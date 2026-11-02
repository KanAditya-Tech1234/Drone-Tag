// When was a GPS point / image really recorded?
//
// Both sketches send "Timestamp" as "YYYY-MM-DD HH:MM:SS" that the firmware has
// ALREADY converted to IST (no zone marker), so such a value is read as IST and
// must not be shifted by another 5:30. A value with "Z" or an offset (ISO 8601)
// is converted from that zone. If the device time is missing or not believable,
// the server's receive time is used instead.

const IST_OFFSET_MS = 330 * 60 * 1000;
const MAX_AHEAD_MS = 10 * 60 * 1000;            // a device clock this far ahead of the server is wrong
const MAX_BEHIND_MS = 7 * 24 * 60 * 60 * 1000;  // older than a week before arrival: not believable

const ZONED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

// Device timestamp -> epoch ms (UTC), or null when it cannot be read.
function parseDeviceTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;          // Unix seconds
  if (/^\d{13}$/.test(s)) return Number(s);                 // Unix milliseconds
  let m = ZONED.exec(s);
  if (m) {
    const ms = Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isFinite(ms) ? ms : null;
  }
  m = LOCAL.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m.map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (sec || 0) > 59) return null;
    return Date.UTC(y, mo - 1, d, h, mi, sec || 0) - IST_OFFSET_MS;   // the firmware's clock is IST
  }
  return null;
}

// { recordedAt: ISO UTC, timeSource: 'device' | 'server' }
function recordedTime(timestamp, receivedAt) {
  const received = Date.parse(receivedAt);
  const device = parseDeviceTime(timestamp);
  const believable = device !== null && new Date(device).getUTCFullYear() >= 2020 &&
    (!Number.isFinite(received) || (device - received <= MAX_AHEAD_MS && received - device <= MAX_BEHIND_MS));
  if (believable) return { recordedAt: new Date(device).toISOString(), timeSource: 'device' };
  return { recordedAt: receivedAt, timeSource: 'server' };
}

module.exports = { parseDeviceTime, recordedTime };
