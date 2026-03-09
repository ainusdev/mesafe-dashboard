const axios = require('axios')
const fs    = require('fs')
const path  = require('path')
const { log } = require('./logger')

const CACHE_FILE = path.join(__dirname, '../cache/airspace_status.csv')

// ─── Load all ICAO codes from airports.csv ──────────────────────────────────

function loadIcaoCodes() {
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
  } catch {
    return []
  }
}

// ─── Load civilian airports for FlightAware check ───────────────────────────
const MILITARY_KEYWORDS = /\b(air base|air field|airbase|airfield|military|naval base|army|air force|air college|air academy)\b/i
const ICAO_TO_FA = { OKBK: 'KWI' }

function loadCivilianAirports() {
  try {
    const file = path.join(__dirname, '../cache/airports.csv')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    const airports = []
    const seen = new Set()
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',')
      const type = (cols[4] || '').replace(/"/g, '').trim()
      if (type !== 'large_airport' && type !== 'medium_airport') continue
      const name = (cols[1] || '').replace(/"/g, '').trim()
      if (MILITARY_KEYWORDS.test(name)) continue
      const icao = (cols[3] || '').replace(/"/g, '').trim()
      const iata = (cols[2] || '').replace(/"/g, '').trim()
      if (!iata) continue
      const validIcao = /^[A-Z]{4}$/.test(icao)
      const key = icao
      const faCode = ICAO_TO_FA[icao] || (validIcao ? icao : iata || null)
      if (!faCode || seen.has(key)) continue
      seen.add(key)
      airports.push({ key, faCode, validIcao })
    }
    return airports
  } catch {
    return []
  }
}

// ─── CSV cache ──────────────────────────────────────────────────────────────

function saveAirspaceCache(statuses) {
  try {
    const lines = ['icao,status,note']
    for (const [icao, st] of Object.entries(statuses)) {
      const note = (st.note || '').replace(/"/g, "'")
      lines.push(`${icao},${st.status},"${note}"`)
    }
    fs.writeFileSync(CACHE_FILE, lines.join('\n'), 'utf8')
  } catch (err) {
    log('Airspace', `Cache save error: ${err.message}`, 'warn')
  }
}

function loadAirspaceCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null
    const lines = fs.readFileSync(CACHE_FILE, 'utf8').trim().split('\n')
    if (lines.length < 2) return null
    const statuses = {}
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^([^,]+),([^,]+),(.*)$/)
      if (!m) continue
      const icao = m[1]
      const status = m[2]
      const note = m[3].replace(/^"|"$/g, '').replace(/'/g, "'")
      statuses[icao] = { status, note }
    }
    log('Airspace', `Loaded ${Object.keys(statuses).length} entries from cache`)
    return statuses
  } catch {
    return null
  }
}

// ─── FlightAware scraper ────────────────────────────────────────────────────

const FA_URL = 'https://www.flightaware.com/live/airport'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function scrapeAirportFlights(faCode) {
  const res = await axios.get(`${FA_URL}/${faCode}`, {
    headers: { 'User-Agent': UA },
    timeout: 15000,
  })
  const html = res.data
  const arrSection = html.match(/id="arrivals-board"([\s\S]*?)(?=id="enroute-board"|id="scheduled-board"|id="departures-board")/i)
  const enrSection = html.match(/id="enroute-board"([\s\S]*?)(?=id="scheduled-board"|id="departures-board")/i)
  const schSection = html.match(/id="scheduled-board"([\s\S]*?)(?=id="departures-board"|<\/div>\s*<script)/i)
  const depSection = html.match(/id="departures-board"([\s\S]*?)(?=<\/div>\s*<script)/i)

  const arrivals   = arrSection ? (arrSection[0].match(/id="Row_/g) || []).length : 0
  const enroute    = enrSection ? (enrSection[0].match(/id="Row_/g) || []).length : 0
  const scheduled  = schSection ? (schSection[0].match(/id="Row_/g) || []).length : 0
  const departures = depSection ? (depSection[0].match(/id="Row_/g) || []).length : 0
  return { arrivals, enroute, scheduled, departures }
}

// Run FlightAware scrapes with concurrency limit
async function scrapeWithConcurrency(entries, concurrency, delayMs) {
  const results = {}
  let idx = 0

  async function worker() {
    while (idx < entries.length) {
      const i = idx++
      const { key, faCode } = entries[i]
      try {
        results[key] = await scrapeAirportFlights(faCode)
      } catch {
        results[key] = null
      }
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    }
  }

  const workers = []
  for (let w = 0; w < Math.min(concurrency, entries.length); w++) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
}

// ─── Public fetch function ──────────────────────────────────────────────────

let cachedStatus = loadAirspaceCache()

async function fetchAirspaceStatus() {
  const allIcao = loadIcaoCodes()
  if (allIcao.length === 0) {
    log('Airspace', 'No airports in cache — skipping', 'warn')
    return cachedStatus || {}
  }

  const statuses = {}
  for (const icao of allIcao) {
    statuses[icao] = { status: 'OPEN', note: '' }
  }

  // ── FlightAware activity check (civilian airports only) ──
  const civilianAirports = loadCivilianAirports()
  for (const ap of civilianAirports) {
    if (!statuses[ap.key]) statuses[ap.key] = { status: 'OPEN', note: '' }
  }
  log('Airspace', `FlightAware: checking ${civilianAirports.length} civilian airports (concurrency 5)`)

  const faResults = await scrapeWithConcurrency(civilianAirports, 5, 200)
  let faSuccess = 0

  for (const ap of civilianAirports) {
    const counts = faResults[ap.key]
    if (!counts) continue // 404 or error — keep OPEN
    faSuccess++
    const hasArrDep = counts.arrivals > 0 || counts.departures > 0
    const hasPending = counts.enroute > 0 || counts.scheduled > 0
    const total = counts.arrivals + counts.departures + counts.enroute + counts.scheduled

    if (total === 0) {
      statuses[ap.key] = { status: 'CLOSED', note: 'No flights detected (FA)' }
    } else if (!hasArrDep && hasPending) {
      // No actual arrivals/departures, only enroute/scheduled → restricted
      statuses[ap.key] = { status: 'RESTRICTED', note: `Pending only: ${counts.enroute} enr, ${counts.scheduled} sched` }
    } else if (hasArrDep) {
      statuses[ap.key].note = `${counts.arrivals} arr, ${counts.departures} dep, ${counts.enroute} enr, ${counts.scheduled} sched`
    }
  }

  cachedStatus = statuses

  // Save to CSV cache
  saveAirspaceCache(statuses)

  const closed     = Object.values(statuses).filter(s => s.status === 'CLOSED').length
  const restricted = Object.values(statuses).filter(s => s.status === 'RESTRICTED').length
  const open       = Object.keys(statuses).length - closed - restricted
  log('Airspace', `${Object.keys(statuses).length} airports | FA:${faSuccess}/${civilianAirports.length} | ${closed} CLOSED, ${restricted} RESTRICTED, ${open} OPEN`)

  return cachedStatus
}

function getCachedAirspaceStatus() {
  return cachedStatus
}

module.exports = { fetchAirspaceStatus, getCachedAirspaceStatus }
