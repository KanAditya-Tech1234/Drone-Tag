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
- **Drone dashboard** (`/drone?tracker=ID`): drone details, flight path with
  S (start) and E (latest), all its images below the map, refresh every 15 s,
  **Export CSV** (times in IST) and **Export images** (ZIP).
- Account, settings (current password needed to change anything), help,
  support and about pages.

**Devices and the mobile app are unaffected:** `POST /api/data`, the telemetry
and config APIs and `GET /api/data/<trackerId>` stay open without any login
or key. Accounts are kept in `<DATA_DIR>/users.json` (passwords only as
scrypt hashes). Set `SESSION_SECRET` so logins survive a restart.

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

## Server API (v1.1.0)

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
