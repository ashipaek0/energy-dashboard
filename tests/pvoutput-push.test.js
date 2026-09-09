'use strict';

/**
 * Timer-lifecycle tests for the PVOutput push engine (issue #115 AC-1..3, AC-10).
 *
 * Bug 1 regression: the startup-delay setTimeout handle was never stored, so
 * stop() could not cancel a pending delay — a restart inside the ≤5-min delay
 * window stacked timers and each later fire orphaned the previous interval,
 * producing N concurrent upload loops. These tests prove via mock timers that
 * start()/stop()/restart() always leave exactly ONE active interval chain.
 *
 * AC-10: rate-limit lockouts (canCall false OR 403 Exceeded) log-and-drop —
 * they never write a hollow row to pvoutput_upload_queue.
 *
 * Run: node --test tests/pvoutput-push.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const push = require('../modules/pvoutput/push');
const rl = require('../modules/pvoutput/rateLimiter');
const { logger } = require('../modules/logger');

// 12:00:00 UTC sits exactly on a 5-min interval boundary → startup delay is
// deterministically the 30s floor; upload ticks every 5 minutes.
const BASE = Date.UTC(2026, 8, 9, 12, 0, 0);
const DELAY = 30_000;
const INTERVAL = 5 * 60_000;

const CONFIG = {
  upload_interval_minutes: 5,
  timezone: 'UTC',
  metric_map: { v1: 'solar_energy', v2: 'solar_power' },
  battery_enabled: false,
  net_mode: false,
  donation_mode: false
};
const METRICS = { solar_energy: 5000, solar_power: 1200 };

/** db stub: EOD rows read as already-uploaded (never fires), queue inserts counted. */
function makeDb() {
  const state = { queueInserts: 0 };
  return {
    state,
    prepare(sql) {
      return {
        get() {
          if (sql.includes('FROM pvoutput_daily_outputs')) return { status: 'uploaded', attempts: 0 };
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

const origLogger = { warn: logger.warn, error: logger.error, debug: logger.debug, info: logger.info };

beforeEach(() => {
  rl._test.reset(); // fresh pools: general remaining 60 → canCall true
  logger.warn = logger.error = logger.debug = logger.info = () => {};
});

afterEach(() => {
  push.stop();
  rl._test.reset();
});

async function flush(times = 3) {
  for (let i = 0; i < times; i++) await new Promise(r => setImmediate(r));
}

function makeClient() {
  const c = { posts: 0, postError: null };
  c.post = async () => {
    c.posts++;
    if (c.postError) throw c.postError;
    return 'OK 200: Added';
  };
  return c;
}

test('AC-1: stop() before the startup delay elapses → no interval is ever born (0 posts)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();

  push.start(db, client, CONFIG, () => METRICS);
  push.stop();

  t.mock.timers.tick(DELAY + 3 * INTERVAL);
  await flush();
  assert.strictEqual(client.posts, 0, 'no upload may fire after stop()');
  push.stop();
});

test('AC-1/AC-3: stop() after the loop is live → no further uploads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();

  push.start(db, client, CONFIG, () => METRICS);
  t.mock.timers.tick(DELAY); // loop born
  await flush();
  assert.strictEqual(client.posts, 1, 'first tick uploads once');

  push.stop();
  t.mock.timers.tick(4 * INTERVAL);
  await flush();
  assert.strictEqual(client.posts, 1, 'no further posts after stop()');
  push.stop();
});

test('AC-2: start() twice (no stop) → exactly one active loop, one post per tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();

  push.start(db, client, CONFIG, () => METRICS);
  push.start(db, client, CONFIG, () => METRICS);

  t.mock.timers.tick(DELAY);
  await flush();
  assert.strictEqual(client.posts, 1, 'exactly one upload after the (single) delay');

  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.strictEqual(client.posts, 2, 'one post per tick');

  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.strictEqual(client.posts, 3, 'one post per tick — no stacked loops');
  push.stop();
});

test('AC-2/AC-3: restart mid-loop tears the old chain down — one post per tick, old loop dead', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();

  push.start(db, client, CONFIG, () => METRICS);
  t.mock.timers.tick(DELAY);       // t = 12:00:30 → chain 1 live
  await flush();
  assert.strictEqual(client.posts, 1);

  t.mock.timers.tick(INTERVAL);    // t = 12:05:30 → chain 1 tick
  await flush();
  assert.strictEqual(client.posts, 2);

  push.start(db, client, CONFIG, () => METRICS); // restart: chain 1 torn down
  // new delay = 270s (aligned to 12:10:00) — 12:05:30 + 270s = 12:10:00
  t.mock.timers.tick(270_000);
  await flush();
  assert.strictEqual(client.posts, 3, 'new chain fires exactly once at its delay');

  // t = 12:10:00 + 5min = 12:15:00. A ghost chain-1 interval (born 12:00:30,
  // cadence 5min) would have fired at 12:10:30 inside this window → posts 5.
  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.strictEqual(client.posts, 4, 'exactly one post per tick after restart — old loop dead');

  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.strictEqual(client.posts, 5, 'still exactly one post per tick');
  push.stop();
});

test('AC-10: locked pool (canCall false) → tick logs and drops, never enqueues', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();

  rl.handleRateLimitExceeded('general', Math.floor(BASE / 1000) + 3600);
  assert.strictEqual(rl.canCall('general', 'high'), false);

  push.start(db, client, CONFIG, () => METRICS);
  t.mock.timers.tick(DELAY + INTERVAL); // delay tick + one interval tick
  await flush();

  assert.strictEqual(client.posts, 0, 'no network call while locked');
  assert.strictEqual(db.state.queueInserts, 0, 'rate-limit lockout must never enqueue a backfill row');
  push.stop();
});

test('AC-10: 403 Exceeded from addstatus → catch log-and-drops, never enqueues', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();
  client.postError = new Error('PVOutput 403: Forbidden 403: Exceeded number requests per hour limit reached');

  push.start(db, client, CONFIG, () => METRICS);
  t.mock.timers.tick(DELAY + INTERVAL);
  await flush();

  assert.ok(client.posts >= 1, 'upload was attempted');
  assert.strictEqual(db.state.queueInserts, 0, '403 Exceeded must not enqueue a backfill row');
  push.stop();
});

test('transient (non-rate-limit) failures still enqueue for backfill', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: BASE });
  const db = makeDb();
  const client = makeClient();
  client.postError = new Error('PVOutput 500: upstream blew up');

  push.start(db, client, CONFIG, () => METRICS);
  t.mock.timers.tick(DELAY);
  await flush();

  assert.strictEqual(client.posts, 1, 'upload was attempted');
  assert.strictEqual(db.state.queueInserts, 1, 'transient errors keep queueing per AC-10');
  push.stop();
});
