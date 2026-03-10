const axios = require('axios')
const { log } = require('./logger')
const fs   = require('fs')
const path = require('path')

// ─── METAR source: Aviation Weather Center ──────────────────────────────────
const AWC_URL = 'https://aviationweather.gov/api/data/metar'
const CACHE_FILE = path.join(__dirname, '../cache/weather.json')

// Load all ICAO codes from airports.csv
function loadAllIcao() {
  try {
    const file = path.join(__dirname, '../cache/airports.csv')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    const codes = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',')
      const icao = (cols[3] || '').replace(/"/g, '').trim()
      if (/^[A-Z]{4}$/.test(icao)) codes.push(icao)
    }
    return [...new Set(codes)]
  } catch { return [] }
}

// ─── Parse raw METAR string into structured data ────────────────────────────
function parseMetar(raw) {
  if (!raw) return null
  const parts = raw.trim().split(/\s+/)
  const result = { raw }

  // Wind: dddssKT or dddssGggKT
  const windPart = parts.find(p => /^\d{3}\d{2,3}(G\d{2,3})?KT$/.test(p))
  if (windPart) {
    result.windDir = parseInt(windPart.slice(0, 3))
    result.windSpeed = parseInt(windPart.slice(3, 5))
    const gust = windPart.match(/G(\d{2,3})/)
    if (gust) result.windGust = parseInt(gust[1])
  }
  const vrb = parts.find(p => /^VRB\d{2,3}KT$/.test(p))
  if (vrb) {
    result.windDir = -1 // variable
    result.windSpeed = parseInt(vrb.slice(3, 5))
  }

  // Visibility (SM or metres)
  const visSM = parts.find(p => /^\d+SM$/.test(p))
  if (visSM) result.visibilityKm = parseInt(visSM) * 1.609
  const visM = parts.find(p => /^\d{4}$/.test(p) && parseInt(p) >= 100 && parseInt(p) <= 9999)
  if (!visSM && visM) result.visibilityKm = parseInt(visM) / 1000

  // Temperature/Dewpoint: TT/DD (M prefix = negative)
  const tempPart = parts.find(p => /^M?\d{2}\/M?\d{2}$/.test(p))
  if (tempPart) {
    const [t, d] = tempPart.split('/')
    result.tempC = t.startsWith('M') ? -parseInt(t.slice(1)) : parseInt(t)
    result.dewpointC = d.startsWith('M') ? -parseInt(d.slice(1)) : parseInt(d)
  }

  // Altimeter: Axxxx (inHg) or Qxxxx (hPa)
  const altA = parts.find(p => /^A\d{4}$/.test(p))
  if (altA) result.altimeterHpa = Math.round(parseInt(altA.slice(1)) * 0.338639)
  const altQ = parts.find(p => /^Q\d{4}$/.test(p))
  if (altQ) result.altimeterHpa = parseInt(altQ.slice(1))

  // Cloud layers
  const clouds = []
  for (const p of parts) {
    const m = p.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})?(CB|TCU)?$/)
    if (m) clouds.push({ cover: m[1], altFt: m[2] ? parseInt(m[2]) * 100 : null, type: m[3] || null })
  }
  if (clouds.length) result.clouds = clouds

  // Weather phenomena
  const wxCodes = [
    'RA','SN','DZ','GR','GS','PL','SG','IC','FG','BR','HZ','FU','SA','DU',
    'SQ','FC','TS','SH','FZ','MI','PR','BC','DR','BL','VC',
  ]
  const wx = parts.filter(p => wxCodes.some(c => p.includes(c)) && !/^\d/.test(p) && !/^[AQ]\d/.test(p))
  if (wx.length) result.weather = wx

  // Flight category
  const ceil = clouds.find(c => ['BKN','OVC','VV'].includes(c.cover))
  const ceilFt = ceil?.altFt
  const visKm = result.visibilityKm
  if (ceilFt !== undefined && ceilFt !== null || visKm !== undefined) {
    if ((ceilFt !== null && ceilFt < 500) || (visKm !== undefined && visKm < 1.6))
      result.category = 'LIFR'
    else if ((ceilFt !== null && ceilFt < 1000) || (visKm !== undefined && visKm < 5))
      result.category = 'IFR'
    else if ((ceilFt !== null && ceilFt < 3000) || (visKm !== undefined && visKm < 8))
      result.category = 'MVFR'
    else
      result.category = 'VFR'
  }

  return result
}

// ─── Fetch METAR in batches ─────────────────────────────────────────────────
async function fetchMetarBatch(icaoList) {
  const results = {}
  const BATCH = 40 // AWC accepts comma-separated ICAO list

  for (let i = 0; i < icaoList.length; i += BATCH) {
    const batch = icaoList.slice(i, i + BATCH)
    try {
      const res = await axios.get(AWC_URL, {
        params: { ids: batch.join(','), format: 'json' },
        timeout: 15000,
      })
      if (Array.isArray(res.data)) {
        for (const m of res.data) {
          if (m.icaoId) {
            results[m.icaoId] = {
              raw: m.rawOb || '',
              parsed: parseMetar(m.rawOb || ''),
              obsTime: m.obsTime || null,
              lat: m.lat,
              lon: m.lon,
            }
          }
        }
      }
    } catch (err) {
      log('Weather', `Batch ${i}-${i + BATCH} error: ${err.message}`, 'warn')
    }
    // Small delay between batches to be polite
    if (i + BATCH < icaoList.length) await new Promise(r => setTimeout(r, 500))
  }
  return results
}

// ─── Main fetch ─────────────────────────────────────────────────────────────
let cachedWeather = loadWeatherCache()

function loadWeatherCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  } catch { return null }
}

function saveWeatherCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8')
  } catch {}
}

async function fetchWeather() {
  const icaoList = loadAllIcao()
  if (icaoList.length === 0) {
    log('Weather', 'No ICAO codes — skipping', 'warn')
    return cachedWeather || {}
  }

  log('Weather', `Fetching METAR for ${icaoList.length} airports...`)
  const results = await fetchMetarBatch(icaoList)

  // Re-parse all results for CPU work — extract stats
  let vfr = 0, mvfr = 0, ifr = 0, lifr = 0, noData = 0
  for (const icao of icaoList) {
    const r = results[icao]
    if (!r?.parsed) { noData++; continue }
    const cat = r.parsed.category
    if (cat === 'VFR') vfr++
    else if (cat === 'MVFR') mvfr++
    else if (cat === 'IFR') ifr++
    else if (cat === 'LIFR') lifr++
  }

  cachedWeather = { ts: Date.now(), stations: results }
  saveWeatherCache(cachedWeather)

  log('Weather', `${Object.keys(results).length}/${icaoList.length} stations | VFR:${vfr} MVFR:${mvfr} IFR:${ifr} LIFR:${lifr} noData:${noData}`)
  return cachedWeather
}

function getCachedWeather() { return cachedWeather }

module.exports = { fetchWeather, getCachedWeather }
