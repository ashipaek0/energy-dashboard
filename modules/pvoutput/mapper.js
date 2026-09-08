/**
 * PVOutput Metric Mapper — converts Epilykos metrics to PVOutput status parameters.
 *
 * All timestamps formatted in the PVOutput system timezone (not UTC, not server-local).
 * Uses Intl.DateTimeFormat for timezone-aware date/time formatting (C1).
 *
 * @module pvoutput/mapper
 */

/**
 * Unwrap a metric value that may be the envelope shape from getCurrentMetrics()
 * ({ value, type, timestamp, unit }) or a legacy flat number. Returns the raw
 * value, or undefined when the metric is missing. A flat metric whose value is
 * literally the number null/0 (non-object) passes through untouched.
 */
function metricValue(metrics, name) {
  if (metrics == null || name == null) return undefined;
  const raw = metrics[name];
  if (raw !== null && typeof raw === 'object' && 'value' in raw) return raw.value;
  return raw;
}

function formatStatusTimestamp(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    d: `${parts.year}${parts.month}${parts.day}`,
    t: `${parts.hour}:${parts.minute}`
  };
}

/**
 * Round minutes down to nearest 5-min interval for the PVOutput time slot.
 */
function roundToInterval(date) {
  const m = date.getMinutes();
  date.setMinutes(m - (m % 5), 0, 0);
  return date;
}

/**
 * Build an addstatus POST body from Epilykos metrics. Metrics may be
 * envelope-shaped ({ metric_name: { value, type, timestamp, unit } }) as
 * returned by getCurrentMetrics(), or a legacy flat { metric_name: value };
 * metricValue() unwraps both.
 * @param {object} metrics — envelope or flat metrics from getCurrentMetrics()
 * @param {object} config — pvoutput_config JSON
 * @param {Date} date — timestamp for this status entry
 * @returns {object} URLSearchParams-compatible key-value pairs
 */
function buildStatusPayload(metrics, config, date = new Date()) {
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rounded = roundToInterval(new Date(date));
  const { d, t } = formatStatusTimestamp(rounded, tz);

  const payload = { d, t };
  const map = config.metric_map || {};

  // Energy generation — use cumulative mode (c1=1) by default
  const v1 = metricValue(metrics, map.v1);
  const v2 = metricValue(metrics, map.v2);
  const hasCumulative = v1 != null;
  const hasInstantPower = v2 != null;

  if (hasCumulative && Number.isFinite(Number(v1))) {
    const raw = Number(v1);
    payload.v1 = Math.round(map.v1_is_kwh ? raw * 1000 : raw);
    if (!config.net_mode) payload.c1 = config.c1_mode ?? 1;
  }
  if (hasInstantPower && Number.isFinite(Number(v2))) {
    payload.v2 = Math.round(Number(v2));
  }

  // Consumption
  const v3 = metricValue(metrics, map.v3);
  if (v3 != null && Number.isFinite(Number(v3))) {
    payload.v3 = Math.round(map.v3_is_kwh ? Number(v3) * 1000 : Number(v3));
  }
  const v4 = metricValue(metrics, map.v4);
  if (v4 != null && Number.isFinite(Number(v4))) payload.v4 = Math.round(Number(v4));

  // Temperature & voltage
  const v5 = metricValue(metrics, map.v5);
  if (v5 != null && Number.isFinite(Number(v5)) && String(v5).trim() !== '') payload.v5 = +Number(v5).toFixed(1);
  const v6 = metricValue(metrics, map.v6);
  if (v6 != null && Number.isFinite(Number(v6)) && String(v6).trim() !== '') payload.v6 = +Number(v6).toFixed(1);

  // Battery
  const b1 = metricValue(metrics, map.b1);
  if (config.battery_enabled && b1 != null && Number.isFinite(Number(b1))) {
    payload.b1 = Math.round(Number(b1));
    payload.b2 = deriveBatteryState(metrics, map);
  }

  // Net mode
  if (config.net_mode && !hasCumulative) {
    payload.n = 1;
  }

  // Extended data (donation only)
  if (config.donation_mode) {
    for (let i = 7; i <= 12; i++) {
      const raw = metricValue(metrics, map[`v${i}`]);
      if (raw != null && Number.isFinite(Number(raw)) && String(raw).trim() !== '') payload[`v${i}`] = +Number(raw).toFixed(2);
    }
  }

  return payload;
}

function deriveBatteryState(metrics, map) {
  const soc = metricValue(metrics, map.soc_metric);
  const power = metricValue(metrics, map.b1);
  if (soc != null && soc >= 95) return 3;  // Full
  if (soc != null && soc <= 5) return 4;   // Flat
  if (power != null && power > 10) return 2;  // Charging
  if (power != null && power < -10) return 1; // Discharging
  return 0;  // Idle
}

/**
 * Validate payload against PVOutput constraints.
 * @param {object} payload
 * @param {number|null} systemSizeW — from config or getsystem cache
 * @returns {string[]} error messages (empty = valid)
 */
function validatePayload(payload, systemSizeW) {
  const errors = [];
  if (!payload.v1 && !payload.v2 && !payload.v3 && !payload.v4) {
    errors.push('No energy or power values to upload');
  }
  if (systemSizeW && payload.v2 && payload.v2 > systemSizeW * 1.5) {
    errors.push(`v2 power ${payload.v2}W > 150% of system size ${systemSizeW}W`);
  }
  if (payload.c1 && payload.n) {
    errors.push('c1 and n (net) cannot both be set');
  }
  if (payload.b2 != null && payload.b1 == null) {
    errors.push('b2 requires b1');
  }
  return errors;
}

module.exports = { formatStatusTimestamp, buildStatusPayload, validatePayload, deriveBatteryState };
