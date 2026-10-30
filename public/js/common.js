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

  // Map markers: green pin = start, red pin = end, arrow = live position.
  const PIN_COLORS = { start: '#16a34a', end: '#dc2626' };
  const pinSvg = (color, size = 30) => `
    <svg width="${size}" height="${Math.round(size * 4 / 3)}" viewBox="0 0 30 40" aria-hidden="true">
      <path d="M15 38.5S27.5 23.6 27.5 14a12.5 12.5 0 0 0-25 0c0 9.6 12.5 24.5 12.5 24.5z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      <circle cx="15" cy="14" r="5" fill="#fff"/>
    </svg>`;
  const arrowSvg = (size = 34) => `
    <svg width="${size}" height="${size}" viewBox="0 0 34 34" aria-hidden="true">
      <path d="M17 2.5 30 31 17 24.2 4 31z" fill="#0b3d2e" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
    </svg>`;
  const markers = {
    start: () => L.divIcon({ className: 'map-pin', html: pinSvg(PIN_COLORS.start), iconSize: [30, 40], iconAnchor: [15, 39], popupAnchor: [0, -36] }),
    end: () => L.divIcon({ className: 'map-pin', html: pinSvg(PIN_COLORS.end), iconSize: [30, 40], iconAnchor: [15, 39], popupAnchor: [0, -36] }),
    // headingDeg: 0 = north, clockwise; null shows the arrow pointing north.
    arrow: headingDeg => L.divIcon({
      className: 'map-arrow',
      html: `<div class="arrow-halo"></div><div class="arrow-body" style="transform:rotate(${Math.round(headingDeg || 0)}deg)">${arrowSvg()}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16],
    }),
  };

  // Legend in the bottom-left corner of a map. kinds: any of 'start', 'live', 'end'.
  function legend(map, kinds) {
    const rows = {
      start: [pinSvg(PIN_COLORS.start, 15), 'Start point'],
      end: [pinSvg(PIN_COLORS.end, 15), 'End point'],
      live: [arrowSvg(17), 'Current live drone position'],
    };
    const control = L.control({ position: 'bottomleft' });
    control.onAdd = () => {
      const box = L.DomUtil.create('div', 'map-legend');
      box.innerHTML = '<b>Legend</b>' + kinds.map(k => `<div class="legend-row"><span class="legend-icon">${rows[k][0]}</span>${rows[k][1]}</div>`).join('');
      L.DomEvent.disableClickPropagation(box);
      return box;
    };
    control.addTo(map);
    return control;
  }

  // Popup text on the maps: only the Tracker ID and the date-time (IST).
  function mapPopup(trackerId, iso, extraHtml = '') {
    return `<div class="map-pop"><b>Tracker ID:</b> ${esc(trackerId)}<br><span class="when"><b>Date &amp; time:</b> ${ist(iso)}</span>${extraHtml}</div>`;
  }

  // A redirect target from ?next=, only to a page on this site.
  function safeNext(fallback = '/') {
    const next = new URLSearchParams(location.search).get('next') || '';
    return next.startsWith('/') && !next.startsWith('//') ? next : fallback;
  }

  window.DT = { ist, esc, api, setStatus, header, baseLayers, markers, legend, mapPopup, safeNext };
})();
