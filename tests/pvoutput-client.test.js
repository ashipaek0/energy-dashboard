'use strict';

/**
 * Tests for the PVOutput HTTP client (issue #114 — POST bodies must carry an
 * explicit Content-Type of application/x-www-form-urlencoded).
 *
 * Node fetch defaults string bodies to text/plain;charset=UTF-8, which
 * PVOutput's addstatus rejects (400 Invalid Time). The header is set inline in
 * post() only; GET must remain unchanged (X-Pvoutput auth headers only).
 *
 * Run: node --test tests/pvoutput-client.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const { PVOutputClient } = require('../modules/pvoutput/client');
const rl = require('../modules/pvoutput/rateLimiter');

const ORIGINAL_FETCH = global.fetch;
let captured;

after(() => {
  global.fetch = ORIGINAL_FETCH;
  rl._test.reset(); // undo pool mutations from the 403 choke-point tests
});

test('post() sends Content-Type application/x-www-form-urlencoded', async () => {
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response('OK 200: Added Status', {
      status: 200,
      headers: {
        'X-Rate-Limit-Limit': '60',
        'X-Rate-Limit-Remaining': '59',
        'X-Rate-Limit-Reset': '3600'
      }
    });
  };

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  const text = await client.post('addstatus.jsp', { d: '20260908', t: '18:55', v1: 8 }, 'general');

  assert.strictEqual(text, 'OK 200: Added Status');
  assert.strictEqual(captured.opts.method, 'POST');
  assert.strictEqual(
    captured.opts.headers['Content-Type'],
    'application/x-www-form-urlencoded',
    'post() must send the explicit form Content-Type header'
  );
  assert.strictEqual(captured.opts.headers['X-Pvoutput-Apikey'], 'test-api-key');
  assert.strictEqual(captured.opts.headers['X-Pvoutput-SystemId'], 'test-system-id');
  assert.strictEqual(captured.opts.body, 'd=20260908&t=18%3A55&v1=8');
  assert.strictEqual(captured.url, 'https://pvoutput.org/service/r2/addstatus.jsp');
});

test('get() headers remain unchanged (no Content-Type on GET)', async () => {
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response('OK 200: System', {
      status: 200,
      headers: {
        'X-Rate-Limit-Limit': '60',
        'X-Rate-Limit-Remaining': '59',
        'X-Rate-Limit-Reset': '3600'
      }
    });
  };

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  const text = await client.get('getsystem.jsp', { sid: 1 }, 'general');

  assert.strictEqual(text, 'OK 200: System');
  assert.strictEqual(captured.opts.headers['X-Pvoutput-Apikey'], 'test-api-key');
  assert.strictEqual(captured.opts.headers['X-Pvoutput-SystemId'], 'test-system-id');
  assert.ok(
    !('Content-Type' in captured.opts.headers),
    'get() must not add a Content-Type header'
  );
  assert.strictEqual(captured.opts.method, undefined);
});

test('AC-9: every request carries X-Rate-Limit: 1 so PVOutput returns rate headers', async () => {
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response('OK 200', { status: 200, headers: { 'X-Rate-Limit-Limit': '60' } });
  };

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  await client.get('getsystem.jsp', {}, 'general');
  assert.strictEqual(captured.opts.headers['X-Rate-Limit'], '1', 'GET must opt in to rate headers');
  await client.post('addstatus.jsp', { d: '20260909', t: '12:00', v1: 1 }, 'general');
  assert.strictEqual(captured.opts.headers['X-Rate-Limit'], '1', 'POST must opt in to rate headers');
});

test('AC-9: successful responses update the limiter from real Headers instances', async () => {
  global.fetch = async () => new Response('OK 200: Added', {
    status: 200,
    headers: {
      'X-Rate-Limit-Limit': '60',
      'X-Rate-Limit-Remaining': '59',
      'X-Rate-Limit-Reset': '1788969600'
    }
  });

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  rl._test.reset();
  await client.post('addstatus.jsp', { d: '20260909', t: '12:00', v1: 1 }, 'general');
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 59, 'remaining parsed from fetch Headers (property access is undefined)');
  assert.strictEqual(st.limit, 60);
  assert.strictEqual(st.resetAt, 1788969600);
});

test('AC-7: 403 Exceeded body at the client choke point teaches the limiter (prefers X-Rate-Limit-Reset) before throwing', async () => {
  global.fetch = async () => new Response(
    'Forbidden 403: Exceeded number requests per hour limit reached',
    {
      status: 403,
      headers: {
        'X-Rate-Limit-Limit': '60',
        'X-Rate-Limit-Remaining': '-237',
        'X-Rate-Limit-Reset': '1788969600'
      }
    }
  );

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  rl._test.reset();
  await assert.rejects(
    () => client.post('addstatus.jsp', { d: '20260909', t: '12:00', v1: 1 }, 'general'),
    /PVOutput 403/
  );
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 0, 'handleRateLimitExceeded zeroes remaining');
  assert.strictEqual(st.resetAt, 1788969600, 'server X-Rate-Limit-Reset preferred over the hour-boundary fallback');
  assert.strictEqual(rl.canCall('general', 'high'), false, 'pool is hard-locked after the 403');
  rl._test.reset();
});

test('AC-7: 403 Exceeded with NO rate headers still locks the pool via the D1 fallback reset', async () => {
  global.fetch = async () => new Response(
    'Forbidden 403: Exceeded number requests per hour. Please wait until the next hour.',
    { status: 403 }
  );

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  rl._test.reset();
  await assert.rejects(
    () => client.get('getsystem.jsp', {}, 'general'),
    /PVOutput 403/
  );
  const st = rl.getState().general;
  assert.strictEqual(st.remaining, 0);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(st.resetAt > now, `D1 fallback resetAt must be in the future (got ${st.resetAt}, now ${now})`);
  assert.ok(st.resetAt <= now + 3720, 'fallback capped at next hour boundary + 60s');
  rl._test.reset();
});

test('403 non-Exceeded bodies do not lock the pool (still throw)', async () => {
  global.fetch = async () => new Response('Forbidden 403: System is suspended', { status: 403 });

  const client = new PVOutputClient('test-api-key', 'test-system-id');
  rl._test.reset();
  await assert.rejects(() => client.get('getsystem.jsp', {}, 'general'), /PVOutput 403/);
  assert.strictEqual(rl.canCall('general'), true, 'unrelated 403 must not zero the pool');
  rl._test.reset();
});
