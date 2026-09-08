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

const ORIGINAL_FETCH = global.fetch;
let captured;

after(() => {
  global.fetch = ORIGINAL_FETCH;
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
