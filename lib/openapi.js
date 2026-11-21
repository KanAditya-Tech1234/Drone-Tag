// OpenAPI 3.0 description of the Drone Tag API. Served as /openapi.json and
// shown by Swagger UI at /docs. Keep it in step with server.js: test/openapi.test.js
// sends every example below to the real server.
const { version } = require('../package.json');

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const ok = (description, schema, example) => ({ description, content: json(schema, example) });
const err = description => ({ description, content: json(ref('Error')) });
const trackerPath = { name: 'trackerId', in: 'path', required: true, description: 'Tracker ID (upper / lower case ignored)', schema: { type: 'string', example: 'DRONE-01' } };
const cookie = [{ cookieAuth: [] }];

const EXAMPLE_POSITION = { TrackerId: 'DRONE-01', Latitude: '23.057984', Longitude: '72.521018', Altitude: '15', Timestamp: '2026-11-20 10:00:00' };

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Drone Tag API',
    version,
    description: [
      'Drone tags (EC200U tracker, Waveshare ESP32-S3 SIM7670G camera board) send GPS positions, photos,',
      'telemetry and configuration files; the dashboard and the Abhyuday Bharat backend read them back.',
      '',
      '**Devices and the read APIs need no login or key.** Only the dashboard endpoints (marked with a',
      'lock) need the dashboard login cookie: log in at `/login` in this browser first, then "Try it out" sends it.',
      '',
      '**Times:** devices send `Timestamp` as `YYYY-MM-DD HH:MM:SS` in IST (no zone). Server times are ISO 8601 UTC.',
      '',
      '**Delay:** every upload reply contains `intervalMs`, the transmission interval the drone must use next.',
      '',
      '**Distance flown** (v1.2): each flight (`session`) has a `distance` summary and each point a',
      '`distanceFromStartM`. For a range A → B, the distance is `distanceFromStartM(B) - distanceFromStartM(A)`.',
    ].join('\n'),
  },
  servers: [
    { url: '/', description: 'This server' },
    { url: 'https://drone-tag-hixr.onrender.com', description: 'Render (test hosting)' },
    { url: 'http://localhost:4000', description: 'Local' },
  ],
  tags: [
    { name: 'Health', description: 'Is the service running?' },
    { name: 'Location & images', description: 'What the drone tags send. No login.' },
    { name: 'Read data', description: 'Positions, flights, distance and images. No login.' },
    { name: 'Telemetry', description: 'Battery, flight / spray status and other readings. No login.' },
    { name: 'Configuration files', description: 'Mission plans, parameter and settings files. No login.' },
    { name: 'Data packets', description: 'id, lat, lon, Alt, Alt_R, d_x / d_y / d_z. Shown live on the dashboard\'s Data packets page. No login.' },
    { name: 'Dashboard', description: 'Used by the web dashboard. Needs the login cookie.' },
    { name: 'Accounts', description: 'Dashboard login and registration.' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Service status',
        description: 'On Render\'s free plan the first request after 15 idle minutes can take up to a minute.',
        responses: { 200: ok('Running', ref('Health')) },
      },
    },

    '/api/data': {
      post: {
        tags: ['Location & images'],
        summary: 'Send a position, an image, or a dashboard setting',
        description: [
          'One endpoint, three kinds of body (the type is worked out from the body itself, so a wrong',
          '`Content-Type` from a modem does not matter):',
          '',
          '1. **JSON position**: `TrackerId`, `Latitude`, `Longitude`, optional `Altitude`, `Timestamp`.',
          '   Lower-case keys (`trackerId`, `lat`, `lon`, `alt`, `ts`) also work.',
          '2. **form-data**: the same fields as text, plus a file field `image` (any image type, max 15 MB).',
          '3. **Raw image file** as the body (what the camera board sends), with the details in the URL:',
          '   `?trackerId=&lat=&lon=&alt=&ts=&filename=`.',
          '',
          'Dashboard settings use the same endpoint: `{"intervalMs": 10000}` sets the default delay,',
          '`{"action": "reset"}` deletes all data.',
          '',
          'Base64 images inside JSON are refused. SVG is refused (it can contain scripts).',
        ].join('\n'),
        parameters: [
          { name: 'trackerId', in: 'query', description: 'Raw image body only: Tracker ID (e.g. CAM-01). Leave empty when sending JSON or form-data', schema: { type: 'string' } },
          { name: 'lat', in: 'query', description: 'Raw image body only: latitude', schema: { type: 'number' } },
          { name: 'lon', in: 'query', description: 'Raw image body only: longitude', schema: { type: 'number' } },
          { name: 'alt', in: 'query', description: 'Raw image body only: altitude in metres', schema: { type: 'number' } },
          { name: 'ts', in: 'query', description: 'Raw image body only: device time, IST "YYYY-MM-DD HH:MM:SS"', schema: { type: 'string' } },
          { name: 'filename', in: 'query', description: 'Raw image body only: original file name (helps for RAW camera formats)', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { oneOf: [ref('PositionIn'), ref('SettingIn')] },
              examples: {
                position: { summary: 'GPS position', value: EXAMPLE_POSITION },
                setDelay: { summary: 'Dashboard: set the default delay to 10 s', value: { intervalMs: 10000 } },
              },
            },
            'multipart/form-data': {
              schema: {
                allOf: [ref('PositionIn')],
                properties: { image: { type: 'string', format: 'binary', description: 'Image file (any image type, max 15 MB)' } },
              },
            },
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          200: ok('Stored', ref('UploadReply'), { status: 'ok', intervalMs: 5000, photoId: null }),
          400: err('Bad data: invalid JSON, missing coordinates, not an image, base64 in JSON, delay out of range'),
          413: err('Image larger than 15 MB'),
        },
      },
      get: {
        tags: ['Read data'],
        summary: 'All trackers together',
        description: 'Everything for every tracker, plus each tracker\'s latest flight in `trackerStatus`. The live map uses this.',
        parameters: [{ name: 'since', in: 'query', description: 'Only points with `seq` greater than this', schema: { type: 'integer' } }],
        responses: { 200: ok('All data', ref('AllData')) },
      },
    },

    '/api/data/{trackerId}': {
      get: {
        tags: ['Read data'],
        summary: 'One tracker: positions, flights, distance, images',
        description: [
          'Returns that tracker\'s points (oldest first), images, flights (`sessions`) and the latest flight (`session`).',
          '',
          'A flight ends after `offlineAfterMs` without data. Each flight has a `distance` summary: distance flown',
          '(sum of all GPS hops, ignoring jitter under 3 m and bad GPS fixes), straight line, start–end box and',
          'area box. Each point has `distanceFromStartM`; a skipped bad GPS fix has `gpsJump: true`.',
          '',
          'With `?photo=<photoId>` (or `?photo=latest`) the reply is **the image file itself**.',
        ].join('\n'),
        parameters: [
          trackerPath,
          { name: 'since', in: 'query', description: 'Only points with `seq` greater than this', schema: { type: 'integer' } },
          { name: 'photo', in: 'query', description: 'Leave empty for JSON. A photoId (or `latest`) returns that image file instead', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'Tracker data (JSON), or the image file with `?photo=`',
            content: {
              ...json(ref('TrackerData')),
              'image/*': { schema: { type: 'string', format: 'binary' } },
            },
          },
          404: err('No data for this tracker, or image not found'),
        },
      },
    },

    '/api/telemetry': {
      post: {
        tags: ['Telemetry'],
        summary: 'Send telemetry',
        description: [
          'JSON only (`Content-Type: application/json`). `TrackerId` and at least one value are required.',
          'Field names may also be written `batteryPercent` or `battery_percent`. A position in telemetry',
          'also moves the drone on the map. Unknown fields are reported in `ignoredFields`.',
        ].join('\n'),
        requestBody: {
          required: true,
          content: json(ref('TelemetryIn'), {
            TrackerId: 'DRONE-01', Timestamp: '2026-11-20 10:00:05', BatteryPercent: 76, BatteryVoltage: 22.4,
            FlightStatus: 'FLYING', SprayStatus: 'ON', TankLevelPercent: 54, FlowRateLpm: 1.8, SpeedMps: 5.2,
            HeadingDeg: 90, Satellites: 14, SignalDbm: -71, Latitude: 23.0581, Longitude: 72.5212, Altitude: 12,
            Extra: { pumpTempC: 41.5 },
          }),
        },
        responses: {
          201: ok('Stored', ref('TelemetryReply'), { status: 'ok', intervalMs: 5000, telemetryId: '1795085469296-12', seq: 12 }),
          400: { description: 'Invalid telemetry (every problem is listed in `errors`)', content: json(ref('Error')) },
        },
      },
      get: {
        tags: ['Telemetry'],
        summary: 'Latest telemetry of every tracker',
        responses: { 200: ok('Latest record per tracker', ref('TelemetryAll')) },
      },
    },

    '/api/telemetry/{trackerId}': {
      get: {
        tags: ['Telemetry'],
        summary: 'Telemetry of one tracker',
        parameters: [
          trackerPath,
          { name: 'since', in: 'query', description: 'Only records with `seq` greater than this', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', description: 'At most this many records (newest kept)', schema: { type: 'integer', default: 100, minimum: 1, maximum: 1000 } },
        ],
        responses: { 200: ok('Latest record and recent records', ref('TelemetryOne')), 404: err('No telemetry for this tracker') },
      },
    },

    '/api/config': {
      post: {
        tags: ['Configuration files'],
        summary: 'Upload a configuration file',
        description: [
          'Text files only, max 1 MB: `.json .plan .yaml .yml .xml .csv .txt .cfg .conf .ini .param .params .waypoints`.',
          'JSON files must be valid JSON. Send as form-data (file field `file`), or as the raw body with',
          '`?trackerId=&filename=` in the URL.',
        ].join('\n'),
        parameters: [
          { name: 'trackerId', in: 'query', description: 'Raw body only: Tracker ID', schema: { type: 'string' } },
          { name: 'filename', in: 'query', description: 'Raw body only: file name with extension, e.g. params.txt', schema: { type: 'string' } },
          { name: 'description', in: 'query', description: 'Raw body only: short description', schema: { type: 'string', maxLength: 200 } },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['TrackerId', 'file'],
                properties: {
                  TrackerId: { type: 'string', example: 'DRONE-01' },
                  Description: { type: 'string', maxLength: 200, example: 'Spray mission, field 7' },
                  file: { type: 'string', format: 'binary' },
                },
              },
            },
            'text/plain': { schema: { type: 'string' }, example: 'SPRAY_RATE=1.8\nALTITUDE=3\n' },
          },
        },
        responses: {
          201: ok('Stored', ref('ConfigReply')),
          400: err('Missing Tracker ID / file name, type not allowed, not text, invalid JSON'),
          413: err('File larger than 1 MB'),
        },
      },
    },

    '/api/config/{trackerId}': {
      get: {
        tags: ['Configuration files'],
        summary: 'List or download a tracker\'s configuration files',
        parameters: [
          trackerPath,
          { name: 'file', in: 'query', description: 'Leave empty for the list. A config id (or `latest`) downloads that file', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'The list (JSON), or the file itself with `?file=`', content: { ...json(ref('ConfigList')), 'text/plain': { schema: { type: 'string' } } } },
          404: err('Configuration file not found'),
        },
      },
    },

    '/api/packet': {
      post: {
        tags: ['Data packets'],
        summary: 'Send a data packet (or a batch of up to 100)',
        description: [
          'Body: one packet as a JSON object, or up to 100 packets as a JSON array (all are stored, or none if any is invalid).',
          'Format: `{"id": "1005", "lat": 23.078143, "lon": 72.531243, "Alt": 16.5, "Alt_R": "AGL", "d_x": 0.32, "d_y": -0.18, "d_z": 0.19}`.',
          'Only `id`, `lat` and `lon` are required; missing values are stored as `null`. `id` may be text or a whole number.',
          '',
          'Field names ignore case, spaces, `_` and `-` (`Alt_R` = `alt_r` = `AltR`; `d_x` = `dx`). The earlier long names',
          'also work: `TrackerId`, `Latitude`, `long` / `Longitude`, `Altitude`, `Altitude Reference`, `delta_x` / `deltaX` (and `detla_x`).',
          'Numbers may be sent as text (`"16.5"`).',
          'Unknown fields are not stored and are listed in `ignoredFields`. A missing or wrong `Content-Type` is fine.',
          '',
          'Every new packet appears at once, without refreshing, on the dashboard page **Data packets** (`/packets`).',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { oneOf: [ref('PacketIn'), { type: 'array', minItems: 1, maxItems: 100, items: ref('PacketIn') }] },
              examples: {
                packet: {
                  summary: 'One data packet',
                  value: { id: '1005', lat: 23.078143, lon: 72.531243, Alt: 16.5, Alt_R: 'AGL', d_x: 0.32, d_y: -0.18, d_z: 0.19 },
                },
                batch: {
                  summary: 'A batch of packets (e.g. sent after a network drop)',
                  value: [
                    { id: '1005', lat: 23.078160, lon: 72.531260, Alt: 16.8, Alt_R: 'AGL', d_x: 0.35, d_y: -0.16, d_z: 0.21, Timestamp: '2026-11-21 10:00:01' },
                    { id: '1005', lat: 23.078178, lon: 72.531277, Alt: 17.1, Alt_R: 'AGL', d_x: 0.38, d_y: -0.15, d_z: 0.22, Timestamp: '2026-11-21 10:00:02' },
                  ],
                },
              },
            },
          },
        },
        responses: {
          201: ok('Stored', ref('PacketReply'), { status: 'ok', intervalMs: 5000, packetId: '1795257467081-1', seq: 1 }),
          400: err('Invalid packet: every problem is listed in `errors` (for a batch: "packet N: ...")'),
          413: err('Body larger than 1 MB'),
        },
      },
      get: {
        tags: ['Data packets'],
        summary: 'Newest data packets of every drone',
        parameters: [
          { name: 'since', in: 'query', description: 'Only packets with `seq` greater than this', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', description: 'At most this many (the newest), oldest first', schema: { type: 'integer', default: 200, minimum: 1, maximum: 5000 } },
        ],
        responses: { 200: ok('Packets', ref('PacketList')) },
      },
    },

    '/api/packet/{trackerId}': {
      get: {
        tags: ['Data packets'],
        summary: 'Data packets of one drone',
        parameters: [
          trackerPath,
          { name: 'since', in: 'query', description: 'Only packets with `seq` greater than this', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', description: 'At most this many (the newest), oldest first', schema: { type: 'integer', default: 200, minimum: 1, maximum: 5000 } },
        ],
        responses: { 200: ok('Packets', ref('PacketList')), 404: err('No data packets for this drone') },
      },
    },

    '/api/packet-stream': {
      get: {
        tags: ['Data packets'],
        summary: 'Live feed of new packets (Server-Sent Events)',
        description: [
          'Stays open and sends each new packet the moment it is stored, as `event: packet` with `id: <seq>` and',
          '`data: <packet JSON>`. `event: reset` means all data was cleared. A comment line every 25 s keeps it open.',
          'In a browser: `new EventSource("/api/packet-stream?trackerId=DRONE-01")`; it reconnects by itself and gets the',
          'packets it missed (via `Last-Event-ID`). The Data packets page uses this. "Try it out" waits forever here.',
        ].join('\n'),
        parameters: [
          { name: 'trackerId', in: 'query', description: 'Only this drone (empty = every drone)', schema: { type: 'string' } },
          { name: 'since', in: 'query', description: 'First send the stored packets with `seq` greater than this', schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'An endless stream of events',
            content: { 'text/event-stream': { schema: { type: 'string' }, example: 'id: 12\nevent: packet\ndata: {"id":"1795257467081-12","trackerId":"DRONE-01","lat":23.0581,"long":72.5212,...}\n\n' } },
          },
        },
      },
    },

    '/api/interval/{trackerId}': {
      get: {
        tags: ['Dashboard'], security: cookie,
        summary: 'A drone\'s own transmission delay',
        parameters: [trackerPath],
        responses: { 200: ok('Delay', ref('IntervalInfo')), 400: err('Invalid Tracker ID'), 401: err('Not logged in') },
      },
      put: {
        tags: ['Dashboard'], security: cookie,
        summary: 'Set a drone\'s own transmission delay',
        description: 'The drone receives it as `intervalMs` in the reply to its next upload. `{"intervalMs": null}` returns it to the default.',
        parameters: [trackerPath],
        requestBody: { required: true, content: json({ type: 'object', properties: { intervalMs: { type: 'integer', nullable: true, minimum: 1000, maximum: 300000 } } }, { intervalMs: 10000 }) },
        responses: { 200: ok('Saved', ref('IntervalInfo')), 400: err('Out of range'), 401: err('Not logged in') },
      },
    },

    '/api/drones': {
      get: {
        tags: ['Dashboard'], security: cookie,
        summary: 'Registered drones',
        responses: {
          200: ok('Drones', { type: 'object', properties: { status: { type: 'string' }, drones: { type: 'array', items: ref('Drone') } } }),
          401: err('Not logged in'),
        },
      },
    },

    '/api/export/{trackerId}/csv': {
      get: {
        tags: ['Dashboard'], security: cookie,
        summary: 'Download a tracker\'s positions as CSV',
        description: 'Times in IST. Columns: tracker_id, date_time_ist, latitude, longitude, altitude, device_timestamp, photo_id, photo_url, distance_from_start_m.',
        parameters: [trackerPath],
        responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: { type: 'string' } } } }, 401: err('Not logged in'), 404: err('No data') },
      },
    },

    '/api/export/{trackerId}/images.zip': {
      get: {
        tags: ['Dashboard'], security: cookie,
        summary: 'Download a tracker\'s images as ZIP',
        parameters: [trackerPath],
        responses: { 200: { description: 'ZIP file', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } }, 401: err('Not logged in'), 404: err('No images') },
      },
    },

    '/auth/options': {
      get: {
        tags: ['Accounts'],
        summary: 'Choices for the registration form',
        responses: { 200: ok('Lists', { type: 'object', properties: {
          status: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } }, applications: { type: 'array', items: { type: 'string' } },
          autonomy: { type: 'array', items: { type: 'string' } }, ranges: { type: 'array', items: { type: 'string' } },
        } }) },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Accounts'],
        summary: 'Register a user and their drone (logs in)',
        requestBody: { required: true, content: json(ref('RegisterIn')) },
        responses: { 201: ok('Registered; the login cookie is set', ref('UserReply')), 400: err('Invalid fields (listed in `errors`)') },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Accounts'],
        summary: 'Log in (sets the login cookie)',
        requestBody: { required: true, content: json({ type: 'object', required: ['phone', 'password'], properties: {
          phone: { type: 'string', description: '10-digit Indian mobile number', example: '9000000001' }, password: { type: 'string', format: 'password' },
        } }) },
        responses: { 200: ok('Logged in', ref('UserReply')), 401: err('Wrong mobile number or password'), 429: err('Too many failed attempts (wait 15 minutes)') },
      },
    },
    '/auth/logout': {
      post: { tags: ['Accounts'], summary: 'Log out (clears the cookie)', responses: { 200: ok('Logged out', { type: 'object', properties: { status: { type: 'string' } } }) } },
    },
    '/auth/me': {
      get: {
        tags: ['Accounts'], security: cookie,
        summary: 'The logged-in user',
        responses: { 200: ok('User', ref('UserReply')), 401: err('Not logged in') },
      },
      put: {
        tags: ['Accounts'], security: cookie,
        summary: 'Change account / drone details (current password required)',
        requestBody: { required: true, content: json({ allOf: [ref('RegisterIn')], properties: { currentPassword: { type: 'string', format: 'password' } } }) },
        responses: { 200: ok('Saved', ref('UserReply')), 400: err('Invalid fields or wrong current password'), 401: err('Not logged in') },
      },
    },
  },

  components: {
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'dt_session', description: 'Set by /auth/login. Log in at /login in this browser, then requests from this page send it.' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'error' },
          message: { type: 'string', example: 'invalid or missing coordinates (Latitude/Longitude)' },
          errors: { description: 'Telemetry: a list of problems. Accounts: problems per field.', oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object', additionalProperties: { type: 'string' } }] },
          trackers: { type: 'array', items: { type: 'string' }, description: 'For an unknown Tracker ID: the trackers that have data' },
        },
      },
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' }, success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Drone Tag API is running' },
          startedAt: { type: 'string', format: 'date-time' }, serverTime: { type: 'string', format: 'date-time' },
        },
      },
      PositionIn: {
        type: 'object',
        required: ['TrackerId', 'Latitude', 'Longitude'],
        properties: {
          TrackerId: { type: 'string', example: 'DRONE-01' },
          Latitude: { oneOf: [{ type: 'number' }, { type: 'string' }], description: '-90..90', example: '23.057984' },
          Longitude: { oneOf: [{ type: 'number' }, { type: 'string' }], description: '-180..180', example: '72.521018' },
          Altitude: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Metres ("15" or "15m")', example: '15' },
          Timestamp: { type: 'string', description: 'Device time, IST "YYYY-MM-DD HH:MM:SS" (or ISO 8601 with zone, or Unix seconds)', example: '2026-11-20 10:00:00' },
        },
      },
      SettingIn: {
        type: 'object',
        description: 'Dashboard setting (no coordinates in the body)',
        properties: {
          intervalMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Default transmission delay' },
          action: { type: 'string', enum: ['reset'], description: 'Deletes ALL points, images, telemetry and configuration files' },
        },
      },
      UploadReply: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          intervalMs: { type: 'integer', description: 'Use this as the delay before the next upload (start to start)', example: 5000 },
          photoId: { type: 'string', nullable: true, description: 'ID of the stored image, or null' },
          message: { type: 'string', description: 'Settings only: "delay updated" / "cleared"' },
        },
      },
      Position: {
        type: 'object',
        properties: { lat: { type: 'number' }, lon: { type: 'number' }, receivedAt: { type: 'string', format: 'date-time' }, seq: { type: 'integer' } },
      },
      Point: {
        type: 'object',
        properties: {
          trackerId: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' },
          altitude: { type: 'string', nullable: true, example: '15m' },
          timestamp: { type: 'string', nullable: true, description: 'Device time as sent' },
          recordedAt: { type: 'string', format: 'date-time', description: 'When it was recorded (device time if believable)' },
          timeSource: { type: 'string', enum: ['device', 'server'] },
          receivedAt: { type: 'string', format: 'date-time' },
          maplink: { type: 'string' },
          photoId: { type: 'string', description: 'Present when an image came with this position' },
          photoUrl: { type: 'string' },
          seq: { type: 'integer', description: 'Increasing number; use with ?since=' },
          distanceFromStartM: { type: 'number', description: 'Distance flown from the start of this point\'s flight (metres)', example: 450 },
          gpsJump: { type: 'boolean', description: 'true: a bad GPS fix, not counted in the distance' },
        },
      },
      AreaBox: {
        type: 'object',
        description: 'Smallest north–south aligned rectangle around the flight (bad GPS fixes left out)',
        properties: {
          south: { type: 'number' }, north: { type: 'number' }, west: { type: 'number' }, east: { type: 'number' },
          widthM: { type: 'number', example: 593 }, heightM: { type: 'number', example: 343 }, areaM2: { type: 'integer', example: 203399 },
        },
      },
      Distance: {
        type: 'object',
        description: 'Distance covered in one flight (lib/distance.js)',
        properties: {
          flownM: { type: 'number', description: 'Distance flown along the path: sum of all GPS hops', example: 3700.5 },
          straightLineM: { type: 'number', description: 'Start to end in a straight line', example: 448.6 },
          startEndBox: {
            type: 'object', description: 'Rectangle with the start and end at opposite corners',
            properties: { eastWestM: { type: 'number' }, northSouthM: { type: 'number' }, alongSidesM: { type: 'number' } },
          },
          areaBox: ref('AreaBox'),
          durationSec: { type: 'integer' },
          avgSpeedKmh: { type: 'number', nullable: true },
          pointsUsed: { type: 'integer' },
          ignoredSmallMoves: { type: 'integer', description: 'GPS jitter under minStepM' },
          ignoredJumps: { type: 'integer', description: 'Bad GPS fixes skipped' },
          minStepM: { type: 'number', example: 3 },
          maxSpeedMps: { type: 'number', example: 50 },
        },
      },
      Session: {
        type: 'object',
        description: 'One flight. It ends after offlineAfterMs without data.',
        properties: {
          id: { type: 'string' }, number: { type: 'integer' },
          status: { type: 'string', enum: ['live', 'ended'] },
          startedAt: { type: 'string', format: 'date-time' }, lastSeenAt: { type: 'string', format: 'date-time' },
          endedAt: { type: 'string', format: 'date-time', nullable: true }, offlineAt: { type: 'string', format: 'date-time', nullable: true },
          start: ref('Position'),
          current: { allOf: [ref('Position')], nullable: true, description: 'Latest position while live' },
          end: { allOf: [ref('Position')], nullable: true, description: 'Last position once ended' },
          headingDeg: { type: 'integer', nullable: true },
          pointCount: { type: 'integer' }, firstSeq: { type: 'integer' }, lastSeq: { type: 'integer' },
          distance: ref('Distance'),
        },
      },
      Photo: {
        type: 'object',
        properties: {
          id: { type: 'string' }, trackerId: { type: 'string' }, originalName: { type: 'string', nullable: true },
          lat: { type: 'number', nullable: true }, lon: { type: 'number', nullable: true }, altitude: { type: 'string', nullable: true },
          timestamp: { type: 'string', nullable: true }, recordedAt: { type: 'string', format: 'date-time' }, receivedAt: { type: 'string', format: 'date-time' },
          timeSource: { type: 'string', enum: ['device', 'server'], description: 'Whether recordedAt is the device time or the arrival time' },
          size: { type: 'integer' }, mime: { type: 'string', example: 'image/jpeg' }, seq: { type: 'integer' },
          url: { type: 'string', example: '/api/data/CAM-01?photo=1792816047102-40' },
        },
      },
      TrackerData: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          trackerId: { type: 'string' },
          trackers: { type: 'array', items: { type: 'string' } },
          intervalMs: { type: 'integer', description: 'This drone\'s delay' },
          defaultIntervalMs: { type: 'integer' },
          offlineAfterMs: { type: 'integer', description: 'A flight ends after this long without data' },
          serverTime: { type: 'string', format: 'date-time' },
          generation: { type: 'integer', description: 'Changes when data is cleared or the server restarts' },
          seq: { type: 'integer' },
          pointCount: { type: 'integer' }, photoCount: { type: 'integer' },
          latest: { allOf: [ref('Point')], nullable: true },
          latestPhoto: { allOf: [ref('Photo')], nullable: true },
          points: { type: 'array', items: ref('Point') },
          photos: { type: 'array', items: ref('Photo') },
          sessions: { type: 'array', items: ref('Session') },
          session: { allOf: [ref('Session')], nullable: true, description: 'The latest flight' },
        },
      },
      AllData: {
        type: 'object',
        properties: {
          status: { type: 'string' }, trackerId: { type: 'string', nullable: true }, trackers: { type: 'array', items: { type: 'string' } },
          intervalMs: { type: 'integer' }, defaultIntervalMs: { type: 'integer' }, offlineAfterMs: { type: 'integer' },
          serverTime: { type: 'string', format: 'date-time' }, generation: { type: 'integer' }, seq: { type: 'integer' },
          pointCount: { type: 'integer' }, photoCount: { type: 'integer' },
          latest: { allOf: [ref('Point')], nullable: true }, latestPhoto: { allOf: [ref('Photo')], nullable: true },
          points: { type: 'array', items: ref('Point') }, photos: { type: 'array', items: ref('Photo') },
          trackerStatus: {
            type: 'array',
            items: { type: 'object', properties: { trackerId: { type: 'string' }, intervalMs: { type: 'integer' }, session: { allOf: [ref('Session')], nullable: true } } },
          },
        },
      },
      TelemetryIn: {
        type: 'object',
        required: ['TrackerId'],
        properties: {
          TrackerId: { type: 'string' },
          Timestamp: { type: 'string', description: 'Device time, IST "YYYY-MM-DD HH:MM:SS"' },
          BatteryPercent: { type: 'number', minimum: 0, maximum: 100 },
          BatteryVoltage: { type: 'number', minimum: 0, maximum: 100 },
          TankLevelPercent: { type: 'number', minimum: 0, maximum: 100 },
          FlowRateLpm: { type: 'number', minimum: 0, maximum: 1000, description: 'Litres per minute' },
          SpeedMps: { type: 'number', minimum: 0, maximum: 200 },
          HeadingDeg: { type: 'number', minimum: 0, maximum: 360, description: '0 = north; turns the map arrow' },
          Satellites: { type: 'integer', minimum: 0, maximum: 100 },
          SignalDbm: { type: 'number', minimum: -150, maximum: 0 },
          FlightStatus: { type: 'string', enum: ['IDLE', 'ARMED', 'TAKING_OFF', 'FLYING', 'HOVERING', 'RETURNING', 'LANDING', 'LANDED', 'ERROR'] },
          SprayStatus: { type: 'string', enum: ['OFF', 'ON', 'PAUSED', 'TANK_EMPTY', 'ERROR'] },
          Latitude: { type: 'number' }, Longitude: { type: 'number' }, Altitude: { type: 'number' },
          Extra: { type: 'object', description: 'Up to 30 more values: number, boolean or text (max 100 characters)', additionalProperties: true },
        },
      },
      TelemetryRecord: {
        type: 'object',
        properties: {
          id: { type: 'string' }, trackerId: { type: 'string' }, timestamp: { type: 'string' }, seq: { type: 'integer' },
          receivedAt: { type: 'string', format: 'date-time' },
          batteryPercent: { type: 'number' }, batteryVoltage: { type: 'number' }, tankLevelPercent: { type: 'number' },
          flowRateLpm: { type: 'number' }, speedMps: { type: 'number' }, headingDeg: { type: 'number' }, satellites: { type: 'integer' },
          signalDbm: { type: 'number' }, flightStatus: { type: 'string' }, sprayStatus: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' }, altitude: { type: 'string' }, extra: { type: 'object', additionalProperties: true },
        },
      },
      TelemetryReply: {
        type: 'object',
        properties: {
          status: { type: 'string' }, intervalMs: { type: 'integer' }, telemetryId: { type: 'string' }, seq: { type: 'integer' },
          ignoredFields: { type: 'array', items: { type: 'string' }, description: 'Fields the server did not recognise' },
        },
      },
      TelemetryAll: {
        type: 'object',
        properties: { status: { type: 'string' }, serverTime: { type: 'string', format: 'date-time' }, seq: { type: 'integer' }, latest: { type: 'array', items: ref('TelemetryRecord') } },
      },
      TelemetryOne: {
        type: 'object',
        properties: {
          status: { type: 'string' }, trackerId: { type: 'string' }, serverTime: { type: 'string', format: 'date-time' }, seq: { type: 'integer' },
          count: { type: 'integer' }, latest: ref('TelemetryRecord'), records: { type: 'array', items: ref('TelemetryRecord') },
        },
      },
      Config: {
        type: 'object',
        properties: {
          id: { type: 'string' }, trackerId: { type: 'string' }, originalName: { type: 'string' }, description: { type: 'string', nullable: true },
          mime: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' }, receivedAt: { type: 'string', format: 'date-time' },
          seq: { type: 'integer' }, url: { type: 'string' },
        },
      },
      PacketIn: {
        type: 'object',
        required: ['id', 'lat', 'lon'],
        properties: {
          id: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Drone / tag ID (1-64 letters, digits, ".", "_", "-"); a whole number is also fine', example: '1005' },
          lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude', example: 23.078143 },
          lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude', example: 72.531243 },
          Alt: { type: 'number', description: 'Altitude in metres (-1000..100000)', example: 16.5 },
          Alt_R: { oneOf: [{ type: 'string', maxLength: 40 }, { type: 'number' }], description: 'Altitude reference: what Alt is measured from, as text such as "MSL" / "AGL", or a number', example: 'AGL' },
          d_x: { type: 'number', description: 'Delta x (-1000000..1000000)', example: 0.32 },
          d_y: { type: 'number', description: 'Delta y', example: -0.18 },
          d_z: { type: 'number', description: 'Delta z', example: 0.19 },
          Timestamp: { type: 'string', description: 'Optional device time, IST "YYYY-MM-DD HH:MM:SS". Without it the arrival time is used.', example: '2026-11-21 10:00:00' },
        },
      },
      Packet: {
        type: 'object',
        description: 'A stored data packet',
        properties: {
          id: { type: 'string', description: 'Packet ID given by the server' },
          trackerId: { type: 'string', description: 'The packet\'s "id"' },
          lat: { type: 'number' }, long: { type: 'number' },
          altitude: { type: 'number', nullable: true },
          altitudeReference: { nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }] },
          deltaX: { type: 'number', nullable: true }, deltaY: { type: 'number', nullable: true }, deltaZ: { type: 'number', nullable: true },
          timestamp: { type: 'string', nullable: true, description: 'Device time as sent' },
          receivedAt: { type: 'string', format: 'date-time' },
          recordedAt: { type: 'string', format: 'date-time' },
          timeSource: { type: 'string', enum: ['device', 'server'] },
          seq: { type: 'integer' },
        },
      },
      PacketReply: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          intervalMs: { type: 'integer', description: 'Delay to use before the next upload' },
          packetId: { type: 'string', description: 'One packet: its ID' },
          count: { type: 'integer', description: 'Batch: how many were stored' },
          packetIds: { type: 'array', items: { type: 'string' }, description: 'Batch: their IDs' },
          seq: { type: 'integer' },
          ignoredFields: { type: 'array', items: { type: 'string' }, description: 'Fields that were not recognised (not stored)' },
        },
      },
      PacketList: {
        type: 'object',
        properties: {
          status: { type: 'string' }, trackerId: { type: 'string', nullable: true }, serverTime: { type: 'string', format: 'date-time' },
          seq: { type: 'integer' }, count: { type: 'integer', description: 'Packets kept for this view' },
          trackers: { type: 'array', items: { type: 'string' }, description: 'Drones that have data packets' },
          packets: { type: 'array', items: ref('Packet') },
        },
      },
      ConfigReply: { type: 'object', properties: { status: { type: 'string' }, intervalMs: { type: 'integer' }, config: ref('Config') } },
      ConfigList: { type: 'object', properties: { status: { type: 'string' }, trackerId: { type: 'string' }, count: { type: 'integer' }, configs: { type: 'array', items: ref('Config') } } },
      IntervalInfo: {
        type: 'object',
        properties: {
          status: { type: 'string' }, trackerId: { type: 'string' }, intervalMs: { type: 'integer' }, custom: { type: 'boolean', description: 'true: the drone has its own delay' },
          defaultIntervalMs: { type: 'integer' }, minIntervalMs: { type: 'integer' }, maxIntervalMs: { type: 'integer' },
        },
      },
      Drone: {
        type: 'object',
        properties: {
          trackerId: { type: 'string' }, uin: { type: 'string' }, category: { type: 'string' }, application: { type: 'string' },
          autonomy: { type: 'string' }, range: { type: 'string' }, owner: { type: 'string' },
        },
      },
      RegisterIn: {
        type: 'object',
        required: ['name', 'email', 'phone', 'password', 'trackerId', 'uin', 'category', 'application', 'autonomy', 'range'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 60 },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string', description: '10-digit Indian mobile number (6-9...)' },
          password: { type: 'string', format: 'password', description: '8+ characters with upper case, lower case and a digit' },
          trackerId: { type: 'string' },
          uin: { type: 'string', description: 'Drone UIN (3-40 letters, digits, - or /)' },
          category: { type: 'string', enum: ['Nano', 'Micro', 'Small', 'Medium', 'Large'] },
          application: { type: 'string', enum: ['Agriculture', 'Spraying', 'Surveillance', 'Mapping', 'Photography', 'Delivery', 'Other'] },
          autonomy: { type: 'string', enum: ['Manual', 'Partially Autonomous', 'Fully Autonomous'] },
          range: { type: 'string', enum: ['Close', 'Short', 'Mid', 'Long'] },
        },
      },
      UserReply: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          user: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' }, drone: ref('Drone'),
            },
          },
        },
      },
    },
  },
};
