'use strict';

/**
 * Issue #61 Phase 2 — behavioural tests for the shared metric-value guards.
 *
 * These exercise the REAL shipped module (`public/js/utils.js`): the two helpers
 * below are the single shared contract every hardened card calls, so testing them
 * here tests the actual coercion decision the cards make.
 *
 * Why the source is loaded via a data: URL instead of `require`/`import`:
 * `public/js/utils.js` is an ES module (`export function ...`) and the repo's
 * `package.json` has no `"type": "module"`, so Node treats a bare `.js` file as
 * CommonJS and either a `require` or a direct `import()` of that path fails to
 * parse it. Evaluating the same bytes as an ES module keeps this a test of the
 * real file's behaviour, not of a copy or of a regex over its text.
 *
 * NOTE ON COVERAGE (stated rather than faked): the card *update functions*
 * (`updateFlowCard`, `updateGaugeCard`, ...) are browser-only — they touch
 * `document`, `getComputedStyle` and `requestAnimationFrame` — and the repo has
 * no DOM environment or frontend test runner. Their number→text behaviour is
 * therefore verified in a browser, not here. What IS covered here is the exact
 * predicate/formatting contract those functions delegate to, plus a behavioural
 * reproduction of the flowCard NaN mechanism (see the last test).
 *
 * Run: node tests/metric-value-format.test.js   (or `npm test`)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const UTILS_PATH = path.join(__dirname, '..', 'public', 'js', 'utils.js');

let helpersPromise = null;
function loadHelpers() {
  if (!helpersPromise) {
    const src = fs.readFileSync(UTILS_PATH, 'utf8');
    const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
    helpersPromise = import(url);
  }
  return helpersPromise;
}

// ---------------------------------------------------------------------------
// isNumericValue — the D1 predicate
// ---------------------------------------------------------------------------

test('isNumericValue: true for every real finite number', async () => {
  const { isNumericValue } = await loadHelpers();
  for (const n of [0, -0, 1, -1, 3.5, -273.15, 4200, 1e12, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, Number.MAX_VALUE]) {
    assert.strictEqual(isNumericValue(n), true, `expected true for ${n}`);
  }
});

test('isNumericValue: false for NaN, Infinity and -Infinity (the hole typeof leaves)', async () => {
  const { isNumericValue } = await loadHelpers();
  assert.strictEqual(isNumericValue(NaN), false);
  assert.strictEqual(isNumericValue(Infinity), false);
  assert.strictEqual(isNumericValue(-Infinity), false);
  // Documents the bug D1 closes: the old guard accepted a genuine NaN, because
  // `typeof NaN === 'number'` and `!isNaN` was missing from three call sites.
  assert.strictEqual(typeof NaN === 'number', true);
});

test('isNumericValue: false for numeric-looking strings (D7 — declared text stays text)', async () => {
  const { isNumericValue } = await loadHelpers();
  for (const s of ['123', '3.5', '-42', '1e3', '4200.0', '0']) {
    assert.strictEqual(isNumericValue(s), false, `expected false for ${JSON.stringify(s)}`);
  }
});

test('isNumericValue: false for non-numeric strings, empty and whitespace-only', async () => {
  const { isNumericValue } = await loadHelpers();
  for (const s of ['Charging', 'FAULT', 'heat', '', ' ', '\t\n', 'NaN', 'Infinity', 'n/a', '--']) {
    assert.strictEqual(isNumericValue(s), false, `expected false for ${JSON.stringify(s)}`);
  }
});

test('isNumericValue: false for boolean tokens, booleans, null, undefined and objects', async () => {
  const { isNumericValue } = await loadHelpers();
  for (const v of ['on', 'off', 'true', 'false', 'ON', 'Off', true, false, null, undefined, {}, [], () => {}]) {
    assert.strictEqual(isNumericValue(v), false, `expected false for ${JSON.stringify(v)}`);
  }
});

test('isNumericValue: never throws, for any input', async () => {
  const { isNumericValue } = await loadHelpers();
  const sample = [0, NaN, Infinity, 'x', '', null, undefined, true, false, {}, [], Symbol('s'), 10n, () => {}];
  for (const v of sample) {
    assert.doesNotThrow(() => isNumericValue(v));
    assert.strictEqual(typeof isNumericValue(v), 'boolean');
  }
});

// ---------------------------------------------------------------------------
// formatValueText — the D2 non-numeric presentation contract
// ---------------------------------------------------------------------------

test('formatValueText: maps all four stored boolean tokens to Title-case, uniformly (D2/AC-2.7)', async () => {
  const { formatValueText } = await loadHelpers();
  assert.strictEqual(formatValueText('on'), 'On');
  assert.strictEqual(formatValueText('true'), 'On');
  assert.strictEqual(formatValueText('off'), 'Off');
  assert.strictEqual(formatValueText('false'), 'Off');
  // The write path lowercases, but tolerate case/whitespace variants rather than
  // rendering "ON" or "Off " inconsistently across cards.
  assert.strictEqual(formatValueText('ON'), 'On');
  assert.strictEqual(formatValueText('Off'), 'Off');
  assert.strictEqual(formatValueText('TRUE'), 'On');
  assert.strictEqual(formatValueText(' on '), 'On');
  // Real booleans take the same mapping.
  assert.strictEqual(formatValueText(true), 'On');
  assert.strictEqual(formatValueText(false), 'Off');
});

test('formatValueText: returns text verbatim, original case (AC-2.8)', async () => {
  const { formatValueText } = await loadHelpers();
  assert.strictEqual(formatValueText('Charging'), 'Charging');
  assert.strictEqual(formatValueText('FAULT'), 'FAULT');
  assert.strictEqual(formatValueText('heat'), 'heat');
  assert.strictEqual(formatValueText('discharging from grid'), 'discharging from grid');
  // Not a boolean token and not numeric: untouched, no inferred unit appended here.
  assert.strictEqual(formatValueText('inverter_temp_status'), 'inverter_temp_status');
  // XSS payload is NOT executed or rewritten here; the cards write this with
  // textContent, so the literal text is the correct result (AC-2.8 escaping check).
  assert.strictEqual(formatValueText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('formatValueText: uses the -- placeholder for missing values, never 0', async () => {
  const { formatValueText } = await loadHelpers();
  assert.strictEqual(formatValueText(undefined), '--');
  assert.strictEqual(formatValueText(null), '--');
  // A measured zero must stay distinguishable from "no data": the zero is handled
  // by the numeric branch of the cards, never by this function.
  assert.strictEqual(formatValueText(0), '0');
});

test('formatValueText: never emits NaN / undefined / null / [object Object] (AC-2.1/2.3 invariant)', async () => {
  const { formatValueText } = await loadHelpers();
  const forbidden = ['NaN', 'undefined', 'null', '[object Object]'];
  const sample = [NaN, Infinity, -Infinity, undefined, null, {}, [], () => {}, Symbol('s'), 10n, '', ' ', '\u0000'];
  for (const v of sample) {
    let out;
    assert.doesNotThrow(() => { out = formatValueText(v); }, `threw for ${String(v)}`);
    assert.strictEqual(typeof out, 'string', `non-string output for ${String(v)}`);
    for (const bad of forbidden) {
      assert.ok(!out.includes(bad), `output ${JSON.stringify(out)} leaks ${JSON.stringify(bad)}`);
    }
  }
  assert.strictEqual(formatValueText(NaN), '--');
  assert.strictEqual(formatValueText(Infinity), '--');
  assert.strictEqual(formatValueText({}), '--');
});

// ---------------------------------------------------------------------------
// Contract at the shape the Phase 1 read path actually delivers
// ---------------------------------------------------------------------------

test('phase-1 read-path fixtures pick exactly one branch and never yield NaN', async () => {
  const { isNumericValue, formatValueText } = await loadHelpers();
  // { value, type } exactly as getCurrentMetrics() emits it (spec §6.2).
  const fixtures = [
    { name: 'N1 solar',           entry: { value: 4200,       type: 'number'  } },
    { name: 'N2 battery_soc',     entry: { value: 76,         type: 'number'  } },
    { name: 'L legacy_power',     entry: { value: 0,          type: 'number'  } },
    { name: 'T1 inverter_state',  entry: { value: 'Charging', type: 'string'  } },
    { name: 'T2 battery_error',   entry: { value: 'FAULT',    type: 'string'  } },
    { name: 'B1 grid_relay',      entry: { value: 'on',       type: 'boolean' } },
    { name: 'B2 mains_present',   entry: { value: 'false',    type: 'boolean' } }
  ];
  for (const { name, entry } of fixtures) {
    const numeric = isNumericValue(entry.value);
    // Exactly one branch — never both, never neither (card code is if/else on this).
    if (entry.type === 'number') assert.strictEqual(numeric, true, name);
    else assert.strictEqual(numeric, false, name);

    const rendered = numeric ? String(entry.value) : formatValueText(entry.value);
    assert.ok(!/NaN|undefined|null/.test(rendered), `${name} rendered ${JSON.stringify(rendered)}`);
  }
  assert.strictEqual(formatValueText('Charging'), 'Charging');
  assert.strictEqual(formatValueText('on'), 'On');
  assert.strictEqual(formatValueText('false'), 'Off');
});

test('the flowCard NaN mechanism is closed by the predicate (behavioural reproduction)', async () => {
  const { isNumericValue } = await loadHelpers();

  // OLD behaviour: `m[n]?.value || 0` passed a truthy string straight through,
  // and `Math.round('Charging')` is NaN — and `typeof NaN === 'number'` is true,
  // so the old `typeof sw === 'number' ? sw : 0` guard in flowCard never fired.
  const oldSw = Math.round('Charging');
  assert.ok(Number.isNaN(oldSw));
  const oldPct = Math.min(100, (oldSw / (2.1 * 1000)) * 100);
  assert.ok(Number.isNaN(oldPct), 'old path produced NaN%, as reported in the issue');

  // NEW behaviour: the value is clamped to numeric 0 *before* Math.round, so
  // every derived number stays finite.
  const valueOf = (entry) => (isNumericValue(entry?.value) ? entry.value : 0);
  for (const text of ['Charging', 'FAULT', 'on', 'false', '', '123', NaN, Infinity]) {
    const sw = Math.round(valueOf({ value: text, type: 'string' }));
    const pct = Math.min(100, (sw / (2.1 * 1000)) * 100);
    assert.strictEqual(Number.isFinite(sw), true, `sw not finite for ${JSON.stringify(text)}`);
    assert.strictEqual(Number.isFinite(pct), true, `pct not finite for ${JSON.stringify(text)}`);
    assert.ok(!String(pct.toFixed(0) + '%').includes('NaN'));
  }
  // And the numeric path is untouched: a real reading still rounds normally.
  assert.strictEqual(Math.round(valueOf({ value: 4200, type: 'number' })), 4200);
});
