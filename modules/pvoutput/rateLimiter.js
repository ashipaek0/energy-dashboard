/**
 * PVOutput Rate Limiter — dual-bucket token tracking with DB-persisted state.
 *
 * Two independent pools:
 *   general   — addstatus, addoutput, addbatchstatus, getsystem, getoutput, getstatus, delete
 *   statistic — getstatistic only (separate limit: 12/hr free, 60/hr donation)
 *
 * State persisted to config table under pvoutput_rate_limit_state on every update.
 * Restored on startup; ignored if resetAt is in the past (window has expired).
 *
 * Windows self-heal lazily: when `now` passes resetAt, the next canCall()
 * access restores `remaining` to `limit` without a process restart.
 *
 * Lockouts (403 Exceeded responses) are taught to the limiter through
 * handleRateLimitExceeded() — called by the client choke point (client.js)
 * whenever a response body matches the PVOutput Exceeded pattern. Per D1 the
 * server-provided X-Rate-Limit-Reset header is preferred when present;
 * otherwise resetAt defaults to the next UTC hour boundary + 60s safety.
 *
 * @module pvoutput/rateLimiter
 */

let pools = {
  general:  { remaining: 60, limit: 60, resetAt: 0 },
  statistic: { remaining: 12, limit: 12, resetAt: 0 }
};

let db = null; // set by init()

// Injectable clock — defaults to the wall clock; tests override via _test.setNow.
let nowFn = () => Date.now();

/** Matches the documented PVOutput lockout body:
 *  "Forbidden 403: Exceeded number requests per hour ... wait till the next hour"
 *  (403 responses carry no rate headers unless the request sent X-Rate-Limit: 1). */
function isRateLimitError(err) {
  const msg = String((err && (err.message !== undefined ? err.message : err)) || '');
  return /exceeded/i.test(msg) && /requests?\s+per hour/i.test(msg);
}

/** D1 fallback reset: next UTC hour boundary + 60s safety buffer. */
function defaultResetAt() {
  const d = new Date(nowFn());
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return Math.floor(d.getTime() / 1000) + 60;
}

function init(database) {
  db = database;
  // Restore persisted state
  try {
    const raw = db.prepare("SELECT value FROM config WHERE key = 'pvoutput_rate_limit_state'").get();
    if (raw && raw.value) {
      const saved = JSON.parse(raw.value);
      const now = Math.floor(nowFn() / 1000);
      if (saved.general && saved.general.resetAt > now) {
        pools.general = saved.general;
      }
      if (saved.statistic && saved.statistic.resetAt > now) {
        pools.statistic = saved.statistic;
      }
    }
  } catch (e) { /* use defaults */ }
}

function persist() {
  if (!db) return;
  try {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pvoutput_rate_limit_state', ?)")
      .run(JSON.stringify(pools));
  } catch (e) { /* non-critical */ }
}

/**
 * Read a header by lowercase name from either a fetch Headers instance
 * (which does NOT support property access) or a plain object.
 */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name];
}

function updateFromHeaders(pool, headers) {
  const p = pools[pool];
  if (!p) return;
  const rem = parseInt(headerValue(headers, 'x-rate-limit-remaining'), 10);
  const lim = parseInt(headerValue(headers, 'x-rate-limit-limit'), 10);
  const rst = parseInt(headerValue(headers, 'x-rate-limit-reset'), 10);
  if (!isNaN(rem)) p.remaining = rem;
  if (!isNaN(lim)) p.limit = lim;
  if (!isNaN(rst)) p.resetAt = rst;
  persist();
}

/**
 * Teach the limiter that the pool is locked out (403 Exceeded).
 * AC-7: sets remaining = 0, preserves limit, sets resetAt per D1
 * (server X-Rate-Limit-Reset header value when provided, else the next
 * UTC hour boundary + 60s), and persists.
 *
 * @param {string} pool pool name ('general' | 'statistic')
 * @param {number} [resetAt] optional epoch-seconds reset from X-Rate-Limit-Reset
 */
function handleRateLimitExceeded(pool = 'general', resetAt) {
  const p = pools[pool];
  if (!p) return;
  p.remaining = 0;
  p.resetAt = (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > 0)
    ? Math.floor(resetAt)
    : defaultResetAt();
  persist();
}

/** Lazy self-heal: restore the bucket once its reset window has passed. */
function healIfExpired(pool) {
  const p = pools[pool];
  if (!p || !p.resetAt) return;
  if (nowFn() >= p.resetAt * 1000) {
    p.remaining = p.limit;
    p.resetAt = 0;
    persist();
  }
}

/**
 * AC-8: returns false whenever remaining <= 0 (any priority, including
 * negative remaining values observed in X-Rate-Limit-Remaining after a 403).
 * An expired window lazily self-heals before the decision is made.
 */
function canCall(pool = 'general', priority = 'normal') {
  const p = pools[pool];
  if (!p) return false;
  healIfExpired(pool);
  if (p.remaining <= 0) return false;                    // hard lock (AC-8)
  if (p.remaining >= 10) return true;                    // comfortable
  if (p.remaining > 3 && priority === 'high') return true; // reserved for uploads
  return false;
}

function msUntilReset(pool = 'general') {
  const p = pools[pool];
  if (!p || !p.resetAt) return 0;
  return Math.max(0, (p.resetAt * 1000) - nowFn());
}

function isDonationAccount() {
  return pools.general.limit >= 300;
}

function getState() {
  return {
    general: { ...pools.general },
    statistic: { ...pools.statistic },
    donation: pools.general.limit >= 300
  };
}

// Test-only hooks: injectable clock and full state reset. Not used in production.
const _test = {
  setNow(fn) {
    nowFn = (typeof fn === 'function') ? fn : (() => Date.now());
  },
  reset() {
    nowFn = () => Date.now();
    pools = {
      general: { remaining: 60, limit: 60, resetAt: 0 },
      statistic: { remaining: 12, limit: 12, resetAt: 0 }
    };
    db = null;
  }
};

module.exports = {
  init, updateFromHeaders, handleRateLimitExceeded, canCall,
  msUntilReset, isDonationAccount, isRateLimitError, getState, _test
};
