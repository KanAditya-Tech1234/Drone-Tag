# Drone Tag API: guide for the drone team

Everything you need to send data from a drone or tracker to the Drone Tag server, without reading the server code.

> **Status (27 Oct 2026):** this API version (1.1.0) is **built and tested locally** but **not yet deployed to Render**. The Render service `https://tracker-drone.onrender.com` is still running the **previous version**, which has only `POST /api/data` and no keys. The new endpoints below (`/health`, `/api/telemetry`, `/api/config`) and the keys go live when the update is deployed (see `RENDER_DEPLOYMENT.md`). We will tell you when it is live; check it with `GET /health`.

---

## A. Server details

| Item | Value |
|---|---|
| Base URL (temporary test hosting) | `https://tracker-drone.onrender.com` |
| Environment | Render free web service, **for testing only**. The final server will be a Hostinger VPS; only the base URL changes then. |
| API version | 1.1.0 (`package.json`) |
| Authentication | Device key in the `X-Device-Key` header on every upload (see below) |
| Content types | `application/json`, `multipart/form-data`, raw image bytes (`image/*`), raw text config (`text/plain`, ...) |
| Size limits | Image 15 MB; configuration file 1 MB; JSON body 1 MB |
| Time format | Any text up to 40 characters; ISO 8601 UTC recommended, e.g. `2026-10-27T10:00:00Z`. The server also records its own `receivedAt` (UTC). |
| Units | Degrees (WGS84) for latitude / longitude, metres for altitude |

### Authentication

- Every **upload** (`POST /api/data`, `POST /api/telemetry`, `POST /api/config`) and **configuration download** needs the device key:
  ```
  X-Device-Key: <DEVICE KEY>
  ```
  Modems that cannot set headers may add `key=<DEVICE KEY>` to the URL query instead. The header is safer, because URLs can end up in logs.
- **Reading** positions, images and telemetry (`GET /api/data...`, `GET /api/telemetry...`) needs no key. This is the same as before; it is how the live map and the farmer app read the data.
- The key is **not** in this document. The project lead shares it with your team directly (see section F). Never put it in a public repository, screenshot or chat group.
- Missing or wrong key → `401 {"status":"error","message":"missing or invalid device key (X-Device-Key header)"}`.

### Response format

Every JSON reply has `"status": "ok"` or `"status": "error"` plus a `message` when something is wrong. Upload replies always include **`intervalMs`**: the delay chosen on the dashboard. Wait that long (start to start) before your next upload.

---

## B. Endpoint reference

| Method | Endpoint | Purpose | Content type | Authentication |
|---|---|---|---|---|
| GET | `/health` | Is the server running? | – | none |
| POST | `/api/data` | Location, image, or location + image | JSON, multipart/form-data, or raw image | device key |
| GET | `/api/data/<TrackerId>` | Read positions, image list, delay; `?photo=<id>` returns an image | – | none |
| POST | `/api/telemetry` | Battery, flight / spray status and other measurements | JSON | device key |
| GET | `/api/telemetry/<TrackerId>` | Read that tracker's telemetry | – | none |
| GET | `/api/telemetry` | Latest telemetry of every tracker | – | none |
| POST | `/api/config` | Upload a configuration file | multipart/form-data or raw text | device key |
| GET | `/api/config/<TrackerId>` | List configuration files; `?file=<id>` or `?file=latest` downloads one | – | device key |

`TrackerId` identifies your device (e.g. `DRONE-01`). Use **1–64 letters, digits, `.`, `_` or `-`**. Upper / lower case are treated the same.

---

### 1. `GET /health`

```
GET https://tracker-drone.onrender.com/health
```
Success (`200`):
```json
{"status":"ok","success":true,"message":"Drone Tag API is running","startedAt":"2026-10-27T10:06:47.596Z","serverTime":"2026-10-27T10:07:06.640Z","deviceKeyRequired":true}
```
The free Render service sleeps after 15 minutes without requests; the first request then takes 30–60 s.

---

### 2. `POST /api/data`: location and images

Three ways to send. Pick whichever your hardware supports.

**Fields** (case-insensitive aliases in brackets):

| Field | Type | Required | Notes |
|---|---|---|---|
| `TrackerId` (`trackerId`, `id`) | text | yes | defaults to `UNKNOWN` if missing; always send it |
| `Latitude` (`lat`) | number, degrees | yes for a position* | −90 … 90 |
| `Longitude` (`lon`, `lng`) | number, degrees | yes for a position* | −180 … 180 |
| `Altitude` (`alt`) | number, metres | no | stored as e.g. `"15m"` |
| `Timestamp` (`ts`, `time`) | text | no | when the reading was taken |
| `image` | file | no | any image format except SVG, max 15 MB |

\* An image without coordinates is still stored (it just cannot be placed on the map). A request with neither an image nor valid coordinates is refused. `0,0` counts as "no GPS fix".

**A) Position only (JSON)**
```bash
curl -X POST "https://tracker-drone.onrender.com/api/data" \
  -H "X-Device-Key: <DEVICE KEY>" -H "Content-Type: application/json" \
  -d '{"TrackerId":"TEST-DRONE-01","Latitude":"23.057984","Longitude":"72.521018","Altitude":"15","Timestamp":"2026-10-27T10:00:00Z"}'
```

**B) Position + image (form-data)**
```bash
curl -X POST "https://tracker-drone.onrender.com/api/data" \
  -H "X-Device-Key: <DEVICE KEY>" \
  -F "TrackerId=TEST-DRONE-01" -F "Latitude=23.0581" -F "Longitude=72.5212" -F "Altitude=18" \
  -F "Timestamp=2026-10-27T10:00:10Z" -F "image=@photo.jpg"
```

**C) Image as the raw body, details in the URL** (for modems that can only send one file):
```bash
curl -X POST "https://tracker-drone.onrender.com/api/data?trackerId=TEST-DRONE-01&lat=23.0583&lon=72.5214&alt=20&ts=2026-10-27T10:00:20Z&filename=photo.jpg" \
  -H "X-Device-Key: <DEVICE KEY>" -H "Content-Type: image/jpeg" --data-binary @photo.jpg
```
URL parameters: `trackerId`, `lat`, `lon`, `alt`, `ts` (URL-encode spaces as `%20`), `filename` (optional original name).

Each image is a separate request. Send them one after another as they are captured; there is no video stream.

**Success (`200`)**
```json
{"status":"ok","intervalMs":10000,"photoId":"1793095626790-2"}
```
`photoId` is `null` when no image was sent.

**Errors**

| Code | Example message | Cause |
|---|---|---|
| 400 | `invalid or missing coordinates (Latitude/Longitude)` | no image and no valid position |
| 400 | `body is not an image — send JSON, form-data, or an image file with Content-Type image/...` | the body is neither JSON nor an image |
| 400 | `images are not accepted inside JSON ...` | base64 image in JSON (not supported) |
| 401 | `missing or invalid device key (X-Device-Key header)` | key missing / wrong |
| 413 | `image too large (max 15 MB)` | image over 15 MB |

---

### 3. `GET /api/data/<TrackerId>`: read what the server stored

```
GET https://tracker-drone.onrender.com/api/data/TEST-DRONE-01
```
Returns `latest` (newest position), `points` (trail, oldest first), `photos` (every stored image with `id`, `mime`, `size`, `receivedAt`, `url`), `photoCount`, `intervalMs`, `seq`.

- `?since=<seq>`: only points newer than that number.
- `?photo=<photoId>` or `?photo=latest`: returns **the image file itself**, exactly as uploaded.
- `GET /api/data` (no TrackerId): all trackers together.
- Unknown TrackerId → `404` with the list of known trackers.

---

### 4. `POST /api/telemetry`: telemetry

JSON object, `Content-Type: application/json`. Field names may be `BatteryPercent`, `batteryPercent` or `battery_percent`.

| Field | Type / unit | Range | Required |
|---|---|---|---|
| `TrackerId` | text | see rules above | **yes** |
| `Timestamp` | text | ≤ 40 chars | no |
| `BatteryPercent` | number, % | 0–100 | no |
| `BatteryVoltage` | number, volts | 0–100 | no |
| `FlightStatus` | text | `IDLE`, `ARMED`, `TAKING_OFF`, `FLYING`, `HOVERING`, `RETURNING`, `LANDING`, `LANDED`, `ERROR` | no |
| `SprayStatus` | text | `OFF`, `ON`, `PAUSED`, `TANK_EMPTY`, `ERROR` | no |
| `TankLevelPercent` | number, % | 0–100 | no |
| `FlowRateLpm` | number, litres/minute | 0–1000 | no |
| `SpeedMps` | number, m/s | 0–200 | no |
| `HeadingDeg` | number, degrees (0 = north) | 0–360 | no |
| `Satellites` | whole number | 0–100 | no |
| `SignalDbm` | number, dBm | −150–0 | no |
| `Latitude`, `Longitude`, `Altitude` | numbers (degrees, metres) | as in section 2 | no; if sent, both coordinates are required, and the position is also added to the map trail |
| `Extra` | object | up to 30 fields; each a number, true/false, or text ≤ 100 chars | no; for any other measurement |

At least **one** measurement besides `TrackerId` / `Timestamp` is required. Status values are case-insensitive. Unknown fields are ignored and listed in `ignoredFields` in the reply.

```bash
curl -X POST "https://tracker-drone.onrender.com/api/telemetry" \
  -H "X-Device-Key: <DEVICE KEY>" -H "Content-Type: application/json" \
  -d '{"TrackerId":"TEST-DRONE-01","Timestamp":"2026-10-27T10:00:30Z","BatteryPercent":76.5,"BatteryVoltage":22.4,"FlightStatus":"FLYING","SprayStatus":"ON","TankLevelPercent":64,"FlowRateLpm":1.8,"SpeedMps":5.2,"HeadingDeg":270,"Satellites":14,"SignalDbm":-71,"Latitude":23.0585,"Longitude":72.5216,"Altitude":12,"Extra":{"pumpPressureBar":2.1}}'
```

**Success (`201`)**
```json
{"status":"ok","intervalMs":10000,"telemetryId":"1793095626830-4","seq":4}
```

**Errors**: `400` with every problem listed:
```json
{"status":"error","message":"invalid telemetry","errors":["BatteryPercent must be a number between 0 and 100"]}
```
Other errors: `400 invalid JSON`, `401` key, `413` body over 1 MB.

**Read it back**
```
GET https://tracker-drone.onrender.com/api/telemetry/TEST-DRONE-01?limit=20
```
Returns `latest`, `records` (newest `limit` records, default 100, max 1000), `count`, `seq`. Use `?since=<seq>` for only newer records. `GET /api/telemetry` returns the latest record of every tracker. Unknown tracker → `404`.

---

### 5. `POST /api/config`: configuration files

Text configuration files only: `.json`, `.plan`, `.yaml`, `.yml`, `.xml`, `.csv`, `.txt`, `.cfg`, `.conf`, `.ini`, `.param`, `.params`, `.waypoints`. Max **1 MB**; UTF-8 text. `.json` / `.plan` files must be valid JSON.

**Form-data** (fields: `TrackerId` required, `Description` optional ≤ 200 chars, file field `file`):
```bash
curl -X POST "https://tracker-drone.onrender.com/api/config" \
  -H "X-Device-Key: <DEVICE KEY>" \
  -F "TrackerId=TEST-DRONE-01" -F "Description=Test mission plan" -F "file=@mission.plan"
```

**Raw body** (name in the URL):
```bash
curl -X POST "https://tracker-drone.onrender.com/api/config?trackerId=TEST-DRONE-01&filename=params.txt" \
  -H "X-Device-Key: <DEVICE KEY>" -H "Content-Type: text/plain" --data-binary @params.txt
```

**Success (`201`)**: returned only after the file is written to disk:
```json
{"status":"ok","intervalMs":10000,"config":{"id":"1793095626908-6","trackerId":"TEST-DRONE-01","originalName":"mission.plan","description":"Test mission plan","mime":"application/json","size":63,"sha256":"407ed574…","receivedAt":"2026-10-27T10:07:06.908Z","seq":6,"url":"/api/config/TEST-DRONE-01?file=1793095626908-6"}}
```
Compare `sha256` with your own file to confirm it arrived intact.

**Errors**: `400` (`file type ".exe" not allowed ...`, `the file is not valid JSON`, `the file is not a text file`, `TrackerId is required ...`), `401` key, `413 configuration file too large (max 1 MB)`, `500 the configuration file could not be stored`.

**List / download** (device key required, since files may hold settings):
```bash
curl -H "X-Device-Key: <DEVICE KEY>" "https://tracker-drone.onrender.com/api/config/TEST-DRONE-01"
curl -H "X-Device-Key: <DEVICE KEY>" "https://tracker-drone.onrender.com/api/config/TEST-DRONE-01?file=latest" -o latest-config
```

---

## C. Replacing the test values

All values in the examples are **synthetic test data**. For real flights:
- `TrackerId`: the ID printed on / configured in your device.
- `Latitude` / `Longitude` / `Altitude`: the GNSS fix (decimal degrees, metres). Leave them out, or send `0,0`, when there is no fix.
- `Timestamp`: the GNSS / device time of the reading.
- Telemetry: the live values from the flight controller.
- `<DEVICE KEY>`: the key you received privately.

On Windows Command Prompt, write JSON with escaped quotes, e.g. `-d "{\"TrackerId\":\"TEST-DRONE-01\"}"`, or use Postman.

---

## D. Testing step by step

**Postman:** import `postman/Drone-Tracker-API.postman_collection.json` and `postman/Drone-Tag-Render.postman_environment.json`, choose the environment **Drone Tag - Render test**, and fill in `deviceKey`. Run the requests from top to bottom.

1. **Is the server up?** `GET /health` → `200` and `"success":true`. If it takes ~60 s the first time, the free service was waking up. If `/health` returns `404`, the new version is not deployed yet.
2. **First request:** send a position (section 2A) → `200 {"status":"ok",...}`.
3. **Check it arrived:** `GET /api/data/<your TrackerId>`. Your point is in `latest`, and images are in `photos`. The live map at the base URL shows it within a second or two.
4. **Telemetry and config:** sections 4 and 5, then read them back.
5. **Read the reply:** `200` / `201` = stored. `400` = fix the data using `message` / `errors`. `401` = key missing or wrong. `413` = file too large. `5xx` or no reply = server problem; retry after 30–60 s.

**Common failures**

| Symptom | Likely cause |
|---|---|
| No reply for ~60 s, then OK | free service was asleep |
| `401` | missing `X-Device-Key` header, typo in key, or key changed |
| `400 body is not an image` | wrong `Content-Type`, or the body is empty / truncated |
| `400 invalid JSON` | quotes not escaped (Windows), trailing comma |
| Modem error 7xx / timeout | APN, signal or SSL problem on the modem; test the same request with curl from a PC |
| Data disappeared | the free Render service restarted or was redeployed (see limitations) |

**When a test fails, send us:** the exact URL and method (key removed), the headers (key removed), the body or file name and size, the HTTP status and reply text, the time (UTC), the TrackerId, and for modems the AT-command log.

---

## E. Current limitations (test environment)

| Area | Status |
|---|---|
| Position, image, telemetry, config upload | **Implemented** (v1.1.0), tested locally; **not yet deployed** to Render |
| Storage | Files on the service's own disk. **On Render's free plan everything (images, telemetry, configs, positions) is wiped on every restart / redeploy.** The server keeps the newest 500 images, 1,000 positions, 2,000 telemetry records and 200 configuration files. |
| Sleep | Free service sleeps after 15 min idle; first request then takes 30–60 s |
| Authentication | One shared device key for all devices; reading positions / images / telemetry is open |
| Rate limiting | None yet; please do not send faster than the `intervalMs` reply |
| HTTPS | Yes (Render). Plain HTTP is redirected. |
| Real hardware | **Not tested yet.** All tests so far used synthetic data. Hardware testing is the drone team's next step. |

## F. Receiving the device key

The project lead sends the device key to one named person in the drone team through a private channel (in person, or a password manager / encrypted message), never in a group chat, e-mail thread, document or repository. Store it in the device configuration only. If it leaks, tell us; we change it on the server and send a new one.
