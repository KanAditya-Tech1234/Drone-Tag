# Drone Tag: testing report

Date: 27 Oct 2026 · Server version 1.1.0 · Tested on Windows 11, Node.js 24.18.

All tests used **synthetic test data**. No real drone hardware was involved.

> **Update 28 Oct 2026: access keys removed** (project decision). Devices send data and the dashboard changes settings without any key. The automated tests were updated and pass (10/10) locally. The key rows below describe the earlier v1.1.0 check and no longer apply.

## How it was tested

1. **Automated API tests**: `npm test` (10 tests, `test/api.test.js`). The server runs on a random port with a temporary data folder.
2. **Manual curl run**: a local instance on port 4100 with test keys, using the same requests as `DRONE_TEAM_API_GUIDE.md`.
3. **Render build check**: a clean copy of the project, `npm ci --omit=dev` (the Render build command), `npm start` with `PORT=4199`, then `GET /health`.
4. **Integration**: the Abhyuday Bharat backend (`DRONE_TRACKER_URL=http://127.0.0.1:4000`) reading the updated server through a full farmer/pilot job, run against the live local backend.

## Results

| Test | Expected result | Actual result | Status |
|---|---|---|---|
| Backend build | Build succeeds | `npm ci --omit=dev` in a clean copy: OK, 0 vulnerabilities; `node --check server.js` OK | **Passed** |
| Server start on the given port | Listens on `PORT` | Started on 4199 / 4100 / random port as set | **Passed** (local) |
| Render deployment | Service starts successfully | Deployed by the project lead at `https://drone-tag-hixr.onrender.com`; `/health` reports v1.1.0 running with `deviceKeyRequired: true` | **Passed** |
| Health check | Successful response | `200 {"status":"ok","success":true,"message":"Drone Tag API is running",...}` locally and on Render | **Passed** (local + Render) |
| Location ingestion | Valid test data accepted | JSON position → `200 {"status":"ok","intervalMs":5000,"photoId":null}` | **Passed** (local) |
| Location validation | Bad data refused | `Latitude:"abc"` → `400 invalid or missing coordinates` | **Passed** (local) |
| Image upload (form-data) | Stored; listed; returned unchanged | `200` with `photoId`; listed in `photos`; `?photo=latest` → `image/jpeg`, 4,833 bytes = original | **Passed** (local) |
| Image upload (raw body) | Stored | `200` with `photoId` | **Passed** (local) |
| Image without GPS | Stored and listed | Listed in `photos` (automated test) | **Passed** (local) |
| Non-image upload | Refused | `400` | **Passed** (local) |
| Telemetry ingestion | Valid test data accepted | `201 {"status":"ok","telemetryId":...}`; read back via `GET /api/telemetry/TEST-DRONE-01`; position added to the map trail | **Passed** (local) |
| Telemetry validation | Clear errors | `BatteryPercent:150` → `400` with `"BatteryPercent must be a number between 0 and 100"`; 3 errors listed for 3 bad fields; bad JSON → `400`; unknown tracker → `404` | **Passed** (local) |
| Configuration upload | File stored, then reported | `.plan` via form-data → `201` with size + sha256; `.txt` raw → `201`; list shows both; download returns identical content | **Passed** (local) |
| Configuration validation | Bad files refused | invalid JSON → `400`; `.exe` → `400`; 1 MB + 1 byte → `413` | **Passed** (local) |
| No keys (v1.1.1) | Uploads, delay and reset work without any key; a leftover key header is ignored | `200` / `201` without keys; `200` with an old `X-Device-Key` header | **Passed** (local) |
| Error handling | Invalid requests produce appropriate errors | as above; unknown `/api/...` → `404` JSON; aborted upload logged as one line | **Passed** (local) |
| Mobile API connectivity (Abhyuday Bharat) | App gets tracker images via its backend | Full job via the API: completed farmer request listed **5 tracker images**, each loaded (`200 image/jpeg`) through the signed links | **Passed** (local tracker) · Render: not tested |
| Abhyuday app on a phone with the Render tracker | Field images visible | Needs the Render deployment first | **Not tested** |
| Tracker phone app (`mobile/App.js`) | Reads the configured URL | Code change only (`EXPO_PUBLIC_DRONE_API_BASE_URL`, default unchanged); not run on a device | **Not tested** |
| Dashboard admin-key prompt | Asks once, remembers | Code change only; not clicked through in a browser | **Not tested** |
| Real drone / tracker hardware | Devices upload successfully | No hardware here | **Not tested**: drone team |

## Live check on Render (27 Oct 2026)

All the Postman collection's requests, plus error cases, were sent to `https://drone-tag-hixr.onrender.com` with synthetic data (tracker `TEST-DRONE-01`). **27 of 27 checks passed.**

| Check | Result |
|---|---|
| `GET /health` | 200 |
| Position without key / with wrong key | 401 / 401 |
| Position (JSON) | 200 |
| Bad coordinates | 400 |
| Position + image (form-data) · image (raw body) · image with `?key=` | 200 · 200 · 200 |
| Non-image body | 400 |
| `GET /api/data/TEST-DRONE-01` | 200 (4 points, 3 photos) |
| `?photo=latest` | 200 `image/jpeg`, byte-identical to the upload |
| Telemetry without key · valid · invalid values | 401 · 201 · 400 (each problem listed) |
| `GET /api/telemetry/TEST-DRONE-01` · `GET /api/telemetry` | 200 · 200 |
| Config upload form-data · raw text | 201 · 201 |
| Config invalid JSON · `.exe` | 400 · 400 |
| Config list without key · with key | 401 · 200 (2 files) |
| Config download `?file=latest` | 200, byte-identical |
| Delay change with device key only · with admin key | 401 · 200 |
| Unknown `/api/...` path | 404 |
| Dashboard page `/` | 200 |

The test data (`TEST-DRONE-01`) was left on the service so the drone team can see example records. It disappears on the next restart, or clear it from the dashboard.

## Awaiting the drone team

- Uploads from the real devices (EC200U tracker, ESP32-S3 camera board, drone flight controller) to the deployed Render URL.
- Telemetry field mapping from the flight controller to the fields in the guide.
- Behaviour on weak mobile signal (timeouts, retries).

## Known issues / risks

- **Render free plan wipes all stored data** on restart, redeploy and wake-up. Fine for testing; not for real records.
- **Reading is public:** anyone with the URL can see positions, images and telemetry. That was already the case. Adding a read key would also need changes in the Abhyuday backend, the dashboard and the tracker app.
- **No rate limiting** yet.
- **No access keys:** anyone with the URL can send data, read it, change the delay or clear all data. Accepted for testing (project decision); worth revisiting before real use.

## Dashboard update (30 Oct 2026): accounts, drone dashboard, filters, exports

`npm test`: **17 of 17 pass** (10 earlier API tests + 7 new):

- Dashboard pages redirect to `/login` without a session; help, about, support, login and register pages are open.
- `POST /api/data` and `GET /api/data/<id>` still work without login (devices and the Abhyuday app are unaffected).
- Register: field validation, duplicate phone / email / Tracker ID (any case) refused, password stored only as a scrypt hash, HttpOnly cookie.
- Login: wrong password refused, `+91` accepted, forged cookie refused; 10 wrong attempts from one IP → `429` for 15 minutes.
- Settings: changes need the current password.
- CSV export: IST date-time column, formula cells neutralised; ZIP export: valid archive, one file per image, IST time in file names.

Browser check (local, port 4100): login, live map pin pop-up (Tracker ID + IST time only), filters (application / range / search / reset), drone dashboard (details, S/E path, images grid below the map, exports), account, settings, help, support, about. All pages fit a 375 px phone screen without sideways scrolling. No console errors.

## UI correction and live tracking markers (30 Oct 2026)

`npm test`: **25 of 25 pass** (17 earlier + 8 new: 7 tracking-session rules in `test/sessions.test.js`, 1 API check of the new session fields and of out-of-range coordinates).

Browser check (local server, test data only, offline window shortened to 20 s by the local launcher):

- Login and register cards centred at 320, 375, 768 and 1280 px; heading, text and button labels centred.
- Simulated flight (12 positions, 3 s apart): green start pin fixed, one arrow that moved with each update (rotated 39° for a north-east track), no red pin while live, markers never multiplied, no browser refresh needed.
- 20 s after the last upload: arrow removed, red pin placed exactly at the last received position (matches the server's last point); chip "Tracking ended".
- New data after the silence started Flight 2 (live, own start, arrow at 90° for an eastward track); Flight 1 kept its start and end and can be picked in the "Flight" selector.
- Live map overview: "1 live" chip, path, start pin and arrow per drone, Live / Ended badge on the drone cards.
- Legend inside the bottom-left corner of both maps at all widths; no page scrolls sideways at 375, 768 or 1280 px; no console errors.
