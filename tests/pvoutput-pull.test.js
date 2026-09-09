'use strict';

/**
 * Startup tests for the PVOutput pull engine (issue #115 AC-4..AC-6).
 *
 * AC-4: getsystem startup fetch is cache-gated on pvoutput_system.fetched_at
 *       (60-min window) — a warm row means ZERO startup GETs.
 * AC-5: populateHistory checks canCall before each getstatus and stops
 *       requesting remaining dates when a 403 Exceeded lands mid-loop.
 * AC-6: a locked pool at startup defers the initial fetches with a warn and
 *       makes zero network requests.
 *
 * Run: node --test tests/pvoutput-pull.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const pull = require('../modules/pvoutput/pull');
const rl = require('../modules/pvoutput/rateLimiter');
const { logger } = require('../modules/logger');

// getsystem.jsp text with >= 16 fields (lat/lng set → timezone derivation path)
const SYSTEM_TEXT = 'Test System,10000,2000,20,250,ACME,1,3000,ACME1,90,25,0,20200101,-33.87,151.21,5';
const CONFIG = { timezone: 'UTC' };

function makeDb(state) {
  return {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('FROM pvoutput_system')) return state.systemRow;
          if (sql.includes('FROM pvoutput_history') && sql.includes('COUNT(*)')) {
            return { c: state.historyCached ? 1 : 0 };
          }
          if (sql.includes("key = 'pvoutput_config'")) return { value: JSON.stringify({ timezone: 'UTC' }) };
          if (sql.includes('FROM pvoutput_daily_outputs')) return { status: 'uploaded' };
          return undefined;
        },
        run() { return { changes: 1 }; },
        all() { return []; }
      };
    }
  };
}

function makeClient(behavior) {
  const c = { gets: [] };
  c.get = async (endpoint, params) => {
    c.gets.push({ endpoint, params });
    if (behavior) return behavior(c.gets.length - 1, endpoint, params);
    if (endpoint === 'getsystem.jsp') return SYSTEM_TEXT;
    return ''; // empty getstatus body — GET counted, no records inserted
  };
  return c;
}

const origLogger = { warn: logger.warn, error: logger.error, debug: logger.debug, info: logger.info };
let warns = [];

beforeEach(() => {
  rl._test.reset(); // general remaining 60 → healthy
  warns = [];
  logger.warn = (...a) => { warns.push(a.join(' ')); };
  logger.error = logger.debug = logger.info = () => {};
});

afterEach(() => {
  pull.stop();
  rl._test.reset();
  logger.warn = origLogger.warn;
  logger.error = origLogger.error;
  logger.debug = origLogger.debug;
  logger.info = origLogger.info;
});

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await new Promise(r => setImmediate(r));
}

test('AC-4: warm pvoutput_system (fetched_at fresh) → zero startup GETs', async () => {
  const db = makeDb({
    systemRow: { system_id: 'sys1', system_name: 'Test System', fetched_at: new Date().toISOString() },
    historyCached: true // all 7 history dates already populated
  });
  const client = makeClient();

  pull.start(db, client, CONFIG);
  await flush();

  assert.strictEqual(client.gets.length, 0, 'warm cache must not hit the network');
});

test('AC-6: cold cache + locked pool → zero GETs and a single deferral warn', async () => {
  const db = makeDb({ systemRow: undefined, historyCached: false });
  const client = makeClient();

  rl.handleRateLimitExceeded('general', Math.floor(Date.now() / 1000) + 3600);
  assert.strictEqual(rl.canCall('general'), false, 'precondition: pool locked');

  pull.start(db, client, CONFIG);
  await flush();

  assert.strictEqual(client.gets.length, 0, 'locked pool must not burst startup fetches');
  const deferral = warns.filter(w => /deferring|deferred/.test(w));
  assert.ok(deferral.length >= 1, `expected a deferral warn, got: ${JSON.stringify(warns)}`);
});

test('AC-6: orchestrator skipInitial flag → no fetch and no duplicate warn', async () => {
  const db = makeDb({ systemRow: undefined, historyCached: false });
  const client = makeClient();

  rl.handleRateLimitExceeded('general', Math.floor(Date.now() / 1000) + 3600);
  pull.start(db, client, CONFIG, { skipInitial: true });
  await flush();

  assert.strictEqual(client.gets.length, 0);
  assert.strictEqual(warns.length, 0, 'orchestrator owns the single warn — pull stays silent');
});

test('AC-4/AC-5: cold cache + healthy pool → at most 8 startup GETs (1 getsystem + 7 getstatus)', async () => {
  const db = makeDb({ systemRow: undefined, historyCached: false });
  const client = makeClient();

  pull.start(db, client, CONFIG);
  await flush();

  assert.ok(client.gets.length <= 8, `expected ≤8 startup GETs, got ${client.gets.length}`);
  assert.strictEqual(client.gets[0].endpoint, 'getsystem.jsp', 'getsystem fires first on a cold cache');
  const history = client.gets.filter(g => g.endpoint === 'getstatus.jsp');
  assert.strictEqual(history.length, 7, 'cold history requests all 7 dates');
});

test('AC-5: 403 Exceeded at date i → remaining dates are not requested', async () => {
  const db = makeDb({ systemRow: undefined, historyCached: false });
  const client = makeClient((idx) => {
    if (idx === 3) {
      throw new Error('PVOutput 403: Forbidden 403: Exceeded number requests per hour limit reached');
    }
    return '';
  });

  await pull.populateHistory(db, client);
  await flush();

  assert.strictEqual(client.gets.length, 4, 'dates 0..3 requested, then the loop must stop');
  const dParams = client.gets.map(g => g.params.d);
  assert.strictEqual(new Set(dParams).size, 4, 'each requested date is distinct');
  const rateLimitWarn = warns.filter(w => /remaining history dates/.test(w));
  assert.ok(rateLimitWarn.length >= 1, `expected mid-loop rate-limit warn, got: ${JSON.stringify(warns)}`);
});

test('AC-5: locked pool mid-history → loop stops before any further getstatus', async () => {
  const db = makeDb({ systemRow: undefined, historyCached: false });
  const client = makeClient((idx) => {
    if (idx === 1) rl.handleRateLimitExceeded('general', Math.floor(Date.now() / 1000) + 3600);
    return '';
  });

  await pull.populateHistory(db, client);
  await flush();

  assert.strictEqual(client.gets.length, 2, 'after the pool locks, no further dates may be requested');
});
