// Distance flown (lib/distance.js): sum of GPS hops, ignoring jitter and jumps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flightDistance, haversineM } = require('../lib/distance');
const { buildSessions } = require('../lib/sessions');

const T0 = Date.parse('2026-11-18T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const M_PER_DEG_LAT = 111195;                              // metres per degree of latitude
const LAT0 = 23.0;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);

// A point `east` / `north` metres from (LAT0, 72.5), `s` seconds into the flight.
let seq = 0;
const pt = (s, east, north) => ({
  seq: ++seq, trackerId: 'D1', receivedAt: at(s),
  lat: LAT0 + north / M_PER_DEG_LAT, lon: 72.5 + east / M_PER_DEG_LON,
});
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test('haversine: 0.001 degree of latitude is about 111 m', () => {
  near(haversineM({ lat: 23, lon: 72 }, { lat: 23.001, lon: 72 }), 111.2, 0.2, 'distance');
});

test('zig-zag (lawn-mower) flight: distance flown is the whole path, not start-to-end', () => {
  // 5 passes of 200 m east/west, 30 m apart, one point every 20 m (2 s apart at 10 m/s).
  const points = [];
  let s = 0;
  for (let pass = 0; pass < 5; pass++) {
    const north = pass * 30;
    if (pass > 0) points.push(pt(s += 3, pass % 2 ? 200 : 0, north));      // 30 m step north
    for (let e = 20; e <= 200; e += 20) points.push(pt(s += 2, pass % 2 ? 200 - e : e, north));
  }
  points.unshift(pt(0, 0, 0));
  points.forEach((p, i) => { if (i) p.receivedAt = at(i * 2); });
  const { summary } = flightDistance(points);
  near(summary.flownM, 5 * 200 + 4 * 30, 2, 'flown');                   // 1120 m
  near(summary.straightLineM, Math.hypot(200, 120), 2, 'straight line'); // ends 200 m east, 120 m north
  near(summary.areaBox.widthM, 200, 1, 'area box width');
  near(summary.areaBox.heightM, 120, 1, 'area box height');
  near(summary.startEndBox.alongSidesM, 320, 2, 'start-end box sides');
  assert.ok(summary.flownM > summary.startEndBox.alongSidesM * 3, 'the box method badly underestimates a zig-zag');
});

test('a closed loop back to the start: flown ~400 m, straight line ~0', () => {
  const points = [pt(0, 0, 0), pt(10, 100, 0), pt(20, 100, 100), pt(30, 0, 100), pt(40, 0, 0)];
  const { summary } = flightDistance(points);
  near(summary.flownM, 400, 1, 'flown');
  near(summary.straightLineM, 0, 0.5, 'straight line');
  near(summary.startEndBox.alongSidesM, 0, 0.5, 'start-end box');
});

test('hovering with GPS jitter adds no distance', () => {
  const wobble = [[0, 0], [1.2, -0.8], [-1, 1.5], [0.5, 0.4], [-1.8, -0.6], [1.4, 1.1], [0, -1.9]];
  const points = Array.from({ length: 60 }, (_, i) => pt(i * 2, ...wobble[i % wobble.length]));
  const { summary } = flightDistance(points);
  assert.equal(summary.flownM, 0);
  assert.equal(summary.ignoredSmallMoves, 59);
});

test('one bad GPS fix far away is skipped', () => {
  const points = [pt(0, 0, 0), pt(5, 50, 0), pt(10, 5000, 3000), pt(15, 100, 0), pt(20, 150, 0)];
  const { summary } = flightDistance(points);
  near(summary.flownM, 150, 1, 'flown');
  assert.equal(summary.ignoredJumps, 1);
  near(summary.areaBox.widthM, 150, 1, 'the bad fix is not part of the area box');
  near(summary.areaBox.heightM, 0, 0.5, 'area box height');
});

test('a fast move that continues from the new place is real and counted', () => {
  // Uploads arriving 1 s apart (e.g. bunched after a network delay): 300 m, then onwards.
  const points = [pt(0, 0, 0), pt(1, 300, 0), pt(2, 310, 0), pt(3, 320, 0)];
  const { summary } = flightDistance(points);
  near(summary.flownM, 320, 1, 'flown');
  assert.equal(summary.ignoredJumps, 0);
});

test('sharp zig-zags sent faster than real flight are still counted when they move on', () => {
  // Legs of ~280 m every 5 s (~56 m/s, above the limit), each ending somewhere new.
  const points = [pt(0, 0, 0), pt(5, 100, 260), pt(10, 160, 20), pt(15, 260, 270), pt(20, 330, 30), pt(25, 420, 280)];
  let truth = 0;
  const m = [[0, 0], [100, 260], [160, 20], [260, 270], [330, 30], [420, 280]];
  for (let i = 1; i < m.length; i++) truth += Math.hypot(m[i][0] - m[i - 1][0], m[i][1] - m[i - 1][1]);
  const { summary } = flightDistance(points);
  near(summary.flownM, truth, 2, 'flown');
  assert.equal(summary.ignoredJumps, 0);
});

test('a device repeating one Timestamp: the arrival times are used for speed', () => {
  // Same device time on every upload, but they arrive 30 s apart: 300 m legs are only 10 m/s.
  const stamp = '2026-11-18 15:30:00';
  const points = [pt(0, 0, 0), pt(30, 0, 300), pt(60, 0, 10), pt(90, 0, 310)].map(p => ({ ...p, timestamp: stamp }));
  const { summary } = flightDistance(points);
  near(summary.flownM, 300 + 290 + 300, 2, 'flown');
  assert.equal(summary.ignoredJumps, 0);
});

test('an out-and-back faster than a drone can fly is a bad fix; a higher limit keeps it', () => {
  const points = [pt(0, 0, 0), pt(5, 0, 400), pt(10, 0, 20)];   // 400 m out and back in 5 s each
  assert.equal(flightDistance(points).summary.ignoredJumps, 1);
  near(flightDistance(points, { maxSpeedMps: 150 }).summary.flownM, 780, 2, 'flown with a 150 m/s limit');
});

test('slow movement in 1 m steps still adds up', () => {
  const points = Array.from({ length: 31 }, (_, i) => pt(i * 2, i, 0));   // 30 m east, 1 m at a time
  const { summary } = flightDistance(points);
  near(summary.flownM, 30, 3, 'flown');
});

test('distance from the start grows point by point and ends at the total', () => {
  const points = [pt(0, 0, 0), pt(10, 100, 0), pt(20, 100, 100), pt(30, 0, 100)];
  const { summary, bySeq } = flightDistance(points);
  const values = points.map(p => bySeq.get(p.seq));
  assert.equal(values[0], 0);
  values.slice(1).forEach((v, i) => assert.ok(v >= values[i]));
  assert.equal(values[values.length - 1], summary.flownM);
  near(summary.avgSpeedKmh, 300 / 30 * 3.6, 0.2, 'average speed');
});

test('sessions carry their own distance; a new flight starts again from 0', () => {
  const bySeq = new Map();
  const points = [pt(0, 0, 0), pt(10, 100, 0), pt(1000, 5000, 0), pt(1010, 5050, 0)];   // 990 s gap = new flight
  const sessions = buildSessions(points, { now: T0 + 2000000, offlineAfterMs: 300000, distanceBySeq: bySeq });
  assert.equal(sessions.length, 2);
  near(sessions[0].distance.flownM, 100, 1, 'flight 1');
  near(sessions[1].distance.flownM, 50, 1, 'flight 2');
  assert.equal(bySeq.get(points[2].seq), 0);
});
