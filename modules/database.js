/**
 * SQLite Database Layer
 *
 * Single-file SQLite database at ./data/energy.db (WAL mode for concurrent reads).
 * Tables: history (power time-series), grid_status (ON/OFF state changes),
 * config (key-value settings), metrics (time-series), latest_metrics (current values).
 *
 * Key functions:
 * - getConfig(key) / setConfig(key, value) — key-value config store
 * - initializeDatabase() — creates tables, seeds defaults, migrates legacy configs
 *
 * @module database
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

let db;
const DB_PATH = './data/energy.db';

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function initializeDatabase() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      logger.error(`Cannot create data directory ${dataDir}: ${err.message}. Falling back to in-memory database.`);
      db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      return;
    }
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
    CREATE INDEX IF NOT EXISTS idx_grid_status_state ON grid_status(state);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      timestamp INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      PRIMARY KEY (timestamp, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_metric_ts ON metrics(metric, timestamp);
    CREATE TABLE IF NOT EXISTS latest_metrics (
      metric TEXT PRIMARY KEY,
      value REAL,
      timestamp INTEGER,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const hasColumn = (tableName, columnName) => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.some(c => c.name === columnName);
  };

  const addColumnIfNotExists = (tableName, columnName, definition) => {
    if (!hasColumn(tableName, columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  };

  // Safe schema migrations with explicit PRAGMA column checking
  addColumnIfNotExists('latest_metrics', 'unit', 'TEXT');
  addColumnIfNotExists('latest_metrics', 'value_text', 'TEXT');
  addColumnIfNotExists('latest_metrics', 'value_type', "TEXT DEFAULT 'number'");
  addColumnIfNotExists('metrics', 'value_text', 'TEXT');
  addColumnIfNotExists('metrics', 'value_type', "TEXT DEFAULT 'number'");

  // PVOutput integration tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS pvoutput_upload_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT NOT NULL,
      time         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      reason       TEXT,
      status       TEXT DEFAULT 'pending',
      attempts     INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL,
      uploaded_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pvoutput_queue_date_status ON pvoutput_upload_queue(date, status);

    CREATE TABLE IF NOT EXISTS pvoutput_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT NOT NULL,
      time         TEXT NOT NULL,
      energy_gen   INTEGER,
      power_gen    INTEGER,
      energy_con   INTEGER,
      power_con    INTEGER,
      efficiency   REAL,
      temperature  REAL,
      voltage      REAL,
      UNIQUE(date, time)
    );
    CREATE INDEX IF NOT EXISTS idx_pvoutput_history_date ON pvoutput_history(date);

    CREATE TABLE IF NOT EXISTS pvoutput_daily_outputs (
      date         TEXT PRIMARY KEY,
      energy_gen   INTEGER,
      peak_power   INTEGER,
      peak_time    TEXT,
      energy_con   INTEGER,
      temperature_min REAL,
      temperature_max REAL,
      condition    TEXT,
      status       TEXT DEFAULT 'pending',
      attempts     INTEGER DEFAULT 0,
      source       TEXT NOT NULL DEFAULT 'push'
    );

    CREATE TABLE IF NOT EXISTS pvoutput_alerts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id        TEXT,
      alert_type       INTEGER,
      message          TEXT,
      pvoutput_datetime TEXT,
      received_at      TEXT NOT NULL,
      acknowledged     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pvoutput_alerts_type ON pvoutput_alerts(alert_type, acknowledged);

    CREATE TABLE IF NOT EXISTS pvoutput_system (
      system_id    TEXT PRIMARY KEY,
      system_name  TEXT,
      system_size  INTEGER,
      postcode     TEXT,
      install_date TEXT,
      latitude     REAL,
      longitude    REAL,
      status_interval INTEGER,
      fetched_at   TEXT
    );
  `);

  // Ensure essential keys exist
  const essentialKeys = [
    'ha_devices', 'mqtt_devices', 'modbus_devices', 'dashboard_config',
    'solar_latitude', 'solar_longitude', 'solar_tilt', 'solar_azimuth',
    'solar_capacity_kwp', 'solcast_api_key', 'forecast_enabled',
    'solar_loss_factor', 'solar_install_date', 'solcast_resource_id',
    'savings_currency', 'savings_rate', 'savings_solar_metric', 'dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard',
    'grid_status_entity', 'all_time_pv_savings_override', 'external_sources', 'external_poll_interval',
    'user_metrics', 'bms_devices', 'dongle_config', 'pvoutput_config', 'pvoutput_stats_cache', 'pvoutput_rate_limit_state',
    'rs232_devices',
    'tuya_devices',
    'tuya_cloud',
    // Dashboard blob split: new granular keys
    'dashboard_layouts', 'dashboard_active',
    // Network
    'network_local_url', 'network_remote_url',
    // Setup wizard
    'setup_wizard_completed'
  ];

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?');

  const seedTransaction = db.transaction(() => {
    for (const key of essentialKeys) insertConfig.run(key, '');
    // Default values
    const defaults = {
      forecast_enabled: 'false',
      dashboard_title: '⚡ Epilykos',
      savings_currency: '€',
      savings_rate: '0.30',
      solar_loss_factor: '0.9',
      solar_install_date: new Date().toISOString().split('T')[0],
      external_poll_interval: '60'
    };
    for (const [key, val] of Object.entries(defaults)) updateConfig.run(val, key, '');
  });
  seedTransaction();

  // Legacy migration
  migrateLegacyConfig();

  // Dashboard blob split migration (must run before default init)
  migrateDashboardConfigBlob();

  // Ensure dashboard_layouts exists with valid JSON (post-migration)
  const dashLayouts = getConfig('dashboard_layouts');
  if (!dashLayouts || dashLayouts === '' || dashLayouts === 'null') {
    const defaultLayouts = JSON.parse(`[{"id":"main","name":"Main","layout":[{"id":"b_1784465890590_20sz","type":"forecast-pvtoday","gridX":0,"gridY":12,"gridW":12,"gridH":8,"enabled":true,"config":{"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","location_name":"Solar Forecast - Lagos","metrics":{"generated":"PV Power"}},"transparent":true,"bgColor":"","fontColor":"","fontSize":""},{"id":"b_1784465948035_e0n4","type":"grid-card","gridX":0,"gridY":20,"gridW":12,"gridH":6,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"#000000","fontColor":"#000000","fontSize":"","metrics":{"grid_status":"Grid Status"},"showTimeline":true}},{"id":"b_1784466238742_nhu9","type":"savings-summary","gridX":4,"gridY":10,"gridW":8,"gridH":2,"enabled":true,"config":{}},{"id":"b_1784480049598_gc1w","type":"flow-card-2","gridX":0,"gridY":0,"gridW":4,"gridH":12,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"","fontColor":"","fontSize":"","metrics":{"solar":"PV Power","grid_import":"Grid Power","battery_charge":"Battery Charge Power","battery_soc":"Battery SOC","consumption":"Load Power","battery_discharge":"Battery Discharge Power","grid_export":"grid_export"},"inverter_image":"https://i.postimg.cc/0y66sKCR/srne.png"},"transparent":false,"bgColor":"","fontColor":"","fontSize":"","metrics":{"solar":"PV Power","grid_import":"Grid Power","battery_charge":"Battery Charge Power","battery_soc":"Battery SOC","consumption":"Load Power","battery_discharge":"Battery Discharge Power","grid_export":"grid_export"}},{"id":"b_1784480391877_32v7","type":"metric-cards","gridX":4,"gridY":6,"gridW":8,"gridH":2,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"","fontColor":"","fontSize":""},"transparent":false,"bgColor":"","fontColor":"","fontSize":"","cards":[{"title":"PV Voltage","metric":"PV Voltage","unit":"V"},{"title":"PV Current","metric":"PV Current","unit":"A"},{"title":"Peak PV","metric":"Peak PV Power","unit":"W"}]},{"id":"b_1784554263492_o1tm","type":"metric-cards","gridX":4,"gridY":8,"gridW":8,"gridH":2,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"","fontColor":"","fontSize":""},"transparent":false,"bgColor":"","fontColor":"","fontSize":"","cards":[{"title":"Batt Voltage","metric":"Battery Voltage","unit":"V"},{"title":"Batt Power","metric":"Battery Power","unit":"W"},{"title":"Batt Energy","metric":"Battery Energy (Capacity)","unit":"kWh"}]},{"id":"b_1785070489725_fqnm","type":"bar-gauge-retro","gridX":4,"gridY":0,"gridW":8,"gridH":6,"enabled":true,"config":{"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","metrics":[{"label":"Solar","metric":"PV Energy Generated","unit":"kWh","min":0,"max":12,"color":"#f59e0b","gradient":"","segments":12},{"label":"Grid","metric":"Grid Energy Import","unit":"kWh","min":0,"max":12,"color":"#b33a2e","gradient":"","segments":12},{"label":"Batt","metric":"Battery Energy (Discharge)","unit":"kWh","min":0,"max":12,"color":"#4a6a2e","gradient":"","segments":12},{"label":"Load","metric":"Load Energy Consumed","unit":"kWh","min":0,"max":12,"color":"#474eff","gradient":"","segments":12}]},"transparent":true,"bgColor":"","fontColor":"","fontSize":"","metrics":[{"label":"Solar","metric":"PV Energy Generated","unit":"kWh","min":0,"max":12,"color":"#f59e0b","gradient":"","segments":12},{"label":"Grid","metric":"Grid Energy Import","unit":"kWh","min":0,"max":12,"color":"#b33a2e","gradient":"","segments":12},{"label":"Batt","metric":"Battery Energy (Discharge)","unit":"kWh","min":0,"max":12,"color":"#4a6a2e","gradient":"","segments":12},{"label":"Load","metric":"Load Energy Consumed","unit":"kWh","min":0,"max":12,"color":"#474eff","gradient":"","segments":12}]},{"id":"b_1785073195659_rf7m","type":"chart-power","gridX":0,"gridY":26,"gridW":12,"gridH":8,"enabled":true,"config":{"datasets":[{"label":"Load","metric":"Load Power","color":"#474eff"},{"label":"Solar","metric":"PV Power","color":"#f59e0b"},{"label":"Battery Charge","metric":"Battery Charge Power","color":"#4a6a2e"},{"label":"Grid Import","metric":"Grid Power","color":"#b33a2e"}],"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","title":"","hideGrid":true,"fill":true},"transparent":true,"bgColor":"","fontColor":"","fontSize":""},{"id":"b_1785073219406_yp2j","type":"chart-energy","gridX":0,"gridY":34,"gridW":12,"gridH":8,"enabled":true,"config":{"datasets":[{"label":"Solar Generated","metric":"PV Energy Generated","color":"#f59e0b"},{"label":"Grid Imported","metric":"Grid Energy Import","color":"#b33a2e"},{"label":"Energy Consumed","metric":"Load Energy Consumed","color":"#474eff"}],"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","title":"","hideGrid":true,"fill":true},"transparent":true,"bgColor":"","fontColor":"","fontSize":""}]}]`);
    setConfig('dashboard_layouts', JSON.stringify(defaultLayouts));
    setConfig('dashboard_active', 'main');
    logger.info('Initialised default dashboard layouts');
  }

  // Ensure dashboard_active exists
  const activeDash = getConfig('dashboard_active');
  if (!activeDash || activeDash === '') {
    setConfig('dashboard_active', 'main');
  }

  // Also keep dashboard_config for backward compatibility with old code
  // (seeded after migration so existing installs keep their old blob)
  const dashConfig = getConfig('dashboard_config');
  if (!dashConfig || dashConfig === '' || dashConfig === 'null') {
    const defaultConfig = JSON.parse(`{"dashboards":[{"id":"main","name":"Main","layout":[{"id":"b_1784465890590_20sz","type":"forecast-pvtoday","gridX":0,"gridY":12,"gridW":12,"gridH":8,"enabled":true,"config":{"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","location_name":"Solar Forecast - Lagos","metrics":{"generated":"PV Power"}},"transparent":true,"bgColor":"","fontColor":"","fontSize":""},{"id":"b_1784465948035_e0n4","type":"grid-card","gridX":0,"gridY":20,"gridW":12,"gridH":6,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"#000000","fontColor":"#000000","fontSize":"","metrics":{"grid_status":"Grid Status"},"showTimeline":true}},{"id":"b_1784466238742_nhu9","type":"savings-summary","gridX":4,"gridY":10,"gridW":8,"gridH":2,"enabled":true,"config":{}},{"id":"b_1784480049598_gc1w","type":"flow-card-2","gridX":0,"gridY":0,"gridW":4,"gridH":12,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"","fontColor":"","fontSize":"","metrics":{"solar":"PV Power","grid_import":"Grid Power","battery_charge":"Battery Charge Power","battery_soc":"Battery SOC","consumption":"Load Power","battery_discharge":"Battery Discharge Power","grid_export":"grid_export"},"inverter_image":"https://i.postimg.cc/0y66sKCR/srne.png"},"transparent":false,"bgColor":"","fontColor":"","fontSize":"","metrics":{"solar":"PV Power","grid_import":"Grid Power","battery_charge":"Battery Charge Power","battery_soc":"Battery SOC","consumption":"Load Power","battery_discharge":"Battery Discharge Power","grid_export":"grid_export"}},{"id":"b_1784480391877_32v7","type":"metric-cards","gridX":4,"gridY":6,"gridW":8,"gridH":2,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"","fontColor":"","fontSize":""},"transparent":false,"bgColor":"","fontColor":"","fontSize":"","cards":[{"title":"PV Voltage","metric":"PV Voltage","unit":"V"},{"title":"PV Current","metric":"PV Current","unit":"A"},{"title":"Peak PV","metric":"Peak PV Power","unit":"W"}]},{"id":"b_1784554263492_o1tm","type":"metric-cards","gridX":4,"gridY":8,"gridW":8,"gridH":2,"enabled":true,"config":{"enabled":true,"transparent":false,"bgColor":"","fontColor":"","fontSize":""},"transparent":false,"bgColor":"","fontColor":"","fontSize":"","cards":[{"title":"Batt Voltage","metric":"Battery Voltage","unit":"V"},{"title":"Batt Power","metric":"Battery Power","unit":"W"},{"title":"Batt Energy","metric":"Battery Energy (Capacity)","unit":"kWh"}]},{"id":"b_1785070489725_fqnm","type":"bar-gauge-retro","gridX":4,"gridY":0,"gridW":8,"gridH":6,"enabled":true,"config":{"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","metrics":[{"label":"Solar","metric":"PV Energy Generated","unit":"kWh","min":0,"max":12,"color":"#f59e0b","gradient":"","segments":12},{"label":"Grid","metric":"Grid Energy Import","unit":"kWh","min":0,"max":12,"color":"#b33a2e","gradient":"","segments":12},{"label":"Batt","metric":"Battery Energy (Discharge)","unit":"kWh","min":0,"max":12,"color":"#4a6a2e","gradient":"","segments":12},{"label":"Load","metric":"Load Energy Consumed","unit":"kWh","min":0,"max":12,"color":"#474eff","gradient":"","segments":12}]},"transparent":true,"bgColor":"","fontColor":"","fontSize":"","metrics":[{"label":"Solar","metric":"PV Energy Generated","unit":"kWh","min":0,"max":12,"color":"#f59e0b","gradient":"","segments":12},{"label":"Grid","metric":"Grid Energy Import","unit":"kWh","min":0,"max":12,"color":"#b33a2e","gradient":"","segments":12},{"label":"Batt","metric":"Battery Energy (Discharge)","unit":"kWh","min":0,"max":12,"color":"#4a6a2e","gradient":"","segments":12},{"label":"Load","metric":"Load Energy Consumed","unit":"kWh","min":0,"max":12,"color":"#474eff","gradient":"","segments":12}]},{"id":"b_1785073195659_rf7m","type":"chart-power","gridX":0,"gridY":26,"gridW":12,"gridH":8,"enabled":true,"config":{"datasets":[{"label":"Load","metric":"Load Power","color":"#474eff"},{"label":"Solar","metric":"PV Power","color":"#f59e0b"},{"label":"Battery Charge","metric":"Battery Charge Power","color":"#4a6a2e"},{"label":"Grid Import","metric":"Grid Power","color":"#b33a2e"}],"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","title":"","hideGrid":true,"fill":true},"transparent":true,"bgColor":"","fontColor":"","fontSize":""},{"id":"b_1785073219406_yp2j","type":"chart-energy","gridX":0,"gridY":34,"gridW":12,"gridH":8,"enabled":true,"config":{"datasets":[{"label":"Solar Generated","metric":"PV Energy Generated","color":"#f59e0b"},{"label":"Grid Imported","metric":"Grid Energy Import","color":"#b33a2e"},{"label":"Energy Consumed","metric":"Load Energy Consumed","color":"#474eff"}],"enabled":true,"transparent":true,"bgColor":"","fontColor":"","fontSize":"","title":"","hideGrid":true,"fill":true},"transparent":true,"bgColor":"","fontColor":"","fontSize":""}]}],"activeDashboard":"main"}`);
    setConfig('dashboard_config', JSON.stringify(defaultConfig));
    logger.info('Initialised default dashboard configuration (legacy blob)');
  }

  // Seed default metrics if none exist (user can delete/add freely)
  if (!getConfig('user_metrics') || getConfig('user_metrics') === '[]') {
    const defaultMetrics = [
      { name: 'Battery Power', unit: 'W' },
      { name: 'Battery Voltage', unit: 'V' },
      { name: 'Battery Current', unit: 'A' },
      { name: 'Battery Runtime', unit: 'h' },
      { name: 'Battery Charge Power', unit: 'W' },
      { name: 'Battery Discharge Power', unit: 'W' },
      { name: 'Battery Energy (Capacity)', unit: 'kWh' },
      { name: 'Battery Energy (Charge)', unit: 'kWh' },
      { name: 'Battery Energy (Discharge)', unit: 'kWh' },
      { name: 'Battery SOC', unit: '%' },
      { name: 'Battery Cell Voltage (Lowest)', unit: 'V' },
      { name: 'Battery Cell Voltage (Highest)', unit: 'V' },
      { name: 'Battery Cell Voltage (Average)', unit: 'V' },
      { name: 'Battery Temperature', unit: '°C' },
      { name: 'Grid Voltage', unit: 'V' },
      { name: 'Grid Power', unit: 'W' },
      { name: 'Grid Current', unit: 'A' },
      { name: 'Grid Energy Import', unit: 'kWh' },
      { name: 'Grid Energy Export', unit: 'kWh' },
      { name: 'Grid Status', unit: 'On/Off' },
      { name: 'PV Power', unit: 'W' },
      { name: 'PV Voltage', unit: 'V' },
      { name: 'PV Energy Generated', unit: 'kWh' },
      { name: 'PV Current', unit: 'A' },
      { name: 'PV Forecast Energy', unit: 'kWh' },
      { name: 'Load Power', unit: 'W' },
      { name: 'Load Current', unit: 'A' },
      { name: 'Load Energy Consumed', unit: 'kWh' },
      { name: 'Load %', unit: '%' },
      { name: 'Inverter Status', unit: '' },
      { name: 'Inverter Temperature', unit: '°C' },
      { name: 'Ambient Temperature', unit: '°C' },
      { name: 'Load Voltage', unit: 'V' },
      { name: 'Grid Frequency', unit: 'hz' },
      { name: 'Load Frequency', unit: 'hz' }
    ].map(m => ({ ...m, createdAt: Date.now() }));
    setConfig('user_metrics', JSON.stringify(defaultMetrics));
    logger.info(`Seeded ${defaultMetrics.length} default metrics`);
  }

  logger.info('Database initialized');
}

function migrateLegacyConfig() {
  const haDevicesStr = getConfig('ha_devices');
  const mqttDevicesStr = getConfig('mqtt_devices');

  if (!haDevicesStr || JSON.parse(haDevicesStr || '[]').length === 0) {
    const haUrl = getConfig('ha_url');
    const haToken = getConfig('ha_token');
    const haEnabled = getConfig('ha_enabled') === 'true';
    if (haUrl || haToken) {
      const entities = {};
      const entityMap = [
        'consumption', 'solar', 'battery_charge', 'battery_discharge',
        'grid_import', 'grid_export', 'battery_soc',
        'daily_consumption', 'daily_solar', 'daily_battery_charge',
        'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export',
        'battery_voltage', 'inverter_temp', 'solar_voltage', 'load_power'
      ];
      entityMap.forEach(metric => {
        const entity = getConfig(`ha_entity_${metric}`);
        if (entity) entities[metric] = entity;
      });
      const device = {
        name: 'Home Assistant',
        url: haUrl,
        token: haToken,
        enabled: haEnabled,
        poll_interval: 30,
        entities
      };
      setConfig('ha_devices', JSON.stringify([device]));
      db.prepare("DELETE FROM config WHERE key LIKE 'ha_entity_%' OR key IN ('ha_url','ha_token','ha_enabled')").run();
      logger.info('Migrated legacy Home Assistant config to ha_devices array.');
    }
  }

  if (!mqttDevicesStr || JSON.parse(mqttDevicesStr || '[]').length === 0) {
    const brokerUrl = getConfig('mqtt_broker_url');
    const username = getConfig('mqtt_username');
    const password = getConfig('mqtt_password');
    const mqttEnabled = getConfig('mqtt_enabled') === 'true';
    if (brokerUrl) {
      const topics = {};
      const topicMap = [
        'consumption', 'solar', 'battery_charge', 'battery_discharge',
        'grid_import', 'grid_export', 'battery_soc',
        'daily_consumption', 'daily_solar', 'daily_battery_charge',
        'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export',
        'battery_voltage', 'inverter_temp', 'solar_voltage', 'load_power'
      ];
      topicMap.forEach(metric => {
        const topic = getConfig(`mqtt_topic_${metric}`);
        if (topic) topics[metric] = topic;
      });
      const device = {
        name: 'MQTT Broker',
        broker: brokerUrl,
        username,
        password,
        enabled: mqttEnabled,
        topics
      };
      setConfig('mqtt_devices', JSON.stringify([device]));
      db.prepare("DELETE FROM config WHERE key LIKE 'mqtt_topic_%' OR key IN ('mqtt_broker_url','mqtt_username','mqtt_password','mqtt_enabled'").run();
      logger.info('Migrated legacy MQTT config to mqtt_devices array.');
    }
  }
}

/**
 * Migrate dashboard_config blob to granular keys.
 * Extracts: dashboards→dashboard_layouts, activeDashboard→dashboard_active,
 * and individual flat keys: desktop_dashboard, mobile_dashboard,
 * transparent_blocks, dashboard_bg_color_light, dashboard_bg_color_dark,
 * dashboard_bg_image, grid_status_entity.
 * Old dashboard_config is kept as fallback (dual-read).
 */
function migrateDashboardConfigBlob() {
  const oldBlob = getConfig('dashboard_config');
  if (!oldBlob || oldBlob === '' || oldBlob === 'null') return;

  try {
    const parsed = JSON.parse(oldBlob);
    if (!parsed || typeof parsed !== 'object') return;

    // Only migrate if the new keys are empty (first-run migration)
    const existingLayouts = getConfig('dashboard_layouts');
    if (existingLayouts && existingLayouts !== '' && existingLayouts !== 'null') {
      // Already migrated — skip
      return;
    }

    // Extract dashboards array
    if (parsed.dashboards && Array.isArray(parsed.dashboards)) {
      setConfig('dashboard_layouts', JSON.stringify(parsed.dashboards));
    }

    // Extract activeDashboard
    if (parsed.activeDashboard) {
      setConfig('dashboard_active', parsed.activeDashboard);
    }

    // Extract flat keys from the blob (only if not already set)
    const flatKeys = [
      'desktop_dashboard', 'mobile_dashboard', 'transparent_blocks',
      'dashboard_bg_color_light', 'dashboard_bg_color_dark',
      'dashboard_bg_image', 'grid_status_entity'
    ];
    for (const key of flatKeys) {
      if (parsed[key] !== undefined && parsed[key] !== null) {
        const existing = getConfig(key);
        if (!existing || existing === '') {
          setConfig(key, String(parsed[key]));
        }
      }
    }

    logger.info('Migrated dashboard_config blob to granular keys (old blob preserved for fallback)');
  } catch (err) {
    logger.warn('Failed to migrate dashboard_config blob:', err.message);
  }
}

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = {
  initializeDatabase,
  getConfig,
  setConfig,
  getDb,
  DB_PATH
};
