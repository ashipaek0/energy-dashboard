'use strict';

/**
 * Tests for the PVOutput metric mapper (issue #76 — .toFixed crash on
 * non-numeric metric values).
 *
 * Run: /usr/bin/node --test tests/mapper.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildStatusPayload, validatePayload, deriveBatteryState } = require('../modules/pvoutput/mapper');

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

test('all-numeric control payload matches pre-fix shape', () => {
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
    energy_kwh: 12.345,  // v1 = 12 (Math.round)
    power_w: 1234.5,     // v2 = 1235 (Math.round)
    consume_kwh: 5.5,    // v3 = 6 (Math.round)
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
    v1: 12,
    c1: 1,
    v2: 1235,
    v3: 6,
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
test('T3 mixed: envelope and flat metrics both map correctly', () => {
  const config = fullConfig();
  const metrics = {
    energy_kwh: 12.345,                 // flat legacy number -> v1 = 12
    power_w: envelope('900.1', 'number', 'W'), // envelope string -> v2 = 900
    consume_kwh: envelope('150.7', 'number', 'kWh'), // envelope -> v3 = 151
    consume_w: 45,                      // flat -> v4 = 45
    temp_c: envelope(22.1),             // envelope numeric -> v5 = 22.1
    voltage_v: '23.9'                   // flat string -> v6 = 23.9
  };
  const payload = buildStatusPayload(metrics, config, DATE);
  assert.strictEqual(payload.v1, 12);
  assert.strictEqual(payload.v2, 900);
  assert.strictEqual(payload.v3, 151);
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
