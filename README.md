# MESAFE — Middle East Safety Dashboard

Real-time conflict monitoring dashboard for the Middle East.
Aircraft tracking (ADS-B), fire hotspots (NASA FIRMS), and simulation mode.

**Live:** https://conflict-safety-dashboard.web.app

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Vite + React 19, Mapbox GL JS v3, Tailwind CSS v3 |
| Backend | Node.js + Express + Socket.io |
| Database | Firebase Firestore |
| Hosting | Firebase Hosting (frontend), Render.com (backend) |

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
VITE_BACKEND_RELEASE_URL=https://your-render-app.onrender.com
```

**`server/.env`**
```env
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
NASA_FIRMS_MAP_KEY=...
FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json
PORT=3001
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
http://localhost:3001/api/health
```

---

## Data Sources

| Source | Interval | Notes |
|--------|----------|-------|
| OpenSky Network (ADS-B) | 15s | OAuth — may time out from cloud IPs |
| NASA FIRMS VIIRS 375m | 5min | 5,000 req/10min limit |

---

## Features

### Live Mode (default)
- Real-time aircraft positions via ADS-B (OpenSky Network)
- Fire hotspots from NASA FIRMS satellite data, saved to Firestore
- Connection status indicator (LIVE / CONNECTING / MOCK)
- If backend is unreachable, auto-falls back to mock data

### Mock Mode
- **START** — generate simulation data for selected region, download CSV on STOP
- **STOP** — pause simulation, download mock data as CSV
- **CLR** — clear all simulation data
- Region change during simulation immediately reseeds data
- Mock data is NOT saved to Firestore
- Mock aircraft have OpenSky-compatible fields

### Map Layers
- **Aircraft** — SVG icons, rotate by heading; military (red), civilian (green)
- **Fires** — heatmap (zoom < 9), circles (zoom >= 9)
- **Airports** — international airports shown by default; other airports toggleable
- Country flag emoji rendered above each aircraft via canvas (bypasses Mapbox SDF font limit)
- Callsign text below each aircraft icon

### Aircraft Popup
- ICAO, callsign, altitude, speed, heading
- FlightAware schedule link for airline callsigns

### Airport Popup
- Name, ICAO/IATA, type, elevation
- FlightAware departures link

### Fire Time Window Filter
Filter hotspots by acquisition time: **1H / 6H / 12H / 24H**

### Aircraft Filter
Filter by type: **ALL / MILITARY / CIVILIAN**

---

## Deployment

```bash
# Frontend → Firebase Hosting
npm run build && firebase deploy --only hosting

# Backend → Render.com (auto-deploy on push to main)
git push origin main
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status + data counts |
| `GET /api/aircraft` | Current aircraft data |
| `GET /api/fires` | Current fire hotspot data |
| `GET /api/airports/me` | Middle East airport data |

---

## Firestore Schema

Collection: `fire_hotspots`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Doc ID: `fire-{date}-{time}-{lat}-{lon}` |
| `coords` | array | `[lon, lat]` |
| `acqTimestamp` | number | UTC milliseconds |
| `acqDate` | string | `YYYY-MM-DD` |
| `acqTime` | string | `HHMM` UTC |
| `brightness` | number | Normalized 0–1 |
| `frp` | number | Fire Radiative Power (MW) |
| `intensity` | string | LOW / MEDIUM / HIGH / EXTREME |
| `confidence` | string | h / m / l / nominal |
