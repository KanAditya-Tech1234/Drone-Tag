// The API docs (lib/openapi.js, shown at /docs) must match the real server:
// every documented endpoint answers with a documented status, every example is
// accepted, and every field the server returns is documented.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drone-tag-docs-'));
process.env.DATA_DIR = DATA_DIR;
process.env.CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const { start } = require('../server');
const spec = require('../lib/openapi');
const JPEG = fs.readFileSync(path.join(__dirname, '..', 'postman', 'sample-photo.jpg'));

let server;
let base;
let cookie = '';

before(async () => {
  server = start(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // Some data and a login, so every endpoint has something to answer with.
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const [lat, lon] of [[23.0, 72.5], [23.001, 72.5], [23.001, 72.501]]) {
    await post('/api/data', { TrackerId: 'DRONE-01', Latitude: lat, Longitude: lon });
  }
  await fetch(`${base}/api/data?trackerId=DRONE-01&lat=23.0005&lon=72.5005`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
  await post('/api/telemetry', { TrackerId: 'DRONE-01', BatteryPercent: 80 });
  await fetch(`${base}/api/config?trackerId=DRONE-01&filename=params.txt`, { method: 'POST', body: 'A=1\n' });
  const reg = await post('/auth/register', {
    name: 'Docs Test', email: 'docs@example.com', phone: '9876500000', password: 'Secret123',
    trackerId: 'DRONE-01', uin: 'UIN-DOCS-01', category: 'Small', application: 'Spraying', autonomy: 'Manual', range: 'Short',
  });
  cookie = (reg.headers.getSetCookie()[0] || '').split(';')[0];
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// Follows $ref / allOf to the object's documented property names.
function propsOf(schema) {
  if (!schema) return null;
  if (schema.$ref) return propsOf(spec.components.schemas[schema.$ref.split('/').pop()]);
  const names = new Set(Object.keys(schema.properties || {}));
  for (const part of schema.allOf || []) (propsOf(part) || []).forEach(n => names.add(n));
  return names;
}
function undocumented(value, schema, where) {
  const names = propsOf(schema);
  return Object.keys(value).filter(k => !names.has(k)).map(k => `${where}.${k}`);
}

test('the docs page and the OpenAPI description are served', async () => {
  const page = await fetch(base + '/docs');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /swagger-ui/);
  const res = await fetch(base + '/openapi.json');
  assert.equal(res.status, 200);
  const served = await res.json();
  assert.equal(served.openapi, '3.0.3');
  assert.equal(served.info.version, require('../package.json').version);
});

test('every $ref points to a defined schema and every tag is declared', () => {
  const text = JSON.stringify(spec);
  for (const [, name] of text.matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)) {
    assert.ok(spec.components.schemas[name], `missing schema ${name}`);
  }
  const tags = new Set(spec.tags.map(t => t.name));
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      assert.ok(op.tags.every(t => tags.has(t)), `${method} ${p}: undeclared tag`);
      assert.ok(Object.keys(op.responses).length > 0, `${method} ${p}: no responses`);
    }
  }
});

test('every documented endpoint exists and answers with a documented status', async () => {
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const url = base + p.replace('{trackerId}', 'DRONE-01');
      const headers = op.security ? { Cookie: cookie } : {};
      let body;
      const content = op.requestBody && op.requestBody.content;
      if (content && content['application/json']) {
        const c = content['application/json'];
        body = JSON.stringify(c.example || (c.examples && Object.values(c.examples)[0].value) || {});
        headers['Content-Type'] = 'application/json';
      } else if (content && content['text/plain']) {
        body = 'A=1\n';
      }
      // Never actually log out / reset during this check; those are covered below / in api.test.js.
      if (p === '/auth/logout') continue;
      const target = p === '/api/config' && method === 'post' ? `${url}?trackerId=DRONE-01&filename=more.txt` : url;
      // The live stream never ends: check its status, then hang up.
      const ctrl = new AbortController();
      const res = await fetch(target, { method: method.toUpperCase(), headers, body, signal: ctrl.signal });
      ctrl.abort();
      const documented = Object.keys(op.responses).map(Number);
      assert.ok(documented.includes(res.status), `${method.toUpperCase()} ${p} answered ${res.status}, documented: ${documented.join(', ')}`);
    }
  }
});

test('the examples in the docs are accepted by the server', async () => {
  const dataBody = spec.paths['/api/data'].post.requestBody.content['application/json'].examples;
  for (const [name, ex] of Object.entries(dataBody)) {
    const res = await fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ex.value) });
    assert.equal(res.status, 200, `/api/data example "${name}"`);
  }
  const tel = spec.paths['/api/telemetry'].post.requestBody.content['application/json'].example;
  const res = await fetch(base + '/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tel) });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).ignoredFields, undefined, 'every field in the telemetry example is a known field');
  const packetExamples = spec.paths['/api/packet'].post.requestBody.content['application/json'].examples;
  for (const [name, ex] of Object.entries(packetExamples)) {
    const r = await fetch(base + '/api/packet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ex.value) });
    assert.equal(r.status, 201, `/api/packet example "${name}"`);
    assert.equal((await r.json()).ignoredFields, undefined, `every field in the packet example "${name}" is known`);
  }
});

test('every field the server returns is documented', async () => {
  const s = spec.components.schemas;
  const missing = [];
  const one = await (await fetch(base + '/api/data/DRONE-01')).json();
  missing.push(...undocumented(one, s.TrackerData, 'TrackerData'));
  one.points.forEach((p, i) => missing.push(...undocumented(p, s.Point, `points[${i}]`)));
  missing.push(...undocumented(one.photos[0], s.Photo, 'Photo'));
  missing.push(...undocumented(one.session, s.Session, 'Session'));
  missing.push(...undocumented(one.session.distance, s.Distance, 'Distance'));
  missing.push(...undocumented(one.session.distance.areaBox, s.AreaBox, 'AreaBox'));
  const all = await (await fetch(base + '/api/data')).json();
  missing.push(...undocumented(all, s.AllData, 'AllData'));
  missing.push(...undocumented(await (await fetch(base + '/health')).json(), s.Health, 'Health'));
  const tel = await (await fetch(base + '/api/telemetry/DRONE-01')).json();
  missing.push(...undocumented(tel, s.TelemetryOne, 'TelemetryOne'));
  missing.push(...undocumented(tel.latest, s.TelemetryRecord, 'TelemetryRecord'));
  const cfg = await (await fetch(base + '/api/config/DRONE-01')).json();
  missing.push(...undocumented(cfg, s.ConfigList, 'ConfigList'));
  missing.push(...undocumented(cfg.configs[0], s.Config, 'Config'));
  const iv = await (await fetch(base + '/api/interval/DRONE-01', { headers: { Cookie: cookie } })).json();
  missing.push(...undocumented(iv, s.IntervalInfo, 'IntervalInfo'));
  const me = await (await fetch(base + '/auth/me', { headers: { Cookie: cookie } })).json();
  missing.push(...undocumented(me.user.drone, s.Drone, 'Drone'));
  const pk = await (await fetch(base + '/api/packet/1005')).json();
  missing.push(...undocumented(pk, s.PacketList, 'PacketList'));
  missing.push(...undocumented(pk.packets[0], s.Packet, 'Packet'));
  const pr = await (await fetch(base + '/api/packet', { method: 'POST', body: JSON.stringify([{ id: '1005', lat: 23, lon: 72, x: 1 }]) })).json();
  missing.push(...undocumented(pr, s.PacketReply, 'PacketReply'));
  assert.deepEqual(missing, [], 'fields returned by the server but missing from lib/openapi.js');
});

test('the shareable offline docs (docs/) are up to date with lib/openapi.js', (t) => {
  const built = path.join(__dirname, '..', 'docs', 'openapi.json');
  if (!fs.existsSync(built)) return t.skip('docs/ not built yet (node tools/build-offline-docs.js)');
  assert.deepEqual(JSON.parse(fs.readFileSync(built, 'utf8')), JSON.parse(JSON.stringify(spec)),
    'docs/ is out of date: run  node tools/build-offline-docs.js');
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'Drone-Tag-API-Docs.html'), 'utf8');
  assert.ok(!/<(script|link)[^>]+(src|href)="https?:/i.test(html), 'the offline file must not load anything from the internet');
  assert.match(html, /supportedSubmitMethods: \[\]/);
  assert.match(html, /validatorUrl: null/);
});
