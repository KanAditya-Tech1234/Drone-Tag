// Builds the shareable, offline copy of the API docs:
//
//   docs/Drone-Tag-API-Docs.html   ONE file: Swagger UI + styles + the API description + logo.
//                                  Opens in any browser with no internet and no server.
//   docs/openapi.json              The API description on its own (Postman: Import → this file).
//
//   node tools/build-offline-docs.js
//
// Run it again after any API change (lib/openapi.js). The first run downloads
// Swagger UI from cdnjs once (checked against the SHA-512 below) and keeps it in
// tools/.swagger-ui-cache/, so later runs need no internet.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs');
const CACHE = path.join(__dirname, '.swagger-ui-cache');
const SWAGGER_VERSION = '5.17.14';         // same version as views/docs.html
const FILES = ['swagger-ui-bundle.min.js', 'swagger-ui.min.css'];
// SHA-512 of each file, as published by cdnjs for this version (its "sri" list).
const PINNED = require('./swagger-ui-sha512.json');

async function swaggerFile(name) {
  const cached = path.join(CACHE, `${SWAGGER_VERSION}-${name}`);
  let buf;
  if (fs.existsSync(cached)) {
    buf = fs.readFileSync(cached);
  } else {
    const url = `https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/${name}`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  const hash = crypto.createHash('sha512').update(buf).digest('base64');
  if (PINNED[name] !== hash) {
    throw new Error(`${name}: SHA-512 does not match tools/swagger-ui-sha512.json (got ${hash}). Not using it.`);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, buf);
  return buf.toString('utf8');
}

// Text that goes inside <script> / <style> must not close the tag early.
const safeScript = s => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeStyle = s => s.replace(/<\/style/gi, '<\\/style');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  // Fresh copy of the description (not the cached module of a running server).
  const spec = JSON.parse(JSON.stringify(require('../lib/openapi')));
  // Offline there is no "this server": list the real addresses only.
  spec.servers = spec.servers.filter(s => s.url !== '/');
  const built = new Date().toISOString().slice(0, 10);
  spec.info.description = [
    `> **Offline copy** of the Drone Tag API documentation, version ${spec.info.version}, built ${built}.`,
    '> "Try it out" is switched off here. To send real requests, open `/docs` on a running server',
    '> (e.g. `https://drone-tag-hixr.onrender.com/docs`) or import `openapi.json` into Postman.',
    '',
    spec.info.description,
  ].join('\n');

  const [js, css] = await Promise.all(FILES.map(swaggerFile));
  const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'public', 'images', 'logo.png')).toString('base64');
  const specJson = JSON.stringify(spec);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drone Tag API docs (offline) v${esc(spec.info.version)}</title>
<link rel="icon" href="${logo}">
<style>${safeStyle(css)}</style>
<style>
  body { margin: 0; background: #fff; }
  .dt-top { background: linear-gradient(90deg, #0b3d2e, #14532d); color: #fff; border-bottom: 4px solid #f59e0b;
    font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  .dt-top .inner { max-width: 1460px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .dt-top img { width: 34px; height: 34px; border-radius: 50%; background: #fff; }
  .dt-top b { font-size: 17px; }
  .dt-top span { opacity: 0.8; font-size: 14px; }
  .dt-top .tag { margin-left: auto; background: rgba(255,255,255,0.15); border-radius: 999px; padding: 3px 12px; font-size: 13px; opacity: 1; }
  .swagger-ui .topbar { display: none; }
  .swagger-ui .info { margin: 24px 0; }
</style>
</head>
<body>
<header class="dt-top">
  <div class="inner">
    <img src="${logo}" alt="">
    <b>Drone Tag API</b><span>Documentation v${esc(spec.info.version)}</span>
    <span class="tag">Offline copy · ${esc(built)}</span>
  </div>
</header>
<div id="swagger"></div>
<script>${safeScript(js)}</script>
<script>
  window.ui = SwaggerUIBundle({
    spec: ${safeScript(specJson)},
    dom_id: '#swagger',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    filter: true,
    supportedSubmitMethods: [],     // offline: no "Try it out"
    validatorUrl: null,             // never contact the online validator
  });
</script>
</body>
</html>
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'Drone-Tag-API-Docs.html'), html);
  fs.writeFileSync(path.join(OUT_DIR, 'openapi.json'), JSON.stringify(require('../lib/openapi'), null, 2) + '\n');
  const kb = f => Math.round(fs.statSync(path.join(OUT_DIR, f)).size / 1024);
  console.log(`Written docs/Drone-Tag-API-Docs.html (${kb('Drone-Tag-API-Docs.html')} KB) and docs/openapi.json (${kb('openapi.json')} KB)`);
})().catch(e => { console.error(e.message); process.exit(1); });
