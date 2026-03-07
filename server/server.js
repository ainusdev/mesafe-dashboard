require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const axios = require('axios')

// ─── Logger ──────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  red:    '\x1b[31m',
  orange: '\x1b[38;5;208m',
  lime:   '\x1b[92m',
  bold:   '\x1b[1m',
}

const TAG_COLOR = {
  Auth:      C.yellow,
  OpenSky:   C.cyan,
  Routes:    C.blue,
  FIRMS:     C.green,
  Firestore: C.magenta,
  Airports:  C.lime,
  Socket:    C.orange,
}

function log(tag, msg, level = 'info') {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const col  = TAG_COLOR[tag] || C.reset
  const lvl  = level === 'warn'  ? `${C.yellow}WARN${C.reset} ` :
               level === 'error' ? `${C.red}ERR ${C.reset} ` : ''
  process.stdout.write(`${C.gray}${ts}${C.reset} ${col}[${tag}]${C.reset} ${lvl}${msg}\n`)
}

// ─── Express + Socket.io setup ───────────────────────────────────────────────

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
})

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001

// ─── In-memory state ─────────────────────────────────────────────────────────

let aircraftData = []
let fireData = []
let airportData = []
let db = null

// ─── Firestore ────────────────────────────────────────────────────────────────

function initFirestore() {
  try {
    const admin = require('firebase-admin')
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT
      let credential

      if (raw) {
        // 1) Try parsing as JSON directly
        // 2) If that fails, treat as file path
        try {
          credential = admin.credential.cert(JSON.parse(raw))
          log('Firestore', 'Using service account from env var')
        } catch {
          const fs = require('fs')
          const json = JSON.parse(fs.readFileSync(raw, 'utf8'))
          credential = admin.credential.cert(json)
          log('Firestore', `Using service account from file: ${raw}`)
        }
      } else {
        // Application Default Credentials (firebase login / GCP)
        credential = admin.credential.applicationDefault()
        log('Firestore', 'Using Application Default Credentials')
      }

      admin.initializeApp({ credential, projectId: 'conflict-safety-dashboard' })
    }
    db = admin.firestore()
    log('Firestore', 'Connected to conflict-safety-dashboard')
  } catch (err) {
    log('Firestore', `Init failed — fires will not be persisted: ${err.message}`, 'warn')
  }
}

/** Save fire hotspots to Firestore. Doc ID is deterministic → deduplicates same satellite pass. */
async function saveFiresToFirestore(fires) {
  if (!db || fires.length === 0) return
  const col = db.collection('fire_hotspots')
  // Firestore batch limit = 500
  for (let i = 0; i < fires.length; i += 500) {
    const batch = db.batch()
    for (const f of fires.slice(i, i + 500)) {
      const docId = `${f.acqDate}-${String(f.acqTime).padStart(4, '0')}-${f.coords[1].toFixed(3)}-${f.coords[0].toFixed(3)}`
      batch.set(col.doc(docId), f)
    }
    await batch.commit()
  }
  log('Firestore', `${fires.length} hotspots saved`)
}

// ─── OurAirports — Middle East ───────────────────────────────────────────────

const ME_COUNTRIES = new Set(['IR','IQ','SA','AE','QA','KW','BH','OM','YE','JO','LB','SY','IL','PS'])

function parseCSVLine(line) {
  const result = []
  let cur = '', inQ = false
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ }
    else if (ch === ',' && !inQ) { result.push(cur); cur = '' }
    else { cur += ch }
  }
  result.push(cur)
  return result
}

async function fetchAirports() {
  try {
    const res = await axios.get('https://ourairports.com/data/airports.csv', { timeout: 30000 })
    const lines = res.data.trim().split('\n')
    const headers = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').trim())

    const airports = []
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i])
      if (vals.length < headers.length) continue

      const row = {}
      headers.forEach((h, idx) => { row[h] = (vals[idx] || '').replace(/"/g, '').trim() })

      if (!ME_COUNTRIES.has(row.iso_country)) continue
      if (!['large_airport', 'medium_airport', 'small_airport'].includes(row.type)) continue

      const lat = parseFloat(row.latitude_deg)
      const lon = parseFloat(row.longitude_deg)
      if (isNaN(lat) || isNaN(lon)) continue

      airports.push({
        id:           row.ident,
        name:         row.name,
        iata:         row.iata_code || '',
        icao:         row.ident,
        type:         row.type,
        country:      row.iso_country,
        municipality: row.municipality || '',
        coords:       [lon, lat],
        elevation:    parseInt(row.elevation_ft) || 0,
      })
    }

    airportData = airports
    log('Airports', `${airports.length} airports loaded (Middle East)`)
  } catch (err) {
    log('Airports', `Fetch error: ${err.message}`, 'error')
  }
}

// ─── OpenSky Network REST API ─────────────────────────────────────────────────
// GET /states/all with Middle East bounding box (free, no API key required)
// Docs: https://openskynetwork.github.io/opensky-api/rest.html
//
// OpenSky state vector field indices (§2.1):
//   0  icao24        ICAO 24-bit hex address
//   1  callsign      Callsign (8 chars, space-padded)
//   2  origin_country
//   3  time_position Unix timestamp of last position update
//   4  last_contact  Unix timestamp of last message received
//   5  longitude     WGS-84 degrees (null if unknown)
//   6  latitude      WGS-84 degrees (null if unknown)
//   7  baro_altitude Barometric altitude, metres (null on ground)
//   8  on_ground     Boolean
//   9  velocity      Ground speed, m/s
//  10  true_track    Heading degrees, 0=N clockwise
//  11  vertical_rate m/s, positive = climbing
//  12  sensors       Receiver IDs (may be null)
//  13  geo_altitude  Geometric altitude, metres
//  14  squawk        Transponder squawk code
//  15  spi           Special purpose indicator (bool)
//  16  position_source 0=ADS-B 1=ASTERIX 2=MLAT 3=FLARM

const OPENSKY_URL  = 'https://opensky-network.org/api/states/all'
const OPENSKY_AUTH = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'

// Middle East bounding box — south, north, west, east
const OPENSKY_BBOX = { lamin: 22, lamax: 42, lomin: 29, lomax: 60 }

const M_S_TO_KNOTS  = 1.94384
const METRES_TO_FEET = 3.28084

// ─── OAuth2 token manager ─────────────────────────────────────────────────────
// Fetches/caches a Bearer token via client_credentials grant.
// Token lifetime = 30 min; we refresh 60 s before expiry.

let _accessToken   = null
let _tokenExpiresAt = 0   // Date.now() ms

async function getAccessToken() {
  const clientId     = process.env.OPENSKY_CLIENT_ID
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  // Return cached token if still fresh
  if (_accessToken && Date.now() < _tokenExpiresAt - 60_000) return _accessToken

  try {
    const res = await axios.post(
      OPENSKY_AUTH,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 }
    )
    _accessToken    = res.data.access_token
    _tokenExpiresAt = Date.now() + res.data.expires_in * 1000
    log('Auth', `Token obtained — expires in ${res.data.expires_in}s`)
    return _accessToken
  } catch (err) {
    log('Auth', `Token request failed: ${err.response?.data?.error_description || err.message}`, 'error')
    _accessToken = null
    return null
  }
}

/** Returns headers object with Authorization: Bearer <token>, or empty if unauthenticated. */
async function getAuthHeaders() {
  const token = await getAccessToken()
  return {
    'User-Agent': 'SentinelDashboard/0.2',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

const MILITARY_CALLSIGN_PREFIXES = [
  'RCH', 'REACH', 'JAKE', 'PACK', 'DARK', 'SPAR', 'DOOM', 'HAVOC',
  'TOPCAT', 'DISCO', 'GHOST', 'WOLF', 'COBRA', 'EAGLE', 'VIPER',
  'RAVEN', 'MAGMA', 'BONE', 'BUFF', 'STEEL', 'BUCK', 'SWORD',
  'SULTAN', 'TORCH', 'ATLAS', 'FORCE', 'KNIGHT', 'DUKE',
]

// ICAO 24-bit hex ranges allocated to military operators
const MILITARY_HEX_RANGES = [
  { min: 0xAE0000, max: 0xAEFFFF }, // US Air Force
  { min: 0xA00000, max: 0xA3FFFF }, // US DoD (general)
  { min: 0x43C000, max: 0x43CFFF }, // UK Military
  { min: 0x3A8000, max: 0x3AFFFF }, // French military
  { min: 0x710000, max: 0x71FFFF }, // Israeli Air Force (IAF)
  { min: 0x730000, max: 0x73FFFF }, // Saudi military (RSAF)
]

function isMilitaryAircraft(icao24, callsign) {
  const cs = (callsign || '').trim().toUpperCase()
  if (MILITARY_CALLSIGN_PREFIXES.some(p => cs.startsWith(p))) return true

  const hex = parseInt(icao24 || '', 16)
  if (!isNaN(hex) && MILITARY_HEX_RANGES.some(r => hex >= r.min && hex <= r.max)) return true

  return false
}

/**
 * Parse a raw OpenSky state vector (17-element array) into a normalised record.
 * Returns null for vectors with no position fix.
 */
function parseStateVector(sv) {
  const lon = sv[5]
  const lat = sv[6]
  if (lon == null || lat == null) return null

  const icao24   = (sv[0] || '').trim().toLowerCase()
  const callsign = (sv[1] || '').trim()
  const baroM    = sv[7]
  const velMs    = sv[9]

  return {
    id:           icao24,
    callsign:     callsign || icao24.toUpperCase(),
    lat:          lat,
    lon:          lon,
    altitude:     baroM != null ? Math.round(baroM * METRES_TO_FEET) : 0,  // feet
    speed:        velMs != null ? Math.round(velMs * M_S_TO_KNOTS) : 0,     // knots
    heading:      sv[10] || 0,
    military:     isMilitaryAircraft(icao24, callsign),
    onGround:     !!sv[8],
    actype:       'UNKNOWN',    // OpenSky free tier does not provide aircraft type
    registration: '',
    origin:       null,
    destination:  null,
    route:        null,
    originCountry: sv[2] || '',
    squawk:       sv[14] || '',
    positionSource: ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][sv[16]] || 'UNKNOWN',
  }
}

// ─── Route Cache (/flights/aircraft) ─────────────────────────────────────────
// OpenSky /flights/aircraft returns departure/arrival airports (ICAO codes)
// for a specific aircraft over a given time window.
//
// Strategy: cache per icao24 with 2-hour TTL, enrich in background batches
// after each position fetch so the initial emit is never delayed.
//
// NOTE: /flights/aircraft requires authenticated requests (OPENSKY_USERNAME set).

const routeCache = new Map()   // icao24 → { origin, destination, route, cachedAt }
const ROUTE_TTL   = 2 * 60 * 60 * 1000   // 2 h — route won't change mid-flight
const ROUTE_BATCH = 3                     // parallel requests per batch
const ROUTE_BATCH_DELAY_MS = 800          // pause between batches (rate-limit headroom)


function getCachedRoute(icao24) {
  const entry = routeCache.get(icao24)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > ROUTE_TTL) { routeCache.delete(icao24); return null }
  return entry
}

/**
 * Call GET /flights/aircraft for one icao24 and return { origin, destination, route }.
 * Returns null on error or when no flight history is found.
 * Results (including negative) are stored in routeCache to skip repeated lookups.
 */
async function fetchFlightRoute(icao24) {
  const cached = getCachedRoute(icao24)
  if (cached) return cached

  // /flights/aircraft requires authentication
  if (!process.env.OPENSKY_CLIENT_ID) return null

  const now   = Math.floor(Date.now() / 1000)
  const begin = now - 86400   // look back 24 h

  try {
    const headers = await getAuthHeaders()
    const res = await axios.get('https://opensky-network.org/api/flights/aircraft', {
      params: { icao24, begin, end: now },
      headers,
      timeout: 12000,
    })

    const flights = Array.isArray(res.data) ? res.data : []

    if (flights.length === 0) {
      routeCache.set(icao24, { origin: null, destination: null, route: null, cachedAt: Date.now() })
      return null
    }

    // Pick the flight with the latest firstSeen (= current or most recent leg)
    const latest = flights.reduce((a, b) => (a.firstSeen > b.firstSeen ? a : b))
    const origin      = latest.estDepartureAirport || null   // ICAO 4-letter, e.g. "OMDB"
    const destination = latest.estArrivalAirport   || null
    const route       = (origin && destination) ? `${origin} → ${destination}` : null

    const entry = { origin, destination, route, cachedAt: Date.now() }
    routeCache.set(icao24, entry)
    return entry
  } catch (err) {
    if (err.response?.status === 404) {
      // No flight record — cache negative to avoid re-querying
      routeCache.set(icao24, { origin: null, destination: null, route: null, cachedAt: Date.now() })
    }
    // 429 = rate limited, 401 = bad auth — silently skip, retry next cycle
    return null
  }
}

/**
 * Enrich aircraftData with route info in the background (non-blocking).
 * Only queries aircraft whose icao24 is not yet in routeCache.
 * Emits updated aircraft:update to all clients as each batch completes.
 */
async function enrichRoutesInBackground(snapshot) {
  if (!process.env.OPENSKY_CLIENT_ID) return   // skip if no OAuth credentials

  const uncached = snapshot.filter(ac => !getCachedRoute(ac.id))
  if (uncached.length === 0) return

  log('Routes', `Fetching routes for ${uncached.length} new aircraft…`)
  let enriched = 0

  for (let i = 0; i < uncached.length; i += ROUTE_BATCH) {
    const batch = uncached.slice(i, i + ROUTE_BATCH)

    await Promise.all(batch.map(async ac => {
      const info = await fetchFlightRoute(ac.id)
      if (!info?.route) return

      // Patch the live aircraftData array in-place
      const idx = aircraftData.findIndex(a => a.id === ac.id)
      if (idx !== -1) { aircraftData[idx] = { ...aircraftData[idx], ...info }; enriched++ }
    }))

    // Push incremental update to clients after every batch
    io.emit('aircraft:update', aircraftData)

    if (i + ROUTE_BATCH < uncached.length) {
      await new Promise(r => setTimeout(r, ROUTE_BATCH_DELAY_MS))
    }
  }

  if (enriched > 0) {
    log('Routes', `${enriched} routes resolved  (cache size: ${routeCache.size})`)
  }
}

async function fetchAircraft() {
  try {
    const headers = await getAuthHeaders()

    let res
    try {
      res = await axios.get(OPENSKY_URL, {
        params: OPENSKY_BBOX,
        headers,
        timeout: 20000,
      })
    } catch (authErr) {
      if (authErr.response?.status === 401) {
        // Token may have expired mid-interval — force refresh and retry once
        _accessToken = null
        const retryHeaders = await getAuthHeaders()
        if (retryHeaders.Authorization) {
          log('OpenSky', '401 — token refreshed, retrying…', 'warn')
          res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers: retryHeaders, timeout: 20000 })
        } else {
          // No credentials configured — fall back to anonymous
          log('OpenSky', '401 — falling back to anonymous request', 'warn')
          res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers: { 'User-Agent': 'SentinelDashboard/0.2' }, timeout: 20000 })
        }
      } else {
        throw authErr
      }
    }

    if (res.status === 404 || !res.data?.states) {
      log('OpenSky', 'No states returned', 'warn')
      return
    }

    const parsed = res.data.states
      .map(parseStateVector)
      .filter(Boolean)
      .filter(ac => !ac.onGround)

    // Apply any already-cached routes before the first emit
    aircraftData = parsed.map(ac => {
      const cached = getCachedRoute(ac.id)
      return cached ? { ...ac, ...cached } : ac
    })

    const milCount = aircraftData.filter(a => a.military).length
    const withRoute = aircraftData.filter(a => a.route).length
    io.emit('aircraft:update', aircraftData)
    log('OpenSky', `${aircraftData.length} aircraft  (${milCount} mil  ${withRoute} with route)`)

    // Fetch missing routes in background — won't block next interval
    enrichRoutesInBackground(aircraftData).catch(err =>
      log('Routes', `Background enrichment error: ${err.message}`, 'error')
    )
  } catch (err) {
    if (err.response?.status === 429) {
      log('OpenSky', 'Rate limited (429) — will retry next interval', 'warn')
    } else {
      log('OpenSky', `Fetch error: ${err.message}`, 'error')
    }
  }
}

// ─── NASA FIRMS (VIIRS 375m) ──────────────────────────────────────────────────
// Middle East bounding box: west=29, south=22, east=60, north=42

async function fetchFIRMS() {
  const mapKey = process.env.NASA_FIRMS_MAP_KEY
  if (!mapKey) {
    log('FIRMS', 'NASA_FIRMS_MAP_KEY not set — skipping', 'warn')
    return
  }

  try {
    // Bounding box: west,south,east,north — last 1 day, VIIRS SNPP NRT
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/VIIRS_SNPP_NRT/29,22,60,42/1`
    const res = await axios.get(url, { timeout: 30000 })

    const lines = res.data.trim().split('\n')
    if (lines.length < 2) {
      log('FIRMS', 'No fire data returned', 'warn')
      return
    }

    // CSV headers: latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,
    //              satellite,instrument,confidence,version,bright_ti5,frp,daynight,type
    const fires = []
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',')
      if (vals.length < 13) continue

      const lat = parseFloat(vals[0])
      const lon = parseFloat(vals[1])
      const brightness = parseFloat(vals[2]) // Kelvin, typically 300-500
      const frp = parseFloat(vals[12]) || 0  // Fire Radiative Power (MW)
      const confidence = vals[9] || 'n'       // h/m/l or 0-100
      const acqDate = vals[5] || ''
      const acqTime = vals[6] || ''

      if (isNaN(lat) || isNaN(lon)) continue

      // Parse acquisition time to UTC timestamp
      const t = String(acqTime).padStart(4, '0')
      const acqTimestamp = acqDate
        ? new Date(`${acqDate}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`).getTime()
        : Date.now()

      fires.push({
        id: `fire-${acqDate}-${t}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
        coords: [lon, lat],
        brightness: Math.min(1, Math.max(0, (brightness - 300) / 200)),
        frp,
        confidence,
        acqDate,
        acqTime,
        acqTimestamp,
        intensity: frp > 100 ? 'EXTREME' : frp > 50 ? 'HIGH' : frp > 10 ? 'MEDIUM' : 'LOW',
      })
    }

    fireData = fires
    io.emit('fires:update', fireData)
    log('FIRMS', `${fireData.length} fire hotspots`)

    saveFiresToFirestore(fires).catch(err =>
      log('Firestore', `Save error: ${err.message}`, 'error')
    )
  } catch (err) {
    log('FIRMS', `Fetch error: ${err.message}`, 'error')
  }
}


// ─── REST API endpoints ───────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    counts: {
      aircraft: aircraftData.length,
      fires: fireData.length,
    },
  })
})

app.get('/api/aircraft', (req, res) => res.json(aircraftData))
app.get('/api/fires', (req, res) => res.json(fireData))
app.get('/api/airports/me', (req, res) => res.json(airportData))

app.get('/api/airports', async (req, res) => {
  try {
    const r = await axios.get('http://api.aviationstack.com/v1/airports', {
      params: { access_key: process.env.AVIATIONSTACK_API_KEY, country_iso2: req.query.country, limit: 100 },
      timeout: 15000,
    })
    res.json(r.data.data || [])
  } catch (e) { console.error('[airports]', e.message); res.json([]) }
})

app.get('/api/flights', async (req, res) => {
  try {
    const r = await axios.get('http://api.aviationstack.com/v1/flights', {
      params: { access_key: process.env.AVIATIONSTACK_API_KEY, dep_iata: req.query.airport, flight_date: req.query.date, limit: 100 },
      timeout: 15000,
    })
    res.json(r.data.data || [])
  } catch (e) { console.error('[flights]', e.message); res.json([]) }
})

// ─── Socket.io connection ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  log('Socket', `Client connected: ${socket.id}`)

  // Push current state to newly connected client
  socket.emit('aircraft:update', aircraftData)
  socket.emit('fires:update', fireData)

  socket.on('disconnect', () => {
    log('Socket', `Client disconnected: ${socket.id}`)
  })
})

// ─── Start server ─────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║  SENTINEL // CONFLICT MONITOR — BACKEND  ║
║  http://localhost:${PORT}                    ║
╚══════════════════════════════════════════╝`)

  initFirestore()

  // Initial data fetch
  await Promise.all([fetchAircraft(), fetchFIRMS(), fetchAirports()])

  // Scheduled intervals
  setInterval(fetchAircraft, 22_000)   // Every 22s (4000 req/day limit)
  setInterval(fetchFIRMS, 10_000)      // Every 10s (FIRMS limit: 5000/10min)
  setInterval(async () => {            // Retry airports if initial fetch failed
    if (airportData.length === 0) await fetchAirports()
  }, 60_000)

})
