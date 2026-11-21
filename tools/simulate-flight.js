// Sends a simulated flight to the local server, so the "Distance flown" panel
// can be checked without a real drone.
//
//   node tools/simulate-flight.js                          lawn-mower spraying flight (default)
//   node tools/simulate-flight.js --pattern erratic        sharp zig-zags, then a long run east
//   node tools/simulate-flight.js --tracker DEMO-02 --interval 1 --url http://localhost:4000
//
// lawnmower: 4 passes of 150 m, 25 m apart, a hover with GPS wobble and one
//            bad GPS fix 400 m away. Real path: 675 m. Sent live, one upload per interval.
// erratic:   the shape of a messy test flight (tight back-and-forth legs of up to
//            330 m, then a long run to the end point). Real path: about 3.7 km.
//            Each upload carries the device time a drone flying 8 m/s would
//            have, so the speeds are realistic even though it is sent quickly.
//
// The script prints the real path length next to what the server calculated.

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const URL_BASE = (args.url || 'http://localhost:4000').replace(/\/$/, '');
const PATTERN = args.pattern || 'lawnmower';
const TRACKER = args.tracker || (PATTERN === 'erratic' ? 'DEMO-02' : 'DEMO-01');
const INTERVAL_S = Number(args.interval || (PATTERN === 'erratic' ? 1 : 2));   // seconds between uploads
const START = { lat: Number(args.lat || 23.0300), lon: Number(args.lon || 72.5800) };
const SPEED_MPS = 8;                                  // erratic: the simulated drone's speed

const M_PER_DEG_LAT = 111195;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(START.lat * Math.PI / 180);
const toLatLon = (east, north) => ({ lat: START.lat + north / M_PER_DEG_LAT, lon: START.lon + east / M_PER_DEG_LON });

// Positions in metres east / north of the start, one per upload.
// `noise` lists uploads that are GPS errors (hover wobble, bad fixes), not real movement.
function lawnmower() {
  const route = [[0, 0]];
  const noise = [];
  const PASS_M = 150, GAP_M = 25, STEP_M = 10;
  for (let pass = 0; pass < 4; pass++) {
    const north = pass * GAP_M;
    if (pass > 0) route.push([pass % 2 ? PASS_M : 0, north]);                    // move 25 m north
    for (let e = STEP_M; e <= PASS_M; e += STEP_M) route.push([pass % 2 ? PASS_M - e : e, north]);
    if (pass === 1) {
      // Hovering: 8 uploads wobbling by about a metre (should add no distance).
      for (let i = 0; i < 8; i++) {
        noise.push(route.length);
        route.push([Math.sin(i * 2.1) * 1.2, north + Math.cos(i * 1.7) * 1.2]);
      }
    }
  }
  route.splice(30, 0, [route[29][0] + 400, route[29][1] + 150]);                // one bad GPS fix
  return { route, noise: [30, ...noise.map(i => (i >= 30 ? i + 1 : i))], realTime: false };
}

function erratic() {
  // Points traced from a dashboard screenshot (pixels, 1 px = 1 m), in flight order.
  const PX = [[530, 410], [455, 402], [430, 402], [347, 329], [415, 383], [382, 290], [475, 390], [377, 239],
    [500, 384], [428, 267], [452, 280], [458, 286], [471, 262], [510, 290], [463, 210], [553, 312], [434, 151],
    [607, 312], [456, 127], [611, 348], [448, 99], [584, 257], [561, 229], [564, 228], [457, 67], [662, 326],
    [808, 317], [907, 255], [940, 228]];
  return { route: PX.map(([x, y]) => [x - PX[0][0], PX[0][1] - y]), noise: [], realTime: true };
}

const { route, noise, realTime } = PATTERN === 'erratic' ? erratic() : lawnmower();
if (PATTERN !== 'erratic' && PATTERN !== 'lawnmower') {
  console.error('Unknown --pattern (use lawnmower or erratic)');
  process.exit(1);
}

// The real path length: straight lines between the real positions (GPS noise left out).
const real = route.filter((_, i) => !noise.includes(i));
let EXPECTED_M = 0;
for (let i = 1; i < real.length; i++) EXPECTED_M += Math.hypot(real[i][0] - real[i - 1][0], real[i][1] - real[i - 1][1]);

// Device times. Live (lawnmower): now. erratic: when a drone flying SPEED_MPS
// would have been at each point, for a flight that ends now.
const flightMs = [0];
for (let i = 1; i < route.length; i++) {
  flightMs.push(flightMs[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]) / SPEED_MPS * 1000);
}

// Device time in IST "YYYY-MM-DD HH:MM:SS", as the drone tags send it.
const istStamp = ms => new Date(ms + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const sendMs = route.length * INTERVAL_S * 1000;
  const flightStart = Date.now() + sendMs - flightMs[flightMs.length - 1];
  console.log(`Sending ${route.length} positions (${PATTERN}) for ${TRACKER} to ${URL_BASE}/api/data, one every ${INTERVAL_S} s.`);
  console.log(`Open the dashboard: ${URL_BASE}/drone?tracker=${TRACKER}`);
  for (let i = 0; i < route.length; i++) {
    const { lat, lon } = toLatLon(...route[i]);
    const body = {
      TrackerId: TRACKER,
      Latitude: lat.toFixed(7),
      Longitude: lon.toFixed(7),
      Altitude: '12',
      Timestamp: istStamp(realTime ? Math.min(Date.now(), flightStart + flightMs[i]) : Date.now()),
    };
    try {
      const res = await fetch(`${URL_BASE}/api/data`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      process.stdout.write(`\r${i + 1}/${route.length} sent (HTTP ${res.status})   `);
    } catch (err) {
      console.error(`\nCould not reach ${URL_BASE}. Is the server running?`, err.message);
      process.exit(1);
    }
    if (i < route.length - 1) await sleep(INTERVAL_S * 1000);
  }
  const data = await (await fetch(`${URL_BASE}/api/data/${encodeURIComponent(TRACKER)}`)).json();
  const d = data.session && data.session.distance;
  console.log('\n');
  console.log(`Real path length:           ${Math.round(EXPECTED_M)} m`);
  if (d) {
    console.log(`Server says distance flown: ${d.flownM} m  (ignored ${d.ignoredSmallMoves} wobbles, ${d.ignoredJumps} bad fixes)`);
    console.log(`Straight line start → end:  ${d.straightLineM} m`);
    console.log(`Start–end box (2 sides):    ${d.startEndBox.alongSidesM} m`);
    console.log(`Flight area box:            ${d.areaBox.widthM} m × ${d.areaBox.heightM} m`);
  }
})();
