// Shared helpers for every Drone Tag page: header + user menu, IST time, JSON API calls.
(function () {
  const IST_FORMAT = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  // ISO / Date -> "30-10-2026 15:42:07 IST"
  function ist(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '–';
    const p = Object.fromEntries(IST_FORMAT.formatToParts(d).map(x => [x.type, x.value]));
    return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second} IST`;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    let body = {};
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401 && options.redirectOn401 !== false && !location.pathname.startsWith('/login')) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    }
    return { ok: res.ok, status: res.status, body };
  }

  function setStatus(el, message, kind = 'info') {
    if (!el) return;
    el.textContent = message || '';
    el.className = message ? `status ${kind}` : 'hidden';
  }

  // Header: brand, navigation and (when signed in) the user menu.
  async function header(active) {
    const host = document.getElementById('app-header');
    if (!host) return null;
    const me = await api('/auth/me', { redirectOn401: false });
    const user = me.ok ? me.body.user : null;
    const link = (href, label, key) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
    host.innerHTML = `
      <header class="topbar"><div class="inner">
        <a class="brand" href="/"><img src="/images/logo.png" alt="Abhyuday logo">
          <span><b>DRONE TAG</b><small>Abhyuday Bharat · live drone tracking</small></span></a>
        <nav class="nav">
          ${user ? link('/', 'Live map', 'map') + link('/drone', 'Drone dashboard', 'drone') : ''}
          ${link('/help', 'Help', 'help')}${link('/about', 'About', 'about')}
          ${user ? '' : link('/login', 'Log in', 'login') + link('/register', 'Register', 'register')}
        </nav>
        ${user ? `
        <div class="user-menu">
          <button class="user-btn" id="user-btn" aria-haspopup="true" aria-expanded="false">
            <span class="avatar">${esc(user.name.charAt(0).toUpperCase())}</span><span>${esc(user.name.split(' ')[0])}</span>
          </button>
          <div class="menu" id="user-menu" role="menu">
            <div class="who"><b>${esc(user.name)}</b>Tracker ${esc(user.drone.trackerId)}</div>
            <a href="/drone?tracker=${encodeURIComponent(user.drone.trackerId)}">My drone</a>
            <a href="/account">Your account</a>
            <a href="/settings">Settings</a>
            <a href="/support">Support</a>
            <button id="logout-btn">Log out</button>
          </div>
        </div>` : ''}
      </div></header>`;
    if (user) {
      const btn = document.getElementById('user-btn');
      const menu = document.getElementById('user-menu');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', () => { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); });
      document.getElementById('logout-btn').addEventListener('click', async () => {
        await api('/auth/logout', { method: 'POST' });
        location.href = '/login';
      });
    }
    return user;
  }

  // Map tiles: street map + satellite, switchable.
  function baseLayers(map) {
    const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery &copy; Esri',
    });
    street.addTo(map);
    L.control.layers({ 'Street map': street, Satellite: satellite }, null, { position: 'topright' }).addTo(map);
  }

  // A redirect target from ?next=, only to a page on this site.
  function safeNext(fallback = '/') {
    const next = new URLSearchParams(location.search).get('next') || '';
    return next.startsWith('/') && !next.startsWith('//') ? next : fallback;
  }

  window.DT = { ist, esc, api, setStatus, header, baseLayers, safeNext };
})();
