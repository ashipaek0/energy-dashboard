#!/usr/bin/env node
/**
 * test/migration-backcompat.test.js — issue #108 AC-36..40 (wave 6).
 *
 * Plain-node fixture in repo style (no framework, exit codes — `npm test`
 * runs it via test/run-all.js). Asserts, against the SHIPPED byte snapshots
 * under test/fixtures/configs/ (captured through the REAL settings UI by the
 * wave-6 jsdom capture harness /tmp/qa-wave6/capture.js: boot → save → reload
 * from the saved payload → save again; save1 === save2 byte-identically for
 * every family):
 *
 *   AC-36  every per-family snapshot is canonical JSON (file bytes ==
 *          JSON.stringify of the parsed value) and carries the enumerated
 *          legacy shapes verbatim (HA {entityId, actions} value, MQTT topics,
 *          external jsonPaths, modbus decimal addresses, rs232 QPIGS:3/label/
 *          hex handles, dongle bare-hex + namespaced luxpower, and an rs232
 *          device with NO mappings key); every resolvable mapping handle is a
 *          1:1 member of its profile's poll-decode domain (resolveHandle
 *          exact-match domain); unresolvable sentinels round-trip RAW.
 *          DOM-level reload-render + byte round-trip is exercised by the
 *          capture harness (59 checks green) and by the wave-4 register gate
 *          + wave-5 HA/MQTT/external gate harnesses.
 *   AC-38  marker semantics on the snapshots: dongle keeps _luxpowerPhase2;
 *          catalog-era saves of dongle-nonLux/modbus/rs232 stamp
 *          _catalogV2:true; luxpower saves NEVER gain _catalogV2 (byte-compat);
 *          manual/legacy HA + MQTT + external saves carry no marker. Plus
 *          source guards that the marker machinery exists and stays inert.
 *   AC-39  legacy Load Profile Registers/Fields loaders still exist verbatim
 *          (source guard) and the default sets they import fully resolve
 *          against the projection domains (their saved output remains valid
 *          under the catalog restore paths).
 *   AC-40  MQTT additive-only invariant, module side: subscriptions derive
 *          ONLY from stored device.topics and message routing is mapping-first
 *          (a mapped topic that disappears from the broker still polls); the
 *          discovery window/cache persists only the separate
 *          mqtt_discovery_cache config key — never mqtt_devices. The DOM
 *          additive merge (re-discovery + cache-load never remove/duplicate
 *          rows) is enforced by the wave-5 gate harness (AC-26, green).
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'configs');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const profile = (p) => JSON.parse(read(p));
const entityCatalog = require(path.join(ROOT, 'modules', 'entityCatalog.js'));

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err && err.message ? err.message.split('\n')[0] : err}`);
  }
}

// ---------------------------------------------------------------- fixture io
const FILES = [
  'ha.json', 'mqtt.json', 'external.json', 'modbus.json', 'rs232.json',
  'rs232-implicit.json', 'dongle-barehex.json', 'dongle-luxpower.json'
];
const fixtures = {};
for (const f of FILES) fixtures[f] = JSON.parse(read(path.join('test', 'fixtures', 'configs', f)));

// ------------------------------------------------- decode-domain construction
// Mirror of the poll-side reverse-lookup key sets each module consumes
// (modules/modbus.js String(address); modules/rs232.js `${cmd.name}:${idx}` /
// label / bare-hex register; modules/dongle.js bare-hex register; LuxPower
// decode key `register_type:register`). entityCatalog's dongle projection ids
// are the exact LuxPower/register handles, so it is reused directly.
function modbusRegisterSet(profileId) {
  const p = profile(`profiles/${profileId}.json`);
  const s = new Set();
  for (const r of (p.registers || [])) {
    if (r.address === undefined || r.address === null || String(r.address).trim() === '') continue;
    if (r.metric === undefined) continue;
    s.add(String(r.address));
  }
  return s;
}
function rs232Domains(profileId) {
  const p = profile(`profiles/rs232/${profileId}.json`);
  const prot = String(p.protocol || '').toLowerCase();
  const s = new Set();
  if (prot === 'modbus-rtu') {
    for (const m of (p.metrics || [])) if (m.register !== undefined && m.register !== null && String(m.register).trim() !== '') s.add(String(m.register));
  } else if (prot === 'vedirect-streaming') {
    for (const f of (p.fields || [])) if (f.label !== undefined && f.label !== null) s.add(String(f.label));
  } else {
    for (const cmd of (p.commands || [])) {
      if (!cmd || cmd.name === undefined) continue;
      for (const f of (cmd.fields || [])) if (f.index !== undefined && f.index !== null) s.add(`${cmd.name}:${f.index}`);
    }
  }
  return s;
}
function dongleDomain(profileId) {
  const p = profile(`profiles/dongles/${profileId}.json`);
  const ids = entityCatalog.dongleProfileEntities(p).map(e => e.id);
  return new Set(ids);
}

// ================================================================ AC-36
check('AC-36.1|every fixture file is canonical JSON (file bytes == JSON.stringify(parsed) + newline)', () => {
  for (const f of FILES) {
    const raw = read(path.join('test', 'fixtures', 'configs', f));
    const parsed = JSON.parse(raw);
    assert.strictEqual(raw, JSON.stringify(parsed) + '\n', `${f} not in canonical byte form`);
  }
});

check('AC-36.2|HA snapshot: entities include an {entityId, actions} value AND plain entity_id strings', () => {
  const dev = fixtures['ha.json'][0];
  const v = dev.entities.house_load;
  assert.strictEqual(typeof v, 'object');
  assert.strictEqual(v.entityId, 'sensor.house_power');
  assert.deepStrictEqual(v.actions, ['toggle']);
  assert.strictEqual(dev.entities.solar_export, 'sensor.solar_production');
  assert.strictEqual(dev.entities.battery_soc, 'sensor.battery_level');
});

check('AC-36.3|MQTT snapshot: metric→topic string map, no discovery/cache metadata leaked into the device', () => {
  const dev = fixtures['mqtt.json'][0];
  assert.strictEqual(dev.topics.battery_soc, 'solar/battery/soc');
  assert.strictEqual(dev.topics.pv1_power, 'solar/inverter/pv1');
  for (const [k, val] of Object.entries(dev.topics)) {
    assert.strictEqual(typeof k, 'string');
    assert.strictEqual(typeof val, 'string', `topic for ${k} is not a plain string`);
  }
});

check('AC-36.4|External snapshot: metric→jsonPath string map', () => {
  const src = fixtures['external.json'][0];
  assert.strictEqual(src.mappings.battery_soc, 'current.temp_c');
  assert.strictEqual(src.mappings.wind_speed, 'current.condition');
  assert.strictEqual(src.mappings.house_load, 'current.humidity');
});

check('AC-36.5|Modbus snapshot: decimal String(address) handles, all resolvable in the profile register domain; unresolvable sentinel raw', () => {
  const dev = fixtures['modbus.json'][0];
  const dom = modbusRegisterSet(dev.profile);
  assert.ok(dom.has('1') && dom.has('2'), 'expected register addresses 1..2 in Growatt-SPF-5000');
  assert.ok(dom.has(dev.mappings.battery_soc), `battery_soc handle ${dev.mappings.battery_soc} not in register domain`);
  assert.ok(dom.has(dev.mappings.pv1_power), `pv1_power handle ${dev.mappings.pv1_power} not in register domain`);
  assert.ok(/^[0-9]+$/.test(dev.mappings.battery_soc), 'address must be decimal');
  assert.strictEqual(dev.mappings.stranded, '9999'); // unresolvable → raw round-trip
  assert.ok(!dom.has('9999'));
});

check('AC-36.6|RS232 snapshot: voltronic QPIGS:3 + canonical QPIGS:0 in ascii domain, raw QMOD:7 sentinel', () => {
  const dev = fixtures['rs232.json'].find(d => d.profile === 'voltronic-qpigs');
  const dom = rs232Domains('voltronic-qpigs');
  assert.ok(dom.has('QPIGS:3'), 'QPIGS:3 missing from voltronic ascii domain');
  assert.ok(dom.has(dev.mappings.output_frequency), 'QPIGS:3 handle not resolvable');
  assert.ok(dom.has(dev.mappings.LegacyPower), 'canonicalized QPIGS:0 handle not resolvable');
  assert.strictEqual(dev.mappings.stranded, 'QMOD:7'); // unresolvable → raw
  assert.ok(!dom.has('QMOD:7'));
});

check('AC-36.7|RS232 snapshot: anern bare-hex register handle resolvable, raw 0xFFFF sentinel', () => {
  const dev = fixtures['rs232.json'].find(d => d.profile === 'anern-evo4200l');
  const dom = rs232Domains('anern-evo4200l');
  assert.ok(/^0x/i.test(dev.mappings.house_load), 'anern handle must stay bare hex');
  assert.ok(dom.has(dev.mappings.house_load), 'anern register handle not in domain');
  assert.strictEqual(dev.mappings.ghost, '0xFFFF'); // unresolvable → raw
  assert.ok(!dom.has('0xFFFF'));
});

check('AC-36.8|RS232 snapshot: vedirect label-keyed handles verbatim in label domain', () => {
  const dev = fixtures['rs232.json'].find(d => d.profile === 'vedirect');
  const dom = rs232Domains('vedirect');
  assert.deepStrictEqual([dev.mappings.battery_voltage, dev.mappings.solar_power, dev.mappings.daily_yield], ['V', 'PPV', 'H19']);
  for (const h of Object.values(dev.mappings)) assert.ok(dom.has(h), `vedirect label handle ${h} not in domain`);
});

check('AC-36.9|rs232-implicit snapshot: a device with NO mappings key (implicit profile-default polling) survives as raw disk bytes', () => {
  const devs = fixtures['rs232-implicit.json'];
  const anern = devs.find(d => d.profile === 'anern-evo4200l');
  assert.ok(anern, 'anern device missing');
  assert.ok(!Object.prototype.hasOwnProperty.call(anern, 'mappings'), 'device must keep NO mappings key');
  assert.ok(!Object.prototype.hasOwnProperty.call(anern, '_catalogV2'));
  const volt = devs.find(d => d.profile === 'voltronic-qpigs');
  assert.ok(Object.prototype.hasOwnProperty.call(volt, 'mappings'), 'companion mapped device expected');
  assert.ok(rs232Domains('voltronic-qpigs').has(volt.mappings.output_frequency));
});

check('AC-36.10|Dongle snapshot (non-lux): bare-hex register handles verbatim, resolvable 1:1 in the deye profile; raw 0xFFFF sentinel', () => {
  const dev = fixtures['dongle-barehex.json'][0];
  const dom = dongleDomain(dev.profile);
  assert.ok(/^0x/i.test(dev.mappings.battery_soc) && !/:/.test(dev.mappings.battery_soc), 'non-lux handle must be bare hex, never namespaced');
  assert.ok(dom.has(dev.mappings.battery_soc), 'bare-hex handle not in deye register domain');
  assert.ok(dom.has(dev.mappings.solar_power), 'bare-hex handle not in deye register domain');
  assert.strictEqual(dev.mappings.stranded, '0xFFFF'); // unresolvable → raw
  assert.ok(!dom.has('0xFFFF'));
});

check('AC-36.11|Dongle snapshot (luxpower): namespaced input:0x handles verbatim in the luxpower projection domain; raw sentinel round-trips', () => {
  const dev = fixtures['dongle-luxpower.json'][0];
  const dom = dongleDomain(dev.profile);
  assert.ok(/^input:0x/i.test(dev.mappings.battery_soc), 'luxpower handle must stay namespaced register_type:register');
  assert.ok(dom.has(dev.mappings.battery_soc) && dom.has(dev.mappings.solar_power), 'namespaced handle not in luxpower domain');
  assert.strictEqual(dev.mappings.stranded, 'input:0x9FFF'); // unresolvable → raw
  assert.ok(!dom.has('input:0x9FFF'));
});

// ================================================================ AC-38
check('AC-38.1|dongle keeps _luxpowerPhase2 (luxpower) and never gains _catalogV2 — byte-compat preserved', () => {
  const dev = fixtures['dongle-luxpower.json'][0];
  assert.strictEqual(dev._luxpowerPhase2, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(dev, '_catalogV2'));
});

check('AC-38.2|catalog-era register saves stamp _catalogV2:true (dongle non-lux, modbus, rs232)', () => {
  assert.strictEqual(fixtures['dongle-barehex.json'][0]._catalogV2, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(fixtures['dongle-barehex.json'][0], '_luxpowerPhase2'), 'non-lux must not carry _luxpowerPhase2');
  assert.strictEqual(fixtures['modbus.json'][0]._catalogV2, true);
  for (const d of fixtures['rs232.json']) assert.strictEqual(d._catalogV2, true);
});

check('AC-38.3|manual/legacy HA, MQTT and external saves carry NO _catalogV2 (marker fires only on catalog paths)', () => {
  for (const f of ['ha.json', 'mqtt.json', 'external.json']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(fixtures[f][0], '_catalogV2'), `${f} must stay unmarked`);
  }
});

check('AC-38.4|marker machinery exists in source and is inert: catalog rows carry data-catalog; collectors gate on it; luxpower excluded', () => {
  const js = read('public/settings.js');
  const cui = read('public/js/catalog-ui.js');
  assert.ok(js.includes('function cardHasCatalogRows'), 'cardHasCatalogRows helper missing');
  assert.ok(js.includes("_catalogV2"), '_catalogV2 marker absent from collectors');
  assert.ok(js.includes(".metric-row[data-catalog]"), 'collector data-catalog query missing');
  assert.ok(js.includes("txSel !== 'luxpower-tcp' && cardHasCatalogRows(card)"), 'luxpower must be excluded from _catalogV2 stamping');
  // HA collector must NOT stamp _catalogV2: expose provenance is in-session only,
  // restored rows render as manual-anatomy, a stamp could not round-trip
  // reload→save and would break the AC-31.14 byte-identical contract (see the
  // settings.js AC-38 comment in the ha-devices collector). Scope the search to
  // the collector region between the ha_devices collectDeviceArray open and its
  // closing of payload assignment — simplest robust proxy: the HA collector
  // returns before the modbus collector that carries the stamping gate.
  const haCollectorOpen = js.indexOf("payload.ha_devices = collectDeviceArray");
  const haCollectorEnd = js.indexOf("payload.mqtt_devices = collectDeviceArray");
  const haCollector = haCollectorOpen >= 0 && haCollectorEnd > haCollectorOpen
    ? js.slice(haCollectorOpen, haCollectorEnd) : '';
  assert.ok(haCollector && !/_catalogV2\s*=\s*true/.test(haCollector), 'HA collector must not stamp _catalogV2 (expose provenance is in-session only)');
  assert.ok(haCollector.includes('data-ha-expose'), 'HA catalog expose rows must be recognized in the collector');
  assert.ok(cui.includes("row.dataset.catalog = '1'"), 'CatalogUI.createRow must mark catalog rows');
  assert.ok(js.includes('row.dataset.catalog = \'1\''), 'MQTT discovery/cache rows must be marked as catalog rows');
});

// ================================================================ AC-39
check('AC-39.1|legacy Load Profile Registers/Fields loaders retained verbatim (source guard) and CatalogUI-free', () => {
  const js = read('public/settings.js');
  const fnOf = (name) => {
    const i = js.indexOf(`function ${name}`);
    assert.ok(i >= 0, `function ${name} missing`);
    let depth = 0, j = js.indexOf('{', i);
    for (let k = j; k < js.length; k++) {
      if (js[k] === '{') depth++;
      else if (js[k] === '}') { depth--; if (depth === 0) return js.slice(i, k + 1); }
    }
    return js.slice(i);
  };
  for (const name of ['loadModbusRegisterMappings', 'loadRs232Mappings', 'loadDongleRegisterMappings']) {
    const body = fnOf(name);
    assert.ok(!body.includes('CatalogUI.createRow'), `${name} must stay legacy (own row builder)`);
  }
  assert.ok(js.includes("'.load-modbus-registers'"), 'modbus legacy Load button listener missing');
  assert.ok(js.includes("'.load-rs232-fields'"), 'rs232 legacy Load button listener missing');
  assert.ok(js.includes("loadDongleRegisterMappings"), 'dongle legacy Load path missing');
});

check('AC-39.2|legacy Load default sets (what the loaders import/pre-bind) are fully resolvable under the catalog restore domains', () => {
  // loadModbusRegisterMappings builds { r.metric: String(r.address) } over the
  // profile's registers; renderSaved must resolve every one of those handles.
  const mb = profile('profiles/Growatt-SPF-5000.json');
  const mbDom = modbusRegisterSet('Growatt-SPF-5000');
  for (const r of (mb.registers || [])) {
    if (r.address === undefined || r.metric === undefined) continue;
    assert.ok(mbDom.has(String(r.address)), `modbus legacy default handle ${String(r.address)} unresolvable`);
  }
  // rs232 voltronic: every `${cmd}:${idx}` the legacy Fields loader pre-binds.
  const vp = profile('profiles/rs232/voltronic-qpigs.json');
  const vDom = rs232Domains('voltronic-qpigs');
  for (const cmd of (vp.commands || [])) {
    for (const f of (cmd.fields || [])) {
      assert.ok(vDom.has(`${cmd.name}:${f.index}`), `rs232 legacy default handle ${cmd.name}:${f.index} unresolvable`);
    }
  }
  // dongle legacy Load Registers default set (register transports, bare hex).
  for (const pid of ['deye-hybrid', 'srne-hybrid']) {
    const p = profile(`profiles/dongles/${pid}.json`);
    const dom = dongleDomain(pid);
    for (const m of (p.metrics || [])) {
      if (m.register === undefined || m.register === null) continue;
      assert.ok(dom.has(String(m.register)), `dongle legacy default handle ${String(m.register)} (${pid}) unresolvable`);
    }
  }
});

// ================================================================ AC-40
check('AC-40.1|MQTT module: subscriptions derive ONLY from stored device.topics; message routing is mapping-first (mapped topic wins even if it disappears from the broker)', () => {
  const src = read('modules/mqtt.js');
  assert.ok(src.includes('const topics = Object.values(device.topics || {}).filter(t => t);'), 'setupMqtt must subscribe from stored mappings only');
  assert.ok(src.includes('if (topics.length) client.subscribe(topics);'), 'subscribe call missing');
  assert.ok(src.includes('for (const [key, t] of Object.entries(topicMap))'), 'message routing must consult the stored mapping');
  assert.ok(src.includes('if (t === topic) { metric = key; break; }'), 'message route keyed by exact stored topic');
  assert.ok(src.includes("if (!metric) return;"), 'unmapped broker messages must be ignored');
});

check('AC-40.2|discovery window/cache writes ONLY the separate mqtt_discovery_cache config key — never mqtt_devices (additive invariant, config-store level)', () => {
  const src = read('server.js');
  const start = src.indexOf("'/api/mqtt-discover-topics'");
  const end = src.indexOf("'/api/modbus/profiles'", start);
  assert.ok(start > 0 && end > start, 'discovery route region not found');
  const region = src.slice(start, end);
  assert.ok(region.includes("setConfig('mqtt_discovery_cache'"), 'cache persistence under mqtt_discovery_cache missing');
  assert.ok(!region.includes("setConfig('mqtt_devices'"), 'discovery region must never write mqtt_devices');
  assert.ok(region.includes("mqtt_discovery_cache"), 'region must reference the cache key');
});

// ================================================================ summary
console.log('');
console.log(`migration-backcompat.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
