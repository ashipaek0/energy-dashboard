/**
 * Metric Sanity Guard (issue #119) — source-agnostic implausible-jump rejection
 * for daily (resettable) energy counters.
 *
 * Design: D3 of the #119 spec — ONE source-agnostic module, importing no source
 * adapter (ha.js / dongle.js / modbus.js / …). Adopted at `modules/ha.js`
 * `saveMetric()` in #119; every other writer can call the same `check()` API
 * later without a signature change.
 *
 * Classification (AC-1 v2, P1–P9) reads the declared unit from the
 * `user_metrics` CONFIG catalogue (`[{name, unit, createdAt}, …]`, seeded at
 * `modules/database.js` and maintained by metricsManager) — NOT from
 * `latest_metrics.unit`, which is NULL for every row in production, so a
 * sample-level unit gate would never fire.
 *
 * Guard state lives in an in-memory Map with write-through to the `config`
 * table JSON key `metric_sanity_state` (D1(ii)), rehydrated at module load.
 * Every state CHANGE (accept / reject / recovery / day-rollover) is persisted,
 * so a process restart during a spike cannot re-baseline onto the corrupt value.
 *
 * Fail-open (AC-9): any internal error is logged at `error`, the sample is
 * treated as ACCEPTED and the guard keeps going — a guard bug must never stop
 * metrics from updating. `check()` never throws into the poll loop.
 *
 * @module metricSanity
 */
'use strict';

const { getConfig, setConfig } = require('./database');
const { logger } = require('./logger');
const { warnParseRateLimited } = require('./utils');

// Container-local timezone (docker-compose.yaml: TZ=Africa/Lagos, UTC+1, no DST).
const TZ = 'Africa/Lagos';

const STATE_CONFIG_KEY = 'metric_sanity_state';

// §5 defaults table (D2). All overridable; a missing config key never throws.
// Thresholds are defined in **kWh** and scale-converted to the metric's native
// unit before comparison (AC-1 note 6 / AC-3): Wh ×1000, kWh ×1, MWh ×1.
const DEFAULTS = {
  maxStepDefault: 0.5,   // any other classified daily counter
  maxStepPv: 0.5,        // PV generation: 0.5 kWh/30 s = 60 kW-equivalent —
                         // 76× margin against the observed 38.1 kWh jump (38.1 / 0.5)
  maxStepGrid: 0.6,      // grid import/export: 72 kW-equivalent
  maxStepBattery: 0.6,   // battery charge/discharge (inrush / high-C charging)
  maxStepLoad: 0.6,      // load
  absoluteCap: 100,      // kWh — first-seen only
  gapSeconds: 300        // 10× the 30 s poll, measured from lastSeenTs (strict >)
};

// AC-3 NOTE 1 (D9): absolute epsilon in kWh. 5 orders of magnitude above the
// largest observed float-subtraction dust (1.4e-14 at 100 kWh scale) and 7
// below the smallest meaningful meter increment (0.01 kWh). Scaled with the
// thresholds for Wh/MWh (×1000 / ×1). Applied to AC-3 b/d/e ONLY.
const EPS_KWH = 1e-9;

// AC-1 P7: cumulative energy units. Case- and whitespace-insensitive.
const CUMULATIVE_ENERGY_UNITS = ['kwh', 'wh', 'mwh'];

// kWh → native multiplier (AC-1 note 6 / §5 "Threshold unit basis").
const UNIT_SCALE = { wh: 1000, kwh: 1, mwh: 1 };

// AC-1 P4: non-energy qualifiers — a money/rate metric is never a daily energy
// counter, even when its name contains `Energy` and its unit is unknown.
// Matched as WHOLE WORDS (optional plural): a bare substring test would exclude
// `PV Energy Generated` (gene-rate-d) and is therefore incompatible with the
// AC-1 worked table, which is normative (AC-12g).
const NON_ENERGY_QUALIFIER_RE =
  /\b(?:cost|price|tariff|rate|revenue|savings|bill|fee|budget|money|currency)s?\b/i;

// ── State ────────────────────────────────────────────────────────────────
// metric name -> { day, lastAccepted, lastAcceptedTs, lastSeenTs, suspect,
//                  suspectSince, recoveryBaseline, lastReason, lastValue, lastDelta }
const state = new Map();
let hydrated = false;
let config = null; // cached threshold snapshot, refreshed once per poll cycle

// Test seam for AC-9 (force an internal error inside the guard).
const _test = { forceError: false };

// ── Config surface ───────────────────────────────────────────────────────

function parseNameList(raw) {
  if (raw === null || raw === undefined) return [];
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(x => String(x).trim()).filter(Boolean);
  } catch (_) { /* not JSON — fall through to delimiter split */ }
  return s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readDailyMetricNames() {
  // Mirrors history.js getRoleMetrics()/buildMetricToRole() but reads the
  // config directly (no adapter import, no auto-populate side effect).
  const names = new Set();
  try {
    const raw = getConfig('role_metrics');
    if (raw && raw !== '{}') {
      const j = JSON.parse(raw);
      for (const [role, name] of Object.entries(j || {})) {
        if (role && String(role).startsWith('daily_') && typeof name === 'string' && name.trim()) {
          names.add(name.trim());
        }
      }
    }
  } catch (_) { /* corrupt role_metrics -> no role-derived names */ }
  return names;
}

/**
 * Read the `user_metrics` CONFIG catalogue: a JSON array of `{name, unit}`.
 * Returns a Map of lowercased trimmed name -> declared unit. This is the REAL
 * production unit source (AC-1 note 4 / H7); `latest_metrics.unit` is NULL for
 * every row and is deliberately not consulted.
 */
function readUnitCatalogue() {
  const units = new Map();
  try {
    const raw = getConfig('user_metrics');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && typeof m.name === 'string' && m.name.trim()) {
            units.set(m.name.trim().toLowerCase(), m.unit);
          }
        }
      }
    }
  } catch (_) { /* corrupt catalogue -> no declared units */ }
  return units;
}

function loadConfig() {
  const cfg = {
    perMetric: {},
    allow: [],
    deny: [],
    dailyNames: new Set(),
    units: new Map(),
    absoluteCap: DEFAULTS.absoluteCap,
    gapSeconds: DEFAULTS.gapSeconds
  };
  try {
    const raw = getConfig('metric_sanity');
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) cfg.perMetric = j;
    }
  } catch (e) {
    logger.warn(`[metric_sanity] invalid metric_sanity config: ${e.message}`);
  }
  try { cfg.allow = parseNameList(getConfig('metric_sanity_allow')); } catch (_) {}
  try { cfg.deny = parseNameList(getConfig('metric_sanity_deny')); } catch (_) {}
  try {
    const abs = positiveNumber(getConfig('metric_sanity_abs_max'));
    if (abs) cfg.absoluteCap = abs;
  } catch (_) {}
  try {
    const gap = positiveNumber(getConfig('metric_sanity_gap_seconds'));
    if (gap) cfg.gapSeconds = gap;
  } catch (_) {}
  cfg.dailyNames = readDailyMetricNames();
  cfg.units = readUnitCatalogue();
  config = cfg;
  return cfg;
}

function cfgSnapshot() {
  return config || loadConfig();
}

function reloadConfig() {
  return loadConfig();
}

// ── Persistence (D1(ii)) ─────────────────────────────────────────────────

function persistState() {
  try {
    const obj = {};
    for (const [k, v] of state.entries()) obj[k] = v;
    setConfig(STATE_CONFIG_KEY, JSON.stringify(obj));
  } catch (e) {
    logger.error(`[metric_sanity] failed to persist state: ${e.message}`);
  }
}

function flush() {
  persistState();
}

function hydrate() {
  if (hydrated) return;
  try {
    const raw = getConfig(STATE_CONFIG_KEY);
    if (raw && raw !== '{}') {
      const j = JSON.parse(raw);
      for (const [k, v] of Object.entries(j || {})) {
        if (v && typeof v === 'object') state.set(k, normalizeState(v));
      }
    }
    hydrated = true;
  } catch (e) {
    // DB may not be initialized yet (module load / early require) — stay
    // un-hydrated so the next call retries, and never throw.
    const msg = `[metric_sanity] could not rehydrate state: ${e.message}`;
    if (/not initialized/i.test(e.message)) logger.debug(msg);
    else logger.warn(msg);
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function normalizeState(v) {
  const lastAcceptedTs = numOrNull(v.lastAcceptedTs);
  return {
    day: v.day !== undefined ? v.day : null,
    lastAccepted: (v.lastAccepted === null || v.lastAccepted === undefined || !Number.isFinite(Number(v.lastAccepted)))
      ? null : Number(v.lastAccepted),
    lastAcceptedTs,
    // AC-2 [v2]: timestamp of the most recent sample, accepted OR rejected.
    // Legacy blob (field absent) migration: lastSeenTs <- lastAcceptedTs, which
    // preserves v1 semantics for exactly one sample and then self-corrects.
    // An explicit `null` is preserved so AC-3c NOTE 4 can fail closed.
    lastSeenTs: Object.prototype.hasOwnProperty.call(v, 'lastSeenTs')
      ? numOrNull(v.lastSeenTs)
      : lastAcceptedTs,
    suspect: !!v.suspect,
    suspectSince: Number.isFinite(Number(v.suspectSince)) ? Number(v.suspectSince) : null,
    recoveryBaseline: (v.recoveryBaseline === null || v.recoveryBaseline === undefined || !Number.isFinite(Number(v.recoveryBaseline)))
      ? null : Number(v.recoveryBaseline),
    lastReason: v.lastReason || null,
    lastValue: v.lastValue === undefined ? null : v.lastValue,
    lastDelta: v.lastDelta === undefined ? null : v.lastDelta
  };
}

// ── Unit resolution (AC-1 note 4) ────────────────────────────────────────

/** Normalise a unit token: trim, lowercase, drop internal whitespace. */
function normUnit(u) {
  return String(u === null || u === undefined ? '' : u).trim().toLowerCase().replace(/\s+/g, '');
}

/** AC-1 P7 upper half: is this a cumulative energy unit? */
function isCumulativeEnergyUnit(u) {
  return CUMULATIVE_ENERGY_UNITS.includes(normUnit(u));
}

/**
 * AC-1 note 4 — declared unit for a metric, config-only (no adapter imports):
 *   1. `metric_sanity["<name>"].unit` (explicit override; exact then
 *      case/whitespace-insensitive) — wins when non-empty;
 *   2. exact then case/whitespace-insensitive match in the `user_metrics`
 *      config catalogue;
 *   3. else `null` (unknown ⇒ P8, never "unguarded" for Energy names).
 * @returns {string|null}
 */
function resolveUnit(name) {
  const raw = String(name === null || name === undefined ? '' : name).trim();
  if (!raw) return null;
  const cfg = cfgSnapshot();
  const lower = raw.toLowerCase();

  // 1. explicit per-metric override
  let ov = cfg.perMetric[raw];
  if (!ov || typeof ov !== 'object') {
    const key = Object.keys(cfg.perMetric).find(k => k.trim().toLowerCase() === lower);
    if (key) ov = cfg.perMetric[key];
  }
  if (ov && typeof ov === 'object' && String(ov.unit == null ? '' : ov.unit).trim() !== '') {
    return String(ov.unit);
  }

  // 2. the user_metrics catalogue
  if (cfg.units.has(lower)) {
    const u = cfg.units.get(lower);
    if (String(u == null ? '' : u).trim() !== '') return String(u);
  }

  // 3. unknown
  return null;
}

/**
 * kWh → native multiplier for a metric (AC-1 note 6): Wh ×1000, kWh ×1,
 * MWh ×1. Unknown units are treated as kWh (the deployment norm).
 */
function scaleFactorFor(name) {
  return UNIT_SCALE[normUnit(resolveUnit(name))] || 1;
}

// ── Classification (AC-1) ────────────────────────────────────────────────

const EXCLUSIONS = [
  { test: n => n.includes('energy total'), reason: 'Energy Total' },
  { test: n => n.endsWith('total'), reason: 'suffix Total' },
  { test: n => n.includes('battery energy (capacity)'), reason: 'Battery Energy (Capacity)' },
  { test: n => n.includes('pv forecast energy'), reason: 'PV Forecast Energy' }
];

function exclusionFor(lowerName) {
  for (const ex of EXCLUSIONS) {
    if (ex.test(lowerName)) return ex.reason;
  }
  return null;
}

function hasNonEnergyQualifier(lowerName) {
  return NON_ENERGY_QUALIFIER_RE.test(lowerName);
}

/**
 * AC-1 v2 — is `name` a guarded daily counter? Normative precedence P1–P9:
 *
 *   P1 allowlist                       -> GUARDED  reason `allowlist`
 *   P2 denylist                        -> not      reason `denylist`
 *   P3 hard exclusion (Energy Total /  -> not      reason `excluded:<pattern>`
 *      suffix Total / Battery Energy
 *      (Capacity) / PV Forecast Energy)
 *   P4 non-energy qualifier            -> not      reason `excluded:non-energy qualifier`
 *   P5 trimmed name ends with `Today`  -> GUARDED  reason `name_today`
 *   P6 value of a `daily_*` role       -> GUARDED  reason `daily_role`
 *   P7 contains `Energy` + cumulative  -> GUARDED  reason `energy_unit`
 *      energy unit (kWh/Wh/MWh)
 *   P8 contains `Energy` + unit unknown-> GUARDED  reason `energy_unknown_unit`
 *   P9 otherwise                       -> not      reason `not_daily_counter`
 *
 * The allowlist wins over every heuristic (including the exclusions); the
 * denylist wins over the heuristics but not over an explicit allowlist entry.
 * P1–P4 are order-critical; P5–P8 order affects only the reported `reason`.
 *
 * @param {string} name metric name
 * @returns {{guarded: boolean, reason: string}}
 */
function classify(name) {
  const raw = String(name === null || name === undefined ? '' : name).trim();
  if (!raw) return { guarded: false, reason: 'empty' };
  const cfg = cfgSnapshot();
  const lower = raw.toLowerCase();
  const eq = (a, b) => a.trim().toLowerCase() === b;

  // P1 / P2 — overrides keep highest priority
  if (cfg.allow.some(a => eq(a, lower))) return { guarded: true, reason: 'allowlist' };
  if (cfg.deny.some(a => eq(a, lower))) return { guarded: false, reason: 'denylist' };

  // P3 — hard exclusions
  const ex = exclusionFor(lower);
  if (ex) return { guarded: false, reason: `excluded:${ex}` };

  // P4 — non-energy qualifier
  if (hasNonEnergyQualifier(lower)) return { guarded: false, reason: 'excluded:non-energy qualifier' };

  // P5 — `… Today`
  if (lower.endsWith('today')) return { guarded: true, reason: 'name_today' };

  // P6 — daily_* role value
  if (cfg.dailyNames.has(raw) || [...cfg.dailyNames].some(n => n.trim().toLowerCase() === lower)) {
    return { guarded: true, reason: 'daily_role' };
  }

  // P7 / P8 — `Energy` name gated by the declared unit (from user_metrics)
  if (lower.includes('energy')) {
    const unit = resolveUnit(raw);
    if (unit !== null && isCumulativeEnergyUnit(unit)) return { guarded: true, reason: 'energy_unit' };
    if (unit === null) return { guarded: true, reason: 'energy_unknown_unit' };
  }

  // P9
  return { guarded: false, reason: 'not_daily_counter' };
}

// ── maxStep resolution (D2 / §5) ─────────────────────────────────────────

/**
 * Threshold in kWh for a metric name, from the per-metric override then the
 * §5 family table. The result is NOT unit-scaled — `check()` multiplies by
 * `scaleFactorFor()`.
 *
 * §5 families [E]: PV generation 0.5; grid import/export 0.6; battery
 * charge/discharge 0.6 (incl. `Battery Energy (Charge)` / `(Discharge)`);
 * load 0.6; any other guarded counter 0.5. The family table is an EXAMPLE of
 * AC-1's coverage, not a second classification source.
 */
function maxStepFor(name) {
  const cfg = cfgSnapshot();
  const raw = String(name).trim();
  const lower = raw.toLowerCase();

  // Per-metric override (exact, then case-insensitive) wins.
  const ov = cfg.perMetric[raw] || cfg.perMetric[lower] ||
    Object.entries(cfg.perMetric).find(([k]) => k.trim().toLowerCase() === lower)?.[1];
  if (ov && Number.isFinite(Number(ov.maxStep)) && Number(ov.maxStep) >= 0) return Number(ov.maxStep);

  const n = lower;
  if (/(^|\s)pv\d*\b/.test(n) || n.includes('pv energy')) return DEFAULTS.maxStepPv;
  if (n.includes('grid')) return DEFAULTS.maxStepGrid;
  if (n.includes('batter') && n.includes('discharg')) return DEFAULTS.maxStepBattery;
  if (n.includes('batter') && n.includes('charg')) return DEFAULTS.maxStepBattery;
  if (n.includes('load')) return DEFAULTS.maxStepLoad;
  return DEFAULTS.maxStepDefault;
}

// ── Local day (Africa/Lagos) ─────────────────────────────────────────────

function localDay(tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(d).map(p => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch (_) {
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
}

function nowSeconds(ts) {
  if (ts === undefined || ts === null || !Number.isFinite(Number(ts))) return Math.floor(Date.now() / 1000);
  return Number(ts);
}

// ── Accept / reject engine (AC-3 … AC-7) ────────────────────────────────

function acceptSample(st, num, nowTs, day, reason) {
  st.day = day;
  st.lastAccepted = num;
  st.lastAcceptedTs = nowTs;
  st.suspect = false;
  st.suspectSince = null;
  st.recoveryBaseline = null;
  persistState();
  return { guarded: true, accepted: true, reason, value: num, day };
}

function rejectSample(st, metricName, num, nowTs, day, reason) {
  if (!st.suspect) {
    st.suspect = true;
    st.suspectSince = nowTs;
    st.recoveryBaseline = st.lastAccepted; // captured ONCE per episode (AC-5)
  }
  if (st.day === null) st.day = day;
  const last = st.lastAccepted;
  const delta = (last === null || last === undefined) ? null : num - last;
  st.lastReason = reason;
  st.lastValue = num;
  st.lastDelta = delta;
  persistState();

  const msg = `[metric_sanity] rejected ${metricName}=${num} (lastAccepted=${last}, delta=${delta}, day=${day}, reason=${reason}, recoveryBaseline=${st.recoveryBaseline})`;
  // AC-8: first rejection of an episode is always logged; repeats are
  // rate-limited per metric. A per-episode key (suspectSince) satisfies both:
  // the episode's first warn is a fresh key, repeats share it.
  warnParseRateLimited(`metric_sanity:${metricName}:${st.suspectSince}`, msg);

  return {
    guarded: true, accepted: false, reason, metric: metricName,
    value: num, lastAccepted: last, delta, day,
    suspect: true, suspectSince: st.suspectSince, recoveryBaseline: st.recoveryBaseline
  };
}

/**
 * AC-3..AC-7 — evaluate a numeric sample for a metric.
 * @param {string} metricName
 * @param {number|string} value numeric sample
 * @param {number} [ts] epoch seconds (defaults to now)
 * @returns {{guarded: boolean, accepted: boolean, reason: string, ...}}
 *   `accepted === true` means the caller may write the sample; `guarded` is
 *   false for non-counters (write unchanged, AC-12b).
 */
function check(metricName, value, ts) {
  try {
    if (_test.forceError) throw new Error('forced internal error (test)');
    hydrate();
    const cls = classify(metricName);
    if (!cls.guarded) {
      return { guarded: false, accepted: true, reason: cls.reason, metric: metricName };
    }

    const num = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(num)) {
      // Non-numeric guarded sample: the text path in the writer owns it (AC-12b).
      return { guarded: true, accepted: true, reason: 'non-numeric', metric: metricName };
    }

    const cfg = cfgSnapshot();
    // Unit-scaled thresholds in the metric's NATIVE unit (AC-1 note 6 / AC-3):
    // thresholds are defined in kWh, EPS included.
    const scale = scaleFactorFor(metricName);
    const maxStep = maxStepFor(metricName) * scale;
    const absCap = cfg.absoluteCap * scale;
    const EPS = EPS_KWH * scale;
    const nowTs = nowSeconds(ts);
    const day = localDay(nowTs);

    let st = state.get(metricName);
    if (!st) {
      st = normalizeState({});
      state.set(metricName, st);
    }

    // AC-2 [v2/B]: lastSeenTs tracks EVERY sample (accept or reject); capture
    // the previous sample timestamp first, then advance it.
    const prevSeenTs = st.lastSeenTs;
    st.lastSeenTs = nowTs;

    // AC-3a — new local day: baseline reset, suspect cleared (AC-7).
    if (st.day !== null && day !== null && day !== st.day) {
      return acceptSample(st, num, nowTs, day, 'day-rollover');
    }

    // AC-3b — first-seen: accept within the absolute cap (+EPS), else reject + suspect.
    if (st.lastAccepted === null || st.lastAccepted === undefined) {
      if (num >= 0 && num <= absCap + EPS) {
        return acceptSample(st, num, nowTs, day, 'first-seen');
      }
      return rejectSample(st, metricName, num, nowTs, day, 'absolute-cap');
    }

    // AC-3c [v2/B — N1] — genuine poll OUTAGE only: no sample of ANY kind for
    // more than gapSeconds. Measured from lastSeenTs (previous sample), NOT
    // lastAcceptedTs, so sustained implausible readings stay held. Strict `>`;
    // no EPS (integer epoch seconds). NOTE 4: if lastSeenTs is null while a
    // baseline exists, (c) must NOT fire (fail closed).
    if (prevSeenTs !== null && prevSeenTs !== undefined && (nowTs - prevSeenTs) > cfg.gapSeconds) {
      const gap = nowTs - prevSeenTs;
      const r = acceptSample(st, num, nowTs, day, 'gap');
      logger.debug(`[metric_sanity] ${metricName}: gap ${gap}s > ${cfg.gapSeconds}s — accepting ${num} and re-baselining`);
      return r;
    }

    const last = st.lastAccepted;

    // AC-3d / AC-6 — recovery while suspect: value <= recoveryBaseline + maxStep (+EPS).
    // Checked before the plain AC-3e step so a suspect-clearing sample is
    // labelled + logged as a recovery (AC-6 mandates the info log).
    if (st.suspect) {
      const baseline = st.recoveryBaseline;
      const limit = (baseline !== null && baseline !== undefined) ? baseline + maxStep : absCap;
      if (num >= 0 && num <= limit + EPS) {
        const r = acceptSample(st, num, nowTs, day, 'recovery');
        logger.info(`[metric_sanity] ${metricName}: recovered — accepted ${num} (recoveryBaseline=${baseline}, +maxStep=${maxStep})`);
        return r;
      }
    }

    // AC-3e — normal monotonic step: 0 <= delta <= maxStep (+EPS, N2).
    const delta = num - last;
    if (delta >= 0 && delta <= maxStep + EPS) {
      return acceptSample(st, num, nowTs, day, 'accept');
    }

    return rejectSample(st, metricName, num, nowTs, day, delta < 0 ? 'decrease' : 'jump');
  } catch (e) {
    // AC-9 fail-open: never reject on a guard bug, never throw into the poll loop.
    try { logger.error(`[metric_sanity] internal error for ${metricName}: ${e.message} — accepting sample (fail-open)`); } catch (_) {}
    return { guarded: true, accepted: true, reason: 'fail-open', error: e.message, metric: metricName };
  }
}

// ── Accessors (AC-2 / AC-8 observability) ────────────────────────────────

function getState(metricName) {
  try {
    hydrate();
    const st = state.get(String(metricName));
    return st ? { ...st } : null;
  } catch (_) { return null; }
}

function getStatus() {
  try {
    hydrate();
    const out = {};
    for (const [k, v] of state.entries()) out[k] = { ...v };
    return out;
  } catch (_) { return {}; }
}

/**
 * Last accepted value for a metric on the current local day, else null.
 * Used by PVOutput uploads for the same-day no-regression rule (AC-11).
 */
function getLastAccepted(metricName, ts) {
  try {
    hydrate();
    const st = state.get(String(metricName));
    if (!st || st.lastAccepted === null || st.lastAccepted === undefined) return null;
    const day = localDay(nowSeconds(ts));
    if (st.day && day && st.day !== day) return null;
    return st.lastAccepted;
  } catch (_) { return null; }
}

function _reset() {
  state.clear();
  hydrated = false;
  config = null;
  try { setConfig(STATE_CONFIG_KEY, '{}'); } catch (_) {}
}

// D1(ii): rehydrate persisted state at module load (safe when the DB is not
// yet initialized — hydrate() leaves hydrated=false and retries lazily).
try { hydrate(); } catch (_) { /* lazy retry on first use */ }

module.exports = {
  check,
  classify,
  maxStepFor,
  resolveUnit,
  scaleFactorFor,
  localDay,
  getState,
  getStatus,
  getLastAccepted,
  reloadConfig,
  flush,
  _reset,
  _test,
  DEFAULTS,
  EPS_KWH,
  TZ
};
