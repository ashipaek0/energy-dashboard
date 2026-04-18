require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
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

function parseGridState(state) {
  if (state === null || state === undefined) return 0;
  if (typeof state === 'number') return state > 0 ? 1 : 0;
  const str = String(state).toLowerCase().trim();
  if (str === 'on' || str === 'true' || str === '1' || str === 'open' || str === 'unlocked') return 1;
  return 0;
}

async function initializeDatabase() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
  await db.exec(`
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS grid_status (
      timestamp INTEGER PRIMARY KEY,
      state INTEGER
    );
  `);
  await db.exec(`
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
    'forecast_enabled'
  ];
  for (const key of essentialKeys) {
    const exists = await db.get('SELECT value FROM config WHERE key = ?', key);
    if (!exists) {
      await db.run('INSERT INTO config (key, value) VALUES (?, ?)', [key, '']);
    }
  }
  const defaults = {
    ha_enabled: 'true',
    mqtt_enabled: 'false',
    forecast_enabled: 'false',
    dashboard_title: '⚡ Energy Dashboard',
    savings_currency: '€',
    savings_rate: '0.30'
  };
  for (const [key, val] of Object.entries(defaults)) {
    const row = await db.get('SELECT value FROM config WHERE key = ?', key);
    if (!row || !row.value) await db.run('UPDATE config SET value = ? WHERE key = ?', [val, key]);
  }
  console.log('Database initialized');
  await setupMqtt();
}

// Wait for DB to be ready before starting server
(async () => {
  await initializeDatabase();
  // Start polling only after DB is ready
  pollAndCache();
  setInterval(pollAndCache, 30000);
})();

async function getConfig(key) {
  const row = await db.get('SELECT value FROM config WHERE key = ?', key);
  return row ? row.value : '';
}

async function setConfig(key, value) {
  await db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
}

async function isSourceEnabled(source) {
  const val = await getConfig(source);
  return val === 'true' || val === true;
}

let mqttClient = null;
const mqttValues = {
  consumption: 0, solar: 0, battery_charge: 0, battery_discharge: 0,
  grid_import: 0, grid_export: 0, battery_soc: 0,
  daily_consumption: 0, daily_solar: 0, daily_battery_charge: 0, daily_battery_discharge: 0,
  daily_grid_import: 0, daily_grid_export: 0
};
const topicKeyMap = {};

async function setupMqtt() {
  if (mqttClient) {
    mqttClient.end();
    mqttClient = null;
  }
  for (let k in topicKeyMap) delete topicKeyMap[k];
  const enabled = await isSourceEnabled('mqtt_enabled');
  if (!enabled) return;
  const brokerUrl = await getConfig('mqtt_broker_url');
  if (!brokerUrl) return;
  const options = {};
  const username = await getConfig('mqtt_username');
  const password = await getConfig('mqtt_password');
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
      'mqtt_topic_daily_battery_discharge', 'mqtt_topic_daily_grid_import', 'mqtt_topic_daily_grid_1000'
    ];
    const topics = [];
    for (const k of topicKeys) {
      const topic = await getConfig(k);
      if (topic) {
        topics.push(topic);
        topicKeyMap[topic] = k.replace('mqtt_topic_', '');
      }
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

async function restartMqtt() {
  await setupMqtt();
}

async function getHAState(entityId, haUrl = null, haToken = null) {
  if (!haUrl) haUrl = await getConfig('ha_url');
  if (!haToken) haToken = await getConfig('ha_token');
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
        const entity = await getConfig(haEntityKey);
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
    await db.run(
      `INSERT OR REPLACE INTO history 
       (timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export, battery_soc,
        daily_consumption, daily_solar, daily_battery_charge, daily_battery_discharge, daily_grid_import, daily_grid_export)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now, consumption, solarPower, battCharge, battDischarge, gridImport, gridExport, batterySoc,
       dailyConsumption, dailySolar, dailyBattCharge, dailyBattDischarge, dailyGridImport, dailyGridExport]
    );

    const gridEntity = await getConfig('grid_status_entity');
    if (gridEntity) {
      try {
        const rawState = await getHAState(gridEntity);
        const isOn = parseGridState(rawState);
        const lastRecord = await db.get('SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1');
        if (!lastRecord || lastRecord.state !== isOn) {
          await db.run('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)', [now, isOn]);
          console.log(`Grid state changed to ${isOn ? 'ON' : 'OFF'} (raw: ${rawState})`);
        }
      } catch (e) { console.error('Grid status polling error:', e); }
    }

    console.log(`Cached at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('Polling error:', err);
  }
}

// --- Public API ---
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'savings_currency', 'savings_rate'];
    const config = {};
    for (const key of keys) {
      config[key] = await getConfig(key);
    }
    config.dashboard_title = config.dashboard_title || '⚡ Energy Dashboard';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/current', async (req, res) => {
  try {
    const latest = await db.get('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1');
    const rateRow = await db.get('SELECT value FROM config WHERE key = ?', 'savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const allTimeSolar = await db.get(`
      SELECT SUM(daily_solar) as total FROM (
        SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch')
      )
    `);
    const allTimeSavings = (allTimeSolar?.total || 0) * rate;
    if (latest) {
      const curr = await getConfig('savings_currency') || '€';
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
    } else {
      res.json({ error: 'No data yet' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = await db.all(`SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`, [since]);
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = await db.all(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history WHERE timestamp >= ?
      GROUP BY day ORDER BY day ASC`, [since]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const rows = await db.all(`
      WITH daily_max AS (
        SELECT 
          date(timestamp, 'unixepoch') as day,
          MAX(daily_consumption) as consumption,
          MAX(daily_solar) as solar,
          MAX(daily_battery_charge) as battery_charge,
          MAX(daily_battery_discharge) as battery_discharge,
          MAX(daily_grid_import) as grid_import,
          MAX(daily_grid_export) as grid_1000
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
    `);
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
    console.error('Monthly query error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    const entity = await getConfig('grid_status_entity');
    if (!entity) return res.json({ configured: false });
    const rawState = await getHAState(entity).catch(() => 0);
    const current = parseGridState(rawState);
    const lastOn = await db.get("SELECT timestamp FROM grid_status WHERE state = 1 ORDER BY timestamp DESC LIMIT 1");
    const lastOff = await db.get("SELECT timestamp FROM grid_status WHERE state = 0 ORDER BY timestamp DESC LIMIT 1");
    res.json({
      configured: true,
      current: current === 1,
      lastOn: lastOn ? lastOn.timestamp * 1000 : null,
      lastOff: lastOff ? lastOff.timestamp * 1000 : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getGridStateAt(timestamp) {
  const row = await db.get(
    'SELECT state FROM grid_status WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1',
    [timestamp]
  );
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
  
  try {
    const initialState = await getGridStateAt(startUnix - 1);
    const rows = await db.all(
      `SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
      [startUnix, endUnix]
    );
    
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
      hours += (endUnix - lastTime) / 3600;
    }
    
    res.json({ period, hours: Math.round(hours * 10) / 10 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Savings endpoint
app.get('/api/savings', async (req, res) => {
  try {
    const rateRow = await db.get('SELECT value FROM config WHERE key = ?', 'savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const currency = await getConfig('savings_currency') || '€';

    const now = new Date();
    
    async function getTotalSolarSince(startDate) {
      const startUnix = Math.floor(startDate.getTime() / 1000);
      const rows = await db.all(`
        SELECT MAX(daily_solar) as daily FROM history WHERE timestamp >= ? GROUP BY date(timestamp, 'unixepoch')
      `, [startUnix]);
      return rows.reduce((sum, r) => sum + (r.daily || 0), 0);
    }

    const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
    const todaySolar = await getTotalSolarSince(todayStart);
    const todaySavings = todaySolar * rate;

    const day = now.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - diff); weekStart.setHours(0,0,0,0);
    const weekSolar = await getTotalSolarSince(weekStart);
    const weekSavings = weekSolar * rate;

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthSolar = await getTotalSolarSince(monthStart);
    const monthSavings = monthSolar * rate;

    const allTimeRows = await db.all(`
      SELECT MAX(daily_solar) as daily FROM history GROUP BY date(timestamp, 'unixepoch')
    `);
    const allTimeSolar = allTimeRows.reduce((sum, r) => sum + (r.daily || 0), 0);
    const allTimeSavings = allTimeSolar * rate;

    res.json({
      currency,
      today: todaySavings || 0,
      week: weekSavings || 0,
      month: monthSavings || 0,
      all: allTimeSavings || 0
    });
  } catch (err) {
    console.error('Savings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Solar Forecast endpoint (cached)
let forecastCache = { data: null, timestamp: 0 };
const FORECAST_CACHE_MS = 3 * 60 * 60 * 1000; // 3 hours

app.get('/api/solar-forecast', async (req, res) => {
  try {
    const forecastEnabled = await isSourceEnabled('forecast_enabled');
    if (!forecastEnabled) {
      return res.json({ error: 'Forecast disabled' });
    }

    const now = Date.now();
    if (forecastCache.data && (now - forecastCache.timestamp) < FORECAST_CACHE_MS) {
      return res.json(forecastCache.data);
    }

    const lat = parseFloat(await getConfig('solar_latitude')) || null;
    const lon = parseFloat(await getConfig('solar_longitude')) || null;
    const tilt = parseFloat(await getConfig('solar_tilt')) || 30;
    const azimuth = parseFloat(await getConfig('solar_azimuth')) || 180;
    const capacityKwp = parseFloat(await getConfig('solar_capacity_kwp')) || 0;
    const solcastKey = await getConfig('solcast_api_key');

    if (!lat || !lon || capacityKwp <= 0) {
      return res.json({ error: 'Location or capacity not configured' });
    }

    let forecastData = null;
    let source = 'none';

    // Try Solcast first if API key exists
    if (solcastKey) {
      try {
        const url = `https://api.solcast.com.au/rooftop_sites/forecast?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&format=json`;
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${solcastKey}` }
        });
        if (response.ok) {
          const data = await response.json();
          forecastData = data.forecasts.map(f => ({
            period_end: f.period_end,
            pv_estimate: f.pv_estimate
          }));
          source = 'solcast';
        }
      } catch (e) { console.warn('Solcast fetch failed, falling back to Open-Meteo'); }
    }

    // Fallback to Open-Meteo
    if (!forecastData) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=4`;
      const response = await fetch(url);
      const data = await response.json();
      
      // Convert irradiance (W/m²) to power (kW) using simple model
      // Assume panel efficiency ~20%, 1 kWp ≈ 5 m² → conversion factor
      const conversionFactor = capacityKwp / 1000 * 0.2;
      const hourly = data.hourly;
      forecastData = hourly.time.map((t, i) => ({
        period_end: new Date(t).toISOString(),
        pv_estimate: (hourly.shortwave_radiation[i] * conversionFactor) / 1000
      }));
      source = 'open-meteo';
    }

    // Aggregate to daily totals
    const dailyMap = new Map();
    forecastData.forEach(f => {
      const date = f.period_end.split('T')[0];
      const existing = dailyMap.get(date) || { date, total_kwh: 0, peak_kw: 0, source };
      existing.total_kwh += f.pv_estimate;
      existing.peak_kw = Math.max(existing.peak_kw, f.pv_estimate);
      dailyMap.set(date, existing);
    });

    const daily = Array.from(dailyMap.values()).slice(0, 4);
    const hourly = forecastData.slice(0, 96);

    const result = { daily, hourly, source };
    forecastCache = { data: result, timestamp: now };
    res.json(result);
  } catch (err) {
    console.error('Solar forecast error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Test forecast endpoint (protected)
app.get('/api/test-forecast', authMiddleware, async (req, res) => {
  try {
    const lat = parseFloat(await getConfig('solar_latitude')) || null;
    const lon = parseFloat(await getConfig('solar_longitude')) || null;
    const capacityKwp = parseFloat(await getConfig('solar_capacity_kwp')) || 0;
    const solcastKey = await getConfig('solcast_api_key');
    const tilt = parseFloat(await getConfig('solar_tilt')) || 30;
    const azimuth = parseFloat(await getConfig('solar_azimuth')) || 180;

    if (!lat || !lon || capacityKwp <= 0) {
      return res.status(400).json({ error: 'Location or capacity not configured' });
    }

    let source = 'none';
    let dailyTotal = 0;
    let peak = 0;

    // Try Solcast first if API key exists
    if (solcastKey) {
      try {
        const url = `https://api.solcast.com.au/rooftop_sites/forecast?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&format=json`;
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${solcastKey}` }
        });
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
      } catch (e) { /* fallback */ }
    }

    // Fallback to Open-Meteo
    if (source === 'none') {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=1`;
      const response = await fetch(url);
      const data = await response.json();
      const conversionFactor = capacityKwp / 1000 * 0.2;
      const hourly = data.hourly;
      const today = new Date().toISOString().split('T')[0];
      hourly.time.forEach((t, i) => {
        if (t.startsWith(today)) {
          const pv = (hourly.shortwave_radiation[i] * conversionFactor) / 1000;
          dailyTotal += pv;
          peak = Math.max(peak, pv);
        }
      });
      source = 'open-meteo';
    }

    res.json({
      success: true,
      source,
      today_estimate_kwh: dailyTotal.toFixed(2),
      peak_kw: peak.toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Backup & Restore (protected) ---
app.get('/api/backup', authMiddleware, async (req, res) => {
  try {
    await db.close();
    res.download(DB_PATH, `energy-dashboard-backup-${Date.now()}.db`, async (err) => {
      await initializeDatabase();
      if (err) console.error('Backup download error:', err);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restore', authMiddleware, upload.single('dbfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tempPath = req.file.path;
  try {
    const testDb = await open({ filename: tempPath, driver: sqlite3.Database });
    await testDb.get('SELECT 1');
    await testDb.close();
    await db.close();
    if (mqttClient) { mqttClient.end(); mqttClient = null; }
    fs.copyFileSync(tempPath, DB_PATH);
    await initializeDatabase();
    await setupMqtt();
    fs.unlinkSync(tempPath);
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch (e) {}
    try { await initializeDatabase(); } catch (e) {}
    res.status(500).json({ error: 'Invalid database file: ' + err.message });
  }
});

// --- Settings API (protected) ---
app.use('/api/settings', authMiddleware);

app.get('/api/settings', async (req, res) => {
  const rows = await db.all('SELECT key, value FROM config');
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

app.post('/api/settings', async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    await setConfig(key, String(value));
  }
  if ('mqtt_broker_url' in updates || 'mqtt_username' in updates || 'mqtt_password' in updates || 'mqtt_enabled' in updates) {
    await restartMqtt();
  }
  // Clear forecast cache when settings change
  forecastCache = { data: null, timestamp: 0 };
  res.json({ success: true });
});

app.get('/api/ha/entities', authMiddleware, async (req, res) => {
  let haUrl = req.query.url;
  let haToken = req.query.token;
  if (!haUrl || !haToken) {
    haUrl = await getConfig('ha_url');
    haToken = await getConfig('ha_token');
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-mqtt', authMiddleware, async (req, res) => {
  let brokerUrl = req.query.broker;
  if (!brokerUrl) brokerUrl = await getConfig('mqtt_broker_url');
  if (!brokerUrl) return res.status(400).json({ error: 'MQTT broker URL not configured' });
  const options = {};
  const username = req.query.username || await getConfig('mqtt_username');
  const password = req.query.password || await getConfig('mqtt_password');
  if (username) options.username = username;
  if (password) options.password = password;
  const testClient = mqtt.connect(brokerUrl, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) {
      testClient.end();
      res.status(500).json({ error: 'Connection timeout' });
    }
  }, 5000);
  testClient.on('connect', () => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) {
      responded = true;
      res.json({ success: true, message: 'Connected to MQTT broker' });
    }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) {
      responded = true;
      res.status(500).json({ error: err.message });
    }
  });
});

app.get('/api/test-mqtt-topic', authMiddleware, async (req, res) => {
  let brokerUrl = req.query.broker;
  if (!brokerUrl) brokerUrl = await getConfig('mqtt_broker_url');
  if (!brokerUrl) return res.status(400).json({ error: 'MQTT broker URL not configured' });
  const topic = req.query.topic;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  const options = {};
  const username = req.query.username || await getConfig('mqtt_username');
  const password = req.query.password || await getConfig('mqtt_password');
  if (username) options.username = username;
  if (password) options.password = password;
  const testClient = mqtt.connect(brokerUrl, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) {
      testClient.end();
      res.status(500).json({ error: 'No message received within 5 seconds' });
    }
  }, 5000);
  testClient.on('connect', () => { testClient.subscribe(topic); });
  testClient.on('message', (recTopic, message) => {
    if (recTopic === topic) {
      clearTimeout(timeout);
      testClient.end();
      if (!responded) {
        responded = true;
        const val = parseFloat(message.toString());
        if (!isNaN(val)) {
          res.json({ success: true, value: val });
        } else {
          res.json({ success: true, value: null, raw: message.toString() });
        }
      }
    }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) {
      responded = true;
      res.status(500).json({ error: err.message });
    }
  });
});

app.get('/settings', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.listen(PORT, () => console.log(`Energy dashboard running on port ${PORT}`));
