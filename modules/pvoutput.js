/**
 * PVOutput Integration Module — bidirectional PVOutput.org data sync.
 *
 * PUSH: uploads live status every 5 min + end-of-day summary at 23:55.
 * PULL: fetches system info, statistics, history, and daily outputs.
 * BACKFILL: detects upload gaps and recovers via batch or individual uploads.
 * WEBHOOK: receives alert callbacks from PVOutput (optional, requires public URL).
 *
 * Exports start()/stop()/restart(), a router for protected API routes,
 * and a webhook router for the public callback endpoint.
 *
 * @module pvoutput
 */
const express = require('express');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { init: initRateLimiter, canCall } = require('./pvoutput/rateLimiter');
const { PVOutputClient } = require('./pvoutput/client');
const { start: startPush, stop: stopPush } = require('./pvoutput/push');
const { start: startPull, stop: stopPull, fetchSystemInfo } = require('./pvoutput/pull');
const { runBackfill, getQueueStats } = require('./pvoutput/backfill');
const { createRouter: createWebhookRouter } = require('./pvoutput/webhook');
const { getCurrentMetrics } = require('./metrics');

let client = null;
let config = null;
let webhookRouter = null;

function start() {
  const db = getDb();
  const raw = getConfig('pvoutput_config');
  if (!raw || raw === '') return;

  try { config = JSON.parse(raw); } catch (e) { logger.error('[pvoutput] invalid config JSON'); return; }
  if (!config.enabled) return;
  if (!config.api_key || !config.system_id) {
    logger.warn('[pvoutput] API key or system ID not configured');
    return;
  }

  initRateLimiter(db);
  client = new PVOutputClient(config.api_key, config.system_id);

  // AC-6: when the pool is locked at startup (remaining <= 0 / cooldown), do no
  // burst — defer the initial pulls and queue backfill with a single warn log;
  // nothing retries until the window recovers (canCall() lazily self-heals on
  // the next restart once resetAt passes). startPull() receives skipInitial so
  // it stays silent and this remains the one warn.
  const poolLocked = !canCall('general');
  if (poolLocked) {
    logger.warn('[pvoutput] rate-limit window active at startup — deferring system-info/history fetches and queue backfill until reset');
  }

  startPush(db, client, config, getCurrentMetrics);
  startPull(db, client, config, { skipInitial: poolLocked });

  // Run backfill for any pending queue items from previous runs
  if (!poolLocked) {
    runBackfill(db, client).catch(e => logger.warn(`[pvoutput] startup backfill: ${e.message}`));
  }

  logger.info(`[pvoutput] started — uploading every ${config.upload_interval_minutes || 5}min`);
}

function stop() {
  stopPush();
  stopPull();
}

function restart() {
  stop();
  start();
}

// Protected API router (SC1)
const apiRouter = express.Router();

apiRouter.get('/status', (req, res) => {
  try {
    const { getState } = require('./pvoutput/rateLimiter');
    const qs = getQueueStats(getDb());
    res.json({
      enabled: config ? config.enabled : false,
      rate_limits: getState(),
      queue: qs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/test', async (req, res) => {
  const { api_key, system_id } = req.body;
  if (!api_key || !system_id) return res.status(400).json({ error: 'API key and system ID required' });
  try {
    const testClient = new PVOutputClient(api_key, system_id);
    // force: true — the test endpoint must always be a live fetch (AC-4),
    // never satisfied from the pvoutput_system cache gate.
    const info = await fetchSystemInfo(getDb(), testClient, { force: true });
    const { getState } = require('./pvoutput/rateLimiter');
    res.json({ success: true, system_name: info.system_name, system_size: info.system_size, timezone: info.timezone, rate_limits: getState() });
  } catch (err) {
    logger.warn(`[pvoutput] test failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/queue', (req, res) => {
  try { res.json(getQueueStats(getDb())); } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/backfill', async (req, res) => {
  if (!client) return res.status(400).json({ error: 'PVOutput not configured' });
  try {
    const result = await runBackfill(getDb(), client);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/history', (req, res) => {
  try {
    const db = getDb();
    const d = req.query.d;
    if (!d) return res.status(400).json({ error: 'Date parameter ?d=yyyymmdd required' });
    const rows = db.prepare('SELECT * FROM pvoutput_history WHERE date = ? ORDER BY time ASC').all(d);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'pvoutput_stats_cache'").get();
    if (row) res.json(JSON.parse(row.value));
    else res.json({ error: 'No stats cached yet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/delete', (req, res) => {
  if (!client) return res.status(400).json({ error: 'PVOutput not configured' });
  const { d, t } = req.body;
  if (!d) return res.status(400).json({ error: 'Date (d=yyyymmdd) required' });
  client.post('deletestatus.jsp', { d, t: t || undefined }, 'general')
    .then(text => res.json({ success: true, message: text.trim() }))
    .catch(err => res.status(500).json({ error: err.message }));
});

apiRouter.get('/alerts', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM pvoutput_alerts ORDER BY received_at DESC LIMIT 100').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/alerts/:id/ack', (req, res) => {
  try {
    getDb().prepare('UPDATE pvoutput_alerts SET acknowledged = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  start,
  stop,
  restart,
  router: apiRouter,         // protected API routes (SC1)
  get webhookRouter() {      // lazy-init webhook router
    if (!webhookRouter) webhookRouter = createWebhookRouter(getDb(), getConfig);
    return webhookRouter;
  }
};
