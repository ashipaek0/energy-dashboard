const { logger } = require('./logger');
const { getConfig, getDb } = require('./database');
const { execFile } = require('child_process');
const path = require('path');

// Module-level cached prepared statements (same pattern as ha.js / mqtt.js / modbus.js)
let metricInsertStmt = null;
let latestUpsertStmt = null;
let metricInsertTextStmt = null;
let latestUpsertTextStmt = null;

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

/**
 * Spawn a Python bridge script and return its parsed JSON output.
 * @param {string} script - absolute path to the Python script
 * @param {string[]} args  - positional arguments for the script
 * @returns {Promise<any>}  - parsed JSON (object or array)
 */
function runBridge(script, args) {
  return new Promise((resolve, reject) => {
    logger.debug(`runBridge: python3 -u ${script} ${args[0]} (${args[1] ? args[1].substring(0,20) : ''}...)`);
    execFile('python3', ['-u', script, ...args], { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Many bridge scripts print structured JSON errors on stdout/stderr.
        const raw = (stdout || stderr || '').trim();
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch (_) { /* not JSON — fall through to generic message */ }
        const detail = [err.message, stderr?.trim(), stdout?.trim()].filter(Boolean).join(' | ');
        return reject(new Error(detail || 'Bridge process failed'));
      }
      // Log stderr for diagnostics (Python debug goes to stderr)
      if (stderr && stderr.trim()) {
        logger.debug(`Bridge stderr (${args[0]}): ${stderr.trim().slice(0, 10000)}`);
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (parseErr) {
        reject(new Error(`Invalid JSON from bridge: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

/**
 * Poll every enabled Tuya device, map raw DP→value pairs to named metrics,
 * and write them into the time-series + latest-metric tables.
 *
 * Called by server.js on the 30-second polling cycle.
 */
async function pollTuyaDevices() {
  let raw;
  try {
    raw = getConfig('tuya_devices');
  } catch (e) {
    logger.debug('Tuya: could not read tuya_devices config');
    return;
  }

  let devices;
  try {
    devices = JSON.parse(raw || '[]');
  } catch (e) {
    logger.error('Tuya: failed to parse tuya_devices config:', e.message);
    return;
  }

  if (!Array.isArray(devices) || !devices.length) return;

  const enabledDevices = devices.filter(d => d && d.enabled && d.dev_id && d.address && d.local_key);
  if (!enabledDevices.length) return;

  const bridgePath = path.join(__dirname, 'tuya_bridge.py');
  const now = Math.floor(Date.now() / 1000);

  const pollPromises = enabledDevices.map(async (device) => {
    const version = device.version || '3.3';
    try {
      const dps = await runBridge(bridgePath, [
        'poll', device.dev_id, device.address, device.local_key, version
      ]);

      if (!dps || typeof dps !== 'object') {
        logger.debug(`Tuya poll (${device.name || device.dev_id}): no DPs returned`);
        return;
      }

      const dpsConfig = device.dps || {};
      let written = 0;

      for (const [metricName, dpNumber] of Object.entries(dpsConfig)) {
        const dpKey = String(dpNumber);
        if (dps[dpKey] === undefined || dps[dpKey] === null) continue;
        saveMetric(metricName, dps[dpKey], now);
        written++;
      }

      logger.debug(
        `Tuya poll (${device.name || device.dev_id}): ${written} metrics from ${Object.keys(dps).length} DPs`
      );
    } catch (e) {
      logger.error(`Tuya poll error for "${device.name || device.dev_id}": ${e.message}`);
    }
  });

  await Promise.allSettled(pollPromises);
}

/**
 * Fetch devices + local keys + DP name mappings from the Tuya IoT Cloud.
 *
 * @param {string} region       - Tuya datacenter region (eu / us / cn / in)
 * @param {string} accessId     - Tuya API access ID
 * @param {string} accessSecret - Tuya API access secret
 * @param {string} deviceId     - any device ID on the account (used to select the API project)
 * @returns {Promise<Array<{name, id, key, ip, version, mapping}>>}
 */
async function fetchCloudDevices(region, accessId, accessSecret, userId) {
  const scriptPath = path.join(__dirname, 'tuya_cloud.py');
  const args = ['fetch-devices', region, accessId, accessSecret, userId];
  return runBridge(scriptPath, args);
}

/**
 * Generate a QR code token for Smart Life app scan login.
 * @param {string} uid - Smart Life User ID (e.g. "BaTuCAf")
 * @returns {Promise<{qr_token: string, qr_url: string}>}
 */
async function generateQrCode(uid) {
  const scriptPath = path.join(__dirname, 'tuya_cloud.py');
  return runBridge(scriptPath, ['generate-qr', uid]);
}

/**
 * Poll for Smart Life app scan result.
 * @param {string} qrToken - QR code token from generateQrCode
 * @param {string} uid - Smart Life User ID
 * @returns {Promise<{status: string, access_token?: string, ...}>}
 */
async function pollQrLogin(qrToken, uid) {
  const scriptPath = path.join(__dirname, 'tuya_cloud.py');
  return runBridge(scriptPath, ['poll-login', qrToken, uid]);
}

/**
 * Fetch devices using OAuth token from Smart Life login.
 * @param {object} tokenInfo - token info object from pollQrLogin
 * @returns {Promise<Array>}
 */
async function fetchDevicesOAuth(tokenInfo) {
  const scriptPath = path.join(__dirname, 'tuya_cloud.py');
  return runBridge(scriptPath, ['fetch-devices-oauth', JSON.stringify(tokenInfo)]);
}

/**
 * Parse the free-form text output of `python3 -m tinytuya scan`.
 * Tries JSON first; falls back to regex extraction of Device ID + IP + Version.
 *
 * @param {string} stdout - raw stdout from the scan process
 * @returns {Array<{dev_id: string, ip: string, version: string}>}
 */
function parseScanOutput(stdout) {
  // 1. Try JSON (some tinytuya versions / wrappers emit structured output)
  try {
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) {
      return parsed.map(d => ({
        dev_id: d.id || d.dev_id || d.devId || '',
        ip: d.ip || '',
        version: d.version || d.ver || ''
      }));
    }
  } catch (_) { /* fall through */ }

  // 2. Regex fallback — typical tinytuya scan prints tabular rows like:
  //    Device ID: bf1234567890, IP: 192.168.1.100, Version: 3.3
  const devices = [];
  const lines = stdout.split('\n');

  for (const line of lines) {
    const idMatch  = line.match(/(?:Device\s*ID|ID|device_id|dev_id)[:=\s]+([a-zA-Z0-9]{10,})/i);
    const ipMatch  = line.match(/(?:IP|ip|address)[:=\s]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i);

    if (idMatch && ipMatch) {
      const verMatch = line.match(/(?:Version|ver|v)[:=\s]+([\d.]+)/i);
      devices.push({
        dev_id: idMatch[1],
        ip: ipMatch[1],
        version: verMatch ? verMatch[1] : ''
      });
    }
  }

  return devices;
}

/**
 * Run a UDP broadcast scan for Tuya devices on the LAN.
 * Calls `python3 -m tinytuya scan` with a 25-second timeout.
 *
 * @returns {Promise<Array<{dev_id: string, ip: string, version: string}>>}
 */
/**
 * Discover Tuya devices on the LAN.
 *
 * @param {string} [subnet] - Optional subnet in CIDR notation (e.g. "192.168.0.0/24").
 *   When provided, scans every IP in the subnet via TCP probe to port 6668.
 *   When omitted, does a UDP broadcast scan (same-subnet only).
 * @returns {Promise<Array<{dev_id: string, ip: string, version: string}>>}
 */
async function discoverTuyaDevices(subnet) {
  if (subnet) {
    // Directed scan — probes every IP in the subnet via TCP 6668.
    // Works across routed subnets. Uses tuya_bridge.py discover action.
    const script = path.join(__dirname, 'tuya_bridge.py');
    return runBridge(script, ['discover', subnet]);
  }

  // UDP broadcast scan (original behaviour, same-subnet only)
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-m', 'tinytuya', 'scan'], { timeout: 30000 });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      if (stdout.trim()) {
        try {
          const devices = parseScanOutput(stdout);
          if (devices.length) return resolve(devices);
        } catch (_) { /* fall through */ }
      }
      reject(new Error('Discovery timed out — no Tuya devices replied within 25 seconds'));
    }, 25000);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0 && stdout.trim()) {
        try {
          resolve(parseScanOutput(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse scan output: ${e.message}`));
        }
      } else if (stderr.trim()) {
        reject(new Error(stderr.trim()));
      } else {
        reject(new Error(`Scan process exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start tinytuya scan: ${err.message}`));
    });
  });
}

/**
 * Probe a single Tuya device to verify LAN connectivity.
 *
 * @param {{dev_id: string, address: string, local_key: string, version?: string}} device
 * @returns {Promise<{success: boolean, dps?: object, error?: string}>}
 */
async function testTuyaDevice({ dev_id, address, local_key, version } = {}) {
  if (!dev_id || !address || !local_key) {
    return { success: false, error: 'Device ID, IP, and Local Key are required' };
  }

  const bridgePath = path.join(__dirname, 'tuya_bridge.py');
  const ver = version || '3.3';

  try {
    return await runBridge(bridgePath, ['test', dev_id, address, local_key, ver]);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Batch-verify all Tuya device connections.
 * Tests each device's LAN connectivity and reports success/failure per device.
 *
 * @param {Array<{dev_id: string, address: string, local_key: string, version?: string, name?: string}>} devices
 * @returns {Promise<Array<{name: string, dev_id: string, success: boolean, dps?: object, error?: string}>>}
 */
async function verifyAllTuyaDevices(devices) {
  const results = [];
  for (const device of devices) {
    if (!device.dev_id || !device.address || !device.local_key) {
      results.push({ name: device.name || device.dev_id || 'unknown', dev_id: device.dev_id, success: false, error: 'Missing dev_id/address/local_key' });
      continue;
    }
    try {
      const res = await testTuyaDevice(device);
      results.push({ name: device.name || device.dev_id, dev_id: device.dev_id, ...res });
    } catch (e) {
      results.push({ name: device.name || device.dev_id, dev_id: device.dev_id, success: false, error: e.message });
    }
  }
  return results;
}

async function executeTuyaAction(deviceId, dpId, value) {
  const devices = JSON.parse(getConfig('tuya_devices') || '[]');
  // Lookup by NAME or dev_id (spec T4.x)
  const device = devices.find(d => d && (d.name === deviceId || d.dev_id === deviceId));
  if (!device || !device.enabled) return { error: 'Tuya device not found or disabled' };
  if (!device.local_key || !device.address) return { error: 'Tuya device missing local_key or IP' };

  // Never send the literal string 'undefined' — default to true (toggle) when missing
  const actionValue = (value === undefined || value === null) ? true : value;
  const version = device.version || '3.3';

  try {
    // Spec arg order: set <dev_id> <address> <local_key> <version> <dp_number> <value>
    const result = await runBridge(path.join(__dirname, 'tuya_bridge.py'), [
      'set', device.dev_id, device.address, device.local_key, version, String(dpId), String(actionValue)
    ]);
    return result;
  } catch (e) {
    logger.error(`Tuya action error for ${deviceId}/DP${dpId}: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = { pollTuyaDevices, fetchCloudDevices, generateQrCode, pollQrLogin, fetchDevicesOAuth, discoverTuyaDevices, testTuyaDevice, verifyAllTuyaDevices, executeTuyaAction };
