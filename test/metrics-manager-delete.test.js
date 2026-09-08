#!/usr/bin/env node
/**
 * test/metrics-manager-delete.test.js
 * Delete-metric cascade regression (issue #108, AC-32..35).
 *
 * AC-34: deleting a metric strips its mapping rows from EVERY store
 * (HA / MQTT / external / modbus / rs232 / dongle), leaves other metrics'
 * mappings intact, external deletion actually fires (regression for the
 * inverted external loop), tuya + BMS stores are NOT touched, and an
 * unknown-name delete is a no-op returning success.
 *
 * Isolation: modules/database.js DB_PATH is CWD-relative ('./data/energy.db'),
 * so this fixture chdirs into a fresh mkdtemp scratch cwd with an empty data/
 * before requiring modules — it never touches the repo's real DB.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-metrics-delete-'));
process.chdir(tmp);

const { initializeDatabase, getConfig, setConfig, getDb } = require('../modules/database');
const { deleteMetric } = require('../modules/metricsManager');

initializeDatabase();

const TARGET = 'solar_power'; // the metric being deleted
const KEEP = 'keep_metric';   // must survive every scrub
const now = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Seed config: every scrub target store + tuya/BMS (must stay untouched)
// ---------------------------------------------------------------------------

setConfig('user_metrics', JSON.stringify([
  { name: TARGET, unit: 'W', createdAt: now },
  { name: KEEP, unit: 'W', createdAt: now }
]));

const haDevices = [
  { name: 'HA main', url: 'http://ha.local', token: 'tok', enabled: true, poll_interval: 30, entities: { [TARGET]: 'sensor.solar_power', [KEEP]: 'sensor.keep' } },
  { name: 'HA keep-only', url: 'http://ha2.local', token: 'tok2', enabled: true, poll_interval: 30, entities: { [KEEP]: 'sensor.keep2' } }
];
setConfig('ha_devices', JSON.stringify(haDevices));

const mqttDevices = [
  { name: 'MQTT main', broker_url: 'mqtt://b1', enabled: true, topics: { [TARGET]: 'inv/1/power', [KEEP]: 'inv/1/keep' } },
  { name: 'MQTT keep-only', broker_url: 'mqtt://b2', enabled: true, topics: { [KEEP]: 'inv/2/keep' } }
];
setConfig('mqtt_devices', JSON.stringify(mqttDevices));

const externalSources = [
  { name: 'REST main', url: 'http://rest.local/api', enabled: true, mappings: { [TARGET]: '$.data.power', [KEEP]: '$.data.keep' } },
  { name: 'REST keep-only', url: 'http://rest2.local/api', enabled: true, mappings: { [KEEP]: '$.data.keep2' } },
  { name: 'REST unmapped', url: 'http://rest3.local/api', enabled: true } // no mappings key at all
];
setConfig('external_sources', JSON.stringify(externalSources));

const modbusDevices = [
  { name: 'Modbus main', transport: 'tcp', host: '1.2.3.4', port: 502, unit_id: 1, mappings: { [TARGET]: '128', [KEEP]: '129' } },
  { name: 'Modbus keep-only', transport: 'rtu', serial_path: '/dev/ttyX', unit_id: 2, mappings: { [KEEP]: '130' } },
  { name: 'Modbus legacy', transport: 'tcp', host: '1.2.3.5', port: 502, unit_id: 3 } // no mappings key
];
setConfig('modbus_devices', JSON.stringify(modbusDevices));

const rs232Devices = [
  { name: 'RS232 main', profile: 'voltronic-qpigs', serial_path: '/dev/ttyUSB0', enabled: true, mappings: { [TARGET]: 'QPIGS:3', [KEEP]: 'QPIGS:0' } },
  { name: 'RS232 keep-only', profile: 'anern-evo4200l', serial_path: '/dev/ttyUSB1', enabled: true, mappings: { [KEEP]: '0x0065' } }
];
setConfig('rs232_devices', JSON.stringify(rs232Devices));

const dongleDevices = [
  { name: 'Dongle main', transport: 'luxpower-tcp', host: '10.0.0.5', profile: 'luxpower-geta', mappings: { [TARGET]: '0x0065', [KEEP]: '0x0066' } },
  { name: 'Dongle keep-only', transport: 'growatt', profile: 'growatt-spf', mappings: { [KEEP]: 'pv1_power' } }
];
setConfig('dongle_config', JSON.stringify(dongleDevices));

// Out-of-scope stores — must survive byte-for-byte.
const tuyaDevices = [
  { name: 'Tuya plug', dev_id: 'd1', address: '1.2.3.4', local_key: 'k', enabled: true, dps: { [TARGET]: '1', [KEEP]: '2' } }
];
setConfig('tuya_devices', JSON.stringify(tuyaDevices));

const bmsDevices = [
  { name: 'BMS wired', transport: 'wired', serial_path: '/dev/ttyBMS', enabled: true, mappings: { '0x0001': TARGET, '0x0002': KEEP } }
];
setConfig('bms_devices', JSON.stringify(bmsDevices));

// latest_metrics / metrics table rows for TARGET + KEEP
const db = getDb();
db.prepare('INSERT INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run(TARGET, 123, now, 'W');
db.prepare('INSERT INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run(KEEP, 456, now, 'W');
db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)').run(now - 60, TARGET, 122);
db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)').run(now - 60, KEEP, 455);

// ---------------------------------------------------------------------------
// Act
// ---------------------------------------------------------------------------

deleteMetric(TARGET);

// ---------------------------------------------------------------------------
// Assert
// ---------------------------------------------------------------------------

function readStore(key) {
  return JSON.parse(getConfig(key) || '[]');
}

function everyMappingLacks(store, metricName) {
  for (const dev of store) {
    const maps = dev.entities || dev.topics || dev.mappings;
    if (maps) assert.ok(!Object.prototype.hasOwnProperty.call(maps, metricName),
      `store still maps deleted metric "${metricName}": ${JSON.stringify(maps)}`);
  }
}

function everyMappingKeeps(store, metricName) {
  let found = false;
  for (const dev of store) {
    const maps = dev.entities || dev.topics || dev.mappings;
    if (maps && Object.prototype.hasOwnProperty.call(maps, metricName)) found = true;
  }
  assert.ok(found, `store lost surviving metric "${metricName}" everywhere`);
}

// 1. user_metrics: TARGET removed, KEEP present
{
  const um = JSON.parse(getConfig('user_metrics'));
  assert.ok(!um.some(m => m.name === TARGET), 'user_metrics still contains deleted metric');
  assert.ok(um.some(m => m.name === KEEP), 'user_metrics lost surviving metric');
  console.log('PASS AC-34: user_metrics stripped of', TARGET, 'and kept', KEEP);
}

// 2. DB tables
{
  const latest = db.prepare('SELECT metric FROM latest_metrics').all().map(r => r.metric);
  const hist = db.prepare('SELECT metric FROM metrics').all().map(r => r.metric);
  assert.ok(!latest.includes(TARGET), 'latest_metrics still contains deleted metric');
  assert.ok(latest.includes(KEEP), 'latest_metrics lost surviving metric');
  assert.ok(!hist.includes(TARGET), 'metrics table still contains deleted metric');
  assert.ok(hist.includes(KEEP), 'metrics table lost surviving metric');
  console.log('PASS AC-34: latest_metrics + metrics table rows stripped');
}

// 3. Every scrub-target store: TARGET gone, KEEP intact
{
  const ha = readStore('ha_devices');
  everyMappingLacks(ha, TARGET);
  everyMappingKeeps(ha, KEEP);

  const mqtt = readStore('mqtt_devices');
  everyMappingLacks(mqtt, TARGET);
  everyMappingKeeps(mqtt, KEEP);

  const ext = readStore('external_sources');
  everyMappingLacks(ext, TARGET);
  everyMappingKeeps(ext, KEEP);
  // external deletion must actually have fired (regression: inverted loop
  // compared jsonPath values against the metric name and never deleted)
  assert.ok(ext[0].mappings && !Object.prototype.hasOwnProperty.call(ext[0].mappings, TARGET),
    'external block did not fire — orientation bug regression');
  assert.ok(ext[0].mappings && Object.prototype.hasOwnProperty.call(ext[0].mappings, KEEP),
    'external block removed surviving metric');

  const modbus = readStore('modbus_devices');
  everyMappingLacks(modbus, TARGET);
  everyMappingKeeps(modbus, KEEP);

  const rs232 = readStore('rs232_devices');
  everyMappingLacks(rs232, TARGET);
  everyMappingKeeps(rs232, KEEP);

  const dongle = readStore('dongle_config');
  everyMappingLacks(dongle, TARGET);
  everyMappingKeeps(dongle, KEEP);

  // Devices that had no mappings key are untouched and still present
  assert.strictEqual(modbus.length, 3, 'modbus device count changed');
  assert.strictEqual(ext.length, 3, 'external source count changed');
  assert.ok(!modbus[2].mappings, 'no-mappings modbus device gained a mappings key');
  console.log('PASS AC-34: HA/MQTT/external/modbus/rs232/dongle scrubbed, other metrics intact');
}

// 4. Tuya + BMS untouched (byte-for-byte)
{
  assert.deepStrictEqual(readStore('tuya_devices'), tuyaDevices, 'tuya_devices was modified');
  assert.deepStrictEqual(readStore('bms_devices'), bmsDevices, 'bms_devices was modified');
  console.log('PASS AC-34: tuya + bms stores untouched');
}

// 5. Unknown-name delete is a no-op returning success
{
  const before = {
    user_metrics: getConfig('user_metrics'),
    ha_devices: getConfig('ha_devices'),
    mqtt_devices: getConfig('mqtt_devices'),
    external_sources: getConfig('external_sources'),
    modbus_devices: getConfig('modbus_devices'),
    rs232_devices: getConfig('rs232_devices'),
    dongle_config: getConfig('dongle_config'),
    tuya_devices: getConfig('tuya_devices'),
    bms_devices: getConfig('bms_devices')
  };
  assert.doesNotThrow(() => deleteMetric('no_such_metric_xyz'), 'unknown-name delete threw');
  for (const [key, val] of Object.entries(before)) {
    assert.strictEqual(getConfig(key), val, `unknown-name delete changed config ${key}`);
  }
  console.log('PASS AC-34: unknown-name delete is a no-op success');
}

console.log('ALL PASS: metrics-manager-delete');
process.exit(0);
