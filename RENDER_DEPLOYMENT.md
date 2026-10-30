# Deploying the Drone Tag server on Render (temporary test hosting)

Render is used **only for testing** until the Hostinger VPS (KVM 2) is bought. Everything here is portable: settings live in environment variables, and nothing depends on Render-only features.

## Current state (27 Oct 2026)

- **v1.1.0 is live at `https://drone-tag-hixr.onrender.com`** (deployed by the project lead from the `Drone tag` folder). All endpoints passed a live check (`TESTING_REPORT.md`).
- **Access keys were removed on 28 Oct 2026** (project decision): devices send data and the dashboard changes settings without any key. If `DEVICE_API_KEY` / `ADMIN_API_KEY` are still set in Render's Environment tab, delete them (see Step 2).
- The older service `https://tracker-drone.onrender.com` still runs the previous version. The existing sketches in `new/` and `esp32s3_sim7670g/` still point there. Change their server address before using them with the new service.
- In the steps below, read "tracker-drone" as your new service's name and `https://drone-tag-hixr.onrender.com` as its URL.

## What to deploy

Files from this folder (`drone-tracker-updated/`):

| File | Needed | Why |
|---|---|---|
| `server.js` | yes | the server (v1.1.0) |
| `package.json`, `package-lock.json` | yes | dependencies, `npm start`, `npm test` |
| `render.yaml` | yes | build / start commands, health check, env var names |
| `public/index.html` | yes | dashboard |
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
git commit -m "Drone Tag v1.1.1: health check, telemetry, config files, no access keys"
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
   | `SESSION_SECRET` | a long random value (signs dashboard logins; without it everyone is logged out at every restart) |
   | `OFFLINE_AFTER_SECONDS` | optional: seconds of silence after which a flight is shown as ended (default `120`) |

   **Delete `DEVICE_API_KEY` and `ADMIN_API_KEY` if they are listed** (no access keys are used any more).
   `PORT` is set by Render automatically; do not add it. `DATA_DIR` / `CONFIG_PATH` stay unset on Render.
3. Save. Render deploys automatically after the push (auto-deploy). Otherwise use **Manual Deploy → Deploy latest commit**.

(Alternative for a brand-new service: **New → Blueprint**, pick the repository; `render.yaml` creates the service.)

## Step 3: Check the deployment

1. **Logs:** the deploy log must end with `Drone Tag server listening on http://0.0.0.0:<port>`, with no `WARNING: ... is not set` lines.
2. Health check:
   ```bash
   curl https://tracker-drone.onrender.com/health
   ```
   Expect `200` with `"message":"Drone Tag API is running"`.
3. Send telemetry without any key (expect `201`):
   ```bash
   curl -X POST https://drone-tag-hixr.onrender.com/api/telemetry -H "Content-Type: application/json" -d "{\"TrackerId\":\"TEST-DRONE-01\",\"BatteryPercent\":80,\"FlightStatus\":\"IDLE\"}"
   ```
4. Run the Postman collection (`postman/`) with the environment **Drone Tag - Render test**.
5. Open the dashboard `https://drone-tag-hixr.onrender.com` and change the delay; it saves without asking for a key.
6. Fill in the Render rows of `TESTING_REPORT.md`.

## Step 4: Connect the Abhyuday Bharat backend

The farmer report in the Abhyuday Bharat app shows the images from this server: the Abhyuday backend reads the image list, and the app loads each image straight from this server (`/api/data/<TrackerId>?photo=<id>`, public). Point the backend at Render in `Smart_Agri_Mobile_Application/backend/.env` (already done on the development PC):
```
DRONE_TRACKER_URL=https://drone-tag-hixr.onrender.com
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
| Uploads or the dashboard get `401` | the old version (with keys) is still running, or `DEVICE_API_KEY` / `ADMIN_API_KEY` are still set: delete them in Render's Environment tab and redeploy |
| Data vanished | free-plan restart / redeploy / sleep; expected on Render (see below) |
| First request very slow | free service woke from sleep (15 min idle) |

## Render free-plan limits

- **Disk is temporary:** images, configuration files, telemetry, positions and the saved delay are lost on every restart, redeploy or wake-up after sleep. Keeping them on Render needs a **paid** plan with a persistent disk, or external storage. Neither is set up; that decision is yours (cost).
- **Dashboard accounts are lost too:** `users.json` is on the same temporary disk, so everyone has to register again after a restart, redeploy or wake-up. The drone data APIs need no account and are not affected.
- Sleeps after 15 minutes without requests.
- 750 free instance hours per month per workspace.

## Moving to the Hostinger VPS later

Nothing in the code is Render-specific. On the VPS:
1. Install Node.js 22, copy the folder, run `npm ci --omit=dev`.
2. Set the environment variables `PORT` (e.g. 4000), **`DATA_DIR=/var/lib/drone-tag`** and `CONFIG_PATH=/var/lib/drone-tag/config.json` (persistent disk, so data survives restarts).
3. Run it with a process manager (systemd or pm2), behind nginx with HTTPS (Let's Encrypt).
4. Change the base URL in: device firmware, `DRONE_TEAM_API_GUIDE.md`, the Postman environment, `mobile/.env` (`EXPO_PUBLIC_DRONE_API_BASE_URL`), and the Abhyuday backend's `DRONE_TRACKER_URL`.

The API contract stays the same.
