// Tracking sessions: splits a tracker's GPS points into flights and decides
// whether the latest flight is still live.
//
// The drone tags send no "power off" message (neither sketch has one), so a
// session counts as ended once nothing has arrived for `offlineAfterMs`. That
// window is several transmission intervals long, so one missed packet or a
// short network drop does not end a flight. A point that arrives after a longer
// silence starts a new session; earlier sessions never change again.

function validFix(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180 && !(p.lat === 0 && p.lon === 0) &&
    Number.isFinite(Date.parse(p.receivedAt));
}

// Compass bearing in degrees (0 = north, clockwise) from a to b.
function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// Direction of travel from the last two different positions, or null.
function headingFromPath(points) {
  const last = points[points.length - 1];
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i].lat !== last.lat || points[i].lon !== last.lon) return Math.round(bearing(points[i], last));
  }
  return null;
}

const position = p => ({ lat: p.lat, lon: p.lon, receivedAt: p.receivedAt, seq: p.seq });

// points: one tracker's points, oldest first. telemetry: that tracker's telemetry records.
// Returns the sessions (oldest first) without their points.
function buildSessions(points, { now = Date.now(), offlineAfterMs, telemetry = [] }) {
  const groups = [];
  let current = null;
  let lastTime = -Infinity;
  for (const p of points) {
    if (!validFix(p)) continue;
    const t = Date.parse(p.receivedAt);
    if (t < lastTime) continue;                        // out of order: never rewrite an older session
    if (!current || t - lastTime > offlineAfterMs) {
      current = [];
      groups.push(current);
    }
    current.push(p);
    lastTime = t;
  }

  return groups.map((group, i) => {
    const first = group[0];
    const last = group[group.length - 1];
    const lastSeenMs = Date.parse(last.receivedAt);
    const live = i === groups.length - 1 && now - lastSeenMs <= offlineAfterMs;
    // Heading: the newest telemetry HeadingDeg sent during this session, else the direction of travel.
    const fromTelemetry = telemetry
      .filter(r => Number.isFinite(r.headingDeg) && r.receivedAt >= first.receivedAt &&
        Date.parse(r.receivedAt) <= lastSeenMs + offlineAfterMs)
      .pop();
    return {
      id: String(first.seq),
      number: i + 1,
      status: live ? 'live' : 'ended',
      startedAt: first.receivedAt,
      lastSeenAt: last.receivedAt,
      endedAt: live ? null : last.receivedAt,
      // While live, the session ends at this time unless new data arrives.
      offlineAt: live ? new Date(lastSeenMs + offlineAfterMs).toISOString() : null,
      start: position(first),
      current: live ? position(last) : null,
      end: live ? null : position(last),
      headingDeg: fromTelemetry ? Math.round(fromTelemetry.headingDeg) % 360 : headingFromPath(group),
      pointCount: group.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
    };
  });
}

module.exports = { buildSessions, validFix, bearing };
