require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const axios = require('axios')
const readline = require('readline')

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
let osintEvents = []

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
    console.log(`[Auth] Token obtained — expires in ${res.data.expires_in}s`)
    return _accessToken
  } catch (err) {
    console.error('[Auth] Token request failed:', err.response?.data?.error_description || err.message)
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

  console.log(`[Routes] Fetching routes for ${uncached.length} new aircraft…`)
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
    console.log(`[Routes] ${enriched} routes resolved  (cache size: ${routeCache.size})`)
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
          console.warn('[OpenSky] 401 — token refreshed, retrying…')
          res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers: retryHeaders, timeout: 20000 })
        } else {
          // No credentials configured — fall back to anonymous
          console.warn('[OpenSky] 401 — falling back to anonymous request')
          res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers: { 'User-Agent': 'SentinelDashboard/0.2' }, timeout: 20000 })
        }
      } else {
        throw authErr
      }
    }

    if (res.status === 404 || !res.data?.states) {
      console.log('[OpenSky] No states returned')
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
    console.log(`[OpenSky] ${aircraftData.length} aircraft  (${milCount} mil  ${withRoute} with route)`)

    // Fetch missing routes in background — won't block next interval
    enrichRoutesInBackground(aircraftData).catch(err =>
      console.error('[Routes] Background enrichment error:', err.message)
    )
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('[OpenSky] Rate limited (429) — will retry next interval')
    } else {
      console.error('[OpenSky] Fetch error:', err.message)
    }
  }
}

// ─── NASA FIRMS (VIIRS 375m) ──────────────────────────────────────────────────
// Middle East bounding box: west=29, south=22, east=60, north=42

async function fetchFIRMS() {
  const mapKey = process.env.NASA_FIRMS_MAP_KEY
  if (!mapKey) {
    console.warn('[FIRMS] NASA_FIRMS_MAP_KEY not set — skipping')
    return
  }

  try {
    // Bounding box: west,south,east,north — last 1 day, VIIRS SNPP NRT
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/VIIRS_SNPP_NRT/29,22,60,42/1`
    const res = await axios.get(url, { timeout: 30000 })

    const lines = res.data.trim().split('\n')
    if (lines.length < 2) {
      console.log('[FIRMS] No fire data returned')
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

      if (isNaN(lat) || isNaN(lon)) continue

      fires.push({
        id: `fire-${i}-${vals[5]}`,
        coords: [lon, lat],
        brightness: Math.min(1, Math.max(0, (brightness - 300) / 200)),
        frp,
        confidence,
        acqDate: vals[5] || '',
        acqTime: vals[6] || '',
        intensity: frp > 100 ? 'EXTREME' : frp > 50 ? 'HIGH' : frp > 10 ? 'MEDIUM' : 'LOW',
      })
    }

    fireData = fires
    io.emit('fires:update', fireData)
    console.log(`[FIRMS] ${fireData.length} fire hotspots`)
  } catch (err) {
    console.error('[FIRMS] Fetch error:', err.message)
  }
}

// ─── Location dictionary (city/region → [lon, lat]) ─────────────────────────

const LOCATION_DICT = {
  'tehran': [51.3890, 35.6892],
  'isfahan': [51.6710, 32.6539],
  'shiraz': [52.5310, 29.5926],
  'tabriz': [46.3005, 38.0800],
  'mashhad': [59.6168, 36.2972],
  'gaza': [34.4668, 31.5017],
  'khan younis': [34.3064, 31.3470],
  'rafah': [34.2600, 31.2897],
  'jabaliya': [34.4843, 31.5320],
  'beirut': [35.4960, 33.8938],
  'tripoli': [35.8494, 34.4367],
  'tyre': [35.2036, 33.2705],
  'sidon': [35.3660, 33.5570],
  'jerusalem': [35.2137, 31.7683],
  'tel aviv': [34.7818, 32.0853],
  'haifa': [34.9896, 32.7940],
  'ramallah': [35.2095, 31.9038],
  'nablus': [35.2600, 32.2211],
  'jenin': [35.2985, 32.4587],
  'damascus': [36.2765, 33.5138],
  'aleppo': [37.1612, 36.2021],
  'deir ez-zor': [40.1410, 35.3360],
  'raqqa': [38.9980, 35.9500],
  'homs': [36.7200, 34.7324],
  'idlib': [36.6340, 35.9306],
  'baghdad': [44.3661, 33.3152],
  'mosul': [43.1189, 36.3356],
  'basra': [47.7804, 30.5085],
  'kirkuk': [44.3922, 35.4681],
  'erbil': [44.0090, 36.1901],
  'fallujah': [43.7866, 33.3509],
  'ramadi': [43.2964, 33.4258],
  'sanaa': [44.2066, 15.3694],
  'aden': [45.0356, 12.7797],
  'hodeida': [42.9541, 14.7978],
  'marib': [45.3220, 15.4580],
  'taiz': [44.0209, 13.5795],
  'riyadh': [46.6753, 24.6877],
  'jeddah': [39.1925, 21.4858],
  'mecca': [39.8261, 21.3891],
  'dubai': [55.2708, 25.2048],
  'abu dhabi': [54.3773, 24.4539],
  'doha': [51.5310, 25.2854],
  'kuwait': [47.9783, 29.3797],
  'amman': [35.9283, 31.9552],
  'cairo': [31.2357, 30.0444],
  'sinai': [34.0, 29.5],
  'west bank': [35.2433, 31.9466],
  'israel': [34.8516, 31.0461],
  'hezbollah': [35.5, 33.8],
  'hamas': [34.4668, 31.5017],
  'houthi': [44.2066, 15.3694],
  'idf': [34.8516, 31.0461],
  'iran': [53.6880, 32.4279],
}

function extractCoordinates(text) {
  // Explicit coords: "32.5°N 44.2°E" or "32.5N 44.2E"
  const coordRegex = /(\d+\.?\d*)\s*°?\s*[Nn],?\s*(\d+\.?\d*)\s*°?\s*[Ee]/
  const match = text.match(coordRegex)
  if (match) {
    return [parseFloat(match[2]), parseFloat(match[1])]
  }

  // Location dictionary match (longest match wins)
  const lower = text.toLowerCase()
  let bestMatch = null
  let bestLen = 0

  for (const [place, coords] of Object.entries(LOCATION_DICT)) {
    if (lower.includes(place) && place.length > bestLen) {
      bestMatch = coords
      bestLen = place.length
    }
  }

  if (bestMatch) {
    // Small random offset to avoid perfect overlaps
    return [
      bestMatch[0] + (Math.random() - 0.5) * 0.15,
      bestMatch[1] + (Math.random() - 0.5) * 0.15,
    ]
  }

  return null
}

function classifyEvent(text) {
  const lower = text.toLowerCase()
  if (/airstrike|air strike|bombing|missile strike|f-16|f-35|jet/.test(lower)) {
    return { type: 'AIRSTRIKE', severity: 'CRITICAL' }
  }
  if (/explosion|blast|detonat|struck|hit/.test(lower)) {
    return { type: 'EXPLOSION', severity: 'HIGH' }
  }
  if (/rocket|drone|uav|uavs|quadcopter|shaheed/.test(lower)) {
    return { type: 'DRONE', severity: 'HIGH' }
  }
  if (/ground operation|infantry|forces|troops|convoy|armored|tank/.test(lower)) {
    return { type: 'MOVEMENT', severity: 'MODERATE' }
  }
  if (/checkpoint|border crossing|crossing|roadblock/.test(lower)) {
    return { type: 'CHECKPOINT', severity: 'LOW' }
  }
  return { type: 'INTEL', severity: 'LOW' }
}

// ─── Telegram (GramJS) OSINT listener ────────────────────────────────────────

async function initTelegram() {
  const { TelegramClient } = require('telegram')
  const { StringSession } = require('telegram/sessions')
  const { NewMessage } = require('telegram/events')

  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0')
  const apiHash = process.env.TELEGRAM_API_HASH || ''

  if (!apiId || !apiHash) {
    console.log('[Telegram] API credentials not set — OSINT listener disabled')
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise(resolve => rl.question(q, resolve))

  const session = new StringSession(process.env.TELEGRAM_SESSION || '')

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
  })

  try {
    await client.start({
      phoneNumber: async () => ask('📱 Telegram phone number (with country code): '),
      password: async () => ask('🔐 2FA password (press Enter if none): '),
      phoneCode: async () => ask('📨 OTP code from Telegram: '),
      onError: (err) => console.error('[Telegram] Auth error:', err.message),
    })

    const savedSession = client.session.save()
    console.log('[Telegram] ✅ Connected!')
    console.log('[Telegram] 💾 Save this session string to .env → TELEGRAM_SESSION=')
    console.log(savedSession)
    rl.close()

    // Channels to monitor
    const OSINT_CHANNELS = [
      '@IntelSky',
      '@MiddleEastSpectator',
      '@OSINTdefender',
      '@intelslava',
    ]

    client.addEventHandler(async (event) => {
      try {
        const msg = event.message
        if (!msg?.message) return

        const text = msg.message
        if (text.length < 20) return // Skip very short messages

        const coords = extractCoordinates(text)
        if (!coords) return

        const { type, severity } = classifyEvent(text)

        const newEvent = {
          id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          coords,
          type,
          severity,
          description: text.replace(/\n/g, ' ').slice(0, 280),
          source: 'TELEGRAM',
          timestamp: Date.now(),
        }

        osintEvents = [newEvent, ...osintEvents].slice(0, 200)
        io.emit('osint:new', newEvent)
        console.log(`[Telegram] 📡 ${type} [${severity}] @ ${coords[1].toFixed(2)},${coords[0].toFixed(2)}`)
      } catch (handlerErr) {
        console.error('[Telegram] Handler error:', handlerErr.message)
      }
    }, new NewMessage({ chats: OSINT_CHANNELS }))

    console.log(`[Telegram] 👁️  Monitoring: ${OSINT_CHANNELS.join(', ')}`)
  } catch (err) {
    console.error('[Telegram] Failed to start:', err.message)
    rl.close()
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
      osint: osintEvents.length,
    },
  })
})

app.get('/api/aircraft', (req, res) => res.json(aircraftData))
app.get('/api/fires', (req, res) => res.json(fireData))
app.get('/api/osint', (req, res) => res.json(osintEvents))

// ─── Socket.io connection ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`)

  // Push current state to newly connected client
  socket.emit('aircraft:update', aircraftData)
  socket.emit('fires:update', fireData)
  socket.emit('osint:update', osintEvents)

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`)
  })
})

// ─── Start server ─────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║  SENTINEL // CONFLICT MONITOR — BACKEND  ║
║  http://localhost:${PORT}                    ║
╚══════════════════════════════════════════╝`)

  // Initial data fetch
  await Promise.all([fetchAircraft(), fetchFIRMS()])

  // Scheduled intervals
  setInterval(fetchAircraft, 15_000)   // Every 15s
  setInterval(fetchFIRMS, 300_000)     // Every 5min

  // Telegram OSINT (optional)
  initTelegram().catch(err => console.error('[Telegram] Init failed:', err.message))
})
