const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================================
// API
//
//   GET  /health                       is the service running?
//   POST /api/data                     send data (GPS position, image file, or a dashboard setting)
//   GET  /api/data/<TrackerId>         read that tracker's data (points, photos, delay, or an image file)
//   POST /api/telemetry                send telemetry (battery, flight / spray status, ...)
//   GET  /api/telemetry/<TrackerId>    read that tracker's telemetry
//   POST /api/config                   upload a configuration file
//   GET  /api/config/<TrackerId>       list / download that tracker's configuration files
//
// Images and configuration files are stored as real files in DATA_DIR
// (default ./uploads) and returned exactly as they were uploaded. The
// dashboard is served from "/".
//
// No access keys: devices send data and the dashboard changes settings without
// any key (project decision).
// =====================================================================

// ---------------------------------------------------------------------
// DELAY CONFIG (persisted to disk so it survives a server restart)
// ---------------------------------------------------------------------
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

const MIN_INTERVAL_MS = 1000;     // don't allow silly-fast spam
const MAX_INTERVAL_MS = 300000;   // 5 min ceiling
const DEFAULT_CONFIG = { intervalMs: 5000 };

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.intervalMs === 'number' &&
      parsed.intervalMs >= MIN_INTERVAL_MS &&
      parsed.intervalMs <= MAX_INTERVAL_MS
    ) {
      return { intervalMs: parsed.intervalMs };
    }
  } catch (err) {
    // File missing or corrupt on first run — fall through to default.
  }
  return { ...DEFAULT_CONFIG };
}

// Write to a temp file then rename, so a crash mid-write can't corrupt it.
function writeJsonAtomic(file, value) {
  const tmpPath = file + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, file);
}

let config = loadConfig();
if (!fs.existsSync(CONFIG_PATH)) {
  try { writeJsonAtomic(CONFIG_PATH, config); } catch (err) { console.error('Could not write initial config.json:', err); }
}

// ---------------------------------------------------------------------
// STORAGE (DATA_DIR, default ./uploads)
//   <photoId>.<ext>           the image files themselves
//   configs/<configId>.<ext>  configuration files
//   db.json                   points, telemetry and file details, so a restart keeps them
// On Render's free plan this disk is wiped on every deploy / restart.
// ---------------------------------------------------------------------
const UPLOAD_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'uploads'));
const CONFIG_DIR = path.join(UPLOAD_DIR, 'configs');
const DB_PATH = path.join(UPLOAD_DIR, 'db.json');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const MAX_HISTORY = 1000;                       // GPS points kept
const MAX_PHOTOS = 500;                         // image files kept (oldest deleted first)
const MAX_TELEMETRY = 2000;                     // telemetry records kept
const MAX_CONFIGS = 200;                        // configuration files kept
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;       // per image
const MAX_CONFIG_BYTES = 1 * 1024 * 1024;       // per configuration file
const MAX_JSON_BYTES = 1 * 1024 * 1024;

let history = [];
let photos = [];
let telemetry = [];
let configs = [];
let seq = 0;   // monotonic counter so clients can ask "anything newer than N?"

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    history = Array.isArray(db.points) ? db.points : [];
    // Drop entries whose file has been deleted by hand.
    photos = (Array.isArray(db.photos) ? db.photos : [])
      .filter(p => fs.existsSync(path.join(UPLOAD_DIR, p.file)));
    telemetry = Array.isArray(db.telemetry) ? db.telemetry : [];
    configs = (Array.isArray(db.configs) ? db.configs : [])
      .filter(c => fs.existsSync(path.join(CONFIG_DIR, c.file)));
    seq = Number(db.seq) || 0;
    console.log(
      `Loaded ${history.length} points, ${photos.length} images, ${telemetry.length} telemetry records ` +
      `and ${configs.length} configuration files from ${UPLOAD_DIR}`
    );
  } catch (err) {
    // No saved data yet.
  }
}
loadDb();

// Saving is batched so a burst of uploads causes one disk write, not many.
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeJsonAtomic(DB_PATH, { seq, points: history, photos, telemetry, configs });
    } catch (err) {
      console.error('Could not save uploads/db.json:', err);
    }
  }, 300);
}

// Changes whenever the data is wiped (reset or server restart), so every
// open browser/phone knows to clear its map and start over.
let generation = Date.now();

function addPoint(point) {
  point.seq = ++seq;
  history.push(point);
  if (history.length > MAX_HISTORY) history.shift();
  scheduleSave();
  return point;
}

function deletePhotoFile(p) {
  fs.unlink(path.join(UPLOAD_DIR, p.file), err => {
    if (err && err.code !== 'ENOENT') console.error('Could not delete', p.file, err.message);
  });
}

function addPhoto(photo) {
  photo.seq = ++seq;
  photos.push(photo);
  while (photos.length > MAX_PHOTOS) deletePhotoFile(photos.shift());
  scheduleSave();
  return photo;
}

function deleteConfigFile(c) {
  fs.unlink(path.join(CONFIG_DIR, c.file), err => {
    if (err && err.code !== 'ENOENT') console.error('Could not delete', c.file, err.message);
  });
}

function addTelemetry(record) {
  record.seq = ++seq;
  telemetry.push(record);
  if (telemetry.length > MAX_TELEMETRY) telemetry.shift();
  scheduleSave();
  return record;
}

function addConfig(config) {
  config.seq = ++seq;
  configs.push(config);
  while (configs.length > MAX_CONFIGS) deleteConfigFile(configs.shift());
  scheduleSave();
  return config;
}

function clearAll() {
  photos.forEach(deletePhotoFile);
  configs.forEach(deleteConfigFile);
  history = [];
  photos = [];
  telemetry = [];
  configs = [];
  generation = Date.now();
  scheduleSave();
}

// ---------------------------------------------------------------------
// IMAGE TYPE DETECTION (any image format)
// ---------------------------------------------------------------------
// The type is worked out from the file's first bytes first, because modems
// often send a wrong Content-Type. If the bytes aren't recognised, the
// declared type (image/...) or the file extension is used instead.

const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', ico: 'image/x-icon',
  jp2: 'image/jp2', jxl: 'image/jxl', dng: 'image/x-adobe-dng', raw: 'image/x-raw',
};
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'image/jp2': 'jp2', 'image/jxl': 'jxl',
};

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const ascii = (a, b) => buf.toString('ascii', a, b);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'image/tiff';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  if (buf.slice(4, 12).equals(Buffer.from([0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]))) return 'image/jp2';
  if ((buf[0] === 0xff && buf[1] === 0x0a) || ascii(4, 8) === 'JXL ') return 'image/jxl';
  return null;
}

// SVG is deliberately refused: it can contain scripts, and the images are
// served from the same site as the dashboard.
// Formats sniffImageType() can recognise. If a file claims to be one of
// these but its bytes don't match, it isn't really that image.
const SNIFFABLE = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff',
  'image/x-icon', 'image/avif', 'image/heic', 'image/heif', 'image/jp2', 'image/jxl',
]);

function resolveImageType(buf, declaredType, fileName) {
  const sniffed = sniffImageType(buf);
  if (sniffed) return sniffed;
  // Unrecognised bytes: only trust the declared type / extension for
  // formats we have no signature check for (e.g. camera RAW files).
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (declared.startsWith('image/') && !declared.includes('svg') && !SNIFFABLE.has(declared)) return declared;
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
  const fromExt = EXT_TO_MIME[ext];
  return fromExt && !SNIFFABLE.has(fromExt) ? fromExt : null;
}

function extensionFor(mime, fileName) {
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  const sub = mime.split('/')[1] || 'img';
  return sub.replace(/^x-/, '').replace(/[^a-z0-9]/g, '').slice(0, 5) || 'img';
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
// Image links point at the tracker that sent them:
//   /api/data/<TrackerId>?photo=<photoId>
function photoUrl(trackerId, id) {
  return `/api/data/${encodeURIComponent(trackerId)}?photo=${encodeURIComponent(id)}`;
}

function photoMeta(p) {
  if (!p) return null;
  const { file, ...meta } = p;
  return { ...meta, url: photoUrl(p.trackerId, p.id) };
}

function withPhotoUrl(point) {
  return point.photoId ? { ...point, photoUrl: photoUrl(point.trackerId, point.photoId) } : point;
}

// Tracker IDs are matched without caring about upper/lower case.
function sameTracker(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function trackerList() {
  const ids = new Map();
  [...history, ...photos, ...telemetry, ...configs]
    .forEach(x => ids.set(String(x.trackerId).toLowerCase(), x.trackerId));
  return [...ids.values()];
}

function parseCoord(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : NaN;
}

function formatAltitude(alt) {
  if (alt == null || alt === '') return null;
  return /^-?\d+(\.\d+)?$/.test(String(alt)) ? `${alt}m` : String(alt);
}

// ---------------------------------------------------------------------
// TRACKING SESSIONS (see lib/sessions.js)
// ---------------------------------------------------------------------
// The tags send no power-off message, so a flight counts as ended after this
// much silence: OFFLINE_AFTER_SECONDS (default 120), but never less than three
// transmission intervals, so a single missed upload does not end a flight.
const { buildSessions } = require('./lib/sessions');
const OFFLINE_AFTER_MS = Math.max(10, Number(process.env.OFFLINE_AFTER_SECONDS) || 120) * 1000;

function offlineAfterMs() {
  return Math.max(OFFLINE_AFTER_MS, 3 * config.intervalMs);
}

function sessionsOf(trackerId, points) {
  return buildSessions(points, {
    offlineAfterMs: offlineAfterMs(),
    telemetry: telemetry.filter(r => sameTracker(r.trackerId, trackerId)),
  });
}

// Picks a value from the request using any of the accepted key spellings.
function pick(data, ...keys) {
  for (const k of keys) {
    if (data[k] !== undefined && data[k] !== '') return data[k];
  }
  return undefined;
}

// Stores one report from a device. `image` is { buffer, mime, originalName } or null.
function storeReport(data, image) {
  const receivedAt = new Date().toISOString();
  const trackerId = String(pick(data, 'TrackerId', 'trackerId', 'trackerID', 'id') || 'UNKNOWN');
  const lat = parseCoord(pick(data, 'Latitude', 'latitude', 'lat'));
  const lon = parseCoord(pick(data, 'Longitude', 'longitude', 'lon', 'lng'));
  const altitude = formatAltitude(pick(data, 'Altitude', 'altitude', 'alt'));
  const timestamp = pick(data, 'Timestamp', 'timestamp', 'ts', 'time') || null;
  const hasFix = !Number.isNaN(lat) && !Number.isNaN(lon) && !(lat === 0 && lon === 0) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

  if (!image && !hasFix) {
    return { error: 'invalid or missing coordinates (Latitude/Longitude)' };
  }

  let photo = null;
  if (image) {
    const id = `${Date.now()}-${seq + 1}`;
    const file = `${id}.${extensionFor(image.mime, image.originalName)}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), image.buffer);
    photo = addPhoto({
      id,
      file,
      originalName: image.originalName || null,
      trackerId,
      lat: hasFix ? lat : null,
      lon: hasFix ? lon : null,
      altitude,
      timestamp,
      receivedAt,
      size: image.buffer.length,
      mime: image.mime,
    });
  }

  // An image without a GPS fix is stored but can't be put on the map.
  let point = null;
  if (hasFix) {
    point = addPoint({
      trackerId,
      lat,
      lon,
      altitude,
      timestamp,
      maplink: `https://maps.google.com/?q=${lat},${lon}`,
      receivedAt,
      photoId: photo ? photo.id : undefined,
    });
  }

  console.log(
    `[${receivedAt}] ${trackerId}` +
    (hasFix ? ` -> ${lat}, ${lon}` : ' (no GPS fix)') +
    (photo ? ` + ${photo.mime} ${Math.round(photo.size / 1024)} KB -> uploads/${photo.file}` : '')
  );
  return { point, photo };
}

// Handles { "intervalMs": ... } and { "action": "reset" } from the dashboard.
function handleSetting(data, res) {
  if (data.action !== undefined) {
    if (data.action !== 'reset') {
      return res.status(400).json({ status: 'error', message: 'unknown action (only "reset" is supported)' });
    }
    clearAll();
    console.log('All points and images cleared');
    return res.json({ status: 'ok', message: 'cleared', intervalMs: config.intervalMs });
  }

  const intervalMs = Number(data.intervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return res.status(400).json({
      status: 'error',
      message: `intervalMs must be a number between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    });
  }
  config = { intervalMs };
  try {
    writeJsonAtomic(CONFIG_PATH, config);
  } catch (err) {
    console.error('Could not persist config.json (interval is still updated in memory):', err);
  }
  console.log(`Delay updated -> ${intervalMs} ms`);
  return res.json({ status: 'ok', message: 'delay updated', intervalMs });
}

// =====================================================================
// WEB DASHBOARD: accounts, pages, exports
// =====================================================================
// Only the web pages and the export downloads need a login. Devices keep sending to
// POST /api/data without one, and the read APIs stay open for the Abhyuday Bharat backend.
const { createAuth } = require('./lib/auth');
const { toIST, pointsToCsv, buildZip } = require('./lib/export');

app.set('trust proxy', 1);   // Render / nginx terminate HTTPS: lets req.secure see it
const auth = createAuth({ dataDir: UPLOAD_DIR, writeJsonAtomic });
const VIEWS = path.join(__dirname, 'views');

function currentUser(req) {
  return auth.userFromRequest(req);
}
function requirePage(req, res, next) {
  if (currentUser(req)) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
function requireApi(req, res, next) {
  if (currentUser(req)) return next();
  res.status(401).json({ status: 'error', message: 'please log in' });
}
const page = file => (req, res) => res.sendFile(path.join(VIEWS, file));

// Pages
app.get('/', requirePage, page('overview.html'));
app.get('/drone', requirePage, page('drone.html'));
app.get('/account', requirePage, page('account.html'));
app.get('/settings', requirePage, page('settings.html'));
app.get(['/login', '/register'], (req, res, next) => (currentUser(req) ? res.redirect('/') : next()));
app.get('/login', page('login.html'));
app.get('/register', page('register.html'));
app.get('/about', page('about.html'));
app.get('/help', page('help.html'));
app.get('/support', page('support.html'));

// Static assets (CSS, JS, images) – no directory index.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Account API
const authJson = express.json({ limit: '16kb' });
function startSession(req, res, user) {
  res.setHeader('Set-Cookie', auth.sessionCookie(user, req.secure));
}

app.get('/auth/options', (req, res) => res.json({ status: 'ok', ...auth.options }));

app.post('/auth/register', authJson, (req, res) => {
  const { user, errors } = auth.register(req.body || {});
  if (errors) return res.status(400).json({ status: 'error', message: 'please correct the highlighted fields', errors });
  startSession(req, res, user);
  console.log(`[${new Date().toISOString()}] new dashboard account for tracker ${user.drone.trackerId}`);
  res.status(201).json({ status: 'ok', user: auth.publicUser(user) });
});

app.post('/auth/login', authJson, (req, res) => {
  const ip = req.ip || 'unknown';
  if (auth.tooManyFailures(ip)) {
    return res.status(429).json({ status: 'error', message: 'too many failed attempts - try again in 15 minutes' });
  }
  const body = req.body || {};
  const user = auth.login(body.phone, body.password);
  if (!user) {
    auth.recordFailure(ip);
    return res.status(401).json({ status: 'error', message: 'wrong mobile number or password' });
  }
  auth.clearFailures(ip);
  startSession(req, res, user);
  res.json({ status: 'ok', user: auth.publicUser(user) });
});

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookie(req.secure));
  res.json({ status: 'ok' });
});

app.get('/auth/me', requireApi, (req, res) => res.json({ status: 'ok', user: auth.publicUser(currentUser(req)) }));

app.put('/auth/me', requireApi, authJson, (req, res) => {
  const { user, errors } = auth.update(currentUser(req), req.body || {});
  if (errors) return res.status(400).json({ status: 'error', message: 'please correct the highlighted fields', errors });
  res.json({ status: 'ok', user: auth.publicUser(user) });
});

// Registered drones (for the filters and the drone info table)
app.get('/api/drones', requireApi, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok', drones: auth.drones() });
});

// Export one tracker's points as CSV (times in IST)
app.get('/api/export/:trackerId/csv', requireApi, (req, res) => {
  const trackerId = req.params.trackerId;
  const points = history.filter(p => sameTracker(p.trackerId, trackerId));
  if (points.length === 0) return res.status(404).json({ status: 'error', message: `no data for tracker "${trackerId}"` });
  const base = `${req.protocol}://${req.get('host')}`;
  const csv = pointsToCsv(points, p => base + photoUrl(p.trackerId, p.photoId));
  const safe = trackerId.replace(/[^A-Za-z0-9._-]/g, '_');
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="drone_${safe}_${toIST(new Date().toISOString()).slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send(csv);
});

// Export one tracker's images as a ZIP (file names carry the IST capture time)
app.get('/api/export/:trackerId/images.zip', requireApi, (req, res) => {
  const trackerId = req.params.trackerId;
  const mine = photos.filter(p => sameTracker(p.trackerId, trackerId));
  if (mine.length === 0) return res.status(404).json({ status: 'error', message: `no images for tracker "${trackerId}"` });
  const files = [];
  mine.forEach((p, i) => {
    try {
      const data = fs.readFileSync(path.join(UPLOAD_DIR, p.file));
      const stamp = toIST(p.receivedAt).replace(/^(\d\d)-(\d\d)-(\d{4}) (\d\d):(\d\d):(\d\d)$/, '$3$2$1_$4$5$6');
      files.push({ name: `${String(i + 1).padStart(3, '0')}_${stamp}_IST.${path.extname(p.file).slice(1) || 'jpg'}`, data, date: new Date(p.receivedAt) });
    } catch (err) { /* file removed meanwhile */ }
  });
  const safe = trackerId.replace(/[^A-Za-z0-9._-]/g, '_');
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="drone_${safe}_images.zip"`,
    'Cache-Control': 'no-store',
  });
  res.send(buildZip(files));
});

// =====================================================================
// API 1:  POST /api/data
// =====================================================================
// Accepts three kinds of body:
//
//   A) form-data:  text fields TrackerId, Latitude, Longitude, Altitude,
//                  Timestamp  +  a file field "image" (any image format)
//
//   B) raw image file as the body (any image format), details in the URL:
//        POST /api/data?trackerId=CAM-01&lat=23.05&lon=72.52&alt=25&ts=...
//      (this is what the camera board sends)
//
//   C) JSON:  a position  { "TrackerId", "Latitude", "Longitude", ... }
//             or a dashboard setting  { "intervalMs": 10000 } / { "action": "reset" }
//
// Every reply includes the current delay, which the devices use as their
// next transmission interval.
const formUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 20 },
});

function readBody(req, res, next) {
  if (req.is('multipart/form-data')) return formUpload.any()(req, res, next);
  return express.raw({ type: () => true, limit: MAX_IMAGE_BYTES })(req, res, next);
}

app.post('/api/data', readBody, (req, res) => {
  // ---- A) form-data ----
  if (req.is('multipart/form-data')) {
    const fields = req.body || {};
    const file = (req.files || [])[0];
    let image = null;
    if (file) {
      const mime = resolveImageType(file.buffer, file.mimetype, file.originalname);
      if (!mime) {
        return res.status(400).json({ status: 'error', message: `"${file.originalname}" is not an image file` });
      }
      image = { buffer: file.buffer, mime, originalName: file.originalname };
    } else if (fields.intervalMs !== undefined || fields.action !== undefined) {
      return handleSetting(fields, res);
    }
    const result = storeReport(fields, image);
    if (result.error) return res.status(400).json({ status: 'error', message: result.error });
    return res.json({ status: 'ok', intervalMs: config.intervalMs, photoId: result.photo ? result.photo.id : null });
  }

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (body.length === 0) {
    return res.status(400).json({ status: 'error', message: 'empty body — send JSON, form-data or an image file' });
  }

  // ---- C) JSON ----
  const isImageBytes = !!sniffImageType(body);
  const looksLikeJson = /^\s*[{[]/.test(body.toString('utf8', 0, 16));
  if (!isImageBytes && (looksLikeJson || req.is('application/json'))) {
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch (err) {
      return res.status(400).json({ status: 'error', message: 'invalid JSON' });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ status: 'error', message: 'JSON body must be an object' });
    }
    if (data.Image !== undefined || data.image !== undefined) {
      return res.status(400).json({
        status: 'error',
        message: 'images are not accepted inside JSON — send the image file as form-data or as the raw request body',
      });
    }
    const hasCoords = pick(data, 'Latitude', 'latitude', 'lat') !== undefined ||
                      pick(data, 'Longitude', 'longitude', 'lon', 'lng') !== undefined;
    if (!hasCoords && (data.intervalMs !== undefined || data.action !== undefined)) {
      return handleSetting(data, res);
    }
    const result = storeReport(data, null);
    if (result.error) return res.status(400).json({ status: 'error', message: result.error });
    return res.json({ status: 'ok', intervalMs: config.intervalMs, photoId: null });
  }

  // ---- B) raw image file ----
  const mime = resolveImageType(body, req.get('Content-Type'), req.query.filename);
  if (!mime) {
    return res.status(400).json({
      status: 'error',
      message: 'body is not an image — send JSON, form-data, or an image file with Content-Type image/...',
    });
  }
  const result = storeReport(req.query, { buffer: body, mime, originalName: req.query.filename || null });
  if (result.error) return res.status(400).json({ status: 'error', message: result.error });
  res.json({ status: 'ok', intervalMs: config.intervalMs, photoId: result.photo.id });
});

// =====================================================================
// API 2:  GET /api/data/<TrackerId>
// =====================================================================
//   GET /api/data/<TrackerId>                  that tracker's data: latest point/photo, all its points and images
//   GET /api/data/<TrackerId>?since=<seq>      same, but only points newer than <seq>
//   GET /api/data/<TrackerId>?photo=<photoId>  one of its images, exactly as uploaded
//   GET /api/data/<TrackerId>?photo=latest     its newest image
//
// Leaving out <TrackerId> (GET /api/data) returns all trackers together;
// the live map uses that to show every drone at once.
app.get('/api/data/:trackerId?', (req, res) => {
  const trackerId = req.params.trackerId;
  const mine = x => trackerId === undefined || sameTracker(x.trackerId, trackerId);
  const myPoints = trackerId === undefined ? history : history.filter(mine);
  const myPhotos = trackerId === undefined ? photos : photos.filter(mine);

  if (trackerId !== undefined && myPoints.length === 0 && myPhotos.length === 0) {
    return res.status(404).json({
      status: 'error',
      message: `no data for tracker "${trackerId}"`,
      trackers: trackerList(),
    });
  }

  if (req.query.photo !== undefined) {
    const id = String(req.query.photo);
    const p = id === 'latest' ? myPhotos[myPhotos.length - 1] : myPhotos.find(x => x.id === id);
    if (!p) {
      return res.status(404).json({
        status: 'error',
        message: trackerId === undefined
          ? 'image not found (it may have been cleared)'
          : `image not found for tracker "${trackerId}"`,
      });
    }
    const downloadName = p.originalName || p.file;
    res.set({
      'Content-Type': p.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"`,
      // A given photo id never changes, so browsers may cache it; "latest" may not.
      'Cache-Control': id === 'latest' ? 'no-store' : 'public, max-age=86400',
    });
    return res.sendFile(path.join(UPLOAD_DIR, p.file), err => {
      if (err && !res.headersSent) res.status(404).json({ status: 'error', message: 'image file missing on disk' });
    });
  }

  const since = Number(req.query.since);
  const points = Number.isFinite(since) ? myPoints.filter(p => p.seq > since) : myPoints;
  const latest = myPoints[myPoints.length - 1] || null;

  // Tracking sessions: for one tracker all of them; for all trackers the latest one each.
  const extra = { offlineAfterMs: offlineAfterMs() };
  if (trackerId !== undefined) {
    extra.sessions = sessionsOf(trackerId, myPoints);
    extra.session = extra.sessions[extra.sessions.length - 1] || null;
  } else {
    extra.trackerStatus = trackerList().map(id => {
      const list = sessionsOf(id, history.filter(p => sameTracker(p.trackerId, id)));
      return { trackerId: id, session: list[list.length - 1] || null };
    });
  }

  res.set('Cache-Control', 'no-store').json({
    ...extra,
    status: 'ok',
    trackerId: trackerId === undefined ? null : (latest || myPhotos[0]).trackerId,
    trackers: trackerList(),
    intervalMs: config.intervalMs,
    serverTime: new Date().toISOString(),
    generation,
    seq,
    pointCount: myPoints.length,
    photoCount: myPhotos.length,
    latest: latest && withPhotoUrl(latest),
    latestPhoto: photoMeta(myPhotos[myPhotos.length - 1]),
    points: points.map(withPhotoUrl),
    // Every stored image (oldest first), including those sent without a GPS fix.
    photos: myPhotos.map(photoMeta),
  });
});

// =====================================================================
// HEALTH:  GET /health
// =====================================================================
const startedAt = new Date().toISOString();

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    status: 'ok',
    success: true,
    message: 'Drone Tag API is running',
    startedAt,
    serverTime: new Date().toISOString(),
  });
});

// =====================================================================
// TELEMETRY:  POST /api/telemetry,  GET /api/telemetry/<TrackerId>
// =====================================================================
const FLIGHT_STATUSES = ['IDLE', 'ARMED', 'TAKING_OFF', 'FLYING', 'HOVERING', 'RETURNING', 'LANDING', 'LANDED', 'ERROR'];
const SPRAY_STATUSES = ['OFF', 'ON', 'PAUSED', 'TANK_EMPTY', 'ERROR'];

// Field name (as sent) → { key: stored name, min, max } for numeric telemetry.
const TELEMETRY_NUMBERS = {
  BatteryPercent: { min: 0, max: 100 },        // %
  BatteryVoltage: { min: 0, max: 100 },        // volts
  TankLevelPercent: { min: 0, max: 100 },      // %
  FlowRateLpm: { min: 0, max: 1000 },          // litres per minute
  SpeedMps: { min: 0, max: 200 },              // metres per second
  HeadingDeg: { min: 0, max: 360 },            // degrees, 0 = north
  Satellites: { min: 0, max: 100, integer: true },
  SignalDbm: { min: -150, max: 0 },            // modem signal strength
};
const TRACKER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KNOWN_TELEMETRY_KEYS = new Set([
  'trackerid', 'id', 'timestamp', 'ts', 'time', 'latitude', 'lat', 'longitude', 'lon', 'lng',
  'altitude', 'alt', 'flightstatus', 'spraystatus', 'extra',
  ...Object.keys(TELEMETRY_NUMBERS).map(k => k.toLowerCase()),
]);

// Accepts "BatteryPercent", "batteryPercent" or "battery_percent".
function pickField(data, name) {
  const want = name.toLowerCase();
  for (const key of Object.keys(data)) {
    if (key.toLowerCase().replace(/_/g, '') === want && data[key] !== '' && data[key] !== null) return data[key];
  }
  return undefined;
}

function validateTelemetry(data) {
  const errors = [];
  const record = {};

  const trackerId = pickField(data, 'TrackerId') ?? pickField(data, 'id');
  if (typeof trackerId !== 'string' || !TRACKER_ID_RE.test(trackerId)) {
    errors.push('TrackerId is required: 1-64 letters, digits, ".", "_" or "-"');
  } else {
    record.trackerId = trackerId;
  }

  const timestamp = pickField(data, 'Timestamp') ?? pickField(data, 'ts');
  if (timestamp !== undefined) {
    if (typeof timestamp !== 'string' && typeof timestamp !== 'number') errors.push('Timestamp must be a string or number');
    else if (String(timestamp).length > 40) errors.push('Timestamp is too long (max 40 characters)');
    else record.timestamp = String(timestamp);
  }

  let measured = 0;
  for (const [name, rule] of Object.entries(TELEMETRY_NUMBERS)) {
    const raw = pickField(data, name);
    if (raw === undefined) continue;
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
      errors.push(`${name} must be ${rule.integer ? 'a whole number' : 'a number'} between ${rule.min} and ${rule.max}`);
    } else {
      record[name.charAt(0).toLowerCase() + name.slice(1)] = n;
      measured++;
    }
  }

  for (const [name, allowed] of [['FlightStatus', FLIGHT_STATUSES], ['SprayStatus', SPRAY_STATUSES]]) {
    const raw = pickField(data, name);
    if (raw === undefined) continue;
    const value = String(raw).trim().toUpperCase();
    if (!allowed.includes(value)) errors.push(`${name} must be one of ${allowed.join(', ')}`);
    else {
      record[name.charAt(0).toLowerCase() + name.slice(1)] = value;
      measured++;
    }
  }

  // Optional position: both coordinates or none.
  const latRaw = pickField(data, 'Latitude') ?? pickField(data, 'lat');
  const lonRaw = pickField(data, 'Longitude') ?? pickField(data, 'lon') ?? pickField(data, 'lng');
  if (latRaw !== undefined || lonRaw !== undefined) {
    const lat = parseCoord(latRaw);
    const lon = parseCoord(lonRaw);
    if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push('Latitude (-90..90) and Longitude (-180..180) must both be valid numbers');
    } else if (!(lat === 0 && lon === 0)) {
      record.lat = lat;
      record.lon = lon;
      const alt = formatAltitude(pickField(data, 'Altitude') ?? pickField(data, 'alt'));
      if (alt) record.altitude = alt;
    }
  }

  const extra = pickField(data, 'Extra');
  if (extra !== undefined) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) errors.push('Extra must be an object');
    else {
      const entries = Object.entries(extra);
      const bad = entries.find(([k, v]) =>
        k.length > 40 ||
        !(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 100)));
      if (entries.length > 30) errors.push('Extra may have at most 30 fields');
      else if (bad) errors.push(`Extra.${String(bad[0]).slice(0, 40)} must be a number, boolean or text up to 100 characters`);
      else if (entries.length > 0) {
        record.extra = Object.fromEntries(entries);
        measured++;
      }
    }
  }

  if (errors.length === 0 && measured === 0) {
    errors.push('send at least one telemetry value (e.g. BatteryPercent, FlightStatus, SprayStatus)');
  }
  const ignored = Object.keys(data).filter(k => !KNOWN_TELEMETRY_KEYS.has(k.toLowerCase().replace(/_/g, '')));
  return { errors, record, ignored };
}

app.post('/api/telemetry', express.json({ limit: MAX_JSON_BYTES, strict: true }), (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ status: 'error', message: 'send a JSON object with Content-Type: application/json' });
  }
  const { errors, record, ignored } = validateTelemetry(data);
  if (errors.length > 0) {
    return res.status(400).json({ status: 'error', message: 'invalid telemetry', errors });
  }
  const receivedAt = new Date().toISOString();
  const id = `${Date.now()}-${seq + 1}`;
  const saved = addTelemetry({ id, ...record, receivedAt });
  // A position in the telemetry also moves the drone on the map.
  if (record.lat !== undefined) {
    addPoint({
      trackerId: record.trackerId,
      lat: record.lat,
      lon: record.lon,
      altitude: record.altitude || null,
      timestamp: record.timestamp || null,
      maplink: `https://maps.google.com/?q=${record.lat},${record.lon}`,
      receivedAt,
    });
  }
  console.log(`[${receivedAt}] ${record.trackerId} telemetry` +
    (record.batteryPercent !== undefined ? ` battery ${record.batteryPercent}%` : '') +
    (record.flightStatus ? ` flight ${record.flightStatus}` : '') +
    (record.sprayStatus ? ` spray ${record.sprayStatus}` : ''));
  res.status(201).json({
    status: 'ok',
    intervalMs: config.intervalMs,
    telemetryId: saved.id,
    seq: saved.seq,
    ...(ignored.length ? { ignoredFields: ignored.slice(0, 20) } : {}),
  });
});

//   GET /api/telemetry                       latest telemetry of every tracker
//   GET /api/telemetry/<TrackerId>           that tracker's latest + recent records
//   GET /api/telemetry/<TrackerId>?since=N   only records newer than seq N
//   ...&limit=N                              at most N records (default 100, max 1000)
app.get('/api/telemetry/:trackerId?', (req, res) => {
  const trackerId = req.params.trackerId;
  res.set('Cache-Control', 'no-store');
  if (trackerId === undefined) {
    const latestBy = new Map();
    telemetry.forEach(t => latestBy.set(String(t.trackerId).toLowerCase(), t));
    return res.json({ status: 'ok', serverTime: new Date().toISOString(), seq, latest: [...latestBy.values()] });
  }
  const mine = telemetry.filter(t => sameTracker(t.trackerId, trackerId));
  if (mine.length === 0) {
    return res.status(404).json({ status: 'error', message: `no telemetry for tracker "${trackerId}"`, trackers: trackerList() });
  }
  const since = Number(req.query.since);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const records = (Number.isFinite(since) ? mine.filter(t => t.seq > since) : mine).slice(-limit);
  res.json({
    status: 'ok',
    trackerId: mine[mine.length - 1].trackerId,
    serverTime: new Date().toISOString(),
    seq,
    count: mine.length,
    latest: mine[mine.length - 1],
    records,
  });
});

// =====================================================================
// CONFIGURATION FILES:  POST /api/config,  GET /api/config/<TrackerId>
// =====================================================================
// Text configuration files only (mission plans, parameters, settings).
const CONFIG_TYPES = {
  json: 'application/json', plan: 'application/json', yaml: 'text/yaml', yml: 'text/yaml',
  xml: 'application/xml', csv: 'text/csv', txt: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
  ini: 'text/plain', param: 'text/plain', params: 'text/plain', waypoints: 'text/plain',
};

const configUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CONFIG_BYTES, files: 1, fields: 10 },
});

function readConfigBody(req, res, next) {
  if (req.is('multipart/form-data')) return configUpload.any()(req, res, next);
  return express.raw({ type: () => true, limit: MAX_CONFIG_BYTES })(req, res, next);
}

// Returns an error message, or null when the file is an acceptable text config.
function checkConfigFile(buffer, ext) {
  if (!CONFIG_TYPES[ext]) return `file type ".${ext || '?'}" not allowed; use one of: ${Object.keys(CONFIG_TYPES).map(e => '.' + e).join(' ')}`;
  if (buffer.length === 0) return 'the file is empty';
  if (buffer.includes(0)) return 'the file is not a text file';
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return 'the file is not valid UTF-8 text';
  }
  if (CONFIG_TYPES[ext] === 'application/json') {
    try { JSON.parse(text); } catch { return 'the file is not valid JSON'; }
  }
  return null;
}

app.post('/api/config', readConfigBody, (req, res) => {
  let fields;
  let buffer;
  let originalName;
  if (req.is('multipart/form-data')) {
    fields = req.body || {};
    const file = (req.files || [])[0];
    if (!file) return res.status(400).json({ status: 'error', message: 'attach the configuration file in the form field "file"' });
    buffer = file.buffer;
    originalName = file.originalname;
  } else {
    fields = req.query;
    buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    originalName = typeof req.query.filename === 'string' ? req.query.filename : '';
  }
  const trackerId = pick(fields, 'TrackerId', 'trackerId', 'trackerID', 'id');
  if (typeof trackerId !== 'string' || !TRACKER_ID_RE.test(trackerId)) {
    return res.status(400).json({ status: 'error', message: 'TrackerId is required: 1-64 letters, digits, ".", "_" or "-"' });
  }
  const safeName = path.basename(String(originalName || '')).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100);
  if (!safeName) return res.status(400).json({ status: 'error', message: 'the file name is required (form file name, or ?filename= for a raw body)' });
  const ext = path.extname(safeName).slice(1).toLowerCase();
  const problem = checkConfigFile(buffer, ext);
  if (problem) return res.status(400).json({ status: 'error', message: problem });
  const description = pick(fields, 'Description', 'description');
  if (description !== undefined && (typeof description !== 'string' || description.length > 200)) {
    return res.status(400).json({ status: 'error', message: 'Description must be text up to 200 characters' });
  }

  const receivedAt = new Date().toISOString();
  const id = `${Date.now()}-${seq + 1}`;
  const file = `${id}.${ext}`;
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, file), buffer);
  } catch (err) {
    console.error('Could not store configuration file:', err.message);
    return res.status(500).json({ status: 'error', message: 'the configuration file could not be stored' });
  }
  const saved = addConfig({
    id,
    file,
    trackerId,
    originalName: safeName,
    description: description || null,
    mime: CONFIG_TYPES[ext],
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    receivedAt,
  });
  console.log(`[${receivedAt}] ${trackerId} config ${safeName} ${buffer.length} bytes -> configs/${file}`);
  const { file: _file, ...meta } = saved;
  res.status(201).json({ status: 'ok', intervalMs: config.intervalMs, config: { ...meta, url: configUrl(saved) } });
});

function configUrl(c) {
  return `/api/config/${encodeURIComponent(c.trackerId)}?file=${encodeURIComponent(c.id)}`;
}

//   GET /api/config/<TrackerId>               list that tracker's configuration files
//   GET /api/config/<TrackerId>?file=<id>     download one (?file=latest for the newest)
app.get('/api/config/:trackerId', (req, res) => {
  const mine = configs.filter(c => sameTracker(c.trackerId, req.params.trackerId));
  if (req.query.file !== undefined) {
    const id = String(req.query.file);
    const c = id === 'latest' ? mine[mine.length - 1] : mine.find(x => x.id === id);
    if (!c) return res.status(404).json({ status: 'error', message: 'configuration file not found' });
    res.set({
      'Content-Type': `${c.mime}; charset=utf-8`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${c.originalName.replace(/["\\\r\n]/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
    return res.sendFile(path.join(CONFIG_DIR, c.file), err => {
      if (err && !res.headersSent) res.status(404).json({ status: 'error', message: 'configuration file missing on disk' });
    });
  }
  res.set('Cache-Control', 'no-store').json({
    status: 'ok',
    trackerId: req.params.trackerId,
    count: mine.length,
    configs: mine.map(({ file, ...meta }) => ({ ...meta, url: configUrl(meta) })),
  });
});

// Any other /api/... path: list the real endpoints.
app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Unknown endpoint. Endpoints: POST /api/data, GET /api/data/<TrackerId>, POST /api/telemetry, ' +
      'GET /api/telemetry/<TrackerId>, POST /api/config, GET /api/config/<TrackerId>, GET /health',
  });
});

// Oversized uploads and bad JSON land here instead of crashing with an HTML error page.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE')) {
    const max = req.path.startsWith('/api/config')
      ? `configuration file too large (max ${MAX_CONFIG_BYTES / 1024 / 1024} MB)`
      : req.path.startsWith('/api/telemetry')
        ? `JSON body too large (max ${MAX_JSON_BYTES / 1024 / 1024} MB)`
        : `image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`;
    return res.status(413).json({ status: 'error', message: max });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 'error', message: 'invalid JSON' });
  }
  // The device dropped the connection mid-upload (common on weak mobile signal).
  if (err && (err.message === 'Request aborted' || err.type === 'request.aborted' || err.code === 'ECONNABORTED')) {
    console.warn(`[${new Date().toISOString()}] upload aborted by the client: ${req.method} ${req.path}`);
    if (!res.headersSent) res.status(400).end();
    return;
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ status: 'error', message: `form-data error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ status: 'error', message: 'server error' });
});

function start(port = PORT) {
  return app.listen(port, '0.0.0.0', () => {
    console.log(`Drone Tag server listening on http://0.0.0.0:${port}`);
    console.log(`Dashboard: http://localhost:${port}   Health: http://localhost:${port}/health`);
    console.log(`Data is saved in: ${UPLOAD_DIR}`);
    console.log(`Current tracker delay: ${config.intervalMs} ms`);
  });
}

if (require.main === module) start();

module.exports = { app, start };
