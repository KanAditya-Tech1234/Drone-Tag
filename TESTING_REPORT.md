# Drone Tag: testing report

Date: 27 Oct 2026 · Server version 1.1.0 · Tested on Windows 11, Node.js 24.18.

All tests used **synthetic test data** and **throwaway local test keys**. No real drone hardware was involved.

## How it was tested

1. **Automated API tests**: `npm test` (10 tests, `test/api.test.js`). The server runs on a random port with a temporary data folder and test keys.
2. **Manual curl run**: a local instance on port 4100 with test keys, using the same requests as `DRONE_TEAM_API_GUIDE.md`.
3. **Render build check**: a clean copy of the project, `npm ci --omit=dev` (the Render build command), `npm start` with `PORT=4199`, then `GET /health`.
4. **Integration**: the Abhyuday Bharat backend (`DRONE_TRACKER_URL=http://127.0.0.1:4000`) reading the updated server through a full farmer/pilot job, run against the live local backend.

## Results

| Test | Expected result | Actual result | Status |
|---|---|---|---|
| Backend build | Build succeeds | `npm ci --omit=dev` in a clean copy: OK, 0 vulnerabilities; `node --check server.js` OK | **Passed** |
| Server start on the given port | Listens on `PORT` | Started on 4199 / 4100 / random port as set | **Passed** (local) |
| Render deployment | Service starts successfully | No access to the deployed GitHub repo or Render from this PC | **Not tested**: deployment pending (see `RENDER_DEPLOYMENT.md`) |
| Health check | Successful response | `200 {"status":"ok","success":true,"message":"Drone Tag API is running",...}` | **Passed** (local) · Render: not tested |
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
| Device key | Uploads without / with wrong key refused | `401` without key and with wrong key; `200` with header; `200` with `?key=` | **Passed** (local) |
| Admin key | Delay / reset need admin key | reset with device key only → `401`; delay with admin key → `200`; reset with admin key clears everything | **Passed** (local) |
| Error handling | Invalid requests produce appropriate errors | as above; unknown `/api/...` → `404` JSON; aborted upload logged as one line | **Passed** (local) |
| Mobile API connectivity (Abhyuday Bharat) | App gets tracker images via its backend | Full job via the API: completed farmer request listed **5 tracker images**, each loaded (`200 image/jpeg`) through the signed links | **Passed** (local tracker) · Render: not tested |
| Abhyuday app on a phone with the Render tracker | Field images visible | Needs the Render deployment first | **Not tested** |
| Tracker phone app (`mobile/App.js`) | Reads the configured URL | Code change only (`EXPO_PUBLIC_DRONE_API_BASE_URL`, default unchanged); not run on a device | **Not tested** |
| Dashboard admin-key prompt | Asks once, remembers | Code change only; not clicked through in a browser | **Not tested** |
| Real drone / tracker hardware | Devices upload successfully | No hardware here; existing sketches do not send the device key yet | **Not tested**: drone team |

## Awaiting the drone team

- Uploads from the real devices (EC200U tracker, ESP32-S3 camera board, drone flight controller) to the deployed Render URL.
- Adding the `X-Device-Key` header (or `?key=`) to the firmware before `DEVICE_API_KEY` is switched on.
- Telemetry field mapping from the flight controller to the fields in the guide.
- Behaviour on weak mobile signal (timeouts, retries).

## Known issues / risks

- **Render free plan wipes all stored data** on restart, redeploy and wake-up. Fine for testing; not for real records.
- **Reading is public:** anyone with the URL can see positions, images and telemetry. That was already the case. Adding a read key would also need changes in the Abhyuday backend, the dashboard and the tracker app.
- **No rate limiting** yet.
- **One shared device key** for all devices. Per-device keys are a later improvement.
