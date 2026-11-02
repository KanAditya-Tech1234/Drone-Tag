// Device timestamps -> the real recording time (lib/time.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDeviceTime, recordedTime } = require('../lib/time');

const iso = ms => new Date(ms).toISOString();

test('zone-free firmware time is already IST: not shifted a second time', () => {
  assert.equal(iso(parseDeviceTime('2026-10-30 18:00:00')), '2026-10-30T12:30:00.000Z');
  assert.equal(iso(parseDeviceTime('2026-10-30T18:00')), '2026-10-30T12:30:00.000Z');
});

test('ISO times with a zone are converted from that zone', () => {
  assert.equal(iso(parseDeviceTime('2026-10-30T12:30:00Z')), '2026-10-30T12:30:00.000Z');
  assert.equal(iso(parseDeviceTime('2026-10-30T18:00:00+05:30')), '2026-10-30T12:30:00.000Z');
  assert.equal(iso(parseDeviceTime('2026-10-30 18:00:00+0530')), '2026-10-30T12:30:00.000Z');
  const unixSeconds = Date.UTC(2026, 9, 30, 12, 40) / 1000;
  assert.equal(iso(parseDeviceTime(String(unixSeconds))), '2026-10-30T12:40:00.000Z');
  assert.equal(iso(parseDeviceTime(String(unixSeconds * 1000))), '2026-10-30T12:40:00.000Z');
});

test('unreadable or unbelievable device times fall back to the arrival time', () => {
  const received = '2026-10-30T12:31:00.000Z';
  assert.deepEqual(recordedTime('2026-10-30 18:00:00', received), { recordedAt: '2026-10-30T12:30:00.000Z', timeSource: 'device' });
  for (const bad of [undefined, '', 'yesterday', '1970-01-01 00:00:00', '2026-13-40 99:00:00',
    '2026-10-30 23:30:00',                // 5.5 h ahead: a doubled IST shift
    '2026-10-01 18:00:00']) {             // weeks before it arrived
    assert.deepEqual(recordedTime(bad, received), { recordedAt: received, timeSource: 'server' }, String(bad));
  }
});
