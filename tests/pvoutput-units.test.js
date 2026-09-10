'use strict';

/**
 * Issue #117 — browser-free UI assertions for the PVOutput kWh/Wh unit
 * selector (spec §5 "UI-level assertions").
 *
 * `public/settings.js` is browser-global code with no test harness, so the
 * testable logic lives in the shared classic script `public/js/pvoutput-units.js`
 * (loaded by settings.html before settings.js, and required by the mapper), and
 * this suite exercises it directly plus asserts the wiring in the page sources.
 *
 * Run: node --test tests/pvoutput-units.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const units = require('../public/js/pvoutput-units');
const mapper = require('../modules/pvoutput/mapper');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Minimal stand-in for the page's metric options renderer.
const metricOptions = (selected) => (selected ? `<option value="${selected}" selected>${selected}</option>` : '<option value="">-- Select metric --</option>');

// UI-1 — collectPvoutputConfig output carries metric_map.v1_unit / v3_unit
// matching the selected dropdown values.
test('UI-1 collectMetricMap persists v1_unit/v3_unit from the unit dropdowns', () => {
  const mm = units.collectMetricMap(
    [{ key: 'v1', value: 'energy_kwh' }, { key: 'v3', value: 'consume_kwh' }],
    [{ key: 'v1', value: 'kWh' }, { key: 'v3', value: 'Wh' }]
  );
  assert.strictEqual(mm.v1, 'energy_kwh');
  assert.strictEqual(mm.v3, 'consume_kwh');
  assert.strictEqual(mm.v1_unit, 'kWh');
  assert.strictEqual(mm.v3_unit, 'Wh');
});

// UI-2 — v1_is_kwh === true iff the selected unit is kWh.
test('UI-2 collectMetricMap sets <key>_is_kwh === true only for kWh', () => {
  const kwh = units.collectMetricMap([{ key: 'v1', value: 'energy_kwh' }], [{ key: 'v1', value: 'kWh' }]);
  assert.strictEqual(kwh.v1_is_kwh, true);

  const wh = units.collectMetricMap([{ key: 'v1', value: 'energy_kwh' }], [{ key: 'v1', value: 'Wh' }]);
  assert.strictEqual(wh.v1_is_kwh, false);
  assert.strictEqual(wh.v1_unit, 'Wh');

  // Only energy keys get unit fields — a stray v2 unit select cannot leak in.
  const stray = units.collectMetricMap([{ key: 'v2', value: 'power_w' }], [{ key: 'v2', value: 'Wh' }]);
  assert.ok(!('v2_unit' in stray), 'v2 (power, W) must never carry a unit');
  assert.ok(!('v2_is_kwh' in stray), 'v2 must never carry a legacy unit flag');

  // An unmapped metric row is still recorded as empty-string-free map entries.
  const unmapped = units.collectMetricMap([{ key: 'v1', value: '' }], [{ key: 'v1', value: 'kWh' }]);
  assert.ok(!('v1' in unmapped), 'an unselected metric must not be written');
  assert.strictEqual(unmapped.v1_unit, 'kWh');
});

// UI-3 — the rendered unit selector is preselected from v1_unit, falling back
// to the legacy is_kwh boolean, then to kWh.
test('UI-3 unit selector preselection: v1_unit > legacy is_kwh > kWh', () => {
  const pick = (html) => {
    const m = /<option value="([^"]+)" selected>/.exec(html);
    return m ? m[1] : null;
  };

  assert.strictEqual(pick(units.buildUnitSelectorHtml('v1', { v1_unit: 'Wh' })), 'Wh');
  assert.strictEqual(pick(units.buildUnitSelectorHtml('v1', { v1_unit: 'kWh' })), 'kWh');
  assert.strictEqual(pick(units.buildUnitSelectorHtml('v1', { v1_is_kwh: false })), 'Wh');
  assert.strictEqual(pick(units.buildUnitSelectorHtml('v1', { v1_is_kwh: true })), 'kWh');
  assert.strictEqual(pick(units.buildUnitSelectorHtml('v1', {})), 'kWh');
  assert.strictEqual(pick(units.buildUnitSelectorHtml('v1', undefined)), 'kWh');

  // The control carries the class + data-key collectPvoutputConfig reads.
  const html = units.buildUnitSelectorHtml('v3', {});
  assert.match(html, /class="pvoutput-metric-unit"/);
  assert.match(html, /data-key="v3"/);
  assert.match(html, /<option value="kWh" selected>kWh<\/option>/);
  assert.match(html, /<option value="Wh">Wh<\/option>/);

  // Round-trip: what the UI collects is what the mapper consumes (AC-3/AC-6).
  const mm = units.collectMetricMap(
    [{ key: 'v3', value: 'consume_kwh' }],
    [{ key: 'v3', value: 'Wh' }]
  );
  const payload = mapper.buildStatusPayload({ consume_kwh: 39500 }, { timezone: 'UTC', metric_map: mm }, new Date('2026-08-11T12:34:00Z'));
  assert.strictEqual(payload.v3, 39500, 'Wh selection must survive collect → save → mapper');
});

// UI-4 — only the v1/v3 energy rows render a unit selector.
test('UI-4 renderMetricFieldsHtml: unit selector on v1/v3 only', () => {
  const html = units.renderMetricFieldsHtml({ v1: 'energy_kwh', v3: 'consume_kwh' }, (s) => s, metricOptions);

  const selectors = html.match(/class="pvoutput-metric-unit" data-key="([^"]+)"/g) || [];
  const keys = selectors.map((s) => /data-key="([^"]+)"/.exec(s)[1]);
  assert.deepStrictEqual(keys, ['v1', 'v3']);

  // Every metric row is still rendered, with its own data-key.
  for (const k of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
    assert.match(html, new RegExp(`class="pvoutput-metric" data-key="${k}"`), `missing metric row ${k}`);
  }
  assert.strictEqual(units.METRIC_FIELDS.filter((f) => f.unit).map((f) => f.key).join(','), 'v1,v3');

  // v2/v4 are power (W), v5 °C, v6 V — no unit control for any of them.
  const perRow = html.split('<div class="form-group"').slice(1);
  const withUnit = perRow.filter((row) => row.includes('pvoutput-metric-unit')).map((row) => /data-key="(v\d)"/.exec(row)[1]);
  assert.deepStrictEqual(withUnit, ['v1', 'v3'], 'non-energy rows must have no unit selector');
});

// UI-5 — no label says (Wh) next to a _kwh hint.
test('UI-5 labels/hints agree with the kWh convention', () => {
  for (const f of units.METRIC_FIELDS) {
    assert.ok(!/\(Wh\)/.test(f.label), `${f.key} label must not claim (Wh): ${f.label}`);
  }
  const v1 = units.METRIC_FIELDS.find((f) => f.key === 'v1');
  const v3 = units.METRIC_FIELDS.find((f) => f.key === 'v3');
  assert.match(v1.hint, /daily_solar_kwh|solar_kwh/);
  assert.match(v3.hint, /daily_consumption|load_kwh/);
  assert.match(v1.hint, /kWh/);
  assert.match(v3.hint, /kWh/);

  const html = units.renderMetricFieldsHtml({}, (s) => s, metricOptions);
  assert.ok(!html.includes('(Wh)'), 'rendered grid must not contain a (Wh) label');
});

// Wiring: the page actually uses the shared module, and the wizard preserves
// metric_map (AC-11). Source-level assertions — the browser bits have no harness.
test('wiring: settings.html loads the module, settings.js uses it, wizard preserves metric_map', () => {
  const settingsHtml = read('public/settings.html');
  const settingsJs = read('public/settings.js');
  const setupJs = read('public/js/setup.js');

  const unitsTag = settingsHtml.indexOf('js/pvoutput-units.js');
  const settingsTag = settingsHtml.indexOf('settings.js');
  assert.ok(unitsTag !== -1, 'settings.html must load js/pvoutput-units.js');
  assert.ok(unitsTag < settingsTag, 'the unit module must load BEFORE settings.js');

  assert.match(settingsJs, /renderMetricFieldsHtml/, 'settings.js must render rows via the shared module');
  assert.match(settingsJs, /collectMetricMap/, 'settings.js must collect metric_map via the shared module');
  assert.ok(!/Energy Generated \(Wh\)/.test(settingsJs), 'the (Wh) label must be gone from settings.js');

  // Both wizard PVOutput save payloads re-emit metric_map.
  const metricMapEmits = setupJs.match(/metric_map: pv\.metric_map \|\| \{\}/g) || [];
  assert.strictEqual(metricMapEmits.length, 2, 'both wizard save payloads must carry metric_map forward');
  assert.match(setupJs, /pvPatch\.metric_map =/, 'prefillOptional must read metric_map back');
});
