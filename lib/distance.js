// Distance covered by a drone during one flight, from its GPS points.
//
// A drone does not fly in a straight line, so the distance flown is the SUM of
// the short hops between consecutive GPS positions (like measuring a winding
// road with many small rulers). Each hop is measured on the Earth's surface
// (haversine formula).
//
// Two kinds of GPS error would otherwise make the total wrong:
//   - Jitter: a hovering or parked drone's position wanders by a few metres.
//     Adding those wobbles up would invent distance. A move only counts once
//     the drone is at least MIN_STEP_M away from the last counted position.
//   - Jumps: a single bad fix can land hundreds of metres away and the next
//     fix is back where the drone really is. Such a spike is skipped only when
//     all three hold: impossibly fast out, impossibly fast back (faster than
//     MAX_SPEED_MPS), and the next fix lands right back next to the previous
//     one (within RETURN_FRACTION of the jump). A sharp zig-zag moves on to a
//     new place, so it is always counted, even when test uploads come faster
//     than a real drone could fly.
//
// For comparison the summary also gives:
//   - straightLineM: start to end in a straight line (a minimum; equals the
//     distance flown only for a perfectly straight flight).
//   - startEndBox: the rectangle with the start and end at opposite corners
//     (the "square from the start and end points" method). Going along its two
//     sides gives an estimate that still ignores every turn in between.
//   - areaBox: the smallest rectangle around the whole flight, i.e. the area
//     the drone worked in.

const { recordedTime } = require('./time');
// Haversine, box and area math are shared with the dashboard (public/js/geo.js).
const { haversineM, areaBox, startEndBox, round1 } = require('../public/js/geo');

const MIN_STEP_M = 3;                // typical GNSS position noise is 2-5 m
// 180 km/h: faster than any of these drones flies. Can be changed with the
// MAX_DRONE_SPEED_MPS environment variable.
const MAX_SPEED_MPS = Number(process.env.MAX_DRONE_SPEED_MPS) > 0 ? Number(process.env.MAX_DRONE_SPEED_MPS) : 50;
const RETURN_FRACTION = 0.2;         // a bad fix comes back within 20% of its jump

// When a point was recorded (device time if believable, else arrival), in ms.
function timeOf(p) {
  return Date.parse(recordedTime(p.timestamp, p.receivedAt).recordedAt);
}

// Seconds between two points for speed checks. Both clocks can make the gap
// look too SHORT (a device repeating one Timestamp; uploads arriving bunched
// together), never too long, so the larger of the two gaps is used (min. 1 s).
function secondsBetween(a, b) {
  const device = (timeOf(b) - timeOf(a)) / 1000;
  const arrival = (Date.parse(b.receivedAt) - Date.parse(a.receivedAt)) / 1000;
  return Math.max(1, device, Number.isFinite(arrival) ? arrival : 0);
}

// points: ONE flight's GPS points, oldest first ({ lat, lon, receivedAt, timestamp?, seq }).
// Returns { summary, bySeq, jumpSeqs } where bySeq maps each point's seq to the
// distance flown from the start of the flight up to that point (metres) and
// jumpSeqs lists the seqs of the bad GPS fixes that were skipped.
function flightDistance(points, { minStepM = MIN_STEP_M, maxSpeedMps = MAX_SPEED_MPS } = {}) {
  const bySeq = new Map();
  const jumpSeqs = [];
  if (!points.length) return { summary: null, bySeq, jumpSeqs };

  let flownM = 0;
  let anchor = points[0];            // last position that was counted
  let ignoredSmallMoves = 0;
  let ignoredJumps = 0;
  const good = [anchor];             // every point except bad fixes (for the area box)
  bySeq.set(anchor.seq, 0);

  const tooFast = (a, b) => haversineM(a, b) / secondsBetween(a, b) > maxSpeedMps;
  // Out and straight back to (almost) where it was: the middle fix was bad.
  const isSpike = (a, p, next) => {
    const out = haversineM(a, p);
    const back = haversineM(p, next);
    return tooFast(a, p) && tooFast(p, next) &&
      haversineM(a, next) <= RETURN_FRACTION * Math.min(out, back);
  };

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const next = points[i + 1];
    const hopM = haversineM(anchor, p);
    if (hopM < minStepM) {
      ignoredSmallMoves++;
      good.push(p);
    } else if (next && isSpike(anchor, p, next)) {
      ignoredJumps++;                // out and straight back again: a bad fix
      jumpSeqs.push(p.seq);
    } else {
      flownM += hopM;
      anchor = p;
      good.push(p);
    }
    bySeq.set(p.seq, round1(flownM));
  }

  const first = points[0];
  const last = points[points.length - 1];
  const durationSec = Math.max(0, Math.round((timeOf(last) - timeOf(first)) / 1000));

  return {
    bySeq,
    jumpSeqs,
    summary: {
      flownM: round1(flownM),
      straightLineM: round1(haversineM(first, last)),
      startEndBox: startEndBox(first, last),
      areaBox: areaBox(good),               // bad fixes left out
      durationSec,
      avgSpeedKmh: durationSec > 0 ? round1(flownM / durationSec * 3.6) : null,
      pointsUsed: points.length - ignoredSmallMoves - ignoredJumps,
      ignoredSmallMoves,
      ignoredJumps,
      minStepM,
      maxSpeedMps,
    },
  };
}

module.exports = { flightDistance, haversineM, MIN_STEP_M, MAX_SPEED_MPS };
