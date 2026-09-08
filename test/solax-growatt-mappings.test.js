#!/usr/bin/env node
/**
 * test/solax-growatt-mappings.test.js
 * Poll-side explicit-mapping support (issue #108, AC-14/15).
 *
 * AC-15 (SolaX): solax-decoder.decodeResponse(buffer, cmd, profile, mappings?)
 *   — optional mappings keyed `${cmd.name}:${field.offset}`; with mappings
 *   present only mapped fields are emitted (skipping unmapped), with no
 *   mappings the output is byte-identical to the legacy field.metric decode.
 *
 * AC-14 (Growatt): the Growatt frame path honors instance.mappings
 *   ({metricName → m.field}) via a field→metric reverse lookup; unmapped
 *   fields are skipped when mappings are present; no mappings key ⇒ the
 *   implicit prefix + m.name behavior, exercised end-to-end through
 *   GrowattServer._processFrame with a real v1.24 frame.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');

const { decodeResponse } = require('../modules/rs232-decoders/solax-decoder');
const { additiveChecksum16LE } = require('../modules/rs232-decoders/rs232-utils');
const { GrowattServer } = require('../modules/dongle/growatt');

const solaxProfile = require('../profiles/rs232/solax-pocket-usb.json');
const dataCmd = solaxProfile.commands.find(c => c.name === 'request_data');

// ---------------------------------------------------------------------------
// SolaX fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic AA55 request_data (func 0x0C) response carrying payload.
 * Header AA 55 [size] [ctrl] [func]; decoder does not parse the size byte, but
 * we fill it consistently anyway. Checksum = additive-16-LE over body[2..].
 */
function buildDataFrame(payload) {
  const header = Buffer.from([0xAA, 0x55, 2 + payload.length, dataCmd.control, dataCmd.function]);
  const body = Buffer.concat([header, payload]);
  const chk = additiveChecksum16LE(body.slice(2));
  return Buffer.concat([body, Buffer.from([chk & 0xFF, (chk >> 8) & 0xFF])]);
}

/** 42-byte payload covering every field offset (feedin_energy_total ends at 42). */
function buildPayload() {
  const p = Buffer.alloc(42);
  p.writeUInt16LE(2300, 0);   // grid_voltage      *0.1  -> 230
  p.writeUInt16LE(1500, 2);   // grid_current      *0.1  -> 150
  p.writeInt16LE(-1200, 4);   // grid_power               -> -1200
  p.writeUInt16LE(3000, 6);   // pv1_power                -> 3000
  p.writeUInt16LE(1500, 8);   // pv2_power                -> 1500
  p.writeUInt16LE(5120, 10);  // battery_voltage   *0.1  -> 512
  p.writeInt16LE(-800, 12);   // battery_power            -> -800
  p.writeUInt16LE(55, 14);    // battery_soc              -> 55
  p.writeUInt16LE(1230, 16);  // energy_today      *0.1  -> 123
  p.writeUInt32LE(12345678, 18); // energy_total    *0.1  -> 1234567.8
  p.writeInt16LE(45, 22);     // inverter_temp           -> 45
  p.writeUInt16LE(5000, 24);  // grid_frequency    *0.01 -> 50
  p.writeUInt16LE(3650, 26);  // pv1_voltage       *0.1  -> 365
  p.writeUInt16LE(830, 28);   // pv1_current       *0.1  -> 83
  p.writeUInt16LE(3600, 30);  // pv2_voltage       *0.1  -> 360
  p.writeUInt16LE(0, 32);     // pv2_current       *0.1  -> 0
  p.writeInt16LE(-150, 34);   // battery_current   *0.1  -> -15
  p.writeUInt16LE(880, 36);   // feedin_energy_today *0.1 -> 88
  p.writeUInt32LE(99999, 38); // feedin_energy_total *0.1 -> 9999.9
  return p;
}

const FRAME = buildDataFrame(buildPayload());

// Expected implicit decode: every field under its profile-default metric name
const EXPECTED_DEFAULT = {
  grid_voltage: 230,
  grid_current: 150,
  grid_power: -1200,
  pv1_power: 3000,
  pv2_power: 1500,
  battery_voltage: 512,
  battery_power: -800,
  battery_soc: 55,
  energy_today: 123,
  energy_total: 1234567.8,
  inverter_temp: 45,
  grid_frequency: 50,
  pv1_voltage: 365,
  pv1_current: 83,
  pv2_voltage: 360,
  pv2_current: 0,
  battery_current: -15,
  feedin_energy_today: 88,
  feedin_energy_total: 9999.9
};

// ---------------------------------------------------------------------------
// AC-15 assertions
// ---------------------------------------------------------------------------

{
  // No mappings → byte-identical legacy decode
  const out = decodeResponse(FRAME, dataCmd, solaxProfile);
  assert.deepStrictEqual(out, EXPECTED_DEFAULT, 'no-mappings decode differs from legacy output');
  console.log('PASS AC-15: no mappings -> legacy field.metric decode byte-identical');
}

{
  // Subset mappings → only mapped fields, renamed to the mapped metric
  const mappings = {
    my_grid_voltage: 'request_data:0',
    my_pv1_power: 'request_data:6',
    // bogus handle for a field that does not exist — must be inert
    ghost: 'request_data:200'
  };
  const out = decodeResponse(FRAME, dataCmd, solaxProfile, mappings);
  assert.deepStrictEqual(out, { my_grid_voltage: 230, my_pv1_power: 3000 },
    'mapped decode emitted wrong fields/names');
  console.log('PASS AC-15: subset mappings -> mapped fields only, unmapped skipped');
}

{
  // Empty mappings object → explicit none, nothing emitted
  const out = decodeResponse(FRAME, dataCmd, solaxProfile, {});
  assert.deepStrictEqual(out, {}, 'empty mappings should emit nothing');
  console.log('PASS AC-15: empty mappings -> no output');
}

{
  // Non-data commands still acknowledge to {} regardless of mappings
  const regCmd = solaxProfile.commands.find(c => c.name === 'register_dongle');
  const out = decodeResponse(FRAME, regCmd, solaxProfile, { anything: 'request_data:0' });
  assert.deepStrictEqual(out, {}, 'non-data command must return {}');
  console.log('PASS AC-15: func <= 5 command returns {} even with mappings');
}

// ---------------------------------------------------------------------------
// Growatt fixture helpers (AC-14)
// ---------------------------------------------------------------------------

/**
 * Build a v1.24 (proto 0x0103) data frame: 8-byte header
 * [..][protoId u16BE][dataLen u16BE][unitId][func 0x04] + payload + checksum.
 */
function buildGrowattFrame(payload) {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0103, 2);
  header.writeUInt16BE(payload.length, 4);
  header[6] = 0x01;   // modbus unit id
  header[7] = 0x04;   // func code: read data push
  const body = Buffer.concat([header, payload]);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xFFFF;
  return Buffer.concat([body, Buffer.from([(sum >> 8) & 0xFF, sum & 0xFF])]);
}

/** v1.24 payload with the serials + registers the growatt-spf profile reads. */
function buildGrowattPayload() {
  const p = Buffer.alloc(52);
  p.write('DL00000001', 0, 10, 'ascii');
  p.write('INV0000001', 10, 10, 'ascii');
  p.writeUInt16BE(3600, 20);   // pv1_voltage *0.1  -> 360   (solar_voltage)
  p.writeUInt16BE(500, 22);    // pv1_current *0.1  -> 50
  p.writeUInt16BE(30000, 24);  // pv1_power   *0.1  -> 3000  (solar_power)
  p.writeUInt16BE(0, 26);      // pv2_voltage
  p.writeUInt16BE(0, 28);      // pv2_current
  p.writeUInt16BE(0, 30);      // pv2_power
  p.writeUInt16BE(2300, 32);   // ac_voltage_r *0.1 -> 230
  p.writeUInt16BE(0, 34);      // ac_current_r
  p.writeUInt16BE(25000, 36);  // ac_power *0.1 -> 2500    (load_power)
  p.writeUInt16BE(5000, 38);   // ac_frequency *0.01 -> 50
  p.writeUInt16BE(4321, 40);   // grid_power *0.1 -> 432.1 (grid_power)
  p.writeUInt16BE(5120, 42);   // battery_voltage *0.1 -> 512 (battery_voltage)
  p.writeUInt16BE(450, 44);    // inverter_temp *0.1 -> 45 (inverter_temperature)
  p.writeUInt16BE(1000, 46);   // daily_solar_kwh *0.1 -> 100 (daily_solar)
  p.writeUInt16BE(0, 48);      // total_solar_kwh hi
  p.writeUInt16BE(25000, 50);  // total_solar_kwh lo -> 2500.0 (total_solar)
  return p;
}

const GROWATT_FRAME = buildGrowattFrame(buildGrowattPayload());

/** Expected implicit decode for the frame above (no mappings, prefix spf_). */
const GROWATT_EXPECTED_IMPLICIT = {
  spf_solar_power: 3000,
  spf_solar_voltage: 360,
  spf_grid_power: 432.1,
  spf_load_power: 2500,
  spf_battery_voltage: 51.2,        // 512 * 0.1
  spf_inverter_temperature: 4.5,    // 45 * 0.1
  spf_daily_solar: 10,              // 100 * 0.1
  spf_total_solar: 250              // 2500 * 0.1
};

// ---------------------------------------------------------------------------
// AC-14 assertions
// ---------------------------------------------------------------------------

{
  // Implicit: no mappings key on the instance → prefix + m.name unchanged
  let written = null;
  const server = new GrowattServer(
    [{ transport: 'growatt', enabled: true, name: 'g1', profile: 'growatt-spf', modbus_unit_id: 1, prefix: 'spf_' }],
    m => { written = m; }
  );
  server._processFrame(GROWATT_FRAME);
  assert.ok(written, 'implicit decode wrote nothing');
  assert.deepStrictEqual(written, GROWATT_EXPECTED_IMPLICIT,
    `implicit growatt decode wrong: ${JSON.stringify(written)}`);
  console.log('PASS AC-14: no mappings key -> prefix + m.name unchanged');
}

{
  // Explicit subset: only the two mapped fields, under the mapped metric names
  // (prefix must NOT apply to mapped names)
  let written = null;
  const server = new GrowattServer(
    [{
      transport: 'growatt', enabled: true, name: 'g2', profile: 'growatt-spf',
      modbus_unit_id: 1, prefix: 'spf_',
      mappings: { my_solar: 'pv1_power', my_grid: 'grid_power' }
    }],
    m => { written = m; }
  );
  server._processFrame(GROWATT_FRAME);
  assert.deepStrictEqual(written, { my_solar: 3000, my_grid: 432.1 },
    `explicit growatt decode wrong: ${JSON.stringify(written)}`);
  console.log('PASS AC-14: subset mappings -> mapped fields only, prefix not applied');
}

{
  // Explicit none: mappings present but empty → nothing emitted
  let written = null;
  const server = new GrowattServer(
    [{
      transport: 'growatt', enabled: true, name: 'g3', profile: 'growatt-spf',
      modbus_unit_id: 1, mappings: {}
    }],
    m => { written = m; }
  );
  server._processFrame(GROWATT_FRAME);
  assert.deepStrictEqual(written, {}, 'empty growatt mappings should emit nothing');
  console.log('PASS AC-14: empty mappings -> no output');
}

console.log('ALL PASS: solax-growatt-mappings');
process.exit(0);
