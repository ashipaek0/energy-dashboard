const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { DelimiterParser } = require('@serialport/parser-delimiter');
const fs = require('fs');
const path = require('path');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { buildModbusReadRequest, buildPollRanges, parseModbusReadResponse, frameByteCount } = require('./modbus-frame');

let availableProfiles = [];
let metricInsertStmt = null;
let latestUpsertStmt = null;
let metricInsertTextStmt = null;
let latestUpsertTextStmt = null;

// Streaming connections: device_name → { port, parser, device, profile }
const streamingConnections = new Map();

// Per-device consecutive failure counters
const failCounts = new Map();

// Fixed serial read timeout in ms (must stay a module-level constant literal so
// the setTimeout() delay is never user-controlled; clears CWE-400).
const QUERY_TIMEOUT_MS = 3000;
const MODBUS_RT_TIMEOUT_MS = 5000;

// Global poll cycle counter for throttling
let pollCycleCounter = 0;

// ── DB Helpers (matches modbus.js pattern) ──────────────────────────────

function getMetricInsert() {
  if (!metricInsertStmt) {
    const db = getDb();
    metricInsertStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  }
  return metricInsertStmt;
}

function getLatestUpsert() {
  if (!latestUpsertStmt) {
    const db = getDb();
    latestUpsertStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  }
  return latestUpsertStmt;
}

function getMetricInsertText() {
  if (!metricInsertTextStmt) {
    const db = getDb();
    metricInsertTextStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  }
  return metricInsertTextStmt;
}

function getLatestUpsertText() {
  if (!latestUpsertTextStmt) {
    const db = getDb();
    latestUpsertTextStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp) VALUES (?, ?, ?, ?)');
  }
  return latestUpsertTextStmt;
}

function saveMetric(metricName, rawValue, timestamp) {
  if (rawValue === null || rawValue === undefined) return;
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    getLatestUpsert().run(metricName, num, timestamp);
    getMetricInsert().run(timestamp, metricName, num);
  } else {
    const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
    const lower = strVal.toLowerCase();
    const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
    const type = isBool ? 'boolean' : 'string';
    const displayVal = isBool ? lower : strVal;
    getLatestUpsertText().run(metricName, displayVal, type, timestamp);
    getMetricInsertText().run(timestamp, metricName, displayVal, type);
  }
}

// ── Profile Loading ─────────────────────────────────────────────────────

function loadRs232Profiles() {
  const profilesDir = path.join(__dirname, '../profiles/rs232');
  if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
    return;
  }
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  availableProfiles.length = 0;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf8');
      const profile = JSON.parse(raw);
      availableProfiles.push({
        id: file.replace('.json', ''),
        name: profile.name || file,
        protocol: profile.protocol || 'unknown',
        transport: profile.transport || 'rs232',
        defaults: profile.defaults || { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
        commands: profile.commands || [],
        fields: profile.fields || [],
        metrics: profile.metrics || [],
        byte_order: profile.byte_order || null,
        default_unit_id: profile.default_unit_id || null,
        decoder: profile.decoder || null,
        frame_format: profile.frame_format || null,
        call_order: profile.call_order || null,
        profile_file: profile.profile_file || null,
      });
    } catch (e) {
      logger.error(`Failed to parse RS232 profile ${file}:`, e.message);
    }
  }
  logger.info(`Loaded ${availableProfiles.length} RS232 profile(s).`);

  // Second pass: resolve profile_file aliases (after all profiles are loaded)
  resolveAliases();
}

function resolveAliases() {
  for (const profile of availableProfiles) {
    if (profile.profile_file) {
      const targetId = profile.profile_file.replace('.json', '');
      const target = availableProfiles.find(p => p.id === targetId);
      if (target && target !== profile) {
        profile.commands = target.commands;
        profile.fields = target.fields;
        profile.frame_format = target.frame_format;
        profile.call_order = target.call_order;
        profile.decoder = profile.decoder || target.decoder;
      }
    }
  }
}

// ── Serial Port Helpers ─────────────────────────────────────────────────

async function openSerialPort(device) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: device.serial_path || '/dev/ttyUSB0',
      baudRate: parseInt(device.baud) || 9600,
      dataBits: parseInt(device.data_bits) || 8,
      stopBits: parseInt(device.stop_bits) || 1,
      parity: device.parity || 'none',
      autoOpen: false,
    });

    port.open(err => {
      if (err) {
        if (err.message.includes('EACCES')) {
          reject(new Error(`Permission denied on ${device.serial_path}. Add user to 'dialout' group: sudo usermod -a -G dialout $USER`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`Port ${device.serial_path} not found. Check USB connection.`));
        } else {
          reject(err);
        }
      } else {
        resolve(port);
      }
    });
  });
}

async function closeSerialPort(port) {
  return new Promise(resolve => {
    if (!port || !port.isOpen) return resolve();
    port.close(() => resolve());
  });
}

// ── Default Frame Detection ─────────────────────────────────────────────

function defaultFrameDetect(buffer, profile) {
  if (buffer.length < 4) return false;
  // Voltronic ASCII: response ends with \r
  if (profile.protocol === 'voltronic-qpigs' || profile.protocol === 'voltronic-ascii') {
    const text = buffer.toString('utf8');
    return text.endsWith('\r');
  }
  // SolaX AA55 binary: frame[2] contains total length
  if (profile.protocol === 'solax-aa55' && buffer.length >= 3) {
    return buffer.length >= buffer[2] + 3; // header(2) + size(1) + payload + checksum(2)
  }
  // Modbus RTU: total frame len = 3 + byteCount(buf[2]) + 2
  if (profile.protocol === 'modbus-rtu' && buffer.length >= 3) {
    return buffer.length >= frameByteCount(buffer);
  }
  return false;
}

// ── Query/Response Cycle (Poll-Based Protocols) ─────────────────────────

async function queryDevice(port, query, profile, timeoutMs = 3000) {
  // The timer delay must be a compile-time constant. timeoutMs is accepted for
  // caller compatibility but is intentionally NOT used for the delay.
  const safeTimeout = QUERY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      port.removeAllListeners('data');
      if (buffer.length > 0) {
        resolve(buffer); // return partial buffer on timeout
      } else {
        reject(new Error('RS232 read timeout'));
      }
    }, safeTimeout);

    port.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const detectFn = profile.isCompleteFrame || defaultFrameDetect;
      if (detectFn(buffer, profile)) {
        clearTimeout(timer);
        port.removeAllListeners('data');
        resolve(buffer);
      } else {
        timer.refresh();
      }
    });

    port.write(query, err => {
      if (err) {
        clearTimeout(timer);
        port.removeAllListeners('data');
        reject(err);
      }
    });
  });
}

// ── Decoder Implementations ─────────────────────────────────────────────

function decodeAsciiResponse(buffer, cmd, mappings) {
  const text = buffer.toString('utf8').trim();
  const prefix = cmd.response?.prefix || '';
  let dataStr = text;
  if (prefix && text.startsWith(prefix)) {
    dataStr = text.slice(prefix.length);
  }
  const delimiter = cmd.response?.delimiter || '\t';
  const fields = dataStr.split(delimiter);

  const results = {};
  for (const fieldDef of cmd.fields || []) {
    const idx = fieldDef.index;
    if (idx >= fields.length || idx < 0) continue;
    let raw = parseFloat(fields[idx].trim());
    if (isNaN(raw)) continue;
    if (fieldDef.scale) raw *= fieldDef.scale;
    // Build reverse lookup: key → metric name (mappings is { metricName → key })
    let keyToMetric = null;
    if (mappings) {
      keyToMetric = {};
      for (const [metric, key] of Object.entries(mappings)) {
        keyToMetric[key] = metric;
      }
    }
    // Mapping override logic
    if (keyToMetric) {
      const key = `${cmd.name}:${idx}`;
      if (keyToMetric[key] !== undefined) {
        results[keyToMetric[key]] = raw;
      }
      // else: skip unmapped when mappings exist
    } else {
      results[fieldDef.metric] = raw;
    }
  }
  return results;
}

function decodeVedirectFrame(frame, profile, mappings) {
  const results = {};
  for (const fieldDef of profile.fields || []) {
    const raw = frame[fieldDef.label];
    if (raw === undefined) continue;
    let val = parseFloat(raw);
    if (isNaN(val)) continue;
    if (fieldDef.scale) val *= fieldDef.scale;
    if (fieldDef.type === 'millivolt') val *= 0.001;
    if (fieldDef.type === 'milliamp') val *= 0.001;
    // Build reverse lookup: key → metric name (mappings is { metricName → label })
    let keyToMetric = null;
    if (mappings) {
      keyToMetric = {};
      for (const [metric, key] of Object.entries(mappings)) {
        keyToMetric[key] = metric;
      }
    }
    // Mapping override logic
    if (keyToMetric) {
      const key = fieldDef.label;
      if (keyToMetric[key] !== undefined) {
        results[keyToMetric[key]] = parseFloat(val.toFixed(3));
      }
      // else: skip unmapped when mappings exist
    } else {
      const metricName = fieldDef.metric_prefix
        ? `${fieldDef.metric_prefix}_${fieldDef.metric}`
        : fieldDef.metric;
      results[metricName] = parseFloat(val.toFixed(3));
    }
  }
  return results;
}

// ── Dispatch to decoder based on profile ────────────────────────────────

function decodeResponse(rawResponse, cmd, profile, mappings) {
  if (profile.protocol === 'vedirect-streaming') {
    return decodeVedirectFrame(rawResponse, profile, mappings);
  }
  // Binary protocols (SolaX AA55) use a custom decoder
  if (profile.decoder) {
    try {
      const decoderPath = path.join(__dirname, 'rs232-decoders', profile.decoder);
      const decoder = require(decoderPath);
      return decoder.decodeResponse(rawResponse, cmd, profile, mappings);
    } catch (err) {
      logger.error(`RS232 decoder '${profile.decoder}' error:`, err.message);
      return {};
    }
  }
  // Default: ASCII field-index decoder (Voltronic, Infinisolar, etc.)
  return decodeAsciiResponse(rawResponse, cmd, mappings);
}

function encodeQuery(cmd, device, profile) {
  if (profile.protocol === 'solax-aa55' && profile.decoder) {
    try {
      const decoderPath = path.join(__dirname, 'rs232-decoders', profile.decoder);
      const decoder = require(decoderPath);
      return decoder.encodeQuery(cmd, profile);
    } catch (err) {
      logger.error(`RS232 encoder '${profile.decoder}' error:`, err.message);
      return Buffer.alloc(0);
    }
  }
  // Default: send command string as-is (Voltronic ASCII)
  return Buffer.from(cmd.query || '');
}

// ── Poll Orchestration ──────────────────────────────────────────────────

async function pollRs232() {
  const devices = JSON.parse(getConfig('rs232_devices') || '[]');
  if (!devices.length) return;
  pollCycleCounter++;

  for (const device of devices) {
    if (!device.enabled) continue;

    const failCount = failCounts.get(device.name) || 0;
    if (failCount >= 5 && (pollCycleCounter % 2) === 0) continue; // skip every other
    if (failCount >= 10) continue; // stop trying

    const profile = availableProfiles.find(p => p.id === device.profile);
    if (!profile) {
      logger.error(`RS232 profile '${device.profile}' not found`);
      continue;
    }

    try {
      if (profile.protocol === 'vedirect-streaming') {
        await pollStreamingDevice(device, profile);
      } else if (profile.protocol === 'modbus-rtu') {
        await pollModbusRtuDevice(device, profile);
      } else {
        await pollQueryDevice(device, profile);
      }
      failCounts.set(device.name, 0);
    } catch (err) {
      handlePollError(device, err);
    }
  }
}

async function pollQueryDevice(device, profile) {
  const port = await openSerialPort(device);
  try {
    const results = {};

    // Determine command order
    const order = profile.call_order || profile.commands.map(c => c.name);
    for (const cmdName of order) {
      const cmd = profile.commands.find(c => c.name === cmdName);
      if (!cmd) continue;
      const queryBuffer = encodeQuery(cmd, device, profile);
      if (queryBuffer.length === 0) continue;
      const rawResponse = await queryDevice(port, queryBuffer, profile, parseInt(device.timeout) || 5000);
      const parsed = decodeResponse(rawResponse, cmd, profile, device.mappings);
      Object.assign(results, parsed);
    }

    // Write to database — use type detection
    const now = Math.floor(Date.now() / 1000);
    for (const [metric, value] of Object.entries(results)) {
      saveMetric(metric, value, now);
    }
    logger.info(`RS232 poll ${device.name}: ${Object.keys(results).length} metrics`);
  } finally {
    await closeSerialPort(port);
  }
}

// ── Modbus-RTU Register Poll (Profile protocol 'modbus-rtu') ───────────────

/**
 * Write a Modbus-RTU frame to the port and read a single complete response frame.
 * Uses frameByteCount() to detect the full frame (3 + byteCount + 2).
 * @param {import('serialport').SerialPort} port
 * @param {Buffer} frame — a complete request frame (incl. CRC)
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>} the complete response frame
 */
async function readModbusRtuFrame(port, frame, timeoutMs = 5000) {
  // The timer delay must be a compile-time constant. timeoutMs is accepted for
  // caller compatibility but is intentionally NOT used for the delay.
  const safeTimeout = MODBUS_RT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      port.removeAllListeners('data');
      reject(new Error('Modbus-RTU read timeout'));
    }, safeTimeout);

    port.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 3) {
        const total = frameByteCount(buffer);
        if (total > 0 && buffer.length >= total) {
          clearTimeout(timer);
          port.removeAllListeners('data');
          resolve(buffer.slice(0, total));
          return;
        }
      }
      timer.refresh();
    });

    port.write(frame, err => {
      if (err) {
        clearTimeout(timer);
        port.removeAllListeners('data');
        reject(err);
      }
    });
  });
}

/**
 * Poll a Modbus-RTU device: build FC 0x03 read requests for each poll range,
 * decode the 16-bit (optionally word-swapped) registers, apply metric type +
 * scale, and write metrics to the RS232 metrics path.
 */
async function pollModbusRtuDevice(device, profile) {
  const port = await openSerialPort(device);
  try {
    const unitId = device.modbus_unit_id || profile.default_unit_id || 5;
    const ranges = buildPollRanges(profile.metrics);
    const registerData = {};

    for (const range of ranges) {
      const frame = buildModbusReadRequest(unitId, 0x03, range.start, range.count);
      const resp = await readModbusRtuFrame(port, frame, parseInt(device.timeout) || 5000);
      const buf = parseModbusReadResponse(resp);
      if (buf.length < range.count * 2) {
        logger.warn(`[rs232] ${device.name}: short buffer at range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
      }
      const leSwap = profile.byte_order === 'le';
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[range.start + i] = v;
      }
    }

    const metrics = {};
    const units = {};
    const prefix = device.prefix || '';
    const mappings = device.mappings || null;
    let regToMetric = null;
    if (mappings) {
      regToMetric = {};
      for (const [metric, reg] of Object.entries(mappings)) regToMetric[reg] = metric;
    }

    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      let metricName;
      if (regToMetric) {
        const key = m.register;
        if (regToMetric[key] !== undefined) metricName = regToMetric[key];
        else continue;
      } else {
        metricName = prefix + m.name;
      }

      if (m.bit !== undefined) raw = (raw >> m.bit) & 1;
      if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;
      if (m.type === 'uint32' || m.type === 'int32') {
        const lo = m.word_order === 'lsb_first' ? addr : addr + 1;
        const hi = m.word_order === 'lsb_first' ? addr + 1 : addr;
        raw = ((registerData[hi] || 0) << 16) | (registerData[lo] || 0);
        if (m.type === 'int32' && raw > 0x7FFFFFFF) raw -= 0x100000000;
      }
      if (m.type === 'uint64') {
        raw = ((registerData[addr + 3] || 0) * 0x1000000000000)
            + ((registerData[addr + 2] || 0) * 0x100000000)
            + ((registerData[addr + 1] || 0) << 16)
            + (registerData[addr] || 0);
      }

      const value = parseFloat((raw * (m.scale || 1)).toFixed(4));
      metrics[metricName] = value;
      if (m.unit) units[metricName] = m.unit;
    }

    const now = Math.floor(Date.now() / 1000);
    for (const [name, val] of Object.entries(metrics)) saveMetric(name, val, now);
    logger.info(`RS232 Modbus-RTU poll ${device.name}: ${Object.keys(metrics).length} metrics`);
  } finally {
    await closeSerialPort(port);
  }
}

// ── Streaming Protocol Handling (Victron VE.Direct) ─────────────────────

const streamingSetupInProgress = new Set();
const streamingRetries = new Map();
const MAX_STREAMING_RETRIES = 3;

function setupStreamingConnection(device, profile) {
  if (streamingSetupInProgress.has(device.name)) return;
  streamingSetupInProgress.add(device.name);

  teardownStreamingConnection(device.name);

  const port = new SerialPort({
    path: device.serial_path,
    baudRate: parseInt(device.baud) || 19200,
    dataBits: 8, stopBits: 1, parity: 'none',
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  let currentFrame = {};

  parser.on('data', line => {
    line = line.trim();
    if (!line) return;

    const [key, ...valParts] = line.split('\t');
    const value = valParts.join('\t');

    if (key === 'Checksum') {
      const metrics = decodeVedirectFrame(currentFrame, profile, device.mappings);
      if (Object.keys(metrics).length > 0) {
        const now = Math.floor(Date.now() / 1000);
        for (const [metric, val] of Object.entries(metrics)) {
          saveMetric(metric, val, now);
        }
      }
      currentFrame = {};
    } else {
      currentFrame[key] = value;
    }
  });

  port.on('error', err => {
    logger.error(`RS232 streaming ${device.name} error: ${err.message}`);
    streamingSetupInProgress.delete(device.name);
    streamingConnections.delete(device.name);
    const retries = streamingRetries.get(device.name) || 0;
    if (retries < MAX_STREAMING_RETRIES) {
      streamingRetries.set(device.name, retries + 1);
      setTimeout(() => setupStreamingConnection(device, profile), 10000);
    } else {
      logger.error(`RS232 streaming ${device.name}: max retries (${MAX_STREAMING_RETRIES}) reached, giving up`);
    }
  });

  port.on('close', () => {
    streamingConnections.delete(device.name);
    streamingSetupInProgress.delete(device.name);
  });

  streamingConnections.set(device.name, { port, parser, device, profile });
}

function teardownStreamingConnection(name) {
  streamingSetupInProgress.delete(name);
  const conn = streamingConnections.get(name);
  if (conn) {
    try { conn.port.close(); } catch (e) { /* ignore */ }
    streamingConnections.delete(name);
  }
}

function pollStreamingDevice(device, profile) {
  const conn = streamingConnections.get(device.name);
  if (!conn || !conn.port.isOpen) {
    if (!streamingSetupInProgress.has(device.name)) {
      setupStreamingConnection(device, profile);
    }
  }
}

// ── Error Handling ──────────────────────────────────────────────────────

function handlePollError(device, err) {
  const count = (failCounts.get(device.name) || 0) + 1;
  failCounts.set(device.name, count);

  if (count >= 5) {
    logger.error(`RS232 ${device.name}: ${count} consecutive failures, throttling — ${err.message}`);
  } else if (count >= 3) {
    logger.warn(`RS232 ${device.name}: ${count} consecutive failures — ${err.message}`);
  } else {
    logger.warn(`RS232 ${device.name}: poll failed — ${err.message}`);
  }
}

// ── Baud Rate Auto-Detection ────────────────────────────────────────────

async function detectBaudRate(serialPath, profile) {
  const FALLBACK_BAUDS = [2400, 4800, 9600, 19200, 38400, 57600, 115200];
  for (const baud of FALLBACK_BAUDS) {
    try {
      const port = await openSerialPort({
        serial_path: serialPath,
        baud,
        data_bits: profile.defaults?.dataBits || 8,
        stop_bits: profile.defaults?.stopBits || 1,
        parity: profile.defaults?.parity || 'none',
      });
      const cmd = profile.commands[0];
      if (!cmd) { await closeSerialPort(port); continue; }
      const query = typeof cmd.query === 'string' ? Buffer.from(cmd.query) : Buffer.from(cmd.query);
      const response = await queryDevice(port, query, profile, 2000);
      await closeSerialPort(port);
      const parsed = decodeResponse(response, cmd, profile);
      if (Object.keys(parsed).length > 0) {
        return baud;
      }
    } catch (e) { /* try next baud */ }
  }
  throw new Error('Could not auto-detect baud rate for ' + serialPath);
}

// ── Test / Port Listing ─────────────────────────────────────────────────

async function testRs232Connection(device) {
  const profile = availableProfiles.find(p => p.id === device.profile);
  if (!profile) throw new Error(`Profile '${device.profile}' not found`);

  if (profile.protocol === 'vedirect-streaming') {
    const port = await openSerialPort(device);
    await new Promise(r => setTimeout(r, 2000));
    await closeSerialPort(port);
    return { success: true, message: 'Port opened successfully' };
  }

  if (profile.protocol === 'modbus-rtu') {
    const port = await openSerialPort(device);
    try {
      const unitId = device.modbus_unit_id || profile.default_unit_id || 5;
      const ranges = buildPollRanges(profile.metrics);
      if (!ranges.length) throw new Error('No poll ranges defined in profile');
      const frame = buildModbusReadRequest(unitId, 0x03, ranges[0].start, ranges[0].count);
      const resp = await readModbusRtuFrame(port, frame, parseInt(device.timeout) || 5000);
      const buf = parseModbusReadResponse(resp);
      const leSwap = profile.byte_order === 'le';
      const registerData = {};
      for (let i = 0; i < ranges[0].count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[ranges[0].start + i] = v;
      }
      const metrics = {};
      for (const m of profile.metrics) {
        const addr = parseInt(m.register, 16);
        let raw = registerData[addr];
        if (raw === undefined) continue;
        if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;
        metrics[m.name] = parseFloat((raw * (m.scale || 1)).toFixed(4));
      }
      return { success: true, metrics };
    } finally {
      await closeSerialPort(port);
    }
  }

  const port = await openSerialPort(device);
  try {
    const cmd = profile.commands[0];
    if (!cmd) throw new Error('No commands defined in profile');
    const query = encodeQuery(cmd, device, profile);
    const raw = await queryDevice(port, query, profile, parseInt(device.timeout) || 5000);
    const parsed = decodeResponse(raw, cmd, profile);
    return { success: true, metrics: parsed };
  } finally {
    await closeSerialPort(port);
  }
}

async function getAvailablePorts() {
  try {
    const ports = await SerialPort.list();
    return ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer || 'Unknown',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
      friendlyName: `[${p.path}] ${p.manufacturer || 'Unknown adapter'}`,
    }));
  } catch (err) {
    logger.warn(`RS232 port scan failed (udevadm missing?): ${err.message}`);
    return [];
  }
}

// ── Graceful Shutdown ───────────────────────────────────────────────────

async function shutdownRs232() {
  logger.info('RS232 shutdown: closing all streaming connections');
  for (const [name, conn] of streamingConnections) {
    try { conn.port.close(); } catch (e) { /* ignore */ }
  }
  streamingConnections.clear();
  logger.info('RS232 shutdown complete');
}

// ── Restart Streaming (for settings save) ───────────────────────────────

function restartRs232Streaming() {
  const devices = JSON.parse(getConfig('rs232_devices') || '[]');
  for (const device of devices) {
    if (!device.enabled) continue;
    const profile = availableProfiles.find(p => p.id === device.profile);
    if (profile && profile.protocol === 'vedirect-streaming') {
      setupStreamingConnection(device, profile);
    }
  }
}

// ── Exports (matching modbus.js pattern) ────────────────────────────────

function getProfileById(id) {
  return availableProfiles.find(p => p.id === id) || null;
}

function loadProfile(id) {
  return availableProfiles.find(p => p.id === id) || null;
}

function executeRS232Action(deviceName, commandName, value) {
  const devices = JSON.parse(getConfig('rs232_devices') || '[]');
  const device = devices.find(d => d.name === deviceName);
  if (!device || !device.enabled) return { error: 'RS232 device not found or disabled' };

  const profile = loadProfile(device.profile);
  const cmd = profile?.commands?.find(c => c.name === commandName);
  if (!cmd) return { error: `Command "${commandName}" not found in profile` };

  try {
    const { SerialPort } = require('serialport');
    const port = new SerialPort({ path: device.serial_path || '/dev/ttyUSB0',
      baudRate: parseInt(device.baud) || 9600,
      dataBits: parseInt(device.data_bits) || 8,
      stopBits: parseInt(device.stop_bits) || 1,
      parity: device.parity || 'none',
    });

    const bytes = buildWriteCommand(cmd, value);
    port.write(bytes);

    return new Promise((resolve) => {
      setTimeout(() => {
        port.close();
        resolve({ success: true });
      }, 500);
    });
  } catch (e) {
    logger.error(`RS232 write error for ${deviceName}/${commandName}: ${e.message}`);
    return { error: e.message };
  }
}

function buildWriteCommand(cmd, value) {
  const hex = cmd.template.replace('{value}', value.toString(16).padStart(2, '0'));
  return Buffer.from(hex.replace(/\s/g, ''), 'hex');
}

/**
 * Spec-compliant raw-byte RS232 action.
 * Writes `commandBytes` verbatim to the device port (fire-and-forget),
 * closes the port after the write completes.
 *
 * @param {string} deviceId — device name in the rs232_devices config
 * @param {string|number[]|Buffer} commandBytes — hex string like '0102' or byte array [0x01, 0x02]
 * @returns {Promise<{success: true}|{error: string}>}
 */
function executeRs232Action(deviceId, commandBytes) {
  return new Promise((resolve) => {
    try {
      const devices = JSON.parse(getConfig('rs232_devices') || '[]');
      const device = devices.find(d => d.name === deviceId);
      if (!device || !device.enabled) {
        return resolve({ error: 'RS232 device not found or disabled' });
      }
      if (commandBytes === undefined || commandBytes === null || commandBytes === '') {
        return resolve({ error: 'No command bytes provided' });
      }

      let buf;
      if (Buffer.isBuffer(commandBytes)) {
        buf = commandBytes;
      } else if (Array.isArray(commandBytes)) {
        buf = Buffer.from(commandBytes);
      } else if (typeof commandBytes === 'string') {
        const hex = commandBytes.replace(/\s/g, '');
        if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
          return resolve({ error: 'Invalid hex string' });
        }
        buf = Buffer.from(hex, 'hex');
      } else {
        return resolve({ error: 'commandBytes must be a hex string, byte array, or Buffer' });
      }

      const { SerialPort } = require('serialport');
      const port = new SerialPort({ path: device.serial_path || '/dev/ttyUSB0',
        baudRate: parseInt(device.baud) || 9600,
        dataBits: parseInt(device.data_bits) || 8,
        stopBits: parseInt(device.stop_bits) || 1,
        parity: device.parity || 'none',
      });

      port.on('error', (err) => {
        logger.error(`RS232 raw write error for ${deviceId}: ${err.message}`);
        resolve({ error: err.message });
      });

      port.write(buf, (err) => {
        if (err) {
          logger.error(`RS232 raw write error for ${deviceId}: ${err.message}`);
          try { port.close(); } catch (e) { /* ignore */ }
          return resolve({ error: err.message });
        }
        port.close();
        resolve({ success: true });
      });
    } catch (e) {
      logger.error(`RS232 raw write error for ${deviceId}: ${e.message}`);
      resolve({ error: e.message });
    }
  });
}

// Alias for the legacy profile-template based action — kept for clarity alongside
// the spec-compliant raw-byte executeRs232Action above.
const executeRs232ProfileAction = executeRS232Action;

module.exports = {
  loadRs232Profiles,
  pollRs232,
  testRs232Connection,
  getAvailablePorts,
  shutdownRs232,
  restartRs232Streaming,
  detectBaudRate,
  executeRS232Action,
  executeRs232Action,
  executeRs232ProfileAction,
  getProfileById,
  availableProfiles: availableProfiles, // getter — always up to date
};
