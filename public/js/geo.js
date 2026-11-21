// Distance and area math shared by the server (lib/distance.js) and the
// browser (drone dashboard), so both always give the same numbers.
//
// Browser: <script src="/js/geo.js"> makes window.DTGeo.
// Node:    require('../public/js/geo.js').
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DTGeo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EARTH_RADIUS_M = 6371008.8;   // mean Earth radius
  const rad = deg => deg * Math.PI / 180;
  const round1 = n => Math.round(n * 10) / 10;

  // Distance in metres between two { lat, lon } positions along the Earth's surface (haversine).
  function haversineM(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Rectangle sides in metres. The east-west side is measured at the middle
  // latitude, because a degree of longitude shrinks towards the poles.
  function boxSides(south, north, west, east) {
    const midLat = (south + north) / 2;
    return {
      eastWestM: haversineM({ lat: midLat, lon: west }, { lat: midLat, lon: east }),
      northSouthM: haversineM({ lat: south, lon: west }, { lat: north, lon: west }),
    };
  }

  // Smallest north-south aligned rectangle around the points: edges, sides and area.
  function areaBox(points) {
    const lats = points.map(p => p.lat);
    const lons = points.map(p => p.lon);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const s = boxSides(south, north, west, east);
    return {
      south, north, west, east,
      widthM: round1(s.eastWestM),
      heightM: round1(s.northSouthM),
      areaM2: Math.round(s.eastWestM * s.northSouthM),
    };
  }

  // The rectangle with a and b at opposite corners: its two sides and their sum.
  function startEndBox(a, b) {
    const s = boxSides(Math.min(a.lat, b.lat), Math.max(a.lat, b.lat), Math.min(a.lon, b.lon), Math.max(a.lon, b.lon));
    return { eastWestM: round1(s.eastWestM), northSouthM: round1(s.northSouthM), alongSidesM: round1(s.eastWestM + s.northSouthM) };
  }

  // Summary of the part of a flight between two of its points (in either order),
  // in the same shape as the server's session.distance. `points` are one
  // flight's points as the API returns them (oldest first, with
  // distanceFromStartM, gpsJump, recordedAt). The distance flown is the
  // difference of the two points' distance from the flight's start; bad GPS
  // fixes are left out of the area. Returns null if either seq is not one of
  // the points or is a bad GPS fix.
  function summaryBetween(points, fromSeq, toSeq) {
    if (fromSeq > toSeq) [fromSeq, toSeq] = [toSeq, fromSeq];
    const range = points.filter(p => p.seq >= fromSeq && p.seq <= toSeq);
    const a = range[0];
    const b = range[range.length - 1];
    if (!a || !b || a.seq !== fromSeq || b.seq !== toSeq || a.gpsJump || b.gpsJump) return null;
    const good = range.filter(p => !p.gpsJump);
    const time = p => Date.parse(p.recordedAt || p.receivedAt);
    const durationSec = Math.max(0, Math.round((time(b) - time(a)) / 1000));
    const flownM = Number.isFinite(a.distanceFromStartM) && Number.isFinite(b.distanceFromStartM)
      ? round1(b.distanceFromStartM - a.distanceFromStartM) : NaN;
    return {
      flownM,
      straightLineM: round1(haversineM(a, b)),
      startEndBox: startEndBox(a, b),
      areaBox: areaBox(good),
      durationSec,
      avgSpeedKmh: durationSec > 0 && Number.isFinite(flownM) ? round1(flownM / durationSec * 3.6) : null,
      pointCount: range.length,
      ignoredJumps: range.length - good.length,
      fromNumber: points.indexOf(a) + 1,     // 1-based position in the flight
      toNumber: points.indexOf(b) + 1,
    };
  }

  // From the flight's start up to the point with `seq`.
  function summaryUpTo(points, seq) {
    return points.length ? summaryBetween(points, points[0].seq, seq) : null;
  }

  return { haversineM, boxSides, areaBox, startEndBox, summaryBetween, summaryUpTo, round1 };
});
