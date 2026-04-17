require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const basicAuth = require('express-basic-auth');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 3000;

const settingsPassword = process.env.SETTINGS_PASSWORD || 'admin';
const authMiddleware = basicAuth({
  users: { 'admin': settingsPassword },
  challenge: true,
  realm: 'Energy Dashboard Settings'
});

let db;
(async () => {
  db = await open({
    filename: './data/energy.db',
    driver: sqlite3.Database
  });
  // History table
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
  // Grid status table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS grid_status (
      timestamp INTEGER PRIMARY KEY,
      state INTEGER
    );
  `);
  // Config table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const essentialKeys = [
    'ha_url', 'ha_token', 'ha_enabled',
    'solar_assistant_url', 'solar_assistant_api_key', 'solar_enabled',
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
    'savings_currency', 'savings_rate', 'dashboard_title', 'dashboard_logo'
  ];
  for (const key of essentialKeys) {
    const exists = await db.get('SELECT value FROM config WHERE key = ?', key);
    if (!exists) {
      await db.run('INSERT INTO config (key, value) VALUES (?, ?)', [key, '']);
    }
  }
  // Defaults
  const defaults = {
    ha_enabled: 'true',
    solar_enabled: 'false',
    mqtt_enabled: 'false',
    dashboard_title: '⚡ Energy Dashboard',
    savings_currency: '€',
    savings_rate: '0.30'
  };
  for (const [key, val] of Object.entries(defaults)) {
    const row = await db.get('SELECT value FROM config WHERE key = ?', key);
    if (!row || !row.value) await db.run('UPDATE config SET value = ? WHERE key = ?', [val, key]);
  }
  console.log('Database initialized');
  setupMqtt();
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

// MQTT
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
      'mqtt_topic_daily_battery_discharge', 'mqtt_topic_daily_grid_import', 'mqtt_topic_daily_grid_export'
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

// HA helpers
async function getHAState(entityId, haUrl = null, haToken = null) {
  if (!haUrl) haUrl = await getConfig('ha_url');
  if (!haToken) haToken = await getConfig('ha_token');
  if (!haUrl || !haToken || !entityId) return 0;
  const res = await fetch(`${haUrl}/api/states/${entityId}`, {
    headers: { 'Authorization': `Bearer ${haToken}` }
  });
  if (!res.ok) throw new Error(`HA API error: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.state) || 0;
}

async function getSolarData(url = null, key = null) {
  if (!url) url = await getConfig('solar_assistant_url');
  if (!key) key = await getConfig('solar_assistant_api_key');
  if (!url || !key) return null;
  const res = await fetch(`${url}/api/v1/status`, {
    headers: { 'X-Api-Key': key }
  });
  if (!res.ok) throw new Error(`Solar API error: ${res.status}`);
  return await res.json();
}

// Polling
async function pollAndCache() {
  try {
    const haEnabled = await isSourceEnabled('ha_enabled');
    const solarEnabled = await isSourceEnabled('solar_enabled');
    const mqttEnabled = await isSourceEnabled('mqtt_enabled');

    async function getValue(mqttKey, haEntityKey) {
      if (mqttEnabled && mqttValues[mqttKey] !== undefined) return mqttValues[mqttKey];
      if (haEnabled) {
        const entity = await getConfig(haEntityKey);
        if (entity) return await getHAState(entity).catch(() => 0);
      }
      return 0;
    }

    const consumption = await getValue('consumption', 'ha_entity_consumption');
    const battCharge = await getValue('battery_charge', 'ha_entity_battery_charge');
    const battDischarge = await getValue('battery_discharge', 'ha_entity_battery_discharge');
    const gridImport = await getValue('grid_import', 'ha_entity_grid_import');
    const gridExport = await getValue('grid_export', 'ha_entity_grid_export');
    const batterySoc = await getValue('battery_soc', 'ha_entity_battery_soc');

    let solarPower = 0, dailySolar = 0;
    if (solarEnabled) {
      try {
        const sa = await getSolarData();
        if (sa) {
          solarPower = sa.power?.now || 0;
          dailySolar = sa.energy?.today || 0;
        }
      } catch { /* fallback */ }
    }
    if (solarPower === 0) solarPower = await getValue('solar', 'ha_entity_solar');
    if (dailySolar === 0) dailySolar = await getValue('daily_solar', 'ha_entity_daily_solar');

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

    // Grid status
    const gridEntity = await getConfig('grid_status_entity');
    if (gridEntity) {
      try {
        const state = await getHAState(gridEntity);
        const isOn = state > 0 ? 1 : 0;
        const lastRecord = await db.get('SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1');
        if (!lastRecord || lastRecord.state !== isOn) {
          await db.run('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)', [now, isOn]);
          console.log(`Grid state changed to ${isOn ? 'ON' : 'OFF'}`);
        }
      } catch (e) { /* ignore */ }
    }

    console.log(`Cached at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('Polling error:', err);
  }
}

pollAndCache();
setInterval(pollAndCache, 30000);

// --- Public API ---
// Prevent favicon requests from triggering auth prompts
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/current', async (req, res) => {
  try {
    const latest = await db.get('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1');
    if (latest) {
      const curr = await getConfig('savings_currency') || '€';
      const rate = parseFloat(await getConfig('savings_rate')) || 0.30;
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
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0,7));
  }
  try {
    // Get daily max values per day, then sum by month to avoid double counting
    const rows = await db.all(`
      SELECT 
        strftime('%Y-%m', date(timestamp, 'unixepoch')) as month,
        SUM(daily_consumption) as consumption_kwh,
        SUM(daily_solar) as solar_kwh,
        SUM(daily_battery_charge) as battery_charge_kwh,
        SUM(daily_battery_discharge) as battery_discharge_kwh,
        SUM(daily_grid_import) as grid_import_kwh,
        SUM(daily_grid_export) as grid_export_kwh
      FROM (
        SELECT 
          date(timestamp, 'unixepoch') as day,
          MAX(daily_consumption) as daily_consumption,
          MAX(daily_solar) as daily_solar,
          MAX(daily_battery_charge) as daily_battery_charge,
          MAX(daily_battery_discharge) as daily_battery_discharge,
          MAX(daily_grid_import) as daily_grid_import,
          MAX(daily_grid_export) as daily_grid_export
        FROM history
        GROUP BY day
      )
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);
    const result = months.map(m => {
      const found = rows.find(r => r.month === m);
      return found || { month: m, consumption_kwh:0, solar_kwh:0, battery_charge_kwh:0, battery_discharge_kwh:0, grid_import_kwh:0, grid_export_kwh:0 };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    const entity = await getConfig('grid_status_entity');
    if (!entity) return res.json({ configured: false });
    const current = await getHAState(entity).catch(() => 0);
    const lastOn = await db.get("SELECT timestamp FROM grid_status WHERE state = 1 ORDER BY timestamp DESC LIMIT 1");
    const lastOff = await db.get("SELECT timestamp FROM grid_status WHERE state = 0 ORDER BY timestamp DESC LIMIT 1");
    res.json({
      configured: true,
      current: current > 0,
      lastOn: lastOn ? lastOn.timestamp * 1000 : null,
      lastOff: lastOff ? lastOff.timestamp * 1000 : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/hours', async (req, res) => {
  const period = req.query.period || 'day';
  const now = new Date();
  let start, end;
  if (period === 'day') {
    start = new Date(now); start.setHours(0,0,0,0);
    end = new Date(now); end.setHours(23,59,59,999);
  } else if (period === 'week') {
    const day = now.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    start = new Date(now); start.setDate(now.getDate() - diff); start.setHours(0,0,0,0);
    end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23,59,59,999);
  } else if (period === 'year') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31, 23,59,59,999);
  } else {
    return res.status(400).json({ error: 'Invalid period' });
  }
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  try {
    const rows = await db.all(
      `SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
      [startUnix, endUnix]
    );
    let hours = 0;
    let lastState = null;
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
  res.json({ success: true });
});

// Fetch HA entities – supports query params for temporary testing
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

// Test Solar Assistant – accepts query params for temporary test
app.get('/api/test-solar', authMiddleware, async (req, res) => {
  let url = req.query.url;
  let key = req.query.key;
  if (!url || !key) {
    url = await getConfig('solar_assistant_url');
    key = await getConfig('solar_assistant_api_key');
  }
  if (!url || !key) return res.status(400).json({ error: 'Solar Assistant URL or API Key not configured' });
  if (url.includes('solar-assistant.io')) {
    return res.status(400).json({ error: 'Use local IP address (e.g., http://192.168.1.100), not the cloud dashboard URL' });
  }
  try {
    const response = await fetch(`${url}/api/v1/status`, {
      headers: { 'X-Api-Key': key }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    res.json({ success: true, data: { power: data.power?.now, energy: data.energy?.today } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test MQTT broker – accepts query params
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

// Test MQTT topic – accepts query params
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
  testClient.on('connect', () => {
    testClient.subscribe(topic);
  });
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
