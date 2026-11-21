// "Start → selected point" summary used by the drone dashboard (public/js/geo.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summaryUpTo, summaryBetween } = require('../public/js/geo');
const { flightDistance } = require('../lib/distance');

const T0 = Date.parse('2026-11-19T10:00:00Z');
const LAT0 = 23.0;
const M_PER_DEG_LAT = 111195;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

// Builds a flight the way GET /api/data returns it: points with distanceFromStartM and gpsJump.
function apiFlight(metres, secondsApart = 10) {
  const points = metres.map(([east, north], i) => ({
    seq: i + 1, trackerId: 'D1',
    lat: LAT0 + north / M_PER_DEG_LAT, lon: 72.5 + east / M_PER_DEG_LON,
    receivedAt: new Date(T0 + i * secondsApart * 1000).toISOString(),
  }));
  const { summary, bySeq, jumpSeqs } = flightDistance(points);
  const api = points.map(p => ({
    ...p, recordedAt: p.receivedAt, distanceFromStartM: bySeq.get(p.seq),
    ...(jumpSeqs.includes(p.seq) ? { gpsJump: true } : {}),
  }));
  return { api, summary };
}

// Lawn-mower: 150 m east, 25 m north, 150 m west, 25 m north, 150 m east.
const LAWN = [[0, 0], [75, 0], [150, 0], [150, 25], [75, 25], [0, 25], [0, 50], [75, 50], [150, 50]];

test('selecting the last point gives exactly the whole-flight numbers', () => {
  const { api, summary } = apiFlight(LAWN);
  const d = summaryUpTo(api, api[api.length - 1].seq);
  assert.equal(d.flownM, summary.flownM);
  assert.equal(d.straightLineM, summary.straightLineM);
  assert.deepEqual(d.startEndBox, summary.startEndBox);
  assert.deepEqual(d.areaBox, summary.areaBox);
  assert.equal(d.durationSec, summary.durationSec);
});

test('the area only covers the flight up to the selected point', () => {
  const { api } = apiFlight(LAWN);
  const afterPass1 = summaryUpTo(api, 3);                 // still on the first line: no area yet
  near(afterPass1.areaBox.widthM, 150, 1, 'width after pass 1');
  assert.equal(afterPass1.areaBox.areaM2, 0);
  near(afterPass1.flownM, 150, 1, 'flown after pass 1');

  const afterPass2 = summaryUpTo(api, 6);                 // 150 m wide, 25 m tall
  near(afterPass2.areaBox.areaM2, 150 * 25, 40, 'area after pass 2');
  near(afterPass2.flownM, 325, 1, 'flown after pass 2');
  assert.equal(afterPass2.pointCount, 6);

  const whole = summaryUpTo(api, 9);                      // 150 m wide, 50 m tall
  near(whole.areaBox.areaM2, 150 * 50, 60, 'whole area');
});

test('area and distance never shrink as the selected point moves later', () => {
  const { api } = apiFlight(LAWN);
  let lastArea = -1;
  let lastFlown = -1;
  for (const p of api) {
    const d = summaryUpTo(api, p.seq);
    assert.ok(d.areaBox.areaM2 >= lastArea && d.flownM >= lastFlown, `point ${p.seq}`);
    lastArea = d.areaBox.areaM2;
    lastFlown = d.flownM;
  }
});

test('the start point gives zero; a bad GPS fix or an unknown point cannot be selected', () => {
  const { api } = apiFlight([[0, 0], [50, 0], [5000, 3000], [100, 0], [150, 0]], 5);
  const start = summaryUpTo(api, 1);
  assert.equal(start.flownM, 0);
  assert.equal(start.areaBox.areaM2, 0);
  assert.equal(api[2].gpsJump, true);
  assert.equal(summaryUpTo(api, 3), null);                 // the bad fix itself
  const after = summaryUpTo(api, 4);                       // the bad fix is not in the area
  near(after.areaBox.widthM, 100, 1, 'width without the bad fix');
  assert.equal(after.ignoredJumps, 1);
  assert.equal(summaryUpTo(api, 99), null);
});

test('a custom range covers only the part between the two chosen points', () => {
  const { api } = apiFlight(LAWN);
  const pass2 = summaryBetween(api, 3, 6);                // 25 m north, then 150 m west
  near(pass2.flownM, 175, 1, 'flown in range');
  near(pass2.areaBox.widthM, 150, 1, 'range width');
  near(pass2.areaBox.heightM, 25, 0.5, 'range height');
  near(pass2.straightLineM, Math.hypot(150, 25), 1, 'straight line in range');
  assert.equal(pass2.pointCount, 4);
  assert.equal(pass2.fromNumber, 3);
  assert.equal(pass2.toNumber, 6);
  assert.equal(pass2.durationSec, 30);

  const middle = summaryBetween(api, 4, 5);               // half of pass 2 only: a line, no area
  near(middle.flownM, 75, 1, 'flown');
  assert.equal(middle.areaBox.areaM2, 0);
});

test('choosing the end before the start gives the same range', () => {
  const { api } = apiFlight(LAWN);
  assert.deepEqual(summaryBetween(api, 7, 2), summaryBetween(api, 2, 7));
});

test('ranges add up: A → B plus B → C equals A → C', () => {
  const { api } = apiFlight(LAWN);
  const ab = summaryBetween(api, 2, 5);
  const bc = summaryBetween(api, 5, 8);
  const ac = summaryBetween(api, 2, 8);
  near(ab.flownM + bc.flownM, ac.flownM, 0.2, 'flown');
});

test('a range from the flight start equals start → point; a bad fix cannot end a range', () => {
  const { api } = apiFlight(LAWN);
  assert.deepEqual(summaryBetween(api, 1, 6), summaryUpTo(api, 6));
  assert.equal(summaryBetween(api, 4, 4).flownM, 0);
  const glitch = apiFlight([[0, 0], [50, 0], [5000, 3000], [100, 0], [150, 0]], 5).api;
  assert.equal(summaryBetween(glitch, 3, 5), null);
  assert.equal(summaryBetween(glitch, 1, 3), null);
  near(summaryBetween(glitch, 2, 5).areaBox.widthM, 100, 1, 'bad fix not in the range area');
});
