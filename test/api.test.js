// API tests: `npm test` (Node 18+ built-in test runner; no extra packages).
// The server runs on a random port with a temporary DATA_DIR. No access keys are used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drone-tag-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const { start } = require('../server');
const JPEG = fs.readFileSync(path.join(__dirname, '..', 'postman', 'sample-photo.jpg'));

let server;
let base;

before(async () => {
  server = start(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const postJson = (url, body, headers = {}) =>
  fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('GET /health answers', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.message, 'Drone Tag API is running');
});

test('devices send data without any key', async () => {
  const position = { TrackerId: 'TEST-01', Latitude: '23.0580', Longitude: '72.5210' };
  const ok = await postJson('/api/data', position);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, 'ok');
  // A leftover key header from older firmware is simply ignored.
  assert.equal((await postJson('/api/data', position, { 'X-Device-Key': 'old-key' })).status, 200);
  const image = await fetch(`${base}/api/data?trackerId=TEST-01&lat=23.06&lon=72.52&key=old-key`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG,
  });
  assert.equal(image.status, 200);
});

test('dashboard settings work without a key', async () => {
  const ok = await postJson('/api/data', { intervalMs: 10000 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).intervalMs, 10000);
  assert.equal((await postJson('/api/data', { intervalMs: 5 })).status, 400);
});

test('an image is stored and listed in photos, also without GPS', async () => {
  const res = await fetch(`${base}/api/data?trackerId=CAM-T1&filename=field.jpg`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG,
  });
  assert.equal(res.status, 200);
  const { photoId } = await res.json();
  const data = await (await fetch(`${base}/api/data/CAM-T1`)).json();
  assert.equal(data.photos.at(-1).id, photoId);
  const image = await fetch(`${base}/api/data/CAM-T1?photo=${photoId}`);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.compare(Buffer.from(await image.arrayBuffer()), JPEG), 0);
});

test('a non-image upload is refused', async () => {
  const res = await fetch(`${base}/api/data?trackerId=CAM-T1`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('not an image at all'),
  });
  assert.equal(res.status, 400);
});

test('telemetry is validated, stored and readable', async () => {
  const good = {
    TrackerId: 'DRONE-T1', Timestamp: '2026-10-27T10:00:00Z', BatteryPercent: 76.5, BatteryVoltage: 22.4,
    FlightStatus: 'flying', SprayStatus: 'ON', TankLevelPercent: 64, FlowRateLpm: 1.8, SpeedMps: 5.2,
    HeadingDeg: 270, Satellites: 14, SignalDbm: -71, Latitude: 23.058, Longitude: 72.521, Altitude: 12,
    Extra: { pumpPressureBar: 2.1, nozzle: 'A' }, Unknown: 1,
  };
  const res = await postJson('/api/telemetry', good);
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.deepEqual(saved.ignoredFields, ['Unknown']);

  const read = await (await fetch(`${base}/api/telemetry/DRONE-T1`)).json();
  assert.equal(read.latest.id, saved.telemetryId);
  assert.equal(read.latest.flightStatus, 'FLYING');
  assert.equal(read.latest.batteryPercent, 76.5);
  assert.deepEqual(read.latest.extra, { pumpPressureBar: 2.1, nozzle: 'A' });
  // The position also lands on the map trail.
  const data = await (await fetch(`${base}/api/data/DRONE-T1`)).json();
  assert.equal(data.latest.lat, 23.058);

  const all = await (await fetch(`${base}/api/telemetry`)).json();
  assert.ok(all.latest.some(t => t.trackerId === 'DRONE-T1'));
});

test('bad telemetry gets clear errors', async () => {
  const res = await postJson('/api/telemetry', { TrackerId: 'bad id!', BatteryPercent: 140, FlightStatus: 'JUMPING' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.errors.length, 3);
  const empty = await postJson('/api/telemetry', { TrackerId: 'DRONE-T1' });
  assert.equal(empty.status, 400);
  const notJson = await fetch(base + '/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(notJson.status, 400);
  assert.equal((await fetch(`${base}/api/telemetry/NOPE`)).status, 404);
});

test('configuration files: upload, list, download; bad files refused', async () => {
  const plan = JSON.stringify({ mission: { items: [{ lat: 23.05, lon: 72.52 }] } });
  const form = new FormData();
  form.append('TrackerId', 'DRONE-T1');
  form.append('Description', 'Test mission');
  form.append('file', new Blob([plan], { type: 'application/json' }), 'mission.plan');
  const res = await fetch(base + '/api/config', { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const { config } = await res.json();
  assert.equal(config.originalName, 'mission.plan');
  assert.equal(config.size, Buffer.byteLength(plan));

  const raw = await fetch(`${base}/api/config?trackerId=DRONE-T1&filename=params.txt`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'SPRAY_RATE=1.8\n',
  });
  assert.equal(raw.status, 201);

  const list = await (await fetch(`${base}/api/config/DRONE-T1`)).json();
  assert.equal(list.count, 2);
  const download = await fetch(base + config.url);
  assert.equal(await download.text(), plan);

  const badJson = await fetch(`${base}/api/config?trackerId=DRONE-T1&filename=broken.json`, { method: 'POST', body: '{not json' });
  assert.equal(badJson.status, 400);
  const badType = await fetch(`${base}/api/config?trackerId=DRONE-T1&filename=run.exe`, { method: 'POST', body: 'MZ' });
  assert.equal(badType.status, 400);
  const tooBig = await fetch(`${base}/api/config?trackerId=DRONE-T1&filename=big.txt`, {
    method: 'POST', body: 'x'.repeat(1024 * 1024 + 1),
  });
  assert.equal(tooBig.status, 413);
});

test('reset clears everything', async () => {
  assert.equal((await postJson('/api/data', { action: 'reset' })).status, 200);
  assert.equal((await fetch(`${base}/api/telemetry/DRONE-T1`)).status, 404);
  const all = await (await fetch(`${base}/api/data`)).json();
  assert.equal(all.photoCount, 0);
});

test('unknown /api paths answer 404 JSON', async () => {
  const res = await fetch(base + '/api/nothing');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).status, 'error');
});
