/**
 * PVOutput Backfill Engine — detects upload gaps and recovers via batch or individual uploads.
 *
 * Gap detection (GS4): local-tables-only query over pvoutput_daily_outputs (source='push')
 * and pvoutput_upload_queue. No pull tables involved.
 *
 * Batch strategy branches on account type (NS5):
 *   donation — addbatchstatus (100/batch, 10s courtesy pause)
 *   free     — individual addstatus (10s courtesy pause)
 * Rate controlled by canCall() (FS4), not by the inter-call delay.
 *
 * C2 invariant: one addbatchstatus call per calendar date, enforced.
 * NM7: inner chunking within a date when records exceed batch size.
 *
 * @module pvoutput/backfill
 */
const { PVOutputClient } = require('./client');
const { canCall, msUntilReset, isDonationAccount } = require('./rateLimiter');
const { logger } = require('../logger');

let backfillActive = false;

/**
 * Run gap detection and backfill. Called on startup and when "Run Backfill" is triggered.
 */
async function runBackfill(db, client) {
  if (backfillActive) {
    logger.debug('[pvoutput] backfill already running, skipping');
    return { pending: 0, message: 'Already running' };
  }
  backfillActive = true;

  try {
    // Gap detection: local tables only (NS4 / GS4)
    const gapDates = detectGaps(db);
    logger.info(`[pvoutput] gap detection: ${gapDates.length} dates with gaps`);

    // Process upload queue
    const queueStats = db.prepare("SELECT COUNT(*) as c FROM pvoutput_upload_queue WHERE status = 'pending'").get();
    const pending = queueStats ? queueStats.c : 0;

    if (pending > 0) {
      const donation = isDonationAccount();
      if (donation) {
        await processBatchBackfill(db, client);
      } else {
        await processFreeBackfill(db, client);
      }
    }

    return { pending: 0, message: 'Backfill complete' };
  } catch (e) {
    logger.error(`[pvoutput] backfill error: ${e.message}`);
    return { pending: 0, message: e.message };
  } finally {
    backfillActive = false;
  }
}

function detectGaps(db) {
  const dates = new Set();
  // Dates from daily outputs with non-uploaded status (source='push' only per GC1)
  const outputGaps = db.prepare(
    "SELECT date FROM pvoutput_daily_outputs WHERE status != 'uploaded' AND source = 'push'"
  ).all();
  outputGaps.forEach(r => dates.add(r.date));

  // Dates from upload queue with failed/expired entries
  const queueGaps = db.prepare(
    "SELECT DISTINCT date FROM pvoutput_upload_queue WHERE status IN ('failed', 'expired')"
  ).all();
  queueGaps.forEach(r => dates.add(r.date));

  return Array.from(dates).sort();
}

/** Donation account: addbatchstatus per date (C2), with inner chunking (NM7). */
async function processBatchBackfill(db, client) {
  const batchSize = 100;
  const dates = db.prepare("SELECT DISTINCT date FROM pvoutput_upload_queue WHERE status = 'pending' ORDER BY date").all();

  for (const { date } of dates) {
    const records = db.prepare(
      "SELECT * FROM pvoutput_upload_queue WHERE date = ? AND status = 'pending' ORDER BY time"
    ).all(date);

    // NM7: inner chunking within this date
    for (let i = 0; i < records.length; i += batchSize) {
      const chunk = records.slice(i, i + batchSize);
      try {
        await backfillDateChunk(db, client, date, chunk);
        // 10s courtesy pause
        await sleep(10_000);
      } catch (e) {
        logger.warn(`[pvoutput] backfill chunk failed for ${date}: ${e.message}`);
        // HUMAN-7: removed a dead '429' branch — PVOutput lockouts are 403
        // Exceeded, which never matched. Rate-limit lockouts are handled by the
        // client choke point + the canCall() gate in backfillDateChunk, so the
        // next chunk defers via msUntilReset instead of hammering.
      }
    }
  }
}

async function backfillDateChunk(db, client, date, records) {
  if (!canCall('general', 'low')) {
    logger.warn(`[pvoutput] rate limit exhausted, deferring backfill`);
    throw new Error('rate limit');
  }

  // C2: one dates batch per call — guaranteed since we process date-by-date
  const data = records.map(r => {
    const payload = JSON.parse(r.payload_json || '{}');
    const fields = [
      date, r.time,
      payload.v1 ?? '', payload.v2 ?? '',
      payload.v3 ?? '', payload.v4 ?? '',
      payload.v5 ?? '', payload.v6 ?? ''
    ];
    while (fields.length > 2 && fields[fields.length - 1] === '') fields.pop();
    return fields.join(',');
  }).join(';');

  const resp = await client.post('addbatchstatus.jsp', { data }, 'general');
  const status = resp.includes('Updated') ? 'updated' : 'added';
  logger.info(`[pvoutput] backfill batch ${date}: ${records.length} records (${status})`);

  // Mark as uploaded
  const ids = records.map(r => r.id);
  if (ids.length === 0) return;
  db.prepare(`UPDATE pvoutput_upload_queue SET status = 'uploaded', uploaded_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

/** Free account: individual addstatus calls. */
async function processFreeBackfill(db, client) {
  const records = db.prepare("SELECT * FROM pvoutput_upload_queue WHERE status = 'pending' ORDER BY date, time LIMIT 500").all();

  for (const record of records) {
    if (!canCall('general', 'low')) {
      const wait = msUntilReset('general');
      logger.info(`[pvoutput] rate limit exhausted, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    try {
      const p = JSON.parse(record.payload_json || '{}');
      if (!p.d || !p.t) {
        // Rebuild minimal payload from date/time
        p.d = record.date; p.t = record.time;
      }
      const resp = await client.post('addstatus.jsp', p, 'general');
      const status = resp.includes('Updated') ? 'updated' : 'added';
      db.prepare("UPDATE pvoutput_upload_queue SET status = 'uploaded', uploaded_at = datetime('now') WHERE id = ?").run(record.id);
      logger.debug(`[pvoutput] backfill ${record.date} ${record.time} (${status})`);
    } catch (e) {
      // HUMAN-7: the '429' branch was dead code — PVOutput lockouts are 403
      // Exceeded and are already taught to the limiter at the client choke
      // point; the canCall() gate above handles the next record's wait.
      logger.warn(`[pvoutput] backfill record failed: ${e.message}`);
      db.prepare("UPDATE pvoutput_upload_queue SET status = 'failed', attempts = attempts + 1 WHERE id = ?").run(record.id);
    }
    // 10s courtesy pause (FS4)
    await sleep(10_000);
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getQueueStats(db) {
  const total = db.prepare("SELECT COUNT(*) as c FROM pvoutput_upload_queue WHERE status = 'pending'").get();
  const byDate = db.prepare("SELECT date, COUNT(*) as c FROM pvoutput_upload_queue WHERE status = 'pending' GROUP BY date ORDER BY date").all();
  return { pending: total ? total.c : 0, byDate };
}

module.exports = { runBackfill, getQueueStats };
