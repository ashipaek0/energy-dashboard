const { getConfig, setConfig, getDb } = require('./database');
const { logger } = require('./logger');

// Get all metrics (from latest_metrics + user_metrics)
function getAllMetrics() {
  const db = getDb();
  const latest = db.prepare('SELECT metric, value, timestamp FROM latest_metrics').all();
  const userMetrics = JSON.parse(getConfig('user_metrics') || '[]');
  const metricMap = new Map();

  // Add metrics with values
  latest.forEach(m => {
    metricMap.set(m.metric, {
      name: m.metric,
      value: m.value,
      timestamp: m.timestamp,
      unit: null
    });
  });

  // Add user-created metrics (may not have values yet)
  userMetrics.forEach(m => {
    if (!metricMap.has(m.name)) {
      metricMap.set(m.name, {
        name: m.name,
        value: null,
        timestamp: null,
        unit: m.unit || ''
      });
    } else {
      // Update unit for existing metric if user-defined
      const existing = metricMap.get(m.name);
      existing.unit = m.unit || existing.unit;
    }
  });

  return Array.from(metricMap.values());
}

function createMetric(name, unit) {
  if (!name || name.trim() === '') throw new Error('Metric name is required');
  const userMetrics = JSON.parse(getConfig('user_metrics') || '[]');
  if (userMetrics.some(m => m.name === name)) throw new Error(`Metric "${name}" already exists`);
  userMetrics.push({ name, unit: unit || '', createdAt: Date.now() });
  setConfig('user_metrics', JSON.stringify(userMetrics));
  logger.info(`Created new metric: ${name}`);
}

function deleteMetric(name) {
  // 1. Remove from user_metrics config
  let userMetrics = JSON.parse(getConfig('user_metrics') || '[]');
  const originalLength = userMetrics.length;
  userMetrics = userMetrics.filter(m => m.name !== name);
  if (userMetrics.length === originalLength) {
    logger.debug(`Metric "${name}" not found in user_metrics, attempting cleanup anyway`);
  }
  setConfig('user_metrics', JSON.stringify(userMetrics));

  // 2. Remove from latest_metrics and metrics tables
  const db = getDb();
  db.prepare('DELETE FROM latest_metrics WHERE metric = ?').run(name);
  db.prepare('DELETE FROM metrics WHERE metric = ?').run(name);

  // 3. Remove from HA device mappings
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  let haChanged = false;
  haDevices.forEach(device => {
    if (device.entities && device.entities[name]) {
      delete device.entities[name];
      haChanged = true;
    }
  });
  if (haChanged) setConfig('ha_devices', JSON.stringify(haDevices));

  // 4. Remove from MQTT device topic mappings
  const mqttDevices = JSON.parse(getConfig('mqtt_devices') || '[]');
  let mqttChanged = false;
  mqttDevices.forEach(device => {
    if (device.topics && device.topics[name]) {
      delete device.topics[name];
      mqttChanged = true;
    }
  });
  if (mqttChanged) setConfig('mqtt_devices', JSON.stringify(mqttDevices));

  // 5. Remove from external sources mappings (mappings: { metricName → jsonPath })
  const externalSources = JSON.parse(getConfig('external_sources') || '[]');
  let extChanged = false;
  externalSources.forEach(src => {
    if (src.mappings) {
      // Iterate metric-first: the key IS the metric name in this store
      for (const metricName of Object.keys(src.mappings)) {
        if (metricName === name) {
          delete src.mappings[metricName];
          extChanged = true;
        }
      }
    }
  });
  if (extChanged) setConfig('external_sources', JSON.stringify(externalSources));

  // 6. Remove from dongle_config device mappings (mappings: { metricName → register })
  const dongleDevices = JSON.parse(getConfig('dongle_config') || '[]');
  let dongleChanged = false;
  dongleDevices.forEach(device => {
    if (device.mappings && Object.prototype.hasOwnProperty.call(device.mappings, name)) {
      delete device.mappings[name];
      dongleChanged = true;
    }
  });
  if (dongleChanged) setConfig('dongle_config', JSON.stringify(dongleDevices));

  // 7. Remove from Modbus device mappings (mappings: { metricName → address })
  const modbusDevices = JSON.parse(getConfig('modbus_devices') || '[]');
  let modbusChanged = false;
  modbusDevices.forEach(device => {
    if (device.mappings && Object.prototype.hasOwnProperty.call(device.mappings, name)) {
      delete device.mappings[name];
      modbusChanged = true;
    }
  });
  if (modbusChanged) setConfig('modbus_devices', JSON.stringify(modbusDevices));

  // 8. Remove from RS232 device mappings (mappings: { metricName → handle })
  const rs232Devices = JSON.parse(getConfig('rs232_devices') || '[]');
  let rs232Changed = false;
  rs232Devices.forEach(device => {
    if (device.mappings && Object.prototype.hasOwnProperty.call(device.mappings, name)) {
      delete device.mappings[name];
      rs232Changed = true;
    }
  });
  if (rs232Changed) setConfig('rs232_devices', JSON.stringify(rs232Devices));

  logger.info(`Deleted metric: ${name}`);
}

module.exports = { getAllMetrics, createMetric, deleteMetric };
