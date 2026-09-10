#!/usr/bin/env node
/**
 * test/metric-sanity.test.js — issue #119 metric sanity guard (source-agnostic).
 *
 * Covers the §4 scenarios: accept, reject+hold, recovery via recoveryBaseline,
 * day rollover (Africa/Lagos), first-seen (within and above the absolute cap),
 * the outage gap rule, allow/deny overrides, classification (incl. the `Total`
 * exclusions), reject-log rate limiting, fail-open, and persistence/restart.
 *
 * [v2 additions] TS-19..TS-27:
 *   TS-19/20/21 normative AC-1 P1–P9 classification off the REAL production
 *   unit source — the `user_metrics` CONFIG catalogue (seeded by
 *   initializeDatabase() at modules/database.js). `latest_metrics.unit` is NULL
 *   for every row in production, so the guard MUST NOT read it.
 *   TS-23..TS-25 the N1 `lastSeenTs` gap fix; TS-26 its persistence;
 *   TS-27 the N2 `EPS` boundary; TS-22 mandatory unit scaling.
 *
 * Isolation: modules/database.js DB_PATH is CWD-relative ('./data/energy.db'),
 * so this fixture chdirs into a fresh mkdtemp scratch cwd before requiring
 * modules — it never touches the repo's real DB (same trick as
 * metrics-manager-delete.test.js).
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-metric-sanity-'));
process.chdir(tmp);

const { initializeDatabase, setConfig, getConfig } = require('../modules/database');
initializeDatabase();

// role_metrics: PV Energy Generated is the daily_solar counter; Load Energy
// Consumed the daily_consumption counter. NOTE [v2]: the Load alias is NO
// LONGER required for `Load Energy Consumed` to be guarded — AC-1 P7 guards it
// from the catalogue unit alone (that is exactly the v1 defect TS-20 pins).
setConfig('role_metrics', JSON.stringify({
  daily_solar: 'PV Energy Generated',
  daily_consumption: 'Load Energy Consumed',
  daily_grid_import: 'Grid Energy Import',
  daily_grid_export: 'Grid Energy Export'
}));

const ms = require('../modules/metricSanity');
const { logger } = require('../modules/logger');
ms.reloadConfig();

/** Local (Africa/Lagos = UTC+1, no DST) wall-clock → epoch seconds. */
function lagos(y, mo, d, h, mi, s) {
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - 3600;
}

/** Replace role_metrics and refresh the guard's per-poll-cycle snapshot. */
function setRoles(obj) {
  setConfig('role_metrics', JSON.stringify(obj));
  ms.reloadConfig();
}

/** The six production incident metric names (all `unit: 'kWh'`). */
const INCIDENT = [
  'PV Energy Generated', 'Load Energy Consumed', 'Grid Energy Import',
  'Grid Energy Export', 'Battery Energy (Charge)', 'Battery Energy (Discharge)'
];

// ── TS-9: classification (AC-1) ──────────────────────────────────────────
{
  const guarded = [
    ['Load Energy Today', 'Today suffix', 'name_today'],
    ['PV1 Energy Today', 'Today suffix', 'name_today'],
    ['PV Energy Generated', 'daily_solar role', 'daily_role']
  ];
  for (const [name, why, reason] of guarded) {
    const c = ms.classify(name);
    assert.strictEqual(c.guarded, true, `${name} should be guarded (${why})`);
    assert.strictEqual(c.reason, reason, `${name} reason should be ${reason}`);
  }
  const unguarded = [
    ['Load Energy Total', 'Energy Total'],
    ['Battery Energy (Capacity)', 'explicit exclusion'],
    ['PV Forecast Energy', 'explicit exclusion'],
    ['PV Power', 'instantaneous'],
    ['Grid Status', 'text/boolean'],
    ['Fridge Energy Total', 'suffix Total']
  ];
  for (const [name, why] of unguarded) {
    assert.strictEqual(ms.classify(name).guarded, false, `${name} should NOT be guarded (${why})`);
  }

  // allowlist wins over the exclusion patterns
  setConfig('metric_sanity_allow', JSON.stringify(['Load Energy Total']));
  ms.reloadConfig();
  assert.strictEqual(ms.classify('Load Energy Total').guarded, true, 'allowlist must win over exclusion');

  // denylist wins over the name heuristics (but not over the allowlist)
  setConfig('metric_sanity_deny', JSON.stringify(['Load Energy Today']));
  ms.reloadConfig();
  assert.strictEqual(ms.classify('Load Energy Today').guarded, false, 'denylist must win over heuristics');
  assert.strictEqual(ms.classify('Load Energy Total').guarded, true, 'allowlist still wins over denylist');
  setConfig('metric_sanity_allow', '');
  setConfig('metric_sanity_deny', '');
  ms.reloadConfig();
  console.log('PASS TS-9: classification + allow/deny overrides');
}

// ── TS-1: normal accept (AC-3c) ──────────────────────────────────────────
{
  ms._reset();
  const t = lagos(2026, 9, 10, 7, 0, 0);
  let r = ms.check('Load Energy Consumed', 3.30, t);
  assert.strictEqual(r.accepted, true, 'first sample accepted');
  assert.strictEqual(r.reason, 'first-seen');
  r = ms.check('Load Energy Consumed', 3.34, t + 30);
  assert.strictEqual(r.accepted, true, 'normal step accepted');
  assert.strictEqual(r.reason, 'accept');
  const st = ms.getState('Load Energy Consumed');
  assert.strictEqual(st.lastAccepted, 3.34);
  assert.strictEqual(st.suspect, false);
  console.log('PASS TS-1: normal accept + state');
}

// ── TS-2/3/4: the real 2026-09-10 curve at the ha.js write choke point ───
{
  ms._reset();
  // Reproduce AC-6's documented curve (1.0 → 39.1 → 39.2 → 2.0 accepted).
  // With the §5 default PV maxStep (0.5) 2.0 > 1.0 + 0.5, so the exact fixture
  // uses the supported per-metric maxStep override (§5 config surface). The
  // default-config recovery boundary is exercised in TS-12.
  setConfig('metric_sanity', JSON.stringify({ 'PV Energy Generated': { maxStep: 1.5, unit: 'kWh' } }));
  ms.reloadConfig();

  const { getDb } = require('../modules/database');
  const ha = require('../modules/ha');
  const db = getDb();
  const M = 'PV Energy Generated';
  const t1 = lagos(2026, 9, 10, 8, 0, 0);

  ha.saveMetric(M, 1.0, t1);
  ha.saveMetric(M, 39.1, t1 + 30); // TS-2: the real spike -> rejected

  let row = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get(M);
  assert.strictEqual(row.value, 1.0, 'held value must stay 1.0');
  assert.strictEqual(row.timestamp, t1, 'held value must keep its ORIGINAL timestamp (AC-4)');
  let cnt = db.prepare('SELECT COUNT(*) c FROM metrics WHERE metric = ?').get(M).c;
  assert.strictEqual(cnt, 1, 'rejected sample must not be written to metrics');

  // TS-3: hold across siblings — suspectSince captured once, baseline 1.0
  ha.saveMetric(M, 39.2, t1 + 60);
  ha.saveMetric(M, 39.3, t1 + 90);
  row = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get(M);
  assert.strictEqual(row.value, 1.0, 'still held at 1.0');
  assert.strictEqual(row.timestamp, t1, 'timestamp still original');
  cnt = db.prepare('SELECT COUNT(*) c FROM metrics WHERE metric = ?').get(M).c;
  assert.strictEqual(cnt, 1, 'no sibling spike written either');
  let st = ms.getState(M);
  assert.strictEqual(st.suspect, true);
  assert.strictEqual(st.suspectSince, t1 + 30, 'suspectSince set once on first rejection');
  assert.strictEqual(st.recoveryBaseline, 1.0, 'recoveryBaseline = pre-spike lastAccepted');

  // TS-4: recovery 2.0 accepted, clears suspect, both tables written
  ha.saveMetric(M, 2.0, t1 + 120);
  row = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get(M);
  assert.strictEqual(row.value, 2.0, 'recovering value written');
  assert.strictEqual(row.timestamp, t1 + 120);
  cnt = db.prepare('SELECT COUNT(*) c FROM metrics WHERE metric = ?').get(M).c;
  assert.strictEqual(cnt, 2, 'recovery written to metrics too');
  st = ms.getState(M);
  assert.strictEqual(st.suspect, false, 'suspect cleared on recovery');
  assert.strictEqual(st.lastAccepted, 2.0);

  setConfig('metric_sanity', '');
  ms.reloadConfig();
  console.log('PASS TS-2/3/4: reject + hold + recovery (AC-6 regression curve)');
}

// ── TS-5: midnight reset (AC-7) ──────────────────────────────────────────
{
  ms._reset();
  const M = 'Load Energy Today';
  const tDay1 = lagos(2026, 9, 10, 23, 58, 0);
  const tDay2 = lagos(2026, 9, 11, 0, 1, 0);
  ms.check(M, 6.0, tDay1);
  let r = ms.check(M, 39.0, tDay1 + 30); // rejected -> suspect
  assert.strictEqual(r.accepted, false, 'spike rejected at 23:58');
  r = ms.check(M, 0.05, tDay2); // new day -> accepted even though it is a drop
  assert.strictEqual(r.accepted, true, 'overnight drop accepted on day rollover');
  assert.strictEqual(r.reason, 'day-rollover');
  const st = ms.getState(M);
  assert.strictEqual(st.day, '2026-09-11', 'day rewritten');
  assert.strictEqual(st.lastAccepted, 0.05);
  assert.strictEqual(st.suspect, false, 'pending rejection must not leak into the new day');
  console.log('PASS TS-5: midnight reset clears suspect');
}

// ── TS-6: first-seen (AC-3b) ─────────────────────────────────────────────
{
  ms._reset();
  const t = lagos(2026, 9, 10, 6, 0, 0);
  let r = ms.check('Grid Energy Import', 3.4, t);
  assert.strictEqual(r.accepted, true, 'first-seen within cap accepted');
  assert.strictEqual(r.reason, 'first-seen');
  assert.strictEqual(ms.getState('Grid Energy Import').suspect, false, 'never suspect on plain first-seen');

  ms._reset();
  r = ms.check('Grid Energy Export', 500, t); // above absolute cap (100 kWh)
  assert.strictEqual(r.accepted, false, 'first-seen above cap rejected');
  assert.strictEqual(r.reason, 'absolute-cap');
  assert.strictEqual(ms.getState('Grid Energy Export').suspect, true, 'above-cap first-seen marked suspect');
  console.log('PASS TS-6: first-seen within/above absolute cap');
}

// ── TS-7: gap resume (AC-3c) ─────────────────────────────────────────────
{
  ms._reset();
  const M = 'PV1 Energy Today';
  const a = lagos(2026, 9, 10, 10, 0, 0);
  const b = lagos(2026, 9, 10, 12, 30, 0); // 9000 s > 300 s gap
  ms.check(M, 5.0, a);
  const r = ms.check(M, 4.0, b); // a decrease, but across an outage
  assert.strictEqual(r.accepted, true, 'gap sample accepted');
  assert.strictEqual(r.reason, 'gap');
  const st = ms.getState(M);
  assert.strictEqual(st.lastAccepted, 4.0, 're-baselined to the post-gap value');
  assert.strictEqual(st.suspect, false);
  console.log('PASS TS-7: gap rule accepts + re-baselines');
}

// ── TS-8: per-metric independence (AC-2) ─────────────────────────────────
{
  ms._reset();
  const t = lagos(2026, 9, 10, 9, 0, 0);
  ms.check('PV Energy Generated', 5.0, t);
  ms.check('Grid Import Energy Today', 2.0, t);
  const r1 = ms.check('PV Energy Generated', 39.0, t + 30); // reject
  const r2 = ms.check('Grid Import Energy Today', 2.1, t + 30); // accept
  assert.strictEqual(r1.accepted, false, 'spiking metric held');
  assert.strictEqual(r2.accepted, true, 'normal metric unaffected');
  assert.strictEqual(ms.getState('PV Energy Generated').suspect, true);
  assert.strictEqual(ms.getState('Grid Import Energy Today').suspect, false);
  assert.strictEqual(ms.getState('Grid Import Energy Today').lastAccepted, 2.1);
  console.log('PASS TS-8: metric independence');
}

// ── TS-17: non-counter no-op through ha.js (AC-12b) ──────────────────────
{
  ms._reset();
  const { getDb } = require('../modules/database');
  const ha = require('../modules/ha');
  const db = getDb();
  const t = lagos(2026, 9, 10, 13, 0, 0);

  ha.saveMetric('PV Power', 0, t);
  ha.saveMetric('PV Power', 39000, t + 30); // huge jump — must be written unchanged
  const row = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get('PV Power');
  assert.strictEqual(row.value, 39000, 'non-counter written unchanged even on a big jump');
  assert.strictEqual(row.timestamp, t + 30, 'non-counter timestamp fresh');

  ha.saveMetric('Grid Status', 'on', t + 60); // text branch — byte-identical
  const trow = db.prepare('SELECT value_text, value_type FROM latest_metrics WHERE metric = ?').get('Grid Status');
  assert.strictEqual(trow.value_text, 'on');
  assert.strictEqual(trow.value_type, 'boolean');

  assert.strictEqual(ms.getState('PV Power'), null, 'no guard state created for a power metric');
  assert.strictEqual(ms.getState('Grid Status'), null, 'no guard state created for a text metric');
  console.log('PASS TS-17: non-counter no-op (AC-12b)');
}

// ── TS-10: reject log rate limiting (AC-8) ───────────────────────────────
{
  const origWarn = logger.warn;
  const warns = [];
  logger.warn = (m) => { warns.push(String(m)); };
  ms._reset();
  const M = 'Battery Discharge Energy Today';
  const base = lagos(2026, 9, 10, 9, 30, 0);
  ms.check(M, 1.0, base);
  for (let i = 0; i < 20; i++) ms.check(M, 50 + i * 0.1, base + 30 * (i + 1));
  logger.warn = origWarn;

  const sanityWarns = warns.filter(m => m.includes('[metric_sanity]'));
  assert.strictEqual(sanityWarns.length, 1, `exactly one warn in the window (got ${sanityWarns.length})`);
  assert.ok(sanityWarns[0].includes('50'), 'raw rejected value retained in the log');
  assert.ok(sanityWarns[0].includes('lastAccepted=1'), 'lastAccepted retained');
  assert.ok(sanityWarns[0].includes('delta='), 'delta retained');
  console.log('PASS TS-10: one rate-limited warn, raw value + lastAccepted + delta present');
}

// ── TS-11: fail-open on an internal guard error (AC-9) ───────────────────
{
  const origError = logger.error;
  const errs = [];
  logger.error = (m) => { errs.push(String(m)); };
  ms._reset();
  ms._test.forceError = true;
  const r = ms.check('Load Energy Today', 42, lagos(2026, 9, 10, 12, 0, 0));
  ms._test.forceError = false;
  logger.error = origError;
  assert.strictEqual(r.accepted, true, 'fail-open: sample accepted');
  assert.strictEqual(r.reason, 'fail-open');
  assert.ok(errs.some(m => m.includes('[metric_sanity]') && m.includes('fail-open')), 'guard error logged');
  console.log('PASS TS-11: fail-open, error logged');
}

// ── TS-12: persistence / restart mid-episode (D1(ii)) ────────────────────
{
  ms._reset();
  setConfig('metric_sanity', '');
  ms.reloadConfig();
  const M = 'PV Energy Generated';
  const t = lagos(2026, 9, 10, 11, 0, 0);
  ms.check(M, 1.0, t);
  ms.check(M, 39.1, t + 30); // reject -> suspect
  ms.flush();

  const day = ms.getState(M).day;
  delete require.cache[require.resolve('../modules/metricSanity')];
  const ms2 = require('../modules/metricSanity'); // rehydrates at module load

  const st = ms2.getState(M);
  assert.strictEqual(st.lastAccepted, 1.0, 'lastAccepted restored');
  assert.strictEqual(st.suspect, true, 'suspect restored');
  assert.strictEqual(st.recoveryBaseline, 1.0, 'recoveryBaseline restored');
  assert.strictEqual(st.day, day, 'day restored');

  // A restart during a spike must NOT re-baseline onto the corrupt value.
  const r = ms2.check(M, 39.2, t + 60);
  assert.strictEqual(r.accepted, false, 'restart mid-episode still rejects the spike');
  // …and recovery to the pre-jump baseline still works (default PV maxStep 0.5).
  const r2 = ms2.check(M, 1.5, t + 90);
  assert.strictEqual(r2.accepted, true, 'recovery to recoveryBaseline + maxStep accepted');
  assert.strictEqual(r2.reason, 'recovery');
  assert.strictEqual(ms2.getState(M).suspect, false);
  console.log('PASS TS-12: persistence round-trip + restart safety');
}

// ═══════════════════════════════════════════════════════════════════════
// v2 amendment (A/B/C) scenarios — TS-19 … TS-27
// ═══════════════════════════════════════════════════════════════════════

// ── TS-19: normative AC-1 P1–P9 table off the real catalogue ─────────────
{
  ms._reset();
  // Cold start: empty role_metrics EXCEPT the one daily_role row (P6).
  setRoles({ daily_solar: 'Solar Yield' });

  // the real production catalogue is present and the six incident names are kWh
  const catalogue = JSON.parse(getConfig('user_metrics') || '[]');
  assert.ok(Array.isArray(catalogue) && catalogue.length >= 30, 'seeded user_metrics catalogue present');
  for (const n of INCIDENT) {
    const row = catalogue.find(m => m.name === n);
    assert.ok(row, `${n} present in the user_metrics catalogue`);
    assert.strictEqual(row.unit, 'kWh', `${n} declared kWh`);
  }

  const table = [
    // [name, guarded, reason prefix]
    ...INCIDENT.map(n => [n, true, 'energy_unit']),
    ['Battery Energy (Capacity)', false, 'excluded:'],
    ['PV Forecast Energy', false, 'excluded:'],
    ['Battery Charge Power', false, 'not_daily_counter'],
    ['Load Power', false, 'not_daily_counter'],
    ['Grid Power', false, 'not_daily_counter'],
    ['Battery Discharge Power', false, 'not_daily_counter'],
    ['Load Energy Today', true, 'name_today'],
    ['PV1 Energy Today', true, 'name_today'],
    ['Load Energy Total', false, 'excluded:'],
    ['Daily Energy Cost', false, 'excluded:non-energy qualifier'],
    ['Solar Yield', true, 'daily_role'],
    ['Battery SOC', false, 'not_daily_counter'],
    ['Grid Status', false, 'not_daily_counter']
  ];
  for (const [name, guarded, reason] of table) {
    const c = ms.classify(name);
    assert.strictEqual(c.guarded, guarded, `${name} guarded should be ${guarded} (got ${JSON.stringify(c)})`);
    assert.ok(String(c.reason).startsWith(reason),
      `${name} reason should start with "${reason}" (got "${c.reason}")`);
  }
  // exact tokens pinned for the two exclusion rows the spec names explicitly
  assert.strictEqual(ms.classify('Load Energy Total').reason, 'excluded:Energy Total');

  // §5 / AC-1 [E] drift guard: the six incident names resolve to the shipped
  // family thresholds (PV 0.5, everything else 0.6 kWh).
  const steps = INCIDENT.map(n => ms.maxStepFor(n));
  assert.deepStrictEqual(steps, [0.5, 0.6, 0.6, 0.6, 0.6, 0.6],
    `§5 family thresholds drifted: ${JSON.stringify(steps)}`);

  ms._reset();
  console.log('PASS TS-19: normative AC-1 P1–P9 classification table');
}

// ── TS-20: the regression test for the verified v1 defect (A) ────────────
{
  ms._reset();
  setRoles({}); // role_metrics empty/unset — the v1 classifier had nothing to go on

  for (const n of INCIDENT) {
    const c = ms.classify(n);
    assert.strictEqual(c.guarded, true, `${n} must be guarded from cold start`);
    assert.strictEqual(c.reason, 'energy_unit', `${n} must be guarded by P7 off the catalogue unit`);
  }

  // End-to-end at the ha.js write choke point, empty role_metrics.
  const { getDb } = require('../modules/database');
  const ha = require('../modules/ha');
  const db = getDb();
  const M = 'Load Energy Consumed';
  const t = lagos(2026, 9, 10, 14, 0, 0);
  ha.saveMetric(M, 1.0, t);
  ha.saveMetric(M, 39.1, t + 30); // the F2-corrupted-metric spike — must be held

  const row = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get(M);
  assert.strictEqual(row.value, 1.0, 'Load Energy Consumed held at 1.0');
  assert.strictEqual(row.timestamp, t, 'held row keeps the ORIGINAL timestamp (AC-4)');
  const cnt = db.prepare('SELECT COUNT(*) c FROM metrics WHERE metric = ?').get(M).c;
  assert.strictEqual(cnt, 1, 'the spike must not be written to metrics');
  ms._reset();
  console.log('PASS TS-20: v1-defect regression — six incident names guarded without role_metrics');
}

// ── TS-21: precedence + overrides (AC-1 P1–P9) ───────────────────────────
{
  ms._reset();
  setConfig('metric_sanity', JSON.stringify({ 'Daily Energy Cost': { unit: 'NGN' } }));
  setRoles({ daily_solar: 'Solar Yield' });

  // P4 — money-named metric excluded regardless of unit
  assert.strictEqual(ms.classify('Daily Energy Cost').guarded, false);
  assert.strictEqual(ms.classify('Daily Energy Cost').reason, 'excluded:non-energy qualifier');

  // P8 — unknown-unit Energy metric is fail-IN (guarded)
  assert.strictEqual(ms.classify('Generator Energy Produced').guarded, true);
  assert.strictEqual(ms.classify('Generator Energy Produced').reason, 'energy_unknown_unit');

  // P3 before P7 — kWh Energy capacity metric is not a daily counter
  assert.strictEqual(ms.classify('Battery Energy (Capacity)').guarded, false);
  assert.ok(ms.classify('Battery Energy (Capacity)').reason.startsWith('excluded:'));

  // P6 — daily_role
  assert.strictEqual(ms.classify('Solar Yield').reason, 'daily_role');

  // P1 — allowlist overrides the qualifier exclusion
  setConfig('metric_sanity_allow', JSON.stringify(['Daily Energy Cost']));
  ms.reloadConfig();
  assert.strictEqual(ms.classify('Daily Energy Cost').guarded, true);
  assert.strictEqual(ms.classify('Daily Energy Cost').reason, 'allowlist');

  // P2 — denylist beats energy_unit …
  setConfig('metric_sanity_allow', '');
  setConfig('metric_sanity_deny', JSON.stringify(['PV Energy Generated']));
  ms.reloadConfig();
  assert.strictEqual(ms.classify('PV Energy Generated').guarded, false);
  assert.strictEqual(ms.classify('PV Energy Generated').reason, 'denylist');
  // … but not the allowlist
  setConfig('metric_sanity_allow', JSON.stringify(['PV Energy Generated']));
  ms.reloadConfig();
  assert.strictEqual(ms.classify('PV Energy Generated').guarded, true);
  assert.strictEqual(ms.classify('PV Energy Generated').reason, 'allowlist');

  setConfig('metric_sanity_allow', '');
  setConfig('metric_sanity_deny', '');
  setConfig('metric_sanity', '');
  ms._reset();
  console.log('PASS TS-21: precedence + allow/deny overrides');
}

// ── TS-22: mandatory unit scaling (AC-1 note 6 / §5) ─────────────────────
{
  ms._reset();
  const M = 'PV Energy Generated';

  // kWh (catalogue): 0.5 kWh / 100 kWh
  setConfig('metric_sanity', '');
  ms.reloadConfig();
  assert.strictEqual(ms.scaleFactorFor(M), 1, 'kWh scale factor 1');
  assert.strictEqual(ms.maxStepFor(M) * ms.scaleFactorFor(M), 0.5);

  // Wh override: maxStep 500 Wh, absoluteCap 100000 Wh
  setConfig('metric_sanity', JSON.stringify({ [M]: { unit: 'Wh' } }));
  ms.reloadConfig();
  assert.strictEqual(ms.resolveUnit(M), 'Wh');
  assert.strictEqual(ms.scaleFactorFor(M), 1000, 'Wh scale factor 1000');
  assert.strictEqual(ms.maxStepFor(M) * ms.scaleFactorFor(M), 500, 'maxStep scales to 500 Wh');

  ms._reset();
  let r = ms.check(M, 1000, lagos(2026, 9, 10, 6, 0, 0));
  assert.strictEqual(r.accepted, true, 'first-seen 1000 Wh accepted');
  r = ms.check(M, 1400, lagos(2026, 9, 10, 6, 0, 30));
  assert.strictEqual(r.accepted, true, '1000 → 1400 Wh accepted (400 ≤ 500)');

  ms._reset();
  r = ms.check(M, 1000, lagos(2026, 9, 10, 6, 0, 0));
  r = ms.check(M, 1600, lagos(2026, 9, 10, 6, 0, 30));
  assert.strictEqual(r.accepted, false, '1000 → 1600 Wh rejected (600 > 500)');
  assert.strictEqual(r.reason, 'jump');

  ms._reset();
  r = ms.check(M, 100000, lagos(2026, 9, 10, 6, 0, 0));
  assert.strictEqual(r.accepted, true, 'absoluteCap scales to 100000 Wh');
  ms._reset();
  r = ms.check(M, 100001, lagos(2026, 9, 10, 6, 0, 0));
  assert.strictEqual(r.accepted, false, 'above the scaled absoluteCap rejected');
  assert.strictEqual(r.reason, 'absolute-cap');

  // MWh: thresholds unchanged (kWh basis)
  setConfig('metric_sanity', JSON.stringify({ [M]: { unit: 'MWh' } }));
  ms.reloadConfig();
  assert.strictEqual(ms.scaleFactorFor(M), 1, 'MWh scale factor 1 (thresholds unchanged)');
  assert.strictEqual(ms.maxStepFor(M) * ms.scaleFactorFor(M), 0.5);

  setConfig('metric_sanity', '');
  ms._reset();
  console.log('PASS TS-22: unit scaling (Wh ×1000, MWh ×1)');
}

// ── TS-23: N1 regression — sustained corruption is held indefinitely ─────
{
  ms._reset();
  setRoles({});
  const M = 'Grid Energy Import';
  const T = lagos(2026, 9, 10, 15, 0, 0);
  ms.check(M, 1.0, T);
  let sawGap = false;
  for (let i = 1; i <= 20; i++) {
    const r = ms.check(M, 39.2, T + 30 * i);
    assert.strictEqual(r.accepted, false, `sample #${i} (T+${30 * i}s) must stay rejected`);
    assert.strictEqual(r.reason, 'jump', `sample #${i} reason must be jump (got ${r.reason})`);
    if (r.reason === 'gap') sawGap = true;
  }
  assert.strictEqual(sawGap, false, 'no gap re-baseline during a sample-carrying episode (v1 accepted #11)');
  const st = ms.getState(M);
  assert.strictEqual(st.lastAccepted, 1.0, 'lastAccepted still 1.0');
  assert.strictEqual(st.lastSeenTs, T + 600, 'lastSeenTs advanced to the latest sample');
  assert.strictEqual(st.suspect, true, 'suspect stays true');
  console.log('PASS TS-23: N1 — sustained corruption held (no gap bypass)');
}

// ── TS-24: a genuine poll outage still accepts + re-baselines ────────────
{
  ms._reset();
  setRoles({});
  const M = 'Grid Energy Export';
  const T = lagos(2026, 9, 10, 15, 0, 0);
  ms.check(M, 5.0, T);
  const r = ms.check(M, 4.0, T + 400); // no samples in between; a decrease
  assert.strictEqual(r.accepted, true, 'post-outage sample accepted');
  assert.strictEqual(r.reason, 'gap');
  const st = ms.getState(M);
  assert.strictEqual(st.lastAccepted, 4.0, 're-baselined to 4.0');
  assert.strictEqual(st.suspect, false, 'suspect cleared by the gap acceptance');
  console.log('PASS TS-24: real outage gap accepts + re-baselines');
}

// ── TS-25: the gap boundary is strict (`>`, not `>=`) ────────────────────
{
  const M = 'Load Energy Consumed';
  const T = lagos(2026, 9, 10, 15, 0, 0);
  // exactly gapSeconds after the last seen sample -> NOT a gap
  ms._reset();
  setRoles({});
  ms.check(M, 1.0, T);
  let r = ms.check(M, 39.1, T + 300);
  assert.strictEqual(r.reason, 'jump', 'exactly gapSeconds is not a gap');
  // gapSeconds + 1 -> a gap
  ms._reset();
  setRoles({});
  ms.check(M, 1.0, T);
  r = ms.check(M, 39.1, T + 301);
  assert.strictEqual(r.accepted, true, 'gapSeconds + 1 is a gap');
  assert.strictEqual(r.reason, 'gap');
  console.log('PASS TS-25: gap boundary strict (`> gapSeconds`)');
}

// ── TS-26: lastSeenTs survives a restart (AC-2/D1) ──────────────────────
{
  ms._reset();
  setRoles({});
  const M = 'PV Energy Generated';
  const T = lagos(2026, 9, 10, 16, 0, 0);
  ms.check(M, 1.0, T);
  ms.check(M, 39.1, T + 30); // reject
  ms.flush();

  delete require.cache[require.resolve('../modules/metricSanity')];
  const ms2 = require('../modules/metricSanity');
  assert.strictEqual(ms2.getState(M).lastSeenTs, T + 30, 'lastSeenTs restored from the persisted blob');

  // sibling spike 30 s after the last SEEN sample: still a jump, no gap
  const r = ms2.check(M, 39.2, T + 60);
  assert.strictEqual(r.accepted, false, 'restart must not open a gap window');
  assert.strictEqual(r.reason, 'jump');
  assert.strictEqual(ms2.getState(M).lastSeenTs, T + 60, 'lastSeenTs advanced again');

  // legacy blob WITHOUT lastSeenTs -> migrate to lastAcceptedTs. That
  // deliberately preserves v1 semantics for exactly ONE sample: a sample
  // > gapSeconds after the last ACCEPTED ts still takes the gap branch.
  ms._reset();
  const legacy = { day: ms.localDay(T), lastAccepted: 1.0, lastAcceptedTs: T, suspect: false, suspectSince: null, recoveryBaseline: null };
  setConfig('metric_sanity_state', JSON.stringify({ [M]: legacy }));
  delete require.cache[require.resolve('../modules/metricSanity')];
  const ms3 = require('../modules/metricSanity');
  assert.strictEqual(ms3.getState(M).lastSeenTs, T, 'legacy blob migrates lastSeenTs <- lastAcceptedTs');
  const r3 = ms3.check(M, 39.2, T + 600);
  assert.strictEqual(r3.reason, 'gap', 'migrated legacy blob keeps v1 gap semantics for one sample');
  // … then self-corrects: the next sample advances lastSeenTs, so no new gap.
  const r3b = ms3.check(M, 39.3, T + 630);
  assert.strictEqual(r3b.reason, 'accept', 'post-migration sample rides the normal step path');

  // AC-3c NOTE 4 — an explicit null lastSeenTs with a baseline must NOT fire
  // the gap branch (fail closed).
  ms._reset();
  const nullSeen = { day: ms.localDay(T), lastAccepted: 1.0, lastAcceptedTs: T, lastSeenTs: null, suspect: false, suspectSince: null, recoveryBaseline: null };
  setConfig('metric_sanity_state', JSON.stringify({ [M]: nullSeen }));
  delete require.cache[require.resolve('../modules/metricSanity')];
  const ms4 = require('../modules/metricSanity');
  assert.strictEqual(ms4.getState(M).lastSeenTs, null, 'explicit null lastSeenTs preserved on rehydrate');
  const r4 = ms4.check(M, 39.2, T + 600); // > gapSeconds, but no last-seen evidence
  assert.strictEqual(r4.accepted, false, 'null lastSeenTs must not open a gap window');
  assert.strictEqual(r4.reason, 'jump');
  ms._reset();
  console.log('PASS TS-26: lastSeenTs persistence + legacy migration + NOTE 4 fail-closed');
}

// ── TS-27: N2 — epsilon-tolerant step/recovery boundaries ────────────────
{
  const M = 'Grid Energy Import'; // §5 default maxStep 0.6
  const T = lagos(2026, 9, 10, 17, 0, 0);
  setRoles({});

  // exactly maxStep, including the binary-float dust 1.6 - 1.0
  ms._reset();
  ms.check(M, 1.0, T);
  let r = ms.check(M, 1.6, T + 30);
  assert.strictEqual(r.accepted, true, `1.0 → 1.6 tolerated (delta ${1.6 - 1.0})`);

  // a real violation above EPS is rejected
  ms._reset();
  ms.check(M, 1.0, T);
  r = ms.check(M, 1.61, T + 30);
  assert.strictEqual(r.accepted, false, '1.0 → 1.61 rejected');
  assert.strictEqual(r.reason, 'jump');

  ms._reset();
  ms.check(M, 1.0, T);
  r = ms.check(M, 1.6000001, T + 30);
  assert.strictEqual(r.accepted, false, '1.0 → 1.6000001 rejected (above EPS)');

  // recovery boundary recoveryBaseline 1.0 + maxStep 0.6 = 1.6 with dust
  ms._reset();
  ms.check(M, 1.0, T);
  ms.check(M, 39.1, T + 30); // reject -> suspect, baseline 1.0
  r = ms.check(M, 1.6, T + 60);
  assert.strictEqual(r.accepted, true, 'recovery at the exact boundary accepted');
  assert.strictEqual(r.reason, 'recovery');

  // the genuine 39.1 jump is still rejected with EPS in place
  ms._reset();
  ms.check(M, 1.0, T);
  r = ms.check(M, 39.1, T + 30);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'jump');
  ms._reset();
  console.log('PASS TS-27: N2 epsilon boundaries (step + recovery)');
}

// ═══════════════════════════════════════════════════════════════════════
// AC-11 / #117 unit-alignment — the no-regression guard and the payload must
// resolve the energy unit from the SAME source (#117's per-field selector).
//
// QA bug: guardOpts converted the guard's stored lastAccepted with
// metricSanity.toWh() (the METRIC catalogue unit) while buildStatusPayload
// converted with resolveEnergyUnit() (the USER selector). Catalogue kWh +
// `v1_unit:'Wh'` compared the 13 Wh payload against a 12500 Wh floor and
// silently skipped EVERY upload. The fix resolves the selector on both sides.
//
// TS-28..TS-31 cover all four (catalogue, selector) combinations, the
// production default, and that a genuine regression is still caught.
// ═══════════════════════════════════════════════════════════════════════
{
  // The AC-11 tests below must seed the SAME metricSanity instance push.js
  // captures. Earlier blocks (TS-12/TS-26) bust the require cache and re-require
  // it, so the outer `ms` binding is stale — re-require both, in order, so the
  // guard we seed is the guard guardOpts reads.
  delete require.cache[require.resolve('../modules/metricSanity')];
  delete require.cache[require.resolve('../modules/pvoutput/push')];
  const msUnit = require('../modules/metricSanity');
  const { guardOpts } = require('../modules/pvoutput/push');
  const { buildStatusPayload, validatePayload } = require('../modules/pvoutput/mapper');
  const N = 'PV Energy Generated';

  /** Model the metric catalogue's declared unit (the guard's native-unit source). */
  const setCatalogueUnit = (unit) => {
    setConfig('metric_sanity', JSON.stringify({ [N]: { unit } }));
    msUnit.reloadConfig();
  };

  /** Seed the guard's same-day lastAccepted at its NATIVE value; return `now`. */
  const seed = (nativeValue) => {
    msUnit._reset();
    const now = new Date();
    const r = msUnit.check(N, nativeValue, Math.floor(now.getTime() / 1000));
    assert.strictEqual(r.accepted, true, `seed ${nativeValue} must be accepted (got ${r.reason})`);
    return now;
  };

  // TS-28 (a): catalogue kWh + selector Wh — both sides must land on the SAME
  // scale (Wh, no ×1000) and the upload must PROCEED.
  {
    setCatalogueUnit('kWh');
    const now = seed(12.5);
    const config = { timezone: 'UTC', system_size_w: 2900, metric_map: { v1: N, v1_unit: 'Wh', v3: N, v3_unit: 'Wh' } };
    const payload = buildStatusPayload({ [N]: 12.5 }, config, now);
    const opts = guardOpts(config, now);
    assert.strictEqual(payload.v1, 13, 'selector Wh posts 12.5 as-is -> 13 Wh');
    assert.strictEqual(opts.minV1Wh, 13, 'minV1Wh must be on the payload scale (was 12500)');
    assert.strictEqual(opts.minV3Wh, 13, 'v3 resolves through the same selector');
    assert.deepStrictEqual(validatePayload(payload, 2900, opts), [], 'no false regression skip');
    console.log('PASS TS-28 (a): catalogue kWh + selector Wh -> aligned, no false regression skip');
  }

  // TS-29 (b): catalogue Wh + selector absent (mapper default kWh) — aligned on
  // the ×1000 scale, so no spurious rejection. (With a real system size the
  // derived ceiling legitimately catches this 1000x payload; the alignment fix
  // removes the WRONG-reason rejection, so assert with no system size set.)
  {
    setCatalogueUnit('Wh');
    const now = seed(12500);
    const config = { timezone: 'UTC', metric_map: { v1: N } };
    const payload = buildStatusPayload({ [N]: 12500 }, config, now);
    const opts = guardOpts(config, now);
    assert.strictEqual(payload.v1, 12500000, 'default kWh selector: ×1000');
    assert.strictEqual(opts.minV1Wh, 12500000, 'min follows the selector, not the catalogue');
    assert.deepStrictEqual(validatePayload(payload, null, opts), [], 'aligned -> no false rejection');
    console.log('PASS TS-29 (b): catalogue Wh + default kWh -> aligned (both ×1000)');
  }

  // TS-30 (c): production config today (catalogue kWh, selector absent) —
  // INVARIANT: byte-identical to the pre-fix behaviour (value ×1000, 12500/12500).
  {
    setCatalogueUnit('kWh');
    const now = seed(12.5);
    const config = { timezone: 'UTC', system_size_w: 2900, metric_map: { v1: N } };
    const payload = buildStatusPayload({ [N]: 12.5 }, config, now);
    const opts = guardOpts(config, now);
    assert.strictEqual(payload.v1, 12500, 'production path unchanged: value ×1000');
    assert.strictEqual(opts.minV1Wh, 12500, 'production minV1Wh unchanged: 12500');
    assert.deepStrictEqual(validatePayload(payload, 2900, opts), [], '12500/12500 upload proceeds');
    console.log('PASS TS-30 (c): production default (kWh, no selector) -> 12500/12500 unchanged');
  }

  // TS-31 (d): a genuine same-day regression is STILL caught under every unit
  // combination — the fix must not disable the guard.
  {
    const combos = [
      // [catalogue, selector, storedNative, incomingNative, expMinWh, expPayloadWh]
      ['kWh', undefined, 50, 12.5, 50000, 12500],
      ['kWh', 'kWh', 50, 12.5, 50000, 12500],
      ['Wh', undefined, 50000, 12500, 50000000, 12500000],
      ['Wh', 'Wh', 50000, 12500, 50000, 12500]
    ];
    for (const [catalogue, selector, stored, incoming, expMin, expPayload] of combos) {
      setCatalogueUnit(catalogue);
      const now = seed(stored);
      const map = { v1: N };
      if (selector) map.v1_unit = selector;
      const config = { timezone: 'UTC', system_size_w: 2900, metric_map: map };
      const payload = buildStatusPayload({ [N]: incoming }, config, now);
      const opts = guardOpts(config, now);
      const label = `catalogue=${catalogue} selector=${selector || '(absent)'}`;
      assert.strictEqual(opts.minV1Wh, expMin, `${label}: minV1Wh`);
      assert.strictEqual(payload.v1, expPayload, `${label}: payload v1`);
      const errors = validatePayload(payload, 2900, opts);
      assert.ok(errors.some(e => e.includes('regression')), `${label}: regression must still be caught (got ${JSON.stringify(errors)})`);
    }
    console.log('PASS TS-31 (d): genuine regression still caught under all four unit combinations');
  }

  setConfig('metric_sanity', '');
  msUnit.reloadConfig();
  msUnit._reset();
}

console.log('ALL PASS: metric-sanity');
process.exit(0);
