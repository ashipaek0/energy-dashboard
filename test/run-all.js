#!/usr/bin/env node
/**
 * test/run-all.js — issue #108 AC-42: `npm test` fixture runner.
 *
 * Iterates every *.test.js under BOTH `test/` and `tests/` in the repo
 * SEQUENTIALLY (plain node, no framework — the fixtures themselves are plain-node
 * assert scripts with exit codes). Reports per-file PASS/FAIL (with the repo-root-
 * relative path, so the originating directory is unambiguous) plus an aggregate
 * line; the process exit code is non-zero when any fixture fails, so CI / `npm test`
 * gates on it.
 *
 * Additive by construction: any new *.test.js in either directory is auto-included;
 * nothing here assumes a fixture list. Fixtures that need a specific CWD run from the
 * repo root (they isolate themselves with fs.mkdtempSync where they need a scratch
 * dir — see metrics-manager-delete.test.js).
 *
 * Usage: node test/run-all.js   (or `npm test`)
 * Exit code: 0 = all green, 1 = at least one fixture failed.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Issue #120: suites live in BOTH the singular `test/` and the plural `tests/`
// tree, so scan both. The `.test.js` filter keeps helper/manual scripts sitting
// in those dirs (e.g. tests/rs232-simulator.js, tests/test-rs232-*.js) excluded,
// and any new *.test.js is auto-discovered (no fixture list to edit).
const TEST_DIRS = ['test', 'tests'];
const PER_FILE_TIMEOUT_MS = 180000; // generous: luxpower frame tests decode big frames

// Collect repo-root-relative paths (e.g. `test/foo.test.js`, `tests/foo.test.js`)
// so each PASS/FAIL line names the directory it came from.
const files = [];
for (const dir of TEST_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (/\.test\.js$/.test(f)) files.push(path.relative(ROOT, path.join(abs, f)));
  }
}
files.sort();

if (!files.length) {
  console.error(`run-all.js: no *.test.js fixtures found under ${TEST_DIRS.join('/, ')}/ — nothing to run.`);
  process.exit(1);
}

console.log(`run-all.js: scanning ${TEST_DIRS.join('/, ')}/ — ${files.length} fixture(s)\n`);

const results = [];
for (const file of files) {
  const filePath = path.join(ROOT, file); // `file` is already repo-root-relative
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
