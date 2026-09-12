const { logger } = require('./logger');
const { getConfig, getDb } = require('./database');
const { assertSafeFetchUrl } = require('./utils');
const metricSanity = require('./metricSanity');

// Build a Home Assistant REST API URL from a base URL, robust to trailing
// slashes and a base that already ends in '/api' (new URL().toString() adds a
// trailing slash, which previously double-formed /api/states -> 404).
function haApiUrl(base, path) {
  let u;
  try {
    u = new URL(base);
  } catch (_) {
    // Never crash URL construction — fall back to an un-normalized concatenation.
    return String(base).replace(/\/+$/, '') + (path ? '/' + String(path).replace(/^\/+/, '') : '');
  }
  // u.pathname always starts with '/' (e.g. '/', '/api', '/base'). Strip only the
  // trailing slash that new URL().toString() adds, then ensure it ends in '/api'.
  let p = u.pathname.replace(/\/+$/, '');
  if (p === '') p = '/api';
  else if (!p.endsWith('/api')) p = p + '/api';
  const rest = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return u.origin + p + (rest ? '/' + rest : '');
}

// SSRF guard: normalize a HA base URL and require http/https. The `new URL()`
// parse + protocol allowlist is the CodeQL-recognized URL sanitizer, so any
// fetch() URL built from the returned value is no longer treated as
// user-controlled.
function safeHaBaseUrl(base) {
  let u;
  try { u = new URL(String(base)); } catch (_) { throw new Error('Invalid HA base URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('HA base URL scheme not allowed (must use http or https)');
  }
  return u.toString();
}

let metricInsertStmt = null;
let latestUpsertStmt = null;
let metricInsertTextStmt = null;
let latestUpsertTextStmt = null;

function getMetricInsert() {
  if (!metricInsertStmt) {
    const db = getDb();
    metricInsertStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  }
  return metricInsertStmt;
}

function getLatestUpsert() {
  if (!latestUpsertStmt) {
    const db = getDb();
    latestUpsertStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  }
  return latestUpsertStmt;
}

function getMetricInsertText() {
  if (!metricInsertTextStmt) {
    const db = getDb();
    metricInsertTextStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  }
  return metricInsertTextStmt;
}

function getLatestUpsertText() {
  if (!latestUpsertTextStmt) {
    const db = getDb();
    latestUpsertTextStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp) VALUES (?, ?, ?, ?)');
  }
  return latestUpsertTextStmt;
}

function saveMetric(metricName, rawValue, timestamp) {
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    // #119 metric sanity guard: reject implausible jumps in daily counters at
    // the write choke point. Guarded + rejected -> HOLD: no write to
    // latest_metrics/metrics and the held row keeps its ORIGINAL timestamp
    // (AC-4). check() fails open and never throws (AC-9); unguarded metrics
    // are written exactly as before (AC-12b).
    const verdict = metricSanity.check(metricName, num, timestamp);
    if (verdict && verdict.guarded && !verdict.accepted) {
      return;
    }
    getLatestUpsert().run(metricName, num, timestamp);
    getMetricInsert().run(timestamp, metricName, num);
  } else {
    const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
    const lower = strVal.toLowerCase();
    const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
    const type = isBool ? 'boolean' : 'string';
    const displayVal = isBool ? lower : strVal;
    getLatestUpsertText().run(metricName, displayVal, type, timestamp);
    getMetricInsertText().run(timestamp, metricName, displayVal, type);
  }
}

let mqttValues = {};

async function pollHomeAssistant() {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  if (!haDevices.length) return;

  // #119: thresholds are read once per poll cycle (§5); missing keys never throw.
  metricSanity.reloadConfig();

  for (const device of haDevices) {
    if (!device.enabled || !device.url || !device.token) continue;
    // SSRF guard: allowlist + scheme check before any fetch. device.url is
    // admin-configured config, but config still flows into fetch(), so guard it.
    const safeCheck = await assertSafeFetchUrl(device.url, { allowPrivate: true });
    if (!safeCheck.ok) { logger.warn(`HA poll: skipping ${device.name}: ${safeCheck.error}`); continue; }
    let base;
    try { base = safeHaBaseUrl(safeCheck.url); } catch (err) { logger.warn(`HA poll: skipping ${device.name}: ${err.message}`); continue; }
    for (const [metric, mapping] of Object.entries(device.entities || {})) {
      // Entity mapping value is either a plain entity_id string or an object
      // { entityId, actions: [...] } carrying optional action metadata (AC-1.4).
      const entityId = (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) ? mapping.entityId : mapping;
      if (!entityId) continue;
      try {
        const res = await fetch(haApiUrl(base, 'states/' + entityId), {
          headers: { 'Authorization': `Bearer ${device.token}` },
          signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) continue;
        const data = await res.json();
        const now = Math.floor(Date.now() / 1000);
        saveMetric(metric, data.state, now);
        // Store numeric representation for mqttValues compatibility
        const num = parseFloat(data.state);
        mqttValues[metric] = !isNaN(num) ? num : (data.state === 'on' || data.state === 'true' ? 1 : (data.state === 'off' || data.state === 'false' ? 0 : data.state));
      } catch (e) {
        logger.warn(`HA poll error for ${device.name} - ${metric}: ${e.message}`);
      }
    }
  }
}

async function fetchHAEntities(url, token) {
  // CodeQL-recognized SSRF guard: parse to a URL object, enforce http/https,
  // and pass the URL OBJECT to fetch (never a re-derived string). The route
  // /api/ha-device-entities additionally allowlists IPs via assertSafeFetchUrl
  // before calling this; this inline guard is sink-level defense-in-depth.
  let u;
  try { u = new URL(String(url)); } catch (_) { throw new Error('Invalid HA URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('HA URL scheme not allowed (must use http or https)');
  let p = u.pathname.replace(/\/+$/, '');
  if (p === '') p = '/api';
  else if (!p.endsWith('/api')) p = p + '/api';
  u.pathname = p + '/states';
  const response = await fetch(u, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`HA error ${response.status} for GET ${u.toString()}`);
  const data = await response.json();
  return data.filter(e => 
    e.entity_id.startsWith('sensor.') || 
    e.entity_id.startsWith('binary_sensor.') ||
    e.entity_id.startsWith('switch.') ||
    e.entity_id.startsWith('light.') ||
    e.entity_id.startsWith('climate.') ||
    e.entity_id.startsWith('fan.') ||
    e.entity_id.startsWith('cover.') ||
    e.entity_id.startsWith('input_boolean.')
  ).map(e => e.entity_id);
}

/**
 * Execute a Home Assistant service call (AC-1.2).
 * Spec signature: executeHAAction(deviceId, domain, service, entityId, params)
 *
 * Backwards-compatible with the route, which passes the whole action spec in the
 * `domain` slot as either a dotted string 'domain.service' or an object
 * { domain, service }, followed by (entityId, params) — i.e. the 4-arg form
 * executeHAAction(deviceId, action, entityId, params) is also accepted.
 */
async function executeHAAction(deviceId, domain, service, entityId, params = {}) {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');

  // Resolve the device by name or by array index.
  let device = haDevices.find(d => d && d.name === deviceId);
  if (!device) {
    const idx = Number(deviceId);
    if (Number.isInteger(idx) && idx >= 0 && idx < haDevices.length) {
      device = haDevices[idx];
    }
  }
  if (!device || !device.enabled) return { success: false, error: 'Device not found or disabled' };
  if (!device.url || !device.token) return { success: false, error: 'Device URL or token missing' };

  // Resolve domain/service. The `domain` slot may hold:
  //   - a plain domain string 'switch'   (spec 5-arg form, service in next slot)
  //   - a dotted string 'switch.toggle'  (route form)
  //   - an object { domain, service }    (route form / spec T1.2)
  const originalService = service;
  const originalEntitySlot = entityId;
  let expanded = false;
  if (domain && typeof domain === 'object') {
    if (typeof domain.domain !== 'string' || !domain.domain ||
        typeof domain.service !== 'string' || !domain.service) {
      return { success: false, error: 'Invalid action object (domain and service are required)' };
    }
    service = domain.service;
    domain = domain.domain;
    expanded = true;
  } else if (typeof domain === 'string' && domain.includes('.')) {
    const parts = domain.split('.');
    domain = parts[0];
    service = parts.slice(1).join('.');
    expanded = true;
  }
  if (expanded && originalService !== undefined) {
    // Route form call: executeHAAction(deviceId, action, entityId, params) —
    // the entity_id was passed in the `service` slot and params in the `entityId` slot.
    entityId = originalService;
    params = (originalEntitySlot && typeof originalEntitySlot === 'object') ? originalEntitySlot : {};
  }
  if (typeof domain !== 'string' || !domain || typeof service !== 'string' || !service) {
    return { success: false, error: 'Invalid service format (domain.service)' };
  }

  try {
    const res = await fetch(haApiUrl(device.url, 'services/' + domain + '/' + service), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: entityId, ...params }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      let errText = '';
      try { errText = await res.text(); } catch (_) { /* non-text body */ }
      let body = null;
      try { body = JSON.parse(errText); } catch (_) { body = errText || null; }
      return {
        success: false,
        error: `HA returned ${res.status}: ${errText || 'unknown error'}`,
        status: res.status,
        body
      };
    }
    let result = null;
    try { result = await res.json(); } catch (_) { /* empty 2xx body */ }
    return { success: true, result };
  } catch (e) {
    logger.error(`HA action error for ${deviceId}/${entityId}: ${e.message}`);
    return { success: false, error: e.message };
  }
}

const DOMAIN_ACTIONS = {
  'switch': [
    { service: 'switch.toggle', label: 'Toggle', type: 'toggle' },
    { service: 'switch.turn_on', label: 'Turn On', type: 'button' },
    { service: 'switch.turn_off', label: 'Turn Off', type: 'button' }
  ],
  'light': [
    { service: 'light.toggle', label: 'Toggle', type: 'toggle' },
    { service: 'light.turn_on', label: 'Turn On', type: 'button' },
    { service: 'light.turn_off', label: 'Turn Off', type: 'button' },
    { service: 'light.turn_on', label: 'Brightness', type: 'set_brightness', param: 'brightness_pct' }
  ],
  'climate': [
    { service: 'climate.set_temperature', label: 'Set Temperature', type: 'number', param: 'temperature' },
    { service: 'climate.set_hvac_mode', label: 'Set Mode', type: 'select', param: 'hvac_mode' },
    { service: 'climate.set_fan_mode', label: 'Set Fan Mode', type: 'select', param: 'fan_mode' },
    { service: 'climate.turn_on', label: 'Turn On', type: 'button' },
    { service: 'climate.turn_off', label: 'Turn Off', type: 'button' }
  ],
  'fan': [
    { service: 'fan.toggle', label: 'Toggle', type: 'toggle' },
    { service: 'fan.turn_on', label: 'Turn On', type: 'button' },
    { service: 'fan.turn_off', label: 'Turn Off', type: 'button' },
    { service: 'fan.set_speed', label: 'Set Speed', type: 'select', param: 'percentage' }
  ],
  'cover': [
    { service: 'cover.open_cover', label: 'Open', type: 'button' },
    { service: 'cover.close_cover', label: 'Close', type: 'button' },
    { service: 'cover.stop_cover', label: 'Stop', type: 'button' },
    { service: 'cover.toggle', label: 'Toggle', type: 'toggle' }
  ],
  'input_boolean': [{ service: 'input_boolean.toggle', label: 'Toggle', type: 'toggle' }]
};

// Spec AC-7.1: flat action names per domain, exactly as asserted by the spec tests.
const SPEC_DOMAIN_ACTIONS = {
  'switch': ['toggle', 'turn_on', 'turn_off'],
  'light': ['toggle', 'turn_on', 'turn_off', 'brightness'],
  'climate': ['set_temperature', 'set_mode', 'set_fan_mode', 'turn_on', 'turn_off'],
  'fan': ['toggle', 'turn_on', 'turn_off', 'set_speed'],
  'cover': ['open_cover', 'close_cover', 'stop_cover', 'toggle'],
  'input_boolean': ['toggle']
};

/**
 * Spec AC-7.1 — return the flat list of action names supported for an entity.
 * @param {string} entityId e.g. 'light.kitchen'
 * @returns {string[]} e.g. ['toggle', 'turn_on', 'turn_off', 'brightness']
 */
function getActionsForEntity(entityId) {
  const dotIndex = entityId.indexOf('.');
  if (dotIndex === -1) return [];
  const domain = entityId.substring(0, dotIndex);
  return SPEC_DOMAIN_ACTIONS[domain] || [];
}

/**
 * Rich action descriptors ({service, label, type, param}) for UI rendering.
 * Kept alongside the spec getActionsForEntity for backwards compatibility.
 * @param {string} entityId e.g. 'light.kitchen'
 * @returns {object[]}
 */
function getEntityActions(entityId) {
  const dotIndex = entityId.indexOf('.');
  if (dotIndex === -1) return [];
  const domain = entityId.substring(0, dotIndex);
  return DOMAIN_ACTIONS[domain] || [];
}

// Per-entity modes cache (AC-7.2): key `${url}|${entityId}` → { data, ts }.
const entityModesCache = new Map();
const ENTITY_MODES_TTL_MS = 5 * 60 * 1000;

/**
 * Spec AC-7.2 — fetch HVAC/fan modes and temperature bounds from the entity's
 * HA attributes, cached per entity with a 5-minute TTL.
 * @param {string} url HA base URL
 * @param {string} token HA long-lived access token
 * @param {string} entityId e.g. 'climate.living_room'
 * @returns {Promise<{hvac_modes: string[], fan_modes: string[], min_temp: number|null, max_temp: number|null}>}
 */
async function getEntityModes(url, token, entityId) {
  const empty = { hvac_modes: [], fan_modes: [], min_temp: null, max_temp: null };
  if (!url || !token || !entityId) return empty;
  const key = `${url}|${entityId}`;
  const cached = entityModesCache.get(key);
  if (cached && Date.now() - cached.ts < ENTITY_MODES_TTL_MS) {
    return cached.data;
  }
  let data = empty;
  try {
    const res = await fetch(haApiUrl(url, 'states/' + entityId), {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const state = await res.json();
      const attrs = state.attributes || {};
      data = {
        hvac_modes: Array.isArray(attrs.hvac_modes) ? attrs.hvac_modes : [],
        fan_modes: Array.isArray(attrs.fan_modes) ? attrs.fan_modes : [],
        min_temp: (attrs.min_temp !== undefined && attrs.min_temp !== null) ? attrs.min_temp : null,
        max_temp: (attrs.max_temp !== undefined && attrs.max_temp !== null) ? attrs.max_temp : null
      };
    }
  } catch (e) {
    logger.warn(`getEntityModes error for ${entityId}: ${e.message}`);
  }
  entityModesCache.set(key, { data, ts: Date.now() });
  return data;
}

module.exports = { pollHomeAssistant, fetchHAEntities, mqttValues, executeHAAction, getActionsForEntity, getEntityActions, getEntityModes, saveMetric };
