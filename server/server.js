require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const axios = require('axios')
const fs = require('fs')
const path = require('path')

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
  Routes:    C.blue, // kept for log tag compatibility
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
const CACHE_DIR = path.join(__dirname, 'cache')

function ensureCacheDir() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }) }

/** Returns path to the latest cache file matching prefix, or null if none exists. */
function latestCacheFile(prefix) {
  if (!fs.existsSync(CACHE_DIR)) return null
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith(prefix + '_') && f.endsWith('.csv'))
    .sort()
  return files.length ? path.join(CACHE_DIR, files[files.length - 1]) : null
}

/** Returns a new timestamped cache path for the given prefix. */
function timestampedCachePath(prefix) {
  ensureCacheDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(CACHE_DIR, `${prefix}_${ts}.csv`)
}

/** Keep only the latest aircraft CSV; delete all others. */
function pruneAircraftCache() {
  if (!fs.existsSync(CACHE_DIR)) return
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('aircraft_') && f.endsWith('.csv'))
    .sort()
  files.slice(0, -1).forEach(f => {
    try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch {}
  })
}

/** Delete fires CSVs whose filename timestamp is older than 24 hours. */
function pruneFiresCache() {
  if (!fs.existsSync(CACHE_DIR)) return
  const cutoff = Date.now() - 24 * 3600 * 1000
  fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('fires_') && f.endsWith('.csv'))
    .forEach(f => {
      // filename: fires_2024-01-01T12-00-00.csv → parse back to ISO
      const iso = f.slice('fires_'.length, -4).replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')
      const ts = new Date(iso).getTime()
      if (!isNaN(ts) && ts < cutoff) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch {}
      }
    })
}

// ─── In-memory state ─────────────────────────────────────────────────────────

let aircraftData = loadAircraftCache()
let fireData     = loadFiresCache()
let airportData  = loadAirportsCache()
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

/** Save aircraft states to Firestore. Doc ID = icao24 → always overwrites with latest state. */
async function saveAircraftToFirestore(aircraft) {
  if (!db || aircraft.length === 0) return
  const col = db.collection('aircraft_states')
  for (let i = 0; i < aircraft.length; i += 500) {
    const batch = db.batch()
    for (const ac of aircraft.slice(i, i + 500)) {
      batch.set(col.doc(ac.id), { ...ac, updatedAt: Date.now() })
    }
    await batch.commit()
  }
  log('Firestore', `${aircraft.length} aircraft states saved`)
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
    saveAirportsCache(airportData)
    log('Airports', `${airports.length} airports loaded (Middle East)`)
  } catch (err) {
    log('Airports', `Fetch error: ${err.message}`, 'error')
  }
}

// ─── adsb.lol — ADS-B Exchange mirror, no API key required ───────────────────
// Docs: https://api.adsb.lol/docs
// Middle East center: lat 32, lon 44.5 — 1500nm radius covers entire region

const ADSBLOL_URL = 'https://api.adsb.lol/v2/lat/32/lon/44.5/dist/1500'

// ICAO Doc 7910 registration prefix → country name (longest prefix matched first)
const REG_PREFIX_COUNTRY = {
  // 3-char
  'A9C': 'Bahrain',
  // 2-char
  '4K': 'Azerbaijan',
  '4L': 'Georgia',
  '4R': 'Sri Lanka',
  '4W': 'Yemen',
  '4X': 'Israel',
  '5A': 'Libya',
  '5B': 'Cyprus',
  '5H': 'Tanzania',
  '5N': 'Nigeria',
  '5Y': 'Kenya',
  '6V': 'Senegal', '6W': 'Senegal',
  '7T': 'Algeria',
  '9K': 'Kuwait',
  '9M': 'Malaysia',
  '9V': 'Singapore',
  'A6': 'United Arab Emirates',
  'A7': 'Qatar',
  'AP': 'Pakistan',
  'D2': 'Angola',
  'D4': 'Cape Verde',
  'D6': 'Comoros',
  'EP': 'Iran, Islamic Republic of',
  'ER': 'Moldova',
  'ES': 'Estonia',
  'ET': 'Ethiopia',
  'EW': 'Belarus',
  'EX': 'Kyrgyzstan',
  'EY': 'Tajikistan',
  'EZ': 'Turkmenistan',
  'HA': 'Hungary',
  'HB': 'Switzerland',
  'HK': 'Colombia',
  'HL': 'Korea, Republic of',
  'HZ': 'Saudi Arabia',
  'J2': 'Djibouti',
  'JA': 'Japan',
  'JY': 'Jordan',
  'LN': 'Norway',
  'LX': 'Luxembourg',
  'LY': 'Lithuania',
  'LZ': 'Bulgaria',
  'OD': 'Lebanon',
  'OE': 'Austria',
  'OH': 'Finland',
  'OK': 'Czech Republic',
  'OO': 'Belgium',
  'OY': 'Denmark',
  'PH': 'Netherlands',
  'PK': 'Indonesia',
  'RA': 'Russia', 'RF': 'Russia',
  'S2': 'Bangladesh',
  'S5': 'Slovenia',
  'SE': 'Sweden',
  'SP': 'Poland',
  'SU': 'Egypt',
  'SX': 'Greece',
  'TC': 'Turkey',
  'TF': 'Iceland',
  'TJ': 'Cameroon',
  'TN': 'Congo',
  'TS': 'Tunisia',
  'UK': 'Uzbekistan',
  'UN': 'Kazakhstan',
  'UR': 'Ukraine',
  'VH': 'Australia',
  'VN': 'Viet Nam',
  'VP': 'United Kingdom',
  'VT': 'India',
  'XA': 'Mexico', 'XB': 'Mexico', 'XC': 'Mexico',
  'YA': 'Afghanistan',
  'YI': 'Iraq',
  'YK': 'Syrian Arab Republic',
  'YL': 'Latvia',
  'YR': 'Romania',
  'Z3': 'North Macedonia',
  'ZA': 'Albania',
  'ZK': 'New Zealand',
  'ZS': 'South Africa',
  // 1-char
  'B': 'China',
  'C': 'Canada',
  'D': 'Germany',
  'F': 'France',
  'G': 'United Kingdom',
  'I': 'Italy',
  'N': 'United States',
}

function regToCountry(reg) {
  if (!reg) return ''
  const r = reg.trim().toUpperCase()
  const c3 = REG_PREFIX_COUNTRY[r.slice(0, 3)]
  if (c3) return c3
  const c2 = REG_PREFIX_COUNTRY[r.slice(0, 2)]
  if (c2) return c2
  return REG_PREFIX_COUNTRY[r.slice(0, 1)] || ''
}

// Middle East bounding box filter (same as OpenSky)
const ME_BBOX = { latMin: 22, latMax: 42, lonMin: 29, lonMax: 60 }

function parseADSBLol(ac) {
  const lon = ac.lon
  const lat = ac.lat
  if (lon == null || lat == null) return null
  if (lat < ME_BBOX.latMin || lat > ME_BBOX.latMax) return null
  if (lon < ME_BBOX.lonMin || lon > ME_BBOX.lonMax) return null

  const icao24   = (ac.hex || '').trim().toLowerCase()
  const callsign = (ac.flight || '').trim()
  const altFt    = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
  const onGround = ac.on_ground || ac.alt_baro === 'ground' || altFt === 0

  return {
    id:             icao24,
    callsign:       callsign || icao24.toUpperCase(),
    lat,
    lon,
    altitude:       altFt != null ? Math.round(altFt) : 0,
    speed:          typeof ac.gs === 'number' ? Math.round(ac.gs) : 0,
    heading:        ac.track != null ? ac.track : null,
    military:       isMilitaryAircraft(icao24, callsign),
    onGround:       !!onGround,
    actype:         ac.t || 'UNKNOWN',
    registration:   ac.r || '',
    originCountry:  regToCountry(ac.r) || ac.ownOp || '',
    squawk:         ac.squawk || '',
    positionSource: 'ADS-B',
  }
}

async function fetchADSBLol() {
  const res = await axios.get(ADSBLOL_URL, { timeout: 20000 })
  if (!res.data?.ac?.length) throw new Error('No aircraft in response')
  return res.data.ac
    .map(parseADSBLol)
    .filter(Boolean)
    .filter(ac => !ac.onGround)
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
    heading:      sv[10] != null ? sv[10] : null,
    military:     isMilitaryAircraft(icao24, callsign),
    onGround:     !!sv[8],
    actype:       'UNKNOWN',    // OpenSky free tier does not provide aircraft type
    registration: '',
    originCountry: sv[2] || '',
    squawk:       sv[14] || '',
    positionSource: ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][sv[16]] || 'UNKNOWN',
  }
}


// ─── OpenSky CSV export ───────────────────────────────────────────────────────

const OPENSKY_CSV_HEADERS = [
  'icao24','callsign','origin_country','time_position','last_contact',
  'longitude','latitude','baro_altitude','on_ground','velocity',
  'true_track','vertical_rate','sensors','geo_altitude','squawk','spi','position_source',
]

function saveOpenSkyCSV(states) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = path.join(__dirname, 'opensky_dumps')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)

    const csvPath = path.join(dir, `opensky_${ts}.csv`)
    const rows = [OPENSKY_CSV_HEADERS.join(',')]
    for (const sv of states) {
      rows.push(sv.map(v => {
        if (v === null || v === undefined) return ''
        const s = String(v)
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
      }).join(','))
    }
    fs.writeFileSync(csvPath, rows.join('\n'), 'utf8')
    log('OpenSky', `Saved ${states.length} rows → opensky_dumps/opensky_${ts}.csv`)
  } catch (err) {
    log('OpenSky', `CSV save error: ${err.message}`, 'error')
  }
}

function loadLatestOpenSkyCSV() {
  try {
    const dir = path.join(__dirname, 'opensky_dumps')
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => f.startsWith('opensky_') && f.endsWith('.csv')).sort()
    if (files.length === 0) return []
    const latest = path.join(dir, files[files.length - 1])
    const lines = fs.readFileSync(latest, 'utf8').trim().split('\n')
    if (lines.length < 2) return []
    // Reconstruct state vectors (CSV columns match OPENSKY_CSV_HEADERS order)
    const aircraft = lines.slice(1).map(line => {
      const sv = line.split(',').map((v, i) => {
        if (v === '' || v === 'null') return null
        if ([3,4,7,9,10,11,13,16].includes(i)) return parseFloat(v)
        if (i === 8) return v === 'true'
        return v
      })
      return parseStateVector(sv)
    }).filter(Boolean).filter(ac => !ac.onGround)
    log('OpenSky', `Loaded ${aircraft.length} aircraft from ${files[files.length - 1]}`)
    return aircraft
  } catch (err) {
    log('OpenSky', `CSV load error: ${err.message}`, 'error')
    return []
  }
}

const FIRMS_CSV_HEADERS = ['id','lon','lat','brightness','frp','confidence','acqDate','acqTime','acqTimestamp','intensity']

function saveFireCSV(fires) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = path.join(__dirname, 'firms_dumps')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    const csvPath = path.join(dir, `firms_${ts}.csv`)
    const rows = [FIRMS_CSV_HEADERS.join(',')]
    for (const f of fires) {
      rows.push([f.id, f.coords[0], f.coords[1], f.brightness, f.frp, f.confidence, f.acqDate, f.acqTime, f.acqTimestamp, f.intensity].join(','))
    }
    fs.writeFileSync(csvPath, rows.join('\n'), 'utf8')
    log('FIRMS', `Saved ${fires.length} rows → firms_dumps/firms_${ts}.csv`)
  } catch (err) {
    log('FIRMS', `CSV save error: ${err.message}`, 'error')
  }
}

function loadLatestFireCSV() {
  try {
    const dir = path.join(__dirname, 'firms_dumps')
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => f.startsWith('firms_') && f.endsWith('.csv')).sort()
    if (files.length === 0) return []
    const latest = path.join(dir, files[files.length - 1])
    const lines = fs.readFileSync(latest, 'utf8').trim().split('\n')
    if (lines.length < 2) return []
    const fires = []
    for (let i = 1; i < lines.length; i++) {
      const v = lines[i].split(',')
      if (v.length < 10) continue
      fires.push({
        id: v[0],
        coords: [parseFloat(v[1]), parseFloat(v[2])],
        brightness: parseFloat(v[3]),
        frp: parseFloat(v[4]),
        confidence: v[5],
        acqDate: v[6],
        acqTime: v[7],
        acqTimestamp: parseInt(v[8], 10),
        intensity: v[9],
      })
    }
    log('FIRMS', `Loaded ${fires.length} hotspots from ${files[files.length - 1]}`)
    return fires
  } catch (err) {
    log('FIRMS', `CSV load error: ${err.message}`, 'error')
    return []
  }
}

// ─── Latest-data cache (server/cache/*.csv — always overwrites) ───────────────

function escapeCsv(v) {
  const s = String(v == null ? '' : v)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s
}

const AIRCRAFT_CACHE_HEADERS = ['id','callsign','lat','lon','altitude','speed','heading','military','onGround','actype','registration','originCountry','squawk','positionSource']

function saveAircraftCache(aircraft) {
  try {
    const file = timestampedCachePath('aircraft')
    const rows = [AIRCRAFT_CACHE_HEADERS.join(',')]
    for (const ac of aircraft) {
      rows.push([
        escapeCsv(ac.id), escapeCsv(ac.callsign),
        ac.lat, ac.lon, ac.altitude, ac.speed,
        ac.heading ?? '', ac.military, ac.onGround,
        escapeCsv(ac.actype), escapeCsv(ac.registration),
        escapeCsv(ac.originCountry), escapeCsv(ac.squawk), escapeCsv(ac.positionSource),
      ].join(','))
    }
    fs.writeFileSync(file, rows.join('\n'), 'utf8')
    pruneAircraftCache()
    log('OpenSky', `Cache saved — ${aircraft.length} aircraft`)
  } catch (err) {
    log('OpenSky', `Cache save error: ${err.message}`, 'error')
  }
}

function loadAircraftCache() {
  try {
    const file = latestCacheFile('aircraft')
    if (!file) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    if (lines.length < 2) return []
    return lines.slice(1).map(line => {
      const v = parseCSVLine(line)
      if (v.length < 14) return null
      const heading = v[6] !== '' ? parseFloat(v[6]) : null
      return {
        id: v[0], callsign: v[1],
        lat: parseFloat(v[2]), lon: parseFloat(v[3]),
        altitude: parseInt(v[4]) || 0, speed: parseInt(v[5]) || 0,
        heading: isNaN(heading) ? null : heading,
        military: v[7] === 'true', onGround: v[8] === 'true',
        actype: v[9], registration: v[10], originCountry: v[11],
        squawk: v[12], positionSource: v[13],
      }
    }).filter(r => r && !isNaN(r.lat) && !isNaN(r.lon))
  } catch (err) {
    log('OpenSky', `Cache load error: ${err.message}`, 'error')
    return []
  }
}

function saveFiresCache(fires) {
  try {
    const file = timestampedCachePath('fires')
    const rows = [FIRMS_CSV_HEADERS.join(',')]
    for (const f of fires) {
      rows.push([f.id, f.coords[0], f.coords[1], f.brightness, f.frp, f.confidence, f.acqDate, f.acqTime, f.acqTimestamp, f.intensity].join(','))
    }
    fs.writeFileSync(file, rows.join('\n'), 'utf8')
    pruneFiresCache()
    log('FIRMS', `Cache saved — ${fires.length} hotspots`)
  } catch (err) {
    log('FIRMS', `Cache save error: ${err.message}`, 'error')
  }
}

function loadFiresCache() {
  try {
    const file = latestCacheFile('fires')
    if (!file) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    if (lines.length < 2) return []
    return lines.slice(1).map(line => {
      const v = line.split(',')
      if (v.length < 10) return null
      return {
        id: v[0], coords: [parseFloat(v[1]), parseFloat(v[2])],
        brightness: parseFloat(v[3]), frp: parseFloat(v[4]),
        confidence: v[5], acqDate: v[6], acqTime: v[7],
        acqTimestamp: parseInt(v[8], 10), intensity: v[9],
      }
    }).filter(Boolean)
  } catch (err) {
    log('FIRMS', `Cache load error: ${err.message}`, 'error')
    return []
  }
}

const AIRPORT_CACHE_HEADERS = ['id','name','iata','icao','type','country','municipality','lon','lat','elevation']

function saveAirportsCache(airports) {
  try {
    ensureCacheDir()
    const rows = [AIRPORT_CACHE_HEADERS.join(',')]
    for (const a of airports) {
      rows.push([
        escapeCsv(a.id), escapeCsv(a.name), escapeCsv(a.iata), escapeCsv(a.icao),
        a.type, a.country, escapeCsv(a.municipality),
        a.coords[0], a.coords[1], a.elevation,
      ].join(','))
    }
    fs.writeFileSync(path.join(CACHE_DIR, 'airports.csv'), rows.join('\n'), 'utf8')
    log('Airports', `Cache saved — ${airports.length} airports`)
  } catch (err) {
    log('Airports', `Cache save error: ${err.message}`, 'error')
  }
}

function loadAirportsCache() {
  try {
    const file = path.join(CACHE_DIR, 'airports.csv')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    if (lines.length < 2) return []
    return lines.slice(1).map(line => {
      const v = parseCSVLine(line)
      if (v.length < 10) return null
      return {
        id: v[0], name: v[1], iata: v[2], icao: v[3],
        type: v[4], country: v[5], municipality: v[6],
        coords: [parseFloat(v[7]), parseFloat(v[8])],
        elevation: parseInt(v[9]) || 0,
      }
    }).filter(Boolean)
  } catch (err) {
    log('Airports', `Cache load error: ${err.message}`, 'error')
    return []
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

    if (process.env.SAVE_OPENSKY_CSV === 'true') saveOpenSkyCSV(res.data.states)

    const parsed = (process.env.SAVE_OPENSKY_CSV === 'true'
      ? loadLatestOpenSkyCSV()
      : res.data.states.map(parseStateVector).filter(Boolean).filter(ac => !ac.onGround)
    )

    aircraftData = parsed
    saveAircraftCache(aircraftData)
    saveAircraftToFirestore(aircraftData).catch(err => log('Firestore', `Aircraft save error: ${err.message}`, 'error'))
    const milCount = aircraftData.filter(a => a.military).length
    io.emit('aircraft:update', aircraftData)
    log('OpenSky', `${aircraftData.length} aircraft  (${milCount} mil)`)
  } catch (err) {
    if (err.response?.status === 429) {
      log('OpenSky', 'Rate limited (429) — will retry next interval', 'warn')
    } else {
      log('OpenSky', `Fetch error: ${err.message} — trying adsb.lol fallback`, 'warn')
    }
    // ── adsb.lol fallback ──────────────────────────────────────────────────────
    try {
      const parsed = await fetchADSBLol()
      aircraftData = parsed
      saveAircraftCache(aircraftData)
      saveAircraftToFirestore(aircraftData).catch(err => log('Firestore', `Aircraft save error: ${err.message}`, 'error'))
      const milCount = aircraftData.filter(a => a.military).length
      io.emit('aircraft:update', aircraftData)
      log('OpenSky', `[adsb.lol] ${aircraftData.length} aircraft  (${milCount} mil)`)
      return
    } catch (lolErr) {
      log('OpenSky', `adsb.lol also failed: ${lolErr.message}`, 'error')
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

    if (process.env.SAVE_FIRMS_CSV === 'true') saveFireCSV(fires)

    saveFiresToFirestore(fires).catch(err =>
      log('Firestore', `Save error: ${err.message}`, 'error')
    )

    fireData = process.env.SAVE_FIRMS_CSV === 'true' ? loadLatestFireCSV() : fires
    saveFiresCache(fireData)
    io.emit('fires:update', fireData)
    log('FIRMS', `${fireData.length} fire hotspots`)
  } catch (err) {
    log('FIRMS', `Fetch error: ${err.message}`, 'error')
  }
}


// ─── REST API endpoints ───────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    connections: io.engine.clientsCount,
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

  socket.on('data:init', async () => {
    // ── Airports: serve from cache; fetch if none ────────────────────────────
    if (airportData.length === 0) {
      log('Airports', 'No cache — fetching…')
      await fetchAirports()
    }
    socket.emit('airports:update', airportData)

    // ── Aircraft: read from latest CSV; fetch if none ─────────────────────────
    let ac = loadAircraftCache()
    if (ac.length === 0) {
      log('OpenSky', 'No aircraft cache — fetching for data:init…')
      await fetchAircraft()
      ac = loadAircraftCache()
    }
    socket.emit('aircraft:update', ac)

    // ── Fires: read from latest CSV; fetch if none ────────────────────────────
    let fires = loadFiresCache()
    if (fires.length === 0) {
      log('FIRMS', 'No fires cache — fetching for data:init…')
      await fetchFIRMS()
      fires = loadFiresCache()
    }
    socket.emit('fires:update', fires)

    log('Socket', `data:init → ${ac.length} ac, ${fires.length} fires, ${airportData.length} ap → ${socket.id}`)
  })

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

  // Initial data fetch — all three on startup
  await Promise.all([fetchAirports(), fetchAircraft(), fetchFIRMS()])

  // Scheduled intervals (configurable via .env, defaults: aircraft 100s, fires 300s)
  const aircraftInterval = parseInt(process.env.AIRCRAFT_INTERVAL_MS) || 100_000
  const firesInterval    = parseInt(process.env.FIRMS_INTERVAL_MS)    || 300_000
  setInterval(fetchAircraft, aircraftInterval)
  setInterval(fetchFIRMS,    firesInterval)
  log('Socket', `Intervals — aircraft: ${aircraftInterval}ms  fires: ${firesInterval}ms`)

})
