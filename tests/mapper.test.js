'use strict';

/**
 * Tests for the PVOutput metric mapper (issue #76 — .toFixed crash on
 * non-numeric metric values).
 *
 * Run: node --test tests/mapper.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildStatusPayload, validatePayload, deriveBatteryState, resolveEnergyUnit } = require('../modules/pvoutput/mapper');
const { logger } = require('../modules/logger');

// 12:34 UTC rounds down to the 12:30 PVOutput slot.
const DATE = new Date('2026-08-11T12:34:00Z');

function baseConfig(overrides = {}) {
  return {
    timezone: 'UTC',
    metric_map: { v5: 'temp_c', v6: 'voltage_v' },
    donation_mode: false,
    battery_enabled: false,
    net_mode: false,
    ...overrides
  };
}

test('numeric strings coerce and round: v5 "42.5" -> 42.5, v6 "24.56" -> 24.6', () => {
  const payload = buildStatusPayload(
    { temp_c: '42.5', voltage_v: '24.56' },
    baseConfig(),
    DATE
  );
  assert.strictEqual(payload.v5, 42.5);
  assert.strictEqual(payload.v6, 24.6);
  assert.strictEqual(typeof payload.v5, 'number');
  assert.strictEqual(typeof payload.v6, 'number');
});

test('non-numeric strings "N/A"/"abc" -> key omitted', () => {
  const payload = buildStatusPayload(
    { temp_c: 'N/A', voltage_v: 'abc' },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for "N/A"');
  assert.ok(!('v6' in payload), 'v6 should be omitted for "abc"');
});

test('null/undefined -> key omitted', () => {
  const payload = buildStatusPayload(
    { temp_c: null, voltage_v: undefined },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for null');
  assert.ok(!('v6' in payload), 'v6 should be omitted for undefined');
});

test('NaN/Infinity/-Infinity -> key omitted', () => {
  const payload = buildStatusPayload(
    { temp_c: NaN, voltage_v: Infinity },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for NaN');
  assert.ok(!('v6' in payload), 'v6 should be omitted for Infinity');

  const payload2 = buildStatusPayload({ temp_c: -Infinity }, baseConfig(), DATE);
  assert.ok(!('v5' in payload2), 'v5 should be omitted for -Infinity');
});

test('empty/whitespace-only strings -> key omitted (no 0.0 falsification)', () => {
  const payload = buildStatusPayload(
    { temp_c: '', voltage_v: '   ' },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for empty string');
  assert.ok(!('v6' in payload), 'v6 should be omitted for whitespace-only string');
});

test('mixed donation loop: v7="bad" omitted, v8="25.556" -> 25.56 present', () => {
  const config = baseConfig({
    donation_mode: true,
    metric_map: { v7: 'don_a', v8: 'don_b' }
  });
  const payload = buildStatusPayload({ don_a: 'bad', don_b: '25.556' }, config, DATE);
  assert.ok(!('v7' in payload), 'v7 should be omitted for "bad"');
  assert.strictEqual(payload.v8, 25.56);
});

test('all-numeric control payload matches shape (energy defaults to kWh ×1000)', () => {
  const config = {
    timezone: 'UTC',
    metric_map: {
      v1: 'energy_kwh', v2: 'power_w', v3: 'consume_kwh', v4: 'consume_w',
      v5: 'temp_c', v6: 'voltage_v',
      v7: 'don1', v8: 'don2', v9: 'don3', v10: 'don4', v11: 'don5', v12: 'don6',
      b1: 'batt_w', soc_metric: 'soc'
    },
    donation_mode: true,
    battery_enabled: true,
    net_mode: false,
    c1_mode: 1
  };
  const metrics = {
    energy_kwh: 12.345,  // v1 = round(12.345*1000) = 12345 (issue #117 default kWh)
    power_w: 1234.5,     // v2 = 1235 (Math.round)
    consume_kwh: 5.5,    // v3 = round(5.5*1000) = 5500 (issue #117 default kWh)
    consume_w: 300.2,    // v4 = 300 (Math.round)
    temp_c: '42.5',      // v5 = 42.5 (toFixed(1))
    voltage_v: '24.56',  // v6 = 24.6 (toFixed(1))
    don1: '1.111',       // v7 = 1.11
    don2: '2.222',       // v8 = 2.22
    don3: '3.333',       // v9 = 3.33
    don4: '4.444',       // v10 = 4.44
    don5: '5.556',       // v11 = 5.56
    don6: '6.666',       // v12 = 6.67
    batt_w: 150.4,       // b1 = 150 (Math.round)
    soc: 96              // b2 = 3 (soc >= 95 => Full)
  };
  const payload = buildStatusPayload(metrics, config, DATE);
  assert.deepStrictEqual(payload, {
    d: '20260811',
    t: '12:30',
    v1: 12345,
    c1: 1,
    v2: 1235,
    v3: 5500,
    v4: 300,
    v5: 42.5,
    v6: 24.6,
    b1: 150,
    b2: 3,
    v7: 1.11,
    v8: 2.22,
    v9: 3.33,
    v10: 4.44,
    v11: 5.56,
    v12: 6.67
  });
});

/**
 * Issue #111 — getCurrentMetrics() envelope fixtures.
 *
 * The live metrics API returns each metric as an envelope object
 * ({ value, type, timestamp, unit }), possibly with string values, which the
 * mapper previously Math.round()'d into NaN -> null payloads.
 */

function envelope(value, type = 'number', unit = '') {
  return { value, type, timestamp: '2026-08-11T12:30:00Z', unit };
}

function fullConfig(overrides = {}) {
  return {
    timezone: 'UTC',
    metric_map: {
      v1: 'energy_kwh', v2: 'power_w', v3: 'consume_kwh', v4: 'consume_w',
      v5: 'temp_c', v6: 'voltage_v'
    },
    donation_mode: false,
    battery_enabled: false,
    net_mode: false,
    ...overrides
  };
}

// T1: prod envelope happy path — numeric and string envelope values unwrap,
// kwh scaling and rounding apply to the unwrapped value.
test('T1 envelope: v1..v6 numeric + string values unwrap and round', () => {
  const config = fullConfig({
    c1_mode: 1,
    metric_map: {
      ...fullConfig().metric_map,
      v1_is_kwh: true,
      v3_is_kwh: true
    }
  });
  const metrics = {
    energy_kwh: envelope(12.345, 'number', 'kWh'),   // v1 = round(12.345*1000) = 12345
    power_w: envelope('1234.5', 'number', 'W'),       // v2 = round(1234.5) = 1235
    consume_kwh: envelope('5.5', 'number', 'kWh'),    // v3 = round(5.5*1000) = 5500
    consume_w: envelope(300.2, 'number', 'W'),        // v4 = round(300.2) = 300
    temp_c: envelope('42.5'),                         // v5 = 42.5
    voltage_v: envelope('24.56')                      // v6 = 24.6
  };
  const payload = buildStatusPayload(metrics, config, DATE);
  assert.deepStrictEqual(payload, {
    d: '20260811',
    t: '12:30',
    v1: 12345,
    c1: 1,
    v2: 1235,
    v3: 5500,
    v4: 300,
    v5: 42.5,
    v6: 24.6
  });
});

// T3: mixed envelope + flat legacy metrics coexist through the same accessor.
// Issue #117: with NO unit flag the energy fields now default to kWh and are
// converted ×1000 (pre-#117 this asserted 12 / 151 — the 1000× bug).
test('T3 mixed: envelope and flat metrics both map correctly (default kWh ×1000)', () => {
  const config = fullConfig();
  const metrics = {
    energy_kwh: 12.345,                 // flat legacy number -> v1 = round(12.345*1000) = 12345
    power_w: envelope('900.1', 'number', 'W'), // envelope string -> v2 = 900
    consume_kwh: envelope('150.7', 'number', 'kWh'), // envelope -> v3 = round(150.7*1000) = 150700
    consume_w: 45,                      // flat -> v4 = 45
    temp_c: envelope(22.1),             // envelope numeric -> v5 = 22.1
    voltage_v: '23.9'                   // flat string -> v6 = 23.9
  };
  const payload = buildStatusPayload(metrics, config, DATE);
  assert.strictEqual(payload.v1, 12345);
  assert.strictEqual(payload.v2, 900);
  assert.strictEqual(payload.v3, 150700);
  assert.strictEqual(payload.v4, 45);
  assert.strictEqual(payload.v5, 22.1);
  assert.strictEqual(payload.v6, 23.9);
});

// T4: null/undefined/'N/A' envelope values -> keys omitted, no null in output.
test('T4 envelope: null/undefined/"N/A" values -> keys omitted, no null serialized', () => {
  const metrics = {
    energy_kwh: envelope(null),
    power_w: envelope(undefined),
    consume_kwh: envelope('N/A', 'text'),
    consume_w: envelope(null),
    temp_c: envelope('N/A', 'text'),
    voltage_v: envelope(null)
  };
  const payload = buildStatusPayload(metrics, fullConfig(), DATE);
  for (const key of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
    assert.ok(!(key in payload), `${key} should be omitted for non-numeric envelope value`);
  }
  assert.ok(!('c1' in payload), 'c1 should not be set without a finite v1');
  assert.ok(!JSON.stringify(payload).includes('null'), 'payload JSON must not contain null');
});

// T5: zero power envelope -> v2 === 0 (not null), validatePayload still flags it.
test('T5 envelope: zero power -> v2 === 0; all-falsy guard still errors', () => {
  const config = fullConfig({ metric_map: { v2: 'power_w' } });
  const payload = buildStatusPayload({ power_w: envelope(0, 'number', 'W') }, config, DATE);
  assert.strictEqual(payload.v2, 0);
  assert.strictEqual(typeof payload.v2, 'number');
  const errors = validatePayload(payload, null);
  assert.ok(errors.includes('No energy or power values to upload'), 'zero v2 must still trip all-falsy guard');
});

// T6: battery envelope unwraps for b1 and soc -> discharging state 1.
test('T6 envelope: battery b1/soc unwrap -> b1 -800, b2 1 (discharging)', () => {
  const config = fullConfig({
    battery_enabled: true,
    metric_map: { b1: 'batt_w', soc_metric: 'soc' }
  });
  const payload = buildStatusPayload(
    { batt_w: envelope(-800, 'number', 'W'), soc: envelope(42, 'number', '%') },
    config,
    DATE
  );
  assert.strictEqual(payload.b1, -800);
  assert.strictEqual(payload.b2, 1);
});

test('T6b deriveBatteryState: envelope + boundary states', () => {
  const map = { b1: 'batt_w', soc_metric: 'soc' };
  const cases = [
    [{ soc: envelope(96) }, 3],   // >= 95 Full
    [{ soc: envelope(95) }, 3],   // boundary full
    [{ soc: envelope(94) }, 0],   // just under full, no power -> idle
    [{ soc: envelope(6) }, 0],    // mid range, no power -> idle
    [{ soc: envelope(5) }, 4],    // <= 5 Flat
    [{ soc: envelope(0) }, 4],    // boundary flat
    [{ soc: envelope(42), batt_w: envelope(-800) }, 1],  // discharging
    [{ soc: envelope(42), batt_w: envelope(800) }, 2],   // charging
    [{ soc: envelope(42), batt_w: envelope(10) }, 0],    // not > 10 -> idle
    [{ soc: envelope(42), batt_w: envelope(-10) }, 0],   // not < -10 -> idle
    [{ soc: envelope(42), batt_w: envelope(11) }, 2],    // boundary charging
    [{ soc: envelope(42), batt_w: envelope(-11) }, 1],   // boundary discharging
    [{ soc: 96 }, 3],             // legacy flat still works
    [{}, 0]                       // nothing present -> idle
  ];
  for (const [metrics, expected] of cases) {
    assert.strictEqual(deriveBatteryState(metrics, map), expected,
      `deriveBatteryState(${JSON.stringify(metrics)}) should be ${expected}`);
  }
});

// T7: donation v7..v12 envelope values round; bad values omitted.
test('T7 envelope: donation v7..v12 numeric round, bad omitted', () => {
  const config = fullConfig({
    donation_mode: true,
    metric_map: {
      v7: 'don1', v8: 'don2', v9: 'don3', v10: 'don4', v11: 'don5', v12: 'don6'
    }
  });
  const metrics = {
    don1: envelope('1.111', 'number', 'W'),  // v7 = 1.11
    don2: envelope('2.222', 'number', 'W'),  // v8 = 2.22
    don3: envelope('3.333', 'number', 'W'),  // v9 = 3.33
    don4: envelope('4.444', 'number', 'W'),  // v10 = 4.44
    don5: envelope('5.556', 'number', 'W'),  // v11 = 5.56
    don6: envelope('bad', 'text')            // v12 omitted
  };
  const payload = buildStatusPayload(metrics, config, DATE);
  assert.strictEqual(payload.v7, 1.11);
  assert.strictEqual(payload.v8, 2.22);
  assert.strictEqual(payload.v9, 3.33);
  assert.strictEqual(payload.v10, 4.44);
  assert.strictEqual(payload.v11, 5.56);
  assert.ok(!('v12' in payload), 'v12 should be omitted for envelope value "bad"');
});

/**
 * Issue #117 — PVOutput energy units (kWh vs Wh, 1000× understatement).
 *
 * Epilykos energy metrics are kWh; PVOutput addstatus wants Wh. The mapper
 * converts ×1000 unless the mapping is EXPLICITLY Wh (D2). Scenarios M-1..M-10
 * from the issue spec.
 */

// M-1: no unit keys at all (a config saved before #117) -> default kWh, ×1000.
test('M-1 no unit keys -> default kWh, ×1000 (pre-#117 config repaired)', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v3: 'consume_kwh' }
  });
  const payload = buildStatusPayload({ energy_kwh: 5.9, consume_kwh: 39.5 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
  assert.strictEqual(payload.v3, 39500);
  assert.strictEqual(typeof payload.v1, 'number');
  assert.ok(Number.isFinite(payload.v1), 'converted v1 must stay a finite number (AC-9)');
});

// M-2: explicit string unit kWh -> ×1000.
test('M-2 v1_unit/v3_unit = "kWh" -> ×1000', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v3: 'consume_kwh', v1_unit: 'kWh', v3_unit: 'kWh' }
  });
  const payload = buildStatusPayload({ energy_kwh: 5.9, consume_kwh: 39.5 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
  assert.strictEqual(payload.v3, 39500);
});

// M-3: explicit string unit Wh -> no conversion.
test('M-3 v1_unit/v3_unit = "Wh" -> passed through unscaled', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v3: 'consume_kwh', v1_unit: 'Wh', v3_unit: 'Wh' }
  });
  const payload = buildStatusPayload({ energy_kwh: 5900, consume_kwh: 39500 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
  assert.strictEqual(payload.v3, 39500);
});

// M-4: legacy explicit false -> "already Wh", no conversion (D8).
test('M-4 legacy v1_is_kwh/v3_is_kwh = false -> Wh, no conversion', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v3: 'consume_kwh', v1_is_kwh: false, v3_is_kwh: false }
  });
  const payload = buildStatusPayload({ energy_kwh: 5900, consume_kwh: 39500 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
  assert.strictEqual(payload.v3, 39500);
});

// M-5: legacy explicit true -> kWh, ×1000 (the pre-#117 T1 path).
test('M-5 legacy v1_is_kwh/v3_is_kwh = true -> kWh, ×1000', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v3: 'consume_kwh', v1_is_kwh: true, v3_is_kwh: true }
  });
  const payload = buildStatusPayload({ energy_kwh: 12.345, consume_kwh: 5.5 }, config, DATE);
  assert.strictEqual(payload.v1, 12345);
  assert.strictEqual(payload.v3, 5500);
});

// M-6: the string unit outranks the legacy boolean (Wh wins over is_kwh:true).
test('M-6 v1_unit="Wh" beats legacy v1_is_kwh=true -> no conversion', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v1_unit: 'Wh', v1_is_kwh: true }
  });
  const payload = buildStatusPayload({ energy_kwh: 5900 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
});

// M-7: ...and kWh wins over legacy is_kwh:false.
test('M-7 v1_unit="kWh" beats legacy v1_is_kwh=false -> ×1000', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v1_unit: 'kWh', v1_is_kwh: false }
  });
  const payload = buildStatusPayload({ energy_kwh: 5.9 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
});

// M-8: a serialized string "false" must NOT be read as an explicit Wh flag.
test('M-8 v1_is_kwh="false" (string) is not truthy-read -> default kWh, ×1000', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v1_is_kwh: 'false' }
  });
  const payload = buildStatusPayload({ energy_kwh: 5.9 }, config, DATE);
  assert.strictEqual(payload.v1, 5900);
});

// M-9: no metric_map at all -> nothing mapped, no v1 key, no crash.
test('M-9 no metric_map at all -> v1 omitted', () => {
  const config = { timezone: 'UTC', net_mode: false, battery_enabled: false, donation_mode: false };
  const payload = buildStatusPayload({ energy_kwh: 5.9 }, config, DATE);
  assert.ok(!('v1' in payload), 'v1 must be absent when unmapped');
});

// M-10: Wh unit with a non-numeric envelope value -> key omitted, no null.
test('M-10 v1_unit="Wh" with null / "N/A" values -> v1 omitted', () => {
  const config = fullConfig({
    metric_map: { v1: 'energy_kwh', v3: 'consume_kwh', v1_unit: 'Wh', v3_unit: 'Wh' }
  });
  const payload = buildStatusPayload({ energy_kwh: envelope(null), consume_kwh: envelope('N/A', 'text') }, config, DATE);
  assert.ok(!('v1' in payload), 'v1 must be omitted for null');
  assert.ok(!('v3' in payload), 'v3 must be omitted for "N/A"');
  assert.ok(!JSON.stringify(payload).includes('null'), 'payload JSON must not contain null');
});

// Precedence is defined once, in public/js/pvoutput-units.js — assert the
// resolver directly so the order is pinned independently of buildStatusPayload.
test('resolveEnergyUnit precedence: unit string > legacy boolean > kWh default', () => {
  const cases = [
    [{ v1_unit: 'Wh', v1_is_kwh: true }, 'Wh'],     // rule 1
    [{ v1_unit: 'kWh', v1_is_kwh: false }, 'kWh'],  // rule 2
    [{ v1_is_kwh: false }, 'Wh'],                   // rule 3
    [{ v1_is_kwh: true }, 'kWh'],                   // rule 4
    [{}, 'kWh'],                                    // rule 4 (missing)
    [undefined, 'kWh'],                             // rule 4 (no map)
    [{ v1_is_kwh: 'false' }, 'kWh'],                // rule 4 (string, strict ===)
    [{ v1_unit: 'wh' }, 'Wh'],                      // case-insensitive normalisation
    [{ v1_unit: 'Wh' }, 'Wh']
  ];
  for (const [map, expected] of cases) {
    assert.strictEqual(resolveEnergyUnit(map, 'v1'), expected,
      `resolveEnergyUnit(${JSON.stringify(map)}) should be ${expected}`);
  }
  // v3 resolves independently of v1.
  assert.strictEqual(resolveEnergyUnit({ v1_unit: 'Wh', v3_unit: 'kWh' }, 'v3'), 'kWh');
});

/**
 * Issue #119 — PVOutput daily ceiling (AC-10) + no-regression (AC-11).
 *
 * NOTE on the ceiling arithmetic: AC-10 defines
 *   ceiling_kWh = system_size_w / 1000 * maxSunHours * safetyFactor
 * which for system_size_w = 2900, maxSunHours = 6, safetyFactor = 1.5 yields
 * **26.1 kWh (26100 Wh)**, not the 27.0 kWh the AC text states; the spec's
 * 27000/27001 boundary is only exact for a 3000 W system. The formula is
 * implemented verbatim; both boundary sets are asserted below.
 */

test('#119 TS-13: v1 39100Wh on a 2900W system -> ceiling error', () => {
  const errors = validatePayload({ v1: 39100, c1: 1 }, 2900);
  assert.ok(
    errors.some(e => e.includes('v1') && e.includes('39100') && e.includes('ceiling')),
    `expected a v1 ceiling error naming field+value+ceiling, got ${JSON.stringify(errors)}`
  );
});

test('#119 TS-13 end-to-end: a 39.1 kWh metric maps to v1 39100Wh -> error', () => {
  const config = {
    timezone: 'UTC', net_mode: false, donation_mode: false, battery_enabled: false,
    c1_mode: 1,
    metric_map: { v1: 'daily_solar', v1_is_kwh: true }
  };
  const payload = buildStatusPayload({ daily_solar: 39.1 }, config, DATE);
  assert.strictEqual(payload.v1, 39100);
  assert.ok(validatePayload(payload, 2900).some(e => e.includes('ceiling')));
});

test('#119 TS-14: ceiling boundaries are unit-correct (Wh vs kWh)', () => {
  // formula-exact boundary for 2900 W: 2.9 * 6 * 1.5 = 26.1 kWh = 26100 Wh
  assert.deepStrictEqual(validatePayload({ v1: 3000, c1: 1 }, 2900), [], 'small per-slot value passes');
  assert.deepStrictEqual(validatePayload({ v1: 26000, c1: 1 }, 2900), [], 'below ceiling passes');
  assert.deepStrictEqual(validatePayload({ v1: 26100, c1: 1 }, 2900), [], 'AT ceiling passes');
  assert.ok(validatePayload({ v1: 26101, c1: 1 }, 2900).some(e => e.includes('ceiling')), 'above ceiling fails');

  // spec TS-14 literal boundary: 3.0 kW * 6 * 1.5 = 27.0 kWh = 27000 Wh
  assert.deepStrictEqual(validatePayload({ v1: 27000, c1: 1 }, 3000), [], '27000 Wh at ceiling passes');
  assert.ok(validatePayload({ v1: 27001, c1: 1 }, 3000).some(e => e.includes('ceiling')), '27001 Wh above ceiling fails');
});

test('#119 TS-14: no system size and no override -> ceiling skipped (non-regression)', () => {
  assert.deepStrictEqual(validatePayload({ v1: 39100, c1: 1 }, null), []);
  assert.deepStrictEqual(validatePayload({ v1: 39100, c1: 1 }, 0), []);
});

test('#119 AC-10: v3 consumption ceiling + config overrides', () => {
  assert.ok(validatePayload({ v3: 39100 }, 2900).some(e => e.includes('v3') && e.includes('ceiling')));
  // pvoutput.max_daily_kwh / max_daily_consumption_kwh overrides
  assert.deepStrictEqual(validatePayload({ v1: 39100, c1: 1 }, 2900, { maxDailyKwh: 50 }), []);
  assert.deepStrictEqual(validatePayload({ v3: 39100 }, 2900, { maxDailyConsumptionKwh: 50 }), []);
  // safetyFactor / maxSunHours derivation override
  assert.deepStrictEqual(validatePayload({ v1: 30000, c1: 1 }, 2900, { safetyFactor: 2, maxSunHours: 6 }), []);
  assert.ok(validatePayload({ v1: 50000, c1: 1 }, 2900, { safetyFactor: 2, maxSunHours: 6 }).some(e => e.includes('ceiling')));
});

test('#119 TS-15 / AC-11: no regression vs last accepted same-day value', () => {
  // v1 = 5000 after a same-day 6000 was already accepted -> regression error
  const errors = validatePayload({ v1: 5000, c1: 1 }, 2900, { minV1Wh: 6000 });
  assert.ok(errors.some(e => e.includes('regression') && e.includes('5000')), `got ${JSON.stringify(errors)}`);
  // equal / above are fine
  assert.deepStrictEqual(validatePayload({ v1: 6000, c1: 1 }, 2900, { minV1Wh: 6000 }), []);
  assert.deepStrictEqual(validatePayload({ v1: 7000, c1: 1 }, 2900, { minV1Wh: 6000 }), []);
  // v3 consumption regression
  assert.ok(validatePayload({ v3: 4000 }, 2900, { minV3Wh: 5000 }).some(e => e.includes('regression')));
});

test('#119 AC-11/AC-12: validatePayload(payload, systemSizeW) signature stays valid', () => {
  assert.deepStrictEqual(validatePayload({ v1: 5000, c1: 1 }, 2900), []);
  assert.deepStrictEqual(validatePayload({ v2: 0 }, null), ['No energy or power values to upload']);
});

test('#119 TS-16: EOD addoutput payload (g/c) gets the same ceiling + regression rules', () => {
  // g above the 2900 W ceiling -> error; no POST upstream
  assert.ok(validatePayload({ d: '20260910', g: 39100, pp: 2500 }, 2900).some(e => e.includes('g') && e.includes('ceiling')));
  // g regressed vs the day's accepted value
  assert.ok(validatePayload({ d: '20260910', g: 5000, pp: 2500 }, 2900, { minV1Wh: 6000 }).some(e => e.includes('regression')));
  // c consumption ceiling
  assert.ok(validatePayload({ d: '20260910', g: 12000, c: 39100 }, 2900).some(e => e.includes('c') && e.includes('ceiling')));
  // a plausible EOD payload passes
  assert.deepStrictEqual(validatePayload({ d: '20260910', g: 12000, c: 9000, pp: 2500 }, 2900), []);
  // no size and no override -> ceiling skipped
  assert.deepStrictEqual(validatePayload({ d: '20260910', g: 39100 }, null), []);
});

/**
 * Issue #119 AC-10 [v2/N3] — TS-28: the EOD/status upload paths must tolerate an
 * explicit `null` config. A default parameter (`config = {}`) only covers
 * `undefined`; before the fix `uploadEod(db, client, null)` threw
 * "Cannot read properties of null (reading 'system_size_w')" inside the try,
 * was swallowed as `EOD upload failed` (after `attempts` was already
 * incremented), and `uploadStatus(…, null, …)` additionally fell through to
 * `queueForBackfill` with a bogus payload — writing a spurious queue row.
 */
const { uploadEod, uploadStatus, guardOpts } = require('../modules/pvoutput/push');
const rl = require('../modules/pvoutput/rateLimiter');
const msSanity = require('../modules/metricSanity');

/** db stub: history returns EOD stats; queue inserts are counted. */
function eodDb(stats) {
  const state = { queueInserts: 0 };
  return {
    state,
    prepare(sql) {
      return {
        get() {
          if (sql.includes('FROM history') && sql.includes('MAX(')) return stats;
          if (sql.includes('FROM history')) return { timestamp: 1757500000 };
          return undefined;
        },
        run() {
          if (sql.includes('INSERT INTO pvoutput_upload_queue')) state.queueInserts++;
          return { changes: 1 };
        }
      };
    }
  };
}

test('#119 TS-28: uploadEod(db, client, null) does not throw, warns nothing, queues nothing', async () => {
  rl._test.reset();
  const warns = [];
  const origWarn = logger.warn;
  logger.warn = (m) => { warns.push(String(m)); };
  try {
    const db = eodDb({ daily_solar: 12.5, peak_watts: 2500, daily_con: 9.0 });
    const client = { posts: 0, async post() { this.posts++; return 'OK 200: Added'; } };
    await uploadEod(db, client, null);
    assert.strictEqual(client.posts, 1, 'EOD tick proceeds to validate + POST on its own merits');
    assert.strictEqual(db.state.queueInserts, 0, 'a null config must not cause a bogus queue row');
    assert.ok(!warns.some(m => m.includes('EOD upload failed')), `no EOD-failure warn, got ${JSON.stringify(warns)}`);
    // empty history still skips cleanly (debug), never throws
    const db2 = eodDb({ daily_solar: null, peak_watts: null, daily_con: null });
    const client2 = { posts: 0, async post() { this.posts++; return 'OK'; } };
    await uploadEod(db2, client2, null);
    assert.strictEqual(client2.posts, 0);
    assert.strictEqual(db2.state.queueInserts, 0);
  } finally {
    logger.warn = origWarn;
  }
});

test('#119 TS-28: uploadStatus(db, client, null, fn) does not throw or enqueue a bogus row', async () => {
  rl._test.reset();
  const warns = [];
  const origWarn = logger.warn;
  logger.warn = (m) => { warns.push(String(m)); };
  try {
    const db = eodDb({ daily_solar: 12.5, peak_watts: 2500, daily_con: 9.0 });
    const client = { posts: 0, async post() { this.posts++; return 'OK 200: Added'; } };
    // null config -> normalised to {}; no metric_map -> the payload validates to
    // "No energy or power values to upload" and skips on its own merits.
    await uploadStatus(db, client, null, () => ({ daily_solar: 5 }));
    assert.strictEqual(db.state.queueInserts, 0, 'null config must not fall through to queueForBackfill');
    assert.ok(!warns.some(m => m.includes('upload failed')), `no upload-failure warn, got ${JSON.stringify(warns)}`);
    assert.ok(warns.some(m => m.includes('skipping upload')), 'skip is explained by the validator, not a null-deref');
  } finally {
    logger.warn = origWarn;
  }
});

/**
 * Issue #119 AC-11 + #117 — unit-source alignment (QA regression).
 *
 * The no-regression guard and buildStatusPayload must resolve the energy unit
 * through the SAME #117 per-field selector. Before the fix `guardOpts`
 * converted the guard's stored lastAccepted with the metric catalogue unit
 * (`metricSanity.toWh`) while the payload used `resolveEnergyUnit(map,'v1')`:
 * catalogue kWh + `v1_unit:'Wh'` compared a 13 Wh payload against a 12500 Wh
 * floor and skipped EVERY tick — a silent, total upload outage.
 */

/** Seed the shared guard's same-day lastAccepted for `name` at its NATIVE value. */
function seedSameDayAccepted(name, nativeValue) {
  msSanity._reset();
  const ts = Math.floor(Date.now() / 1000);
  const r = msSanity.check(name, nativeValue, ts);
  assert.ok(r.accepted, `seed ${name}=${nativeValue} must be accepted (got ${r.reason})`);
  return ts;
}

test('#119 AC-11/#117: v1_unit:"Wh" + a same-day accepted value uploads (no false regression)', async () => {
  rl._test.reset();
  const name = 'PV Energy Generated';
  seedSameDayAccepted(name, 12.5); // native 12.5; selector Wh -> payload 13, floor 13
  const config = {
    timezone: 'UTC', net_mode: false, donation_mode: false, battery_enabled: false,
    c1_mode: 1, system_size_w: 2900,
    metric_map: { v1: name, v1_unit: 'Wh' }
  };

  // Aligned by construction: the guard floor is the payload's own scale.
  const now = new Date();
  const payload = buildStatusPayload({ [name]: 12.5 }, config, now);
  assert.strictEqual(payload.v1, 13);
  assert.strictEqual(guardOpts(config, now).minV1Wh, 13, 'minV1Wh shares the payload scale (was 12500)');

  const db = eodDb({});
  const client = { posts: 0, async post() { this.posts++; return 'OK 200: Added'; } };
  const warns = []; const origWarn = logger.warn;
  logger.warn = (m) => { warns.push(String(m)); };
  try {
    await uploadStatus(db, client, config, () => ({ [name]: 12.5 }));
  } finally {
    logger.warn = origWarn;
    msSanity._reset();
  }
  assert.strictEqual(client.posts, 1, 'selector Wh must not be skipped as a regression');
  assert.ok(!warns.some(m => m.includes('regression')), `no false regression warn, got ${JSON.stringify(warns)}`);
  assert.strictEqual(db.state.queueInserts, 0);
});

test('#119 AC-11/#117: a genuine same-day regression still skips under v1_unit:"Wh"', async () => {
  rl._test.reset();
  const name = 'PV Energy Generated';
  seedSameDayAccepted(name, 50); // accepted 50; selector Wh -> floor 50; incoming 12.5 -> payload 13
  const config = {
    timezone: 'UTC', net_mode: false, donation_mode: false, battery_enabled: false,
    c1_mode: 1, system_size_w: 2900,
    metric_map: { v1: name, v1_unit: 'Wh' }
  };

  const db = eodDb({});
  const client = { posts: 0, async post() { this.posts++; return 'OK 200: Added'; } };
  const warns = []; const origWarn = logger.warn;
  logger.warn = (m) => { warns.push(String(m)); };
  try {
    await uploadStatus(db, client, config, () => ({ [name]: 12.5 }));
  } finally {
    logger.warn = origWarn;
    msSanity._reset();
  }
  assert.strictEqual(client.posts, 0, 'a real regression must still be skipped');
  assert.ok(warns.some(m => m.includes('regression')), `regression warn expected, got ${JSON.stringify(warns)}`);
});
