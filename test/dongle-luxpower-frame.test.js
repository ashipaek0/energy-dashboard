#!/usr/bin/env node
/**
 * test/dongle-luxpower-frame.test.js
 * Frame-level validation for the LuxPower local-TCP transport (issue #102),
 * covering AC1-AC6 plus structural validation of the phase-2 profile
 * profiles/dongles/luxpower-geta.json (AC15, issue #107: write:false,
 * empty writable_registers, input+holding scopes, count:2 uint32 lsb_first pairs,
 * read_ranges coverage, explicit mapping). Issue #109 widened the live scope —
 * wide-sweep holding 0x0C-0xFE (was 0x00-0x77), input <= 0xEE (was 0xE8) — and
 * added 42 metrics (40 holding + 2 input) with decode spot-checks AC9-AC12.
 *
 * Fixtures marked REAL were captured from the live GETA dongle (serials replaced
 * with synthetic LXP fixtures for public-repo hygiene, #105) on 2026-09-05
 * (/home/ubuntu/epilykos-tracker/luxpower-geta-discovery.json, crcOk:true) —
 * genuine wire response frames, not synthesized; serial bytes rewritten in place
 * and CRCs recomputed via the module's own crc16Modbus. Original capture on user
 * hardware.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildReadFrame,
  buildWriteFrame,
  parseFrame,
  crc16Modbus,
  DEV_FN_HOLDING,
  DEV_FN_INPUT,
  DEV_FN_WRITE_SINGLE
} = require('../modules/dongle/luxpowerTcp');

// ---------------------------------------------------------------------------
// Golden + REAL wire fixtures
// ---------------------------------------------------------------------------

// AC2 golden request (pcap-derived): readRegisters(start=0, count=40, devFn=0x04)
const AC2_HEX = 'a11a0500200001c24c585030303030303031120000044c58503030303030303200002800527a';
const AC2 = Buffer.from(AC2_HEX, 'hex');

// REAL: input registers 0-39 response (devFn 0x04, start 0, byte_len 0x50)
const REAL_INPUT_0_39 = Buffer.from('a11a05006f0001c24c585030303030303031610001044c585030303030303032000050140036090000000012015e000000ae010000000000000000690800008138a51358010000aa0000006b0810325c10a6130000000000004f023600000000001c002700270026003000000052008a10fb0ecc40', 'hex');

// REAL: input registers 40-79 response (devFn 0x04, start 40, byte_len 0x50)
const REAL_INPUT_40_79 = Buffer.from('a11a05006f0001c24c585030303030303031610001044c5850303030303030322800503600000000000000000000001c00000027000000270000002600000030000000000000005200000000000000000000002b002700310000000000ea2a0100000000000000000000000000200000000000accd', 'hex');

// REAL: input registers 80-119 response (devFn 0x04, start 80, byte_len 0x50)
const REAL_INPUT_80_119 = Buffer.from('a11a05006f0001c24c585030303030303031610001044c5850303030303030325000501104cb01e80312019600000000000000000000007132bfab0e03f0606d1003000000b301000000000000000000000000000012010000120100000000000000000000040100004c585030303030303032b4b4', 'hex');

// REAL: holding registers 80-119 response (devFn 0x03, start 80, byte_len 0x50)
const REAL_HOLDING_80_119 = Buffer.from('a11a05006f0001c24c585030303030303031610001034c5850303030303030325000500000000000000000000000000000000000000000e600320000000000000000000000000000001c01d20064006400000000000f0038ff260200009001810c000000000100000000000000000000001400a3c2', 'hex');

// REAL: unsolicited holding 0-79 push (devFn 0x03, start 0, byte_len 0xA0)
const REAL_UNSOL_HOLDING_0_79 = Buffer.from('a11a0500bf0001c24c585030303030303031b10001034c5850303030303030320000a0601101004c585030303030303032434a41410000092100001a0905102f1501000000000000001a000100800b1e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000173b00000000000000000000640000000000000000006310', 'hex');

// ---------------------------------------------------------------------------
// AC1: CRC16/Modbus over the known-good request inner (serials swapped to
// synthetic LXP fixtures per #105, CRC recomputed) = 0x7A52 (wire 52 7a)
// ---------------------------------------------------------------------------
{
  const inner = AC2.slice(20, AC2.length - 2);
  assert.strictEqual(crc16Modbus(inner), 0x7A52, 'AC1: CRC over request inner must be 0x7A52');
  assert.strictEqual(AC2[AC2.length - 2], 0x52, 'AC1: CRC stored low byte must be 0x52');
  assert.strictEqual(AC2[AC2.length - 1], 0x7A, 'AC1: CRC stored high byte must be 0x7A');
  console.log('PASS AC1: crc16Modbus(request inner) = 0x' + crc16Modbus(inner).toString(16) + ' (wire 52 7a)');
}

// ---------------------------------------------------------------------------
// AC2: builder byte-matches the 38-byte pcap golden frame
// ---------------------------------------------------------------------------
{
  const built = buildReadFrame({ protocol: 5, dongle: 'LXP0000001', inverter: 'LXP0000002', devFn: 0x04, start: 0, count: 40 });
  assert.strictEqual(built.length, 38, 'AC2: built frame must be 38 bytes');
  assert.ok(built.equals(AC2), 'AC2: built frame must byte-match golden pcap frame');
  console.log('AC2: buildReadFrame(...) byte-matches golden hex (' + AC2_HEX + ')');
}

// ---------------------------------------------------------------------------
// AC3: builder validation throws
// ---------------------------------------------------------------------------
{
  const base = { protocol: 5, dongle: 'LXP0000001', inverter: 'LXP0000002', devFn: 0x04, start: 0, count: 1 };
  assert.throws(() => buildReadFrame({ ...base, dongle: 'LXP1' }), /dongle must be exactly 10 alphanumeric/, 'AC3: short dongle serial must throw');
  assert.throws(() => buildReadFrame({ ...base, dongle: 'LXP000000!' }), /dongle must be exactly 10 alphanumeric/, 'AC3: non-alnum dongle serial must throw');
  assert.throws(() => buildReadFrame({ ...base, inverter: 'INV0000' }), /inverter must be exactly 10 alphanumeric/, 'AC3: short inverter serial must throw');
  assert.throws(() => buildReadFrame({ ...base, devFn: 0x06 }), /devFn must be 0x03 \(holding\) or 0x04 \(input\)/, 'AC3: devFn 0x06 must throw');
  assert.throws(() => buildReadFrame({ ...base, start: -1 }), /start must be within 0\.\.0xFFFF/, 'AC3: negative start must throw');
  assert.throws(() => buildReadFrame({ ...base, start: 0x10000 }), /start must be within 0\.\.0xFFFF/, 'AC3: start 0x10000 must throw');
  assert.throws(() => buildReadFrame({ ...base, count: 0 }), /count must be within 1\.\.0xFFFF/, 'AC3: count 0 must throw');
  assert.throws(() => buildReadFrame({ ...base, count: 0x10000 }), /count must be within 1\.\.0xFFFF/, 'AC3: count 0x10000 must throw');
  assert.throws(() => buildReadFrame({ ...base, start: 'abc' }), /start must be within/, 'AC3: non-numeric start must throw');
  // Both valid function codes still build (devFn lands at inner[1] == frame[21])
  for (const fn of [DEV_FN_HOLDING, DEV_FN_INPUT]) {
    const f = buildReadFrame({ ...base, devFn: fn, count: 2 });
    assert.strictEqual(f[21], fn, 'AC3: devFn byte must be written to frame[21]');
  }
  console.log('PASS AC3: builder validation (serials/devFn/start/count) throws as required');
}

// ---------------------------------------------------------------------------
// AC4: parser extracts action/dev_fn/serial/start/byte_len/values on REAL frames
// ---------------------------------------------------------------------------
function parseAndCheck(buf, expect, label) {
  const stored = buf.readUInt16LE(buf.length - 2);
  const computed = crc16Modbus(buf.slice(20, buf.length - 2));
  assert.strictEqual(stored, computed, `${label}: stored CRC 0x${stored.toString(16)} must match computed 0x${computed.toString(16)}`);
  const p = parseFrame(buf);
  assert.strictEqual(p.action, 1, `${label}: action must be 0x01`);
  assert.strictEqual(p.devFn, expect.devFn, `${label}: dev_fn`);
  assert.strictEqual(p.inverter, 'LXP0000002', `${label}: inverter serial`);
  assert.strictEqual(p.start, expect.start, `${label}: start register`);
  assert.strictEqual(p.byteLen, expect.byteLen, `${label}: byte_len`);
  assert.strictEqual(p.values.length, expect.byteLen, `${label}: values length must equal byte_len`);
  assert.strictEqual(p.frameLen, buf.length - 6, `${label}: frame_len + 6 must equal total length`);
  assert.strictEqual(p.dataLen, p.frameLen - 14, `${label}: data_len must equal frame_len - 14`);
  return p;
}

{
  const p0 = parseAndCheck(REAL_INPUT_0_39, { devFn: 0x04, start: 0, byteLen: 0x50 }, 'AC4: REAL input 0-39');
  // Live-decoded values (little-endian words, per discovery input map)
  assert.strictEqual(p0.values.readUInt16LE(0 * 2), 20, 'reg0 operational_state = 20');
  assert.strictEqual(p0.values.readUInt16LE(1 * 2), 2358, 'reg1 pv1_voltage raw = 2358 (235.8V @0.1)');
  assert.strictEqual(p0.values.readUInt16LE(4 * 2), 274, 'reg4 battery_voltage raw = 274 (27.4V @0.1)');
  assert.strictEqual(p0.values.readUInt16LE(5 * 2), 94, 'reg5 battery_soc = 94%');
  assert.strictEqual(p0.values.readUInt16LE(7 * 2), 430, 'reg7 pv1_power = 430W');
  assert.strictEqual(p0.values.readUInt16LE(12 * 2), 2153, 'reg12 grid_voltage raw = 2153 (215.3V @0.1)');
  assert.strictEqual(p0.values.readUInt16LE(15 * 2), 5029, 'reg15 grid_frequency raw = 5029 (50.29Hz @0.01)');

  parseAndCheck(REAL_INPUT_40_79, { devFn: 0x04, start: 40, byteLen: 0x50 }, 'AC4: REAL input 40-79');
  parseAndCheck(REAL_INPUT_80_119, { devFn: 0x04, start: 80, byteLen: 0x50 }, 'AC4: REAL input 80-119');
  parseAndCheck(REAL_HOLDING_80_119, { devFn: 0x03, start: 80, byteLen: 0x50 }, 'AC4: REAL holding 80-119');
  parseAndCheck(REAL_UNSOL_HOLDING_0_79, { devFn: 0x03, start: 0, byteLen: 0xA0 }, 'AC4: REAL unsolicited holding 0-79');

  console.log('PASS AC4: parseFrame extracts fields from 5 REAL captured frames (CRC verified on each)');
  console.log('  REAL input 0-39 live values: state=20 pv1=235.8V batt=27.4V soc=94% pv1_pwr=430W grid=215.3V freq=50.29Hz');
}

// ---------------------------------------------------------------------------
// AC5 note: fragmentation / junk-resync is exercised over a real socket in
// test/dongle-luxpower-socket.test.js (transport receive buffer is private;
// findMarker is not exported).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC6: malformed frames throw / corruption detectable (discard+resync is
// exercised over a real socket in the socket test)
// ---------------------------------------------------------------------------
{
  // Truncated frame — total shorter than frame_len + 6
  assert.throws(() => parseFrame(REAL_INPUT_0_39.slice(0, 30)), /frame length mismatch|too short/, 'AC6: truncated frame must throw');
  assert.throws(() => parseFrame(Buffer.from([0xA1, 0x1A, 0x05, 0x00])), /too short/, 'AC6: tiny buffer must throw');
  // Missing start marker
  const noMarker = Buffer.from(REAL_INPUT_0_39);
  noMarker[0] = 0x00;
  assert.throws(() => parseFrame(noMarker), /missing start marker/, 'AC6: missing A1 1A marker must throw');
  // Wrong TCP function byte (not 0xC2)
  const badFn = Buffer.from(REAL_INPUT_0_39);
  badFn[7] = 0x00;
  assert.throws(() => parseFrame(badFn), /unexpected tcp function/, 'AC6: non-0xC2 tcp function must throw');
  // Request frame (action 0x00) must not parse as a response
  assert.throws(() => parseFrame(AC2), /expected action 0x01/, 'AC6: action 0x00 request must throw in parseFrame');
  // Corruption flips CRC detectably at the pure-function level
  const corrupt = Buffer.from(REAL_INPUT_0_39);
  corrupt[50] ^= 0xFF;
  const storedCrc = corrupt.readUInt16LE(corrupt.length - 2);
  assert.notStrictEqual(crc16Modbus(corrupt.slice(20, corrupt.length - 2)), storedCrc, 'AC6: single flipped byte must break CRC');
  console.log('PASS AC6: truncated/malformed/bad-CRC frames detected (parse throws / CRC breaks)');
}

// ---------------------------------------------------------------------------
// AC15: profile structural validation (phase-2 schema: capabilities.write,
// writable_registers, input+holding register scope, count 1|2 with uint32
// lsb_first pairs, read_ranges coverage, explicit mapping)
// ---------------------------------------------------------------------------
{
  const PROFILE_PATH = path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json');
  assert.ok(fs.existsSync(PROFILE_PATH), 'AC15: profile luxpower-geta.json must exist');
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

  assert.strictEqual(profile.protocol, 'luxpower-tcp', 'AC15: protocol must be luxpower-tcp');
  assert.strictEqual(profile.transport, 'luxpower-tcp', 'AC15: transport must be luxpower-tcp');
  assert.strictEqual(profile.default_port, 8000, 'AC15: default_port must be 8000');
  assert.strictEqual(profile.byte_order, 'le', 'AC15: byte_order must be le (real values are LE words)');
  assert.strictEqual(profile.mapping, 'explicit', 'AC15: mapping must be explicit (issue #106 phase 2)');
  assert.ok(profile.capabilities && profile.capabilities.write === false, 'AC15: capabilities.write must be false (issue #107 — no surfaced writes)');
  assert.ok(Array.isArray(profile.metrics) && profile.metrics.length > 0, 'AC15: metrics[] required');

  // writable_registers: must be empty — no write registers surfaced (issue #107)
  const writable = profile.writable_registers || [];
  assert.strictEqual(writable.length, 0, 'AC15: writable_registers must be empty (issue #107)');
  // Formerly surfaced writable registers (0x0069 eod_soc, 0x004B charge_first_soc_limit,
  // 0x005A eps_voltage_set, 0x005B eps_frequency_set) must not reappear in any writable list
  const formerWritable = [0x0069, 0x004B, 0x005A, 0x005B];
  for (const w of writable) {
    const reg = parseInt(w.register, 16);
    assert.ok(!formerWritable.includes(reg), `AC15: former writable register ${w.register} must not be surfaced (issue #107)`);
  }

  const rangeCovers = (reg, type) => (profile.read_ranges && profile.read_ranges[type] || []).some(([s, c]) => reg >= s && reg < s + c);

  const seen = new Set();
  let inputCount = 0;
  let holdingCount = 0;
  let count2Count = 0;
  for (const m of profile.metrics) {
    assert.strictEqual(typeof m.name, 'string', 'AC15: metric name required');
    assert.ok(/^0x[0-9a-fA-F]+$/.test(m.register), `AC15: ${m.name} register must be hex 0xNNNN`);
    const reg = parseInt(m.register, 16);
    const rtype = m.register_type || 'holding';
    assert.ok(rtype === 'input' || rtype === 'holding', `AC15: ${m.name} register_type must be input or holding`);
    const count = m.count || 1;
    assert.ok(count === 1 || count === 2, `AC15: ${m.name} count must be 1 or 2`);
    if (rtype === 'input') {
      inputCount++;
      assert.ok(reg >= 0x00 && reg <= 0xEE, `AC15: input ${m.name} register ${m.register} outside scope 0x00..0xEE (issue #109)`);
      assert.ok(!(reg >= 0x73 && reg <= 0x77), `AC15: input ${m.name} register ${m.register} in serial region 0x73..0x77`);
    } else {
      holdingCount++;
      assert.ok(reg >= 0x0C && reg <= 0xFE, `AC15: holding ${m.name} register ${m.register} outside scope 0x0C..0xFE (identity 0x00..0x0B excluded, issue #109)`);
    }
    if (count === 2) {
      count2Count++;
      assert.strictEqual(m.type, 'uint32', `AC15: ${m.name} count:2 must be type uint32`);
      assert.strictEqual(m.word_order, 'lsb_first', `AC15: ${m.name} count:2 must be word_order lsb_first (lower addr = low word)`);
    }
    assert.ok(rangeCovers(reg, rtype), `AC15: ${m.name} register ${m.register} (${rtype}) not inside any ${rtype} read_range`);
    const pairKey = `${rtype}:${m.register}`;
    assert.ok(!seen.has(pairKey), `AC15: duplicate (register_type, register) ${pairKey}`);
    seen.add(pairKey);
  }
  assert.strictEqual(inputCount, 167, 'AC15: profile must hold exactly 167 input metrics (165 + 2 unmapped raws, issue #109)');
  assert.strictEqual(holdingCount, 58, 'AC15: profile must hold exactly 58 holding metrics (18 + 40, issue #109)');
  assert.strictEqual(count2Count, 20, 'AC15: count:2 uint32 metric count must stay 20 (issue #109 adds no count:2)');

  const names = profile.metrics.map(m => m.name);
  for (const n of ['operational_state', 'pv1_voltage', 'pv2_voltage', 'pv3_voltage', 'battery_voltage', 'battery_soc',
    'pv1_power', 'pv2_power', 'pv3_or_total_power', 'battery_charge_power', 'battery_discharge_power', 'grid_voltage', 'grid_frequency']) {
    assert.ok(names.includes(n), `AC15: starter metric ${n} missing from profile`);
  }
  // Issue #109 spot list (AC2 registry anchors)
  for (const n of ['float_charge_voltage', 'battery_nominal_voltage', 'equalization_interval', 'line_mode', 'system_enable_2',
    'soc_low_limit_eps_discharge', 'unmatched_battery_capacity', 'ac_charge_start_soc', 'delta_voltage',
    'unmapped_input_d3', 'unmapped_input_ee']) {
    assert.ok(names.includes(n), `AC15: issue-#109 metric ${n} missing from profile`);
  }
  assert.strictEqual(profile.metrics.length, names.length, 'AC15: metric names must be unique');
  assert.strictEqual(profile.metrics.length, seen.size, 'AC15: all (register_type, register) pairs unique');
  console.log(`PASS AC15: luxpower-geta.json valid — ${inputCount} input + ${holdingCount} holding metrics (${count2Count} count:2 uint32), issue #109 +42, mapping:explicit, write:false, ${writable.length} writable holding registers`);
}

// ---------------------------------------------------------------------------
// AC27 (issue #106 W2): buildWriteFrame unit test — 38-byte layout, field
// offsets, CRC coverage, validation throws (synthetic LXP serials only).
// ---------------------------------------------------------------------------
{
  const wf = buildWriteFrame({ protocol: 5, dongle: 'LXP0000001', inverter: 'LXP0000002', start: 0x69, value: 0x1234 });
  assert.strictEqual(wf.length, 38, 'AC27: write frame must be 38 bytes total (frame_len 32 + 6 header/CRC)');
  assert.strictEqual(wf.readUInt16LE(4), 32, 'AC27: frame_len must be 32');
  assert.strictEqual(wf.readUInt16LE(18), 18, 'AC27: data_len must be 18 (16-byte inner + 2-byte CRC)');
  assert.strictEqual(wf[0], 0xA1, 'AC27: start marker A1');
  assert.strictEqual(wf[1], 0x1A, 'AC27: start marker 1A');
  assert.strictEqual(wf[7], 0xC2, 'AC27: tcp function 0xC2 (TranslatedData)');
  assert.strictEqual(wf.slice(8, 18).toString('ascii'), 'LXP0000001', 'AC27: dongle serial must occupy frame[8..18)');
  assert.strictEqual(wf[20], 0x00, 'AC27: inner action must be 0x00 (request) at frame[20]');
  assert.strictEqual(wf[21], DEV_FN_WRITE_SINGLE, 'AC27: inner dev_fn must be 0x06 at frame[21]');
  assert.strictEqual(wf.slice(22, 32).toString('ascii'), 'LXP0000002', 'AC27: inverter serial must occupy frame[22..32)');
  assert.strictEqual(wf.readUInt16LE(32), 0x69, 'AC27: start register must be u16 LE at frame[32..34)');
  assert.strictEqual(wf.readUInt16LE(34), 0x1234, 'AC27: value must be u16 LE at frame[34..36)');
  const stored = wf.readUInt16LE(36);
  const computed = crc16Modbus(wf.slice(20, wf.length - 2));
  assert.strictEqual(stored, computed, 'AC27: stored CRC must equal crc16Modbus(frame[20:-2])');
  console.log('PASS AC27: buildWriteFrame — 38B layout, dongle@[8..18) dev_fn=0x06@21 start@[32..34) value@[34..36), CRC over inner valid');
}
{
  const base = { protocol: 5, dongle: 'LXP0000001', inverter: 'LXP0000002', start: 0x69, value: 1 };
  assert.throws(() => buildWriteFrame({ ...base, dongle: 'LXP1' }), /dongle must be exactly 10 alphanumeric/, 'AC27: short dongle serial must throw');
  assert.throws(() => buildWriteFrame({ ...base, dongle: 'LXP000000!' }), /dongle must be exactly 10 alphanumeric/, 'AC27: non-alnum dongle serial must throw');
  assert.throws(() => buildWriteFrame({ ...base, inverter: 'INV0000' }), /inverter must be exactly 10 alphanumeric/, 'AC27: short inverter serial must throw');
  assert.throws(() => buildWriteFrame({ ...base, inverter: 'INV000000!' }), /inverter must be exactly 10 alphanumeric/, 'AC27: non-alnum inverter serial must throw');
  assert.throws(() => buildWriteFrame({ ...base, start: -1 }), /start must be within 0\.\.0xFFFF/, 'AC27: negative start must throw');
  assert.throws(() => buildWriteFrame({ ...base, start: 0x10000 }), /start must be within 0\.\.0xFFFF/, 'AC27: start > 0xFFFF must throw');
  assert.throws(() => buildWriteFrame({ ...base, start: 'abc' }), /start must be within/, 'AC27: non-numeric start must throw');
  assert.throws(() => buildWriteFrame({ ...base, value: -1 }), /value must be within 0\.\.0xFFFF/, 'AC27: negative value must throw');
  assert.throws(() => buildWriteFrame({ ...base, value: 0x10000 }), /value must be within 0\.\.0xFFFF/, 'AC27: value > 0xFFFF must throw');
  assert.throws(() => buildWriteFrame({ ...base, value: 'xyz' }), /value must be within/, 'AC27: non-numeric value must throw');
  // Boundary values are legal and build (start/value u16 LE fields round-trip)
  const edge = buildWriteFrame({ ...base, start: 0xFFFF, value: 0xFFFF });
  assert.strictEqual(edge.readUInt16LE(32), 0xFFFF, 'AC27: start 0xFFFF must round-trip');
  assert.strictEqual(edge.readUInt16LE(34), 0xFFFF, 'AC27: value 0xFFFF must round-trip');
  console.log('PASS AC27: buildWriteFrame validation — bad serials / start>0xFFFF / value out of range all throw; 0xFFFF boundaries round-trip');
}

// ---------------------------------------------------------------------------
// R4 (issue #106 QA-AC4): 76522s runtime golden fixture — the count:2
// lsb_first uint32 decode of registers 0x45/0x46 (low word 10986 = 0x2AEA +
// high word 1<<16 = 76522 s) must produce 76522 via the shared profile decode.
// Exercised end-to-end: synthetic response frame → parseFrame →
// luxpowerWordsFromBuffer → decodeLuxpowerMetrics (the exact pipeline the poll
// cycle and unsolicited-push handler share). Synthetic LXP serials only.
// ---------------------------------------------------------------------------
{
  const { luxpowerWordsFromBuffer, decodeLuxpowerMetrics } = require('../modules/dongle');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json'), 'utf8'));
  const runtime = profile.metrics.find(m => m.name === 'runtime_seconds');
  assert.ok(runtime, 'R4: profile must model runtime_seconds');
  assert.strictEqual(runtime.register, '0x0045', 'R4: runtime_seconds must live at register 0x0045');
  assert.strictEqual(runtime.register_type, 'input', 'R4: runtime_seconds must be input-space');
  assert.strictEqual(runtime.count, 2, 'R4: runtime_seconds must be count:2');
  assert.strictEqual(runtime.type, 'uint32', 'R4: runtime_seconds must be type uint32');
  assert.strictEqual(runtime.word_order, 'lsb_first', 'R4: runtime_seconds must be word_order lsb_first');
  assert.strictEqual(runtime.scale, 1, 'R4: runtime_seconds must be scale 1');
  assert.strictEqual(runtime.unit, 's', 'R4: runtime_seconds must be unit s');

  // Synthetic response frame: devFn 0x04 (input), start register 0x45, payload
  // = the two wire words (LE per word): [EA 2A] = 10986, [01 00] = 1.
  const R4_HEX = 'a11a0500230001c24c585030303030303031150001044c585030303030303032450004ea2a01002e0f';
  const R4_FRAME = Buffer.from(R4_HEX, 'hex');
  // CRC sanity over the fixture itself
  assert.strictEqual(R4_FRAME.readUInt16LE(R4_FRAME.length - 2), crc16Modbus(R4_FRAME.slice(20, R4_FRAME.length - 2)), 'R4: fixture CRC must be valid');
  const p = parseFrame(R4_FRAME);
  assert.strictEqual(p.devFn, 0x04, 'R4: frame must parse as devFn 0x04');
  assert.strictEqual(p.start, 0x45, 'R4: frame start must be register 0x45');
  assert.strictEqual(p.byteLen, 4, 'R4: frame byte_len must be 4 (two registers)');

  const words = luxpowerWordsFromBuffer(profile, p.values, p.start, 'input');
  const instance = { name: 'lxp-runtime-fixture', mappings: { runtime_seconds: 'input:0x0045' } };
  const { metrics, units } = decodeLuxpowerMetrics(profile, instance, words);
  assert.strictEqual(metrics.runtime_seconds, 76522, 'R4: count:2 lsb_first decode of 0x45/0x46 (10986 + 1<<16) must produce 76522');
  assert.strictEqual(units.runtime_seconds, 's', 'R4: decoded unit must be s');
  assert.strictEqual(metrics.runtime_seconds + '', '76522', 'R4: raw seconds (scale 1), no fractional drift');
  console.log('PASS R4 (QA-AC4): 76522s runtime golden — parseFrame(0x04@0x45) → words → profile decode = 76522 s (fixture ' + R4_HEX + ')');
}

// ---------------------------------------------------------------------------
// AC9 (issue #109): decode spot-check — synthetic holding frame (devFn 0x03,
// start 0x90, 7 words = regs 0x90..0x96) carrying sweep values 0x90=274,
// 0x94=240, 0x96=30 → float_charge_voltage 27.4 V, battery_nominal_voltage
// 24.0 V, equalization_interval 30 d through the shared decode pipeline.
// 0.1-scaled floats compared within 1e-9 (no exact-equality on decimals).
// ---------------------------------------------------------------------------
{
  const { luxpowerWordsFromBuffer, decodeLuxpowerMetrics } = require('../modules/dongle');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json'), 'utf8'));
  const AC9_HEX = 'a11a05002d0001c24c5850303030303030311f0001034c58503030303030303290000e1201000000000000f00000001e0095c0';
  const AC9_FRAME = Buffer.from(AC9_HEX, 'hex');
  assert.strictEqual(AC9_FRAME.readUInt16LE(AC9_FRAME.length - 2), crc16Modbus(AC9_FRAME.slice(20, AC9_FRAME.length - 2)), 'AC9: fixture CRC must be valid');
  const p = parseFrame(AC9_FRAME);
  assert.strictEqual(p.devFn, 0x03, 'AC9: frame must parse as devFn 0x03 (holding)');
  assert.strictEqual(p.start, 0x90, 'AC9: frame start must be register 0x90');
  assert.strictEqual(p.byteLen, 14, 'AC9: frame byte_len must be 14 (seven registers 0x90..0x96)');
  assert.strictEqual(p.values.readUInt16LE(0), 274, 'AC9: reg 0x90 raw must be 274');
  assert.strictEqual(p.values.readUInt16LE(4 * 2), 240, 'AC9: reg 0x94 raw must be 240');
  assert.strictEqual(p.values.readUInt16LE(6 * 2), 30, 'AC9: reg 0x96 raw must be 30');

  const words = luxpowerWordsFromBuffer(profile, p.values, p.start, 'holding');
  const instance = { name: 'lxp-ac9-fixture', mappings: { float_charge_voltage: 'holding:0x0090', battery_nominal_voltage: 'holding:0x0094', equalization_interval: 'holding:0x0096' } };
  const { metrics, units } = decodeLuxpowerMetrics(profile, instance, words);
  assert.ok(Math.abs(metrics.float_charge_voltage - 27.4) < 1e-9, 'AC9: float_charge_voltage must decode 27.4 (274 @0.1)');
  assert.strictEqual(units.float_charge_voltage, 'V', 'AC9: float_charge_voltage unit must be V');
  assert.ok(Math.abs(metrics.battery_nominal_voltage - 24.0) < 1e-9, 'AC9: battery_nominal_voltage must decode 24.0 (240 @0.1)');
  assert.strictEqual(units.battery_nominal_voltage, 'V', 'AC9: battery_nominal_voltage unit must be V');
  assert.strictEqual(metrics.equalization_interval, 30, 'AC9: equalization_interval must decode 30 (scale 1)');
  assert.strictEqual(units.equalization_interval, 'd', 'AC9: equalization_interval unit must be d');
  console.log('PASS AC9: sweep decode spot-check — 0x90=274→27.4V, 0x94=240→24.0V, 0x96=30→30d (fixture ' + AC9_HEX + ')');
}

// ---------------------------------------------------------------------------
// AC10 (issue #109): decode spot-check 2 — REAL_HOLDING_80_119 fixture holds
// reg 0x6D raw 400 (the lead-acid charge temp upper limit lives inside that
// REAL capture) → lead_acid_temp_upper_limit_chg 40.0 °C; plus synthetic
// smart_load_on_voltage 0xD5=270 → 27.0 V and delta_voltage 0xFE=16 → 1.6 V.
// AC9 + AC10 together cover 6 new registers against real sweep values.
// ---------------------------------------------------------------------------
{
  const { luxpowerWordsFromBuffer, decodeLuxpowerMetrics } = require('../modules/dongle');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json'), 'utf8'));

  // (a) REAL capture: holding 80-119 covers 0x50..0x77; 0x6D sits at word 29.
  const stored = REAL_HOLDING_80_119.readUInt16LE(REAL_HOLDING_80_119.length - 2);
  assert.strictEqual(stored, crc16Modbus(REAL_HOLDING_80_119.slice(20, REAL_HOLDING_80_119.length - 2)), 'AC10: REAL_HOLDING_80_119 CRC must be valid');
  const pr = parseFrame(REAL_HOLDING_80_119);
  assert.strictEqual(pr.start, 0x50, 'AC10: REAL holding frame must start at 0x50');
  assert.strictEqual(pr.values.readUInt16LE(29 * 2), 400, 'AC10: REAL reg 0x6D raw must be 400 (sweep-confirmed)');
  const wordsReal = luxpowerWordsFromBuffer(profile, pr.values, pr.start, 'holding');
  const instReal = { name: 'lxp-ac10-real', mappings: { lead_acid_temp_upper_limit_chg: 'holding:0x006D' } };
  const decReal = decodeLuxpowerMetrics(profile, instReal, wordsReal);
  assert.ok(Math.abs(decReal.metrics.lead_acid_temp_upper_limit_chg - 40.0) < 1e-9, 'AC10: lead_acid_temp_upper_limit_chg must decode 40.0 (400 @0.1)');
  assert.strictEqual(decReal.units.lead_acid_temp_upper_limit_chg, '°C', 'AC10: lead_acid_temp_upper_limit_chg unit must be °C');

  // (b) synthetic: holding reg 0xD5 = 270 → 27.0 V
  const AC10_D5_HEX = 'a11a0500210001c24c585030303030303031130001034c585030303030303032d500020e0101e5';
  const AC10_D5 = Buffer.from(AC10_D5_HEX, 'hex');
  assert.strictEqual(AC10_D5.readUInt16LE(AC10_D5.length - 2), crc16Modbus(AC10_D5.slice(20, AC10_D5.length - 2)), 'AC10: D5 fixture CRC must be valid');
  const pd = parseFrame(AC10_D5);
  const wordsD5 = luxpowerWordsFromBuffer(profile, pd.values, pd.start, 'holding');
  const decD5 = decodeLuxpowerMetrics(profile, { name: 'lxp-ac10-d5', mappings: { smart_load_on_voltage: 'holding:0x00D5' } }, wordsD5);
  assert.ok(Math.abs(decD5.metrics.smart_load_on_voltage - 27.0) < 1e-9, 'AC10: smart_load_on_voltage must decode 27.0 (270 @0.1)');
  assert.strictEqual(decD5.units.smart_load_on_voltage, 'V', 'AC10: smart_load_on_voltage unit must be V');

  // (c) synthetic: holding reg 0xFE = 16 → 1.6 V
  const AC10_FE_HEX = 'a11a0500210001c24c585030303030303031130001034c585030303030303032fe00021000ed83';
  const AC10_FE = Buffer.from(AC10_FE_HEX, 'hex');
  assert.strictEqual(AC10_FE.readUInt16LE(AC10_FE.length - 2), crc16Modbus(AC10_FE.slice(20, AC10_FE.length - 2)), 'AC10: FE fixture CRC must be valid');
  const pfe = parseFrame(AC10_FE);
  const wordsFE = luxpowerWordsFromBuffer(profile, pfe.values, pfe.start, 'holding');
  const decFE = decodeLuxpowerMetrics(profile, { name: 'lxp-ac10-fe', mappings: { delta_voltage: 'holding:0x00FE' } }, wordsFE);
  assert.ok(Math.abs(decFE.metrics.delta_voltage - 1.6) < 1e-9, 'AC10: delta_voltage must decode 1.6 (16 @0.1)');
  assert.strictEqual(decFE.units.delta_voltage, 'V', 'AC10: delta_voltage unit must be V');
  console.log('PASS AC10: REAL 0x6D=400→40.0°C + synthetic 0xD5=270→27.0V smart_load_on_voltage, 0xFE=16→1.6V delta_voltage');
}

// ---------------------------------------------------------------------------
// AC11 (issue #109): new-window chunk parse — synthetic devFn 0x03 response
// at the previously-gapped 0xA0..0xC7 boundary (start 0xA0, 40 regs, byte_len
// 0x50) parses cleanly; all 7 Tier-B metrics appear in the words and decode to
// 0 through the shared pipeline (values 0 allowed — window never captured).
// ---------------------------------------------------------------------------
{
  const { luxpowerWordsFromBuffer, decodeLuxpowerMetrics } = require('../modules/dongle');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json'), 'utf8'));
  const AC11_HEX = 'a11a05006f0001c24c585030303030303031610001034c585030303030303032a000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000783c';
  const AC11_FRAME = Buffer.from(AC11_HEX, 'hex');
  assert.strictEqual(AC11_FRAME.readUInt16LE(AC11_FRAME.length - 2), crc16Modbus(AC11_FRAME.slice(20, AC11_FRAME.length - 2)), 'AC11: fixture CRC must be valid');
  const p = parseFrame(AC11_FRAME);
  assert.strictEqual(p.devFn, 0x03, 'AC11: frame must parse as devFn 0x03 (holding)');
  assert.strictEqual(p.start, 0xA0, 'AC11: frame start must be register 0xA0');
  assert.strictEqual(p.byteLen, 0x50, 'AC11: frame byte_len must be 0x50 (40 registers)');
  assert.strictEqual(p.values.length, 80, 'AC11: values must span 80 bytes');

  const words = luxpowerWordsFromBuffer(profile, p.values, p.start, 'holding');
  const tierB = [['ac_charge_start_soc', 0xA0], ['ac_charge_end_soc', 0xA1], ['gen_charge_start_voltage', 0xC2],
    ['gen_charge_end_voltage', 0xC3], ['gen_charge_start_soc', 0xC4], ['gen_charge_end_soc', 0xC5], ['max_gen_charge_current', 0xC6]];
  const mappings = {};
  for (const [name, reg] of tierB) {
    assert.strictEqual(words['holding:' + reg], 0, `AC11: word holding:${reg} (${name}) must be present (0 in zero-filled window)`);
    mappings[name] = 'holding:0x' + reg.toString(16).toUpperCase().padStart(4, '0');
  }
  const instance = { name: 'lxp-ac11-fixture', mappings };
  const { metrics, units } = decodeLuxpowerMetrics(profile, instance, words);
  for (const [name] of tierB) {
    assert.strictEqual(metrics[name], 0, `AC11: ${name} must decode 0 from the zero-filled window`);
  }
  assert.strictEqual(units.ac_charge_start_soc, '%', 'AC11: ac_charge_start_soc unit must be %');
  assert.strictEqual(units.max_gen_charge_current, 'A', 'AC11: max_gen_charge_current unit must be A');
  console.log('PASS AC11: window chunk 0xA0-0xC7 parses — 7 Tier-B metrics in words, decode to 0, no boundary error');
}

// ---------------------------------------------------------------------------
// AC12 (issue #109): unmapped input raws — synthetic input frame (devFn 0x04,
// start 0xD3, 28 words = regs 0xD3..0xEE) carrying 0xD3=1500 and 0xEE=32775
// → unmapped_input_d3 1500, unmapped_input_ee 32775 (scale 1, unit "").
// ---------------------------------------------------------------------------
{
  const { luxpowerWordsFromBuffer, decodeLuxpowerMetrics } = require('../modules/dongle');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json'), 'utf8'));
  const AC12_HEX = 'a11a0500570001c24c585030303030303031490001044c585030303030303032d30038dc05000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000780c36c';
  const AC12_FRAME = Buffer.from(AC12_HEX, 'hex');
  assert.strictEqual(AC12_FRAME.readUInt16LE(AC12_FRAME.length - 2), crc16Modbus(AC12_FRAME.slice(20, AC12_FRAME.length - 2)), 'AC12: fixture CRC must be valid');
  const p = parseFrame(AC12_FRAME);
  assert.strictEqual(p.devFn, 0x04, 'AC12: frame must parse as devFn 0x04 (input)');
  assert.strictEqual(p.start, 0xD3, 'AC12: frame start must be register 0xD3');
  assert.strictEqual(p.byteLen, 0x38, 'AC12: frame byte_len must be 0x38 (28 registers 0xD3..0xEE)');
  assert.strictEqual(p.values.readUInt16LE(0), 1500, 'AC12: reg 0xD3 raw must be 1500 (0x05DC)');
  assert.strictEqual(p.values.readUInt16LE(27 * 2), 32775, 'AC12: reg 0xEE raw must be 32775 (0x8007)');

  const words = luxpowerWordsFromBuffer(profile, p.values, p.start, 'input');
  const instance = { name: 'lxp-ac12-fixture', mappings: { unmapped_input_d3: 'input:0x00D3', unmapped_input_ee: 'input:0x00EE' } };
  const { metrics, units } = decodeLuxpowerMetrics(profile, instance, words);
  assert.strictEqual(metrics.unmapped_input_d3, 1500, 'AC12: unmapped_input_d3 must decode 1500 (scale 1)');
  assert.strictEqual(metrics.unmapped_input_ee, 32775, 'AC12: unmapped_input_ee must decode 32775 (scale 1)');
  assert.strictEqual(units.unmapped_input_d3, undefined, 'AC12: unmapped_input_d3 must carry no unit (unit "")');
  assert.strictEqual(units.unmapped_input_ee, undefined, 'AC12: unmapped_input_ee must carry no unit (unit "")');
  console.log('PASS AC12: unmapped input raws — 0xD3=1500, 0xEE=32775 (scale 1, unit "")');
}

console.log('PASS: dongle-luxpower-frame.test.js — AC1, AC2, AC3, AC4, AC6, AC15 (167/58/20), R4 (76522s golden), AC9-AC12 (issue #109 decode spot-checks), AC27 (buildWriteFrame) all green');
process.exitCode = 0;
