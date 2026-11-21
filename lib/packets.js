// Data packets: { "id", "lat", "lon", "Alt", "Alt_R", "d_x", "d_y", "d_z" }
// (the earlier long names - long, Altitude, Altitude Reference, delta_x ... - still work).
//
// validatePacket() checks one packet and turns it into the stored record.
// createPacketStream() pushes every new packet to open dashboards at once
// (Server-Sent Events), so the Data packets table fills without refreshing.

const TRACKER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Field names are matched ignoring case, spaces, "_" and "-", so "Alt_R", "alt_r" and "AltR"
// are the same field, as are "d_x", "dx" and "delta_x". "detla_x" (as written in the first
// packet description) is accepted as delta_x.
const ALIASES = {
  trackerId: ['id', 'trackerid', 'droneid'],
  lat: ['lat', 'latitude'],
  long: ['lon', 'long', 'lng', 'longitude'],
  altitude: ['alt', 'altitude'],
  altitudeReference: ['altr', 'altitudereference', 'altituderef', 'altreference', 'altref'],
  deltaX: ['deltax', 'detlax', 'dx'],
  deltaY: ['deltay', 'detlay', 'dy'],
  deltaZ: ['deltaz', 'detlaz', 'dz'],
  timestamp: ['timestamp', 'ts', 'time'],
};
const KNOWN = new Map(Object.entries(ALIASES).flatMap(([field, names]) => names.map(n => [n, field])));
const norm = key => String(key).toLowerCase().replace(/[\s_-]/g, '');

const LIMITS = {
  lat: [-90, 90],
  long: [-180, 180],
  altitude: [-1000, 100000],          // metres
  deltaX: [-1e6, 1e6],
  deltaY: [-1e6, 1e6],
  deltaZ: [-1e6, 1e6],
};
// Names used in error messages (the packet format the drones send).
const LABEL = {
  trackerId: 'id', lat: 'lat', long: 'lon', altitude: 'Alt', altitudeReference: 'Alt_R',
  deltaX: 'd_x', deltaY: 'd_y', deltaZ: 'd_z', timestamp: 'Timestamp',
};

// A number, or a number written as text ("12.5"). Anything else: NaN.
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}

// Returns { errors: [..], record, ignored: [..] }.
function validatePacket(data) {
  const errors = [];
  const ignored = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: ['each packet must be a JSON object'], record: null, ignored };
  }
  const raw = {};
  for (const [key, value] of Object.entries(data)) {
    const field = KNOWN.get(norm(key));
    if (!field) ignored.push(key);
    else if (value !== '' && value !== null && value !== undefined) raw[field] = value;
  }

  const record = {};
  // A numeric id (1005 without quotes) is the same as "1005".
  if (Number.isInteger(raw.trackerId) && raw.trackerId >= 0) raw.trackerId = String(raw.trackerId);
  if (typeof raw.trackerId !== 'string' || !TRACKER_ID_RE.test(raw.trackerId)) {
    errors.push('id is required: 1-64 letters, digits, ".", "_" or "-"');
  } else {
    record.trackerId = raw.trackerId;
  }

  for (const field of ['lat', 'long', 'altitude', 'deltaX', 'deltaY', 'deltaZ']) {
    const required = field === 'lat' || field === 'long';
    if (raw[field] === undefined) {
      if (required) errors.push(`${LABEL[field]} is required`);
      else record[field] = null;
      continue;
    }
    const n = toNumber(raw[field]);
    const [min, max] = LIMITS[field];
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${LABEL[field]} must be a number between ${min} and ${max}`);
    else record[field] = n;
  }
  if (record.lat === 0 && record.long === 0) errors.push('lat / long 0, 0 is not a real position (no GPS fix?)');

  // Altitude Reference: a short text such as "MSL" / "AGL", or a number (e.g. the home altitude).
  const ref = raw.altitudeReference;
  if (ref === undefined) record.altitudeReference = null;
  else if (typeof ref === 'number' && Number.isFinite(ref)) record.altitudeReference = ref;
  else if (typeof ref === 'string' && ref.trim().length <= 40) record.altitudeReference = ref.trim();
  else errors.push('Alt_R (altitude reference) must be text up to 40 characters (e.g. "MSL", "AGL") or a number');

  if (raw.timestamp !== undefined) {
    if ((typeof raw.timestamp !== 'string' && typeof raw.timestamp !== 'number') || String(raw.timestamp).length > 40) {
      errors.push('Timestamp must be text or a number, up to 40 characters');
    } else {
      record.timestamp = String(raw.timestamp);
    }
  } else {
    record.timestamp = null;
  }

  return { errors, record: errors.length ? null : record, ignored };
}

// ---------------------------------------------------------------------
// Live stream (Server-Sent Events)
// ---------------------------------------------------------------------
// GET /api/packet-stream[?trackerId=ID][&since=seq]
// Sends "packet" events (data = one packet as JSON, id = its seq). A browser's
// EventSource reconnects by itself after a network drop and sends the last id
// it saw (Last-Event-ID), so the packets it missed are sent first.
function createPacketStream({ packetsSince }) {
  const clients = new Set();

  // A comment line every 25 s keeps proxies (Render, nginx) from closing an idle stream.
  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  const send = (res, packet) => res.write(`id: ${packet.seq}\nevent: packet\ndata: ${JSON.stringify(packet)}\n\n`);
  const matches = (c, packet) => !c.trackerId || c.trackerId === String(packet.trackerId).toLowerCase();

  function handler(req, res) {
    const trackerId = typeof req.query.trackerId === 'string' && req.query.trackerId ? req.query.trackerId.toLowerCase() : '';
    const since = Number(req.get('Last-Event-ID') ?? req.query.since);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',       // nginx: do not hold the events back
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');      // reconnect after 3 s if the connection drops
    const client = { res, trackerId };
    if (Number.isFinite(since)) {
      for (const p of packetsSince(since)) if (matches(client, p)) send(res, p);
    }
    clients.add(client);
    req.on('close', () => clients.delete(client));
  }

  return {
    handler,
    publish(packet) { for (const c of clients) if (matches(c, packet)) send(c.res, packet); },
    // After "clear all data": every open table empties itself.
    reset() { for (const c of clients) c.res.write('event: reset\ndata: {}\n\n'); },
    clientCount: () => clients.size,
    closeAll() { for (const c of clients) c.res.end(); clients.clear(); },
  };
}

module.exports = { validatePacket, createPacketStream };
