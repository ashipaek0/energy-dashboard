/**
 * LuxPower Local TCP Transport — persistent TCP client for LuxPower WiFi dongles
 * (DI-EW-GL style) that expose the proprietary v5 "TranslatedData" protocol on
 * port 8000 (NOT Modbus TCP — payloads are Modbus-style register ops wrapped in
 * a proprietary frame).
 *
 * Frame (all u16 little-endian):
 *   A1 1A | proto(u16 LE)=5 | frame_len(u16 LE) | 0x01 | 0xC2 | dongle(10 ASCII)
 *   | data_len(u16 LE) | inner | crc16/Modbus(u16 LE)
 *
 * Total frame length = frame_len + 6. CRC covers ONLY the inner payload
 * (frame[20 : len-2]) — standard Modbus CRC16 (poly 0xA001, init 0xFFFF,
 * reflected), stored little-endian. data_len = inner length + 2 (includes CRC).
 *
 * inner (request)  = action(0x00) | dev_fn | inverter(10 ASCII) | start(u16 LE) | count|value(u16 LE)
 * inner (response) = action(0x01) | dev_fn | inverter(10 ASCII) | start(u16 LE) | byte_len(1) | values[byte_len]
 *
 * dev_fn: 0x03 = holding (ReadHold), 0x04 = input (ReadInput),
 *         0x06 = write single register (WriteSingle). A 0x06 response echoes
 *         the written register back either as the bare 16-byte request inner
 *         with action flipped to 0x01 (no byte_len) or in the framed 17-byte
 *         form above with byte_len = 2.
 *
 * Design: persistent connection lifecycle (connect / auto-reconnect with 1s→60s
 * exponential backoff / stop), one serialized outstanding request at a time
 * (single-flight — reads and writes share the queue), receive-buffer framing
 * that survives fragmentation, concatenation and junk (resync on A1 1A), CRC
 * validation, and emission of unsolicited action=0x01 frames to onFrame.
 * Response discrimination is by content (dev_fn + start register + inverter
 * serial), since the protocol has no request/response correlation field.
 *
 * @module dongle/luxpowerTcp
 */
const net = require('net');

const FRAME_MAGIC = 0xA11A; // bytes A1 1A
const TCP_FN_TRANSLATED_DATA = 0xC2;
const DEV_FN_HOLDING = 0x03;
const DEV_FN_INPUT = 0x04;
const DEV_FN_WRITE_SINGLE = 0x06;

/** Exponential reconnect backoff sequence (ms), capped at 60 s. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];

const CRC16_TABLE = buildCrc16Table();

function buildCrc16Table() {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xA001 ^ (crc >> 1)) : (crc >> 1);
    }
    table[i] = crc;
  }
  return table;
}

/**
 * CRC16/Modbus over a buffer (poly 0xA001, init 0xFFFF, reflected).
 * @param {Buffer} data
 * @returns {number} 16-bit CRC
 */
function crc16Modbus(data) {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc = CRC16_TABLE[(crc ^ byte) & 0xFF] ^ (crc >> 8);
  }
  return crc;
}

const SERIAL_RE = /^[A-Za-z0-9]{10}$/;

/** Validate a 10-char ASCII serial; returns trimmed value or throws. */
function validateSerial(value, label) {
  const s = (value === undefined || value === null) ? '' : String(value).trim();
  if (!SERIAL_RE.test(s)) {
    throw new Error(`${label} must be exactly 10 alphanumeric ASCII characters`);
  }
  return s;
}

/** Validate a dev_fn (0x03 holding / 0x04 input). */
function validateDevFn(devFn) {
  if (devFn !== DEV_FN_HOLDING && devFn !== DEV_FN_INPUT) {
    throw new Error(`devFn must be 0x03 (holding) or 0x04 (input), got 0x${devFn.toString(16)}`);
  }
  return devFn;
}

/**
 * Build a LuxPower local-TCP v5 read request frame.
 * @param {object} opts { protocol=5, dongle, inverter, devFn, start, count }
 * @returns {Buffer} full wire frame (frame_len + 6 bytes)
 */
function buildReadFrame(opts) {
  const protocol = (opts.protocol === undefined ? 5 : parseInt(opts.protocol, 10)) || 5;
  const dongle = validateSerial(opts.dongle, 'dongle');
  const inverter = validateSerial(opts.inverter, 'inverter');
  const devFn = validateDevFn(parseInt(opts.devFn, 10));
  const start = parseInt(opts.start, 10);
  const count = parseInt(opts.count, 10);
  if (isNaN(start) || start < 0 || start > 0xFFFF) throw new Error('start must be within 0..0xFFFF');
  if (isNaN(count) || count < 1 || count > 0xFFFF) throw new Error('count must be within 1..0xFFFF');

  // inner (request) = action | dev_fn | inverter(10) | start(u16 LE) | count(u16 LE)
  const inner = Buffer.alloc(16);
  inner[0] = 0x00; // action = request
  inner[1] = devFn;
  inner.write(inverter, 2, 10, 'ascii');
  inner.writeUInt16LE(start, 12);
  inner.writeUInt16LE(count, 14);

  // outer frame; data_len covers inner + 2-byte CRC => total = 20 + data_len
  const dataLen = inner.length + 2;
  const total = 20 + dataLen;
  const frame = Buffer.alloc(total);
  frame[0] = 0xA1;
  frame[1] = 0x1A;
  frame.writeUInt16LE(protocol, 2);
  frame.writeUInt16LE(total - 6, 4); // frame_len = total - 6
  frame[6] = 0x01;
  frame[7] = TCP_FN_TRANSLATED_DATA;
  frame.write(dongle, 8, 10, 'ascii');
  frame.writeUInt16LE(dataLen, 18);
  inner.copy(frame, 20);
  frame.writeUInt16LE(crc16Modbus(inner), total - 2);
  return frame;
}

/**
 * Build a LuxPower local-TCP v5 write-single-register request frame
 * (Modbus fn 0x06), same C2 envelope as buildReadFrame.
 * @param {object} opts { protocol=5, dongle, inverter, start, value }
 * @returns {Buffer} full wire frame (38 bytes: frame_len 32 + 6)
 */
function buildWriteFrame(opts) {
  const protocol = (opts.protocol === undefined ? 5 : parseInt(opts.protocol, 10)) || 5;
  const dongle = validateSerial(opts.dongle, 'dongle');
  const inverter = validateSerial(opts.inverter, 'inverter');
  const start = parseInt(opts.start, 10);
  const value = parseInt(opts.value, 10);
  if (isNaN(start) || start < 0 || start > 0xFFFF) throw new Error('start must be within 0..0xFFFF');
  if (isNaN(value) || value < 0 || value > 0xFFFF) throw new Error('value must be within 0..0xFFFF');
  const maskedValue = value & 0xFFFF;

  // inner (request) = action | dev_fn(0x06) | inverter(10) | start(u16 LE) | value(u16 LE)
  const inner = Buffer.alloc(16);
  inner[0] = 0x00; // action = request
  inner[1] = DEV_FN_WRITE_SINGLE;
  inner.write(inverter, 2, 10, 'ascii');
  inner.writeUInt16LE(start, 12);
  inner.writeUInt16LE(maskedValue, 14);

  // outer frame; data_len covers inner + 2-byte CRC => total = 20 + data_len
  const dataLen = inner.length + 2;
  const total = 20 + dataLen;
  const frame = Buffer.alloc(total);
  frame[0] = 0xA1;
  frame[1] = 0x1A;
  frame.writeUInt16LE(protocol, 2);
  frame.writeUInt16LE(total - 6, 4); // frame_len = total - 6
  frame[6] = 0x01;
  frame[7] = TCP_FN_TRANSLATED_DATA;
  frame.write(dongle, 8, 10, 'ascii');
  frame.writeUInt16LE(dataLen, 18);
  inner.copy(frame, 20);
  frame.writeUInt16LE(crc16Modbus(inner), total - 2);
  return frame;
}

/**
 * Parse a complete (CRC-validated) LuxPower v5 response frame.
 * @param {Buffer} frame — full wire frame
 * @returns {{action:number, devFn:number, inverter:string, start:number,
 *            byteLen:number, values:Buffer, frameLen:number, dataLen:number}}
 * @throws {Error} on structural mismatch (does NOT verify CRC — caller does)
 */
function parseFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 20) throw new Error('frame too short');
  if (frame[0] !== 0xA1 || frame[1] !== 0x1A) throw new Error('missing start marker A1 1A');
  if (frame[7] !== TCP_FN_TRANSLATED_DATA) throw new Error(`unexpected tcp function 0x${frame[7].toString(16)}`);
  const frameLen = frame.readUInt16LE(4);
  if (frame.length !== frameLen + 6) throw new Error('frame length mismatch (frame_len + 6)');
  const dataLen = frame.readUInt16LE(18);
  if (dataLen !== frameLen - 14) throw new Error('data_len does not match frame_len');
  const innerLen = dataLen - 2; // CRC excluded
  const innerStart = 20;
  if (frame.length !== innerStart + innerLen + 2) throw new Error('inner payload length mismatch');
  const inner = frame.slice(innerStart, innerStart + innerLen);
  const action = inner[0];
  if (action !== 0x01) throw new Error(`expected action 0x01 (response), got 0x${action.toString(16)}`);
  if (inner.length < 15) throw new Error('response inner too short');
  const devFn = inner[1];
  const inverter = inner.slice(2, 12).toString('ascii');
  const start = inner.readUInt16LE(12);
  let byteLen;
  let values;
  if (devFn === DEV_FN_WRITE_SINGLE) {
    // Write-single (0x06) response echoes the written register. Accept both
    // wire shapes: the bare 16-byte request inner with action flipped to 0x01
    // (…|start|value, no byte_len field) and the framed 17-byte form used by
    // 0x03/0x04 responses (…|start|byte_len=2|value).
    if (inner.length === 16) {
      byteLen = 2;
      values = inner.slice(14, 16);
    } else if (inner.length === 17) {
      byteLen = inner[14];
      if (byteLen !== 2) throw new Error(`write-single byte_len ${byteLen} must be 2 (one register)`);
      values = inner.slice(15, 17);
    } else {
      throw new Error(`write-single response inner must be 16 (echo) or 17 (framed) bytes, got ${inner.length}`);
    }
  } else {
    byteLen = inner[14];
    if (15 + byteLen !== inner.length) throw new Error(`byte_len ${byteLen} does not match value payload (${inner.length - 15})`);
    values = inner.slice(15, 15 + byteLen);
  }
  return {
    action,
    devFn,
    inverter,
    start,
    byteLen,
    values,
    frameLen,
    dataLen
  };
}

/**
 * Find the next frame start marker (A1 1A) in a buffer; returns the index of the
 * first candidate, or -1 when no marker pair is present.
 */
function findMarker(buf) {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xA1 && buf[i + 1] === 0x1A) return i;
  }
  return -1;
}

class LuxpowerTcpTransport {
  /**
   * @param {object} instance — dongle config { host, port?, dongle_serial,
   *   inverter_serial, protocol?, timeout_ms?/timeout?, onFrame? }
   */
  constructor(instance) {
    const host = (instance.host || '').trim();
    if (!host || host.length > 253) throw new Error('Invalid host');
    const ipType = net.isIP(host);
    if (ipType === 0 && !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Invalid hostname');
    const port = parseInt(instance.port) || 8000;
    if (port < 1 || port > 65535) throw new Error('Invalid port');
    this._host = host;
    this._port = port;
    // Config field naming: dongle_serial = outer-header dongle serial,
    // inverter_serial = inner 10-char inverter serial.
    this._dongle = validateSerial(instance.dongle_serial, 'dongle_serial');
    this._inverter = validateSerial(instance.inverter_serial, 'inverter_serial');
    this._protocol = (instance.protocol === undefined ? 5 : parseInt(instance.protocol, 10)) || 5;
    const timeoutMs = parseInt(instance.timeout_ms !== undefined ? instance.timeout_ms : instance.timeout, 10);
    this._timeoutMs = (!isNaN(timeoutMs) && timeoutMs > 0) ? timeoutMs : 8000;
    this.onFrame = typeof instance.onFrame === 'function' ? instance.onFrame : null;

    this._socket = null;
    this._connected = false;
    this._connecting = false;
    this._started = false;
    this._rx = Buffer.alloc(0);
    this._backoffIdx = 0;
    this._reconnectTimer = null;
    this._queue = [];   // requests not yet written (FIFO)
    this._current = null; // single in-flight request
  }

  /** Return validated connection target — breaks taint chain for static analysis */
  _target() {
    return { host: this._host, port: this._port };
  }

  /** Start the persistent connection lifecycle (idempotent). */
  start() {
    if (this._started) return this;
    this._started = true;
    this._connect();
    return this;
  }

  /** Stop the connection lifecycle: close socket, clear timers, reject pending. */
  stop() {
    this._started = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    this._connected = false;
    this._connecting = false;
    this._rx = Buffer.alloc(0);
    const err = new Error('transport stopped');
    if (this._current) {
      this._settleCurrent(err);
    }
    for (const req of this._queue.splice(0)) {
      req.timer && clearTimeout(req.timer);
      req.reject(err);
    }
  }

  /**
   * Read `count` registers starting at `start` via function code devFn.
   * Serialized with writeRegister on one shared queue: only one request is
   * outstanding at a time; further calls queue.
   * @param {number} start — register address (decimal, 0-based)
   * @param {number} count — number of registers (1..0xFFFF)
   * @param {number} [devFn] — 0x03 holding (default) or 0x04 input
   * @returns {Promise<Buffer>} raw value bytes (2 bytes per register, as received)
   */
  readRegisters(start, count, devFn) {
    if (!this._started) this.start();
    const parsedStart = parseInt(start, 10);
    const parsedCount = parseInt(count, 10);
    if (isNaN(parsedStart) || parsedStart < 0 || parsedStart > 0xFFFF) return Promise.reject(new Error('start must be within 0..0xFFFF'));
    if (isNaN(parsedCount) || parsedCount < 1 || parsedCount > 0xFFFF) return Promise.reject(new Error('count must be within 1..0xFFFF'));
    let fn = DEV_FN_HOLDING;
    try { fn = validateDevFn(devFn === undefined ? DEV_FN_HOLDING : parseInt(devFn, 10)); } catch (e) { return Promise.reject(e); }

    return new Promise((resolve, reject) => {
      this._queue.push({ start: parsedStart, count: parsedCount, devFn: fn, resolve, reject, timer: null });
      this._pump();
    });
  }

  /**
   * Write a single holding register (Modbus fn 0x06, write-single). Runs on the
   * SAME single-flight queue as reads — only one request (read or write) is
   * outstanding at a time. Resolves when the dongle echoes the write back
   * (action 0x01, dev_fn 0x06, matching start register). Any other frame that
   * arrives while the write is pending (read responses, pushes, wrong start)
   * is treated as unsolicited and never resolves the write.
   * @param {number} start — register address (decimal, 0-based)
   * @param {number} value — 16-bit word to write (masked to 0..0xFFFF)
   * @returns {Promise<Buffer>} 2-byte echo of the written value
   */
  writeRegister(start, value) {
    if (!this._started) this.start();
    const parsedStart = parseInt(start, 10);
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedStart) || parsedStart < 0 || parsedStart > 0xFFFF) return Promise.reject(new Error('start must be within 0..0xFFFF'));
    if (isNaN(parsedValue) || parsedValue < 0 || parsedValue > 0xFFFF) return Promise.reject(new Error('value must be within 0..0xFFFF'));

    return new Promise((resolve, reject) => {
      this._queue.push({ kind: 'write', start: parsedStart, value: parsedValue & 0xFFFF, resolve, reject, timer: null });
      this._pump();
    });
  }

  /** Send the next queued request if the channel is free and connected. */
  _pump() {
    if (this._current || this._queue.length === 0) return;
    if (!this._connected) {
      if (this._started && !this._connecting && !this._socket) this._connect();
      return; // flush after (re)connect
    }
    const req = this._queue.shift();
    this._current = req;
    req.timer = setTimeout(() => {
      if (this._current !== req) return;
      this._current = null;
      clearTimeout(req.timer);
      req.reject(new Error('timeout'));
      this._pump();
    }, this._timeoutMs);
    req.timer.unref && req.timer.unref();
    try {
      let frame;
      if (req.kind === 'write') {
        frame = buildWriteFrame({
          protocol: this._protocol,
          dongle: this._dongle,
          inverter: this._inverter,
          start: req.start,
          value: req.value
        });
      } else {
        frame = buildReadFrame({
          protocol: this._protocol,
          dongle: this._dongle,
          inverter: this._inverter,
          devFn: req.devFn,
          start: req.start,
          count: req.count
        });
      }
      this._socket.write(frame);
    } catch (e) {
      this._current = null;
      clearTimeout(req.timer);
      req.reject(e);
      this._pump();
    }
  }

  _settleCurrent(err) {
    const req = this._current;
    this._current = null;
    if (!req) return;
    if (req.timer) clearTimeout(req.timer);
    req.reject(err);
  }

  _connect() {
    if (!this._started || this._connecting || this._connected) return;
    if (this._socket && !this._socket.destroyed) return;
    this._connecting = true;
    const { host, port } = this._target();
    const socket = net.createConnection({ host, port });
    this._socket = socket;

    socket.on('connect', () => {
      if (!this._started) { socket.destroy(); return; }
      this._connecting = false;
      this._connected = true;
      this._backoffIdx = 0;
      this._pump();
    });

    socket.on('data', chunk => this._onData(chunk));

    socket.on('error', err => {
      this._connected = false;
      this._connecting = false;
      this._socket = null;
      if (this._current) this._settleCurrent(new Error(`connection error: ${err.message}`));
      this._scheduleReconnect();
    });

    socket.on('close', () => {
      this._connected = false;
      this._connecting = false;
      if (this._socket === socket) this._socket = null;
      if (this._current) this._settleCurrent(new Error('connection closed'));
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (!this._started || this._reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this._backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
    this._backoffIdx++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectTimer.unref && this._reconnectTimer.unref();
  }

  /** Feed a raw TCP chunk into the receive buffer (socket data handler). */
  _onData(chunk) {
    this._rx = this._rx.length ? Buffer.concat([this._rx, chunk]) : chunk;
    this._drainRx();
  }

  /**
   * Frame/defragment the receive buffer. Handle fragmentation, concatenation,
   * junk-prefix resync, CRC validation; complete frames go to _handleFrame.
   */
  _drainRx() {
    let buf = this._rx;
    while (buf.length >= 6) {
      const marker = findMarker(buf);
      if (marker < 0) {
        buf = buf.slice(buf.length - 1); // keep 1 byte in case A1 straddles chunks
        break;
      }
      if (marker > 0) buf = buf.slice(marker); // junk prefix resync
      const frameLen = buf.readUInt16LE(4);
      if (frameLen < 16 || frameLen > 0x2000) {
        buf = buf.slice(2); // absurd length — drop marker and resync
        continue;
      }
      const total = frameLen + 6;
      if (buf.length < total) break; // wait for more bytes
      const frame = buf.slice(0, total);
      buf = buf.slice(total);

      let parsed = null;
      try {
        const proto = frame.readUInt16LE(2);
        if (proto !== this._protocol) throw new Error(`unexpected protocol ${proto}`);
        const stored = frame.readUInt16LE(total - 2);
        const computed = crc16Modbus(frame.slice(20, total - 2));
        if (stored !== computed) throw new Error(`CRC mismatch (stored 0x${stored.toString(16)}, computed 0x${computed.toString(16)})`);
        parsed = parseFrame(frame);
      } catch (e) {
        // discard frame; never resolve a pending read on a corrupt frame
        continue;
      }
      try {
        this._handleFrame(parsed);
      } catch (e) {
        // handler errors must not break the receive loop
      }
    }
    this._rx = buf;
  }

  /** Route a validated response frame: match pending or emit unsolicited. */
  _handleFrame(parsed) {
    // Only frames from our configured inverter are of interest.
    if (parsed.inverter !== this._inverter) return;

    const req = this._current;
    if (!req) {
      this._emitUnsolicited(parsed);
      return;
    }

    // Pending write: resolve ONLY on the matching 0x06 echo (action is already
    // 0x01 — parseFrame guarantees it). dev_fn 0x06 never matches a read request
    // and vice versa, so read responses / holding pushes / wrong-register echoes
    // arriving mid-write fall through to unsolicited and never resolve it.
    if (req.kind === 'write') {
      if (parsed.devFn === DEV_FN_WRITE_SINGLE && parsed.start === req.start) {
        this._current = null;
        clearTimeout(req.timer);
        req.resolve(parsed.values);
        this._pump();
        return;
      }
      this._emitUnsolicited(parsed);
      return;
    }

    // Content-match discrimination: dev_fn + start + inverter serial.
    if (parsed.devFn === req.devFn && parsed.start === req.start) {
      if (parsed.byteLen !== req.count * 2) {
        // Malformed/inconsistent response — discard, keep request pending
        // (it will time out rather than resolve with wrong-length data).
        this._emitUnsolicited(parsed);
        return;
      }
      this._current = null;
      clearTimeout(req.timer);
      req.resolve(parsed.values);
      this._pump();
      return;
    }

    // Not the response to our outstanding request — unsolicited (e.g. holding
    // push arriving while an input read is pending). Never resolves it.
    this._emitUnsolicited(parsed);
  }

  _emitUnsolicited(parsed) {
    if (this.onFrame) {
      try { this.onFrame(parsed); } catch (e) { /* handler errors are isolated */ }
    }
  }
}

module.exports = {
  LuxpowerTcpTransport,
  buildReadFrame,
  buildWriteFrame,
  parseFrame,
  crc16Modbus,
  DEV_FN_HOLDING,
  DEV_FN_INPUT,
  DEV_FN_WRITE_SINGLE
};
