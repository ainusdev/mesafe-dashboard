const fs   = require('fs')
const path = require('path')
const { log } = require('./logger')

const CACHE_DIR = path.join(__dirname, '../cache')


function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
}

function latestCacheFile(prefix) {
  if (!fs.existsSync(CACHE_DIR)) return null
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith(prefix + '_') && f.endsWith('.csv'))
    .sort()
  return files.length ? path.join(CACHE_DIR, files[files.length - 1]) : null
}

function timestampedCachePath(prefix) {
  ensureCacheDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(CACHE_DIR, `${prefix}_${ts}.csv`)
}

function pruneAircraftCache() {
  if (!fs.existsSync(CACHE_DIR)) return
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('aircraft_') && f.endsWith('.csv'))
    .sort()
  files.slice(0, -1).forEach(f => {
    try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch {}
  })
}

function pruneFiresCache() {
  if (!fs.existsSync(CACHE_DIR)) return
  const cutoff = Date.now() - 24 * 3600 * 1000
  fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('fires_') && f.endsWith('.csv'))
    .forEach(f => {
      const iso = f.slice('fires_'.length, -4).replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')
      const ts = new Date(iso).getTime()
      if (!isNaN(ts) && ts < cutoff) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch {}
      }
    })
}

function escapeCsv(v) {
  const s = String(v == null ? '' : v)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s
}

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

// ─── Aircraft cache ───────────────────────────────────────────────────────────

const AIRCRAFT_CACHE_HEADERS = [
  'id','callsign','lat','lon','altitude','speed','heading',
  'military','militaryStatus','onGround','actype','registration','originCountry','squawk','positionSource',
]

function saveAircraftCache(aircraft) {
  try {
    const file = timestampedCachePath('aircraft')
    const rows = [AIRCRAFT_CACHE_HEADERS.join(',')]
    for (const ac of aircraft) {
      rows.push([
        escapeCsv(ac.id), escapeCsv(ac.callsign),
        ac.lat, ac.lon, ac.altitude, ac.speed,
        ac.heading ?? '', ac.military, ac.militaryStatus || (ac.military ? 'military' : 'civilian'), ac.onGround,
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
      // Support both old (14-col) and new (15-col with militaryStatus) format
      const hasStatus = v.length >= 15
      const heading = v[6] !== '' ? parseFloat(v[6]) : null
      const military = v[7] === 'true'
      const militaryStatus = hasStatus
        ? (v[8] || (military ? 'military' : 'civilian'))
        : (military ? 'military' : 'civilian')
      const col = hasStatus ? 1 : 0  // offset for columns after militaryStatus
      return {
        id: v[0], callsign: v[1],
        lat: parseFloat(v[2]), lon: parseFloat(v[3]),
        altitude: parseInt(v[4]) || 0, speed: parseInt(v[5]) || 0,
        heading: isNaN(heading) ? null : heading,
        military, militaryStatus,
        onGround: v[8 + col] === 'true',
        actype: v[9 + col], registration: v[10 + col], originCountry: v[11 + col],
        squawk: v[12 + col], positionSource: v[13 + col],
      }
    }).filter(r => r && !isNaN(r.lat) && !isNaN(r.lon))
  } catch (err) {
    log('OpenSky', `Cache load error: ${err.message}`, 'error')
    return []
  }
}

// ─── Fires cache ──────────────────────────────────────────────────────────────

const FIRMS_CSV_HEADERS = [
  'id','lon','lat','brightness','frp','confidence','acqDate','acqTime','acqTimestamp','intensity',
]

function saveFiresCache(fires) {
  try {
    const file = timestampedCachePath('fires')
    const rows = [FIRMS_CSV_HEADERS.join(',')]
    for (const f of fires) {
      rows.push([
        f.id, f.coords[0], f.coords[1], f.brightness, f.frp,
        f.confidence, f.acqDate, f.acqTime, f.acqTimestamp, f.intensity,
      ].join(','))
    }
    fs.writeFileSync(file, rows.join('\n'), 'utf8')

    pruneFiresCache()
    log('FIRMS', `Cache saved — ${fires.length} hotspots`)
  } catch (err) {
    log('FIRMS', `Cache save error: ${err.message}`, 'error')
  }
}

function parseFireLine(line) {
  const v = line.split(',')
  if (v.length < 10) return null
  return {
    id: v[0], coords: [parseFloat(v[1]), parseFloat(v[2])],
    brightness: parseFloat(v[3]), frp: parseFloat(v[4]),
    confidence: v[5], acqDate: v[6], acqTime: v[7],
    acqTimestamp: parseInt(v[8], 10), intensity: v[9],
  }
}

function loadFiresCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return []
    const cutoff = Date.now() - 24 * 3600 * 1000
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.startsWith('fires_') && f.endsWith('.csv'))
      .sort()

    if (files.length === 0) return []

    const seen = new Map()
    for (const f of files) {
      // parse timestamp from filename to skip files older than 24h
      const iso = f.slice('fires_'.length, -4).replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')
      const ts  = new Date(iso).getTime()
      if (!isNaN(ts) && ts < cutoff) continue

      try {
        const lines = fs.readFileSync(path.join(CACHE_DIR, f), 'utf8').trim().split('\n')
        for (const line of lines.slice(1)) {
          const fire = parseFireLine(line)
          if (!fire || !fire.id) continue
          if (fire.id.startsWith('fire-MTG')) continue   // EUMETSAT removed — skip legacy MTG entries
          seen.set(fire.id, fire)
        }
      } catch {}
    }

    return [...seen.values()]
  } catch (err) {
    log('FIRMS', `Cache load error: ${err.message}`, 'error')
    return []
  }
}

// ─── Airports cache ───────────────────────────────────────────────────────────

const AIRPORT_CACHE_HEADERS = [
  'id','name','iata','icao','type','country','municipality','lon','lat','elevation',
]

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
    const airportFile = path.join(CACHE_DIR, 'airports.csv')
    fs.writeFileSync(airportFile, rows.join('\n'), 'utf8')
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

module.exports = {
  parseCSVLine,
  FIRMS_CSV_HEADERS,
  latestCacheFile,
  saveAircraftCache, loadAircraftCache,
  saveFiresCache,    loadFiresCache,
  saveAirportsCache, loadAirportsCache,
}
