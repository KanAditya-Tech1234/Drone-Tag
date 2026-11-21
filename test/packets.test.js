// Data packets: POST /api/packet, GET /api/packet[/<id>], live stream /api/packet-stream.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drone-tag-packets-'));
process.env.DATA_DIR = DATA_DIR;
process.env.CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const { start } = require('../server');

let server;
let base;
before(async () => {
  server = start(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const PACKET = { id: 'PKT-01', lat: 23.0581, long: 72.5212, Altitude: 12.5, 'Altitude Reference': 'AGL', delta_x: 0.42, delta_y: -0.18, delta_z: 0.05 };
const send = (body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(base + '/api/packet', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

// Opens the live stream and collects its events until stop() is called.
async function openStream(query = '', headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/packet-stream${query}`, { signal: ctrl.signal, headers });
  const events = [];
  const reader = res.body.getReader();
  (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += Buffer.from(value).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (type) events.push({ type, data: JSON.parse(data) });
      }
    }
  })();
  return { res, events, stop: () => ctrl.abort() };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('a data packet is stored and can be read back', async () => {
  const res = await send(PACKET);
  assert.equal(res.status, 201);
  const reply = await res.json();
  assert.equal(reply.status, 'ok');
  assert.ok(reply.packetId && reply.seq && reply.intervalMs >= 1000);

  const one = await (await fetch(base + '/api/packet/pkt-01')).json();
  assert.equal(one.count, 1);
  const p = one.packets[0];
  assert.deepEqual(
    [p.trackerId, p.lat, p.long, p.altitude, p.altitudeReference, p.deltaX, p.deltaY, p.deltaZ],
    ['PKT-01', 23.0581, 72.5212, 12.5, 'AGL', 0.42, -0.18, 0.05],
  );
  assert.equal(p.id, reply.packetId);
  assert.match(p.recordedAt, /^\d{4}-/);
});

test('the current packet format { id, lat, lon, Alt, Alt_R, d_x, d_y, d_z } is stored completely', async () => {
  const res = await send({ id: '1005', lat: 23.078143, lon: 72.531243, Alt: 16.5, Alt_R: 'AGL', d_x: 0.32, d_y: -0.18, d_z: 0.19 });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).ignoredFields, undefined, 'every field is recognised');
  const p = (await (await fetch(base + '/api/packet/1005')).json()).packets[0];
  assert.deepEqual(
    [p.trackerId, p.lat, p.long, p.altitude, p.altitudeReference, p.deltaX, p.deltaY, p.deltaZ],
    ['1005', 23.078143, 72.531243, 16.5, 'AGL', 0.32, -0.18, 0.19],
  );
  // id as a number (no quotes) is the same drone
  assert.equal((await send({ id: 1005, lat: 23.0782, lon: 72.5313, Alt_R: 'MSL' })).status, 201);
  assert.equal((await (await fetch(base + '/api/packet/1005')).json()).count, 2);
});

test('other spellings, numbers as text and a missing Content-Type are accepted', async () => {
  const res = await send(
    { ID: 'PKT-02', Latitude: '23.06', Longitude: '72.53', alt: '15', altitude_reference: 44.2, detla_x: '1', detla_y: 2, detla_z: -3, Timestamp: '2026-11-21 10:00:00', battery: 80 },
    {},
  );
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).ignoredFields, ['battery']);
  const p = (await (await fetch(base + '/api/packet/PKT-02')).json()).packets[0];
  assert.deepEqual([p.lat, p.long, p.altitude, p.altitudeReference, p.deltaX, p.deltaY, p.deltaZ], [23.06, 72.53, 15, 44.2, 1, 2, -3]);
  assert.equal(p.timestamp, '2026-11-21 10:00:00');
});

test('only id, lat and long are required; the rest may be missing', async () => {
  assert.equal((await send({ id: 'PKT-03', lat: 23.1, long: 72.6 })).status, 201);
  const p = (await (await fetch(base + '/api/packet/PKT-03')).json()).packets[0];
  assert.deepEqual([p.altitude, p.altitudeReference, p.deltaX, p.deltaY, p.deltaZ], [null, null, null, null, null]);
});

test('bad packets get every problem listed', async () => {
  const res = await send({ id: 'bad id!', lat: 123, delta_x: 'abc', 'Altitude Reference': { x: 1 } });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.equal(errors.length, 5);   // id, lat range, long missing, delta_x, Altitude Reference
  assert.equal((await send('{ not json')).status, 400);
  assert.equal((await send({ id: 'PKT-04', lat: 0, long: 0 })).status, 400);
});

test('a batch is stored completely or not at all', async () => {
  const ok = await send([{ ...PACKET, id: 'PKT-05' }, { ...PACKET, id: 'PKT-05', delta_x: 1 }]);
  assert.equal(ok.status, 201);
  const reply = await ok.json();
  assert.equal(reply.count, 2);
  assert.equal(reply.packetIds.length, 2);

  const bad = await send([{ ...PACKET, id: 'PKT-06' }, { ...PACKET, id: 'PKT-06', lat: 999 }]);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).errors[0], /^packet 2: /);
  assert.equal((await fetch(base + '/api/packet/PKT-06')).status, 404);

  assert.equal((await send([])).status, 400);
  assert.equal((await send(Array.from({ length: 101 }, () => PACKET))).status, 400);
});

test('reading: all drones, one drone, since and limit, unknown drone', async () => {
  const all = await (await fetch(base + '/api/packet')).json();
  assert.ok(all.count >= 5);
  assert.ok(all.trackers.includes('PKT-01') && all.trackers.includes('PKT-05'));
  const seqs = all.packets.map(p => p.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));        // oldest first
  const newer = await (await fetch(`${base}/api/packet?since=${seqs[seqs.length - 2]}`)).json();
  assert.equal(newer.packets.length, 1);
  assert.equal((await (await fetch(`${base}/api/packet?limit=2`)).json()).packets.length, 2);
  const missing = await fetch(base + '/api/packet/NOPE');
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).trackers.includes('PKT-01'));
});

test('the live stream delivers new packets at once, filtered by drone', async () => {
  const everyone = await openStream();
  const onlyB = await openStream('?trackerId=pkt-live-b');
  assert.equal(everyone.res.status, 200);
  assert.match(everyone.res.headers.get('content-type'), /text\/event-stream/);
  await wait(100);
  await send({ ...PACKET, id: 'PKT-LIVE-A' });
  await send({ ...PACKET, id: 'PKT-LIVE-B' });
  await wait(300);
  assert.deepEqual(everyone.events.filter(e => e.type === 'packet').map(e => e.data.trackerId), ['PKT-LIVE-A', 'PKT-LIVE-B']);
  assert.deepEqual(onlyB.events.map(e => e.data.trackerId), ['PKT-LIVE-B']);
  everyone.stop();
  onlyB.stop();
});

test('after a dropped connection the stream sends the packets that were missed', async () => {
  const before = (await (await fetch(base + '/api/packet')).json()).seq;
  await send({ ...PACKET, id: 'PKT-MISSED' });
  await send({ ...PACKET, id: 'PKT-MISSED' });
  // The browser sends the last id it saw as Last-Event-ID when it reconnects.
  const again = await openStream('', { 'Last-Event-ID': String(before) });
  await wait(300);
  assert.deepEqual(again.events.map(e => e.data.trackerId), ['PKT-MISSED', 'PKT-MISSED']);
  again.stop();
});

test('packets are saved to db.json; clearing all data clears them and tells open pages', async () => {
  await wait(500);                                                 // batched save
  const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
  assert.ok(db.packets.some(p => p.trackerId === 'PKT-01'));

  const live = await openStream();
  await wait(100);
  const reset = await fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) });
  assert.equal(reset.status, 200);
  await wait(200);
  assert.ok(live.events.some(e => e.type === 'reset'));
  assert.equal((await (await fetch(base + '/api/packet')).json()).count, 0);
  live.stop();
});

test('the Data packets page needs a login', async () => {
  const res = await fetch(base + '/packets', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?next=%2Fpackets/);
});
