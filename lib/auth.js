// Dashboard accounts: each user registers once with their drone (Tracker ID + details).
// Accounts protect the web dashboard only. Devices keep sending to POST /api/data without
// any login, and GET /api/data stays open for the Abhyuday Bharat backend.
//
// Storage: <DATA_DIR>/users.json (passwords as scrypt hashes, never plain text).
// Sessions: a signed, HttpOnly cookie (HMAC with SESSION_SECRET).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'dt_session';
const SESSION_DAYS = 7;

const CATEGORIES = ['Nano', 'Micro', 'Small', 'Medium', 'Large'];
const APPLICATIONS = ['Agriculture', 'Spraying', 'Surveillance', 'Mapping', 'Photography', 'Delivery', 'Other'];
const AUTONOMY = ['Manual', 'Partially Autonomous', 'Fully Autonomous'];
const RANGES = ['Close', 'Short', 'Mid', 'Long'];
const TRACKER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function createAuth({ dataDir, writeJsonAtomic }) {
  const usersPath = path.join(dataDir, 'users.json');
  // Without SESSION_SECRET every restart signs everyone out (fine for testing).
  const secret = (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
  let users = [];
  try {
    const saved = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    if (Array.isArray(saved)) users = saved;
  } catch (err) { /* no accounts yet */ }

  const save = () => writeJsonAtomic(usersPath, users);
  const sameTag = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  /* ---------- passwords ---------- */
  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
  }
  function checkPassword(password, stored) {
    const [kind, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }

  /* ---------- validation ---------- */
  const text = v => (typeof v === 'string' ? v.trim() : '');
  function validateProfile(body, { partial = false, exceptId = null } = {}) {
    const errors = {};
    const out = {};
    const want = key => !partial || body[key] !== undefined;

    if (want('name')) {
      const name = text(body.name).replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 60 || /[<>{}]/.test(name)) errors.name = 'Enter your name (2–60 characters)';
      else out.name = name;
    }
    if (want('email')) {
      const email = text(body.email).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) errors.email = 'Enter a valid email address';
      else if (users.some(u => u.email === email && u.id !== exceptId)) errors.email = 'This email is already registered';
      else out.email = email;
    }
    if (want('phone')) {
      const phone = text(body.phone).replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
      if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a 10-digit Indian mobile number';
      else if (users.some(u => u.phone === phone && u.id !== exceptId)) errors.phone = 'This mobile number is already registered';
      else out.phone = phone;
    }
    if (want('password') && !(partial && text(body.password) === '')) {
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 8 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
        errors.password = 'Use at least 8 characters with an uppercase letter, a lowercase letter and a number';
      } else out.password = password;
    }
    if (want('trackerId')) {
      const trackerId = text(body.trackerId);
      if (!TRACKER_ID_RE.test(trackerId)) errors.trackerId = 'Tracker ID: 1–64 letters, numbers, ".", "_" or "-"';
      else if (users.some(u => sameTag(u.drone.trackerId, trackerId) && u.id !== exceptId)) errors.trackerId = 'This Tracker ID is already registered';
      else out.trackerId = trackerId;
    }
    if (want('uin')) {
      const uin = text(body.uin).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9/-]{1,38}[A-Z0-9]$/.test(uin)) errors.uin = 'Enter the drone UIN (3–40 letters, numbers, - or /)';
      else out.uin = uin;
    }
    for (const [key, list, label] of [
      ['category', CATEGORIES, 'category'], ['application', APPLICATIONS, 'application'],
      ['autonomy', AUTONOMY, 'autonomy'], ['range', RANGES, 'range'],
    ]) {
      if (!want(key)) continue;
      const value = text(body[key]);
      if (!list.includes(value)) errors[key] = `Choose the drone ${label}`;
      else out[key] = value;
    }
    return { errors, out };
  }

  const publicUser = u => u && ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt, drone: { ...u.drone },
  });

  function register(body) {
    const { errors, out } = validateProfile(body);
    if (Object.keys(errors).length) return { errors };
    const user = {
      id: crypto.randomUUID(),
      name: out.name, email: out.email, phone: out.phone,
      passwordHash: hashPassword(out.password),
      drone: {
        trackerId: out.trackerId, uin: out.uin, category: out.category,
        application: out.application, autonomy: out.autonomy, range: out.range,
      },
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    save();
    return { user };
  }

  function login(phone, password) {
    const normalized = text(phone).replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
    const user = users.find(u => u.phone === normalized);
    // Same work and the same answer whether or not the number exists.
    const ok = checkPassword(password, user ? user.passwordHash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86));
    return ok && user ? user : null;
  }

  function update(user, body) {
    if (!checkPassword(body.currentPassword, user.passwordHash)) {
      return { errors: { currentPassword: 'Your current password is not correct' } };
    }
    const { errors, out } = validateProfile(body, { partial: true, exceptId: user.id });
    if (Object.keys(errors).length) return { errors };
    for (const key of ['name', 'email', 'phone']) if (out[key]) user[key] = out[key];
    if (out.password) user.passwordHash = hashPassword(out.password);
    for (const key of ['trackerId', 'uin', 'category', 'application', 'autonomy', 'range']) {
      if (out[key]) user.drone[key] = out[key];
    }
    user.updatedAt = new Date().toISOString();
    save();
    return { user };
  }

  /* ---------- sessions ---------- */
  const sign = payload => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  function sessionCookie(user, secure) {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const payload = Buffer.from(JSON.stringify({ u: user.id, e: exp })).toString('base64url');
    return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
      (secure ? '; Secure' : '');
  }
  const clearCookie = secure => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

  function userFromRequest(req) {
    const raw = String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='));
    if (!raw) return null;
    const [payload, signature] = raw.slice(COOKIE.length + 1).split('.');
    if (!payload || !signature) return null;
    const expected = sign(payload);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof e !== 'number' || e < Date.now()) return null;
      return users.find(x => x.id === u) || null;
    } catch { return null; }
  }

  /* ---------- login rate limit (per IP, failed attempts) ---------- */
  const failures = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILURES = 10;
  function tooManyFailures(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > WINDOW_MS) return false;
    return f.count >= MAX_FAILURES;
  }
  function recordFailure(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
    else f.count++;
  }
  const clearFailures = ip => failures.delete(ip);

  const droneOf = trackerId => {
    const user = users.find(u => sameTag(u.drone.trackerId, trackerId));
    return user ? { ...user.drone, owner: user.name } : null;
  };
  const drones = () => users.map(u => ({ ...u.drone, owner: u.name }));

  return {
    register, login, update, publicUser, userFromRequest, sessionCookie, clearCookie,
    tooManyFailures, recordFailure, clearFailures, droneOf, drones,
    options: { categories: CATEGORIES, applications: APPLICATIONS, autonomy: AUTONOMY, ranges: RANGES },
  };
}

module.exports = { createAuth };
