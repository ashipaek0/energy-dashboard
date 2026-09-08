/**
 * Inverter Dongle Module — polls inverter WiFi dongles via Solarman V5, Modbus TCP, or Growatt.
 *
 * Each enabled dongle instance is polled on its own interval. Solarman V5 and Modbus TCP
 * use outgoing TCP connections (poll-based). Growatt uses an inbound TCP server (push-based).
 *
 * Metrics are written to the central metrics/latest_metrics store, same as HA, MQTT, and Modbus.
 *
 * @module dongle
 */
const fs = require('fs');
const path = require('path');
const { getConfig, setConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { SolarmanV5Transport } = require('./dongle/solarmanV5');
const { GrowattServer } = require('./dongle/growatt');
const { ModbusTcpTransport } = require('./dongle/modbusTcp');
const { FelicityTcpTransport } = require('./dongle/felicityTcp');
const { LuxpowerTcpTransport } = require('./dongle/luxpowerTcp');

let pollIntervals = [];
let growattServer = null;
let luxpowerPollers = [];
const profileCache = new Map();

function startDonglePolling() {
  stopDonglePolling();

  const raw = getConfig('dongle_config');
  if (!raw || raw === '[]') return;

  let config;
  try { config = JSON.parse(raw); } catch (e) { logger.error('[dongle] invalid config JSON'); return; }

  const growattInstances = [];

  for (const inst of config) {
    if (!inst.enabled) continue;

    if (inst.transport === 'growatt') {
      growattInstances.push(inst);
      continue;
    }

    const profile = loadProfile(inst.profile);
    if (!profile) { logger.warn(`[dongle] profile ${inst.profile} not found for ${inst.name}`); continue; }

    if (profile.protocol === 'felicity-tcp') {
      const transport = new FelicityTcpTransport(inst);
      const intervalMs = (inst.poll_interval || 30) * 1000;
      const id = setInterval(() => pollJsonInstance(inst, transport, profile), intervalMs);
      pollIntervals.push(id);
      pollJsonInstance(inst, transport, profile).catch(err => logger.warn(`[dongle] ${inst.name}: initial poll failed — ${err.message}`));
      continue;
    }

    if (profile.protocol === 'luxpower-tcp') {
      // Phase-2 (issue #106): the expanded profile is mapping:'explicit' —
      // auto-migrate legacy phase-1 luxpower-geta instances that have no saved
      // mappings so their polling continues (idempotent, see helper).
      if (inst.profile === 'luxpower-geta') {
        migrateLuxpowerExplicitMappings(inst, profile);
      }
      // LuxPower local TCP (v5 TranslatedData on :8000). Config uses explicit
      // dongle_serial (outer header) + inverter_serial (inner 10-char serial);
      // tolerate devices that stored either serial under serial_number — both
      // dedicated fields fall back to serial_number when left empty.
      let transport = null;
      try {
        transport = new LuxpowerTcpTransport({
          host: inst.host || inst.ip,
          port: inst.port || 8000,
          dongle_serial: inst.dongle_serial || inst.serial_number,
          inverter_serial: inst.inverter_serial || inst.serial_number,
          onFrame: parsed => handleLuxpowerFrame(inst, profile, parsed)
        });
        // D4 (revised): ~5s active input cadence for luxpower-tcp; honor an
        // explicit poll_interval (seconds) when the instance sets one.
        const intervalMs = (inst.poll_interval || 5) * 1000;
        const id = setInterval(() => pollLuxpowerInstance(inst, transport, profile), intervalMs);
        luxpowerPollers.push({ instance: inst, transport, intervalId: id });
        transport.start();
        pollLuxpowerInstance(inst, transport, profile).catch(err => logger.warn(`[dongle] ${inst.name}: initial poll failed — ${err.message}`));
      } catch (err) {
        if (transport) { try { transport.stop(); } catch (_) {} }
        logger.warn(`[dongle] ${inst.name}: luxpower instance skipped — ${err.message}`);
        continue;
      }
      continue;
    }

    profile.poll_ranges = buildPollRanges(profile.metrics);

    let Transport = ModbusTcpTransport;
    if (inst.transport === 'solarman-v5') Transport = SolarmanV5Transport;
    const transport = new Transport(inst);

    const intervalMs = (inst.poll_interval || 30) * 1000;
    const id = setInterval(() => pollInstance(inst, transport, profile), intervalMs);
    pollIntervals.push(id);
    pollInstance(inst, transport, profile).catch(err => logger.warn(`[dongle] ${inst.name}: initial poll failed — ${err.message}`));
  }

  if (growattInstances.length > 0) {
    growattServer = new GrowattServer(growattInstances, writeMetrics);
    growattServer.start();
  }
}

function stopDonglePolling() {
  pollIntervals.forEach(clearInterval);
  pollIntervals = [];
  for (const entry of luxpowerPollers) {
    clearInterval(entry.intervalId);
    if (entry.transport) entry.transport.stop();
  }
  luxpowerPollers = [];
  if (growattServer) { growattServer.stop(); growattServer = null; }
}

function restartDonglePolling() { startDonglePolling(); }

function writeMetrics(metrics, units) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)');
  const metricInsertText = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  const latestUpsertText = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp, unit) VALUES (?, ?, ?, ?, ?)');
  for (const [name, rawValue] of Object.entries(metrics)) {
    if (rawValue === undefined || rawValue === null) continue;
    const num = parseFloat(rawValue);
    if (!isNaN(num) && num === Number(rawValue)) {
      metricInsert.run(now, name, num);
      latestUpsert.run(name, num, now, (units && units[name]) || null);
    } else {
      const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
      const lower = strVal.toLowerCase();
      const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
      const type = isBool ? 'boolean' : 'string';
      const displayVal = isBool ? lower : strVal;
      metricInsertText.run(now, name, displayVal, type);
      latestUpsertText.run(name, displayVal, type, now, (units && units[name]) || null);
    }
  }
}

function loadProfile(profileId) {
  if (profileCache.has(profileId)) {
    return profileCache.get(profileId);
  }
  const profilePath = path.join(__dirname, '..', 'profiles', 'dongles', `${profileId}.json`);
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profileCache.set(profileId, profile);
    return profile;
  } catch (e) {
    logger.error(`[dongle] Failed to load profile ${profileId}: ${e.message}`);
    return null;
  }
}

function buildPollRanges(metrics) {
  const addresses = metrics
    .map(m => ({ addr: parseInt(m.register, 16), count: m.count || 1 }))
    .sort((a, b) => a.addr - b.addr);

  const ranges = [];
  for (const item of addresses) {
    const last = ranges[ranges.length - 1];
    if (last && item.addr <= last.start + last.count + 4) {
      const newEnd = Math.max(last.start + last.count, item.addr + item.count);
      last.count = newEnd - last.start;
    } else {
      ranges.push({ start: item.addr, count: item.count });
    }
  }
  return ranges;
}

/**
 * Phase-1 LuxPower starter registers (issue #102 profile) — the 13 input
 * registers 0x0000..0x000F that existed before the phase-2 profile expansion
 * (issue #106). Used to synthesize mappings for legacy instances.
 */
const LUXPOWER_PHASE1_METRIC_NAMES = [
  'operational_state', 'pv1_voltage', 'pv2_voltage', 'pv3_voltage',
  'battery_voltage', 'battery_soc', 'pv1_power', 'pv2_power',
  'pv3_or_total_power', 'battery_charge_power', 'battery_discharge_power',
  'grid_voltage', 'grid_frequency'
];

/** True when the instance carries at least one explicit mapping entry. */
function hasMappings(instance) {
  return !!(instance.mappings && typeof instance.mappings === 'object' && Object.keys(instance.mappings).length > 0);
}

/**
 * Auto-migration for issue #106 (AC18): the phase-1 LuxPower profile polled
 * implicitly (prefix+name defaults, no instance.mappings required). The phase-2
 * profile is mapping:'explicit' — zero instance.mappings means "map nothing,
 * write nothing" (the explicit no-entity-mappings state). A naive
 * "zero mappings ⇒ migrate" trigger is over-broad: it fires on EVERY boot for
 * brand-new phase-2 instances and for instances whose user deleted all
 * mappings, silently re-synthesizing the 13 starter mappings they never wanted.
 *
 * Migration therefore fires ONLY for a genuine LEGACY phase-1 instance, i.e.
 * ALL of the following hold:
 *   - explicit-mapping luxpower-geta profile with zero saved mappings;
 *   - NO phase-2 save marker (instance._luxpowerPhase2 !== true) — the phase-2
 *     settings UI stamps every luxpower-tcp device it saves, so brand-new and
 *     user-edited instances (incl. a user who deleted all mappings) are never
 *     auto-migrated;
 *   - NO prior-migration marker (instance._luxpowerMigrated !== true) — a
 *     migrated instance whose mappings were later deleted is never
 *     re-synthesized;
 *   - legacy metric-universe proof: all 13 phase-1 metric names exist in the
 *     metric universe under the instance prefix (metricsManager.getAllMetrics —
 *     phase-1 implicit polling auto-created exactly prefix+name rows). This is
 *     the only per-config-independent evidence that the instance actually ran
 *     under phase-1 semantics.
 *
 * When it fires it synthesizes the 13 phase-1 starter mappings and persists
 * BOTH the mappings and _luxpowerMigrated:true into the stored config (merge,
 * never clobber, so existing flags survive), making the trigger
 * self-terminating: later boots see mappings (or the marker) and skip, and a
 * later full wipe of the mappings still never re-migrates.
 */
function migrateLuxpowerExplicitMappings(instance, profile) {
  if (profile.mapping !== 'explicit') return false;
  if (hasMappings(instance)) return false;
  if (instance._luxpowerMigrated === true) return false; // migrated once already
  if (instance._luxpowerPhase2 === true) return false;   // saved via phase-2 UI — user-managed

  // Legacy proof: phase-1 implicit polling wrote prefix+name rows for all 13.
  // Require every one of them in the metric universe — anything less means the
  // instance cannot be proven to have run phase-1 (fresh/unstamped configs stay
  // in the explicit warn-once state).
  const prefix = instance.prefix || '';
  let universe;
  try {
    const { getAllMetrics } = require('./metricsManager');
    universe = new Set((getAllMetrics() || []).map(m => m && m.name).filter(Boolean));
  } catch (e) {
    logger.warn(`[dongle] luxpower ${instance.name}: legacy migration check skipped — metric universe unavailable (${e.message})`);
    return false;
  }
  const byName = new Map(profile.metrics.map(m => [m.name, m]));
  const mappings = {};
  for (const name of LUXPOWER_PHASE1_METRIC_NAMES) {
    const m = byName.get(name);
    if (!m) continue; // renamed/removed in the phase-2 profile — skip
    if (!universe.has(prefix + name)) return false; // not proven legacy — leave untouched
    const key = m.register_type ? `${m.register_type}:${m.register}` : m.register;
    mappings[prefix + name] = key;
  }
  if (Object.keys(mappings).length === 0) return false;
  instance.mappings = mappings;
  instance._luxpowerMigrated = true;
  try {
    const raw = getConfig('dongle_config');
    if (raw && raw !== '[]') {
      const devices = JSON.parse(raw);
      const hit = devices.find(d => d && d.name === instance.name);
      if (hit && !hasMappings(hit)) {
        // Merge (never replace the whole entry): keep any existing flags/fields.
        hit.mappings = mappings;
        hit._luxpowerMigrated = true;
        setConfig('dongle_config', JSON.stringify(devices));
      }
    }
  } catch (e) {
    logger.warn(`[dongle] ${instance.name}: could not persist migrated mappings — ${e.message}`);
  }
  logger.info(`[dongle] luxpower ${instance.name}: auto-migrated legacy phase-1 instance to explicit mappings (${Object.keys(mappings).length} registers, handles input:0xNNNN, _luxpowerMigrated persisted)`);
  return true;
}

async function pollInstance(instance, transport, profile) {
  try {
    const registerData = {};
    const start = Date.now();

    for (const range of profile.poll_ranges) {
      const buf = await transport.readRegisters(range.start, range.count);
      if (buf.length < range.count * 2) {
        logger.warn(`[dongle] ${instance.name}: short buffer at range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
      }
      const leSwap = profile.byte_order === 'le';
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[range.start + i] = v;
      }
    }

    const metrics = {};
    const units = {};
    const prefix = instance.prefix || '';
    const mappings = instance.mappings || null;
    // Build reverse lookup: register → metric name (mappings is { metricName → register })
    let regToMetric = null;
    if (mappings) {
      regToMetric = {};
      for (const [metric, reg] of Object.entries(mappings)) {
        regToMetric[reg] = metric;
      }
    }

    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      // Mapping override logic
      let metricName;
      if (regToMetric) {
        const key = m.register; // e.g., "0x0065"
        if (regToMetric[key] !== undefined) {
          metricName = regToMetric[key];
        } else {
          // Key not in mappings at all — skip unmapped when mappings exist
          continue;
        }
      } else {
        metricName = prefix + m.name;
      }

      if (m.bit !== undefined) raw = (raw >> m.bit) & 1;

      if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;

      if (m.type === 'uint32' || m.type === 'int32') {
        const lo = m.word_order === 'lsb_first' ? addr : addr + 1;
        const hi = m.word_order === 'lsb_first' ? addr + 1 : addr;
        raw = ((registerData[hi] || 0) << 16) | (registerData[lo] || 0);
        if (m.type === 'int32' && raw > 0x7FFFFFFF) raw -= 0x100000000;
      }

      if (m.type === 'uint64') {
        raw = ((registerData[addr + 3] || 0) * 0x1000000000000)
            + ((registerData[addr + 2] || 0) * 0x100000000)
            + ((registerData[addr + 1] || 0) << 16)
            + (registerData[addr] || 0);
      }

      const value = parseFloat((raw * (m.scale || 1)).toFixed(4));
      metrics[metricName] = value;
      if (m.unit) units[metricName] = m.unit;
    }

    writeMetrics(metrics, units);
    instance.lastSeen = Date.now();
    instance.consecutiveFails = 0;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - start}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
  }
}

async function pollJsonInstance(instance, transport, profile) {
  try {
    const start = Date.now();
    const data = await transport.poll();

    const metrics = {};
    const units = {};
    const prefix = instance.prefix || '';
    const mappings = instance.mappings || null;
    // Build reverse lookup: path → metric name (mappings is { metricName → path })
    let pathToMetric = null;
    if (mappings) {
      pathToMetric = {};
      for (const [metric, key] of Object.entries(mappings)) {
        pathToMetric[key] = metric;
      }
    }

    for (const field of profile.fields) {
      let raw = getByPath(data, field.path);
      if (raw === undefined || raw === null || (typeof raw === 'number' && isNaN(raw))) continue;

      // Mapping override logic
      let metricName;
      if (pathToMetric) {
        const key = field.path; // e.g., "realtime.ACin[0][0]"
        if (pathToMetric[key] !== undefined) {
          metricName = pathToMetric[key];
        } else {
          continue; // skip unmapped when mappings exist
        }
      } else {
        metricName = prefix + field.name;
      }

      if (typeof raw === 'string') {
        raw = parseInt(raw, 10);
        if (isNaN(raw)) continue;
      }

      const value = parseFloat((raw * (field.scale || 1)).toFixed(4));
      metrics[metricName] = value;
      if (field.unit) units[metricName] = field.unit;
    }

    writeMetrics(metrics, units);
    instance.lastSeen = Date.now();
    instance.consecutiveFails = 0;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - start}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
  }
}

/**
 * Convert a raw register payload (2 bytes per word, as received on the wire —
 * byte_order 'le' means each word arrives little-endian) into the namespaced
 * registerData map consumed by decodeLuxpowerMetrics. `start` is the first
 * register address carried by the frame/read; `space` is 'input' (devFn 0x04)
 * or 'holding' (devFn 0x03). Keys are 'space:<decimal address>'. Pure — no I/O.
 */
function luxpowerWordsFromBuffer(profile, buffer, start, space) {
  const registerData = {};
  if (!Buffer.isBuffer(buffer)) return registerData;
  const leSwap = profile.byte_order === 'le';
  const count = Math.floor(buffer.length / 2);
  for (let i = 0; i < count; i++) {
    let v = buffer.readUInt16BE(i * 2);
    if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
    registerData[`${space}:${start + i}`] = v;
  }
  return registerData;
}

/**
 * Shared LuxPower metric decode (issue #106 phase 2) — the ONE decode path used
 * by both the active poll cycle (pollLuxpowerInstance) and unsolicited push
 * handling (handleLuxpowerFrame), so a holding push decodes into holding
 * metrics exactly like an active holding read. registerData keys are namespaced
 * 'space:<decimal addr>' (see luxpowerWordsFromBuffer); input and holding share
 * register address space and never collide because words are keyed per space.
 * count:2 uint32 entries combine two adjacent words (word_order lsb_first →
 * lower address holds the low word) BEFORE scale; explicit-mapping + prefix
 * semantics are identical to the poll path (emit ONLY instance.mappings
 * entries; zero mappings on an explicit profile → warn once per boot via the
 * instance flag and emit nothing). Pure — does NOT write metrics or touch the
 * DB; callers funnel the returned {metrics, units} into writeMetrics.
 */
function decodeLuxpowerMetrics(profile, instance, registerData) {
  const metrics = {};
  const units = {};
  const prefix = instance.prefix || '';
  const mappings = hasMappings(instance) ? instance.mappings : null;
  const explicit = profile.mapping === 'explicit';
  // Reverse lookup: (namespaced) register key → metric name
  const regToMetric = {};
  if (mappings) {
    for (const [metric, reg] of Object.entries(mappings)) {
      regToMetric[reg] = metric;
    }
  }

  if (explicit && !mappings) {
    // Explicit-mapping profile with nothing mapped — nothing can be emitted.
    // Warn once per instance per boot (shared flag across poll + push paths).
    if (!instance._luxpowerNoMappingsWarned) {
      instance._luxpowerNoMappingsWarned = true;
      logger.warn(`[dongle] luxpower ${instance.name}: no entity mappings — map profile entities in Dongle settings`);
    }
    return { metrics, units };
  }

  for (const m of profile.metrics) {
    // Mapping override logic — namespaced key first (AC16), then legacy bare
    // hex for configs saved before namespacing; unmapped → skip.
    let metricName;
    if (mappings) {
      const key = m.register_type ? `${m.register_type}:${m.register}` : m.register;
      metricName = regToMetric[key] !== undefined ? regToMetric[key] : regToMetric[m.register];
      if (metricName === undefined) continue;
    } else {
      metricName = prefix + m.name;
    }

    const addr = parseInt(m.register, 16);
    const space = m.register_type || 'holding';
    const wordAt = off => registerData[`${space}:${addr + off}`];
    let raw;

    if (m.type === 'uint64') {
      const w0 = wordAt(0);
      const w1 = wordAt(1);
      const w2 = wordAt(2);
      const w3 = wordAt(3);
      if (w0 === undefined || w1 === undefined || w2 === undefined || w3 === undefined) continue;
      raw = w3 * 0x1000000000000 + w2 * 0x100000000 + w1 * 0x10000 + w0;
    } else if (m.count === 2 && (m.type === 'uint32' || m.type === 'int32')) {
      // 32-bit word pair: word_order 'lsb_first' → the lower address holds
      // the LOW word; 'msb_first' swaps. Combined before scale.
      const loOff = m.word_order === 'lsb_first' ? 0 : 1;
      const hiOff = m.word_order === 'lsb_first' ? 1 : 0;
      const lo = wordAt(loOff);
      const hi = wordAt(hiOff);
      if (lo === undefined || hi === undefined) continue;
      raw = hi * 0x10000 + lo;
      if (m.type === 'int32' && raw > 0x7FFFFFFF) raw -= 0x100000000;
    } else {
      raw = wordAt(0);
      if (raw === undefined) continue;
      if (m.bit !== undefined) raw = (raw >> m.bit) & 1;
      if (m.type === 'int16' && raw > 0x7FFF) raw -= 0x10000;
    }

    const value = parseFloat((raw * (m.scale || 1)).toFixed(4));
    metrics[metricName] = value;
    if (m.unit) units[metricName] = m.unit;
  }
  return { metrics, units };
}

/**
 * LuxPower local-TCP poll cycle (issue #106 phase 2): reads EVERY input range
 * from profile.read_ranges.input (devFn 0x04) and, when the profile models
 * holding metrics or advertises capabilities.write, every holding range from
 * profile.read_ranges.holding (devFn 0x03). Falls back to ranges derived from
 * the profile's input/holding metrics when read_ranges is absent. Input and
 * holding share register address space, so decoded words are keyed by namespace
 * (input:N / holding:N) and register keys stay namespaced input:0xNNNN /
 * holding:0xNNNN — the two spaces never collide. count:2 uint32 entries combine
 * two adjacent words (word_order lsb_first → lower address is the low word)
 * BEFORE scale; holding metrics decode through this same shared path as input.
 * mapping:'explicit' profiles emit ONLY instance.mappings entries (zero
 * mappings → warn once per boot, emit nothing). One range read failure logs and
 * continues the cycle instead of killing it. All reads are sequential awaits so
 * the transport's single-flight queue is respected.
 */
async function pollLuxpowerInstance(instance, transport, profile) {
  try {
    const start = Date.now();
    const inputMetrics = profile.metrics.filter(m => (m.register_type || 'holding') === 'input');
    const holdingMetrics = profile.metrics.filter(m => (m.register_type || 'holding') === 'holding');

    const readRanges = profile.read_ranges;
    const inputRanges = (readRanges && Array.isArray(readRanges.input))
      ? readRanges.input.map(r => ({ start: r[0], count: r[1] }))
      : buildPollRanges(inputMetrics);
    // Holding is the only writable space, so write-capable profiles poll it too.
    const pollHolding = holdingMetrics.length > 0 || !!(profile.capabilities && profile.capabilities.write);
    const holdingRanges = (readRanges && Array.isArray(readRanges.holding))
      ? readRanges.holding.map(r => ({ start: r[0], count: r[1] }))
      : (holdingMetrics.length ? buildPollRanges(holdingMetrics) : []);

    // Words are stored per namespace so identical input/holding addresses never
    // overwrite each other (decimal key suffix; hex is only used for mapping).
    const registerData = {};
    const readRangesInto = async (ranges, devFn, space) => {
      for (const range of ranges) {
        try {
          const buf = await transport.readRegisters(range.start, range.count, devFn);
          if (buf.length < range.count * 2) {
            logger.warn(`[dongle] ${instance.name}: short buffer at ${space} range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
          }
          Object.assign(registerData, luxpowerWordsFromBuffer(profile, buf, range.start, space));
        } catch (e) {
          // A failed range must not kill the rest of the cycle — log + continue.
          logger.warn(`[dongle] ${instance.name}: ${space} range read failed at ${range.start} (count ${range.count}) — ${e.message}`);
        }
      }
    };
    await readRangesInto(inputRanges, 0x04, 'input');
    if (pollHolding) await readRangesInto(holdingRanges, 0x03, 'holding');

    // Shared decode path — identical semantics for active reads and for
    // unsolicited pushes (handleLuxpowerFrame) since issue #106 (AC7).
    const { metrics, units } = decodeLuxpowerMetrics(profile, instance, registerData);

    writeMetrics(metrics, units);
    instance.lastSeen = Date.now();
    instance.consecutiveFails = 0;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - start}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
  }
}

/**
 * Unsolicited LuxPower frames (e.g. the inverter's ~2s holding pushes: devFn
 * 0x03, start 0, byte_len 160). Since issue #106 phase 2 these decode into
 * holding metrics THROUGH THE SAME shared decode path as the active poll cycle
 * (decodeLuxpowerMetrics + writeMetrics, honoring explicit-mapping + prefix
 * semantics) — a push is free data freshness, not just liveness. Pushes still
 * NEVER satisfy a pending read (that is transport-level discrimination) and
 * always update lastSeen/consecutiveFails. Frames with no decodable profile
 * payload (devFn other than 0x03/0x04, or empty values) fall back to
 * liveness-only behaviour.
 */
function handleLuxpowerFrame(instance, profile, parsed) {
  instance.lastSeen = Date.now();
  instance.consecutiveFails = 0;
  // devFn → register space: 0x03 holding (ReadHold), 0x04 input (ReadInput).
  const space = parsed.devFn === 0x04 ? 'input' : (parsed.devFn === 0x03 ? 'holding' : null);
  let metricCount = 0;
  if (profile && space && Buffer.isBuffer(parsed.values) && parsed.values.length >= 2) {
    try {
      const registerData = luxpowerWordsFromBuffer(profile, parsed.values, parsed.start, space);
      const { metrics, units } = decodeLuxpowerMetrics(profile, instance, registerData);
      metricCount = Object.keys(metrics).length;
      if (metricCount > 0) writeMetrics(metrics, units);
    } catch (e) {
      // A bad push must never take liveness down — decode failure is logged only.
      logger.warn(`[dongle] ${instance.name}: unsolicited luxpower frame decode failed — ${e.message}`);
    }
  }
  logger.debug(`[dongle] ${instance.name}: unsolicited luxpower frame devFn=0x${parsed.devFn.toString(16)} start=0x${parsed.start.toString(16)} byteLen=${parsed.byteLen} → ${metricCount} holding/input metrics`);
}

function getByPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    const match = part.match(/^(.+?)\[(\d+)\]\[(\d+)\]$/);
    if (match) {
      cur = cur[match[1]];
      if (!cur) return undefined;
      cur = cur[parseInt(match[2])];
      if (!cur) return undefined;
      cur = cur[parseInt(match[3])];
    } else {
      const arrMatch = part.match(/^(.+?)\[(\d+)\]$/);
      if (arrMatch) {
        cur = cur[arrMatch[1]];
        if (!cur) return undefined;
        cur = cur[parseInt(arrMatch[2])];
      } else {
        cur = cur[part];
      }
    }
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

function getProfileById(id) {
  const profilePath = path.join(__dirname, '..', 'profiles', 'dongles', `${id}.json`);
  try {
    if (profileCache.has(id)) return profileCache.get(id);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profileCache.set(id, profile);
    return profile;
  } catch (e) {
    return null;
  }
}

async function executeDongleAction(deviceName, registerAddr, value) {
  const devices = JSON.parse(getConfig('dongle_config') || '[]');
  const device = devices.find(d => d.name === deviceName);
  if (!device || !device.enabled) return { error: 'Dongle device not found or disabled' };

  const transportType = device.transport || 'modbus-tcp';

  // Growatt dongles are push-only (inbound TCP server) — writes are not supported.
  if (transportType === 'growatt') {
    return { error: 'Growatt not supported — push-only, write actions are not available' };
  }

  // Felicity inverters speak a proprietary JSON API, not Modbus registers.
  const profile = getProfileById(device.profile);
  if (transportType === 'felicity-tcp' || profile?.protocol === 'felicity-tcp') {
    return { error: 'felicity-tcp dongles use a proprietary JSON API and do not support Modbus register writes' };
  }

  // LuxPower local TCP: phase 1 shipped read-only; phase 2 (issue #106) writes
  // holding registers via Modbus fn 0x06 (write-single) when the profile's
  // capabilities.write is true. Profiles without write support keep the original
  // phase-1 read-only error verbatim.
  if (transportType === 'luxpower-tcp' || profile?.protocol === 'luxpower-tcp') {
    if (!profile || !profile.capabilities || profile.capabilities.write !== true) {
      return { error: 'luxpower-tcp is read-only in phase 1 — register writes are not supported' };
    }
    return executeLuxpowerWrite(device, profile, registerAddr, value);
  }

  if (isNaN(parseInt(registerAddr))) {
    return { error: 'Invalid register address' };
  }
  const addr = parseInt(registerAddr);
  const val = parseInt(value) || 0;

  try {
    if (transportType === 'solarman-v5') {
      if (!device.serial_number) {
        return { error: 'solarman-v5 write requires serial_number in dongle config' };
      }
      const { SolarmanV5Transport } = require('./dongle/solarmanV5');
      const transport = new SolarmanV5Transport({
        host: device.host || device.ip,
        port: device.port || 8899,
        serial_number: device.serial_number,
        modbus_unit_id: device.modbus_unit_id || 1
      });
      await transport.writeRegister(addr, val);
      return { success: true };
    }

    if (transportType === 'modbus-rtu') {
      return { error: 'modbus-rtu has moved to the RS232 path; use rs232_devices + executeRs232Action for register writes' };
    }

    // Default: plain Modbus TCP (transport 'modbus-tcp' or unset)
    const { ModbusTcpTransport } = require('./dongle/modbusTcp');
    const transport = new ModbusTcpTransport({
      host: device.host || device.ip,
      port: device.port || 502,
      modbus_unit_id: device.modbus_unit_id || 1
    });
    await transport.writeRegister(addr, val);
    return { success: true };
  } catch (e) {
    logger.error(`Dongle write error for ${deviceName}/register ${registerAddr}: ${e.message}`);
    return { error: e.message };
  }
}

/**
 * LuxPower local-TCP register write (issue #106 phase 2): writes a single
 * holding register via Modbus fn 0x06 (write-single) over the shared transport
 * queue, resolving on the dongle's echo response. The entity handle is the
 * phase-2 namespaced form 'holding:0xNNNN', or legacy bare hex ('0xNNNN') /
 * decimal for backward compatibility. Only registers listed in the profile's
 * writable_registers are accepted (register_type must match a namespaced
 * handle); min/max/step are applied in RAW register units (matching the
 * transport write). kind:'value' writes the clamped/stepped word directly;
 * kind:'bitfield' does a read-modify-write preserving bits outside entry.mask
 * (no bitfield registers ship in phase 2 — implemented for catalog
 * forward-compat). Timeouts/errors resolve as { error }.
 */
async function executeLuxpowerWrite(device, profile, handle, value) {
  const trimmed = String(handle == null ? '' : handle).trim();
  let addr = null;
  let handleType = null;
  const namespaced = trimmed.match(/^(input|holding):((?:0x[0-9a-fA-F]+)|[0-9]+)$/);
  if (namespaced) {
    handleType = namespaced[1];
    addr = namespaced[2].startsWith('0x') ? parseInt(namespaced[2], 16) : parseInt(namespaced[2], 10);
  } else if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    addr = parseInt(trimmed, 16);
  } else if (/^[0-9]+$/.test(trimmed)) {
    addr = parseInt(trimmed, 10);
  }
  if (addr === null || isNaN(addr)) return { error: 'Invalid register address' };

  const writable = profile.writable_registers || [];
  const entry = writable.find(w =>
    parseInt(w.register, 16) === addr &&
    (!handleType || !w.register_type || handleType === w.register_type)
  );
  if (!entry) {
    const listed = writable.length
      ? writable.map(w => `${w.register_type || 'holding'}:${w.register}`).join(', ')
      : 'none';
    return { error: `Register ${trimmed} is not writable on luxpower profile (writable_registers: ${listed})` };
  }

  const parsed = parseFloat(value);
  if (isNaN(parsed)) return { error: 'Invalid value for register write' };

  // Clamp + step-round in raw register units (catalog scale is 1 by design —
  // min/max/step match what the transport writes).
  let raw = parsed;
  const min = entry.min !== undefined && entry.min !== null ? Number(entry.min) : null;
  const max = entry.max !== undefined && entry.max !== null ? Number(entry.max) : null;
  const step = entry.step !== undefined && entry.step !== null && Number(entry.step) > 0 ? Number(entry.step) : null;
  if (min !== null) raw = Math.max(raw, min);
  if (max !== null) raw = Math.min(raw, max);
  if (step !== null) raw = Math.round(raw / step) * step;
  if (min !== null && raw < min) raw = min;
  if (max !== null && raw > max) raw = max;

  let transport = null;
  try {
    transport = new LuxpowerTcpTransport({
      host: device.host || device.ip,
      port: device.port || profile.default_port || 8000,
      dongle_serial: device.dongle_serial || device.serial_number,
      inverter_serial: device.inverter_serial || device.serial_number
    });
    let writeValue = Math.round(raw);
    if (writeValue < 0 || writeValue > 0xFFFF) {
      return { error: `Value ${writeValue} out of 16-bit register range` };
    }
    if ((entry.kind || 'value') === 'bitfield') {
      // Read-modify-write: keep the bits outside entry.mask, set the writable
      // bits from the requested value.
      const buf = await transport.readRegisters(addr, 1, 0x03);
      if (buf.length < 2) return { error: `Short read on register ${trimmed}` };
      let cur = buf.readUInt16BE(0);
      if (profile.byte_order === 'le') cur = ((cur & 0xFF) << 8) | (cur >> 8);
      const mask = entry.mask !== undefined && entry.mask !== null ? Number(entry.mask) : 0xFFFF;
      writeValue = (cur & (~mask & 0xFFFF)) | (writeValue & mask);
    }
    await transport.writeRegister(addr, writeValue);
    return { success: true };
  } catch (e) {
    logger.error(`Dongle write error for ${device.name || device.host || handle}/register ${trimmed}: ${e.message}`);
    return { error: e.message };
  } finally {
    if (transport) { try { transport.stop(); } catch (_) {} }
  }
}

module.exports = {
  startDonglePolling, stopDonglePolling, restartDonglePolling,
  executeDongleAction, getProfileById,
  // Shared LuxPower decode helpers (pure) — exported for unit tests (AC4/R4
  // golden fixture + push-decode coverage in the frame/socket suites).
  luxpowerWordsFromBuffer, decodeLuxpowerMetrics, handleLuxpowerFrame
};
