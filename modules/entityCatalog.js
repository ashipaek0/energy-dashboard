'use strict';

/**
 * modules/entityCatalog.js — issue #108 stage 1: pure per-source catalog projections.
 *
 * Every function here is a PURE projection: it takes an already-parsed profile
 * object (or later-stage payload) and returns an array of catalog entity items.
 * No fs, no network, no DB, no logger — routes are thin wrappers and fixtures
 * can exercise every projection without booting the server.
 *
 * Decode-key contract (load-bearing, do not change): every emitted item `id` is
 * exactly the key that the owning module's reverse-lookup consumes when polling
 * that profile family, so a persisted `{metricName: id}` mapping resolves 1:1:
 *
 *   - register transports (solarman-v5 / modbus-tcp / default) — bare hex
 *     register string, `m.register` (modules/dongle.js pollInstance decode).
 *   - growatt (push) — `m.field` (modules/dongle/growatt.js data[m.field]).
 *   - felicity-tcp (JSON push) — `field.path`, bracket-array syntax included
 *     (modules/dongle.js pollJsonInstance decode, getByPath on profile.fields).
 *   - luxpower-tcp — namespaced `${register_type}:${register}` (e.g.
 *     'input:0x0000'), matching decodeLuxpowerMetrics' primary key; legacy
 *     bare-hex remains only a fallback on the decode side, never an emitted id.
 *
 * Projection dispatch mirrors modules/dongle.js startDonglePolling branch keys
 * (profile.protocol 'luxpower-tcp'/'felicity-tcp', transport 'growatt', else the
 * register family) so the catalog always advertises what the poller can decode.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Numeric value of a register string: hex ('0x..') or decimal. */
function regNum(reg) {
  const s = String(reg).trim();
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

/** Modbus register-space sort order (mirrors the legacy route's REG_TYPE_ORDER). */
const REG_TYPE_ORDER = { coil: 0, discrete: 1, input: 2, holding: 3 };

/**
 * writable-map key, normalized the way the legacy route did it:
 * lowercased register_type ('' when absent) + NUMERIC register value.
 */
function wKey(type, reg) {
  return `${String(type || '').toLowerCase()}:${regNum(reg)}`;
}

/** Build {registerType-register -> writable entry} from profile.writable_registers. */
function buildWritableMap(writable) {
  const writableMap = new Map();
  if (Array.isArray(writable)) {
    for (const w of writable) writableMap.set(wKey(w.register_type, w.register), w);
  }
  return writableMap;
}

/**
 * catEntity(props) — canonical catalog item builder.
 *
 * Shared shape helper for every projection. `id` is required and is the
 * persisted handle (see decode-key contract above). Optional keys are emitted
 * in a fixed canonical order when their value is defined (undefined values are
 * dropped, so in-memory items always equal their JSON serialization):
 * id, register_type, register, name, label, unit, scale, type, count, access,
 * writable, kind, then any extra keys (min/max/step/actions/…) in insertion
 * order. Per-family extras ride through `props` untouched.
 */
function catEntity(props) {
  if (!props || typeof props !== 'object') {
    throw new TypeError('catEntity: props object required');
  }
  if (props.id === undefined) {
    throw new TypeError('catEntity: id (the persisted handle) is required');
  }
  const item = { id: props.id };
  const canonical = ['register_type', 'register', 'name', 'label', 'unit', 'scale', 'type', 'count', 'access', 'writable', 'kind'];
  for (const key of canonical) {
    if (props[key] !== undefined) item[key] = props[key];
  }
  for (const [key, value] of Object.entries(props)) {
    if (!canonical.includes(key) && key !== 'id' && value !== undefined) item[key] = value;
  }
  return item;
}

/** Writable extras copied onto an entity only when defined (min/max/step/kind/actions). */
function writableExtras(w) {
  const out = {};
  if (w === undefined) return out;
  if (w.min !== undefined) out.min = w.min;
  if (w.max !== undefined) out.max = w.max;
  if (w.step !== undefined) out.step = w.step;
  if (w.kind !== undefined) out.kind = w.kind;
  if (w.actions !== undefined) out.actions = w.actions;
  return out;
}

// ---------------------------------------------------------------------------
// Dongle projections
// ---------------------------------------------------------------------------

/**
 * Register-transport projection (AC-3) — solarman-v5, modbus-tcp and any other
 * non-special dongle transport that polls through pollInstance.
 *
 * One item per metrics[] entry. `id` is the bare-hex register verbatim
 * (`m.register`, dongle.js pollInstance decode key) — NEVER namespaced, so no
 * `undefined:0x…` can be emitted. `register_type` is metadata only (defaults to
 * 'holding' when the profile metric omits it — it never participates in the
 * id). `kind:'register'`. Metrics whose register is empty/absent are skipped:
 * they are not decode-reachable on this path. A writable_registers union is
 * surfaced when the profile carries one (ids stay bare-hex for this family).
 * Sorted by numeric register.
 */
function dongleRegisterEntities(profile) {
  const metrics = Array.isArray(profile.metrics) ? profile.metrics : [];
  const writable = Array.isArray(profile.writable_registers) ? profile.writable_registers : [];
  const writableMap = buildWritableMap(writable);

  const entities = [];
  for (const m of metrics) {
    const reg = m.register;
    if (reg === undefined || reg === null || String(reg).trim() === '') continue; // not decode-reachable here
    const w = writableMap.get(wKey(m.register_type, reg));
    entities.push(catEntity({
      id: reg, // bare hex — the handle pollInstance reverse-lookup consumes
      register_type: m.register_type !== undefined ? m.register_type : 'holding', // metadata only
      register: reg,
      name: m.name,
      label: m.label,
      unit: m.unit,
      scale: m.scale,
      type: m.type,
      count: m.count,
      access: w ? 'readwrite' : 'read',
      writable: !!w,
      kind: 'register',
      ...writableExtras(w)
    }));
  }

  // Writable registers absent from metrics[] still surface as entities
  // (family id form: bare hex, writable registers are holding-space).
  if (writable.length) {
    const present = new Set(entities.map(e => wKey(e.register_type, e.register)));
    for (const w of writable) {
      if (present.has(wKey(w.register_type, w.register))) continue;
      entities.push(catEntity({
        id: w.register,
        register_type: w.register_type !== undefined ? w.register_type : 'holding',
        register: w.register,
        name: w.name,
        label: w.label,
        unit: w.unit,
        scale: w.scale,
        type: w.type,
        count: w.count !== undefined ? w.count : 1,
        access: 'readwrite',
        writable: true,
        kind: 'register',
        ...writableExtras(w)
      }));
    }
  }

  entities.sort((a, b) => regNum(a.register) - regNum(b.register));
  return entities;
}

/**
 * Growatt push projection (AC-4) — transport 'growatt' (GrowattServer).
 *
 * One item per metrics[] entry. `id` is `m.field` — the key growatt.js reads
 * from the decoded frame (`data[m.field]`). Registers are '' in this family and
 * are included (the field IS the addressing). `kind:'field'`. Sorted by label.
 */
function dongleGrowattEntities(profile) {
  const metrics = Array.isArray(profile.metrics) ? profile.metrics : [];
  const entities = [];
  for (const m of metrics) {
    if (m.field === undefined || m.field === null || String(m.field).trim() === '') continue;
    entities.push(catEntity({
      id: m.field, // decode key: growatt.js data[m.field]
      name: m.name, // implicit default metric name (prefix + m.name)
      label: m.label,
      unit: m.unit,
      scale: m.scale,
      type: m.type,
      count: m.count,
      access: 'read',
      writable: false,
      kind: 'field'
    }));
  }
  entities.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return entities;
}

/**
 * Felicity JSON-path projection (AC-5) — protocol 'felicity-tcp'.
 *
 * One item per fields[] entry. `id` is `field.path` verbatim, bracket-array
 * syntax included ('realtime.ACin[0][0]') — the exact key pollJsonInstance's
 * path→metric reverse lookup consumes. `kind:'path'`. Profile field order is
 * preserved (deterministic, decode order).
 */
function dongleFelicityEntities(profile) {
  const fields = Array.isArray(profile.fields) ? profile.fields : [];
  const entities = [];
  for (const f of fields) {
    if (f.path === undefined || f.path === null) continue;
    entities.push(catEntity({
      id: f.path, // decode key: pollJsonInstance pathToMetric[field.path]
      name: f.name, // implicit default metric name (prefix + f.name)
      label: f.label,
      unit: f.unit,
      scale: f.scale,
      type: f.type,
      count: f.count,
      access: 'read',
      writable: false,
      kind: 'path'
    }));
  }
  return entities;
}

/**
 * LuxPower namespaced projection (AC-2) — protocol 'luxpower-tcp'.
 *
 * Byte-compatible with the legacy `GET /api/dongle/profile/:id/entities`
 * handler (server.js ~L1872 at HEAD 34a1898): same item keys and order
 * (id/register_type/register/name/label/unit/scale/type/count/access/writable,
 * plus min/max/step/kind/actions when the register is writable), same
 * `${register_type}:${register}` ids, same writable_registers union, same sort
 * (register_type coil→discrete→input→holding, then numeric register). Unlike
 * the legacy handler, an absent register_type falls back to the bare register
 * for the id (decodeLuxpowerMetrics' own key expression) so `undefined:0x…`
 * ids are impossible.
 */
function dongleLuxpowerEntities(profile) {
  const metrics = Array.isArray(profile.metrics) ? profile.metrics : [];
  const writable = Array.isArray(profile.writable_registers) ? profile.writable_registers : [];
  const writableMap = buildWritableMap(writable);

  const entities = [];
  for (const m of metrics) {
    const w = writableMap.get(wKey(m.register_type, m.register));
    const entity = {
      id: m.register_type !== undefined ? `${m.register_type}:${m.register}` : m.register, // decode key (namespaced)
      register_type: m.register_type !== undefined ? m.register_type : 'holding',
      register: m.register,
      name: m.name,
      label: m.label,
      unit: m.unit,
      scale: m.scale,
      type: m.type,
      count: m.count,
      access: w ? 'readwrite' : 'read',
      writable: !!w
    };
    if (w) {
      if (w.min !== undefined) entity.min = w.min;
      if (w.max !== undefined) entity.max = w.max;
      if (w.step !== undefined) entity.step = w.step;
      if (w.kind !== undefined) entity.kind = w.kind;
      if (w.actions !== undefined) entity.actions = w.actions;
    }
    entities.push(entity);
  }

  // Writable registers absent from metrics[] still surface as entities.
  for (const w of writable) {
    if (metrics.some(m => wKey(m.register_type, m.register) === wKey(w.register_type, w.register))) continue;
    const entity = {
      id: w.register_type !== undefined ? `${w.register_type}:${w.register}` : `${'holding'}:${w.register}`,
      register_type: w.register_type !== undefined ? w.register_type : 'holding',
      register: w.register,
      name: w.name,
      label: w.label,
      unit: w.unit,
      scale: w.scale,
      type: w.type,
      count: w.count !== undefined ? w.count : 1,
      access: 'readwrite',
      writable: true
    };
    if (w.min !== undefined) entity.min = w.min;
    if (w.max !== undefined) entity.max = w.max;
    if (w.step !== undefined) entity.step = w.step;
    if (w.kind !== undefined) entity.kind = w.kind;
    if (w.actions !== undefined) entity.actions = w.actions;
    entities.push(entity);
  }

  entities.sort((a, b) => {
    const ar = REG_TYPE_ORDER[a.register_type] !== undefined ? REG_TYPE_ORDER[a.register_type] : 99;
    const br = REG_TYPE_ORDER[b.register_type] !== undefined ? REG_TYPE_ORDER[b.register_type] : 99;
    if (ar !== br) return ar - br;
    return regNum(a.register) - regNum(b.register);
  });
  return entities;
}

/**
 * Dongle profile dispatcher (AC-1..6). Mirrors modules/dongle.js startDonglePolling:
 * protocol 'luxpower-tcp' → namespaced; protocol 'felicity-tcp' → JSON paths;
 * transport 'growatt' → fields; everything else (solarman-v5, modbus-tcp,
 * default) → bare-hex registers.
 */
function dongleProfileEntities(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const protocol = profile.protocol ? String(profile.protocol).toLowerCase() : '';
  if (protocol === 'luxpower-tcp') return dongleLuxpowerEntities(profile);
  if (protocol === 'felicity-tcp') return dongleFelicityEntities(profile);
  const transport = profile.transport ? String(profile.transport).toLowerCase() : '';
  if (transport === 'growatt') return dongleGrowattEntities(profile);
  return dongleRegisterEntities(profile);
}

module.exports = {
  catEntity,
  dongleProfileEntities,
  dongleRegisterEntities,
  dongleGrowattEntities,
  dongleFelicityEntities,
  dongleLuxpowerEntities
};
