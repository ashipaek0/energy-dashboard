#!/usr/bin/env node
/**
 * test/entity-catalog.test.js — issue #108 stage 1 fixtures (AC-1..6).
 *
 * Plain-node fixture in repo style (no framework, exit codes). Exercises the
 * pure projections in modules/entityCatalog.js against the SHIPPED profile set
 * (profiles/dongles/*.json) plus inline synthetic profiles. Never boots the
 * server, never touches a DB, never writes config.
 *
 * AC-2's byte-identical snapshot (test/fixtures/dongle-luxpower-geta.entities.json)
 * was captured at HEAD 34a1898 by executing the VERBATIM body of the then-current
 * route handler GET /api/dongle/profile/:id/entities (server.js L1872-1950) against
 * the shipped luxpower-geta profile — i.e. genuine current-route output, no server.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const catalog = require(path.join(ROOT, 'modules', 'entityCatalog.js'));

const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'entityCatalog.js'), 'utf8');

const PROFILES = {};
for (const id of ['deye-hybrid', 'srne-hybrid', 'growatt-spf', 'felicity-tcp', 'luxpower-geta']) {
  PROFILES[id] = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'dongles', `${id}.json`), 'utf8'));
}

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${label}\n      ${err && err.message ? err.message.split('\n').join('\n      ') : err}`);
  }
}

// ---------------------------------------------------------------------------
// AC-1 — module exports: catEntity + per-source pure projections, fs-free
// ---------------------------------------------------------------------------
check('AC-1: entityCatalog exports catEntity + dongle projections as functions', () => {
  for (const name of ['catEntity', 'dongleProfileEntities', 'dongleRegisterEntities', 'dongleGrowattEntities', 'dongleFelicityEntities', 'dongleLuxpowerEntities']) {
    assert.strictEqual(typeof catalog[name], 'function', `${name} should be a function`);
  }
  // Purity: no fs / db / network requires anywhere in the module.
  for (const banned of ["require('fs')", 'require("fs")', "require('http')", 'require("http")', 'require(' + "'net')", 'require("net")', 'require(' + "'./database')", 'require("./database")']) {
    assert.ok(!MODULE_SRC.includes(banned), `module must be fs-free / io-free (found ${banned})`);
  }
  // catEntity contract: id required, undefined values dropped.
  const item = catalog.catEntity({ id: '0x0065', name: 'solar_power', label: 'Solar Power', scale: 0.1, unit: 'W', type: 'uint16', count: 1, kind: 'register', access: 'read', writable: false, unitMissing: undefined });
  assert.deepStrictEqual(item, { id: '0x0065', name: 'solar_power', label: 'Solar Power', scale: 0.1, unit: 'W', type: 'uint16', count: 1, access: 'read', writable: false, kind: 'register' });
  assert.throws(() => catalog.catEntity({}), /id/);
});

// ---------------------------------------------------------------------------
// AC-2 — luxpower-geta byte-identical to current route output (snapshot fixture)
// ---------------------------------------------------------------------------
const SNAPSHOT_PATH = path.join(__dirname, 'fixtures', 'dongle-luxpower-geta.entities.json');
const SNAPSHOT = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
const SNAPSHOT_ENTITIES = JSON.parse(SNAPSHOT);
const LUX = PROFILES['luxpower-geta'];

check('AC-2: luxpower-geta projection is byte-identical to captured current-route output', () => {
  assert.strictEqual(JSON.stringify(catalog.dongleProfileEntities(LUX)), SNAPSHOT,
    'serialized projection must equal the route-verbatim snapshot byte-for-byte');
  assert.strictEqual(catalog.dongleProfileEntities(LUX).length, LUX.metrics.length, 'one item per metric (no writable-only extras at HEAD)');
});

check('AC-2: snapshot structure — item keys, namespaced ids, sort, decode-key match', () => {
  const baseKeys = ['id', 'register_type', 'register', 'name', 'label', 'unit', 'scale', 'type', 'count', 'access', 'writable'];
  const allowed = new Set([...baseKeys, 'min', 'max', 'step', 'kind', 'actions']);
  const byId = new Map(LUX.metrics.map(m => [m.register_type ? `${m.register_type}:${m.register}` : m.register, m]));
  let prevKey = null;
  const ids = new Set();
  for (const e of SNAPSHOT_ENTITIES) {
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected key ${k} on ${e.id}`);
    assert.strictEqual(e.id, `${e.register_type}:${e.register}`, 'id is namespaced register_type:register');
    assert.ok(/^(input|holding):0x[0-9A-Fa-f]{4}$/.test(e.id), `namespaced hex id expected, got ${e.id}`);
    ids.add(e.id);
    assert.ok(!e.id.includes('undefined'), `no undefined:0x ids (got ${e.id})`);
    // Every emitted id is exactly the decode key decodeLuxpowerMetrics consumes,
    // and every field mirrors its owning profile metric 1:1.
    const m = byId.get(e.id);
    assert.ok(m, `snapshot id ${e.id} must be a decode key of luxpower-geta metrics[]`);
    assert.strictEqual(e.name, m.name);
    assert.strictEqual(e.register_type, m.register_type);
    assert.strictEqual(e.register, m.register);
    assert.strictEqual(e.label, m.label);
    assert.strictEqual(e.unit, m.unit);
    assert.strictEqual(e.scale, m.scale);
    assert.strictEqual(e.type, m.type);
    assert.strictEqual(e.count, m.count);
    // sort: register_type order input(2) before holding(3), then numeric register
    const curTypeOrder = e.register_type === 'input' ? 2 : 3;
    const curNum = parseInt(e.register, 16);
    if (prevKey !== null) {
      const ord = curTypeOrder - prevKey.typeOrder || curNum - prevKey.num;
      assert.ok(ord >= 0, `out of order ${e.id}`);
    }
    prevKey = { typeOrder: curTypeOrder, num: curNum };
    // access/writable base shape (writable list empty at HEAD → all read)
    assert.strictEqual(e.access, 'read');
    assert.strictEqual(e.writable, false);
    assert.strictEqual(Object.keys(e).length, baseKeys.length, `item ${e.id} should carry exactly the 12 route keys (writable empty at HEAD)`);
  }
  assert.strictEqual(ids.size, LUX.metrics.length, 'ids unique, 1:1 with metrics');
  // decode-key bijection: emitted id set === set of decodeLuxpowerMetrics keys
  const decodeKeys = new Set(LUX.metrics.map(m => (m.register_type ? `${m.register_type}:${m.register}` : m.register)));
  assert.strictEqual(ids.size, decodeKeys.size);
  for (const k of decodeKeys) assert.ok(ids.has(k), `decode key ${k} missing from emitted set`);
});

check('AC-2: writable_registers union reproduces legacy route semantics (synthetic luxpower profile)', () => {
  // Synthetic profile modelling the historical 4-writable luxpower-geta shape
  // (0b256ae) + an actions entry, exercising the union + readwrite extras.
  const profile = {
    name: 'Synthetic LuxPower fixture profile',
    protocol: 'luxpower-tcp',
    mapping: 'explicit',
    metrics: [
      { name: 'operational_state', register: '0x0000', register_type: 'input', count: 1, type: 'uint16', scale: 1, unit: '', label: 'Operational State' },
      { name: 'pv1_voltage', register: '0x0001', register_type: 'input', count: 1, type: 'uint16', scale: 0.1, unit: 'V', label: 'PV1 Voltage' },
      { name: 'charge_first_soc_limit', register: '0x004B', register_type: 'holding', count: 1, type: 'uint16', scale: 1, unit: '%', label: 'Charge First SOC Limit' },
      { name: 'eod_soc', register: '0x0069', register_type: 'holding', count: 1, type: 'uint16', scale: 1, unit: '%', label: 'EOD SOC (Shutdown %)' }
    ],
    writable_registers: [
      { register: '0x0069', register_type: 'holding', name: 'eod_soc', label: 'EOD SOC (Shutdown %)', unit: '%', scale: 1, type: 'uint16', min: 10, max: 90, step: 1, kind: 'value', actions: [{ key: 'set' }] },
      { register: '0x004B', register_type: 'holding', name: 'charge_first_soc_limit', label: 'Charge First SOC Limit', unit: '%', scale: 1, type: 'uint16', min: 0, max: 100, step: 1, kind: 'value' },
      { register: '0x005A', register_type: 'holding', name: 'eps_voltage_set', label: 'EPS Voltage Set', unit: 'V', scale: 1, type: 'uint16', min: 200, max: 260, step: 1, kind: 'value' }
    ]
  };
  const got = catalog.dongleProfileEntities(profile);
  const expected = [
    { id: 'input:0x0000', register_type: 'input', register: '0x0000', name: 'operational_state', label: 'Operational State', unit: '', scale: 1, type: 'uint16', count: 1, access: 'read', writable: false },
    { id: 'input:0x0001', register_type: 'input', register: '0x0001', name: 'pv1_voltage', label: 'PV1 Voltage', unit: 'V', scale: 0.1, type: 'uint16', count: 1, access: 'read', writable: false },
    { id: 'holding:0x004B', register_type: 'holding', register: '0x004B', name: 'charge_first_soc_limit', label: 'Charge First SOC Limit', unit: '%', scale: 1, type: 'uint16', count: 1, access: 'readwrite', writable: true, min: 0, max: 100, step: 1, kind: 'value' },
    // writable-only register (absent from metrics[]) surfaces as an extra entity
    { id: 'holding:0x005A', register_type: 'holding', register: '0x005A', name: 'eps_voltage_set', label: 'EPS Voltage Set', unit: 'V', scale: 1, type: 'uint16', count: 1, access: 'readwrite', writable: true, min: 200, max: 260, step: 1, kind: 'value' },
    { id: 'holding:0x0069', register_type: 'holding', register: '0x0069', name: 'eod_soc', label: 'EOD SOC (Shutdown %)', unit: '%', scale: 1, type: 'uint16', count: 1, access: 'readwrite', writable: true, min: 10, max: 90, step: 1, kind: 'value', actions: [{ key: 'set' }] }
  ];
  assert.strictEqual(got.length, 5, '4 metrics + 1 writable-only union entity');
  assert.strictEqual(JSON.stringify(got), JSON.stringify(expected), 'union output (keys/order/values) must match legacy route shape');
});

// ---------------------------------------------------------------------------
// AC-3 — register transports: one item per metrics[], bare-hex ids, no
//        'undefined:0x', register_type metadata default 'holding', kind 'register'
// ---------------------------------------------------------------------------
function registerFamilyAssertions(id, profile) {
  const entities = catalog.dongleProfileEntities(profile);
  assert.strictEqual(entities.length, profile.metrics.length, `${id}: one entity per metrics[] entry`);
  const byReg = new Map(profile.metrics.map(m => [m.register, m]));
  const ids = new Set();
  let prevNum = -1;
  for (const e of entities) {
    ids.add(e.id);
    assert.ok(!e.id.includes('undefined'), `${id}: id must never contain 'undefined' (got ${e.id})`);
    assert.ok(/^0x[0-9A-Fa-f]+$/.test(e.id), `${id}: bare-hex id expected, got '${e.id}'`);
    const m = byReg.get(e.id);
    assert.ok(m, `${id}: id ${e.id} must be a verbatim metrics[].register`);
    assert.strictEqual(e.id, m.register, `${id}: id must equal register verbatim, never namespaced`);
    assert.strictEqual(e.kind, 'register');
    assert.strictEqual(e.register_type, 'holding', `${id}: register_type metadata defaults to 'holding' when profile omits it`);
    assert.strictEqual(e.register, m.register);
    assert.strictEqual(e.name, m.name);
    assert.strictEqual(e.label, m.label);
    assert.strictEqual(e.unit, m.unit);
    assert.strictEqual(e.scale, m.scale);
    assert.strictEqual(e.type, m.type);
    assert.strictEqual(e.count, m.count);
    assert.strictEqual(e.access, 'read');
    assert.strictEqual(e.writable, false);
    const num = parseInt(e.id, 16);
    assert.ok(num >= prevNum, `${id}: sorted by numeric register (${e.id} after ${prevNum})`);
    prevNum = num;
  }
  assert.strictEqual(ids.size, profile.metrics.length, `${id}: ids unique`);
}

check('AC-3: deye-hybrid (solarman-v5) — bare-hex register entities', () => {
  registerFamilyAssertions('deye-hybrid', PROFILES['deye-hybrid']);
  // register+field both present → id must be the register (decode key), not the field
  const e = catalog.dongleProfileEntities(PROFILES['deye-hybrid']).find(x => x.register === '0x0065');
  assert.strictEqual(e.id, '0x0065');
});

check('AC-3: srne-hybrid (solarman-v5) — bare-hex register entities', () => {
  registerFamilyAssertions('srne-hybrid', PROFILES['srne-hybrid']);
});

check('AC-3: modbus-tcp transport — same bare-hex register projection (synthetic)', () => {
  const synthetic = {
    name: 'Synthetic Modbus TCP dongle profile (fixture only)',
    transport: 'modbus-tcp',
    requires_serial: false,
    default_port: 502,
    default_unit_id: 1,
    metrics: [
      { name: 'solar_power', register: '0x0001', count: 1, type: 'uint16', scale: 1, unit: 'W', label: 'Solar Power' },
      { name: 'battery_voltage', register: '0x000A', count: 2, type: 'uint32', scale: 0.1, unit: 'V', label: 'Battery Voltage' },
      { name: 'grid_power', register: '0x0002', count: 1, type: 'int16', scale: 1, unit: 'W', label: 'Grid Power' }
    ]
  };
  // dispatch: transport 'modbus-tcp' must land on the register family projection
  assert.deepStrictEqual(catalog.dongleProfileEntities(synthetic), catalog.dongleRegisterEntities(synthetic));
  registerFamilyAssertions('synthetic-modbus-tcp', synthetic);
  const ids = catalog.dongleProfileEntities(synthetic).map(e => e.id);
  assert.deepStrictEqual(ids, ['0x0001', '0x0002', '0x000A'], 'numeric-register sort');
});

// ---------------------------------------------------------------------------
// AC-4 — growatt-spf: id = m.field, kind 'field', register '' included, label sort
// ---------------------------------------------------------------------------
check('AC-4: growatt-spf — field-id projection', () => {
  const profile = PROFILES['growatt-spf'];
  const entities = catalog.dongleProfileEntities(profile);
  assert.strictEqual(entities.length, profile.metrics.length, 'one entity per metrics[] (register \"\" entries included)');
  const byField = new Map(profile.metrics.map(m => [m.field, m]));
  const ids = new Set();
  let prevLabel = null;
  for (const e of entities) {
    ids.add(e.id);
    assert.ok(byField.has(e.id), `id ${e.id} must be a verbatim m.field (decode key growatt.js)`);
    assert.strictEqual(e.id, byField.get(e.id).field);
    assert.strictEqual(e.kind, 'field');
    assert.strictEqual(e.name, byField.get(e.id).name);
    assert.strictEqual(e.register, undefined, 'register is not part of growatt field entities');
    assert.strictEqual(e.access, 'read');
    assert.strictEqual(e.writable, false);
    if (prevLabel !== null) assert.ok(String(e.label).localeCompare(String(prevLabel)) >= 0, `sorted by label (${e.label} after ${prevLabel})`);
    prevLabel = e.label;
  }
  assert.strictEqual(ids.size, profile.metrics.length, 'ids unique');
  assert.ok(ids.has('pv1_power'), 'pv1_power (register \"\" metric) is emitted with its field id');
});

// ---------------------------------------------------------------------------
// AC-5 — felicity-tcp: one item per fields[], id = f.path, kind 'path'
// ---------------------------------------------------------------------------
check('AC-5: felicity-tcp — JSON-path projection', () => {
  const profile = PROFILES['felicity-tcp'];
  const entities = catalog.dongleProfileEntities(profile);
  assert.strictEqual(entities.length, profile.fields.length, 'one entity per fields[] entry');
  const byPath = new Map(profile.fields.map(f => [f.path, f]));
  const ids = new Set();
  for (const e of entities) {
    ids.add(e.id);
    assert.ok(byPath.has(e.id), `id ${e.id} must be a verbatim field.path (decode key pollJsonInstance)`);
    assert.strictEqual(e.id, byPath.get(e.id).path);
    assert.strictEqual(e.kind, 'path');
    assert.strictEqual(e.name, byPath.get(e.id).name);
    assert.strictEqual(e.label, byPath.get(e.id).label);
    assert.strictEqual(e.scale, byPath.get(e.id).scale);
    assert.strictEqual(e.access, 'read');
    assert.strictEqual(e.writable, false);
  }
  assert.strictEqual(ids.size, profile.fields.length, 'paths unique');
  // bracket-array paths are part of the emitted decode-key set
  assert.ok(ids.has('realtime.ACin[0][0]'), 'array-indexed path id emitted verbatim');
  // profile order preserved (deterministic decode order)
  assert.strictEqual(entities[0].id, profile.fields[0].path);
});

// ---------------------------------------------------------------------------
// AC-6 — id round-trip: a legacy {defaultName: id} mapping resolves 1:1 through
//        the projection for every shipped profile (decode-reachable bijection)
// ---------------------------------------------------------------------------
function decodeUnits(profile) {
  // (profile, unit, decodeKey) per shipped family — mirrors each module's decode loop
  if (Array.isArray(profile.fields) && profile.fields.length) return profile.fields.map(f => ({ unit: f, key: f.path, kind: 'path' }));
  return profile.metrics.map(m => {
    if (profile.transport === 'growatt') return { unit: m, key: m.field, kind: 'field' };
    if (m.register_type) return { unit: m, key: `${m.register_type}:${m.register}`, kind: 'namespaced' };
    return { unit: m, key: m.register, kind: 'register' };
  });
}

check('AC-6: round-trip every shipped dongle profile — emitted ids == decode keys, 1:1', () => {
  for (const [id, profile] of Object.entries(PROFILES)) {
    const entities = catalog.dongleProfileEntities(profile);
    const units = decodeUnits(profile);
    const emitted = new Set(entities.map(e => e.id));
    assert.strictEqual(entities.length, units.length, `${id}: entity count == decode-unit count (no growth)`);
    assert.strictEqual(emitted.size, units.length, `${id}: ids unique`);

    const idByName = new Map();
    for (const u of units) {
      // every decode key is emitted exactly once
      assert.ok(emitted.has(u.key), `${id}: decode key ${u.key} missing from emitted ids`);
      // no undefined ids, no namespaced leakage on register transports
      assert.ok(!String(u.key).includes('undefined'), `${id}: decode key must not contain 'undefined' (got ${u.key})`);
      const entity = entities.find(e => e.id === u.key);
      // legacy {defaultName: id} mapping round-trips: name ↔ key resolves 1:1
      idByName.set(u.unit.name, u.key);
      assert.strictEqual(entity.name, u.unit.name, `${id}: entity name is the implicit default metric name for ${u.key}`);
    }

    // reverse resolution — mapping value (id) uniquely recovers the metric name
    const nameById = new Map();
    for (const [name, key] of idByName) {
      assert.ok(!nameById.has(key), `${id}: decode key ${key} must map to exactly one default name`);
      nameById.set(key, name);
    }
    for (const e of entities) {
      assert.ok(nameById.has(e.id), `${id}: emitted id ${e.id} must be reachable by the module reverse-lookup`);
      assert.strictEqual(nameById.get(e.id), e.name);
    }
  }
});

check('AC-6: register-family ids are never namespaced and never carry register_type in the id', () => {
  for (const id of ['deye-hybrid', 'srne-hybrid']) {
    for (const e of catalog.dongleProfileEntities(PROFILES[id])) {
      assert.strictEqual(e.id, e.register, `${id}: id must be the bare hex register`);
      assert.ok(!/^(input|holding|coil|discrete):/.test(e.id), `${id}: no namespaced prefix in register-family ids`);
    }
  }
});

// ---------------------------------------------------------------------------
console.log(`\nentity-catalog.test.js: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
