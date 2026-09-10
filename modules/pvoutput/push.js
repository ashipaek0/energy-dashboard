/**
 * PVOutput Push Engine — uploads live status every N minutes and end-of-day summary.
 *
 * Live uploads align to the configured interval boundary with a 30s minimum startup delay.
 * EOD upload fires at 23:55 in the PVOutput system timezone via per-minute polling.
 * Retry logic (00:15, 01:00) uses the same polling loop, gated by DB-stored attempt count.
 *
 * @module pvoutput/push
 */
const { PVOutputClient } = require('./client');
const { buildStatusPayload, validatePayload, resolveEnergyUnit } = require('./mapper');
const { canCall, isRateLimitError } = require('./rateLimiter');
const { logger } = require('../logger');
const metricSanity = require('../metricSanity');

let pushInterval = null;
let eodInterval = null;
// AC-1: the startup-delay timer handle must be tracked so stop() can cancel a
// pending delay; an untracked timer used to survive stop() and later orphan the
// interval it created (N restarts inside the delay window → N upload loops).
let startupTimer = null;

function start(db, client, config, getMetricsFn) {
  // Idempotent by construction (AC-2): stop() clears any pending startup delay
  // and any live interval, so a second start()/restart always leaves exactly
  // one chain that will eventually fire.
  stop();

  const intervalMs = (config.upload_interval_minutes || 5) * 60 * 1000;
  // 30s minimum startup delay (M12)
  const msToBoundary = (intervalMs - (Date.now() % intervalMs)) % intervalMs;
  const delay = Math.max(msToBoundary, 30_000);

  startupTimer = setTimeout(() => {
    startupTimer = null;
    uploadStatus(db, client, config, getMetricsFn);
    pushInterval = setInterval(() => uploadStatus(db, client, config, getMetricsFn), intervalMs);
  }, delay);

  // EOD polling loop — per-minute check in PVOutput system timezone (S3)
  // Ensure today's push row exists (RM4)
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = getLocalDate(tz);
  db.prepare(
    `INSERT OR IGNORE INTO pvoutput_daily_outputs (date, status, attempts, source) VALUES (?, 'pending', 0, 'push')`
  ).run(todayStr);

  eodInterval = setInterval(() => {
    const { h, m } = getLocalTime(tz);
    const row = db.prepare('SELECT status, attempts FROM pvoutput_daily_outputs WHERE date = ? AND source = ?').get(todayStr, 'push');
    if (!row) return;
    const att = row.attempts;

    // FM5 lookup table
    let shouldFire = false;
    if (att === 0 && h === 23 && m === 55) shouldFire = true;
    else if (att === 1 && h === 0 && m === 15) shouldFire = true;
    else if (att === 2 && h === 1 && m === 0) shouldFire = true;

    if (shouldFire && row.status !== 'uploaded') {
      db.prepare('UPDATE pvoutput_daily_outputs SET attempts = attempts + 1 WHERE date = ? AND source = ?').run(todayStr, 'push');
      uploadEod(db, client, config);
    }
    if (att >= 3 && row.status !== 'uploaded' && row.status !== 'failed') {
      db.prepare("UPDATE pvoutput_daily_outputs SET status = 'failed' WHERE date = ? AND source = ?").run(todayStr, 'push');
    }
  }, 60_000);

  // Startup recovery: if past 23:55 and no row existed, fire EOD (HM5)
  const nowLocal = getLocalTime(tz);
  if (nowLocal.h >= 0 && (nowLocal.h > 23 || (nowLocal.h === 23 && nowLocal.m >= 55))) {
    const existingRow = db.prepare('SELECT status FROM pvoutput_daily_outputs WHERE date = ? AND source = ?').get(todayStr, 'push');
    if (!existingRow || existingRow.status !== 'uploaded') {
      db.prepare("UPDATE pvoutput_daily_outputs SET attempts = attempts + 1 WHERE date = ? AND source = ?").run(todayStr, 'push');
      uploadEod(db, client, config);
    }
  }
}

function stop() {
  // AC-1: cancel a pending startup delay so no interval can be born after stop().
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (pushInterval) { clearInterval(pushInterval); pushInterval = null; }
  if (eodInterval) { clearInterval(eodInterval); eodInterval = null; }
}

async function uploadStatus(db, client, config, getMetricsFn) {
  // #119 AC-10 [v2/N3]: normalise an explicit `null` too — a default parameter
  // only covers `undefined`. Without this, `config.system_size_w` threw inside
  // the try, the tick log-and-dropped as "upload failed", and the catch fell
  // through to queueForBackfill with a bogus payload.
  config = config || {};
  if (!canCall('general', 'high')) {
    // AC-10 (D3): rate-limit lockouts NEVER enqueue — log-and-drop; the next
    // interval tick retries and a newer tick supersedes an old status anyway.
    logger.warn('[pvoutput] rate limit window active — skipping status upload (not queued)');
    return;
  }
  try {
    const metrics = getMetricsFn();
    const now = new Date();
    const payload = buildStatusPayload(metrics, config, now);
    const systemSizeW = config.system_size_w || null;
    // #119 AC-10/AC-11: daily ceiling + no-regression vs last accepted value.
    const errors = validatePayload(payload, systemSizeW, guardOpts(config, now));
    if (errors.length > 0) {
      logger.warn(`[pvoutput] skipping upload: ${errors.join(', ')}`);
      return;
    }
    const resp = await client.post('addstatus.jsp', payload, 'general');
    const status = resp.includes('Updated') ? 'updated' : 'added';
    logger.debug(`[pvoutput] uploaded status at ${payload.t} (${status})`);
  } catch (err) {
    // AC-10 (D3): a 403-Exceeded lockout log-and-drops — the limiter was already
    // taught by the client choke point; queueing a hollow row would only feed
    // backfill replay into the next window.
    if (isRateLimitError(err)) {
      logger.warn(`[pvoutput] upload rate-limited (403 Exceeded) — dropping tick, retrying next interval`);
      return;
    }
    if (err.message.includes('No sun') || err.message.includes('400')) {
      logger.debug(`[pvoutput] upload skipped: ${err.message}`);
      return;
    }
    if (err.message.includes('401')) {
      logger.error('[pvoutput] invalid API key or system ID — disabling');
      return;
    }
    // Non-rate-limit (transient network/5xx) errors keep queueing for backfill.
    logger.warn(`[pvoutput] upload failed: ${err.message}`);
    queueForBackfill(db, {}, new Date(), err.message);
  }
}

async function uploadEod(db, client, config) {
  // #119 AC-10 [v2/N3]: `config = {}` as a default parameter does NOT cover an
  // explicit `null`; normalise before any property access.
  config = config || {};
  if (!canCall('general', 'high')) {
    logger.warn('[pvoutput] rate limit exhausted, EOD deferred');
    return;
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = getLocalDate(tz);
    // NC2: all EOD data from Epilykos history table
    const stats = db.prepare(
      `SELECT MAX(daily_solar) as daily_solar, MAX(solar) as peak_watts,
              MAX(daily_consumption) as daily_con
       FROM history WHERE date(timestamp, 'unixepoch') = ?`
    ).get(todayStr);
    if (!stats || stats.daily_solar == null) {
      logger.debug('[pvoutput] no history data for today, skipping EOD');
      return;
    }
    const peakRow = db.prepare(
      `SELECT timestamp FROM history WHERE date(timestamp, 'unixepoch') = ? ORDER BY solar DESC LIMIT 1`
    ).get(todayStr);
    let pt = '';
    if (peakRow) {
      const peakDate = new Date(peakRow.timestamp * 1000);
      pt = `${String(peakDate.getHours()).padStart(2, '0')}:${String(peakDate.getMinutes()).padStart(2, '0')}`;
    }
    const payload = {
      d: todayStr.replace(/-/g, ''),
      g: Math.round((stats.daily_solar || 0) * 1000), // kWh → Wh
      pp: Math.round(stats.peak_watts || 0),
      pt: pt || undefined,
      c: Math.round((stats.daily_con || 0) * 1000)
    };
    // #119 AC-10/AC-11: the addoutput path was previously unvalidated — apply
    // the same daily ceiling + no-regression rules before posting.
    const errors = validatePayload(payload, config.system_size_w || null, guardOpts(config, new Date()));
    if (errors.length > 0) {
      logger.warn(`[pvoutput] skipping EOD upload: ${errors.join(', ')}`);
      return;
    }
    const resp = await client.post('addoutput.jsp', payload, 'general');
    db.prepare(
      "UPDATE pvoutput_daily_outputs SET status = ? WHERE date = ? AND source = 'push'"
    ).run('uploaded', todayStr);
    logger.info(`[pvoutput] end-of-day output uploaded: ${resp.trim()}`);
  } catch (err) {
    logger.warn(`[pvoutput] EOD upload failed: ${err.message}`);
  }
}

/**
 * #119 — build the optional validatePayload checks: ceiling overrides from the
 * pvoutput config and the guard's last accepted same-day value (AC-11).
 * Never throws (AC-9): a guard error just means "no extra check".
 *
 * #119 AC-11 + #117 [unit-alignment fix]: the guard stores the metric's NATIVE
 * value, while `buildStatusPayload` converts it to Wh using the #117 per-field
 * selector. Resolve the SAME selector here (`resolveEnergyUnit`) and apply the
 * SAME conversion, so the `minV1Wh`/`minV3Wh` ceiling is on the exact scale of
 * the value the payload will post. Resolving from the metric catalogue instead
 * (the old `metricSanity.toWh`) could disagree with the selector — e.g.
 * catalogue kWh + `v1_unit:'Wh'` compared a 13 Wh payload against a 12500 Wh
 * floor and silently skipped EVERY upload.
 */
function guardOpts(config, date) {
  const cfg = config || {};
  const map = cfg.metric_map || {};
  const opts = {
    maxDailyKwh: cfg.max_daily_kwh != null ? cfg.max_daily_kwh : cfg['pvoutput.max_daily_kwh'],
    maxDailyConsumptionKwh: cfg.max_daily_consumption_kwh != null ? cfg.max_daily_consumption_kwh : cfg['pvoutput.max_daily_consumption_kwh']
  };
  try {
    const ts = date instanceof Date ? Math.floor(date.getTime() / 1000) : Math.floor(Date.now() / 1000);
    // Mirror buildStatusPayload's conversion exactly (kWh ⇒ ×1000, Wh ⇒ as-is),
    // sharing #117's D8 precedence rather than re-implementing it.
    const gv = metricSanity.getLastAccepted(map.v1, ts);
    if (gv != null && Number.isFinite(Number(gv))) {
      opts.minV1Wh = Math.round(resolveEnergyUnit(map, 'v1') === 'kWh' ? Number(gv) * 1000 : Number(gv));
    }
    const cv = metricSanity.getLastAccepted(map.v3, ts);
    if (cv != null && Number.isFinite(Number(cv))) {
      opts.minV3Wh = Math.round(resolveEnergyUnit(map, 'v3') === 'kWh' ? Number(cv) * 1000 : Number(cv));
    }
  } catch (_) { /* AC-9: never block an upload on a guard error */ }
  return opts;
}

function queueForBackfill(db, payload, date, reason) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rounded = new Date(date);
    rounded.setMinutes(rounded.getMinutes() - (rounded.getMinutes() % 5), 0, 0);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(rounded).map(p => [p.type, p.value]));
    db.prepare(
      `INSERT INTO pvoutput_upload_queue (date, time, payload_json, reason, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'))`
    ).run(`${parts.year}${parts.month}${parts.day}`, `${parts.hour}:${parts.minute}`, JSON.stringify(payload), reason);
  } catch (e) { /* non-critical */ }
}

function getLocalTime(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { h: parseInt(parts.hour), m: parseInt(parts.minute) };
}

function getLocalDate(timezone) {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

module.exports = { start, stop, uploadStatus, uploadEod, guardOpts };
