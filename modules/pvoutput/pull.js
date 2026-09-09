/**
 * PVOutput Pull Engine — fetches system info, statistics, and history from PVOutput.
 *
 * Scheduled operations:
 *   getsystem   — on startup (validate credentials, cache system info including timezone)
 *   getstatistic — daily at 01:00 (lifetime stats, cached in config table)
 *   getoutput   — daily at 01:30 (last 30 days of daily outputs)
 *   getstatus   — on startup, cache-gated per date (last 7 days for dashboard history)
 *
 * @module pvoutput/pull
 */
const { PVOutputClient } = require('./client');
const { canCall, isRateLimitError } = require('./rateLimiter');
const { logger } = require('../logger');

// D2: startup getsystem cache gate — re-fetch at most once per 60 minutes
// unless no row exists yet or the caller forces a live fetch (/api/pvoutput/test).
const SYSTEM_CACHE_TTL_MS = 60 * 60 * 1000;

let dailyInterval = null;

/**
 * Start the pull engine. The startup burst (getsystem + 7-date history) only
 * runs when the rate-limit pool allows it — AC-6: a locked pool defers the
 * initial fetches (single warn) and nothing retries until the window recovers.
 * `opts.skipInitial` is set by the pvoutput orchestrator when it has already
 * decided the pool is locked (so the warn is logged exactly once, up-stack).
 */
function start(db, client, config, opts = {}) {
  stop();

  if (opts.skipInitial === true) {
    logger.debug('[pvoutput] initial pulls deferred (rate-limit window active)');
  } else if (canCall('general')) {
    // Fetch system info on startup (shared with test endpoint, M8)
    fetchSystemInfo(db, client).catch(e => logger.warn(`[pvoutput] getsystem failed: ${e.message}`));
    // 7-day status history — cache-gated per date (GS3)
    populateHistory(db, client).catch(e => logger.warn(`[pvoutput] history fetch failed: ${e.message}`));
  } else {
    logger.warn('[pvoutput] rate limit window locked at startup — deferring system-info and history fetches until it recovers');
  }

  // Daily pulls at 01:00, 01:30 — evaluated in PVOutput system timezone (S3/S6)
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  dailyInterval = setInterval(() => {
    const { h, m } = getLocalTime(tz);
    if (h === 1 && m === 0) {
      fetchStatistics(db, client).catch(e => logger.warn(`[pvoutput] getstatistic failed: ${e.message}`));
    }
    if (h === 1 && m === 30) {
      fetchDailyOutputs(db, client).catch(e => logger.warn(`[pvoutput] getoutput failed: ${e.message}`));
    }
  }, 60_000);
}

function stop() {
  if (dailyInterval) { clearInterval(dailyInterval); dailyInterval = null; }
}

/**
 * Parse a SQLite datetime('now') value ('YYYY-MM-DD HH:MM:SS', UTC) or an ISO
 * string into epoch ms. Returns NaN when unparseable.
 */
function parseDbDate(str) {
  if (!str) return NaN;
  const s = String(str).trim().replace(' ', 'T');
  return Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
}

function isCacheFresh(fetchedAt, ttlMs, now = Date.now()) {
  const t = parseDbDate(fetchedAt);
  return Number.isFinite(t) && (now - t) < ttlMs;
}

/**
 * Fetch system info from PVOutput. Shared between startup and test endpoint (M8).
 *
 * AC-4 (D2): cache-gated on pvoutput_system.fetched_at — skips the live GET
 * when the stored row is newer than SYSTEM_CACHE_TTL_MS (60 min) and a row
 * exists. Pass `{ force: true }` (the /api/pvoutput/test endpoint does) to
 * always hit the network. Returns the stored row on a cache hit, or the parsed
 * info object after a live fetch.
 */
async function fetchSystemInfo(db, client, opts = {}) {
  const force = opts === true || (opts && opts.force === true);

  if (!force) {
    const row = db.prepare('SELECT * FROM pvoutput_system WHERE system_id = ?').get(client.systemId);
    if (row && row.fetched_at && isCacheFresh(row.fetched_at, SYSTEM_CACHE_TTL_MS)) {
      logger.debug(`[pvoutput] getsystem cache hit (fetched_at ${row.fetched_at}) — skipping live fetch`);
      return row;
    }
  }

  const text = await client.get('getsystem.jsp', {}, 'general');
  const fields = text.trim().split(',');
  if (fields.length < 16) throw new Error('unexpected getsystem response');

  const info = {
    system_name: fields[0],
    system_size: parseInt(fields[1]) || 0,
    postcode: fields[2],
    num_panels: parseInt(fields[3]) || 0,
    panel_power: parseInt(fields[4]) || 0,
    panel_brand: fields[5],
    num_inverters: parseInt(fields[6]) || 0,
    inverter_power: parseInt(fields[7]) || 0,
    inverter_brand: fields[8],
    orientation: fields[9],
    array_tilt: fields[10],
    shade: fields[11],
    install_date: fields[12],
    latitude: parseFloat(fields[13]) || null,
    longitude: parseFloat(fields[14]) || null,
    status_interval: parseInt(fields[15]) || 5
  };

  // Derive timezone from lat/lng using geo-tz (S6)
  let timezone = null;
  try {
    const { find } = require('geo-tz');
    if (info.latitude != null && info.longitude != null) {
      const tzs = find(info.latitude, info.longitude);
      if (tzs && tzs.length > 0) timezone = tzs[0];
    }
  } catch (e) { /* geo-tz not available */ }
  if (!timezone) {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    logger.warn('[pvoutput] could not determine timezone from coordinates, falling back to server local');
  }
  info.timezone = timezone;

  db.prepare(`INSERT OR REPLACE INTO pvoutput_system
    (system_id, system_name, system_size, postcode, install_date, latitude, longitude, status_interval, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(client.systemId, info.system_name, info.system_size, info.postcode, info.install_date,
         info.latitude, info.longitude, info.status_interval);

  // Auto-fill timezone in config if not manually set (NM6)
  const configRow = db.prepare("SELECT value FROM config WHERE key = 'pvoutput_config'").get();
  if (configRow) {
    try {
      const cfg = JSON.parse(configRow.value);
      if (!cfg.timezone && timezone) {
        cfg.timezone = timezone;
        db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pvoutput_config', ?)").run(JSON.stringify(cfg));
        logger.info(`[pvoutput] auto-detected timezone: ${timezone}`);
      }
    } catch (e) { /* non-critical */ }
  }

  return info;
}

/**
 * Fetch 7-day status history — cache-gated per date (GS3).
 * AC-5: checks canCall('general') before EACH getstatus; on a rate-limit
 * failure mid-loop it stops requesting the remaining dates (no cascade of
 * 403s). Per-date failures never reject — startup cannot crash on history.
 */
async function populateHistory(db, client) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (let i = 0; i < 7; i++) {
    // AC-5/AC-6: never request another date while the window is locked.
    if (!canCall('general')) {
      logger.warn('[pvoutput] rate limit window active — stopping history fetch');
      break;
    }
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: tz });
    const dateCompact = dateStr.replace(/-/g, '');

    // Cache gate: skip if already populated
    const existing = db.prepare('SELECT COUNT(*) as c FROM pvoutput_history WHERE date = ?').get(dateStr);
    if (existing && existing.c > 0) continue;

    try {
      const text = await client.get('getstatus.jsp', { d: dateCompact, h: 1, limit: 288, asc: 1 }, 'general');
      const insert = db.prepare(`INSERT OR IGNORE INTO pvoutput_history
        (date, time, energy_gen, power_gen, energy_con, power_con, efficiency, temperature, voltage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const records = text.trim().split(';').filter(r => r);
      for (const record of records) {
        const cols = record.split(',');
        if (cols.length < 8) continue;
        insert.run(
          cols[0], cols[1],
          parseInt(cols[2]) || null, parseInt(cols[3]) || null,
          parseInt(cols[4]) || null, parseInt(cols[5]) || null,
          parseFloat(cols[6]) || null, parseFloat(cols[7]) || null,
          parseFloat(cols[8]) || null
        );
      }
      logger.debug(`[pvoutput] fetched history for ${dateStr}: ${records.length} records`);
    } catch (e) {
      if (isRateLimitError(e)) {
        // AC-5: 403 Exceeded mid-loop — stop requesting the remaining dates.
        logger.warn(`[pvoutput] rate limited fetching ${dateStr} — skipping remaining history dates`);
        break;
      }
      logger.warn(`[pvoutput] history fetch for ${dateStr} failed: ${e.message}`);
    }
  }
}

/** Fetch aggregate statistics (cached 24h by PVOutput). */
async function fetchStatistics(db, client) {
  try {
    const text = await client.get('getstatistic.jsp', { c: 1 }, 'statistic');
    const fields = text.trim().split(',');
    if (fields.length < 11) return;
    const stats = {
      energy_gen: parseInt(fields[0]) || 0,
      energy_eff: parseFloat(fields[1]) || 0,
      energy_exp: parseInt(fields[2]) || 0,
      energy_imp: parseInt(fields[3]) || 0,
      avg_power: parseInt(fields[4]) || 0,
      best_day_eff: parseFloat(fields[6]) || 0,
      best_day_start: fields[7] || null,
      best_day_end: fields[8] || null,
      alltime_eff: parseFloat(fields[9]) || 0,
      alltime_date: fields[10] || null,
      fetched_at: new Date().toISOString()
    };
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pvoutput_stats_cache', ?)")
      .run(JSON.stringify(stats));
    logger.debug(`[pvoutput] statistics cached: ${stats.energy_gen} Wh lifetime`);
  } catch (e) {
    logger.warn(`[pvoutput] getstatistic failed: ${e.message}`);
  }
}

/** Fetch last 30 days of daily output records for monthly chart. */
async function fetchDailyOutputs(db, client) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const df = startDate.toLocaleDateString('en-CA', { timeZone: tz }).replace(/-/g, '');
    const dt = endDate.toLocaleDateString('en-CA', { timeZone: tz }).replace(/-/g, '');

    const text = await client.get('getoutput.jsp', { df, dt, c: 1, limit: 30 }, 'general');
    const records = text.trim().split(';').filter(r => r);
    const insert = db.prepare(`INSERT OR IGNORE INTO pvoutput_daily_outputs
      (date, energy_gen, peak_power, peak_time, energy_con, temperature_min, temperature_max, condition, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 'pull')`);
    for (const record of records) {
      const cols = record.split(',');
      if (cols.length < 9) continue;
      const dateStr = `${cols[0].slice(0, 4)}-${cols[0].slice(4, 6)}-${cols[0].slice(6, 8)}`;
      insert.run(
        dateStr, parseInt(cols[1]) || null, parseInt(cols[5]) || null, cols[6] || null,
        parseInt(cols[12]) || null, parseFloat(cols[8]) || null, parseFloat(cols[9]) || null, cols[7] || null
      );
    }
    logger.debug(`[pvoutput] daily outputs fetched: ${records.length} records`);
  } catch (e) {
    logger.warn(`[pvoutput] getoutput failed: ${e.message}`);
  }
}

module.exports = { start, stop, fetchSystemInfo, populateHistory };

function getLocalTime(timezone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { h: parseInt(parts.hour), m: parseInt(parts.minute) };
}
