# MESAFE — Middle East Safety Dashboard

Real-time conflict monitoring dashboard for the Middle East.
Aircraft tracking (ADS-B), fire hotspots (NASA FIRMS + EUMETSAT MTG), airport data, and simulation mode.

**Live:** https://mesafe.ainus.dev
**Repository:** https://github.com/ainusdev/mesafe-dashboard

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Vite + React 19, Mapbox GL JS v3, Tailwind CSS v3 |
| Backend | Node.js + Express + Socket.io |
| Database | Firebase Firestore |
| Storage | Firebase Storage (CSV backups) |
| Hosting | Firebase Hosting (frontend), Koyeb (backend) |
| Analytics | Firebase Analytics, Cloudflare Web Analytics |

---

## Local Development

### Prerequisites

```bash
# Frontend
npm install

# Backend
cd server && npm install
```

### Environment Variables

**`.env`** (project root)
```env
VITE_MAPBOX_TOKEN=...
VITE_BACKEND_DEV_URL=http://localhost:3001
VITE_BACKEND_RELEASE_URL=https://api.mesafe.ainus.dev
```

**`server/.env`**
```env
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
NASA_FIRMS_MAP_KEY=...
EUMETSAT_CONSUMER_KEY=...
EUMETSAT_CONSUMER_SECRET=...
FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json
PORT=3001

# Polling intervals (default: 300000ms = 5min)
AIRCRAFT_INTERVAL_MS=300000
FIRMS_INTERVAL_MS=300000
INTERVAL_JITTER_MULTIPLIER=3
```

`server/serviceAccount.json` — Firebase service account key (Firebase Console → Project Settings → Service Accounts)

### Run

```bash
# Terminal 1 — Backend
cd server && node server.js

# Terminal 2 — Frontend
npm run dev
# http://localhost:5173
```

### Health Check

```
GET /health
→ { status, uptime, connections, counts: { aircraft, fires } }
```

---

## Data Sources

| Source | Default Interval | Notes |
|--------|----------|-------|
| OpenSky Network (ADS-B) | 5min + jitter | OAuth — may time out from cloud IPs |
| NASA FIRMS (VIIRS SNPP + NOAA-20 + MODIS) | 5min + jitter | 3 satellite sources merged, low-confidence filtered |
| EUMETSAT MTG (Meteosat FCI-2 CAP) | 5min + jitter | 10-min geostationary, OAuth2 auto-renewal |
| OurAirports (CSV) | On startup / on-demand | Large + medium airports |

Each fire source runs in parallel with a 45s hard timeout — one slow or failing source never blocks others.

---

## Features

### Live Mode (default)
- Real-time aircraft positions via ADS-B (OpenSky Network)
- Fire hotspots from NASA FIRMS + EUMETSAT satellite data
- Airport data from OurAirports
- Connection status indicator (LIVE / CONNECTING / MOCK)
- Auto-fallback to mock data if backend is unreachable

### Mock Mode
- **START** — generate simulation data for selected region
- **STOP** — pause simulation, download mock data as CSV
- **CLR** — clear all simulation data
- Region change during simulation immediately reseeds data

### Map Layers
- **Aircraft** — ✈️ emoji icons rotating by heading; callsign text below; country flag above
- **Fires** — heatmap (zoom < 9), 🔥 emoji icons (zoom ≥ 9)
- **Airports** — large airports visible by default; medium/small airports toggleable

### Fire Hotspot Details
- FRP-based sizing for visual intensity distinction
- Cluster popup: clicking overlapping hotspots shows aggregate stats (total/max/avg FRP, intensity breakdown)
- 4 data sources: VIIRS SNPP, VIIRS NOAA-20, MODIS, EUMETSAT MTG
- Low-confidence detections auto-filtered
- Cross-source deduplication (~500m proximity)

### Fire Time Window Filter
Filter hotspots by acquisition time: **6H / 12H / 24H**
Uses GPU-side `map.setFilter()` for instant response.
Selection persists across page refreshes.

### Aircraft Filter
Filter by type: **ALL / MILITARY / CIVILIAN**

---

## Data Persistence

### CSV Cache (`server/cache/`)
- Aircraft: timestamped CSV, keeps only latest file
- Fires: timestamped CSV per fetch, keeps 24h window, merged by ID on load
- Airports: single `airports.csv`, overwritten on each fetch

### Firebase Storage
- CSVs uploaded to Storage on save: `csv/{type}/{YYYY-MM-DD}/{filename}`
- Bulk upload of existing CSVs on server startup
- Hourly sync at :00

### Firestore
- On startup, fires are **always** merged from Firestore to ensure full 24h coverage (satellite pass timing can cause partial API results)
- Aircraft and airports restored from Firestore only when CSV cache is empty

---

## Deployment

```bash
# Frontend → Firebase Hosting
npm run build && firebase deploy --only hosting

# Backend → Koyeb (auto-deploy on push to main)
git push origin main
```

---

## API Endpoints

Base URL: `https://api.mesafe.ainus.dev`

| Endpoint | Description |
|----------|-------------|
| `GET /` | Full dashboard data (health + all datasets) |
| `GET /health` | Server status, uptime, socket connections, data counts |
| `GET /aircraft` | Current aircraft data |
| `GET /fires` | Current fire hotspot data |
| `GET /airports` | Middle East airport data |
| `GET /airspace` | Airport operational status (FlightAware) |

### Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `data:init` | Client → Server | Request initial data for all layers |
| `aircraft:update` | Server → Client | Aircraft position update |
| `fires:update` | Server → Client | Fire hotspot update |
| `airports:update` | Server → Client | Airport data update |
| `airspace:update` | Server → Client | Airport operational status update |

---

## Firestore Schema

**`aircraft_snapshots/latest`** — Latest aircraft positions (overwrite)

**`fire_snapshots/{timestamp}`** — Fire data per fetch cycle (24h retention)

| Field | Type | Description |
|-------|------|-------------|
| `fires` | array | Fire objects (chunked at 500 per doc) |
| `savedAt` | number | UTC milliseconds |
| `count` | number | Number of fires in chunk |

**Fire object fields:** `id`, `coords [lon,lat]`, `acqTimestamp`, `acqDate`, `acqTime`, `brightness` (0–1), `frp` (MW), `intensity` (LOW/MEDIUM/HIGH/EXTREME), `confidence` (h/m/l/nominal)

**`airport_snapshots/latest`** — Latest airport data (overwrite)
