/**
 * solax-decoder.js
 * Decoder for SolaX Pocket USB AA55 binary protocol.
 * 
 * Protocol:
 *   Frame: [AA 55][size][ctrl][func][payload...][chk_lo][chk_hi]
 *   Checksum: 16-bit additive little-endian over all preceding bytes
 *   Functions: 0x01=Register dongle, 0x05=Request serial, 0x0C=Request data
 * 
 * Reference: https://github.com/jesserockz/aiosolax-uart (Python)
 */

const { additiveChecksum16LE, toHexString } = require('./rs232-utils');

/**
 * Build a SolaX request frame.
 * @param {object} cmd - Command definition from profile ({ function, control, payload })
 * @param {object} profile - Profile JSON
 * @returns {Buffer} Complete frame with header + payload + checksum
 */
function encodeQuery(cmd, profile) {
  const func = cmd.function || 0x01;
  const ctrl = cmd.control || 0x01;
  const payloadStr = cmd.payload || '';
  const payload = Buffer.from(payloadStr, 'ascii');

  // Build frame body (everything after header up to checksum)
  const body = Buffer.concat([
    Buffer.from([0xAA, 0x55]),
    Buffer.alloc(1), // size placeholder
    Buffer.from([ctrl, func]),
    payload,
  ]);

  // Size = total frame bytes including all body fields minus header
  // Size byte at offset 2 = number of bytes from ctrl to end of payload
  body[2] = 2 + payload.length; // ctrl(1) + func(1) + payload(N)

  // Calculate additive 16-bit LE checksum over body[2] .. body[end]
  const checksum = additiveChecksum16LE(body.slice(2));
  const chkLo = checksum & 0xFF;
  const chkHi = (checksum >> 8) & 0xFF;

  return Buffer.concat([body, Buffer.from([chkLo, chkHi])]);
}

/**
 * Decode a SolaX response frame.
 * @param {Buffer} buffer - Raw response from inverter
 * @param {object} cmd - Command that was sent
 * @param {object} profile - Profile JSON with fields definition
 * @param {object} [mappings] - Optional explicit mappings { metricName → `${cmd.name}:${field.offset}` }.
 *   When present, only mapped fields are emitted under their mapped metric names
 *   (skip unmapped); when absent, every field decodes under its profile-default
 *   `field.metric` name (byte-identical to pre-mapping behavior).
 * @returns {object} { metric_name: value, ... }
 */
function decodeResponse(buffer, cmd, profile, mappings) {
  if (buffer.length < 7) {
    throw new Error(`Solax response too short: ${buffer.length} bytes`);
  }

  // Validate header
  if (buffer[0] !== 0xAA || buffer[1] !== 0x55) {
    throw new Error(`Invalid SolaX header: ${toHexString(buffer.slice(0, 2))}`);
  }

  // Validate checksum
  const bodyEnd = buffer.length - 2; // exclude checksum bytes
  const expectedChk = additiveChecksum16LE(buffer.slice(2, bodyEnd));
  const actualChk = buffer.readUInt16LE(bodyEnd);
  if (expectedChk !== actualChk) {
    throw new Error(`SolaX checksum mismatch: expected ${expectedChk.toString(16)}, got ${actualChk.toString(16)}`);
  }

  // For register/request_serial responses, just acknowledge (no metric data)
  if (cmd.function <= 5) {
    return {};
  }

  // For request_data (0x0C), extract payload
  // Frame: AA 55 [size] [ctrl] [func] [payload...] [chk_lo] [chk_hi]
  // Payload starts at offset 5 (AA=0, 55=1, size=2, ctrl=3, func=4)
  const payloadOffset = 5;
  const payloadData = buffer.slice(payloadOffset, bodyEnd);

  const results = {};
  // Build reverse lookup: handle → metric name (mappings is { metricName → "cmd.name:offset" })
  let keyToMetric = null;
  if (mappings) {
    keyToMetric = {};
    for (const [metric, key] of Object.entries(mappings)) {
      keyToMetric[key] = metric;
    }
  }

  for (const field of profile.fields || []) {
    const offset = field.offset;
    if (offset + 2 > payloadData.length) continue; // field out of range

    let raw;
    if (field.type === 'uint16') {
      raw = payloadData.readUInt16LE(offset);
    } else if (field.type === 'int16') {
      raw = payloadData.readInt16LE(offset);
    } else if (field.type === 'uint32') {
      if (offset + 4 > payloadData.length) continue;
      raw = payloadData.readUInt32LE(offset);
    } else {
      raw = payloadData.readUInt16LE(offset);
    }

    let value = raw * (field.scale || 1);
    // Round to sensible precision
    value = parseFloat(value.toFixed(4));

    // Mapping override logic
    let metricName;
    if (keyToMetric) {
      const key = `${cmd.name}:${offset}`;
      if (keyToMetric[key] !== undefined) {
        metricName = keyToMetric[key];
      } else {
        continue; // skip unmapped when mappings exist
      }
    } else {
      metricName = field.metric;
    }
    results[metricName] = value;
  }

  return results;
}

module.exports = { encodeQuery, decodeResponse };
