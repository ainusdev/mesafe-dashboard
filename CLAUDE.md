# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Frontend
```bash
npm run dev        # Dev server at http://localhost:5173
npm run build      # Production build → dist/
npm run preview    # Preview production build
```

### Backend
```bash
cd server && node server.js   # Start backend at http://localhost:3001
cd server && node --watch server.js  # Watch mode
```

### Deployment
```bash
npm run build && firebase deploy --only hosting   # Deploy frontend
git push origin main   # Push backend code (Koyeb auto-deploy)
```

### Health check
```
http://localhost:3001/api/health
```

## Architecture

Two separate apps — frontend (Vite/React) and backend (Node.js/Express) in `server/`.

### Frontend (`src/`)
Single-file app: **`src/App.jsx`** contains all logic — mock data engine, Mapbox map, and HUD UI. No routing, no component files, no state management library.

**Data flow:**
- Connects to backend via `socket.io-client` on `VITE_BACKEND_URL`
- If backend is unreachable → auto-falls back to mock data (2s tick)
- Live mode indicator badge switches MOCK ↔ LIVE in the UI

**Mapbox layers** (all in single `useEffect` on map init):
- `aircraft-layer` — symbol, SVG icon, rotates by heading
- `fire-heat-layer` — heatmap, zoom 6–9
- `fire-circle-layer` — circles, minzoom 9
- Layer visibility toggled via `map.setLayoutProperty(id, 'visibility', ...)`

**Key expression gotcha (Mapbox GL JS v3):** `['get', 'brightness']` returns untyped value — always wrap with `['to-number', ['get', 'brightness'], 0]` in paint expressions.

**Region persistence:** `localStorage` key `sentinel_region` — 12 regions (TEHRAN default).

### Backend (`server/server.js`)
Express + Socket.io. Pushes data to clients via events:
- `aircraft:update` — every 15s (OpenSky REST API)
- `fires:update` — every 5min (NASA FIRMS CSV API)

**Known limitation:** OpenSky OAuth times out from cloud provider IPs (Koyeb, fly.io, etc.) — aircraft falls back to mock on frontend. FIRMS works fine everywhere.

**REST endpoints:**
- `GET /api/health` — status + counts
- `GET /api/aircraft`, `/api/fires`, `/api/osint`

### Environment variables

**Frontend** (`.env`, gitignored):
```
VITE_MAPBOX_TOKEN=...
VITE_BACKEND_URL=https://api.mesafe.ainus.dev:10000   # or localhost:3001
```

**Backend** (`server/.env`, gitignored):
```
OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
NASA_FIRMS_MAP_KEY
TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION
PORT=3001
```

### Hosting
- **Frontend:** Firebase Hosting (`firebase deploy --only hosting`)
- **Backend:** Koyeb (`server/` as root, `npm install` build, `node server.js` start)
- **Keep-alive:** UptimeRobot pings `/api/health` every 5min
