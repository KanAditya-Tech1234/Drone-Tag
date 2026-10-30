// Tracking-session rules (lib/sessions.js): start, live arrow, end after silence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSessions, bearing } = require('../lib/sessions');

const T0 = Date.parse('2026-10-30T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const pt = (s, lat, lon) => ({ seq: ++seq, trackerId: 'D1', lat, lon, receivedAt: at(s) });
const OFF = 120000;   // 2 minutes

test('a running flight is live: fixed start, current position, no end yet', () => {
  const points = [pt(0, 23.0, 72.0), pt(10, 23.001, 72.0), pt(20, 23.002, 72.0)];
  const [s] = buildSessions(points, { now: T0 + 30000, offlineAfterMs: OFF });
  assert.equal(s.status, 'live');
  assert.deepEqual([s.start.lat, s.start.lon], [23.0, 72.0]);
  assert.deepEqual([s.current.lat, s.current.lon], [23.002, 72.0]);
  assert.equal(s.end, null);
  assert.equal(s.headingDeg, 0);                     // moving north
  assert.equal(s.offlineAt, at(20 + 120));
});

test('a short gap (missed packets) does not end the flight', () => {
  const points = [pt(0, 23.0, 72.0), pt(100, 23.001, 72.001)];   // 100 s silence < 120 s
  const sessions = buildSessions(points, { now: T0 + 150000, offlineAfterMs: OFF });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'live');
});

test('after the silence window the flight ends at the last received position', () => {
  const points = [pt(0, 23.0, 72.0), pt(10, 23.001, 72.0), pt(20, 23.002, 72.003)];
  const [s] = buildSessions(points, { now: T0 + 20000 + OFF + 1, offlineAfterMs: OFF });
  assert.equal(s.status, 'ended');
  assert.equal(s.current, null);
  assert.deepEqual([s.end.lat, s.end.lon], [23.002, 72.003]);
  assert.equal(s.endedAt, at(20));
});

test('data after a long silence starts a new flight; the old one stays unchanged', () => {
  const points = [pt(0, 23.0, 72.0), pt(10, 23.001, 72.0), pt(600, 23.1, 72.1), pt(610, 23.101, 72.1)];
  const sessions = buildSessions(points, { now: T0 + 615000, offlineAfterMs: OFF });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].status, 'ended');
  assert.deepEqual([sessions[0].end.lat, sessions[0].end.lon], [23.001, 72.0]);
  assert.equal(sessions[1].status, 'live');
  assert.deepEqual([sessions[1].start.lat, sessions[1].start.lon], [23.1, 72.1]);
  assert.equal(sessions[1].firstSeq, points[2].seq);
});

test('invalid and out-of-order points are ignored', () => {
  const points = [
    pt(0, 23.0, 72.0), pt(5, NaN, 72.0), pt(6, 0, 0), pt(7, 123, 72.0),
    pt(10, 23.001, 72.0), { ...pt(3, 23.5, 72.5) },
  ];
  const [s] = buildSessions(points, { now: T0 + 15000, offlineAfterMs: OFF });
  assert.equal(s.pointCount, 2);
  assert.deepEqual([s.current.lat, s.current.lon], [23.001, 72.0]);
});

test('telemetry heading wins over the direction of travel; standing still gives null', () => {
  const points = [pt(0, 23.0, 72.0), pt(10, 23.001, 72.0)];
  const telemetry = [{ trackerId: 'D1', headingDeg: 271.6, receivedAt: at(9) }];
  const [s] = buildSessions(points, { now: T0 + 12000, offlineAfterMs: OFF, telemetry });
  assert.equal(s.headingDeg, 272);
  const [still] = buildSessions([pt(0, 23.0, 72.0), pt(10, 23.0, 72.0)], { now: T0 + 12000, offlineAfterMs: OFF });
  assert.equal(still.headingDeg, null);
});

test('bearing points east for a move to the east', () => {
  assert.equal(Math.round(bearing({ lat: 23, lon: 72 }, { lat: 23, lon: 72.01 })), 90);
});
