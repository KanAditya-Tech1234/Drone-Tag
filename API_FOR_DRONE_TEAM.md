# Drone Tracker API: only two endpoints

> **Superseded by [DRONE_TEAM_API_GUIDE.md](DRONE_TEAM_API_GUIDE.md)** (v1.1.0: health check, telemetry,
> configuration files, device key). The `POST /api/data` / `GET /api/data` contract below is unchanged, except that
> uploads need the `X-Device-Key` header once the server has `DEVICE_API_KEY` set.

| # | Method | URL (local testing) | Purpose |
|---|---|---|---|
| 1 | **POST** | `http://localhost:4000/api/data` | **Send data**: GPS position and/or an image file |
| 2 | **GET** | `http://localhost:4000/api/data/<TrackerId>` | **Read data** of one tracker: points and delay (JSON), or an image file |

Example: `http://localhost:4000/api/data/CAM-01`

- Dashboard (live map): `http://localhost:4000/`
- From another device on the same Wi-Fi, use the PC's IP instead of
  `localhost`, e.g. `http://192.168.1.25:4000/api/data`.
- Images are sent and returned as **real image files**, in **any image
  format** (JPG, PNG, WebP, GIF, BMP, TIFF, HEIC, AVIF, ...). **Base64 is not
  used.**
- Images are saved in the server's `uploads/` folder and are kept after a
  restart.

---

## API 1: POST /api/data (send data)

### Option A: GPS position only (JSON)
```
POST http://localhost:4000/api/data
Content-Type: application/json
```
```json
{
  "TrackerId": "TRK-05",
  "Latitude": "23.057984",
  "Longitude": "72.521018",
  "Altitude": "15",
  "Timestamp": "2026-10-24 10:00:00"
}
```

### Option B: GPS position + image file (form-data), recommended
```
POST http://localhost:4000/api/data
Content-Type: multipart/form-data
```
| Key | Type | Example | Required |
|---|---|---|---|
| `TrackerId` | Text | `CAM-01` | yes |
| `Latitude` | Text | `23.050000` | yes* |
| `Longitude` | Text | `72.515000` | yes* |
| `Altitude` | Text | `25` | no |
| `Timestamp` | Text | `2026-10-24 10:01:00` | no |
| `image` | **File** | `photo.jpg` (any image format) | no |

### Option C: Image as the raw request body + details in the URL
This is for devices (like the camera board's 4G modem) that can only send one
file as the body.
```
POST http://localhost:4000/api/data?trackerId=CAM-01&lat=23.056&lon=72.523&alt=27&ts=2026-10-24%2010:01:20
Content-Type: image/jpeg          (or image/png, image/webp, ... matching the file)
Body: <the image file bytes>
```

| URL parameter | Same as | Required |
|---|---|---|
| `trackerId` | TrackerId | yes |
| `lat` | Latitude | yes* |
| `lon` | Longitude | yes* |
| `alt` | Altitude | no |
| `ts` | Timestamp (URL-encode the space as `%20`) | no |
| `filename` | Original file name, e.g. `photo.heic` | no |

\* An image sent without coordinates is still saved, but it can't be placed
on the map.

**Notes:**
- Max image size: **15 MB**.
- The image type is detected from the file itself, so a wrong `Content-Type`
  doesn't matter for common formats.
- SVG files are refused for security reasons.
- Browsers can't display some formats (HEIC, TIFF, camera RAW). They are still
  stored, and clicking the point on the map downloads them.
- Lowercase keys also work: `trackerId`, `latitude`/`lat`,
  `longitude`/`lon`, `altitude`/`alt`, `timestamp`/`ts`.

### Successful reply
```json
{ "status": "ok", "intervalMs": 10000, "photoId": "1792816047102-40" }
```
- **`intervalMs`** is the delay set on the dashboard, in milliseconds. The
  device must wait this long before its next upload, measured from the
  **start** of one upload to the start of the next.
- **`photoId`** is the ID of the stored image, or `null` if no image was sent.

### Dashboard settings (JSON, also POST /api/data)
The dashboard uses these. Devices don't need them.

| Body | Effect |
|---|---|
| `{ "intervalMs": 10000 }` | Change the delay (1000–300000 ms) |
| `{ "action": "reset" }` | Delete all points and images |

---

## API 2: GET /api/data/<TrackerId> (read data)

Put the tracker's ID at the end of the URL, for example
`http://localhost:4000/api/data/CAM-01`. Upper and lower case don't matter
(`cam-01` works too).

| Request | Returns |
|---|---|
| `GET /api/data/CAM-01` | All data of tracker CAM-01 as JSON (see below) |
| `GET /api/data/CAM-01?since=5` | Same, but `points` only contains points newer than number 5 |
| `GET /api/data/CAM-01?photo=<photoId>` | **The image file itself**, exactly as uploaded, with its real type |
| `GET /api/data/CAM-01?photo=latest` | The newest image file of CAM-01 |
| `GET /api/data` | Same as the first row, but for **all trackers together** (the live map uses this) |

An unknown TrackerId returns `404`, with the list of trackers that do have data:
```json
{ "status": "error", "message": "no data for tracker \"CAM-09\"", "trackers": ["CAM-01", "TRK-05"] }
```

### Example JSON reply: `GET /api/data/CAM-01`
```json
{
  "status": "ok",
  "trackerId": "CAM-01",
  "trackers": ["CAM-01", "TRK-05"],
  "intervalMs": 10000,
  "serverTime": "2026-10-24T04:30:12.000Z",
  "generation": 1792815100000,
  "seq": 8,
  "pointCount": 2,
  "photoCount": 2,
  "latest": {
    "trackerId": "CAM-01", "lat": 23.06, "lon": 72.52, "altitude": "25m",
    "timestamp": "2026-10-24 10:01:10", "photoId": "1792816047102-7",
    "photoUrl": "/api/data/CAM-01?photo=1792816047102-7", "seq": 7, "...": "..."
  },
  "latestPhoto": {
    "id": "1792816047102-7", "originalName": "photo.jpg", "trackerId": "CAM-01",
    "lat": 23.06, "lon": 72.52, "size": 48211, "mime": "image/jpeg",
    "url": "/api/data/CAM-01?photo=1792816047102-7"
  },
  "points": [
    { "trackerId": "CAM-01", "lat": 23.05, "lon": 72.51, "photoId": "1792816047001-5",
      "photoUrl": "/api/data/CAM-01?photo=1792816047001-5", "seq": 5, "...": "..." },
    { "trackerId": "CAM-01", "lat": 23.06, "lon": 72.52, "photoId": "1792816047102-7",
      "photoUrl": "/api/data/CAM-01?photo=1792816047102-7", "seq": 7, "...": "..." }
  ]
}
```

| Field | Meaning |
|---|---|
| `trackerId` | The tracker this reply is about (`null` for `GET /api/data`) |
| `trackers` | Every TrackerId the server has data for |
| `intervalMs` | Current delay |
| `seq` | Number of the newest item. Pass it back as `?since=` to get only new points next time. |
| `generation` | Changes when data is cleared or the server restarts |
| `latest` | This tracker's most recent GPS point |
| `latestPhoto` | This tracker's most recent image details; open `url` to get the image file |
| `points` | This tracker's trail points, oldest first. Points with an image have `photoId` and `photoUrl`. |
| `photos` | Every image of this tracker (all trackers for `GET /api/data`), oldest first, including images sent without GPS. Each has `id`, `trackerId`, `originalName`, `mime`, `size`, `receivedAt` and `url`. The Abhyuday Bharat app reads this list to show the images in the farmer's report. |

---

## Status codes

| Code | Meaning |
|---|---|
| `200` | OK |
| `400` | Bad data: invalid JSON, missing/invalid coordinates, file is not an image, base64 sent inside JSON, or delay out of range. The `message` field explains why. |
| `404` | Unknown TrackerId, image not found for that tracker, or a URL other than `/api/data` |
| `413` | Image larger than 15 MB |

## Quick test from a PC (curl)
```bash
curl -X POST "http://localhost:4000/api/data" -H "Content-Type: application/json" -d "{\"TrackerId\":\"TRK-05\",\"Latitude\":\"23.0580\",\"Longitude\":\"72.5210\"}"
```
```bash
curl -X POST "http://localhost:4000/api/data" -F "TrackerId=CAM-01" -F "Latitude=23.0580" -F "Longitude=72.5210" -F "image=@photo.jpg"
```
```bash
curl -X POST "http://localhost:4000/api/data?trackerId=CAM-01&lat=23.0580&lon=72.5210" -H "Content-Type: image/png" --data-binary @photo.png
```
```bash
curl "http://localhost:4000/api/data/CAM-01"
```
