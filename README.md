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
| Hosting | Firebase Hosting (frontend), Koyeb (backend) |

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
VITE_BACKEND_RELEASE_URL=https://your-koyeb-app.koyeb.app
```

**`server/.env`**
```env
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
NASA_FIRMS_MAP_KEY=...
FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json
PORT=3001
```

`server/serviceAccount.json` — Firebase 서비스 계정 키 (Firebase Console → 프로젝트 설정 → 서비스 계정)

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
| OpenSky Network (ADS-B) | 22s | 4,000 req/day limit |
| NASA FIRMS VIIRS 375m | 10s | 5,000 req/10min limit |

---

## Features

### Live Mode (default)
- Real-time aircraft positions via ADS-B
- Fire hotspots from NASA satellite data, saved to Firestore
- Connection status indicator (LIVE / CONNECTING)

### Mock Mode
- **START** — generate simulation data for selected region
- **STOP** — pause simulation, data remains on map
- **CLR** — clear all simulation data
- Region change during simulation immediately reseeds data
- Mock data is NOT saved to Firestore

### Fire Time Window Filter
Filter hotspots by acquisition time: **1H / 6H / 12H / 24H**

### Aircraft Filter
Filter by type: **ALL / MILITARY / CIVILIAN**

---

## Deployment

```bash
# Frontend → Firebase Hosting
npm run build && firebase deploy --only hosting

# Backend → Koyeb (auto-deploy on push)
git push origin main
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status + data counts |
| `GET /api/aircraft` | Current aircraft data |
| `GET /api/fires` | Current fire hotspot data |

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
