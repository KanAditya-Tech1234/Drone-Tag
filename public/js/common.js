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

  // When a point/image was recorded: the device time when the server could trust it, else arrival.
  const recTime = x => x.recordedAt || x.receivedAt;

  // ISO -> { date: "2026-10-30", time: "15:42:07" } in IST, for the date / time filters.
  function istParts(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(IST_FORMAT.formatToParts(d).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
  }

  // Filter { date: "YYYY-MM-DD" | "", from: "HH:MM" | "", to: "HH:MM" | "" } on IST time.
  // "to" includes its whole minute (10:30 keeps 10:30:59).
  function matchesFilter(value, f) {
    const p = istParts(value);
    if (!p) return false;
    if (f.date && p.date !== f.date) return false;
    if (f.from && p.time < f.from + ':00') return false;
    if (f.to && p.time > f.to + ':59') return false;
    return true;
  }

  // 5000 -> "5 seconds", 120000 -> "2 minutes", 90000 -> "90 seconds"
  function formatInterval(ms) {
    const s = Math.round(ms / 1000);
    if (s >= 60 && s % 60 === 0) return `${s / 60} minute${s === 60 ? '' : 's'}`;
    return `${s} second${s === 1 ? '' : 's'}`;
  }

  // Image viewer shared by the pages: DT.lightbox().open(url, caption)
  let box = null;
  function lightbox() {
    if (box) return box;
    const el = document.createElement('div');
    el.className = 'lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Image');
    el.innerHTML = `<img alt="Drone image"><div class="cap"></div>
      <div class="row"><a class="btn btn-accent" target="_blank" rel="noopener">Open original</a><button class="btn btn-outline" type="button">Close</button></div>`;
    document.body.appendChild(el);
    const close = () => { el.classList.remove('open'); el.querySelector('img').removeAttribute('src'); };
    el.querySelector('button').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    box = {
      open(url, caption) {
        el.querySelector('img').src = url;
        el.querySelector('a').href = url;
        el.querySelector('.cap').textContent = caption || '';
        el.classList.add('open');
      },
      close,
    };
    return box;
  }

  // ---------------------------------------------------------------------
  // Drone navigation bar (drone dashboard, All Images, All Data):
  // drone selector, links between the three pages, Transmission interval setting.
  //   const bar = DT.droneBar(host, { trackerId, active: 'dashboard' | 'images' | 'data', onSelect })
  //   bar.setTrackers(ids)   adds Tracker IDs to the selector (registered drones are added by itself)
  //   bar.setTracker(id)     shows another drone (dashboard only; the other pages reload)
  // ---------------------------------------------------------------------
  const PRESETS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const pageUrl = (path, id) => `${path}?tracker=${encodeURIComponent(id)}`;

  function droneBar(host, { trackerId = '', active = 'dashboard', onSelect } = {}) {
    let current = trackerId;
    const known = new Map();   // lower-case id -> id
    host.innerHTML = `
      <div class="drone-bar">
        <label class="drone-pick"><span>Drone</span>
          <select aria-label="Choose a drone"><option value="">Choose a drone…</option></select></label>
        <nav class="drone-tabs" aria-label="Drone pages">
          <a data-page="dashboard" href="#">Dashboard</a>
          <a data-page="images" href="#">All Images</a>
          <a data-page="data" href="#">All Data</a>
        </nav>
        <button class="btn btn-accent interval-btn" type="button" disabled>Transmission interval</button>
      </div>
      <dialog class="modal" aria-labelledby="iv-title">
        <form method="dialog" class="form-grid">
          <h2 id="iv-title" style="margin:0">Transmission interval</h2>
          <p class="muted iv-for" style="margin:0"></p>
          <label class="field">Send data every
            <select class="iv-preset">${PRESETS.map(s => `<option value="${s}">${formatInterval(s * 1000)}</option>`).join('')}
              <option value="custom">Custom…</option></select></label>
          <label class="field iv-custom hidden">Seconds (1 to 300)
            <input type="number" min="1" max="300" step="1" inputmode="numeric"></label>
          <p class="muted iv-note" style="margin:0;font-size:13px"></p>
          <div class="hidden" data-role="iv-status"></div>
          <div class="actions">
            <button class="btn btn-primary iv-save" type="button">Save</button>
            <button class="btn btn-outline iv-default" type="button">Use default</button>
            <button class="btn btn-outline iv-close" type="button">Close</button>
          </div>
        </form>
      </dialog>`;
    const select = host.querySelector('.drone-pick select');
    const intervalBtn = host.querySelector('.interval-btn');
    const dialog = host.querySelector('dialog');
    const q = s => dialog.querySelector(s);
    const ivStatus = q('[data-role="iv-status"]');   // setStatus() replaces the class, so keep the element
    let info = null;

    function links() {
      host.querySelectorAll('.drone-tabs a').forEach(a => {
        const path = { dashboard: '/drone', images: '/images', data: '/data' }[a.dataset.page];
        a.href = current ? pageUrl(path, current) : path;
        a.classList.toggle('active', a.dataset.page === active);
        a.setAttribute('aria-current', a.dataset.page === active ? 'page' : 'false');
      });
      intervalBtn.disabled = !current;
    }
    function fillSelect() {
      if (current) known.set(current.toLowerCase(), known.get(current.toLowerCase()) || current);
      const ids = [...known.values()].sort((a, b) => a.localeCompare(b));
      const html = '<option value="">Choose a drone…</option>' + ids.map(id => `<option>${esc(id)}</option>`).join('');
      if (select.innerHTML !== html) select.innerHTML = html;
      const match = ids.find(id => id.toLowerCase() === current.toLowerCase());
      select.value = match || '';
    }
    async function loadInterval() {
      info = null;
      if (!current) { intervalBtn.textContent = 'Transmission interval'; return; }
      const res = await api('/api/interval/' + encodeURIComponent(current));
      if (!res.ok) { intervalBtn.textContent = 'Transmission interval'; return; }
      info = res.body;
      intervalBtn.textContent = `Transmission interval: ${formatInterval(info.intervalMs)}`;
    }
    function showDialogValue(ms) {
      const s = Math.round(ms / 1000);
      q('.iv-preset').value = PRESETS.includes(s) ? String(s) : 'custom';
      q('.iv-custom input').value = s;
      q('.iv-custom').classList.toggle('hidden', PRESETS.includes(s));
    }
    function describe() {
      q('.iv-for').textContent = `Drone ${current}: currently every ${formatInterval(info.intervalMs)}` +
        (info.custom ? ' (its own setting).' : ' (the default for all drones).');
      q('.iv-note').textContent = `The drone switches to the new interval after its next upload. ` +
        `Default for drones without their own setting: ${formatInterval(info.defaultIntervalMs)}.`;
      q('.iv-default').disabled = !info.custom;
    }
    async function save(intervalMs) {
      const status = ivStatus;
      setStatus(status, 'Saving…', 'info');
      const res = await api('/api/interval/' + encodeURIComponent(current), { method: 'PUT', body: JSON.stringify({ intervalMs }) });
      if (!res.ok) {
        setStatus(status, (res.body && res.body.message) ? `Not saved: ${res.body.message}` : 'Not saved. Check your connection and try again.', 'err');
        return;
      }
      info = res.body;
      intervalBtn.textContent = `Transmission interval: ${formatInterval(info.intervalMs)}`;
      showDialogValue(info.intervalMs);
      describe();
      setStatus(status, intervalMs === null
        ? `Saved. ${current} now uses the default (${formatInterval(info.intervalMs)}).`
        : `Saved. ${current} will send every ${formatInterval(info.intervalMs)}.`, 'ok');
    }

    select.addEventListener('change', () => {
      const id = select.value;
      if (!id || id.toLowerCase() === current.toLowerCase()) return;
      if (onSelect) onSelect(id);
      else location.href = pageUrl({ dashboard: '/drone', images: '/images', data: '/data' }[active], id);
    });
    intervalBtn.addEventListener('click', async () => {
      if (!info) await loadInterval();
      if (!info) return;
      showDialogValue(info.intervalMs);
      describe();
      setStatus(ivStatus, '');
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    });
    q('.iv-preset').addEventListener('change', () => {
      q('.iv-custom').classList.toggle('hidden', q('.iv-preset').value !== 'custom');
    });
    q('.iv-save').addEventListener('click', () => {
      const preset = q('.iv-preset').value;
      const seconds = preset === 'custom' ? Number(q('.iv-custom input').value) : Number(preset);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
        setStatus(ivStatus, 'Enter a whole number of seconds from 1 to 300.', 'err');
        return;
      }
      save(seconds * 1000);
    });
    q('.iv-default').addEventListener('click', () => save(null));
    q('.iv-close').addEventListener('click', () => dialog.close());

    // Registered drones are always in the selector, even before they send anything.
    api('/api/drones').then(res => {
      if (res.ok) res.body.drones.forEach(d => known.set(d.trackerId.toLowerCase(), d.trackerId));
      fillSelect();
    });
    links();
    fillSelect();
    loadInterval();

    return {
      setTrackers(ids) {
        (ids || []).forEach(id => { if (!known.has(String(id).toLowerCase())) known.set(String(id).toLowerCase(), String(id)); });
        fillSelect();
      },
      setTracker(id) {
        current = id;
        links();
        fillSelect();
        loadInterval();
      },
    };
  }

  // Date / time filter (IST) for the All Images and All Data pages.
  // onApply(filter) gets { date, from, to } ('' = not set) after Apply / Reset.
  function filterBar(host, onApply) {
    host.innerHTML = `
      <form class="actions filter-bar" novalidate>
        <label class="field grow">Date <input type="date" name="date"></label>
        <label class="field grow">From time <input type="time" name="from"></label>
        <label class="field grow">To time <input type="time" name="to"></label>
        <button class="btn btn-primary" type="submit">Apply filter</button>
        <button class="btn btn-outline" type="reset">Reset</button>
      </form>
      <div class="hidden" data-role="filter-msg" style="margin-top:10px"></div>`;
    const form = host.querySelector('form');
    const msg = host.querySelector('[data-role="filter-msg"]');
    const read = () => ({ date: form.elements.date.value, from: form.elements.from.value, to: form.elements.to.value });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = read();
      if (f.from && f.to && f.from > f.to) return setStatus(msg, '"From time" must be before "To time".', 'err');
      setStatus(msg, '');
      onApply(f);
    });
    form.addEventListener('reset', () => { setTimeout(() => { setStatus(msg, ''); onApply(read()); }); });
    return { get: read };
  }

  // A redirect target from ?next=, only to a page on this site.
  function safeNext(fallback = '/') {
    const next = new URLSearchParams(location.search).get('next') || '';
    return next.startsWith('/') && !next.startsWith('//') ? next : fallback;
  }

  window.DT = {
    ist, esc, api, setStatus, header, baseLayers, markers, legend, mapPopup, safeNext,
    recTime, istParts, matchesFilter, formatInterval, lightbox, droneBar, filterBar,
  };
})();
