#!/usr/bin/env node
/**
 * test/run-all.js — issue #108 AC-42: `npm test` fixture runner.
 *
 * Iterates every test/*.test.js in the repo SEQUENTIALLY (plain node, no
 * framework — the fixtures themselves are plain-node assert scripts with
 * exit codes). Reports per-file PASS/FAIL plus an aggregate line; the process
 * exit code is non-zero when any fixture fails, so CI / `npm test` gates on it.
 *
 * Additive by construction: any new test/*.test.js is auto-included; nothing
 * here assumes a fixture list. Fixtures that need a specific CWD run from the
 * repo root (they isolate themselves with fs.mkdtempSync where they need a
 * scratch dir — see metrics-manager-delete.test.js).
 *
 * Usage: node test/run-all.js   (or `npm test`)
 * Exit code: 0 = all green, 1 = at least one fixture failed.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = __dirname;
const PER_FILE_TIMEOUT_MS = 180000; // generous: luxpower frame tests decode big frames

const files = fs.readdirSync(TEST_DIR)
  .filter(f => /\.test\.js$/.test(f))
  .sort();

if (!files.length) {
  console.error('run-all.js: no test/*.test.js fixtures found — nothing to run.');
  process.exit(1);
}

console.log(`run-all.js: ${files.length} fixture(s) under ${path.relative(ROOT, TEST_DIR)}/\n`);

const results = [];
for (const file of files) {
  const filePath = path.join(TEST_DIR, file);
  const t0 = Date.now();
  // Inherit env (NODE_PATH etc. may be set by callers); run from the repo root
  // like the historical manual invocations did.
  const r = spawnSync(process.execPath, [filePath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: PER_FILE_TIMEOUT_MS,
    env: Object.assign({}, process.env, { NODE_NO_WARNINGS: '1' })
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ file, ok, ms });

  // Stream the fixture's own output so PASS/FAIL detail stays visible inline.
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.error(`[FAIL] ${file} — timed out after ${PER_FILE_TIMEOUT_MS / 1000}s`);
  } else if (!ok) {
    console.error(`[FAIL] ${file} — exited with status ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}`);
  } else {
    console.log(`[PASS] ${file} — ${ms}ms\n`);
  }
}

const passed = results.filter(x => x.ok).length;
const failed = results.length - passed;
console.log('----------------------------------------');
console.log(`run-all.js: ${passed}/${results.length} fixtures passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
