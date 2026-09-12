#!/usr/bin/env node
/**
 * tests/entity-state.test.js
 * Issue #61 Phase-3 defect — entity state dropped to null for numeric metrics,
 * plus the modules/ha.js mqttValues string-drop (rides along).
 *
 * Run:  node tests/entity-state.test.js   (also picked up by `npm test`)
 *
 * Why this shape
 * --------------
 * The bug lives in `findLatestStateForEntity()` inside server.js, which is NOT
 * exported and must never be `require()`d: at load time server.js calls
 * `initializeDatabase()` and `server.listen()`. So, exactly like the existing
 * text-metric-card fixture loads the real component source, this fixture reads
 * server.js as TEXT, brace-matches the real function body out, and executes
 * those production bytes with `db` / `getConfig` / `logger` injected. Nothing is
 * re-implemented: the expression under test is the one in server.js.
 *
 * The DB is a throwaway SQLite file in its own mkdtemp dir — the repo's
 * data/ is never opened, and `initializeDatabase()` is never called.
 *
 * Pre-fix the state expression was `row.value_type ? row.value_text : row.value`;
 * value_type is the STRING 'number' for numeric rows (truthy), so numeric rows
 * returned value_text (NULL). The `legacy` check below reproduces that failure
 * to prove the assertion is not vacuous.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const HA_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'ha.js'), 'utf8');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log('  \u2713 ' + name); }
  catch (e) { failures++; console.error('  \u2717 ' + name + ' \u2014 ' + (e && e.message || e)); }
}

// ── Load the real server.js function without requiring server.js ─────────
function extractFunctionBody(src, name) {
  const sigIdx = src.indexOf('function ' + name + '(');
  if (sigIdx === -1) throw new Error('function ' + name + '() not found in server.js');
  const open = src.indexOf('{', sigIdx);
  if (open === -1) throw new Error('no body brace for ' + name);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

const fnBody = extractFunctionBody(SERVER_SRC, 'findLatestStateForEntity');
// The body references only db / getConfig / logger / entityId as free variables.
// new Function(...) yields a 4-param function, so deps are bound at call time.
const findLatestStateFn = new Function('db', 'getConfig', 'logger', 'entityId', fnBody);

// ── Throwaway SQLite DB in its own temp dir (never the repo's data/) ─────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-entity-state-'));
const db = new Database(path.join(tmpDir, 'energy-test.db'));
db.exec(`
  CREATE TABLE latest_metrics (
    metric TEXT PRIMARY KEY,
    value REAL,
    timestamp INTEGER,
    unit TEXT,
    value_text TEXT,
    value_type TEXT
  );
`);
const insert = db.prepare(
  'INSERT INTO latest_metrics (metric, value, value_text, value_type) VALUES (?, ?, ?, ?)'
);
insert.run('solar_power', 43, null, 'number');        // numeric -> value set, value_text NULL
insert.run('relay_state', null, 'on', 'boolean');     // boolean -> value_text set
insert.run('inverter_state', null, 'Charging', 'string'); // string -> value_text set
insert.run('blank_state', null, '', 'string');        // genuine empty-string text

const haDevices = [{
  name: 'HA main',
  enabled: true,
  entities: {
    solar_power: 'sensor.solar_power',
    relay_state: { entityId: 'switch.relay_state', actions: [] }, // object-mapping form (AC-1.4)
    inverter_state: 'sensor.inverter_state',
    blank_state: 'sensor.blank_state',
    orphan: 'sensor.no_latest_row'                                 // entity mapped, no DB row
  }
}];
const getConfig = (key) => (key === 'ha_devices' ? JSON.stringify(haDevices) : undefined);
const logger = { warn: () => {}, info: () => {}, error: () => {} };
const findLatestStateForEntity = (entityId) => findLatestStateFn(db, getConfig, logger, entityId);

// ── Defect + fix ────────────────────────────────────────────────────────
console.log('findLatestStateForEntity \u2014 state contract (#61 Phase-3)');

check('defect is real: the pre-fix expression returns null for a numeric row', () => {
  const row = db.prepare('SELECT value, value_text, value_type FROM latest_metrics WHERE metric = ?').get('solar_power');
  const legacy = (r) => (r.value_type ? r.value_text : r.value);
  assert.strictEqual(legacy(row), null, 'pre-fix expression no longer reproduces the defect');
});

check('numeric row (value=43, value_text NULL) yields the number 43', () => {
  const r = findLatestStateForEntity('sensor.solar_power');
  assert.ok(r, 'expected a result object');
  assert.strictEqual(r.entity_id, 'sensor.solar_power');
  assert.strictEqual(typeof r.state, 'number');
  assert.strictEqual(r.state, 43);
});

check('boolean row (value_text="on") yields the text "on"', () => {
  const r = findLatestStateForEntity('switch.relay_state');
  assert.ok(r, 'expected a result object (object-mapping form)');
  assert.strictEqual(r.state, 'on');
});

check('string row (value_text="Charging") yields the text "Charging"', () => {
  const r = findLatestStateForEntity('sensor.inverter_state');
  assert.ok(r, 'expected a result object');
  assert.strictEqual(r.state, 'Charging');
});

check('empty-string text is carried through as "" (matches getCurrentMetrics), not null', () => {
  const r = findLatestStateForEntity('sensor.blank_state');
  assert.ok(r, 'expected a result object');
  assert.strictEqual(r.state, '');
  assert.notStrictEqual(r.state, null);
});

check('entity mapped to a metric with no latest_metrics row -> null (no throw)', () => {
  assert.strictEqual(findLatestStateForEntity('sensor.no_latest_row'), null);
});

check('unknown entity -> null (no throw)', () => {
  assert.strictEqual(findLatestStateForEntity('sensor.not_mapped'), null);
});

check('server.js no longer keys state on the value_type flag', () => {
  assert.ok(!/value_type\s*\?/.test(SERVER_SRC), 'server.js still contains a `value_type ?` ternary');
});

// ── modules/ha.js mqttValues string-drop (rides along) ───────────────────
// pollHomeAssistant() writes the map but cannot be run here (it needs a live
// DB + fetch), so the real assignment expression is extracted from source and
// evaluated for representative HA states. The bug: non-numeric, non-boolean
// states fell through to `undefined`, dropping the text.
console.log('modules/ha.js \u2014 mqttValues carries text values');

let evalMqttValue = null;
check('the mqttValues assignment expression is extractable from ha.js', () => {
  const m = HA_SRC.match(/mqttValues\[metric\]\s*=\s*(.+);\s*$/m);
  assert.ok(m, 'mqttValues[metric] assignment not found in modules/ha.js');
  evalMqttValue = new Function('data', 'num', 'return (' + m[1].trim() + ');');
});

check('numeric state stays numeric (43 -> 43)', () => {
  assert.strictEqual(evalMqttValue({ state: '43' }, 43), 43);
});

check('boolean states stay 1 / 0', () => {
  assert.strictEqual(evalMqttValue({ state: 'on' }, NaN), 1);
  assert.strictEqual(evalMqttValue({ state: 'true' }, NaN), 1);
  assert.strictEqual(evalMqttValue({ state: 'off' }, NaN), 0);
  assert.strictEqual(evalMqttValue({ state: 'false' }, NaN), 0);
});

check('a plain string state is carried through, not dropped to undefined', () => {
  const v = evalMqttValue({ state: 'Charging' }, NaN);
  assert.strictEqual(v, 'Charging');
  assert.notStrictEqual(v, undefined);
});

console.log('');
console.log('entity-state: ' + passes + ' passed, ' + failures + ' failed');
try { db.close(); } catch (_) { /* ignore */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(failures ? 1 : 0);
