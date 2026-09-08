/**
 * Epilykos Energy Dashboard — Express Server
 *
 * Core responsibilities:
 * - Serves static frontend files (HTML, CSS, JS modules)
 * - Provides REST API for dashboard state, metrics, config, and settings
 * - Manages WebSocket connections for real-time state push (30s interval)
 * - Orchestrates polling: HA, MQTT, Modbus, External REST, BMS bridge
 * - Session-based auth for settings/editor with CSRF protection
 * - Database backup/restore, layout import/export
 *
 * @module server
 */
require('dotenv').config({ quiet: true });
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const morgan = require('morgan');
const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const dns = require('dns');
const { logger } = require('./modules/logger');
const { initializeDatabase, getConfig, setConfig, getDb, DB_PATH } = require('./modules/database');
const { isAuthenticated, loginLimiter, csrfProtection, settingsPassword, passwordEnvManaged, getSettingsPassword, setSettingsPassword } = require('./modules/sessionAuth');
const { pollHomeAssistant, fetchHAEntities, getActionsForEntity, getEntityActions, getEntityModes } = require('./modules/ha');
const { setupMqtt, restartMqtt, mqttClients } = require('./modules/mqtt');
const { loadProfiles, pollModbus, testModbusConnection, availableProfiles } = require('./modules/modbus');
const { pollTuyaDevices, fetchCloudDevices, generateQrCode, pollQrLogin, fetchDevicesOAuth, discoverTuyaDevices, testTuyaDevice, verifyAllTuyaDevices } = require('./modules/tuya');
const { loadRs232Profiles, pollRs232, testRs232Connection, getAvailablePorts, shutdownRs232, restartRs232Streaming, availableProfiles: rs232Profiles } = require('./modules/rs232');
const { pollLegacyHistory } = require('./modules/history');
const { pollGridStatus, getCurrentGridStatus, getGridHours, getGridTimeline } = require('./modules/grid');
const { computeTodaySolar, getSolarForecast, testForecast } = require('./modules/solar');
const { getSavings } = require('./modules/savings');
const { getCurrentMetrics, getMetricHistory } = require('./modules/metrics');
const { getDashboardConfig, saveDashboardConfig } = require('./modules/dashboard-config');
const { backupDatabase, restoreDatabase, startSnapshotScheduler, stopSnapshotScheduler, listSnapshots, restoreFromSnapshot, checkpointWal } = require('./modules/backup');
const { parseGridState, assertSafeFetchUrl, assertSafeBrokerUrl, isBlockedIp } = require('./modules/utils');
const { startExternalPolling, restartExternalPolling, stopExternalPolling } = require('./modules/external');
const { startBmsPolling, restartBmsPolling, stopBmsPolling } = require('./modules/bms');
const { startBmsWiredPolling, restartBmsWiredPolling, stopBmsWiredPolling, testBmsWiredConnection, getBmsWiredFields } = require('./modules/bmsWired');
const { startDonglePolling, restartDonglePolling, stopDonglePolling } = require('./modules/dongle');
const pvoutput = require('./modules/pvoutput');
// Issue #108 (AC-1..13): dongle projections live in the pure module; the
// remaining per-family projections are route-level pure helpers below (server
// wave touches server.js only). All catalog routes are thin wrappers.
const entityCatalog = require('./modules/entityCatalog');

// ================= #108 catalog projections (pure) =================
// No fs / network / DB / logger. Every function below takes parsed data and
// returns catalog items, so the route handlers stay thin wrappers. Named to
// mirror the entityCatalog.js API (catEntity + per-source projections) so a
// later slice can move them into that module verbatim.
// ===================================================================

function modbusProfileEntities(profile) {
  // AC-7: one item per registers[], id = String(r.address) — the exact handle
  // modules/modbus.js addrToMetric[String(address)] consumes (poll filter L132,
  // metric name L167). name = r.metric, the implicit default metric name.
  const registers = profile && Array.isArray(profile.registers) ? profile.registers : [];
  const entities = [];
  for (const r of registers) {
    if (r.address === undefined || r.address === null || String(r.address).trim() === '') continue;
    if (r.metric === undefined) continue; // not decode-reachable without a metric
    entities.push(entityCatalog.catEntity({
      id: String(r.address),
      name: r.metric,
      label: r.label,
      unit: r.unit,
      scale: r.scale,
      type: r.type,
      kind: 'register'
    }));
  }
  entities.sort((a, b) => (Number(a.id) - Number(b.id)) || String(a.id).localeCompare(String(b.id)));
  return entities;
}

function rs232HexNum(reg) {
  const s = String(reg).trim();
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

function rs232ProfileEntities(profile) {
  // AC-8: per-family projection over an ALIAS-RESOLVED profile (the route feeds
  // the in-memory profile, which loadRs232Profiles()/resolveAliases() already
  // merged — infinisolar yields voltronic's commands). Decode-key contract
  // mirrors modules/rs232.js exactly:
  //  - query/ascii family:  decodeAsciiResponse L261 → `${cmd.name}:${idx}`
  //  - modbus-rtu family:   pollModbusRtuDevice L496 → m.register (bare hex)
  //  - vedirect family:     decodeVedirectFrame L293 → field.label
  //  - solax/binary family: solax-decoder L120 → `${dataCmd.name}:${offset}`
  if (!profile || typeof profile !== 'object') return [];
  const protocol = profile.protocol ? String(profile.protocol).toLowerCase() : '';
  const entities = [];

  if (protocol === 'modbus-rtu') {
    for (const m of (Array.isArray(profile.metrics) ? profile.metrics : [])) {
      if (m.register === undefined || m.register === null || String(m.register).trim() === '') continue;
      entities.push(entityCatalog.catEntity({
        id: m.register,
        name: m.name,
        label: m.label,
        unit: m.unit,
        scale: m.scale,
        type: m.type,
        kind: 'register'
      }));
    }
    entities.sort((a, b) => rs232HexNum(a.id) - rs232HexNum(b.id));
    return entities;
  }

  if (protocol === 'vedirect-streaming') {
    for (const f of (Array.isArray(profile.fields) ? profile.fields : [])) {
      if (f.label === undefined || f.label === null) continue;
      const metricName = f.metric_prefix ? `${f.metric_prefix}_${f.metric}` : f.metric;
      entities.push(entityCatalog.catEntity({
        id: f.label,
        name: metricName,
        label: f.label,
        unit: f.unit,
        scale: f.scale,
        type: f.type,
        kind: 'vedirect'
      }));
    }
    entities.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return entities;
  }

  const commands = Array.isArray(profile.commands) ? profile.commands : [];

  if (profile.decoder || protocol === 'solax-aa55') {
    // Custom binary decoder (SolaX AA55): only the DATA command (function > 5)
    // carries metric payload — register/serial handshakes decode to nothing
    // (solax-decoder L77-79). Fall back to the LAST command when none exceeds 5.
    const funcVal = (cmd) => {
      if (!cmd || cmd.function === undefined) return NaN;
      const v = cmd.function;
      if (typeof v === 'number') return v;
      const s = String(v).trim();
      return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    };
    const dataCmd = commands.find(c => Number.isFinite(funcVal(c)) && funcVal(c) > 5) || commands[commands.length - 1] || null;
    if (dataCmd) {
      for (const f of (Array.isArray(profile.fields) ? profile.fields : [])) {
        if (f.offset === undefined || f.offset === null) continue;
        entities.push(entityCatalog.catEntity({
          id: `${dataCmd.name}:${f.offset}`,
          name: f.metric,
          label: f.label,
          unit: f.unit,
          scale: f.scale,
          type: f.type,
          kind: 'binary'
        }));
      }
    }
    return entities;
  }

  // Default query/response ASCII family (voltronic-qpigs, infinisolar alias,
  // and any future ascii query profile) — fields nested per command, keyed by
  // index. Deterministic: command order preserved, then field index order.
  for (const cmd of commands) {
    if (!cmd || cmd.name === undefined) continue;
    for (const f of (Array.isArray(cmd.fields) ? cmd.fields : [])) {
      if (f.index === undefined || f.index === null) continue;
      entities.push(entityCatalog.catEntity({
        id: `${cmd.name}:${f.index}`,
        name: f.metric,
        label: f.label,
        unit: f.unit,
        scale: f.scale,
        type: f.type,
        kind: 'ascii'
      }));
    }
  }
  return entities;
}

// 8-domain set shared with modules/ha.js fetchHAEntities filter (L147-156).
const HA_CATALOG_DOMAINS = ['sensor', 'binary_sensor', 'switch', 'light', 'climate', 'fan', 'cover', 'input_boolean'];

function haStatesToCatalog(states) {
  // AC-10: enrich ONE /api/states fetch into catalog items (no registry, no
  // websocket). The legacy /api/ha-device-entities (entity_id strings only)
  // stays untouched — both endpoints remain callable.
  const items = [];
  if (!Array.isArray(states)) return items;
  for (const e of states) {
    if (!e || typeof e.entity_id !== 'string' || e.entity_id === '') continue;
    const domain = e.entity_id.split('.')[0];
    if (!HA_CATALOG_DOMAINS.includes(domain)) continue;
    const attrs = (e.attributes && typeof e.attributes === 'object' && !Array.isArray(e.attributes)) ? e.attributes : {};
    const friendly = (typeof attrs.friendly_name === 'string' && attrs.friendly_name !== '')
      ? attrs.friendly_name : e.entity_id;
    items.push({
      id: e.entity_id, // persisted handle (entity_id)
      entity_id: e.entity_id,
      domain,
      label: friendly,
      name: friendly,
      unit_of_measurement: attrs.unit_of_measurement !== undefined ? attrs.unit_of_measurement : null,
      device_class: attrs.device_class !== undefined ? attrs.device_class : null,
      state: e.state !== undefined ? e.state : null,
      attributes: attrs,
      kind: 'ha'
    });
  }
  return items;
}

const REST_FLATTEN_DEFAULT_CAPS = Object.freeze({ maxDepth: 6, maxLeaves: 500, maxArrayItems: 100 });

function flattenJsonLeaves(doc, caps) {
  // AC-11: deterministic DFS flatten of a parsed JSON document to scalar leaves
  // {path, value, type, sample}. Caps: path ≤ maxDepth segments, ≤ maxLeaves
  // leaves (first-N), arrays expanded to maxArrayItems items then capped.
  // Objects iterate in insertion order, arrays by numeric index; only
  // number/string/boolean leaves are emitted; empty containers and non-leaf
  // values are skipped. Returns { leaves, truncated }.
  const maxDepth = caps && caps.maxDepth !== undefined ? caps.maxDepth : REST_FLATTEN_DEFAULT_CAPS.maxDepth;
  const maxLeaves = caps && caps.maxLeaves !== undefined ? caps.maxLeaves : REST_FLATTEN_DEFAULT_CAPS.maxLeaves;
  const maxArrayItems = caps && caps.maxArrayItems !== undefined ? caps.maxArrayItems : REST_FLATTEN_DEFAULT_CAPS.maxArrayItems;
  const leaves = [];
  let truncated = false;

  const kindOf = (v) => {
    if (v === null) return 'null';
    return Array.isArray(v) ? 'array' : typeof v;
  };
  const sampleOf = (value) => {
    const s = typeof value === 'string' ? value : String(value);
    return s.length > 200 ? s.slice(0, 200) : s;
  };

  function visit(value, segments) {
    if (leaves.length >= maxLeaves) { truncated = true; return; }
    const kind = kindOf(value);
    if (kind === 'number' || kind === 'string' || kind === 'boolean') {
      // Scalars are leaves when their path fits the segment budget (parents
      // refuse to descend past maxDepth).
      if (segments.length <= maxDepth) {
        leaves.push({ path: segments.join('.'), value, type: kind, sample: sampleOf(value) });
      }
      return;
    }
    if (kind === 'null') return;
    if (kind !== 'array' && kind !== 'object') return; // function/symbol/undefined etc. are not JSON — skipped silently
    const isEmpty = kind === 'array' ? value.length === 0 : Object.keys(value).length === 0;
    if (isEmpty) return; // skip empty containers
    if (segments.length >= maxDepth) { truncated = true; return; } // non-empty content beyond depth budget
    if (kind === 'array') {
      if (value.length > maxArrayItems) truncated = true;
      const n = Math.min(value.length, maxArrayItems);
      for (let i = 0; i < n; i++) visit(value[i], segments.concat(String(i)));
    } else if (kind === 'object') {
      for (const key of Object.keys(value)) visit(value[key], segments.concat(key));
    }
  }

  visit(doc, []);
  return { leaves, truncated };
}

function mqttSampleOf(rawText, retained) {
  // AC-12: type inference for one MQTT payload sample. rawText is the payload
  // already capped at 200 chars by the caller. Types: number (full-string
  // numeric literal), boolean ('true'/'false', case-insensitive like the repo's
  // saveMetric convention), else string — plain text AND JSON payloads collapse
  // to 'string' (JSON→string per AC-12).
  const s = String(rawText).trim();
  const retainedFlag = !!retained;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return { value: n, type: 'number', raw: String(rawText), retained: retainedFlag };
  }
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false') return { value: lower === 'true', type: 'boolean', raw: String(rawText), retained: retainedFlag };
  return { value: String(rawText), type: 'string', raw: String(rawText), retained: retainedFlag };
}
// ================= /#108 catalog projections =================

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Global rate limiter — 200 requests per 15 min per IP
const globalLimiter = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, limit: 2000, standardHeaders: 'draft-6', legacyHeaders: false });
app.use(globalLimiter);

// Morgan HTTP request logging (stream to winston)
app.use(morgan('combined', { stream: logger.stream }));

// Compression (gzip + brotli)
app.use(compression());

// Session secret — persist across restarts so sessions survive
const SESSION_SECRET_FILE = path.join(__dirname, 'data', 'session-secret');
let sessionSecret = process.env.SESSION_SECRET;
if (sessionSecret) {
  logger.info('Using SESSION_SECRET from environment variable');
} else {
  logger.warn('⚠️  SESSION_SECRET env var not set — using persistent file-based secret');
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      sessionSecret = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (!sessionSecret) throw new Error('Empty secret file');
    } else {
      sessionSecret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
      fs.writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
      logger.info('Generated new session secret and saved to data/session-secret');
    }
  } catch (err) {
    logger.error('Failed to read/write session secret file, falling back to ephemeral:', err.message);
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }
}

// Session middleware
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize database, load profiles, start MQTT and external polling
initializeDatabase();
const db = getDb();
loadProfiles();
loadRs232Profiles();  // RS232 serial inverter profiles
setupMqtt();
startExternalPolling();
startBmsPolling();   // Start BMS bridge polling
startBmsWiredPolling();   // Start BMS wired (Modbus-RTU serial) polling
startDonglePolling();
pvoutput.start();     // Start PVOutput push/pull engines
startSnapshotScheduler();

// Periodic WAL checkpoint — prevents unbounded WAL file growth
// Runs every hour via setInterval (TRUNCATE resets WAL to 0 bytes after full checkpoint)
setInterval(() => {
  try { checkpointWal(); } catch (e) { logger.warn('Periodic WAL checkpoint failed:', e.message); }
}, 60 * 60 * 1000);

// Multer for restore and import
const upload = multer({
  dest: '/tmp/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.db') || file.originalname.endsWith('.json')) cb(null, true);
    else cb(new Error('Only .db or .json files allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Middleware
// Redirect raw editor.html to the protected /editor route (auth gate — issue #87)
app.get('/editor.html', (req, res) => res.redirect('/editor'));
// Serve static files with 1h browser cache
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', immutable: true }));
app.use(express.json());
app.use('/api', csrfProtection);

// Normalize req.body: Express 5 leaves req.body undefined when no parser matched
// (Express 4 defaulted to {}). Restores the v4 default globally.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected WebSocket clients
const wsClients = new Set();

/**
 * Push dashboard state to all connected WebSocket clients.
 * Each client receives JSON: { type: 'dashboard-state', data: state }
 * @param {object} state - built by buildDashboardState()
 */
function broadcastDashboardState(state) {
  const message = JSON.stringify({ type: 'dashboard-state', data: state });
  const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KB
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_SIZE) {
    logger.warn(`WebSocket broadcast blocked: message size ${Buffer.byteLength(message, 'utf8')} exceeds 64KB limit`);
    return;
  }
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message, err => {
        if (err) {
          wsClients.delete(client);
          client.terminate();
        }
      });
    }
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  wsClients.add(ws);
  logger.info(`WebSocket client connected (${wsClients.size} total)`);
  
  (async () => {
    try {
      const state = await buildDashboardState();
      ws.send(JSON.stringify({ type: 'dashboard-state', data: state }));
    } catch (err) {
      logger.error('Error sending initial state via WebSocket:', err);
    }
  })();

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info(`WebSocket client disconnected (${wsClients.size} remaining)`);
  });
  ws.on('error', () => {
    wsClients.delete(ws);
    ws.terminate();
  });
});

/**
 * Build the complete dashboard state object sent via WebSocket and REST API.
 * Aggregates: latest power values, all metrics, savings, grid status/hours/timeline,
 * 24h power history, 7d energy bar data.
 * @returns {Promise<object>} dashboard state
 */
// 24h power history is downsampled into 10-minute buckets so the chart gets a
// bounded, deterministic point count (~145) across the FULL window regardless
// of the raw ~30s poll density (was LIMIT 300, which truncated to ~2.5h).
const POWER_HISTORY_BUCKET_SECONDS = 600;
async function buildDashboardState() {
  const start = Date.now();
  const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
  const dailySolarKwh = computeTodaySolar();
  const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
  const rate = parseFloat(rateRow?.value) || 0.30;
  const currency = getConfig('savings_currency') || '€';
  let currentData = { error: 'No data yet' };
  if (latest) {
    currentData = {
      consumption_kw: latest.consumption / 1000,
      solar_kw: latest.solar / 1000,
      battery_charge_kw: latest.battery_charge / 1000,
      battery_discharge_kw: latest.battery_discharge / 1000,
      battery_power_kw: (latest.battery_charge - latest.battery_discharge) / 1000,
      grid_import_kw: latest.grid_import / 1000,
      grid_export_kw: latest.grid_export / 1000,
      battery_soc: latest.battery_soc,
      daily_consumption_kwh: latest.daily_consumption,
      daily_solar_kwh: dailySolarKwh,
      daily_battery_charge_kwh: latest.daily_battery_charge,
      daily_battery_discharge_kwh: latest.daily_battery_discharge,
      daily_grid_import_kwh: latest.daily_grid_import,
      daily_grid_export_kwh: latest.daily_grid_export,
      savings_currency: currency,
      savings_rate: rate,
      today_savings: dailySolarKwh * rate,
      timestamp: latest.timestamp * 1000
    };
  }
  // Parallelize independent DB/cache calls to avoid N+1 waterfall
  const historySince = Math.floor(Date.now() / 1000) - 24 * 3600;
  const barSince = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const [metrics, savings, gridStatus, historyRows, barRows] = await Promise.all([
    getCurrentMetrics(),
    getSavings(),
    getCurrentGridStatus(),
    db.prepare(`SELECT (timestamp / ${POWER_HISTORY_BUCKET_SECONDS}) * ${POWER_HISTORY_BUCKET_SECONDS} AS timestamp,
       AVG(consumption) as consumption,
       AVG(solar) as solar,
       AVG(battery_charge) as battery_charge,
       AVG(battery_discharge) as battery_discharge,
       AVG(grid_import) as grid_import,
       AVG(grid_export) as grid_export
     FROM history WHERE timestamp >= ?
     GROUP BY (timestamp / ${POWER_HISTORY_BUCKET_SECONDS})
     ORDER BY timestamp ASC`).all(historySince),
    db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history WHERE timestamp >= ?
      GROUP BY day ORDER BY day ASC
    `).all(barSince)
  ]);
  // Parallelize all grid queries — 4 periods + timeline
  const [gridHoursDay, gridHoursWeek, gridHoursMonth, gridHoursYear, gridTimeline] = gridStatus.configured
    ? await Promise.all([
        getGridHours('day'), getGridHours('week'), getGridHours('month'), getGridHours('year'),
        getGridTimeline('24h')
      ])
    : [0, 0, 0, 0, { configured: false, available: false, segments: [], windowStart: 0, windowEnd: 0 }];
  const gridHours = {
    day: gridHoursDay,
    week: gridHoursWeek,
    month: gridHoursMonth,
    year: gridHoursYear,
    // Pass through flags so the frontend can distinguish real 00:00 (measured
    // zero, available=true) from no-data (not configured / unresolvable) — D1.
    configured: gridStatus.configured,
    available: gridStatus.available
  };
  const powerHistory = historyRows.map(r => ({
    timestamp: r.timestamp * 1000,
    consumption_kw: r.consumption / 1000,
    solar_kw: r.solar / 1000,
    battery_charge_kw: r.battery_charge / 1000,
    battery_discharge_kw: r.battery_discharge / 1000,
    battery_power_kw: (r.battery_charge - r.battery_discharge) / 1000,
    grid_import_kw: r.grid_import / 1000,
    grid_export_kw: r.grid_export / 1000
  }));
  const dailyEnergyBar = barRows.map(r => ({
    day: r.day,
    solar_kwh: r.solar_kwh,
    consumption_kwh: r.consumption_kwh,
    battery_charge_kwh: r.battery_charge_kwh,
    battery_discharge_kwh: r.battery_discharge_kwh,
    grid_import_kwh: r.grid_import_kwh,
    grid_export_kwh: r.grid_export_kwh
  }));
  const elapsed = Date.now() - start;
  logger.debug(`buildDashboardState took ${elapsed}ms`);
  return {
    current: currentData,
    metrics,
    savings,
    gridStatus,
    gridHours,
    gridTimeline,
    powerHistory,
    dailyEnergyBar
  };
}

/**
 * Main 30-second polling cycle. Fetches data from all configured sources,
 * builds dashboard state, and broadcasts to WebSocket clients.
 * Runs once immediately on startup, then every 30s via setInterval.
 */
async function pollAllSources() {
  const start = Date.now();
  logger.debug('Polling cycle started');
  try {
    await pollHomeAssistant();
    await pollModbus();
    await pollTuyaDevices();
    await pollRs232();         // RS232 serial inverter polling
    await pollLegacyHistory();
    await pollGridStatus();
    // BMS polling is independent and runs on its own interval
    if (wsClients.size > 0) {
      const state = await buildDashboardState();
      broadcastDashboardState(state);
    }
    const elapsed = Date.now() - start;
    logger.info(`Polling cycle completed in ${elapsed}ms`);
  } catch (err) {
    logger.error('Polling error:', err);
  }
}
pollAllSources();
const pollInterval = setInterval(pollAllSources, 30000);

// ---------- Public API (no auth) ----------
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard', 'savings_currency', 'savings_rate', 'solar_capacity_kwp'];
    const config = {};
    for (const key of keys) config[key] = getConfig(key);
    config.dashboard_title = config.dashboard_title || '⚡ Epilykos';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.set('Cache-Control', 'public, max-age=300');
    res.json(config);
  } catch (err) {
    logger.error('Error in /api/public-config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/current', async (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
    const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const allTimeSolar = db.prepare(`SELECT SUM(daily_solar) as total FROM (SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch'))`).get();
    const allTimeSavings = (allTimeSolar?.total || 0) * rate;
    res.set('Cache-Control', 'public, max-age=10');
    if (latest) {
      const curr = getConfig('savings_currency') || '€';
      const dailySolarKwh = computeTodaySolar();
      res.json({
        consumption_kw: latest.consumption / 1000,
        solar_kw: latest.solar / 1000,
        battery_charge_kw: latest.battery_charge / 1000,
        battery_discharge_kw: latest.battery_discharge / 1000,
        battery_power_kw: (latest.battery_charge - latest.battery_discharge) / 1000,
        grid_import_kw: latest.grid_import / 1000,
        grid_export_kw: latest.grid_export / 1000,
        battery_soc: latest.battery_soc,
        daily_consumption_kwh: latest.daily_consumption,
        daily_solar_kwh: dailySolarKwh,
        daily_battery_charge_kwh: latest.daily_battery_charge,
        daily_battery_discharge_kwh: latest.daily_battery_discharge,
        daily_grid_import_kwh: latest.daily_grid_import,
        daily_grid_export_kwh: latest.daily_grid_export,
        savings_currency: curr,
        savings_rate: rate,
        today_savings: dailySolarKwh * rate,
        all_time_savings: allTimeSavings,
        timestamp: latest.timestamp * 1000
      });
    } else {
      res.json({ error: 'No data yet' });
    }
  } catch (err) {
    logger.error('Error in /api/current:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/history', async (req, res) => {
  const requestedDays = parseInt(req.query.days);
  if (isNaN(requestedDays) || requestedDays < 1) return res.status(400).json({ error: 'days must be a positive integer (1-7)' });
  const days = Math.min(requestedDays, 7);
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = db.prepare(`SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(since);
    res.json(rows.map(r => ({
      ...r,
      consumption_kw: r.consumption / 1000,
      solar_kw: r.solar / 1000,
      battery_charge_kw: r.battery_charge / 1000,
      battery_discharge_kw: r.battery_discharge / 1000,
      battery_power_kw: (r.battery_charge - r.battery_discharge) / 1000,
      grid_import_kw: r.grid_import / 1000,
      grid_export_kw: r.grid_export / 1000,
      timestamp: r.timestamp * 1000
    })));
  } catch (err) {
    logger.error('Error in /api/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/daily', async (req, res) => {
  const requestedDays = parseInt(req.query.days);
  if (isNaN(requestedDays) || requestedDays < 1) return res.status(400).json({ error: 'days must be a positive integer (1-365)' });
  const days = Math.min(requestedDays, 365);
  const now = new Date();
  const dateArray = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateArray.push(d.toISOString().split('T')[0]);
  }
  const startUnix = Math.floor(new Date(dateArray[0] + 'T00:00:00').getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  try {
    // Use MAX(daily_*) — the running cumulative totals — for reliable daily energy
    const rows = db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(startUnix, endUnix);
    const dataMap = {};
    rows.forEach(r => { dataMap[r.day] = r; });
    const result = dateArray.map(date => {
      const d = dataMap[date];
      return {
        day: date,
        consumption_kwh: d?.consumption_kwh || 0,
        solar_kwh: d?.solar_kwh || 0,
        battery_charge_kwh: d?.battery_charge_kwh || 0,
        battery_discharge_kwh: d?.battery_discharge_kwh || 0,
        grid_import_kwh: d?.grid_import_kwh || 0,
        grid_export_kwh: d?.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/daily:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/monthly', async (req, res) => {
  try {
    const now = new Date();
    const months = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        display: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
      });
    }
    const rows = db.prepare(`
      WITH daily_max AS (
        SELECT date(timestamp, 'unixepoch') as day,
          MAX(daily_consumption) as consumption,
          MAX(daily_solar) as solar,
          MAX(daily_battery_charge) as battery_charge,
          MAX(daily_battery_discharge) as battery_discharge,
          MAX(daily_grid_import) as grid_import,
          MAX(daily_grid_export) as grid_export
        FROM history GROUP BY day
      )
      SELECT strftime('%Y-%m', day) as month,
        SUM(consumption) as consumption_kwh,
        SUM(solar) as solar_kwh,
        SUM(battery_charge) as battery_charge_kwh,
        SUM(battery_discharge) as battery_discharge_kwh,
        SUM(grid_import) as grid_import_kwh,
        SUM(grid_export) as grid_export_kwh
      FROM daily_max GROUP BY month ORDER BY month DESC LIMIT 12
    `).all();
    const dataMap = {};
    rows.forEach(r => { dataMap[r.month] = r; });
    const result = months.map(m => {
      const data = dataMap[m.key] || {};
      return {
        month: m.display,
        consumption_kwh: data.consumption_kwh || 0,
        solar_kwh: data.solar_kwh || 0,
        battery_charge_kwh: data.battery_charge_kwh || 0,
        battery_discharge_kwh: data.battery_discharge_kwh || 0,
        grid_import_kwh: data.grid_import_kwh || 0,
        grid_export_kwh: data.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/monthly:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    res.json(await getCurrentGridStatus());
  } catch (err) {
    logger.error('Error in /api/grid/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grid/hours', async (req, res) => {
  try {
    const period = req.query.period || 'day';
    const validPeriods = ['day', 'week', 'month', 'year'];
    if (!validPeriods.includes(period)) return res.status(400).json({ error: `Invalid period. Allowed: ${validPeriods.join(', ')}` });
    const hours = await getGridHours(period);
    res.json({ period, hours });
  } catch (err) {
    logger.error('Error in /api/grid/hours:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grid/timeline', async (req, res) => {
  try {
    const period = req.query.period || '24h';
    const validPeriods = ['24h', '7d', '30d'];
    if (!validPeriods.includes(period)) return res.status(400).json({ error: `Invalid period. Allowed: ${validPeriods.join(', ')}` });
    res.json(await getGridTimeline(period));
  } catch (err) {
    logger.error('Error in /api/grid/timeline:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/savings', async (req, res) => {
  try {
    res.json(await getSavings());
  } catch (err) {
    logger.error('Error in /api/savings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/solar-forecast', async (req, res) => {
  try {
    res.json(await getSolarForecast());
  } catch (err) {
    logger.error('Error in /api/solar-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/solar/intraday', async (req, res) => {
  try {
    const field = req.query.field || 'solar';
    const allowed = ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'];
    if (!allowed.includes(field)) return res.status(400).json({ error: `Invalid field. Allowed: ${allowed.join(', ')}` });
    const now = new Date();
    const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const rows = db.prepare(`SELECT timestamp, ${field} as watts, daily_solar FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(todayStart);
    res.json(rows.map(r => ({ timestamp: r.timestamp, watts: r.watts, daily_solar: r.daily_solar })));
  } catch (err) {
    logger.error('Error in /api/solar/intraday:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard-state', async (req, res) => {
  try {
    const state = await buildDashboardState();
    res.json(state);
  } catch (err) {
    logger.error('Aggregated state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard config endpoint (public) – with error handling
app.get('/api/dashboard-config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const config = getDashboardConfig();
    res.json(config);
  } catch (err) {
    logger.error('Error fetching dashboard config:', err);
    const fallback = {
      dashboards: [{ id: 'main', name: 'Main', layout: [] }],
      activeDashboard: 'main'
    };
    res.status(500).json(fallback);
  }
});

// ---------- Authentication endpoints ----------
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && password === getSettingsPassword()) {
    req.session.authenticated = true;
    logger.info('User logged in successfully');
    return res.json({ success: true });
  }
  logger.warn('Failed login attempt');
  res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy();
  logger.info('User logged out');
  res.redirect('/');
});

// Auth status endpoint (public, but indicates session state)
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ---------- Setup wizard ----------
// Public page (pre-auth; setup.js gates sources behind login)
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// Public status (no session needed)
app.get('/api/wizard/status', (req, res) => {
  try {
    const completed = getConfig('setup_wizard_completed') === 'true';
    const keys = ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices'];
    let hasDataSource = false;
    for (const k of keys) {
      const v = JSON.parse(getConfig(k) || '[]');
      if (Array.isArray(v) && v.length > 0) { hasDataSource = true; break; }
    }
    res.json({ needsSetup: !completed, completed, hasDataSource, passwordEnvManaged });
  } catch (err) {
    logger.error('Error in /api/wizard/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reveal the current password ONLY when not env-managed and not yet completed
app.get('/api/wizard/password', (req, res) => {
  if (!passwordEnvManaged && getConfig('setup_wizard_completed') !== 'true') {
    return res.json({ password: getSettingsPassword() });
  }
  res.status(403).json({ error: 'Password is managed by environment or setup already complete' });
});

// Set the admin password (pre-auth, CSRF-exempt). Auto-login on first-run set (D2).
app.post('/api/wizard/password', (req, res) => {
  const { password } = req.body;
  if (passwordEnvManaged) {
    // Env-managed first-run: the password is fixed by SETTINGS_PASSWORD, so the
    // operator is auto-authenticated (D2 auto-login extension). Only while setup
    // is incomplete; once completed the normal auth flow applies.
    if (getConfig('setup_wizard_completed') === 'true') {
      return res.status(403).json({ error: 'Password is managed by environment' });
    }
    if (req.session) req.session.authenticated = true;
    return res.json({ success: true });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    setSettingsPassword(password);
    if (req.session) req.session.authenticated = true;
    return res.json({ success: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// Mark setup complete (isAuthenticated)
app.post('/api/wizard/complete', isAuthenticated, (req, res) => {
  setConfig('setup_wizard_completed', 'true');
  res.json({ success: true });
});

// "Start fresh" reset — empties ONLY device arrays + role_metrics + flag; never history/metrics/snapshots
app.post('/api/wizard/reset', isAuthenticated, (req, res) => {
  for (const k of ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices']) {
    setConfig(k, '[]');
  }
  setConfig('role_metrics', '{}');
  setConfig('setup_wizard_completed', '');
  res.json({ success: true });
});

// ---------- Protected API (session + CSRF) – no rate limit ----------
app.use('/api/test-forecast', isAuthenticated);
app.get('/api/test-forecast', async (req, res) => {
  try {
    res.json(await testForecast(req.query));
  } catch (err) {
    logger.error('Error in test-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/role-metrics', isAuthenticated);
app.get('/api/role-metrics', (req, res) => {
  const raw = getConfig('role_metrics');
  res.json(raw ? JSON.parse(raw) : {});
});
app.post('/api/role-metrics', (req, res) => {
  const mapping = req.body;
  if (typeof mapping !== 'object' || mapping === null) return res.status(400).json({ error: 'Expected JSON object' });
  setConfig('role_metrics', JSON.stringify(mapping));
  logger.info('[role-metrics] Updated mapping:', mapping);
  res.json({ success: true });
});

app.use('/api/ha-device-entities', isAuthenticated);
app.get('/api/ha-device-entities', async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    res.json(await fetchHAEntities(safeUrl, token));
  } catch (err) {
    logger.error('Error fetching HA entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-10 (#108): enriched HA entity catalog — ONE /states fetch, same SSRF guard
// as /api/ha-device-entities above (allowPrivate:true), same 8-domain filter
// (ha.js L147-156), items enriched with friendly_name/unit/device_class/state/
// attributes. Pure projection (haStatesToCatalog) — no registry, no websocket,
// no writes. The legacy string-array endpoint above is untouched.
app.use('/api/ha/entities', isAuthenticated);
app.get('/api/ha/entities', async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    // CodeQL-recognized sanitizer (mirrors ha.js fetchHAEntities): parse to a
    // URL object, enforce http/https, and pass the URL OBJECT to fetch.
    let u;
    try { u = new URL(String(safeUrl)); } catch (_) { return res.status(400).json({ error: 'Invalid HA URL' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return res.status(400).json({ error: 'HA URL scheme not allowed (must use http or https)' });
    }
    let p = u.pathname.replace(/\/+$/, '');
    if (p === '') p = '/api';
    else if (!p.endsWith('/api')) p = p + '/api';
    u.pathname = p + '/states';
    const response = await fetch(u, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`HA error ${response.status} for GET ${u.toString()}`);
    const states = await response.json();
    res.json(haStatesToCatalog(states));
  } catch (err) {
    logger.error('Error fetching HA entity catalog:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resolve the last-known state of an entity from the latest_metrics table via
// the ha_devices mapping (used when the request does not carry url/token).
function findLatestStateForEntity(entityId) {
  try {
    const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
    for (const device of haDevices) {
      for (const [metric, mapping] of Object.entries(device.entities || {})) {
        // Mapping value is either a plain entity_id string or an object
        // { entityId, actions: [...] } carrying action metadata (AC-1.4).
        const eid = (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) ? mapping.entityId : mapping;
        if (eid === entityId) {
          const row = db.prepare('SELECT value, value_text, value_type FROM latest_metrics WHERE metric = ?').get(metric);
          if (row) {
            return { entity_id: entityId, state: row.value_type ? row.value_text : row.value };
          }
        }
      }
    }
  } catch (err) {
    logger.warn('findLatestStateForEntity error:', err.message);
  }
  return null;
}

app.use('/api/entity-actions', isAuthenticated);
app.get('/api/entity-actions', (req, res) => {
  const { entity } = req.query;
  if (!entity || typeof entity !== 'string' || entity.length > 128) {
    return res.status(400).json({ error: 'Valid entity ID required' });
  }
  res.json({ actions: getEntityActions(entity) });
});

// Spec AC-7.4 — auto-discovery: actions + modes + current state for one entity.
// Auth: isAuthenticated (session). CSRF: the global /api csrfProtection requires
// X-Requested-With on POSTs — settings.js sends it.
app.use('/api/ha/entity-actions', isAuthenticated);
app.post('/api/ha/entity-actions', async (req, res) => {
  const { device: deviceRef, entityId } = req.body || {};
  if (!entityId || typeof entityId !== 'string') {
    return res.status(400).json({ error: 'Valid entity ID required' });
  }
  const trimmed = entityId.trim();
  if (trimmed.length > 128 || !/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(trimmed)) {
    return res.status(400).json({ error: 'Valid entity ID required (domain.entity)' });
  }
  // SSRF guard: resolve the HA device from server-side config only — never
  // trust client-supplied url/token. Mirrors executeHAAction lookup.
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  let device = null;
  if (typeof deviceRef === 'string' && deviceRef !== '') {
    device = haDevices.find(d => d && d.name === deviceRef);
    if (!device && /^\d+$/.test(deviceRef)) {
      device = haDevices[Number(deviceRef)];
    }
  }
  if (device && !device.enabled) device = null;
  if (typeof deviceRef === 'string' && deviceRef !== '' && !device) {
    return res.status(404).json({ error: 'HA device not found' });
  }
  const url = device?.url;
  const token = device?.token;
  const entityIdOk = trimmed;
  if (device && (!url || !token)) {
    return res.status(400).json({ error: 'Configured HA device is missing url/token' });
  }
  try {
    const actions = getActionsForEntity(entityIdOk);
    let modes = { hvac_modes: [], fan_modes: [], min_temp: null, max_temp: null };
    let currentState = null;
    if (url && token) {
      const [modeData, stateRes] = await Promise.all([
        getEntityModes(url, token, entityIdOk),
        fetch(`${url}/api/states/${entityIdOk}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(5000)
        }).catch(() => null)
      ]);
      modes = modeData;
      if (stateRes && stateRes.ok) {
        const st = await stateRes.json().catch(() => null);
        if (st && st.entity_id) {
          currentState = { entity_id: st.entity_id, state: st.state, attributes: st.attributes || {} };
        }
      }
    } else {
      // No device context: DB-only fallback — never fetch with client data.
      currentState = findLatestStateForEntity(entityIdOk);
    }
    res.json({ actions, modes, currentState });
  } catch (err) {
    logger.error('Error in /api/ha/entity-actions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/test-mqtt', isAuthenticated);
app.get('/api/test-mqtt', async (req, res) => {
  // Support pre-save testing: accept broker/username/password from query params
  const broker = req.query.broker || (() => {
    const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
    const device = devices.find(d => d.enabled);
    return device?.broker;
  })();
  const username = req.query.username || null;
  const password = req.query.password || null;
  if (!broker) return res.status(400).json({ error: 'No MQTT broker configured. Enter a broker URL first.' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  const testClient = require('mqtt').connect(safe.url, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { testClient.end(); res.status(500).json({ error: 'Connection timeout' }); }
  }, 5000);
  testClient.on('connect', () => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; res.json({ success: true, message: 'Connected to MQTT broker' }); }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; logger.error('MQTT test connection error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

app.use('/api/test-mqtt-topic', isAuthenticated);
app.get('/api/test-mqtt-topic', async (req, res) => {
  const topic = req.query.topic;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  // Support pre-save testing: accept broker/username/password from query params
  const broker = req.query.broker || (() => {
    const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
    const device = devices.find(d => d.enabled);
    return device?.broker;
  })();
  const username = req.query.username || null;
  const password = req.query.password || null;
  if (!broker) return res.status(400).json({ error: 'No MQTT broker configured' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  const testClient = require('mqtt').connect(safe.url, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { testClient.end(); res.status(500).json({ error: 'No message received within 5 seconds' }); }
  }, 5000);
  testClient.on('connect', () => testClient.subscribe(topic));
  testClient.on('message', (recTopic, message) => {
    if (recTopic === topic) {
      clearTimeout(timeout);
      testClient.end();
      if (!responded) {
        responded = true;
        const val = parseFloat(message.toString());
        if (!isNaN(val)) res.json({ success: true, value: val });
        else res.json({ success: true, value: null, raw: message.toString() });
      }
    }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; logger.error('MQTT topic test error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

// ── MQTT topic discovery ────────────────────────────────────────
app.use('/api/mqtt-discover-topics', isAuthenticated);
app.get('/api/mqtt-discover-topics', async (req, res) => {
  const broker = req.query.broker;
  const username = req.query.username || null;
  const password = req.query.password || null;
  if (!broker) return res.status(400).json({ error: 'Broker URL required' });
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const mqtt = require('mqtt');
  const client = mqtt.connect(safe.url, options);
  let responded = false;
  const topics = new Set();
  // AC-12 (#108): during the 15s window also keep the LAST message payload per
  // topic (payload capped at 200 chars) so the response can carry typed
  // samples; on window end the window is persisted under mqtt_discovery_cache.
  const lastMessageByTopic = new Map();
  const PAYLOAD_CAP = 200;
  const MAX_ENTRIES = 2000;
  const timeout = setTimeout(() => {
    client.end();
    if (!responded) {
      responded = true;
      const sorted = [...topics].sort();
      const entries = [...lastMessageByTopic.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_ENTRIES)
        .map(([topic, sample]) => ({ topic, sample }));
      persistMqttDiscoveryCache(safe.url, entries); // AC-12 — the only config write of the catalog slice
      res.json({ success: true, topics: sorted, count: sorted.length, entries });
    }
  }, 15000);
  client.on('connect', () => {
    client.subscribe('#', (err) => {
      if (err) {
        clearTimeout(timeout);
        client.end();
        if (!responded) { responded = true; logger.error('MQTT subscribe error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
      }
    });
  });
  client.on('message', (topic, message) => {
    if (typeof topic !== 'string') return;
    topics.add(topic);
    let text = '';
    try { text = message.toString('utf8'); } catch (_) { text = ''; }
    lastMessageByTopic.set(topic, mqttSampleOf(text.slice(0, PAYLOAD_CAP), !!(message && message.retain)));
  });
  client.on('error', (err) => {
    clearTimeout(timeout);
    client.end();
    if (!responded) { responded = true; logger.error('MQTT discover error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

// AC-12 (#108): cached MQTT discovery window — returned WITHOUT listening (D9),
// so the MQTT card can re-hydrate rows from a previous 15s window. The broker
// key is the same assertSafeBrokerUrl-normalized URL used at persist time, so
// lookups always match.
app.use('/api/mqtt-discovery-cache', isAuthenticated);
app.get('/api/mqtt-discovery-cache', (req, res) => {
  const broker = req.query.broker;
  if (!broker) return res.status(400).json({ error: 'Broker URL required' });
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  try {
    const cache = JSON.parse(getConfig('mqtt_discovery_cache') || '{}');
    const hit = cache && typeof cache === 'object' ? cache[safe.url] : null;
    res.json({
      success: true,
      broker: safe.url,
      ts: hit ? hit.ts : null,
      entries: hit && Array.isArray(hit.entries) ? hit.entries : []
    });
  } catch (err) {
    logger.error('Error reading mqtt_discovery_cache:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-12 (#108): persist one broker's discovery window under the additive
// mqtt_discovery_cache config key — keyed by normalized broker URL, capped at
// MAX_ENTRIES topics, additive per broker (never reads/writes mqtt_devices; a
// later window for the same broker replaces only that broker's entry).
function persistMqttDiscoveryCache(brokerUrlKey, entries) {
  try {
    const cache = JSON.parse(getConfig('mqtt_discovery_cache') || '{}');
    cache[brokerUrlKey] = { ts: Date.now(), broker: brokerUrlKey, entries };
    setConfig('mqtt_discovery_cache', JSON.stringify(cache));
  } catch (err) {
    logger.error('Error persisting mqtt_discovery_cache:', err.message);
  }
}

app.use('/api/modbus/profiles', isAuthenticated);
app.get('/api/modbus/profiles', (req, res) => {
  res.json(availableProfiles.map(p => ({ id: p.id, name: p.name })));
});

app.use('/api/modbus/profile', isAuthenticated);
app.get('/api/modbus/profile/:id', (req, res) => {
  const { getProfileById } = require('./modules/modbus');
  const profile = getProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

// AC-7 (#108): entity catalog for one modbus profile — one item per
// registers[], id = String(address) (decimal), the exact handle the module
// reverse-lookup consumes (modules/modbus.js L132/L167); name = r.metric (the
// implicit default). Same auth as the profile GET above; pure projection, no
// metric creation, no writes.
app.get('/api/modbus/profile/:id/entities', (req, res) => {
  const { getProfileById } = require('./modules/modbus');
  const profile = getProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  try {
    res.json(modbusProfileEntities(profile));
  } catch (err) {
    logger.error('Error projecting modbus profile entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/test-modbus', isAuthenticated);
app.post('/api/test-modbus', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (device.transport === 'tcp' && !device.host) return res.status(400).json({ error: 'Host required for TCP' });
  if (device.transport === 'serial' && !device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  try {
    const result = await testModbusConnection(device);
    res.json(result);
  } catch (err) {
    logger.error('Modbus test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RS232 API Endpoints ────────────────────────────────────────────────
app.use('/api/rs232/profiles', isAuthenticated);
app.get('/api/rs232/profiles', (req, res) => {
  res.json(rs232Profiles.map(p => ({ id: p.id, name: p.name, protocol: p.protocol })));
});

app.use('/api/rs232/profile', isAuthenticated);
app.get('/api/rs232/profile/:id', (req, res) => {
  const profile = rs232Profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Resolve profile_file alias and return full profile with fields/commands
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const profilePath = path.join(__dirname, 'profiles', 'rs232', `${safeId}.json`);
  try {
    const fullProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    // Issue #108 AC-9: serve the ALIAS-MERGED profile — resolve profile_file
    // exactly like modules/rs232.js resolveAliases() (L117-130), so legacy
    // "📥 Load Profile Fields" renders commands/fields for alias profiles
    // (infinisolar → voltronic-qpigs) instead of the raw file's empty arrays.
    if (fullProfile.profile_file) {
      const targetId = String(fullProfile.profile_file).replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
      const targetPath = path.join(__dirname, 'profiles', 'rs232', `${targetId}.json`);
      if (fs.existsSync(targetPath)) {
        const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        fullProfile.commands = target.commands !== undefined ? target.commands : (fullProfile.commands || []);
        fullProfile.fields = target.fields !== undefined ? target.fields : (fullProfile.fields || []);
        fullProfile.frame_format = target.frame_format !== undefined ? target.frame_format : fullProfile.frame_format;
        fullProfile.call_order = target.call_order !== undefined ? target.call_order : fullProfile.call_order;
        if (!fullProfile.decoder && target.decoder !== undefined) fullProfile.decoder = target.decoder;
      }
    }
    res.json(fullProfile);
  } catch (err) {
    logger.error('Error loading rs232 profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-8 (#108): entity catalog for one rs232 profile — projects the IN-MEMORY
// profile, which loadRs232Profiles()/resolveAliases() already alias-merged, so
// infinisolar yields voltronic's commands. id is the exact decode handle per
// protocol family (see rs232ProfileEntities); pure projection, no writes.
app.get('/api/rs232/profile/:id/entities', (req, res) => {
  const profile = rs232Profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  try {
    res.json(rs232ProfileEntities(profile));
  } catch (err) {
    logger.error('Error projecting rs232 profile entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/rs232/ports', isAuthenticated);
app.get('/api/rs232/ports', async (req, res) => {
  try {
    const ports = await getAvailablePorts();
    res.json(Array.isArray(ports) ? ports : []);
  } catch (err) {
    logger.error('RS232 port scan error:', err);
    res.json([]);
  }
});

app.use('/api/test-rs232', isAuthenticated);
app.post('/api/test-rs232', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (!device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  if (!device.profile) return res.status(400).json({ error: 'Profile required' });
  try {
    const result = await testRs232Connection(device);
    res.json(result);
  } catch (err) {
    logger.error('RS232 test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/dashboard-config', isAuthenticated, (req, res) => {
  try {
    saveDashboardConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error saving dashboard config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard-config/export', isAuthenticated, (req, res) => {
  const config = getDashboardConfig();
  res.setHeader('Content-Disposition', 'attachment; filename="dashboard-layout.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(config);
});

app.post('/api/dashboard-config/import', isAuthenticated, upload.single('layout'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const imported = JSON.parse(content);
    if (!imported.dashboards || !Array.isArray(imported.dashboards)) {
      throw new Error('Invalid dashboard config format');
    }
    // Merge: add imported dashboards to existing ones, avoiding ID collisions
    if (req.query.merge !== 'false') {
      const existing = getDashboardConfig();
      const existingIds = new Set(existing.dashboards.map(d => d.id));
      for (const db of imported.dashboards) {
        if (existingIds.has(db.id)) {
          db.id = 'db_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          if (db.name) db.name += ' (imported)';
        }
        existing.dashboards.push(db);
        existingIds.add(db.id);
      }
      saveDashboardConfig(existing);
    } else {
      saveDashboardConfig(imported);
    }
    fs.unlinkSync(req.file.path);
    res.json({ success: true });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    logger.error('Error importing dashboard config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/backup', isAuthenticated);
app.get('/api/backup', (req, res) => backupDatabase(res));

app.use('/api/restore', isAuthenticated);
app.post('/api/restore', upload.single('dbfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await restoreDatabase(req.file.path);
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) {
    logger.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed, original database restored.' });
  } finally {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
  }
});

// ── Snapshot API ──────────────────────────────────────────────

app.use('/api/snapshots', isAuthenticated);
app.get('/api/snapshots', (req, res) => {
  try {
    res.json(listSnapshots());
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/snapshots/restore/:name', async (req, res) => {
  try {
    const result = await restoreFromSnapshot(decodeURIComponent(req.params.name));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/settings', isAuthenticated);
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

app.post('/api/settings', (req, res) => {
  const updates = req.body;
  try {
    // Reject keys matching sensitive patterns (token, password, secret, key, etc.)
    const sensitivePattern = /_token$|_password$|_secret$/i;
    const sensitiveKeyExempt = ['tuya_cloud'];
    const filteredUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (sensitivePattern.test(key) && !sensitiveKeyExempt.includes(key)) {
        logger.warn(`[Settings] Rejected sensitive key: ${key}`);
        continue;
      }
      filteredUpdates[key] = value;
    }
    const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(filteredUpdates)) {
      // Reject undefined values; coerce null to empty string
      if (value === undefined) continue;
      const safeValue = value === null ? '' : String(value);
      stmt.run(key, safeValue);
    }
    if ('mqtt_devices' in filteredUpdates) restartMqtt();
    if ('external_sources' in filteredUpdates || 'external_poll_interval' in filteredUpdates) restartExternalPolling();
    if ('bms_devices' in filteredUpdates) {
      restartBmsPolling();
      restartBmsWiredPolling();
    }
    if ('bms_banks' in filteredUpdates) {
      // Orphan cleanup: diff old vs new, delete unreferenced bank_* metrics
      const { cleanupOrphanedBankMetrics } = require('./modules/bmsAggregator');
      const oldBanks = JSON.parse(getConfig('bms_banks') || '[]');
      const newBanks = JSON.parse(filteredUpdates['bms_banks']);
      cleanupOrphanedBankMetrics(oldBanks, newBanks);
      // Auto-create bank metrics not yet in the system
      const { createMetric } = require('./modules/metricsManager');
      for (const bank of newBanks) {
        const safeName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
        for (const fn of (bank.functions || [])) {
          try { createMetric(`bank_${fn.output}`, ''); } catch (_) { /* idempotent */ }
        }
        try { createMetric(`bank_${safeName}_devices_online`, ''); } catch (_) {}
        try { createMetric(`bank_${safeName}_last_update`, ''); } catch (_) {}
      }
      restartBmsPolling();
      restartBmsWiredPolling();
    }
    if ('dongle_config' in filteredUpdates) restartDonglePolling();
    if ('pvoutput_config' in filteredUpdates) pvoutput.restart();
    if ('rs232_devices' in filteredUpdates) restartRs232Streaming();
    const forecastKeys = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date'
    ];
    if (Object.keys(filteredUpdates).some(k => forecastKeys.includes(k))) {
      // Force cache reset
    }
    logger.info('Settings saved successfully');
    res.json({ success: true });
  } catch (err) {
    logger.error('[Settings] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Per-section save API ─────────────────────────────────────────

const sensitivePattern = /_token$|_password$|_secret$/i;

/**
 * Helper: save a whitelist of config keys from req.body.
 * Applies the sensitive-key filter, writes to DB, returns saved key list.
 * @param {string[]} allowedKeys - keys to accept
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {{ saved: string[] }}
 */
function saveConfigKeys(allowedKeys, req, res) {
  const updates = req.body;
  const filtered = {};
  for (const key of allowedKeys) {
    if (key in updates) {
      if (sensitivePattern.test(key)) {
        logger.warn(`[Settings] Rejected sensitive key: ${key}`);
        continue;
      }
      const raw = updates[key];
      // Reject undefined values (missing/unset) to avoid "undefined" strings in DB
      if (raw === undefined) continue;
      // Coerce null to empty string instead of "null"
      const value = raw === null ? '' : String(raw);
      filtered[key] = value;
    }
  }
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  const saved = [];
  for (const [key, value] of Object.entries(filtered)) {
    stmt.run(key, value);
    saved.push(key);
  }
  return { saved };
}

// Data sources: ha_devices, mqtt_devices, modbus_devices, rs232_devices,
// external_sources, bms_devices, bms_banks, dongle_config, pvoutput_config
app.post('/api/settings/data-sources', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'ha_devices', 'mqtt_devices', 'modbus_devices', 'rs232_devices',
      'external_sources', 'external_poll_interval',
      'bms_devices', 'bms_banks', 'dongle_config', 'pvoutput_config',
      'tuya_devices', 'tuya_cloud', 'setup_probe_cache'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);

    if ('mqtt_devices' in req.body) restartMqtt();
    if ('external_sources' in req.body || 'external_poll_interval' in req.body) restartExternalPolling();
    if ('bms_devices' in req.body) {
      restartBmsPolling();
      restartBmsWiredPolling();
    }
    if ('bms_banks' in req.body) {
      const { cleanupOrphanedBankMetrics } = require('./modules/bmsAggregator');
      const oldBanks = JSON.parse(getConfig('bms_banks') || '[]');
      const newBanks = JSON.parse(req.body['bms_banks']);
      cleanupOrphanedBankMetrics(oldBanks, newBanks);
      const { createMetric } = require('./modules/metricsManager');
      for (const bank of newBanks) {
        const safeName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
        for (const fn of (bank.functions || [])) {
          try { createMetric(`bank_${fn.output}`, ''); } catch (_) { /* idempotent */ }
        }
        try { createMetric(`bank_${safeName}_devices_online`, ''); } catch (_) {}
        try { createMetric(`bank_${safeName}_last_update`, ''); } catch (_) {}
      }
      restartBmsPolling();
      restartBmsWiredPolling();
    }
    if ('dongle_config' in req.body) restartDonglePolling();
    if ('pvoutput_config' in req.body) pvoutput.restart();
    if ('rs232_devices' in req.body) restartRs232Streaming();

    logger.info(`[Settings/data-sources] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/data-sources] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Metrics: user_metrics only
app.post('/api/settings/metrics', isAuthenticated, (req, res) => {
  try {
    const allowed = ['user_metrics'];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/metrics] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/metrics] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard: layouts, active, and display keys
app.post('/api/settings/dashboard', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'dashboard_layouts', 'dashboard_active',
      'desktop_dashboard', 'mobile_dashboard', 'transparent_blocks',
      'dashboard_bg_color_light', 'dashboard_bg_color_dark',
      'dashboard_bg_image', 'grid_status_entity'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);

    // If saving dashboard_layouts, also update the legacy dashboard_config blob
    if ('dashboard_layouts' in req.body || 'dashboard_active' in req.body) {
      try {
        const layoutsStr = getConfig('dashboard_layouts');
        const active = getConfig('dashboard_active');
        const dashboards = JSON.parse(layoutsStr || '[]');
        const legacyBlob = JSON.parse(getConfig('dashboard_config') || '{}');
        legacyBlob.dashboards = dashboards;
        legacyBlob.activeDashboard = active;
        setConfig('dashboard_config', JSON.stringify(legacyBlob));
      } catch (_) { /* best-effort */ }
    }

    logger.info(`[Settings/dashboard] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/dashboard] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Solar: forecast keys + role_metrics
app.post('/api/settings/solar', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date', 'role_metrics'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/solar] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/solar] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Savings: savings_* keys
app.post('/api/settings/savings', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'savings_currency', 'savings_rate', 'savings_solar_metric',
      'all_time_pv_savings_override'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/savings] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/savings] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Branding: dashboard appearance
app.post('/api/settings/branding', isAuthenticated, (req, res) => {
  try {
    const allowed = ['dashboard_title', 'dashboard_logo', 'dashboard_favicon'];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/branding] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/branding] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Network: network_* keys
app.post('/api/settings/network', isAuthenticated, (req, res) => {
  try {
    const allowed = ['network_local_url', 'network_remote_url'];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/network] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/network] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Backup: no-op (backup is action-based, not config)
app.post('/api/settings/backup', isAuthenticated, (req, res) => {
  res.json({ ok: true, saved: [] });
});

app.post('/api/action', isAuthenticated, async (req, res) => {
  const { source, device, action, entity, params } = req.body;
  
  if (!source || !device || !action) {
    return res.status(400).json({ success: false, error: 'source, device, and action are required' });
  }
  
  try {
    let result;
    switch (source) {
      case 'ha':
        const { executeHAAction } = require('./modules/ha');
        // Route form of the spec signature: (deviceId, action, entityId, params);
        // `action` may be a dotted string 'domain.service' or an object {domain, service}.
        result = await executeHAAction(device, action, entity, params || {});
        break;
      case 'mqtt': {
        const { executeMqttAction } = require('./modules/mqtt');
        // Topic is the entity; payload comes from params.payload or is inferred from the action.
        let payload = params?.payload;
        if (payload === undefined || payload === null) {
          if (action === 'turn_on') payload = 'ON';
          else if (action === 'turn_off') payload = 'OFF';
          else if (action === 'toggle') {
            // Flip the entity's current state; default to 'ON' when unknown.
            const cur = getCurrentMetrics()[entity]?.value;
            const isOn = cur === 'on' || cur === 'ON' || cur === 'true' || cur === '1' || cur === 1 || cur === true;
            payload = isOn ? 'OFF' : 'ON';
          } else {
            payload = '';
          }
        }
        result = await executeMqttAction(device, entity, payload);
        break;
      }
      case 'tuya': {
        const { executeTuyaAction } = require('./modules/tuya');
        // Resolve the device by NAME or dev_id from the tuya_devices config
        const tuyaDevices = JSON.parse(getConfig('tuya_devices') || '[]');
        const tuyaDevice = tuyaDevices.find(d => d && (d.name === device || d.dev_id === device));
        if (!tuyaDevice || !tuyaDevice.enabled) {
          result = { success: false, error: 'Tuya device not found or disabled' };
          break;
        }
        // Map entity → DP number via the device's dps config (dps: { metricName: dpNumber })
        const dpMap = tuyaDevice.dps || {};
        let dpNumber;
        for (const [dpName, dpNum] of Object.entries(dpMap)) {
          if (dpName === entity) { dpNumber = dpNum; break; }
        }
        if (dpNumber === undefined || dpNumber === null) {
          result = { success: false, error: 'DP not found' };
          break;
        }
        // Toggles send true when no explicit value is given — never the literal 'undefined'
        const actionValue = (params?.value === undefined || params?.value === null) ? true : params.value;
        result = await executeTuyaAction(device, dpNumber, actionValue);
        break;
      }
      case 'modbus':
        const { executeModbusAction } = require('./modules/modbus');
        // (deviceName, registerAddr, value, type) — register = entity, type='coil' for coils
        result = await executeModbusAction(device, entity, params?.value, params?.type);
        break;
      case 'rs232':
        const { executeRs232ProfileAction } = require('./modules/rs232');
        // Profile form (deviceName, commandName, value) — the switch/stateSelect
        // components send action = command name and params.value = value.
        result = await executeRs232ProfileAction(device, action, params?.value);
        break;
      case 'dongle': {
        const { executeDongleAction } = require('./modules/dongle');
        // (deviceName, registerAddr, value). The entity may be a namespaced id
        // from the profile entity catalog ('holding:0x0069') or a bare hex
        // register — hand only the register address to the transport. Action
        // strings other than 'write' pass through untouched (executeDongleAction
        // is write-only today; presets are reserved for later).
        const registerAddr = typeof entity === 'string' && entity.includes(':') ? entity.split(':').pop() : entity;
        result = await executeDongleAction(device, registerAddr, params?.value);
        break;
      }
      default:
        return res.status(501).json({ success: false, error: 'Source not yet supported' });
    }
    
    if (result?.error) {
      return res.status(502).json({ success: false, ...result });
    }
    res.json(result);
  } catch (e) {
    logger.error('Action error:', e);
    res.status(500).json({ success: false, error: 'Action failed' });
  }
});

// BMS bridge proxy – browser can't reach bms-bridge directly
const BMS_BRIDGE_URL = process.env.BMS_BRIDGE_URL || 'http://bms-bridge:8020';

app.use('/api/bms', isAuthenticated);

app.get('/api/bms/scan', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const url = force ? `${BMS_BRIDGE_URL}/devices?force_scan=true` : `${BMS_BRIDGE_URL}/devices`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      const text = await r.text();
      logger.error(`BMS scan bridge returned ${r.status}: ${text.slice(0,200)}`);
      return res.status(502).json({ error: `Bridge returned ${r.status}` });
    }
    const data = await r.json();
    res.json(data);
  } catch (err) {
    logger.error('BMS scan proxy error:', err.message);
    res.status(502).json({ error: 'BMS bridge not reachable. Check that bms-bridge container is running.' });
  }
});

app.get('/api/bms/test', async (req, res) => {
  const address = req.query.address;
  if (!address) return res.status(400).json({ error: 'MAC address required' });
  try {
    const r = await fetch(`${BMS_BRIDGE_URL}/device/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      const text = await r.text();
      logger.error(`BMS test bridge returned ${r.status}: ${text.slice(0,200)}`);
      return res.status(502).json({ error: `Bridge returned ${r.status}` });
    }
    const data = await r.json();

    // Store test data in latest_metrics so getAvailableSourceKeys can find it
    try {
      const devices = JSON.parse(getConfig('bms_devices') || '[]');
      const device = devices.find(d => d.address === address);
      if (device && device.name) {
        const db = getDb();
        const now = Math.floor(Date.now() / 1000);
        const stmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
        for (const [key, val] of Object.entries(data)) {
          if (typeof val !== 'number' || isNaN(val)) continue;
          const safeName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
          stmt.run(safeName, val, now);
        }
      }
    } catch (storeErr) {
      logger.warn('Failed to store BMS test data:', storeErr.message);
    }

    res.json(data);
  } catch (err) {
    logger.error('BMS test proxy error:', err.message);
    res.status(502).json({ error: 'BMS bridge not reachable. Check that bms-bridge container is running.' });
  }
});

// BMS wired (Modbus-RTU serial) — test + fields
app.use('/api/bms-wired', isAuthenticated);

// List the metric descriptors (field/label/unit) for a wired BMS profile.
app.get('/api/bms-wired/fields/:profileId', async (req, res) => {
  try {
    const fields = await getBmsWiredFields(req.params.profileId);
    res.json(fields);
  } catch (e) {
    logger.error('BMS-wired fields error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Open a one-off connection and read registers (no DB write).
app.post('/api/bms-wired/test', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (!device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  if (!device.profile) return res.status(400).json({ error: 'Profile required' });
  try {
    const result = await testBmsWiredConnection(device);
    res.json(result);
  } catch (e) {
    logger.error('BMS-wired test error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// BMS bank aggregation — test endpoint
app.post('/api/bms/bank/test', async (req, res) => {
  const bank = req.body;
  if (!bank || !bank.devices || !bank.functions) {
    return res.status(400).json({ error: 'Bank config with devices and functions required' });
  }
  try {
    const { readLatestBmsMetrics, isDeviceFresh, resolveSource, resolveCapacity, computeFunction } = require('./modules/bmsAggregator');
    const pollInterval = parseInt(getConfig('bms_poll_interval')) || 30;
    const stalenessThreshold = pollInterval * 2;
    const now = Math.floor(Date.now() / 1000);

    // Gather raw data and freshness per device
    const deviceStatuses = {};
    const deviceData = {};
    let freshCount = 0;
    for (const device of (bank.devices || [])) {
      const raw = readLatestBmsMetrics(device.name);
      const fresh = isDeviceFresh(raw, stalenessThreshold);
      const newestTs = Object.keys(raw).length > 0
        ? Math.max(...Object.values(raw).map(m => m.timestamp))
        : null;
      deviceData[device.name] = { raw, fresh, device };
      deviceStatuses[device.name] = {
        status: fresh ? 'fresh' : 'stale',
        age_s: newestTs ? now - newestTs : null
      };
      if (fresh) freshCount++;
    }

    const willPublish = (freshCount / (bank.devices.length || 1)) >= 0.5;
    const results = {};
    const warnings = [];

    // Compute each function (preview only — don't write)
    for (const fn of (bank.functions || [])) {
      try {
        const values = [];
        const timestamps = [];
        for (const device of bank.devices) {
          const d = deviceData[device.name];
          if (!d.fresh) { values.push(undefined); timestamps.push(undefined); continue; }
          const src = d.raw[resolveSource(fn, device.name)];
          values.push(src ? src.value : undefined);
          timestamps.push(src ? src.timestamp : undefined);
        }

        let weights = null;
        if (fn.fn === 'weighted_soc' || fn.fn === 'sum_weighted') {
          weights = [];
          let capCount = 0;
          for (const device of bank.devices) {
            const d = deviceData[device.name];
            if (!d.fresh) { weights.push(undefined); continue; }
            const cap = resolveCapacity(device, d.raw);
            if (cap == null) {
              warnings.push(`${device.name}: design_capacity not reported, excluded from ${fn.fn}`);
              weights.push(undefined);
            } else {
              weights.push(cap);
              capCount++;
            }
          }
          if (capCount < 2) {
            warnings.push(`${fn.fn}(${fn.source}): only ${capCount} devices have valid capacity — skipped`);
            continue;
          }
        }

        if (fn.fn === 'sum_weighted') {
          for (let i = 0; i < values.length; i++) {
            if (values[i] != null) values[i] = values[i] / 100;
          }
        }

        if (fn.fn === 'sum' && freshCount < bank.devices.length) {
          warnings.push(`sum(${fn.source}): partial set (${freshCount}/${bank.devices.length} devices) — value undercounted`);
        }

        const result = computeFunction(fn.fn, values, weights, timestamps);
        if (result != null) {
          results[`bank_${fn.output}`] = Math.round(result * 100) / 100;
        }
      } catch (err) {
        logger.error(`BMS bank compute error for ${fn.output}:`, err.message);
        warnings.push(`${fn.output}: computation failed`);
      }
    }

    res.json({
      results,
      devices: deviceStatuses,
      summary: {
        devices_total: bank.devices.length,
        devices_fresh: freshCount,
        will_publish: willPublish
      },
      warnings
    });
  } catch (err) {
    logger.error('BMS bank test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// BMS device source keys — for function row dropdown in UI
app.get('/api/bms/device-metrics/:name', (req, res) => {
  const name = req.params.name;
  if (!name || name.length > 64) return res.status(400).json({ error: 'Invalid device name' });
  try {
    const { getAvailableSourceKeys } = require('./modules/bmsAggregator');
    const keys = getAvailableSourceKeys(name);
    res.json(keys);
  } catch (err) {
    logger.error('BMS device-metrics error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// BMS device connection status — for live indicator dot in settings UI
app.get('/api/bms/device-status', (req, res) => {
  const rawName = req.query.name;
  const name = Array.isArray(rawName) ? rawName[0] : rawName;
  if (!name || name.length > 64) return res.status(400).json({ error: 'Invalid device name' });
  try {
    const { readLatestBmsMetrics, isDeviceFresh } = require('./modules/bmsAggregator');
    const pollInterval = parseInt(getConfig('bms_poll_interval')) || 30;
    const raw = readLatestBmsMetrics(name);
    const connected = isDeviceFresh(raw, pollInterval * 2);
    const newestTs = Object.keys(raw).length > 0
      ? Math.max(...Object.values(raw).map(m => m.timestamp))
      : null;
    res.json({
      name,
      connected,
      metricCount: Object.keys(raw).length,
      lastSeen: newestTs
    });
  } catch (err) {
    logger.error('BMS device-status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Tuya API routes ─────────────────────────────────────────────

app.get('/api/tuya-discover', isAuthenticated, async (req, res) => {
  try {
    // Accept optional ?subnet=192.168.0.0/24 for cross-subnet directed scan
    const rawSubnet = req.query.subnet;
    const subnet = Array.isArray(rawSubnet) ? rawSubnet[0] : (rawSubnet || '');
    if (subnet) {
      // SSRF guard (#71): the directed scan TCP-probes every IP in the subnet
      // from this host, so it must be a valid IPv4 CIDR AND an RFC1918 network.
      const cidrMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet);
      if (!cidrMatch) return res.status(400).json({ error: 'Invalid subnet (expected CIDR like 192.168.0.0/24)' });
      const octets = cidrMatch.slice(1, 5).map(Number);
      const prefix = Number(cidrMatch[5]);
      const invalidOctet = octets.some(o => o > 255);
      const invalidPrefix = prefix > 32;
      const inRfc1918 = (octets[0] === 10) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
      if (invalidOctet || invalidPrefix || !inRfc1918) return res.status(400).json({ error: 'Subnet must be a private RFC1918 network' });
    }
    const devices = await discoverTuyaDevices(subnet || undefined);
    res.json({ success: true, devices });
  } catch (err) {
    logger.error('[Tuya] Discover error:', err);
    res.status(500).json({ error: 'Discovery failed' });
  }
});

app.post('/api/tuya-cloud-fetch', isAuthenticated, async (req, res) => {
  try {
    const { region, access_id, access_secret, user_id } = req.body;
    const devices = await fetchCloudDevices(region, access_id, access_secret, user_id);
    res.json({ success: true, devices });
  } catch (err) {
    logger.error('[Tuya] Cloud fetch error:', err);
    res.status(500).json({ error: 'Cloud fetch failed' });
  }
});

// Smart Life OAuth flow — QR code login (replaces the IoT API credential flow)
app.post('/api/tuya-generate-qr', isAuthenticated, async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const result = await generateQrCode(uid);
    res.json(result);
  } catch (err) {
    logger.error('[Tuya] QR generate error:', err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

app.post('/api/tuya-poll-login', isAuthenticated, async (req, res) => {
  try {
    const { qr_token, uid } = req.body;
    if (!qr_token || !uid) return res.status(400).json({ error: 'qr_token and uid are required' });
    const result = await pollQrLogin(qr_token, uid);
    res.json(result);
  } catch (err) {
    logger.error('[Tuya] Poll login error:', err);
    res.status(500).json({ error: 'Login poll failed' });
  }
});

app.post('/api/tuya-fetch-oauth', isAuthenticated, async (req, res) => {
  try {
    const { token_info } = req.body;
    if (!token_info) return res.status(400).json({ error: 'token_info is required' });
    const devices = await fetchDevicesOAuth(token_info);
    res.json({ success: true, devices });
  } catch (err) {
    logger.error('[Tuya] OAuth fetch error:', err);
    res.status(500).json({ error: 'OAuth device fetch failed' });
  }
});

app.post('/api/test-tuya', isAuthenticated, async (req, res) => {
  try {
    const { dev_id, address, local_key, version } = req.body;
    const result = await testTuyaDevice({ dev_id, address, local_key, version });
    res.json(result);
  } catch (err) {
    logger.error('[Tuya] Test error:', err);
    res.status(500).json({ error: 'Test failed' });
  }
});

app.post('/api/tuya-verify-all', isAuthenticated, async (req, res) => {
  try {
    const { devices } = req.body;
    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'devices array is required' });
    }
    const results = await verifyAllTuyaDevices(devices);
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;
    res.json({ success: true, results, summary: `${successCount}/${totalCount} devices connected` });
  } catch (err) {
    logger.error('[Tuya] Verify all error:', err);
    res.status(500).json({ error: 'Verify all failed' });
  }
});

app.use('/api/test-external', isAuthenticated);
app.post('/api/test-external', async (req, res) => {
  const { url, jsonPath } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    const response = await fetch(safeUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    let value = null;
    if (jsonPath) {
      const parts = jsonPath.split('.');
      let cur = data;
      for (const part of parts) cur = cur?.[part];
      value = cur;
    } else {
      value = data;
    }
    const num = parseFloat(value);
    res.json({ success: true, value: isNaN(num) ? value : num });
  } catch (err) {
    logger.error('Error testing external source:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-11 (#108): REST field catalog — flatten a live JSON document into
// deterministic scalar leaves {path,value,type,sample} with caps (depth ≤ 6
// segments, ≤ 500 leaves, arrays ≤ 100 items). Guard is EXACTLY the
// /api/test-external guard (assertSafeFetchUrl allowPrivate:true), 5s timeout,
// JSON only, and the error contract mirrors the test route. modules/external.js
// is untouched — this route never writes config or metrics.
app.use('/api/external/fields', isAuthenticated);
app.post('/api/external/fields', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    const response = await fetch(safeUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const { leaves, truncated } = flattenJsonLeaves(data, REST_FLATTEN_DEFAULT_CAPS);
    res.json({ leaves, truncated, leafCount: leaves.length });
  } catch (err) {
    logger.error('Error fetching external fields:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== DONGLE ENDPOINTS (protected) ==========
app.get('/api/dongle/profiles', isAuthenticated, (req, res) => {
  try {
    const profilesDir = path.join(__dirname, 'profiles', 'dongles');
    if (!fs.existsSync(profilesDir)) return res.json([]);
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
    const profiles = files.map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf8'));
      return { id: f.replace('.json', ''), name: raw.name, transport: raw.transport, requires_serial: raw.requires_serial, default_port: raw.default_port, default_unit_id: raw.default_unit_id, protocol: raw.protocol, capabilities: raw.capabilities, mapping: raw.mapping };
    });
    res.json(profiles);
  } catch (err) {
    logger.error('Error listing dongle profiles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/dongle/profile', isAuthenticated);
app.get('/api/dongle/profile/:id', (req, res) => {
  try {
    const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const profilePath = path.join(__dirname, 'profiles', 'dongles', `${safeId}.json`);
    if (!fs.existsSync(profilePath)) return res.status(404).json({ error: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    res.json(profile);
  } catch (err) {
    logger.error('Error loading dongle profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Issue #108 AC-2..6: dongle profile entity catalog — thin wrapper over the
// pure projections in modules/entityCatalog.js (dispatcher mirrors modules/
// dongle.js poll branch keys: luxpower-tcp → namespaced ids, felicity-tcp →
// JSON paths, growatt → field ids, every other transport → bare-hex registers).
// luxpower-geta output is byte-identical to the pre-#108 inline handler
// (snapshot fixture test/entity-catalog.test.js). Pure projection — no metric
// creation, no config writes, no poll side effects. 404/500 shapes unchanged.
app.get('/api/dongle/profile/:id/entities', (req, res) => {
  try {
    const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const profilePath = path.join(__dirname, 'profiles', 'dongles', `${safeId}.json`);
    if (!fs.existsSync(profilePath)) return res.status(404).json({ error: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    res.json(entityCatalog.dongleProfileEntities(profile));
  } catch (err) {
    logger.error('Error loading dongle profile entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/dongle/test', isAuthenticated);
app.post('/api/dongle/test', async (req, res) => {
  const { host, port, serial_number, modbus_unit_id, transport } = req.body;
  if (!host) return res.status(400).json({ error: 'Host required' });

  const rawHost = String(host).trim();
  // #103: RFC1918 literals/resolutions (10/8, 172.16/12, 192.168/16) are now
  // ALLOWED for dongle test dials (intranet inverters). Still blocked: loopback
  // 127/8 + ::1 (+ IPv4-mapped), link-local 169.254/16 incl. metadata + fe80::/10,
  // ULA fc00::/7, and unspecified 0.0.0.0/::. isBlockedIp(ip, true) already blocks
  // loopback/link-local/unspecified (and mapped-loopback via its IPv4 re-check)
  // while ALLOWING RFC1918 — but it also allows ULA when allowPrivate is true,
  // so add an explicit fc00::/7 first-hextet check. Anything non-IP → blocked.
  const isRestrictedTestIp = (ip) => {
    if (isBlockedIp(ip, true)) return true;
    if (net.isIP(ip) !== 6) return false; // v4 RFC1918 + public, or 0 → allow
    const first = String(ip).toLowerCase().split(':')[0];
    if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
    return (parseInt(first, 16) & 0xfe00) === 0xfc00; // ULA fc00::/7
  };
  const isValidHostname = (value) => {
    if (value.length > 253) return false;
    const labels = value.split('.');
    return labels.every(label =>
      /^[a-zA-Z0-9-]{1,63}$/.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-')
    );
  };

  const ipVersion = net.isIP(rawHost);
  if (ipVersion) {
    if (isRestrictedTestIp(rawHost.toLowerCase())) {
      return res.status(400).json({ error: 'Host is not allowed' });
    }
  } else {
    if (!isValidHostname(rawHost)) {
      return res.status(400).json({ error: 'Invalid host' });
    }
    const lowered = rawHost.toLowerCase();
    if (lowered === 'localhost' || lowered.endsWith('.local')) {
      return res.status(400).json({ error: 'Host is not allowed' });
    }
  }

  const parsedPort = Number.parseInt(port, 10);
  const safePort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null;
  if (port !== undefined && port !== null && port !== '' && safePort === null) {
    return res.status(400).json({ error: 'Invalid port' });
  }
  // SSRF guard (#71/#103): resolve hostnames up front and dial the RESOLVED IP
  // so a DNS-rebinding swap between validation and connect() cannot redirect the
  // TCP dial to a blocked address. Every A/AAAA record must be either public or
  // RFC1918 (intranet inverters are first-class targets); loopback, link-local/
  // metadata, ULA and unspecified stay blocked (isRestrictedTestIp). Mixed
  // public+blocked resolution sets → blocked. Literal IPs are vetted by the
  // same numeric check above (string-prefix block removed — numeric checks now
  // cover 0.0.0.0 and :: too).
  let safeHost = rawHost;
  if (!net.isIP(rawHost)) {
    let addrs;
    try {
      addrs = await dns.promises.lookup(rawHost, { all: true, verbatim: true });
    } catch (_) {
      return res.status(400).json({ error: 'Invalid host' });
    }
    if (!addrs || addrs.length === 0) return res.status(400).json({ error: 'Invalid host' });
    for (const a of addrs) {
      if (isRestrictedTestIp(a.address)) {
        return res.status(400).json({ error: 'Host is not allowed' });
      }
    }
    safeHost = addrs[0].address;
  }

  try {
    let transportObj;
    if (transport === 'felicity-tcp') {
      transportObj = new (require('./modules/dongle/felicityTcp').FelicityTcpTransport)({ host: safeHost, port: safePort || 53970 });
      const data = await transportObj.poll();
      const count = data.realtime ? Object.keys(data.realtime).length : 0;
      res.json({ success: true, raw: `JSON OK — ${count} realtime keys` });
      return;
    }
    if (transport === 'luxpower-tcp') {
      // #103/AC18: stranded serial_number is usable as the dongle serial too.
      const dongleSerial = String(req.body.dongle_serial || req.body.serial_number || '').trim();
      const inverterSerial = String(req.body.inverter_serial || req.body.serial_number || '').trim();
      if (!dongleSerial || !inverterSerial) {
        return res.status(400).json({ error: 'Dongle serial and inverter serial are required for luxpower-tcp' });
      }
      const LuxpowerTcpTransport = require('./modules/dongle/luxpowerTcp').LuxpowerTcpTransport;
      try {
        transportObj = new LuxpowerTcpTransport({
          host: safeHost,
          port: safePort || 8000,
          dongle_serial: dongleSerial,
          inverter_serial: inverterSerial,
          timeout_ms: 3000
        });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      try {
        // Real read cycle: input register 0x0000 (operational state); values
        // are little-endian words on the wire (see luxpower-geta profile).
        const data = await transportObj.readRegisters(0, 1, 0x04);
        res.json({ success: true, raw: data.readUInt16LE(0) });
      } finally {
        transportObj.stop();
      }
      return;
    }
    if (transport === 'solarman-v5') {
      transportObj = new (require('./modules/dongle/solarmanV5').SolarmanV5Transport)({ host: safeHost, port: safePort || 8899, serial_number, modbus_unit_id: modbus_unit_id || 1 });
    } else {
      transportObj = new (require('./modules/dongle/modbusTcp').ModbusTcpTransport)({ host: safeHost, port: safePort || 502, modbus_unit_id: modbus_unit_id || 1 });
    }
    const data = await transportObj.readRegisters(0x0100, 1);
    res.json({ success: true, raw: data.readUInt16BE(0) });
  } catch (err) {
    logger.warn(`[dongle] test connection failed to ${safeHost}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/dongle/status', isAuthenticated);
app.get('/api/dongle/status', (req, res) => {
  try {
    const raw = getConfig('dongle_config');
    if (!raw || raw === '[]') return res.json([]);
    const config = JSON.parse(raw);
    const result = config.map(inst => ({
      name: inst.name,
      enabled: inst.enabled,
      transport: inst.transport,
      lastSeen: inst.lastSeen || null,
      consecutiveFails: inst.consecutiveFails || 0
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== PVOUTPUT ROUTES ==========
// Public webhook (CSRF skipped in sessionAuth.js — called by PVOutput servers)
app.use('/api/pvoutput/webhook', pvoutput.webhookRouter);
// Protected routes
app.use('/api/pvoutput', isAuthenticated, pvoutput.router);

// ========== METRIC MANAGEMENT ENDPOINTS (protected) ==========
app.get('/api/metrics/list', isAuthenticated, (req, res) => {
  try {
    const { getAllMetrics } = require('./modules/metricsManager');
    const metrics = getAllMetrics();
    res.json(metrics);
  } catch (err) {
    logger.error('Error fetching metrics list:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/metrics/create', isAuthenticated, (req, res) => {
  try {
    const { createMetric } = require('./modules/metricsManager');
    const { name, unit } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    createMetric(name, unit || '');
    res.json({ success: true });
  } catch (err) {
    logger.error('Error creating metric:', err);
    res.status(400).json({ error: 'Failed to create metric' });
  }
});

app.delete('/api/metrics/:name', isAuthenticated, (req, res) => {
  try {
    const { deleteMetric } = require('./modules/metricsManager');
    const { name } = req.params;
    deleteMetric(name);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error deleting metric:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Visual Editor (protected) ----------
app.get('/editor', (req, res) => {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// ---------- Network config (public, read-only) ----------
app.get('/api/network-config', (req, res) => {
  const localURL = getConfig('network_local_url') || '';
  const remoteURL = getConfig('network_remote_url') || '';
  res.json({ localURL, remoteURL });
});

// ---------- Health probe (public, no auth) ----------
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ---------- Settings page (protected) ----------
app.get('/settings', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ---------- Login page (public) ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- Root route (public) ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Metrics endpoints ----------
app.get('/api/metrics/current', async (req, res) => {
  try {
    res.json(getCurrentMetrics());
  } catch (err) {
    logger.error('Error in /api/metrics/current:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics/history', async (req, res) => {
  const metric = req.query.metric;
  if (!metric || typeof metric !== 'string' || metric.length > 128) return res.status(400).json({ error: 'metric is required (max 128 chars)' });
  const hours = parseInt(req.query.hours) || 24;
  if (isNaN(hours) || hours < 1 || hours > 8760) return res.status(400).json({ error: 'hours must be 1-8760' });
  try {
    res.json(getMetricHistory(metric, hours));
  } catch (err) {
    logger.error('Error in /api/metrics/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics/names', async (req, res) => {
  try {
    const rows = db.prepare('SELECT metric FROM latest_metrics ORDER BY metric').all();
    const names = rows.map(r => r.metric);
    res.json(names);
  } catch (err) {
    logger.error('Error in /api/metrics/names:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Catch-all for SPA ----------
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/settings') || req.path.startsWith('/login') || req.path.startsWith('/editor') || req.path.startsWith('/setup') || req.path.match(/\.(css|js|png|jpg|svg|ico)$/)) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start HTTP server with WebSocket support
server.listen(PORT, () => logger.info(`Energy dashboard running on port ${PORT} (session-based auth, log level: ${process.env.LOG_LEVEL || 'info'})`));

// ── Graceful Shutdown ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled promise rejection: ${reason?.stack || reason}`);
});
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  await shutdownRs232();
  clearInterval(pollInterval);
  stopExternalPolling();
  stopBmsPolling();
  stopBmsWiredPolling();
  stopDonglePolling();
  stopSnapshotScheduler();
  for (const client of mqttClients.values()) client.end(true);
  mqttClients.clear();
  wss.close(() => wsClients.clear());
  db.close();
  logger.info('Shutdown complete');
});
process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  await shutdownRs232();
  clearInterval(pollInterval);
  stopExternalPolling();
  stopBmsPolling();
  stopBmsWiredPolling();
  stopDonglePolling();
  stopSnapshotScheduler();
  for (const client of mqttClients.values()) client.end(true);
  mqttClients.clear();
  wss.close(() => wsClients.clear());
  db.close();
  logger.info('Shutdown complete');
});
