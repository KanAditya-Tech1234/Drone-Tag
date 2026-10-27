# Deploying the Drone Tag server on Render (temporary test hosting)

Render is used **only for testing** until the Hostinger VPS (KVM 2) is bought. Everything here is portable: settings live in environment variables, and nothing depends on Render-only features.

## Current state (27 Oct 2026)

- The Render web service **`tracker-drone`** already exists at `https://tracker-drone.onrender.com`. It runs the **previous** server version: no `/health`, no telemetry or config endpoints, no keys.
- This PC has **no access** to the GitHub repository that service deploys from, and no Render credentials. The local copy in `C:\Aditya\DroneTracking` is a git repository without commits or a remote. **So the new version (1.1.0) has not been deployed.** Follow the steps below.

## What to deploy

Files from this folder (`drone-tracker-updated/`):

| File | Needed | Why |
|---|---|---|
| `server.js` | yes | the server (v1.1.0) |
| `package.json`, `package-lock.json` | yes | dependencies, `npm start`, `npm test` |
| `render.yaml` | yes | build / start commands, health check, env var names |
| `public/index.html` | yes | dashboard (now sends the admin key) |
| `config.json` | yes | default transmission delay |
| `.gitignore`, `.env.example` | yes | keeps `uploads/`, `node_modules/`, `.env` out of git |
| `test/`, `postman/` | recommended | tests and Postman collection |
| `DRONE_TEAM_API_GUIDE.md`, `RENDER_DEPLOYMENT.md`, `TESTING_REPORT.md`, `README.md`, `API_FOR_DRONE_TEAM.md` | recommended | documentation |
| `mobile/`, `new/`, `esp32s3_sim7670g/` | optional | phone app and device sketches |

**Never commit** `uploads/`, `node_modules/` or a `.env` file. Also leave out `Hosting_Report_*.pdf` and `start-local.cmd` (local-only helper).

## Step 1: Push the code to the GitHub repository

The service deploys from the GitHub repository connected to it. To find which one: Render dashboard → **tracker-drone** → **Settings → Build & Deploy → Repository** (also note the **Branch** and **Root Directory**).

Then, from a clone of that repository:
```bash
git pull
```
Copy the files listed above into the repository folder, under the configured **Root Directory** (empty = repository root). Then:
```bash
git add server.js package.json package-lock.json render.yaml public/index.html config.json .gitignore .env.example test postman DRONE_TEAM_API_GUIDE.md RENDER_DEPLOYMENT.md TESTING_REPORT.md README.md API_FOR_DRONE_TEAM.md
```
```bash
git commit -m "Drone Tag v1.1.0: health check, telemetry, config files, device/admin keys"
```
```bash
git push
```
If you use GitHub's website instead: open the repository → **Add file → Upload files**, drag the files in (keep the `public/`, `test/` and `postman/` folders), and commit to the deployed branch.

## Step 2: Set the service settings and secrets

Render dashboard → **tracker-drone**:

1. **Settings → Build & Deploy**
   - Build Command: `npm ci --omit=dev`
   - Start Command: `npm start`
   - **Health Check Path: `/health`** (it was `/api/data`)
2. **Environment** → add:

   | Key | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `DEVICE_API_KEY` | a new random value (see below) |
   | `ADMIN_API_KEY` | a different random value |

   Generate each value on your PC (run it twice):
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   Keep both values in a password manager. Do not paste them into chat, documents or the repository.
   `PORT` is set by Render automatically; do not add it. `DATA_DIR` / `CONFIG_PATH` stay unset on Render.
3. Save. Render deploys automatically after the push (auto-deploy). Otherwise use **Manual Deploy → Deploy latest commit**.

> **Before setting `DEVICE_API_KEY`:** devices that do not send the key yet will get `401` from then on. The existing sketches in `new/` and `esp32s3_sim7670g/` do not send it. Agree with the drone team when to switch, or update their firmware to add the `X-Device-Key` header (or `?key=`) first.

(Alternative for a brand-new service: **New → Blueprint**, pick the repository; `render.yaml` creates the service and asks for the two keys.)

## Step 3: Check the deployment

1. **Logs:** the deploy log must end with `Drone Tag server listening on http://0.0.0.0:<port>`, with no `WARNING: ... is not set` lines.
2. Health check:
   ```bash
   curl https://tracker-drone.onrender.com/health
   ```
   Expect `200` with `"message":"Drone Tag API is running"` and `"deviceKeyRequired":true`.
3. Device key enforced (expect `401`):
   ```bash
   curl -X POST https://tracker-drone.onrender.com/api/telemetry -H "Content-Type: application/json" -d "{\"TrackerId\":\"TEST-DRONE-01\",\"BatteryPercent\":80}"
   ```
4. With the key (expect `201`; replace `<DEVICE KEY>`):
   ```bash
   curl -X POST https://tracker-drone.onrender.com/api/telemetry -H "X-Device-Key: <DEVICE KEY>" -H "Content-Type: application/json" -d "{\"TrackerId\":\"TEST-DRONE-01\",\"BatteryPercent\":80,\"FlightStatus\":\"IDLE\"}"
   ```
5. Run the Postman collection (`postman/`) with the environment's `deviceKey` / `adminKey` filled in.
6. Open the dashboard `https://tracker-drone.onrender.com`. Changing the delay asks for the admin key once.
7. Fill in the Render rows of `TESTING_REPORT.md`.

## Step 4: Connect the Abhyuday Bharat backend

The farmer report in the Abhyuday Bharat app shows the images from this server. The phone app never calls the Drone Tag server directly: the Abhyuday backend reads it and gives the app short-lived signed links. Point the backend at Render in `Smart_Agri_Mobile_Application/backend/.env`:
```
DRONE_TRACKER_URL=https://tracker-drone.onrender.com
```
Restart the backend. Reading needs no key, so no Drone Tag secret goes into the Abhyuday backend or the app.

## Updating later

Push to the deployed branch → Render redeploys automatically. Each redeploy **wipes the stored data** on the free plan.

## Troubleshooting

| Problem | Fix |
|---|---|
| Deploy fails at `npm ci` | `package-lock.json` missing or out of date: run `npm install` locally and commit the lock file |
| Service "unhealthy" | Health Check Path must be `/health`; check the logs for a startup error |
| `/health` returns 404 | the old version is still running: check that the push reached the deployed branch / root directory |
| Every upload gets `401` | device not sending `X-Device-Key`, or a typo in the Render `DEVICE_API_KEY` |
| Dashboard can't change the delay | wrong admin key stored in the browser: clear the site data and enter it again |
| Data vanished | free-plan restart / redeploy / sleep; expected on Render (see below) |
| First request very slow | free service woke from sleep (15 min idle) |

## Render free-plan limits

- **Disk is temporary:** images, configuration files, telemetry, positions and the saved delay are lost on every restart, redeploy or wake-up after sleep. Keeping them on Render needs a **paid** plan with a persistent disk, or external storage. Neither is set up; that decision is yours (cost).
- Sleeps after 15 minutes without requests.
- 750 free instance hours per month per workspace.

## Moving to the Hostinger VPS later

Nothing in the code is Render-specific. On the VPS:
1. Install Node.js 22, copy the folder, run `npm ci --omit=dev`.
2. Set the same environment variables: `DEVICE_API_KEY`, `ADMIN_API_KEY`, plus `PORT` (e.g. 4000), **`DATA_DIR=/var/lib/drone-tag`** and `CONFIG_PATH=/var/lib/drone-tag/config.json` (persistent disk, so data survives restarts).
3. Run it with a process manager (systemd or pm2), behind nginx with HTTPS (Let's Encrypt).
4. Change the base URL in: device firmware, `DRONE_TEAM_API_GUIDE.md`, the Postman environment, `mobile/.env` (`EXPO_PUBLIC_DRONE_API_BASE_URL`), and the Abhyuday backend's `DRONE_TRACKER_URL`.

The API contract stays the same.
