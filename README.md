# Drone Live Tracker (server + map + photos)

A Node.js server and web map that receives data from two kinds of device and
shows it live on an OpenStreetMap map. Test it locally first (see
**Run locally** below); hosting on Render comes later.

Images are stored as real files in `uploads/` (any image format, no base64).
GPS points and image details are saved in `uploads/db.json`, so they survive
a server restart.

| Device | Sketch | Sends |
|---|---|---|
| EC200U 4G GPS tracker | `new/new.ino` | GPS position as JSON → `POST /api/data` |
| **Waveshare ESP32-S3-SIM7670G-4G** (camera + GNSS) | `esp32s3_sim7670g/esp32s3_sim7670g.ino` | JPEG photo + GPS → `POST /api/data` |

```
drone-tracker-updated/
├── server.js                 <- receives positions + photos, serves the map and APIs
├── package.json
├── render.yaml               <- Render settings (build/start command, health check)
├── config.json               <- saved transmission delay
├── lib/auth.js               <- dashboard accounts (scrypt hashes, signed session cookie)
├── lib/export.js             <- IST time, CSV and ZIP export
├── views/                    <- pages: login, register, live map, drone dashboard,
│                                account, settings, help, support, about
├── public/                   <- CSS, page script, logo
├── new/new.ino               <- EC200U tracker sketch
├── esp32s3_sim7670g/
│   └── esp32s3_sim7670g.ino  <- Waveshare camera board sketch
└── mobile/App.js             <- Expo (React Native) phone app
```

## Dashboard (login required)

The web pages need an account: open `/register`, enter your details and your
drone (Tracker ID, UIN, category, application, autonomy, range), then log in
with your mobile number and password.

- **Live map** (`/`): every drone at its latest position; click a pin for its
  Tracker ID and time (IST). Filter by Tracker ID, application, autonomy, range.
- **Drone dashboard** (`/drone?tracker=ID`): drone details, the flight path,
  all its images below the map, refresh every 5 s, a flight selector,
  **Export CSV** (times in IST) and **Export images** (ZIP).

### Drone dashboard layout

- **Drone bar** (top): drone selector, Dashboard / All Images / All Data, and
  **Transmission interval** (that drone's own sending delay, 1 s to 5 min).
- **Map** with an **Images** button on its right: opens a sidebar with the
  drone's images, newest at the top, four visible at a time (scroll for more),
  each with its date and time; click one to enlarge it. **All Images** opens
  `/images?tracker=ID`.
- **GPS data** table right under the map: latitude, longitude, altitude
  (`--` when missing) and time (IST), newest first, five rows visible.
  **All Data** opens `/data?tracker=ID`.
- All Images and All Data show everything the server still keeps for that drone
  (the latest 500 images / 1000 GPS records of all drones together) with a
  date and time filter.

### Per-drone transmission interval

`config.json` holds the default and each drone's own delay:

```json
{ "intervalMs": 10000, "trackerIntervalsMs": { "CAM-01": 5000, "CAM-02": 15000 } }
```

The reply to every upload from a drone (`POST /api/data` as JSON, form-data or a
raw image, `POST /api/telemetry`, `POST /api/config`) carries **that drone's**
`intervalMs`; the sketches already read it, so no firmware change is needed.
Drones without their own setting get the default. The dashboard sets it with
`PUT /api/interval/<TrackerId>` `{ "intervalMs": 5000 }` (`null` = back to the
default; login required). Older `config.json` files with only `intervalMs` still work.

### Time shown for GPS records and images

Both sketches send `Timestamp` as `YYYY-MM-DD HH:MM:SS` already in IST, so it is
shown as is (not shifted again). An ISO time with `Z` or an offset is converted
from that zone. If the device time is missing or not believable (before 2020,
more than 10 minutes ahead of the server, or more than a week old), the time the
server received the record is shown, marked "(received)". The API returns this
as `recordedAt` (UTC) and `timeSource` (`device` / `server`) on every point and image.

### Map markers and when a flight ends

| Marker | Meaning |
|---|---|
| Green pin | Start point: the first position of the flight. Never moves. |
| Arrow | Current live position while the tag is sending; rotated to the telemetry `HeadingDeg` if sent, otherwise to the direction of travel. |
| Red pin | End point: the last position received, shown only once the flight has ended. |

The drone tags send no "power off" message, so the server ends a flight when
nothing has arrived for `OFFLINE_AFTER_SECONDS` (default 300 s = 5 minutes, never less than
three transmission intervals). One missed upload or a short network drop does
not end a flight. Data arriving after a longer silence starts a new flight; the
earlier flight keeps its end point. `GET /api/data/<id>` now also returns
`sessions`, `session` and `offlineAfterMs`, and `GET /api/data` returns
`trackerStatus`; all earlier fields are unchanged. Positions outside
latitude -90..90 / longitude -180..180 are refused.
- Account, settings (current password needed to change anything), help,
  support and about pages.

### Distance covered in a flight

The drone dashboard shows, for the flight on the map:

| Tile | How it is worked out |
|---|---|
| **Distance flown** (the real answer) | The sum of every hop between consecutive GPS positions of the flight, each measured on the Earth's surface (haversine). Because it follows every position, zig-zags, turns and loops are all counted. |
| Straight line start → end | Start to end directly. The shortest possible distance; equals the distance flown only for a perfectly straight flight. |
| Start–end box | The rectangle with the start and end points at opposite corners (the "square from the start and end" method): its east–west side + north–south side. Ignores every turn in between, so it is only a rough estimate. |
| Flight area box | The smallest rectangle around the whole flight: width × height and area (m², hectares, acres). Shows *where* the drone worked, not how far it flew. |

GPS errors are handled so they do not inflate the distance (`lib/distance.js`):
- **Jitter:** a hovering drone's position wobbles by a few metres. A move only counts once the drone is at least **3 m** from the last counted position.
- **Bad fixes:** a position is skipped only when it jumps away faster than **50 m/s** (180 km/h), comes back just as fast, and lands within 20% of the jump from where it was. It is shown as a grey dot and marked `"gpsJump": true`. Sharp zig-zags that move on to a new place are always counted.
- **Times:** speeds use the larger of the device-time gap and the arrival-time gap. A device repeating one `Timestamp`, or uploads arriving bunched together, cannot make a normal move look impossibly fast.
- **Test data:** a hand-made flight sent faster than a drone can fly (for example 300 m out and straight back, 5 s apart) looks exactly like a GPS glitch and is skipped. Either send realistic `Timestamp`s, or start the server with `MAX_DRONE_SPEED_MPS=150` while testing.

Each point's popup shows its **distance from the start**. The overview cards show the latest flight's distance. The CSV export has a `distance_from_start_m` column. Two checkboxes above the map draw the two boxes.

**Measure part of a flight (custom start and end).** Pick any two points on the path:
- **Click a point:** it becomes the **end** of the range, measured from the flight's start.
- **Choose any start:** in a point's popup, **Set as start** makes it the start of the range; **Set as end** makes it the end. The two can be picked in either order.
- **Use the flight's own ends:** the green start pin resets the range start to the flight's start; the red end pin / live arrow resets the end.

While a range is chosen:
- All four tiles cover only that part: distance flown in the range, straight line between its ends, its start–end box, and its area box (width × height).
- Its area box is drawn on the map (blue, dashed) even if the checkbox is off.
- The path between the two points is highlighted in blue. The range start has a green ring and the range end a blue ring.
- The bar above the tiles shows the range, e.g. "point 8 (16:13:34) → point 20 (16:16:55)".

The distance flown in a range is the difference of the two points' "distance from start", so ranges add up (A → B plus B → C = A → C). Bad GPS fixes (grey dots) cannot be picked and are never part of the area.

To go back to the whole flight, use **Show whole flight** or press **Esc**. The range stays while the page refreshes. While a range is chosen, or a popup is open, the map no longer jumps to follow a live drone.

The browser uses the same code as the server for this (`public/js/geo.js`, also used by `lib/distance.js`), so a range covering the whole flight gives exactly the whole-flight numbers.

The accuracy depends on how often the drone sends its position. Corners cut between two uploads are not seen, so a shorter transmission interval gives a more exact distance.

**API:** every session in `GET /api/data/<id>` (and `trackerStatus[].session` in `GET /api/data`) has a `distance` object:
`flownM`, `straightLineM`, `startEndBox { eastWestM, northSouthM, alongSidesM }`, `areaBox { south, north, west, east, widthM, heightM, areaM2 }`, `durationSec`, `avgSpeedKmh`, `pointsUsed`, `ignoredSmallMoves`, `ignoredJumps`.
Every point has `distanceFromStartM`. All earlier fields are unchanged.

**Try it without a drone:** with the server running on port 4000,
```bash
node tools/simulate-flight.js
```
sends a zig-zag spraying flight (real length 675 m, with a hover and one bad GPS fix) as tracker `DEMO-01`. Open `http://localhost:4000/drone?tracker=DEMO-01`.
```bash
node tools/simulate-flight.js --pattern erratic
```
sends a messy test flight (tight back-and-forth legs, then a long run to the end; real length about 3.7 km) as `DEMO-02`, flown at a realistic 8 m/s. Each run prints the real path length next to the server's result.

**Devices and the mobile app are unaffected:** `POST /api/data`, the telemetry
and config APIs and `GET /api/data/<trackerId>` stay open without any login
or key. Accounts are kept in `<DATA_DIR>/users.json` (passwords only as
scrypt hashes). Set `SESSION_SECRET` so logins survive a restart.

### Data packets (live table)

Drones send packets `{ "id": "1005", "lat": 23.078143, "lon": 72.531243, "Alt": 16.5, "Alt_R": "AGL", "d_x": 0.32, "d_y": -0.18, "d_z": 0.19 }`
(the earlier long names `long`, `Altitude`, `Altitude Reference`, `delta_x` ... still work) to
`POST /api/packet` (one packet, or up to 100 in a JSON array). They are stored in `db.json` (the newest 5,000)
and read back with `GET /api/packet` / `GET /api/packet/<id>`.

The dashboard menu has **Data packets** (`/packets`): a table with time (IST), ID, latitude, longitude, altitude,
altitude reference and Δx / Δy / Δz, newest at the top. New packets appear **without refreshing**: the server
pushes each one the moment it is stored over `GET /api/packet-stream` (Server-Sent Events, built into every
browser). New rows flash briefly.
- **Drone** chooses one drone or all drones.
- **Pause** holds new rows ("N new packets waiting") until **Resume**.
- The **Live** chip shows the connection. After a network drop the page reconnects by itself and fills in the packets it missed.
- Clearing all data empties the table on every open page.

Postman: folder **7. Data packets**. Field rules: [DRONE_TEAM_API_GUIDE.md](DRONE_TEAM_API_GUIDE.md) section 6 and `/docs`.

## How the transmission delay works

1. Choose a delay on the website (for example **10 seconds**). It is saved on
   the server.
2. After each upload the server replies with `{"intervalMs": 10000}`. The
   device reads this and uses it from its **next** upload onwards. A change
   therefore reaches the device within one old interval. For example, going
   from 60 s to 10 s can take up to 60 s.
3. Both sketches measure the delay **start-to-start**: a new upload begins
   every 10 s, and the upload time is included in the 10 s. Before this fix
   the sketch waited 10 s *after* each upload finished, so updates really
   came every 10 s + upload time.
4. The website and the phone app check the server every second and redraw as
   soon as new data arrives.
5. On the map, each tracker has a dashed trail with a green **S** (start) pin,
   a red **E** (latest) pin and an arrow showing the direction of travel.
   Hover over any point or the line to see the tracker ID, time and photo.

> A photo upload over LTE Cat-1 takes roughly 2–6 s, depending on signal and
> photo size. If the chosen delay is shorter than the upload time (for
> example 1 s or 2 s), the board sends back-to-back as fast as it can and
> prints a NOTE in the Serial Monitor. For the camera board, use **5 s or
> more**.

## Server API (v1.2.0)

**Interactive API docs (Swagger UI): open `/docs` in a browser**, e.g. `http://localhost:4000/docs` or
`https://drone-tag-hixr.onrender.com/docs`. Every endpoint is listed with its fields, examples and
replies, and **Try it out** sends real requests to the server you pick at the top. The dashboard
endpoints (lock icon) use your login: log in at `/login` in the same browser first. The OpenAPI
description itself is at `/openapi.json` (source: `lib/openapi.js`). `test/openapi.test.js` checks
that it matches the server, so update `lib/openapi.js` together with any API change.

**Offline copy to share:** `docs/Drone-Tag-API-Docs.html` is ONE file that opens in any browser with no internet and no
server: Swagger UI, styles, the full API description and the logo are all inside (about 1.9 MB). "Try it out" is
switched off in it. `docs/openapi.json` is the same description for Postman (Import → that file). After any API
change, rebuild both with:
```bash
node tools/build-offline-docs.js
```
The first build downloads Swagger UI once from cdnjs and checks it against the SHA-512 in `tools/swagger-ui-sha512.json`;
later builds use the cached copy. `npm test` fails if `docs/` is older than `lib/openapi.js`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Is the service running? (Render health check) |
| `POST /api/data` | **Send data.** A JSON position (`TrackerId`, `Latitude`, `Longitude`, optional `Altitude`, `Timestamp`); **or form-data** with those text fields plus a file field `image`; **or** the raw image file as the body with `?trackerId=&lat=&lon=&alt=&ts=` in the URL; or a dashboard setting: `{"intervalMs":10000}` / `{"action":"reset"}`. Any image format; max 15 MB. The reply always includes `intervalMs`. |
| `GET /api/data/<TrackerId>` | **Read data** of one tracker, e.g. `/api/data/CAM-01`: delay, latest point, all its points and all its images (`photos`). `?since=<seq>` returns only newer points; `?photo=<photoId>` or `?photo=latest` returns the image file itself, exactly as uploaded. Without a TrackerId (`/api/data`) it returns all trackers together, which the live map uses. |
| `POST /api/telemetry` · `GET /api/telemetry/<TrackerId>` | Send / read telemetry: battery, flight and spray status, tank, flow, speed, heading, satellites, signal. |
| `POST /api/config` · `GET /api/config/<TrackerId>` | Upload / list / download text configuration files (max 1 MB). |

No access keys: devices send data and the dashboard changes settings without any key (project decision). Anyone with the URL can do the same.

- Drone team: [DRONE_TEAM_API_GUIDE.md](DRONE_TEAM_API_GUIDE.md)
- Deployment: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)
- Test results: [TESTING_REPORT.md](TESTING_REPORT.md)
- Postman: `postman/Drone-Tracker-API.postman_collection.json` + `postman/Drone-Tag-Render.postman_environment.json`
- Tests: `npm test`

### Limits on Render's free plan

- **Render's free disk is temporary.** The `uploads/` folder (images and
  `db.json`) is wiped on every deploy and restart. Locally and on a VPS they
  are kept. The server keeps the newest **500 images** and the last
  **1,000 points**. To keep images permanently on Render, add a database or
  cloud storage, or move to a VPS.
- **The service sleeps after 15 minutes with no requests.** The first request
  after that takes ~30–60 s. The sketches wait up to 60–90 s for a reply, so
  the first upload still goes through. Once a device is sending, the service
  stays awake.
- `config.json` (the saved delay) also resets to its committed value after a
  redeploy.

---

## NEXT STEPS (what you need to do)

### Step 1: Deploy the new server to Render

Follow [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md): push the files to the
repository connected to the `tracker-drone` service, set the health check path
to `/health`. No access keys are needed; point the sketches below at the
service URL.

### Step 2: Prepare the Waveshare ESP32-S3-SIM7670G board

1. Insert a **4G data SIM** (nano SIM) and connect the **LTE antenna** and the
   **GNSS antenna**. GNSS needs open sky to get a fix.
2. Connect the camera module (**OV2640** or OV5640) to the camera connector.
3. On the back of the board, set the DIP switches **CAM = ON** and **4G = ON**.
   Set the USB switch so the Type-C port connects to the ESP32-S3, so you can
   flash it and use the Serial Monitor.
4. Find out whether your board is **V1 or V2** (printed on the board, or ask
   the seller). The camera pins differ between the two.

### Step 3: Flash the camera sketch

1. In the Arduino IDE, install **esp32 by Espressif Systems** (version 3.x)
   from Boards Manager. The camera library is included.
2. Open `esp32s3_sim7670g/esp32s3_sim7670g.ino` and check the settings at
   the top:
   - `BOARD_VERSION`: 1 or 2
   - `APN`: `airtelgprs.com` for Airtel, `jionet` for Jio, `www` for Vi,
     `bsnlnet` for BSNL
   - `TRACKER_ID`: name shown on the map (default `CAM-01`)
   - `SERVER_BASE`: already set to the Render URL
   - `FRAME_SIZE` / `JPEG_QUALITY`: photo size vs upload speed
3. Under **Tools**, set:
   - Board: **ESP32S3 Dev Module**
   - USB CDC On Boot: **Enabled**
   - PSRAM: **QSPI PSRAM** (if the camera fails to start, try **OPI PSRAM**)
   - Flash Size: **16MB**
   - Partition Scheme: any with a 3 MB+ app
4. Upload, then open the Serial Monitor at **115200**. A healthy start looks
   like:
   ```
   Camera ready
   Modem ready at 921600 baud
   Network registered
   Modem initialised
   GNSS : 23.057984, 72.521018      (or "no fix yet" indoors)
   Photo: 38211 bytes
   HTTP status 200, 52 byte reply
   Upload successful
   ```
5. To test indoors (no GNSS fix), set `SIMULATE_GPS_IF_NO_FIX = true` so the
   board still appears on the map. Photos upload either way.

### Step 4: Re-flash the EC200U tracker

`new/new.ino` now uses the same start-to-start timing. Upload it again so the
EC200U also keeps exactly to the chosen delay.

### Step 5: Update and rebuild the phone app

`mobile/App.js` now points to `https://tracker-drone.onrender.com`. It shows
the latest photo and refreshes in step with the chosen delay. Run it with:
```bash
cd mobile
npx expo start
```
For a new APK, rebuild it the way you built the previous one.

### Troubleshooting the camera board

| Serial Monitor shows | Fix |
|---|---|
| `Camera init failed` | CAM switch ON? Correct `BOARD_VERSION`? Try the other PSRAM option. Reseat the camera ribbon. |
| `modem not responding` | 4G switch ON? Try `MODEM_FAST_BAUD 0`. Check that the modem UART is on GPIO17/18 for your board revision. |
| `SIM not ready` | SIM inserted the right way, PIN lock disabled, SIM has data |
| `HTTP status 7xx` | Network/SSL error inside the modem: check APN, signal and data balance |
| `HTTP status 413` | Photo too large: use a smaller `FRAME_SIZE` or a higher `JPEG_QUALITY` number |
| `GNSS : no fix yet` for a long time | GNSS antenna connected and outdoors? A cold start can take a few minutes. |
| `NOTE: this cycle took ... longer than the interval` | Choose a longer delay on the website, or make photos smaller |

## Run locally

Port 3000 is used by another project on this PC, so use port 4000.

```bash
npm install
```
Command Prompt:
```bash
set PORT=4000&& npm start
```
PowerShell:
```bash
$env:PORT=4000; npm start
```
Then open `http://localhost:4000`. Test the API with the Postman collection in
`postman/` (import `Drone-Tracker-API.postman_collection.json`), or with curl:
```bash
curl -X POST http://localhost:4000/api/data -F "TrackerId=CAM-01" -F "Latitude=23.0580" -F "Longitude=72.5210" -F "image=@postman/sample-photo.jpg"
```
