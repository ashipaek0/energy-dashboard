const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../modules/database');

test('buildDashboardState — verifies metrics contract is an object with { value, type, timestamp, unit }', async () => {
  initializeDatabase();
  const db = getDb();

  // Seed sample latest metric
  db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, value_type, timestamp, unit) VALUES (?, ?, ?, ?, ?)').run(
    'test_power_watt', 1250, 'number', Math.floor(Date.now() / 1000), 'W'
  );

  const { buildDashboardState } = require('../routes/metrics');
  const state = await buildDashboardState();

  assert.ok(state, 'buildDashboardState should return a state object');
  assert.ok(state.metrics, 'state.metrics should exist');
  assert.ok(state.metrics.test_power_watt, 'state.metrics.test_power_watt should exist');

  const entry = state.metrics.test_power_watt;
  assert.equal(typeof entry, 'object', 'metric entry in state.metrics must be an object, not a raw primitive');
  assert.equal(entry.value, 1250, 'entry.value should match seeded value');
  assert.equal(entry.type, 'number', 'entry.type should match seeded type');
  assert.equal(entry.unit, 'W', 'entry.unit should match seeded unit');
});
