const axios = require('axios')
const fs    = require('fs')
const path  = require('path')
const { log } = require('./logger')
const { saveAircraftCache } = require('./cache')
const { saveAircraftToFirestore } = require('./firestore')

// ─── airplanes.live — ADS-B Exchange mirror, no API key required ──────────────
// Middle East center: lat 32, lon 44.5 — 1500nm radius covers entire region
const AIRPLANESLIVE_URL = 'https://api.airplanes.live/v2/point/32/44.5/1500'

// ─── ICAO Doc 7910 registration prefix → country name ─────────────────────────
const REG_PREFIX_COUNTRY = {
  // 3-char
  'A4O': 'Oman',
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
  '9H': 'Malta',
  '9K': 'Kuwait',
  '9M': 'Malaysia',
  '9V': 'Singapore',
  'A6': 'United Arab Emirates',
  'A7': 'Qatar',
  'AP': 'Pakistan',
  'D2': 'Angola',
  'D4': 'Cape Verde',
  'D6': 'Comoros',
  'EC': 'Spain',
  'EI': 'Ireland',
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
  'HS': 'Thailand',
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
  'T7': 'San Marino',
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

// ─── Middle East bounding box ─────────────────────────────────────────────────
const ME_BBOX = { latMin: 22, latMax: 42, lonMin: 29, lonMax: 60 }

function parseAirplanesLive(ac) {
  const lon = ac.lon
  const lat = ac.lat
  if (lon == null || lat == null) return null
  if (lat < ME_BBOX.latMin || lat > ME_BBOX.latMax) return null
  if (lon < ME_BBOX.lonMin || lon > ME_BBOX.lonMax) return null

  const icao24   = (ac.hex || '').trim().toLowerCase()
  const callsign = (ac.flight || '').trim()
  const altFt    = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
  const onGround = ac.on_ground || ac.alt_baro === 'ground' || altFt === 0

  const militaryStatus = classifyMilitary(icao24, callsign)
  return {
    id:             icao24,
    callsign:       callsign || icao24.toUpperCase(),
    lat,
    lon,
    altitude:       altFt != null ? Math.round(altFt) : 0,
    speed:          typeof ac.gs === 'number' ? Math.round(ac.gs) : 0,
    heading:        ac.track != null ? ac.track : null,
    military:       militaryStatus === 'military',
    militaryStatus,
    onGround:       !!onGround,
    actype:         ac.t || 'UNKNOWN',
    registration:   ac.r || '',
    originCountry:  regToCountry(ac.r) || ac.ownOp || '',
    squawk:         ac.squawk || '',
    positionSource: 'ADS-B',
  }
}

async function fetchAirplanesLive() {
  const res = await axios.get(AIRPLANESLIVE_URL, { timeout: 20000 })
  if (!res.data?.ac?.length) throw new Error('No aircraft in response')
  return res.data.ac
    .map(parseAirplanesLive)
    .filter(Boolean)
    .filter(ac => !ac.onGround)
}

// ─── OpenSky Network REST API ─────────────────────────────────────────────────
const OPENSKY_URL  = 'https://opensky-network.org/api/states/all'
const OPENSKY_AUTH = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const OPENSKY_BBOX = { lamin: 22, lamax: 42, lomin: 29, lomax: 60 }

const M_S_TO_KNOTS   = 1.94384
const METRES_TO_FEET = 3.28084

// ─── OAuth2 token manager ─────────────────────────────────────────────────────
let _accessToken    = null
let _tokenExpiresAt = 0

async function getAccessToken() {
  const clientId     = process.env.OPENSKY_CLIENT_ID
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  if (_accessToken && Date.now() < _tokenExpiresAt - 60_000) return _accessToken

  try {
    const res = await axios.post(
      OPENSKY_AUTH,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
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

async function getAuthHeaders() {
  const token = await getAccessToken()
  return {
    'User-Agent': 'SentinelDashboard/0.2',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// ─── Military classification ──────────────────────────────────────────────────
// Returns: 'military' | 'suspected' | 'civilian'

// Confirmed military callsign prefixes (well-documented USAF/NATO/Middle East)
const CONFIRMED_MILITARY_CALLSIGNS = [
  'RCH', 'REACH',  // USAF Air Mobility Command (KC-135, C-17)
  'JAKE',           // USAF
  'PACK',           // USAF
  'DARK',           // USAF special ops
  'SPAR',           // USAF VIP transport (C-37A)
  'DOOM',           // USAF
  'HAVOC',          // US military
  'TOPCAT',         // US military
  'DISCO',          // E-8C JSTARS surveillance
  'RAVEN',          // USAF special ops
  'MAGMA',          // USAF
  'BONE',           // B-1B Lancer
  'BUFF',           // B-52 Stratofortress
  'SWORD',          // USAF
  'TORCH',          // USAF special ops
  'KNIGHT',         // USAF
  'DUKE',           // USAF
  'VIPER',          // F-16 Fighting Falcon
]

// Ambiguous — could be military or civilian; shown as 미식별 (unidentified)
const SUSPECTED_MILITARY_CALLSIGNS = [
  'GHOST',  // too generic
  'WOLF',   // too generic
  'COBRA',  // used by civilian helicopter tours
  'EAGLE',  // Eagle Aviation civilian ops
  'SULTAN', // royal/state (not necessarily combat military)
  'ATLAS',  // Atlas Air civilian cargo
  'FORCE',  // too generic
  'STEEL',  // too generic
  'BUCK',   // too generic
]

// Confirmed military ICAO 24-bit hex allocations
const CONFIRMED_MILITARY_HEX_RANGES = [
  { min: 0xAE0000, max: 0xAEFFFF, note: 'US Air Force' },
  { min: 0x43C000, max: 0x43CFFF, note: 'UK Military (RAF)' },
  { min: 0x3A8000, max: 0x3AFFFF, note: 'French Air Force' },
  { min: 0x710000, max: 0x71FFFF, note: 'Israeli Air Force (IAF)' },
  { min: 0x730000, max: 0x73FFFF, note: 'Saudi military (RSAF)' },
]

/** Returns 'military' | 'suspected' | 'civilian' */
function classifyMilitary(icao24, callsign) {
  const cs = (callsign || '').trim().toUpperCase()
  if (CONFIRMED_MILITARY_CALLSIGNS.some(p => cs.startsWith(p))) return 'military'
  const hex = parseInt(icao24 || '', 16)
  if (!isNaN(hex) && CONFIRMED_MILITARY_HEX_RANGES.some(r => hex >= r.min && hex <= r.max)) return 'military'
  if (SUSPECTED_MILITARY_CALLSIGNS.some(p => cs.startsWith(p))) return 'suspected'
  return 'civilian'
}

// ─── OpenSky state vector parser ──────────────────────────────────────────────
// Field indices per OpenSky API §2.1
function parseStateVector(sv) {
  const lon = sv[5]
  const lat = sv[6]
  if (lon == null || lat == null) return null

  const icao24   = (sv[0] || '').trim().toLowerCase()
  const callsign = (sv[1] || '').trim()
  const baroM    = sv[7]
  const velMs    = sv[9]

  const militaryStatus = classifyMilitary(icao24, callsign)
  return {
    id:             icao24,
    callsign:       callsign || icao24.toUpperCase(),
    lat,
    lon,
    altitude:       baroM != null ? Math.round(baroM * METRES_TO_FEET) : 0,
    speed:          velMs != null ? Math.round(velMs * M_S_TO_KNOTS) : 0,
    heading:        sv[10] != null ? sv[10] : null,
    military:       militaryStatus === 'military',
    militaryStatus,
    onGround:       !!sv[8],
    actype:         'UNKNOWN',
    registration:   '',
    originCountry:  sv[2] || '',
    squawk:         sv[14] || '',
    positionSource: ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][sv[16]] || 'UNKNOWN',
  }
}

// ─── Optional raw OpenSky CSV dump ───────────────────────────────────────────
const OPENSKY_CSV_HEADERS = [
  'icao24','callsign','origin_country','time_position','last_contact',
  'longitude','latitude','baro_altitude','on_ground','velocity',
  'true_track','vertical_rate','sensors','geo_altitude','squawk','spi','position_source',
]

function saveOpenSkyCSV(states) {
  try {
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = path.join(__dirname, '../opensky_dumps')
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
    const dir = path.join(__dirname, '../opensky_dumps')
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => f.startsWith('opensky_') && f.endsWith('.csv')).sort()
    if (files.length === 0) return []
    const latest = path.join(dir, files[files.length - 1])
    const lines  = fs.readFileSync(latest, 'utf8').trim().split('\n')
    if (lines.length < 2) return []
    return lines.slice(1).map(line => {
      const sv = line.split(',').map((v, i) => {
        if (v === '' || v === 'null') return null
        if ([3,4,7,9,10,11,13,16].includes(i)) return parseFloat(v)
        if (i === 8) return v === 'true'
        return v
      })
      return parseStateVector(sv)
    }).filter(Boolean).filter(ac => !ac.onGround)
  } catch (err) {
    log('OpenSky', `CSV load error: ${err.message}`, 'error')
    return []
  }
}

// ─── Main fetch function ──────────────────────────────────────────────────────

/** Fetch aircraft from OpenSky (→ airplanes.live fallback). Returns aircraft array. */
async function fetchAircraft() {
  try {
    const headers = await getAuthHeaders()

    let res
    try {
      res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers, timeout: 20000 })
    } catch (authErr) {
      if (authErr.response?.status === 401) {
        _accessToken = null
        const retryHeaders = await getAuthHeaders()
        if (retryHeaders.Authorization) {
          log('OpenSky', '401 — token refreshed, retrying…', 'warn')
          res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers: retryHeaders, timeout: 20000 })
        } else {
          log('OpenSky', '401 — falling back to anonymous request', 'warn')
          res = await axios.get(OPENSKY_URL, { params: OPENSKY_BBOX, headers: { 'User-Agent': 'SentinelDashboard/0.2' }, timeout: 20000 })
        }
      } else {
        throw authErr
      }
    }

    if (res.status === 404 || !res.data?.states) {
      log('OpenSky', 'No states returned', 'warn')
      return []
    }

    if (process.env.SAVE_OPENSKY_CSV === 'true') saveOpenSkyCSV(res.data.states)

    const parsed = process.env.SAVE_OPENSKY_CSV === 'true'
      ? loadLatestOpenSkyCSV()
      : res.data.states.map(parseStateVector).filter(Boolean).filter(ac => !ac.onGround)

    saveAircraftCache(parsed)
    saveAircraftToFirestore(parsed).catch(err =>
      log('Firestore', `Aircraft save error: ${err.message}`, 'error'),
    )
    const milCount = parsed.filter(a => a.military).length
    log('OpenSky', `${parsed.length} aircraft  (${milCount} mil)`)
    return parsed
  } catch (err) {
    if (err.response?.status === 429) {
      log('OpenSky', 'Rate limited (429) — trying airplanes.live fallback', 'warn')
    } else {
      log('OpenSky', `Fetch error: ${err.message} — trying airplanes.live fallback`, 'warn')
    }

    const parsed = await fetchAirplanesLive()
    saveAircraftCache(parsed)
    saveAircraftToFirestore(parsed).catch(err =>
      log('Firestore', `Aircraft save error: ${err.message}`, 'error'),
    )
    const milCount = parsed.filter(a => a.military).length
    log('OpenSky', `[airplanes.live] ${parsed.length} aircraft  (${milCount} mil)`)
    return parsed
  }
}

module.exports = { fetchAircraft }
