require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const basicAuth = require('express-basic-auth');
const mqtt = require('mqtt');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const settingsPassword = process.env.SETTINGS_PASSWORD || 'admin';
const authMiddleware = basicAuth({
  users: { 'admin': settingsPassword },
  challenge: true,
  realm: 'Energy Dashboard Settings'
});

const upload = multer({
  dest: '/tmp/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.db')) {
      cb(null, true);
    } else {
      cb(new Error('Only .db files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

let db;
const DB_PATH = './data/energy.db';

let mqttClient = null;
const mqttValues = {
  consumption: 0, solar: 0, battery_charge: 0, battery_discharge: 0,
  grid_import: 0, grid_export: 0, battery_soc: 0,
  daily_consumption: 0, daily_solar: 0, daily_battery_charge: 0, daily_battery_discharge: 0,
  daily_grid_import: 0, daily_grid_export: 0
};
const topicKeyMap = {};

// Weather code mapping (Flaticon icon classes)
const weatherCodeMap = {
  0: { icon: 'fi fi-sr-sun', desc: 'Clear Sky' },
  1: { icon: 'fi fi-sr-sun', desc: 'Mainly Clear' },
  2: { icon: 'fi fi-sr-cloud-sun', desc: 'Partly Cloudy' },
  3: { icon: 'fi fi-sr-cloud', desc: 'Overcast' },
  45: { icon: 'fi fi-sr-cloud', desc: 'Fog' },
  48: { icon: 'fi fi-sr-cloud', desc: 'Depositing Rime Fog' },
  51: { icon: 'fi fi-sr-cloud-rain', desc: 'Light Drizzle' },
  53: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Drizzle' },
  55: { icon: 'fi fi-sr-cloud-rain', desc: 'Dense Drizzle' },
  61: { icon: 'fi fi-sr-cloud-rain', desc: 'Slight Rain' },
  63: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Rain' },
  65: { icon: 'fi fi-sr-cloud-rain', desc: 'Heavy Rain' },
  80: { icon: 'fi fi-sr-cloud-rain', desc: 'Rain Showers' }
};
const DEFAULT_WEATHER = { icon: 'fi fi-sr-sun', desc: 'Clear Sky' };

function parseGridState(state) {
  if (state === null || state === undefined) return 0;
  if (typeof state === 'number') return state > 0 ? 1 : 0;
  const str = String(state).toLowerCase().trim();
  if (str === 'on' || str === 'true' || str === '1' || str === 'open' || str === 'unlocked') return 1;
  return 0;
}

function initializeDatabase() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      timestamp INTEGER PRIMARY KEY,
      consumption REAL,
      solar REAL,
      battery_charge REAL,
      battery_discharge REAL,
      grid_import REAL,
      grid_export REAL,
      battery_soc REAL,
      daily_consumption REAL,
      daily_solar REAL,
      daily_battery_charge REAL,
      daily_battery_discharge REAL,
      daily_grid_import REAL,
      daily_grid_export REAL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON history(timestamp);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS grid_status (
      timestamp INTEGER PRIMARY KEY,
      state INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const essentialKeys = [
    'ha_url', 'ha_token', 'ha_enabled',
    'mqtt_broker_url', 'mqtt_username', 'mqtt_password', 'mqtt_enabled',
    'mqtt_topic_consumption', 'mqtt_topic_solar', 'mqtt_topic_battery_charge',
    'mqtt_topic_battery_discharge', 'mqtt_topic_grid_import', 'mqtt_topic_grid_export',
    'mqtt_topic_battery_soc',
    'mqtt_topic_daily_consumption', 'mqtt_topic_daily_solar', 'mqtt_topic_daily_battery_charge',
    'mqtt_topic_daily_battery_discharge', 'mqtt_topic_daily_grid_import', 'mqtt_topic_daily_grid_export',
    'ha_entity_consumption', 'ha_entity_solar', 'ha_entity_battery_charge', 'ha_entity_battery_discharge',
    'ha_entity_grid_import', 'ha_entity_grid_export', 'ha_entity_daily_consumption', 'ha_entity_daily_solar',
    'ha_entity_daily_battery_charge', 'ha_entity_daily_battery_discharge', 'ha_entity_daily_grid_import', 'ha_entity_daily_grid_export',
    'ha_entity_battery_soc', 'grid_status_entity',
    'savings_currency', 'savings_rate', 'dashboard_title', 'dashboard_logo',
    'solar_latitude', 'solar_longitude', 'solar_tilt', 'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key',
    'forecast_enabled', 'solar_loss_factor', 'solar_install_date', 'solcast_resource_id',
    'all_time_pv_savings_override'
  ];

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const key of essentialKeys) {
    insertConfig.run(key, '');
  }

  const defaults = {
    ha_enabled: 'true',
    mqtt_enabled: 'false',
    forecast_enabled: 'false',
    dashboard_title: '⚡ Energy Dashboard',
    savings_currency: '€',
    savings_rate: '0.30',
    solar_loss_factor: '0.9',
    solar_install_date: new Date().toISOString().split('T')[0]
  };

  const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?');
  for (const [key, val] of Object.entries(defaults)) {
    updateConfig.run(val, key, '');
  }

  console.log('Database initialized');
  setupMqtt();
}

initializeDatabase();

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setConfig(key, value) {
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    stmt.run(key, String(value));
  } catch (err) {
    console.error(`[setConfig] ERROR for ${key}:`, err.message);
    throw err;
  }
}

async function isSourceEnabled(source) {
  const val = getConfig(source);
  return val === 'true' || val === true;
}

async function setupMqtt() {
  if (mqttClient) { mqttClient.end(); mqttClient = null; }
  for (let k in topicKeyMap) delete topicKeyMap[k];
  const enabled = await isSourceEnabled('mqtt_enabled');
  if (!enabled) return;
  const brokerUrl = getConfig('mqtt_broker_url');
  if (!brokerUrl) return;
  const options = {};
  const username = getConfig('mqtt_username');
  const password = getConfig('mqtt_password');
  if (username) options.username = username;
  if (password) options.password = password;
  mqttClient = mqtt.connect(brokerUrl, options);
  mqttClient.on('connect', async () => {
    console.log('MQTT connected');
    const topicKeys = [
      'mqtt_topic_consumption', 'mqtt_topic_solar', 'mqtt_topic_battery_charge',
      'mqtt_topic_battery_discharge', 'mqtt_topic_grid_import', 'mqtt_topic_grid_export',
      'mqtt_topic_battery_soc',
      'mqtt_topic_daily_consumption', 'mqtt_topic_daily_solar', 'mqtt_topic_daily_battery_charge',
      'mqtt_topic_daily_battery_discharge', 'mqtt_topic_daily_grid_1000', 'mqtt_topic_daily_grid_export'
    ];
    const topics = [];
    for (const k of topicKeys) {
      const topic = getConfig(k);
      if (topic) { topics.push(topic); topicKeyMap[topic] = k.replace('mqtt_topic_', ''); }
    }
    if (topics.length) mqttClient.subscribe(topics);
  });
  mqttClient.on('message', (topic, message) => {
    const val = parseFloat(message.toString());
    if (isNaN(val)) return;
    const key = topicKeyMap[topic];
    if (key) mqttValues[key] = val;
  });
  mqttClient.on('error', (err) => console.error('MQTT error:', err));
}

async function restartMqtt() { await setupMqtt(); }

async function getHAState(entityId, haUrl = null, haToken = null) {
  if (!haUrl) haUrl = getConfig('ha_url');
  if (!haToken) haToken = getConfig('ha_token');
  if (!haUrl || !haToken || !entityId) return 0;
  const res = await fetch(`${haUrl}/api/states/${entityId}`, {
    headers: { 'Authorization': `Bearer ${haToken}` }
  });
  if (!res.ok) throw new Error(`HA API error: ${res.status}`);
  const data = await res.json();
  return data.state;
}

async function pollAndCache() {
  try {
    const haEnabled = await isSourceEnabled('ha_enabled');
    const mqttEnabled = await isSourceEnabled('mqtt_enabled');
    async function getValue(mqttKey, haEntityKey) {
      if (mqttEnabled && mqttValues[mqttKey] !== undefined) return mqttValues[mqttKey];
      if (haEnabled) {
        const entity = getConfig(haEntityKey);
        if (entity) {
          const raw = await getHAState(entity).catch(() => 0);
          return parseFloat(raw) || 0;
        }
      }
      return 0;
    }
    const consumption = await getValue('consumption', 'ha_entity_consumption');
    const battCharge = await getValue('battery_charge', 'ha_entity_battery_charge');
    const battDischarge = await getValue('battery_discharge', 'ha_entity_battery_discharge');
    const gridImport = await getValue('grid_import', 'ha_entity_grid_import');
    const gridExport = await getValue('grid_export', 'ha_entity_grid_export');
    const batterySoc = await getValue('battery_soc', 'ha_entity_battery_soc');
    const solarPower = await getValue('solar', 'ha_entity_solar');
    const dailySolar = await getValue('daily_solar', 'ha_entity_daily_solar');
    const dailyConsumption = await getValue('daily_consumption', 'ha_entity_daily_consumption');
    const dailyBattCharge = await getValue('daily_battery_charge', 'ha_entity_daily_battery_charge');
    const dailyBattDischarge = await getValue('daily_battery_discharge', 'ha_entity_daily_battery_discharge');
    const dailyGridImport = await getValue('daily_grid_import', 'ha_entity_daily_grid_import');
    const dailyGridExport = await getValue('daily_grid_export', 'ha_entity_daily_grid_export');

    const now = Math.floor(Date.now() / 1000);
    const insertHistory = db.prepare(`
      INSERT OR REPLACE INTO history 
      (timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export, battery_soc,
       daily_consumption, daily_solar, daily_battery_charge, daily_battery_discharge, daily_grid_import, daily_grid_export)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertHistory.run(now, consumption, solarPower, battCharge, battDischarge, gridImport, gridExport, batterySoc,
      dailyConsumption, dailySolar, dailyBattCharge, dailyBattDischarge, dailyGridImport, dailyGridExport);

    const gridEntity = getConfig('grid_status_entity');
    if (gridEntity) {
      try {
        const rawState = await getHAState(gridEntity);
        const isOn = parseGridState(rawState);
        const lastRecord = db.prepare('SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1').get();
        if (!lastRecord || lastRecord.state !== isOn) {
          db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(now, isOn);
          console.log(`Grid state changed to ${isOn ? 'ON' : 'OFF'} (raw: ${rawState})`);
        }
      } catch (e) { console.error('Grid status polling error:', e); }
    }
    console.log(`Cached at ${new Date().toISOString()}`);
  } catch (err) { console.error('Polling error:', err); }
}

pollAndCache();
setInterval(pollAndCache, 30000);

// Clear forecast cache at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    forecastCache = { data: null, timestamp: 0 };
    console.log('Forecast cache cleared at midnight');
  }
}, 60000);

// --- Public API ---
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'savings_currency', 'savings_rate', 'solar_capacity_kwp'];
    const config = {};
    for (const key of keys) { config[key] = getConfig(key); }
    config.dashboard_title = config.dashboard_title || '⚡ Energy Dashboard';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/current', async (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
    const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const allTimeSolar = db.prepare(`SELECT SUM(daily_solar) as total FROM (SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch'))`).get();
    const allTimeSavings = (allTimeSolar?.total || 0) * rate;
    if (latest) {
      const curr = getConfig('savings_currency') || '€';
      res.json({
        consumption_kw: latest.consumption / 1000,
        solar_kw: latest.solar / 1000,
        battery_charge_kw: latest.battery_charge / 1000,
        battery_discharge_kw: latest.battery_discharge / 1000,
        grid_import_kw: latest.grid_import / 1000,
        grid_export_kw: latest.grid_export / 1000,
        battery_soc: latest.battery_soc,
        daily_consumption_kwh: latest.daily_consumption,
        daily_solar_kwh: latest.daily_solar,
        daily_battery_charge_kwh: latest.daily_battery_charge,
        daily_battery_discharge_kwh: latest.daily_battery_discharge,
        daily_grid_import_kwh: latest.daily_grid_import,
        daily_grid_export_kwh: latest.daily_grid_export,
        savings_currency: curr,
        savings_rate: rate,
        today_savings: latest.daily_solar * rate,
        all_time_savings: allTimeSavings,
        timestamp: latest.timestamp * 1000
      });
    } else { res.json({ error: 'No data yet' }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/history', async (req, res) => {
  const days = parseInt(req.query.days) || 1;
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
      grid_import_kw: r.grid_import / 1000,
      grid_export_kw: r.grid_export / 1000,
      timestamp: r.timestamp * 1000
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/daily', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history WHERE timestamp >= ?
      GROUP BY day ORDER BY day ASC
    `).all(since);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        SELECT 
          date(timestamp, 'unixepoch') as day,
          MAX(daily_consumption) as consumption,
          MAX(daily_solar) as solar,
          MAX(daily_battery_charge) as battery_charge,
          MAX(daily_battery_discharge) as battery_discharge,
          MAX(daily_grid_import) as grid_import,
          MAX(daily_grid_export) as grid_export
        FROM history
        GROUP BY day
      )
      SELECT 
        strftime('%Y-%m', day) as month,
        SUM(consumption) as consumption_kwh,
        SUM(solar) as solar_kwh,
        SUM(battery_charge) as battery_charge_kwh,
        SUM(battery_discharge) as battery_discharge_kwh,
        SUM(grid_import) as grid_import_kwh,
        SUM(grid_export) as grid_export_kwh
      FROM daily_max
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
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
  } catch (err) { console.error('Monthly query error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    const entity = getConfig('grid_status_entity');
    if (!entity) return res.json({ configured: false });
    const rawState = await getHAState(entity).catch(() => 0);
    const current = parseGridState(rawState);
    const lastOn = db.prepare("SELECT timestamp FROM grid_status WHERE state = 1 ORDER BY timestamp DESC LIMIT 1").get();
    const lastOff = db.prepare("SELECT timestamp FROM grid_status WHERE state = 0 ORDER BY timestamp DESC LIMIT 1").get();
    res.json({
      configured: true,
      current: current === 1,
      lastOn: lastOn ? lastOn.timestamp * 1000 : null,
      lastOff: lastOff ? lastOff.timestamp * 1000 : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function getGridStateAt(timestamp) {
  const row = db.prepare(
    'SELECT state FROM grid_status WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1'
  ).get(timestamp);
  return row ? row.state : 0;
}

app.get('/api/grid/hours', async (req, res) => {
  const period = req.query.period || 'day';
  const now = new Date();
  let start, end;
  
  if (period === 'day') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === 'week') {
    const day = now.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === 'year') {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else {
    return res.status(400).json({ error: 'Invalid period' });
  }
  
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  const currentUnix = Math.floor(now.getTime() / 1000);
  const effectiveEndUnix = Math.min(endUnix, currentUnix);
  
  try {
    const initialState = getGridStateAt(startUnix);
    const rows = db.prepare(
      `SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`
    ).all(startUnix, effectiveEndUnix);
    
    let hours = 0;
    let lastState = initialState;
    let lastTime = startUnix;
    
    for (const row of rows) {
      if (lastState === 1) {
        hours += (row.timestamp - lastTime) / 3600;
      }
      lastState = row.state;
      lastTime = row.timestamp;
    }
    
    if (lastState === 1) {
      hours += (effectiveEndUnix - lastTime) / 3600;
    }
    
    res.json({ period, hours: Math.round(hours * 10) / 10 });
  } catch (err) { console.error('[Grid Hours] Error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/debug/timezone', async (req, res) => {
  const now = new Date();
  res.json({
    localTime: now.toString(),
    iso: now.toISOString(),
    timezoneOffset: now.getTimezoneOffset(),
    envTZ: process.env.TZ || 'not set',
    dayStart: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toString(),
    dayEnd: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toString()
  });
});

app.get('/api/savings', async (req, res) => {
  try {
    const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const currency = getConfig('savings_currency') || '€';

    let todaySolar = 0;
    try {
      const haEnabled = await isSourceEnabled('ha_enabled');
      const mqttEnabled = await isSourceEnabled('mqtt_enabled');
      if (mqttEnabled && mqttValues.daily_solar !== undefined) {
        todaySolar = mqttValues.daily_solar;
      } else if (haEnabled) {
        const haEntity = getConfig('ha_entity_daily_solar');
        if (haEntity) {
          const raw = await getHAState(haEntity).catch(() => 0);
          todaySolar = parseFloat(raw) || 0;
        }
      }
    } catch (e) { console.warn('Failed to fetch live daily solar, using history:', e.message); }

    const todayDate = new Date().toLocaleDateString('en-CA');
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayStartUnix = Math.floor(todayStart.getTime() / 1000);

    const latestTodayRow = db.prepare(`
      SELECT timestamp, daily_solar FROM history 
      WHERE timestamp >= ? AND daily_solar IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(todayStartUnix);

    if (!latestTodayRow) {
      todaySolar = 0;
    } else {
      const rowLocalDate = new Date(latestTodayRow.timestamp * 1000).toLocaleDateString('en-CA');
      if (rowLocalDate !== todayDate) todaySolar = 0;
      else if (todaySolar === 0) {
        const rows = db.prepare(`
          SELECT timestamp, daily_solar FROM history 
          WHERE timestamp >= ? AND daily_solar IS NOT NULL
          ORDER BY timestamp ASC
        `).all(todayStartUnix);
        let maxVal = 0;
        rows.forEach(row => {
          const rowDate = new Date(row.timestamp * 1000).toLocaleDateString('en-CA');
          if (rowDate === todayDate && row.daily_solar > maxVal) maxVal = row.daily_solar;
        });
        todaySolar = maxVal;
      }
    }

    const todaySavings = todaySolar * rate;

    function getTotalSolarSince(startDate) {
      const startUnix = Math.floor(startDate.getTime() / 1000);
      const rows = db.prepare(`
        SELECT timestamp, daily_solar FROM history 
        WHERE timestamp >= ? AND daily_solar IS NOT NULL
        ORDER BY timestamp ASC
      `).all(startUnix);
      const dailyMax = {};
      rows.forEach(row => {
        const date = new Date(row.timestamp * 1000).toLocaleDateString('en-CA');
        const val = row.daily_solar;
        if (!dailyMax[date] || val > dailyMax[date]) { dailyMax[date] = val; }
      });
      return Object.values(dailyMax).reduce((sum, val) => sum + val, 0);
    }

    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - diff); weekStart.setHours(0,0,0,0);
    const weekSolar = getTotalSolarSince(weekStart);
    const weekSavings = weekSolar * rate;

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthSolar = getTotalSolarSince(monthStart);
    const monthSavings = monthSolar * rate;

    let allTimeSavings;
    const overrideValStr = getConfig('all_time_pv_savings_override');
    if (overrideValStr && !isNaN(parseFloat(overrideValStr))) {
      allTimeSavings = parseFloat(overrideValStr);
    } else {
      const allTimeRows = db.prepare(`SELECT timestamp, daily_solar FROM history WHERE daily_solar IS NOT NULL ORDER BY timestamp ASC`).all();
      const allDailyMax = {};
      allTimeRows.forEach(row => {
        const date = new Date(row.timestamp * 1000).toLocaleDateString('en-CA');
        const val = row.daily_solar;
        if (!allDailyMax[date] || val > allDailyMax[date]) { allDailyMax[date] = val; }
      });
      const allTimeSolar = Object.values(allDailyMax).reduce((sum, val) => sum + val, 0);
      allTimeSavings = allTimeSolar * rate;
    }

    res.json({
      currency,
      today: todaySavings || 0,
      week: weekSavings || 0,
      month: monthSavings || 0,
      all: allTimeSavings || 0
    });
  } catch (err) { console.error('Savings error:', err); res.status(500).json({ error: err.message }); }
});

// Helper: get Open-Meteo solar forecast data (now applies loss factor)
async function getOpenMeteoData(lat, lon, capacityKwp, lossFactor) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=4`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo API error: ${response.status}`);
  const data = await response.json();
  const conversionFactor = (capacityKwp / 1000) * (lossFactor || 0.9);   // apply loss factor
  const hourly = data.hourly;
  const forecasts = hourly.time.map((t, i) => ({
    period_end: new Date(t).toISOString(),
    pv_estimate: hourly.shortwave_radiation[i] * conversionFactor
  }));
  return { forecasts, source: 'open-meteo' };
}

// Solar Forecast endpoint (cached)
let forecastCache = { data: null, timestamp: 0 };
const FORECAST_CACHE_MS = 3 * 60 * 60 * 1000;

app.get('/api/solar-forecast', async (req, res) => {
  try {
    const forecastEnabled = await isSourceEnabled('forecast_enabled');
    if (!forecastEnabled) {
      return res.json({ error: 'Forecast disabled' });
    }

    const now = Date.now();
    if (forecastCache.data && (now - forecastCache.timestamp) < FORECAST_CACHE_MS) {
      const cacheDate = forecastCache.data.daily[0]?.date;
      const todayDate = new Date().toLocaleDateString('en-CA');
      if (cacheDate !== todayDate) {
        forecastCache = { data: null, timestamp: 0 };
      } else {
        return res.json(forecastCache.data);
      }
    }

    const lat = parseFloat(getConfig('solar_latitude')) || null;
    const lon = parseFloat(getConfig('solar_longitude')) || null;
    const capacityKwp = parseFloat(getConfig('solar_capacity_kwp')) || 0;
    const solcastKey = getConfig('solcast_api_key');
    const resourceId = getConfig('solcast_resource_id');
    const lossFactor = parseFloat(getConfig('solar_loss_factor')) || 0.9;
    const installDate = getConfig('solar_install_date') || '2020-01-01';

    if (capacityKwp <= 0) {
      return res.json({ error: 'System capacity not configured' });
    }

    let forecastData = null;
    let source = 'none';

    // Attempt Solcast if key is provided
    if (solcastKey) {
      if (resourceId) {
        try {
          const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&api_key=${solcastKey}`;
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            if (data.forecasts && Array.isArray(data.forecasts)) {
              forecastData = data.forecasts.map(f => ({
                period_end: f.period_end,
                pv_estimate: f.pv_estimate
              }));
              source = 'solcast';
            }
          } else {
            const errorText = await response.text();
            console.warn('Solcast (resource) fetch failed:', response.status, errorText);
          }
        } catch (e) { console.warn('Solcast (resource) error:', e.message); }
      }
      if (!forecastData && lat && lon) {
        try {
          const tilt = parseFloat(getConfig('solar_tilt')) || 30;
          const azimuth = parseFloat(getConfig('solar_azimuth')) || 180;
          const url = `https://api.solcast.com.au/world_pv_power/forecasts?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&loss_factor=${lossFactor}&install_date=${installDate}&format=json&api_key=${solcastKey}`;
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            if (data.forecasts && Array.isArray(data.forecasts)) {
              forecastData = data.forecasts.map(f => ({
                period_end: f.period_end,
                pv_estimate: f.pv_estimate
              }));
              source = 'solcast';
            }
          } else {
            const errorText = await response.text();
            console.warn('Solcast (lat/lon) fetch failed:', response.status, errorText);
          }
        } catch (e) { console.warn('Solcast (lat/lon) error:', e.message); }
      }
    }

    if (!forecastData) {
      if (!lat || !lon) {
        return res.json({ error: 'Location (lat/lon) required for Open-Meteo fallback' });
      }
      try {
        const openMeteo = await getOpenMeteoData(lat, lon, capacityKwp, lossFactor);
        forecastData = openMeteo.forecasts;
        source = openMeteo.source;
      } catch (e) {
        console.error('Open-Meteo fallback failed:', e.message);
        return res.json({ error: 'All forecast sources unavailable. Try again later.' });
      }
    }

    let actualTodayKwh = 0;
    const todayDate = new Date().toLocaleDateString('en-CA');
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayStartUnix = Math.floor(todayStart.getTime() / 1000);

    try {
      const haEnabled = await isSourceEnabled('ha_enabled');
      const mqttEnabled = await isSourceEnabled('mqtt_enabled');
      if (mqttEnabled && mqttValues.daily_solar !== undefined) {
        actualTodayKwh = mqttValues.daily_solar;
      } else if (haEnabled) {
        const haEntity = getConfig('ha_entity_daily_solar');
        if (haEntity) {
          const raw = await getHAState(haEntity).catch(() => 0);
          actualTodayKwh = parseFloat(raw) || 0;
        }
      }
    } catch (e) {
      console.warn('Failed to fetch live daily solar, using history:', e.message);
    }

    if (actualTodayKwh === 0) {
      const latestTodayRow = db.prepare(`
        SELECT timestamp, daily_solar FROM history 
        WHERE timestamp >= ? AND daily_solar IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
      `).get(todayStartUnix);
      if (!latestTodayRow) {
        actualTodayKwh = 0;
      } else {
        const rowLocalDate = new Date(latestTodayRow.timestamp * 1000).toLocaleDateString('en-CA');
        if (rowLocalDate !== todayDate) {
          actualTodayKwh = 0;
        } else {
          const todayRows = db.prepare(`
            SELECT timestamp, daily_solar FROM history 
            WHERE timestamp >= ? AND daily_solar IS NOT NULL
            ORDER BY timestamp ASC
          `).all(todayStartUnix);
          let maxVal = 0;
          todayRows.forEach(row => {
            const rowDate = new Date(row.timestamp * 1000).toLocaleDateString('en-CA');
            if (rowDate === todayDate && row.daily_solar > maxVal) maxVal = row.daily_solar;
          });
          actualTodayKwh = maxVal;
        }
      }
    }

    const dailyMap = new Map();
    forecastData.forEach(f => {
      const date = f.period_end.split('T')[0];
      const existing = dailyMap.get(date) || { date, total_kwh: 0, peak_kw: 0, source };
      existing.total_kwh += f.pv_estimate;
      existing.peak_kw = Math.max(existing.peak_kw, f.pv_estimate);
      dailyMap.set(date, existing);
    });

    const daily = Array.from(dailyMap.values()).slice(0, 4);
    
    // Attach actual_so_far but do NOT add it to total_kwh (pure forecast)
    for (const dayEntry of daily) {
      if (dayEntry.date === todayDate) {
        dayEntry.actual_so_far = actualTodayKwh;
        break;
      }
    }

    const hourly = forecastData.slice(0, 96);
    const result = { daily, hourly, source };

    // Fetch weather data (current + 2‑day forecast)
    if (lat && lon) {
      try {
        // Current weather
        const currentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m,apparent_temperature&timezone=auto&forecast_days=1`;
        const currentRes = await fetch(currentUrl);
        let temp = null, feelsLike = null, humidity = null;
        let iconClass = DEFAULT_WEATHER.icon;
        let weatherDesc = DEFAULT_WEATHER.desc;

        if (currentRes.ok) {
          const currentData = await currentRes.json();
          const cw = currentData.current_weather;
          temp = cw.temperature;
          const code = cw.weathercode;
          const mapping = weatherCodeMap[code] || DEFAULT_WEATHER;
          iconClass = mapping.icon;
          weatherDesc = mapping.desc;

          const hourlyData = currentData.hourly;
          const times = hourlyData.time.map(t => new Date(t));
          for (let i = 0; i < times.length; i++) {
            if (times[i].getHours() === new Date().getHours()) {
              feelsLike = hourlyData.apparent_temperature[i];
              humidity = hourlyData.relativehumidity_2m[i];
              break;
            }
          }
        }

        // Daily weather for 3 full days (indices: 1 = tomorrow, 2 = day after)
        let forecastWeather = [];
        const dailyWeatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,apparent_temperature_max,relativehumidity_2m_mean&timezone=auto&forecast_days=3`;
        const dailyWeatherRes = await fetch(dailyWeatherUrl);

        if (dailyWeatherRes.ok) {
          const dailyWeatherData = await dailyWeatherRes.json();
          const dates = dailyWeatherData.daily.time;
          const codes = dailyWeatherData.daily.weathercode;
          const temps = dailyWeatherData.daily.temperature_2m_max;
          const feels = dailyWeatherData.daily.apparent_temperature_max;
          const humids = dailyWeatherData.daily.relativehumidity_2m_mean;

          function getDayName(dateStr) {
            const d = new Date(dateStr + 'T12:00:00');
            return d.toLocaleDateString('en-US', { weekday: 'long' });
          }

          for (let i = 1; i <= 2; i++) {
            if (i < dates.length) {
              const mapping = weatherCodeMap[codes[i]] || DEFAULT_WEATHER;
              forecastWeather.push({
                date: dates[i],
                day_name: getDayName(dates[i]),
                icon_class: mapping.icon,
                desc: mapping.desc,
                temp: temps[i],
                extra: (feels[i] != null ? `Feels ${feels[i].toFixed(0)}°C` : '') +
                       (humids[i] != null ? ` · Humidity ${humids[i].toFixed(0)}%` : '')
              });
            }
          }
        }

        result.weather = {
          icon_class: iconClass,
          desc: weatherDesc,
          temp,
          extra: (feelsLike != null ? `Feels ${feelsLike.toFixed(0)}°C` : '') +
                 (humidity != null ? ` · Humidity ${humidity}%` : ''),
          forecast_weather: forecastWeather
        };
      } catch (e) {
        console.warn('Weather data fetch failed:', e.message);
        result.weather = {
          icon_class: DEFAULT_WEATHER.icon,
          desc: DEFAULT_WEATHER.desc,
          temp: null,
          extra: '',
          forecast_weather: []
        };
      }
    } else {
      result.weather = {
        icon_class: DEFAULT_WEATHER.icon,
        desc: DEFAULT_WEATHER.desc,
        temp: null,
        extra: '',
        forecast_weather: []
      };
    }

    forecastCache = { data: result, timestamp: now };
    res.json(result);
  } catch (err) {
    console.error('Solar forecast error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-forecast', authMiddleware, async (req, res) => {
  try {
    const latStr = getConfig('solar_latitude');
    const lonStr = getConfig('solar_longitude');
    const capStr = getConfig('solar_capacity_kwp');
    
    if (!latStr || !lonStr || !capStr) {
      return res.status(400).json({ error: 'Latitude, longitude, and capacity are required' });
    }
    
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    const capacityKwp = parseFloat(capStr);
    
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Invalid latitude or longitude format' });
    }
    if (isNaN(capacityKwp) || capacityKwp <= 0) {
      return res.status(400).json({ error: 'System capacity must be a positive number (kWp)' });
    }

    const solcastKey = getConfig('solcast_api_key');
    const resourceId = getConfig('solcast_resource_id');
    const tilt = parseFloat(getConfig('solar_tilt')) || 30;
    const azimuth = parseFloat(getConfig('solar_azimuth')) || 180;
    const lossFactor = parseFloat(getConfig('solar_loss_factor')) || 0.9;
    const installDate = getConfig('solar_install_date') || '2020-01-01';

    let source = 'none';
    let dailyTotal = 0;
    let peak = 0;

    if (solcastKey) {
      if (resourceId) {
        try {
          const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&api_key=${solcastKey}`;
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            const forecasts = data.forecasts || [];
            const today = new Date().toISOString().split('T')[0];
            forecasts.forEach(f => {
              if (f.period_end.startsWith(today)) {
                dailyTotal += f.pv_estimate;
                peak = Math.max(peak, f.pv_estimate);
              }
            });
            source = 'solcast';
          }
        } catch (e) { console.warn('Solcast (resource) test failed:', e.message); }
      }
      if (source === 'none') {
        try {
          const url = `https://api.solcast.com.au/world_pv_power/forecasts?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&loss_factor=${lossFactor}&install_date=${installDate}&format=json&api_key=${solcastKey}`;
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            const forecasts = data.forecasts || [];
            const today = new Date().toISOString().split('T')[0];
            forecasts.forEach(f => {
              if (f.period_end.startsWith(today)) {
                dailyTotal += f.pv_estimate;
                peak = Math.max(peak, f.pv_estimate);
              }
            });
            source = 'solcast';
          }
        } catch (e) { console.warn('Solcast (lat/lon) test failed:', e.message); }
      }
    }

    if (source === 'none') {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=1`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Open-Meteo API error: ${response.status}`);
        const data = await response.json();
        const conversionFactor = (capacityKwp / 1000) * lossFactor;
        const hourly = data.hourly;
        const today = new Date().toISOString().split('T')[0];
        hourly.time.forEach((t, i) => {
          if (t.startsWith(today)) {
            const pv = hourly.shortwave_radiation[i] * conversionFactor;
            dailyTotal += pv;
            peak = Math.max(peak, pv);
          }
        });
        source = 'open-meteo';
      } catch (e) {
        return res.status(500).json({ error: `Forecast service unavailable: ${e.message}` });
      }
    }

    res.json({
      success: true,
      source,
      today_estimate_kwh: dailyTotal.toFixed(2),
      peak_kw: peak.toFixed(2)
    });
  } catch (err) { console.error('Test forecast error:', err); res.status(500).json({ error: err.message }); }
});

// --- Backup & Restore (protected) ---
app.get('/api/backup', authMiddleware, (req, res) => {
  try {
    if (db) db.close();
    res.download(DB_PATH, `energy-dashboard-backup-${Date.now()}.db`, (err) => {
      initializeDatabase();
      if (err) console.error('Backup download error:', err);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/restore', authMiddleware, upload.single('dbfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tempPath = req.file.path;
  try {
    const testDb = new Database(tempPath);
    testDb.prepare('SELECT 1').get();
    testDb.close();
    
    if (db) db.close();
    if (mqttClient) { mqttClient.end(); mqttClient = null; }
    
    fs.copyFileSync(tempPath, DB_PATH);
    initializeDatabase();
    await setupMqtt();
    fs.unlinkSync(tempPath);
    
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch (e) {}
    try { initializeDatabase(); } catch (e) {}
    res.status(500).json({ error: 'Invalid database file: ' + err.message });
  }
});

// --- Settings API (protected) ---
app.use('/api/settings', authMiddleware);

app.get('/api/settings', async (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

app.post('/api/settings', async (req, res) => {
  const updates = req.body;
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, String(value));
    }
    if ('mqtt_broker_url' in updates || 'mqtt_username' in updates || 'mqtt_password' in updates || 'mqtt_enabled' in updates) {
      await restartMqtt();
    }
    const forecastKeys = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date'
    ];
    if (Object.keys(updates).some(k => forecastKeys.includes(k))) {
      forecastCache = { data: null, timestamp: 0 };
      console.log('Forecast cache cleared – settings changed');
    }
    res.json({ success: true });
  } catch (err) { console.error('[Settings] Save error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/ha/entities', authMiddleware, async (req, res) => {
  let haUrl = req.query.url;
  let haToken = req.query.token;
  if (!haUrl || !haToken) {
    haUrl = getConfig('ha_url');
    haToken = getConfig('ha_token');
  }
  if (!haUrl || !haToken) return res.status(400).json({ error: 'HA not configured' });
  try {
    const response = await fetch(`${haUrl}/api/states`, {
      headers: { 'Authorization': `Bearer ${haToken}` }
    });
    if (!response.ok) throw new Error(`HA error ${response.status}`);
    const data = await response.json();
    const sensors = data.filter(e => e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.')).map(e => e.entity_id);
    res.json(sensors);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/test-mqtt', authMiddleware, async (req, res) => {
  let brokerUrl = req.query.broker;
  if (!brokerUrl) brokerUrl = getConfig('mqtt_broker_url');
  if (!brokerUrl) return res.status(400).json({ error: 'MQTT broker URL not configured' });
  const options = {};
  const username = req.query.username || getConfig('mqtt_username');
  const password = req.query.password || getConfig('mqtt_password');
  if (username) options.username = username;
  if (password) options.password = password;
  const testClient = mqtt.connect(brokerUrl, options);
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
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });
});

app.get('/api/test-mqtt-topic', authMiddleware, async (req, res) => {
  let brokerUrl = req.query.broker;
  if (!brokerUrl) brokerUrl = getConfig('mqtt_broker_url');
  if (!brokerUrl) return res.status(400).json({ error: 'MQTT broker URL not configured' });
  const topic = req.query.topic;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  const options = {};
  const username = req.query.username || getConfig('mqtt_username');
  const password = req.query.password || getConfig('mqtt_password');
  if (username) options.username = username;
  if (password) options.password = password;
  const testClient = mqtt.connect(brokerUrl, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { testClient.end(); res.status(500).json({ error: 'No message received within 5 seconds' }); }
  }, 5000);
  testClient.on('connect', () => { testClient.subscribe(topic); });
  testClient.on('message', (recTopic, message) => {
    if (recTopic === topic) {
      clearTimeout(timeout);
      testClient.end();
      if (!responded) {
        responded = true;
        const val = parseFloat(message.toString());
        if (!isNaN(val)) { res.json({ success: true, value: val }); }
        else { res.json({ success: true, value: null, raw: message.toString() }); }
      }
    }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });
});

app.get('/settings', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.listen(PORT, () => console.log(`Energy dashboard running on port ${PORT}`));
