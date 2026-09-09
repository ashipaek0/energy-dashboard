'use strict';

/**
 * Tests for the PVOutput rate limiter (issue #115 — rate-limit self-lockout).
 *
 * Covers: header parsing (plain object AND fetch Headers instances), the
 * no-header 403 path via handleRateLimitExceeded with an injectable clock,
 * D1 reset fallback (next UTC hour boundary + 60s), expiry self-heal,
 * stale persisted-state init, canCall boundaries, msUntilReset, and
 * donation-limit preservation.
 *
 * Run: node --test tests/rateLimiter.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const rl = require('../modules/pvoutput/rateLimiter');

// 2026-09-09T15:30:00Z — probe-verified reset boundary is 16:00:00 UTC
// (1788969600), so the D1 fallback must be 1788969600 + 60 = 1788969660.
const T0_MS = Date.UTC(2026, 8, 9, 15, 30, 0);
const NEXT_HOUR_PLUS_60 = 1788969660; // 2026-09-09T16:01:00Z

/** In-memory config-table db stub (config key -> JSON value). */
function makeDb(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    raw(key) { return rows.get(key); },
    prepare(sql) {
      return {
        get() {
          const m = sql.match(/key = '([^']+)'/);
          const v = m ? rows.get(m[1]) : undefined;
          return v !== undefined ? { value: v } : undefined;
        },
        run(...args) {
          const m = sql.match(/VALUES \('([^']+)'/);
          if (m) rows.set(m[1], args[0]);
          return { changes: 1 };
        }
      };
    }
  };
}

beforeEach(() => {
  rl._test.reset();
  rl._test.setNow(() => T0_MS);
});

test('updateFromHeaders parses remaining/limit/reset from plain-object headers and persists', () => {
  const db = makeDb();
  rl.init(db);

  rl.updateFromHeaders('general', {
    'x-rate-limit-remaining': '59',
    'x-rate-limit-limit': '60',
    'x-rate-limit-reset': '1788969600'
  });

  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 59);
  assert.strictEqual(st.limit, 60);
  assert.strictEqual(st.resetAt, 1788969600);
  // Persisted: config row now holds serialized pool state.
  const saved = JSON.parse(db.raw('pvoutput_rate_limit_state'));
  assert.strictEqual(saved.general.remaining, 59);
  assert.strictEqual(saved.general.limit, 60);
  assert.strictEqual(saved.general.resetAt, 1788969600);
});

test('updateFromHeaders parses fetch Headers instances (property access returns undefined)', () => {
  const db = makeDb();
  rl.init(db);
  const headers = new Headers({
    'X-Rate-Limit-Remaining': '59',
    'X-Rate-Limit-Limit': '60',
    'X-Rate-Limit-Reset': '1788969600'
  });
  rl.updateFromHeaders('general', headers);
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 59);
  assert.strictEqual(st.resetAt, 1788969600);
});

test('handleRateLimitExceeded with no headers zeroes remaining, keeps limit, D1 fallback reset, canCall false at high', () => {
  const db = makeDb();
  rl.init(db);
  rl.updateFromHeaders('general', { 'x-rate-limit-remaining': '60', 'x-rate-limit-limit': '60' });

  rl.handleRateLimitExceeded('general');

  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 0);
  assert.strictEqual(st.limit, 60, 'limit must be preserved');
  assert.strictEqual(st.resetAt, NEXT_HOUR_PLUS_60, 'D1: next UTC hour boundary + 60s safety');
  assert.strictEqual(rl.canCall('general', 'high'), false, 'remaining 0 hard-locks even at high priority');
});

test('handleRateLimitExceeded prefers an explicit server X-Rate-Limit-Reset value', () => {
  const db = makeDb();
  rl.init(db);
  // e.g. reset already reached within this hour — server value wins over fallback
  rl.handleRateLimitExceeded('general', 1788969500);
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 0);
  assert.strictEqual(st.resetAt, 1788969500);
});

test('expired window lazily self-heals on the next canCall access', () => {
  const db = makeDb();
  rl.init(db);
  rl.handleRateLimitExceeded('general'); // resetAt 16:01:00Z

  rl._test.setNow(() => T0_MS + 31 * 60 * 1000); // 16:01:00Z — exactly resetAt
  assert.strictEqual(rl.canCall('general', 'high'), true, 'window passed → self-heal');
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 60, 'remaining restored to limit');
  assert.strictEqual(st.resetAt, 0, 'resetAt cleared after heal');
});

test('init() restores persisted state only while resetAt is in the future', () => {
  const future = Math.floor(T0_MS / 1000) + 3600;
  const past = Math.floor(T0_MS / 1000) - 60;

  // Fresh pool locked by persisted state whose window has NOT expired.
  rl.init(makeDb({
    pvoutput_rate_limit_state: JSON.stringify({
      general: { remaining: 0, limit: 60, resetAt: future },
      statistic: { remaining: 12, limit: 12, resetAt: 0 }
    })
  }));
  assert.strictEqual(rl.getState().general.remaining, 0);
  assert.strictEqual(rl.canCall('general', 'high'), false);

  // Stale persisted lock (resetAt in the past) must be ignored → defaults.
  rl._test.reset();
  rl._test.setNow(() => T0_MS);
  rl.init(makeDb({
    pvoutput_rate_limit_state: JSON.stringify({
      general: { remaining: 0, limit: 60, resetAt: past },
      statistic: { remaining: 0, limit: 12, resetAt: past }
    })
  }));
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 60, 'stale lock ignored, defaults restored');
  assert.strictEqual(rl.canCall('general'), true);
  assert.strictEqual(rl.getState().statistic.remaining, 12);
});

test('canCall boundaries: 0 hard-locked at any priority, 10 comfortable at normal, reserve band only for high', () => {
  const db = makeDb();
  rl.init(db);
  const set = (remaining) => rl.updateFromHeaders('general', {
    'x-rate-limit-remaining': String(remaining),
    'x-rate-limit-limit': '60',
    'x-rate-limit-reset': String(Math.floor(T0_MS / 1000) + 7200)
  });

  set(0);
  assert.strictEqual(rl.canCall('general', 'normal'), false);
  assert.strictEqual(rl.canCall('general', 'high'), false);

  set(-237); // probe-verified negative remaining after a 403
  assert.strictEqual(rl.canCall('general', 'high'), false, 'negative remaining is a hard lock');

  set(10);
  assert.strictEqual(rl.canCall('general', 'normal'), true, 'remaining 10 is comfortable');

  set(9);
  assert.strictEqual(rl.canCall('general', 'normal'), false);
  assert.strictEqual(rl.canCall('general', 'high'), true, 'reserve band open for high priority uploads');

  set(3);
  assert.strictEqual(rl.canCall('general', 'high'), false);
  assert.strictEqual(rl.canCall('general', 'normal'), false);

  set(60);
  assert.strictEqual(rl.canCall('general'), true);
});

test('msUntilReset is 0 when unset and >0 when a reset is scheduled', () => {
  rl.init(makeDb());
  assert.strictEqual(rl.msUntilReset('general'), 0);

  rl.handleRateLimitExceeded('general'); // resetAt 1788969660 (= T0 + 31min)
  const ms = rl.msUntilReset('general');
  assert.ok(ms > 0, 'scheduled reset yields positive ms');
  assert.strictEqual(ms, (1788969660 * 1000) - T0_MS);
});

test('donation account limit is preserved across handleRateLimitExceeded', () => {
  const db = makeDb();
  rl.init(db);
  rl.updateFromHeaders('general', { 'x-rate-limit-remaining': '300', 'x-rate-limit-limit': '300' });
  assert.strictEqual(rl.isDonationAccount(), true);

  rl.handleRateLimitExceeded('general');
  assert.strictEqual(rl.getState().general.remaining, 0);
  assert.strictEqual(rl.getState().general.limit, 300, 'donation limit preserved');
  assert.strictEqual(rl.isDonationAccount(), true);
});

test('isRateLimitError matches the documented PVOutput 403 Exceeded body', () => {
  assert.strictEqual(rl.isRateLimitError(new Error('PVOutput 403: Forbidden 403: Exceeded number requests per hour limit reached')), true);
  assert.strictEqual(rl.isRateLimitError('Forbidden 403: Exceeded number requests per hour'), true);
  assert.strictEqual(rl.isRateLimitError(new Error('PVOutput 400: Invalid Time')), false);
  assert.strictEqual(rl.isRateLimitError(new Error('network down')), false);
});
