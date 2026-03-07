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
cd server && node server.js          # Start backend at http://localhost:3001
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
- Connects to backend via `socket.io-client` — `VITE_BACKEND_DEV_URL` in dev, `VITE_BACKEND_RELEASE_URL` in prod
- Frontend sends `data:init` on connect; receives `airports:update`, `aircraft:update`, `fires:update`
- If backend is unreachable → auto-falls back to mock data (2s tick)
- Live mode indicator badge switches MOCK ↔ LIVE in the UI

**Mapbox layers** (all in single `useEffect` on map init):
- `aircraft-layer` — symbol, SVG icon, rotates by heading; callsign text below
- `flag-layer` — flag PNG above aircraft (`flagcdn.com`, bypasses Mapbox SDF color-emoji limit)
- `fire-heat-layer` — heatmap, zoom 6–9
- `fire-circle-layer` — circles, minzoom 9
- `airport-circle-layer` / `airport-label-layer` — large airports, visible by default
- `airport-other-*` — other airports, hidden by default (toggleable)
- Layer visibility toggled via `map.setLayoutProperty(id, 'visibility', ...)`

**Flag loading:** `preloadAllFlags(map)` fires ~75 parallel `map.loadImage()` calls at `map.on('load')` — all COUNTRY_CODE flags ready before any aircraft arrives. `_flagRequested` Set prevents duplicates.

**Key expression gotcha (Mapbox GL JS v3):** `['get', 'brightness']` returns untyped value — always wrap with `['to-number', ['get', 'brightness'], 0]` in paint expressions.

**Region persistence:** `localStorage` key `sentinel_region` — 9 regions (IRAN default).

### Backend (`server/server.js`)
Express + Socket.io. All `res.json()` responses are pretty-printed (`app.set('json spaces', 2)`).

**Aircraft sources:** OpenSky REST API (primary) → `airplanes.live` automatic fallback if OpenSky fails (429 / cloud IP timeout).

**Push events with jitter scheduling** (avoids rate-limit patterns):
- `aircraft:update` — base `AIRCRAFT_INTERVAL_MS` + random(0, base × `INTERVAL_JITTER_MULTIPLIER`)
- `fires:update` — base `FIRMS_INTERVAL_MS` + jitter
- `airports:update` — once per client on `data:init`; fetched from OurAirports CSV if cache empty

**Cache:** `server/cache/` — timestamped CSV files:
- `aircraft_<ts>.csv` — keep latest 1, rest deleted after each fetch
- `fires_<ts>.csv` — files older than 24h deleted after each fetch
- `airports.csv` — single overwrite (rarely changes)

Served from CSV on `data:init`, not from in-memory state. All three responses sent in parallel (async IIFEs, no sequential blocking).

**REST endpoints:**
- `GET /api/health` — status + uptime + counts (pretty JSON)
- `GET /api/aircraft`, `/api/fires`, `/api/airports/me`
- `GET /api/airports`, `/api/flights` — AviationStack proxy (requires `AVIATIONSTACK_API_KEY`)

### Environment variables

**Frontend** (`.env`, gitignored):
```
VITE_MAPBOX_TOKEN=...
VITE_BACKEND_DEV_URL=http://localhost:3001
VITE_BACKEND_RELEASE_URL=https://...koyeb.app
```

**Backend** (`server/.env`, gitignored):
```
OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
NASA_FIRMS_MAP_KEY
FIREBASE_SERVICE_ACCOUNT          # JSON string (inline)
TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION
AVIATIONSTACK_API_KEY             # optional, for /api/airports and /api/flights proxies
AIRCRAFT_INTERVAL_MS=30000        # base interval ms
FIRMS_INTERVAL_MS=30000           # base interval ms
INTERVAL_JITTER_MULTIPLIER=3      # next = base + random(0, base × multiplier)
SAVE_OPENSKY_CSV=true             # optional: dump raw OpenSky responses to server/opensky_dumps/
SAVE_FIRMS_CSV=true               # optional: dump raw FIRMS responses to server/firms_dumps/
PORT=3001
```

### Hosting
- **Frontend:** Firebase Hosting (`firebase deploy --only hosting`)
- **Backend:** Koyeb (`server/` as root, `npm install` build, `node server.js` start)
- **Keep-alive:** UptimeRobot pings `/api/health` every 5min
