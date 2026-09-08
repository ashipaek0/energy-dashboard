/**
 * Growatt TCP Server Transport — receives periodic data pushes from Growatt WiFi dongles.
 *
 * The Growatt dongle must be reconfigured (via its web UI) to point to the Epilykos host
 * instead of server.growatt.com. The dongle pushes energy data every ~5 minutes.
 *
 * Protocol: 8-byte Big-Endian header + payload + 2-byte checksum.
 * Supports v1.24 (proto 0x0103) and v3.05 (proto 0x0104) frames.
 *
 * @module dongle/growatt
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');

class GrowattServer {
  /**
   * @param {object[]} instances — dongle config entries with transport === 'growatt'
   * @param {function} writeFn — writeMetrics(metrics) callback
   */
  constructor(instances, writeFn) {
    this.instances = instances.filter(i => i.transport === 'growatt' && i.enabled);
    this.writeMetrics = writeFn;
    this.port = this.instances[0]?.port || 5279;
    this.server = null;
    this.profiles = {};
    for (const inst of this.instances) {
      if (inst.profile && !this.profiles[inst.profile]) {
        this.profiles[inst.profile] = loadProfile(inst.profile);
      }
    }
  }

  start() {
    if (this.instances.length === 0) return;
    this.server = net.createServer(socket => {
      const remote = `${socket.remoteAddress}:${socket.remotePort}`;
      logger.info(`[dongle:growatt] connection from ${remote}`);

      let buffer = Buffer.alloc(0);

      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 8) {
          const dataLen = buffer.readUInt16BE(4);
          const totalLen = 8 + dataLen;
          if (buffer.length < totalLen) break;

          try {
            const frame = buffer.slice(0, totalLen);
            buffer = buffer.slice(totalLen);
            this._processFrame(frame);
          } catch (e) {
            logger.warn(`[dongle:growatt] frame error: ${e.message}`);
            buffer = buffer.slice(1);
          }
        }
      });

      socket.on('error', err => logger.warn(`[dongle:growatt] socket error: ${err.message}`));
      socket.on('close', () => logger.info(`[dongle:growatt] ${remote} disconnected`));
    });

    this.server.listen(this.port, () => {
      logger.info(`[dongle:growatt] listening on :${this.port}`);
    });
  }

  _processFrame(buf) {
    const protoId = buf.readUInt16BE(2);
    const unitId = buf[6];
    const funcCode = buf[7];

    if (funcCode !== 0x04) return;

    const payload = buf.slice(8, buf.length - 2);
    const checksum = buf.readUInt16BE(buf.length - 2);

    let sum = 0;
    for (let i = 0; i < buf.length - 2; i++) sum += buf[i];
    if ((sum & 0xFFFF) !== checksum) throw new Error('checksum mismatch');

    let data;
    if (protoId === 0x0103) data = this._parseV1_24(payload);
    else if (protoId === 0x0104) data = this._parseV3_05(payload);
    else return;

    const instance = this.instances.find(i => i.modbus_unit_id === unitId) || this.instances[0];
    if (!instance) return;

    const profile = this.profiles[instance.profile];
    if (!profile) return;

    const prefix = instance.prefix || '';
    const mappings = instance.mappings || null;
    // Build reverse lookup: field → metric name (mappings is { metricName → m.field })
    let fieldToMetric = null;
    if (mappings) {
      fieldToMetric = {};
      for (const [metric, field] of Object.entries(mappings)) {
        fieldToMetric[field] = metric;
      }
    }

    const metrics = {};
    for (const m of profile.metrics) {
      const val = data[m.field];
      if (val !== undefined && val !== null && !isNaN(val)) {
        let metricName;
        if (fieldToMetric) {
          const key = m.field; // e.g., "pv1_power"
          if (fieldToMetric[key] !== undefined) {
            metricName = fieldToMetric[key];
          } else {
            // Key not in mappings at all — skip unmapped when mappings exist
            continue;
          }
        } else {
          metricName = prefix + m.name;
        }
        metrics[metricName] = parseFloat((val * (m.scale || 1)).toFixed(4));
      }
    }

    this.writeMetrics(metrics);
    instance.lastSeen = Date.now();
  }

  /** Parse Growatt v1.24 energy data payload */
  _parseV1_24(payload) {
    let offset = 0;
    const result = {};

    result.datalogger_serial = payload.slice(offset, offset + 10).toString('ascii').trim();
    offset += 10;
    result.inverter_serial = payload.slice(offset, offset + 10).toString('ascii').trim();
    offset += 10;

    result.pv1_voltage = payload.readUInt16BE(offset) * 0.1;
    result.pv1_current = payload.readUInt16BE(offset + 2) * 0.1;
    result.pv1_power = payload.readUInt16BE(offset + 4) * 0.1;
    result.pv2_voltage = payload.readUInt16BE(offset + 6) * 0.1;
    result.pv2_current = payload.readUInt16BE(offset + 8) * 0.1;
    result.pv2_power = payload.readUInt16BE(offset + 10) * 0.1;
    offset += 12;

    result.ac_voltage_r = payload.readUInt16BE(offset) * 0.1;
    result.ac_current_r = payload.readUInt16BE(offset + 2) * 0.1;
    result.ac_power = payload.readUInt16BE(offset + 4) * 0.1;
    result.ac_frequency = payload.readUInt16BE(offset + 6) * 0.01;
    offset += 8;

    result.grid_power = payload.readUInt16BE(offset) * 0.1;
    offset += 2;

    result.battery_voltage = payload.readUInt16BE(offset) * 0.1;
    offset += 2;

    result.inverter_temp = payload.readUInt16BE(offset) * 0.1;
    offset += 2;

    result.daily_solar_kwh = payload.readUInt16BE(offset) * 0.1;
    const hi = payload.readUInt16BE(offset + 2);
    const lo = payload.readUInt16BE(offset + 4);
    result.total_solar_kwh = (hi * 65536 + lo) * 0.1;

    return result;
  }

  /** Parse Growatt v3.05 energy data payload — same structure, different register offsets */
  _parseV3_05(payload) {
    let offset = 0;
    const result = {};

    result.datalogger_serial = payload.slice(offset, offset + 10).toString('ascii').trim();
    offset += 10;
    result.inverter_serial = payload.slice(offset, offset + 10).toString('ascii').trim();
    offset += 10;

    result.pv1_voltage = payload.readUInt16BE(offset) * 0.1;
    result.pv1_current = payload.readUInt16BE(offset + 2) * 0.1;
    result.pv1_power = payload.readUInt16BE(offset + 4) * 0.1;
    result.pv2_voltage = payload.readUInt16BE(offset + 6) * 0.1;
    result.pv2_current = payload.readUInt16BE(offset + 8) * 0.1;
    result.pv2_power = payload.readUInt16BE(offset + 10) * 0.1;
    offset += 12;

    result.ac_voltage_r = payload.readUInt16BE(offset) * 0.1;
    result.ac_current_r = payload.readUInt16BE(offset + 2) * 0.1;
    result.ac_power = payload.readUInt16BE(offset + 4) * 0.1;
    result.ac_frequency = payload.readUInt16BE(offset + 6) * 0.01;
    offset += 8;

    result.grid_power = payload.readUInt16BE(offset) * 0.1;
    offset += 2;

    result.battery_voltage = payload.readUInt16BE(offset) * 0.1;
    offset += 2;

    result.inverter_temp = payload.readUInt16BE(offset) * 0.1;
    offset += 2;

    result.daily_solar_kwh = payload.readUInt16BE(offset) * 0.1;
    const hi = payload.readUInt16BE(offset + 2);
    const lo = payload.readUInt16BE(offset + 4);
    result.total_solar_kwh = (hi * 65536 + lo) * 0.1;

    return result;
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
  }
}

function loadProfile(profileId) {
  const profilePath = path.join(__dirname, '..', '..', 'profiles', 'dongles', `${profileId}.json`);
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (e) {
    logger.error(`[dongle:growatt] Failed to load profile ${profileId}: ${e.message}`);
    return null;
  }
}

module.exports = { GrowattServer };
