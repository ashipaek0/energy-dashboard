/**
 * Energy Metrics & Telemetry Routes
 *
 * Provides REST API endpoints for current power state, time-series history,
 * daily/monthly energy rollups, grid timeline, solar forecasts, and dashboard configurations.
 *
 * @module routes/metrics
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, getDb } = require('../modules/database');
const { computeTodaySolar, getSolarForecast } = require('../modules/solar');
const { getGridHours, getGridTimeline, getCurrentGridStatus } = require('../modules/grid');
const { getSavings } = require('../modules/savings');
const metricSanity = require('../modules/metricSanity');
const { getDashboardConfig } = require('../modules/dashboard-config');

const router = express.Router();

const POWER_HISTORY_BUCKET_SECONDS = 600;

async function buildDashboardState() {
  const db = getDb();
  const start = Date.now();
  const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
  const dailySolarKwh = computeTodaySolar();
  const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
  const rate = parseFloat(rateRow?.value) || 0.30;
  const curr = getConfig('savings_currency') || '€';
  const allTimeSolar = db.prepare(`SELECT SUM(daily_solar) as total FROM (SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch'))`).get();
  const allTimeSavings = (allTimeSolar?.total || 0) * rate;

  const currentData = latest ? {
    consumption_kw: latest.consumption / 1000,
    solar_kw: latest.solar / 1000,
    battery_charge_kw: latest.battery_charge / 1000,
    battery_discharge_kw: latest.battery_discharge / 1000,
    battery_power_kw: (latest.battery_charge - latest.battery_discharge) / 1000,
    grid_import_kw: latest.grid_import / 1000,
    grid_export_kw: latest.grid_export / 1000,
    battery_soc: latest.battery_soc,
    daily_consumption_kwh: latest.daily_consumption,
    daily_solar_kwh: dailySolarKwh,
    daily_battery_charge_kwh: latest.daily_battery_charge,
    daily_battery_discharge_kwh: latest.daily_battery_discharge,
    daily_grid_import_kwh: latest.daily_grid_import,
    daily_grid_export_kwh: latest.daily_grid_export,
    savings_currency: curr,
    savings_rate: rate,
    today_savings: dailySolarKwh * rate,
    all_time_savings: allTimeSavings,
    timestamp: latest.timestamp * 1000
  } : null;

  const metricsRows = db.prepare('SELECT * FROM latest_metrics').all();
  const metrics = {};
  for (const row of metricsRows) {
    if (row.value_type === 'string' || row.value_type === 'boolean') {
      metrics[row.metric] = row.value_text;
    } else {
      metrics[row.metric] = row.value;
    }
  }

  const gridStatus = getCurrentGridStatus();
  const now = Math.floor(Date.now() / 1000);
  const powerHistorySince = now - 86400;
  const barSince = now - (7 * 86400);

  const [savings, historyRows, barRows] = await Promise.all([
    getSavings(),
    Promise.resolve(db.prepare(`
      SELECT
        (timestamp / ${POWER_HISTORY_BUCKET_SECONDS}) * ${POWER_HISTORY_BUCKET_SECONDS} as timestamp,
        AVG(consumption) as consumption,
        AVG(solar) as solar,
        AVG(battery_charge) as battery_charge,
        AVG(battery_discharge) as battery_discharge,
        AVG(grid_import) as grid_import,
        AVG(grid_export) as grid_export,
        AVG(battery_soc) as battery_soc
      FROM history WHERE timestamp >= ?
      GROUP BY (timestamp / ${POWER_HISTORY_BUCKET_SECONDS})
      ORDER BY timestamp ASC
    `).all(powerHistorySince)),
    Promise.resolve(db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history WHERE timestamp >= ?
      GROUP BY day ORDER BY day ASC
    `).all(barSince))
  ]);

  const [gridHoursDay, gridHoursWeek, gridHoursMonth, gridHoursYear, gridTimeline] = gridStatus.configured
    ? await Promise.all([
        getGridHours('day'), getGridHours('week'), getGridHours('month'), getGridHours('year'),
        getGridTimeline('24h')
      ])
    : [0, 0, 0, 0, { configured: false, available: false, segments: [], windowStart: 0, windowEnd: 0 }];

  const gridHours = {
    day: gridHoursDay,
    week: gridHoursWeek,
    month: gridHoursMonth,
    year: gridHoursYear,
    configured: gridStatus.configured,
    available: gridStatus.available
  };

  const powerHistory = historyRows.map(r => ({
    timestamp: r.timestamp * 1000,
    consumption_kw: r.consumption / 1000,
    solar_kw: r.solar / 1000,
    battery_charge_kw: r.battery_charge / 1000,
    battery_discharge_kw: r.battery_discharge / 1000,
    battery_power_kw: (r.battery_charge - r.battery_discharge) / 1000,
    grid_import_kw: r.grid_import / 1000,
    grid_export_kw: r.grid_export / 1000
  }));

  const dailyEnergyBar = barRows.map(r => ({
    day: r.day,
    solar_kwh: r.solar_kwh,
    consumption_kwh: r.consumption_kwh,
    battery_charge_kwh: r.battery_charge_kwh,
    battery_discharge_kwh: r.battery_discharge_kwh,
    grid_import_kwh: r.grid_import_kwh,
    grid_export_kwh: r.grid_export_kwh
  }));

  const elapsed = Date.now() - start;
  logger.debug(`buildDashboardState took ${elapsed}ms`);

  return {
    current: currentData,
    metrics,
    savings,
    gridStatus,
    gridHours,
    gridTimeline,
    powerHistory,
    dailyEnergyBar
  };
}

router.get('/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard', 'savings_currency', 'savings_rate', 'solar_capacity_kwp'];
    const config = {};
    for (const key of keys) config[key] = getConfig(key);
    config.dashboard_title = config.dashboard_title || '⚡ Epilykos';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.set('Cache-Control', 'public, max-age=300');
    res.json(config);
  } catch (err) {
    logger.error('Error in /api/public-config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/current', async (req, res) => {
  try {
    const db = getDb();
    const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
    const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const allTimeSolar = db.prepare(`SELECT SUM(daily_solar) as total FROM (SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch'))`).get();
    const allTimeSavings = (allTimeSolar?.total || 0) * rate;
    res.set('Cache-Control', 'public, max-age=10');
    if (latest) {
      const curr = getConfig('savings_currency') || '€';
      const dailySolarKwh = computeTodaySolar();
      res.json({
        consumption_kw: latest.consumption / 1000,
        solar_kw: latest.solar / 1000,
        battery_charge_kw: latest.battery_charge / 1000,
        battery_discharge_kw: latest.battery_discharge / 1000,
        battery_power_kw: (latest.battery_charge - latest.battery_discharge) / 1000,
        grid_import_kw: latest.grid_import / 1000,
        grid_export_kw: latest.grid_export / 1000,
        battery_soc: latest.battery_soc,
        daily_consumption_kwh: latest.daily_consumption,
        daily_solar_kwh: dailySolarKwh,
        daily_battery_charge_kwh: latest.daily_battery_charge,
        daily_battery_discharge_kwh: latest.daily_battery_discharge,
        daily_grid_import_kwh: latest.daily_grid_import,
        daily_grid_export_kwh: latest.daily_grid_export,
        savings_currency: curr,
        savings_rate: rate,
        today_savings: dailySolarKwh * rate,
        all_time_savings: allTimeSavings,
        metric_sanity: metricSanity.getStatus(),
        timestamp: latest.timestamp * 1000
      });
    } else {
      res.json({ error: 'No data yet' });
    }
  } catch (err) {
    logger.error('Error in /api/current:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', async (req, res) => {
  const requestedDays = parseInt(req.query.days);
  if (isNaN(requestedDays) || requestedDays < 1) return res.status(400).json({ error: 'days must be a positive integer (1-7)' });
  const days = Math.min(requestedDays, 7);
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(since);
    res.json(rows.map(r => ({
      ...r,
      consumption_kw: r.consumption / 1000,
      solar_kw: r.solar / 1000,
      battery_charge_kw: r.battery_charge / 1000,
      battery_discharge_kw: r.battery_discharge / 1000,
      battery_power_kw: (r.battery_charge - r.battery_discharge) / 1000,
      grid_import_kw: r.grid_import / 1000,
      grid_export_kw: r.grid_export / 1000,
      timestamp: r.timestamp * 1000
    })));
  } catch (err) {
    logger.error('Error in /api/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/daily', async (req, res) => {
  const requestedDays = parseInt(req.query.days);
  if (isNaN(requestedDays) || requestedDays < 1) return res.status(400).json({ error: 'days must be a positive integer (1-365)' });
  const days = Math.min(requestedDays, 365);
  const now = new Date();
  const dateArray = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateArray.push(d.toISOString().split('T')[0]);
  }
  const startUnix = Math.floor(new Date(dateArray[0] + 'T00:00:00').getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(startUnix, endUnix);
    const dataMap = {};
    rows.forEach(r => { dataMap[r.day] = r; });
    const result = dateArray.map(date => {
      const d = dataMap[date];
      return {
        day: date,
        consumption_kwh: d?.consumption_kwh || 0,
        solar_kwh: d?.solar_kwh || 0,
        battery_charge_kwh: d?.battery_charge_kwh || 0,
        battery_discharge_kwh: d?.battery_discharge_kwh || 0,
        grid_import_kwh: d?.grid_import_kwh || 0,
        grid_export_kwh: d?.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/daily:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/monthly', async (req, res) => {
  try {
    const now = new Date();
    const months = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        display: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
      });
    }
    const db = getDb();
    const rows = db.prepare(`
      WITH daily_max AS (
        SELECT date(timestamp, 'unixepoch') as day,
          MAX(daily_consumption) as consumption,
          MAX(daily_solar) as solar,
          MAX(daily_battery_charge) as battery_charge,
          MAX(daily_battery_discharge) as battery_discharge,
          MAX(daily_grid_import) as grid_import,
          MAX(daily_grid_export) as grid_export
        FROM history GROUP BY day
      )
      SELECT strftime('%Y-%m', day) as month,
        SUM(consumption) as consumption_kwh,
        SUM(solar) as solar_kwh,
        SUM(battery_charge) as battery_charge_kwh,
        SUM(battery_discharge) as battery_discharge_kwh,
        SUM(grid_import) as grid_import_kwh,
        SUM(grid_export) as grid_export_kwh
      FROM daily_max GROUP BY month ORDER BY month DESC LIMIT 12
    `).all();
    const dataMap = {};
    rows.forEach(r => { dataMap[r.month] = r; });
    const result = months.map(m => {
      const d = dataMap[m.key];
      return {
        month: m.key,
        display: m.display,
        consumption_kwh: d?.consumption_kwh || 0,
        solar_kwh: d?.solar_kwh || 0,
        battery_charge_kwh: d?.battery_charge_kwh || 0,
        battery_discharge_kwh: d?.battery_discharge_kwh || 0,
        grid_import_kwh: d?.grid_import_kwh || 0,
        grid_export_kwh: d?.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/monthly:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/grid/status', (req, res) => {
  res.json(getCurrentGridStatus());
});

router.get('/grid/timeline', async (req, res) => {
  try {
    const period = req.query.period || '24h';
    res.json(await getGridTimeline(period));
  } catch (err) {
    logger.error('Error in /api/grid/timeline:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/savings', async (req, res) => {
  try {
    res.json(await getSavings());
  } catch (err) {
    logger.error('Error in /api/savings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/solar-forecast', async (req, res) => {
  try {
    res.json(await getSolarForecast());
  } catch (err) {
    logger.error('Error in /api/solar-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/solar/intraday', async (req, res) => {
  try {
    const field = req.query.field || 'solar';
    const allowed = ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'];
    if (!allowed.includes(field)) return res.status(400).json({ error: `Invalid field. Allowed: ${allowed.join(', ')}` });
    const now = new Date();
    const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const db = getDb();
    const rows = db.prepare(`SELECT timestamp, ${field} as watts, daily_solar FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(todayStart);
    res.json(rows.map(r => ({ timestamp: r.timestamp, watts: r.watts, daily_solar: r.daily_solar })));
  } catch (err) {
    logger.error('Error in /api/solar/intraday:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/dashboard-state', async (req, res) => {
  try {
    const state = await buildDashboardState();
    res.json(state);
  } catch (err) {
    logger.error('Aggregated state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/dashboard-config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const config = getDashboardConfig();
    res.json(config);
  } catch (err) {
    logger.error('Error fetching dashboard config:', err);
    const fallback = {
      dashboards: [{ id: 'main', name: 'Main', layout: [] }],
      activeDashboard: 'main'
    };
    res.status(500).json(fallback);
  }
});

module.exports = { router, buildDashboardState };
