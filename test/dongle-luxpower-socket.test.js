#!/usr/bin/env node
/**
 * test/dongle-luxpower-socket.test.js
 * Loopback socket tests for the LuxPower local-TCP transport (issue #102),
 * covering AC5 (fragmentation/resync over the wire), AC6 (bad-CRC discard +
 * resync), AC8-AC12. A fake dongle (net.createServer) on 127.0.0.1 asserts the
 * AC2 golden request bytes and serves real-shaped response frames.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const net = require('net');

const {
  LuxpowerTcpTransport,
  crc16Modbus,
  DEV_FN_HOLDING,
  DEV_FN_INPUT,
  DEV_FN_WRITE_SINGLE
} = require('../modules/dongle/luxpowerTcp');

const DONGLE = 'LXP0000001';
const INVERTER = 'LXP0000002';
const AC2_HEX = 'a11a0500200001c24c585030303030303031120000044c58503030303030303200002800527a';
const AC2 = Buffer.from(AC2_HEX, 'hex');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a full response/push frame (action 0x01) with explicit fields. */
function buildFrame({ devFn, start, values, inverter = INVERTER, dongle = DONGLE }) {
  const inner = Buffer.alloc(15 + values.length);
  inner[0] = 0x01; // action = response/push
  inner[1] = devFn;
  inner.write(inverter, 2, 10, 'ascii');
  inner.writeUInt16LE(start, 12);
  inner[14] = values.length;
  values.copy(inner, 15);
  const dataLen = inner.length + 2;
  const frameLen = dataLen + 14;
  const frame = Buffer.alloc(frameLen + 6);
  frame[0] = 0xA1;
  frame[1] = 0x1A;
  frame.writeUInt16LE(5, 2);          // protocol v5
  frame.writeUInt16LE(frameLen, 4);
  frame[6] = 0x01;
  frame[7] = 0xC2;                    // TCP TranslatedData
  frame.write(dongle, 8, 10, 'ascii');
  frame.writeUInt16LE(dataLen, 18);
  inner.copy(frame, 20);
  frame.writeUInt16LE(crc16Modbus(inner), frameLen + 4);
  return frame;
}

/** Deterministic value payload for a parsed request: words = start..start+count-1. */
function makeValues(req) {
  const v = Buffer.alloc(req.count * 2);
  for (let i = 0; i < req.count; i++) v.writeUInt16BE((req.start + i) & 0xFFFF, i * 2);
  return v;
}

/** A 16-bit word as little-endian wire bytes ([lo, hi]) — real-dongle word order. */
function leWord(v) {
  return Buffer.from([v & 0xFF, (v >> 8) & 0xFF]);
}

/**
 * Build a bare write-single (0x06) ECHO response — the 16-byte request inner
 * with action flipped to 0x01 (no byte_len field): action | dev_fn | inverter
 * (10) | start(u16 LE) | value(u16 LE). parseFrame accepts this shape.
 */
function buildWriteEcho16({ start, value, inverter = INVERTER, dongle = DONGLE }) {
  const inner = Buffer.alloc(16);
  inner[0] = 0x01; // action = response
  inner[1] = DEV_FN_WRITE_SINGLE;
  inner.write(inverter, 2, 10, 'ascii');
  inner.writeUInt16LE(start, 12);
  inner.writeUInt16LE(value, 14);
  const dataLen = inner.length + 2;
  const frameLen = dataLen + 14;
  const frame = Buffer.alloc(frameLen + 6);
  frame[0] = 0xA1;
  frame[1] = 0x1A;
  frame.writeUInt16LE(5, 2);
  frame.writeUInt16LE(frameLen, 4);
  frame[6] = 0x01;
  frame[7] = 0xC2;
  frame.write(dongle, 8, 10, 'ascii');
  frame.writeUInt16LE(dataLen, 18);
  inner.copy(frame, 20);
  frame.writeUInt16LE(crc16Modbus(inner), frameLen + 4);
  return frame;
}

/** Parse a 38-byte LuxPower request frame (request inner = 16 bytes). */
function parseRequest(buf) {
  return {
    devFn: buf[21],
    inverter: buf.slice(22, 32).toString('ascii'),
    dongle: buf.slice(8, 18).toString('ascii'),
    start: buf.readUInt16LE(32),
    count: buf.readUInt16LE(34)
  };
}

/** Fake-dongle connection handler that answers every request it parses. */
function answerRequests(sock) {
  sock._rx = Buffer.alloc(0);
  sock.on('data', chunk => {
    sock._rx = Buffer.concat([sock._rx, chunk]);
    while (sock._rx.length >= 38) {
      const reqBuf = sock._rx.slice(0, 38);
      sock._rx = sock._rx.slice(38);
      const req = parseRequest(reqBuf);
      sock.write(buildFrame({ devFn: req.devFn, start: req.start, values: makeValues(req) }));
    }
  });
}

function makeTransport(port, extra) {
  return new LuxpowerTcpTransport(Object.assign({
    host: '127.0.0.1',
    port,
    dongle_serial: DONGLE,
    inverter_serial: INVERTER
  }, extra));
}

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', res));
}

function closeServer(server, sockets) {
  for (const s of sockets) if (!s.destroyed) s.destroy();
  return new Promise(res => server.close(res));
}

async function withFakeDongle(handler, body) {
  const sockets = new Set();
  const server = net.createServer(sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    handler(sock);
  });
  await listen(server);
  const port = server.address().port;
  try {
    return await body(port);
  } finally {
    await closeServer(server, sockets);
  }
}

async function waitFor(cond, ms, label) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// AC8: loopback readRegisters resolves; server-side bytes == AC2 golden hex
// ---------------------------------------------------------------------------
async function testAC8() {
  let recorded = null;
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      if (!recorded) recorded = Buffer.from(reqBuf);
      const req = parseRequest(reqBuf);
      sock.write(buildFrame({ devFn: req.devFn, start: req.start, values: makeValues(req) }));
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      const resolved = await t.readRegisters(0, 40, DEV_FN_INPUT);
      assert.ok(recorded, 'AC8: fake dongle must have received a request');
      assert.ok(recorded.equals(AC2), 'AC8: request bytes must equal AC2 golden hex');
      assert.strictEqual(resolved.length, 80, 'AC8: 40 registers x 2 bytes');
      assert.ok(resolved.equals(makeValues(parseRequest(recorded))), 'AC8: resolved values must equal what the fake dongle sent');
    } finally {
      t.stop();
    }
  });
  console.log('PASS AC8: loopback readRegisters(0,40,0x04) resolves; wire bytes == AC2 hex');
}

// ---------------------------------------------------------------------------
// AC5 over a real socket: junk-prefix resync, byte-at-a-time, random chunks
// ---------------------------------------------------------------------------
function recordAndCapture(sock, onRequest) {
  sock._rx = Buffer.alloc(0);
  sock.on('data', chunk => {
    sock._rx = Buffer.concat([sock._rx, chunk]);
    while (sock._rx.length >= 38) {
      const reqBuf = sock._rx.slice(0, 38);
      sock._rx = sock._rx.slice(38);
      onRequest(reqBuf);
    }
  });
}

function chunkedWrite(sock, buf, chunkSizes) {
  let off = 0;
  const step = () => {
    if (off >= buf.length) return;
    const n = Math.min(chunkSizes[Math.floor(Math.random() * chunkSizes.length)], buf.length - off);
    sock.write(buf.slice(off, off + n));
    off += n;
    setImmediate(step);
  };
  step();
}

async function testAC5() {
  // (a) junk prefix before the response — transport must resync on A1 1A
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      const resp = buildFrame({ devFn: parseRequest(reqBuf).devFn, start: parseRequest(reqBuf).start, values: makeValues(parseRequest(reqBuf)) });
      sock.write(Buffer.concat([Buffer.from([0x00, 0xFF, 0x11, 0x22, 0x33, 0x44]), resp]));
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      const resolved = await t.readRegisters(0, 4, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 8, 'AC5a: junk-prefixed response must resolve');
    } finally { t.stop(); }
  });

  // (b) byte-at-a-time delivery
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      const resp = buildFrame({ devFn: parseRequest(reqBuf).devFn, start: parseRequest(reqBuf).start, values: makeValues(parseRequest(reqBuf)) });
      for (let i = 0; i < resp.length; i++) {
        (i => setImmediate(() => sock.write(resp.slice(i, i + 1))))(i);
      }
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      const resolved = await t.readRegisters(0, 4, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 8, 'AC5b: byte-at-a-time response must assemble and resolve');
    } finally { t.stop(); }
  });

  // (c) random-size chunks
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      const resp = buildFrame({ devFn: parseRequest(reqBuf).devFn, start: parseRequest(reqBuf).start, values: makeValues(parseRequest(reqBuf)) });
      chunkedWrite(sock, resp, [1, 2, 3, 5, 7, 11]);
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      const resolved = await t.readRegisters(0, 8, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 16, 'AC5c: randomly chunked response must resolve');
    } finally { t.stop(); }
  });

  console.log('PASS AC5: junk-prefix resync + byte-at-a-time + random-chunk framing all resolve');
}

// ---------------------------------------------------------------------------
// AC6 over a real socket: bad-CRC frame discarded, never resolves; good frame
// after it still resolves (resync)
// ---------------------------------------------------------------------------
async function testAC6() {
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      const req = parseRequest(reqBuf);
      const good = buildFrame({ devFn: req.devFn, start: req.start, values: makeValues(req) });
      const bad = Buffer.from(good);
      bad[Math.floor(bad.length / 2)] ^= 0xFF; // corrupt one payload byte -> CRC fails
      sock.write(Buffer.concat([bad, good]));  // corrupt frame first, then the good one
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      const resolved = await t.readRegisters(0, 4, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 8, 'AC6: bad-CRC frame must be discarded; good frame after it must resolve the pending read');
      // bad frame must NOT have resolved the read with garbage — content check
      assert.ok(resolved.equals(makeValues({ start: 0, count: 4 })), 'AC6: resolved values must come from the good (second) frame');
    } finally { t.stop(); }
  });
  console.log('PASS AC6: bad-CRC frame discarded (pending read untouched); good frame after resync resolves');
}

// ---------------------------------------------------------------------------
// AC9: timeout rejects cleanly (<2s with timeout_ms:500) and connection is
// reusable for the next read
// ---------------------------------------------------------------------------
async function testAC9() {
  let reqCount = 0;
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      reqCount++;
      if (reqCount > 1) { // first request is swallowed (never answered)
        const req = parseRequest(reqBuf);
        sock.write(buildFrame({ devFn: req.devFn, start: req.start, values: makeValues(req) }));
      }
    });
  }, async port => {
    const t = makeTransport(port, { timeout_ms: 500 });
    try {
      const t0 = Date.now();
      await assert.rejects(t.readRegisters(0, 4, DEV_FN_INPUT), /timeout/, 'AC9: unanswered read must reject with timeout');
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2000, `AC9: timeout must fire well under 2s (took ${elapsed}ms)`);

      // Connection must still be usable on the same socket
      const resolved = await t.readRegisters(0, 4, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 8, 'AC9: second read on the same connection must succeed');
    } finally { t.stop(); }
  });
  console.log('PASS AC9: timeout rejects cleanly (<2s); same connection reused for next read');
}

// ---------------------------------------------------------------------------
// AC10: unsolicited push (action 0x01, no pending request) -> onFrame fires,
// no crash, no false resolve
// ---------------------------------------------------------------------------
async function testAC10() {
  const frames = [];
  const pushed = buildFrame({ devFn: DEV_FN_HOLDING, start: 0, values: Buffer.alloc(10) });
  await withFakeDongle(sock => {
    sock.write(pushed); // push immediately on connect, before any request
    recordAndCapture(sock, reqBuf => {
      const req = parseRequest(reqBuf);
      sock.write(buildFrame({ devFn: req.devFn, start: req.start, values: makeValues(req) }));
    });
  }, async port => {
    const t = makeTransport(port, { onFrame: p => frames.push(p) });
    try {
      t.start();
      await waitFor(() => frames.length >= 1, 2000, 'unsolicited frame');
      assert.strictEqual(frames.length, 1, 'AC10: exactly one unsolicited frame');
      assert.strictEqual(frames[0].action, 1, 'AC10: action 0x01');
      assert.strictEqual(frames[0].devFn, DEV_FN_HOLDING, 'AC10: dev_fn 0x03 holding push');
      assert.strictEqual(frames[0].start, 0, 'AC10: start 0');
      assert.strictEqual(frames[0].byteLen, 10, 'AC10: byte_len 10');
      assert.strictEqual(frames[0].inverter, INVERTER, 'AC10: inverter serial extracted');

      // transport still healthy afterwards
      const resolved = await t.readRegisters(0, 4, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 8, 'AC10: read after unsolicited push must resolve');
      assert.strictEqual(frames.length, 1, 'AC10: response must not be re-emitted as unsolicited');
    } finally { t.stop(); }
  });
  console.log('PASS AC10: unsolicited holding push fires onFrame; no crash, no false resolve');
}

// ---------------------------------------------------------------------------
// AC11: content-match discrimination — an unsolicited 0x03 frame (and a 0x04
// frame at a different start) never satisfy a pending 0x04@0 read; requests
// are serialized (queued read waits)
// ---------------------------------------------------------------------------
async function testAC11() {
  const frames = [];
  // three frames concatenated in ONE write: wrong-devFn push, wrong-start push,
  // then the true response for the pending 0x04@0 read
  const wrongFn = buildFrame({ devFn: DEV_FN_HOLDING, start: 0, values: Buffer.from([0x90, 0x00, 0x90, 0x01, 0x90, 0x02, 0x90, 0x03]) });
  const wrongStart = buildFrame({ devFn: DEV_FN_INPUT, start: 16, values: Buffer.from([0x50, 0x00, 0x50, 0x01, 0x50, 0x02, 0x50, 0x03]) });
  const trueResp1 = buildFrame({ devFn: DEV_FN_INPUT, start: 0, values: Buffer.from([0x10, 0x00, 0x10, 0x01, 0x10, 0x02, 0x10, 0x03]) });

  await withFakeDongle(sock => {
    let reqNo = 0;
    recordAndCapture(sock, reqBuf => {
      reqNo++;
      const req = parseRequest(reqBuf);
      if (reqNo === 1) {
        assert.strictEqual(req.start, 0, 'AC11: first request must be start 0');
        sock.write(Buffer.concat([wrongFn, wrongStart, trueResp1])); // one TCP chunk
      } else {
        assert.strictEqual(req.start, 4, 'AC11: second (queued) request must be start 4');
        sock.write(buildFrame({ devFn: req.devFn, start: req.start, values: makeValues(req) }));
      }
    });
  }, async port => {
    const t = makeTransport(port, { onFrame: p => frames.push(p) });
    try {
      // Issue both reads up front — the second must queue until the first resolves
      const p1 = t.readRegisters(0, 4, DEV_FN_INPUT);
      const p2 = t.readRegisters(4, 2, DEV_FN_INPUT);
      const [r1, r2] = await Promise.all([p1, p2]);

      assert.ok(r1.equals(Buffer.from([0x10, 0x00, 0x10, 0x01, 0x10, 0x02, 0x10, 0x03])),
        'AC11: pending 0x04@0 read must resolve from the 0x04@0 frame ONLY');
      assert.strictEqual(r2.length, 4, 'AC11: queued read resolves after the first');
      assert.ok(r2.equals(makeValues({ start: 4, count: 2 })), 'AC11: second read gets its own values');

      assert.strictEqual(frames.length, 2, 'AC11: both mismatched frames must be emitted unsolicited');
      assert.strictEqual(frames[0].devFn, DEV_FN_HOLDING, 'AC11: first unsolicited is the 0x03 push');
      assert.strictEqual(frames[0].start, 0, 'AC11: 0x03 push start 0');
      assert.strictEqual(frames[1].devFn, DEV_FN_INPUT, 'AC11: second unsolicited is 0x04');
      assert.strictEqual(frames[1].start, 16, 'AC11: 0x04 push at start 16 (different from pending 0)');
    } finally { t.stop(); }
  });
  console.log('PASS AC11: content-match discrimination (0x03 + 0x04@16 never satisfy 0x04@0); requests serialized');
}

// ---------------------------------------------------------------------------
// AC12: mid-session drop -> pending read rejects, reconnect within backoff,
// next read succeeds; stop() leaves no handles (process exits naturally)
// ---------------------------------------------------------------------------
async function testAC12() {
  let connNo = 0;
  await withFakeDongle(sock => {
    connNo++;
    if (connNo === 1) {
      // first connection: destroy the socket as soon as a request arrives
      sock.on('data', () => sock.destroy());
    } else {
      answerRequests(sock);
    }
  }, async port => {
    const t = makeTransport(port);
    try {
      const t0 = Date.now();
      await assert.rejects(t.readRegisters(0, 2, DEV_FN_INPUT), /connection closed|connection error/, 'AC12: drop mid-session must reject the pending read');
      assert.ok(Date.now() - t0 < 1500, 'AC12: rejection must be prompt');

      const t1 = Date.now();
      const resolved = await t.readRegisters(0, 2, DEV_FN_INPUT);
      assert.strictEqual(resolved.length, 4, 'AC12: read after reconnect must succeed');
      assert.ok(Date.now() - t1 < 4000, `AC12: reconnect+read must complete within backoff budget (took ${Date.now() - t1}ms)`);
    } finally {
      t.stop(); // no timers/handles left behind
    }
  });
  console.log('PASS AC12: mid-session drop rejected; reconnect succeeds within backoff; stop() clean');
}

// ---------------------------------------------------------------------------
// AC31a: loopback writeRegister resolves on the matching 0x06 echo (bare
// 16-byte echo form); the request bytes carry dev_fn 0x06 + start + value.
// ---------------------------------------------------------------------------
async function testAC31a() {
  let seen = null;
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      seen = Buffer.from(reqBuf);
      const req = parseRequest(reqBuf);
      sock.write(buildWriteEcho16({ start: req.start, value: req.count })); // value rides the u16 LE field parseRequest calls 'count'
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      const echoed = await t.writeRegister(0x69, 0x0BB8);
      assert.ok(seen, 'AC31a: fake dongle must have received the write request');
      assert.strictEqual(seen.length, 38, 'AC31a: write request must be 38 bytes');
      assert.strictEqual(seen[21], DEV_FN_WRITE_SINGLE, 'AC31a: request dev_fn must be 0x06');
      assert.strictEqual(seen.readUInt16LE(32), 0x69, 'AC31a: request start register must be 0x69');
      assert.strictEqual(seen.readUInt16LE(34), 0x0BB8, 'AC31a: request value must be 0x0BB8');
      assert.ok(echoed.equals(leWord(0x0BB8)), 'AC31a: resolved echo must carry the written word bytes');
      assert.strictEqual(echoed.readUInt16LE(0), 0x0BB8, 'AC31a: resolved echo word must round-trip');
    } finally { t.stop(); }
  });
  console.log('PASS AC31a: writeRegister(0x69, 0x0BB8) resolves on matching 0x06 echo (16B bare form); wire request correct');
}

// ---------------------------------------------------------------------------
// AC31b: wrong-devFn and wrong-start frames never resolve a pending write —
// they are treated as unsolicited (onFrame) — only the matching echo resolves.
// ---------------------------------------------------------------------------
async function testAC31b() {
  const frames = [];
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      const req = parseRequest(reqBuf);
      assert.strictEqual(req.devFn, DEV_FN_WRITE_SINGLE, 'AC31b: fake must only see write requests here');
      // 1) read-shaped frame (devFn 0x03) at the SAME start — wrong function
      const wrongFn = buildFrame({ devFn: DEV_FN_HOLDING, start: req.start, values: Buffer.from([0xAA, 0xBB]) });
      // 2) 0x06 echo of a DIFFERENT register — wrong start
      const wrongStart = buildWriteEcho16({ start: (req.start + 1) & 0xFFFF, value: 0x1111 });
      // 3) the real echo in the framed 17-byte form (byte_len=2) — must resolve
      const ok = buildFrame({ devFn: DEV_FN_WRITE_SINGLE, start: req.start, values: leWord(req.count) });
      sock.write(Buffer.concat([wrongFn, wrongStart, ok]));
    });
  }, async port => {
    const t = makeTransport(port, { onFrame: p => frames.push(p) });
    try {
      const echoed = await t.writeRegister(0x30, 0xABCD);
      assert.ok(echoed.equals(leWord(0xABCD)), 'AC31b: write must resolve from the matching echo ONLY (framed 17B form)');
      assert.strictEqual(frames.length, 2, 'AC31b: wrong-devFn + wrong-start frames must be emitted unsolicited, never resolve the write');
      assert.strictEqual(frames[0].devFn, DEV_FN_HOLDING, 'AC31b: first unsolicited frame is the 0x03 read-shape');
      assert.strictEqual(frames[1].devFn, DEV_FN_WRITE_SINGLE, 'AC31b: second unsolicited frame is the 0x06 wrong-start echo');
      assert.strictEqual(frames[1].start, 0x31, 'AC31b: wrong-start echo must carry start 0x31');
    } finally { t.stop(); }
  });
  console.log('PASS AC31b: wrong-devFn + wrong-start frames treated unsolicited (never resolve pending write); framed 17B echo resolves');
}

// ---------------------------------------------------------------------------
// AC31c: an unsolicited holding push arriving DURING a pending write is
// handled safely — emitted to onFrame, never resolves the write.
// ---------------------------------------------------------------------------
async function testAC31c() {
  const frames = [];
  await withFakeDongle(sock => {
    recordAndCapture(sock, reqBuf => {
      const req = parseRequest(reqBuf);
      const push = buildFrame({ devFn: DEV_FN_HOLDING, start: 0, values: Buffer.alloc(160) }); // 0-79 holding push
      const ok = buildWriteEcho16({ start: req.start, value: req.count });
      sock.write(Buffer.concat([push, ok]));
    });
  }, async port => {
    const t = makeTransport(port, { onFrame: p => frames.push(p) });
    try {
      const echoed = await t.writeRegister(0x4B, 60);
      assert.ok(echoed.equals(leWord(60)), 'AC31c: write must still resolve after the push');
      assert.strictEqual(echoed.readUInt16LE(0), 60, 'AC31c: echo word 60 round-trips');
      assert.strictEqual(frames.length, 1, 'AC31c: exactly one unsolicited frame (the push)');
      assert.strictEqual(frames[0].devFn, DEV_FN_HOLDING, 'AC31c: push devFn 0x03');
      assert.strictEqual(frames[0].start, 0, 'AC31c: push start 0');
      assert.strictEqual(frames[0].byteLen, 160, 'AC31c: push byte_len 160');
    } finally { t.stop(); }
  });
  console.log('PASS AC31c: holding push during pending write → onFrame, write still resolves on its echo');
}

// ---------------------------------------------------------------------------
// AC31d: stateful fake dongle — write-then-read-back of the same holding
// register returns the written value on the same connection.
// ---------------------------------------------------------------------------
async function testAC31d() {
  await withFakeDongle(sock => {
    const regs = new Map();
    recordAndCapture(sock, reqBuf => {
      const req = parseRequest(reqBuf);
      if (req.devFn === DEV_FN_WRITE_SINGLE) {
        regs.set(req.start, req.count); // value lives in the u16 LE field
        sock.write(buildWriteEcho16({ start: req.start, value: req.count }));
      } else {
        const v = regs.has(req.start) ? regs.get(req.start) : 0;
        sock.write(buildFrame({ devFn: req.devFn, start: req.start, values: leWord(v) }));
      }
    });
  }, async port => {
    const t = makeTransport(port);
    try {
      await t.writeRegister(0x69, 77);
      const readBack = await t.readRegisters(0x69, 1, DEV_FN_HOLDING);
      assert.strictEqual(readBack.length, 2, 'AC31d: read-back must return one register');
      assert.strictEqual(readBack.readUInt16LE(0), 77, 'AC31d: read-back of the written register must return 77');
      // untouched register reads back 0
      const untouched = await t.readRegisters(0x6A, 1, DEV_FN_HOLDING);
      assert.strictEqual(untouched.readUInt16LE(0), 0, 'AC31d: untouched register must read back 0');
    } finally { t.stop(); }
  });
  console.log('PASS AC31d: stateful fake — writeRegister(0x69, 77) then readRegisters(0x69) returns 77; untouched reg reads 0');
}

// ---------------------------------------------------------------------------
async function main() {
  await testAC8();
  await testAC5();
  await testAC6();
  await testAC9();
  await testAC10();
  await testAC11();
  await testAC12();
  await testAC31a();
  await testAC31b();
  await testAC31c();
  await testAC31d();
  console.log('PASS: dongle-luxpower-socket.test.js — AC5, AC6, AC8..AC12, AC31a-d (write flows) all green');
  process.exitCode = 0;
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
