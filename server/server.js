require('dotenv').config()
const express = require('express')
const http    = require('http')
const { Server } = require('socket.io')
const cors   = require('cors')
const axios  = require('axios')
const fs     = require('fs')
const path   = require('path')

const { log }                                     = require('./lib/logger')
const { loadAircraftCache, loadFiresCache, loadAirportsCache,
        saveAircraftCache, saveFiresCache, saveAirportsCache,
        latestCacheFile } = require('./lib/cache')
const { initFirestore, migrateFireHotspotsToSnapshots,
        saveAircraftToFirestore, saveFiresToFirestore, saveAirportsToFirestore,
        loadAircraftFromFirestore, loadFiresFromFirestore, loadAirportsFromFirestore,
}                                                 = require('./lib/firestore')
const { fetchAirports }                           = require('./lib/airports')
const { fetchAircraft }                           = require('./lib/aircraft')
const { fetchFIRMS }                              = require('./lib/fires')

// ─── Express + Socket.io ──────────────────────────────────────────────────────

const app = express()
app.set('json spaces', 2)
const server = http.createServer(app)

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout:  20000,
  transports:   ['polling', 'websocket'],
})

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001

// ─── 1. Firestore 초기화 ──────────────────────────────────────────────────────

initFirestore()

// ─── 2. CSV 로드 → 비어있으면 Firestore에서 복구 (비동기, 비차단) ────────────

let aircraftData = loadAircraftCache()
let fireData     = loadFiresCache()
let airportData  = loadAirportsCache()

;(async () => {
  // 구 포맷 마이그레이션 — 복구를 블로킹하지 않도록 백그라운드 실행
  migrateFireHotspotsToSnapshots().catch(err =>
    log('Firestore', `Migration error: ${err.message}`, 'warn'))

  // CSV가 비어있는 항목만 Firestore에서 복구
  const needAircraft = aircraftData.length === 0
  const needFires    = fireData.length === 0
  const needAirports = airportData.length === 0

  if (!needAircraft && !needFires && !needAirports) {
    log('Cache', 'All CSV caches loaded — Firestore restore skipped')
    return
  }

  const [fsAircraft, fsFires, fsAirports] = await Promise.all([
    needAircraft ? loadAircraftFromFirestore() : Promise.resolve([]),
    needFires    ? loadFiresFromFirestore()    : Promise.resolve([]),
    needAirports ? loadAirportsFromFirestore() : Promise.resolve([]),
  ])

  if (fsAircraft.length > 0) { saveAircraftCache(fsAircraft); aircraftData = loadAircraftCache(); io.emit('aircraft:update', aircraftData) }
  if (fsFires.length > 0)    { saveFiresCache(fsFires);       fireData     = loadFiresCache();    io.emit('fires:update', fireData)       }
  if (fsAirports.length > 0) { saveAirportsCache(fsAirports); airportData  = loadAirportsCache(); io.emit('airports:update', airportData) }

  log('Firestore', `Restore complete — aircraft:${fsAircraft.length} fires:${fsFires.length} airports:${fsAirports.length}`)
})().catch(err => log('Firestore', `Restore failed: ${err.message}`, 'warn'))

// ─── 3. API 폴링 사이클 ───────────────────────────────────────────────────────

const aircraftInterval = parseInt(process.env.AIRCRAFT_INTERVAL_MS) || 300_000
const firesInterval    = parseInt(process.env.FIRMS_INTERVAL_MS)    || 300_000
const jitterMult       = parseFloat(process.env.INTERVAL_JITTER_MULTIPLIER) || 3

function scheduleWithJitter(fn, baseMs, tag) {
  const jitter = Math.random() * baseMs * jitterMult
  const next   = Math.round(baseMs + jitter)
  log(tag, `Next fetch in ${(next / 1000).toFixed(0)}s`)
  setTimeout(async () => {
    await fn().catch(err => log(tag, `Fetch error: ${err.message}`, 'error'))
    scheduleWithJitter(fn, baseMs, tag)
  }, next)
}

async function doFetchAircraft() {
  const data = await fetchAircraft()
  if (data.length > 0) {
    aircraftData = data
    io.emit('aircraft:update', aircraftData)
    saveAircraftToFirestore(data).catch(err => log('Firestore', `Aircraft save failed: ${err.message}`, 'warn'))
  }
}

async function doFetchFIRMS() {
  const data = await fetchFIRMS()
  if (data.length > 0) {
    fireData = data
    io.emit('fires:update', fireData)
    // saveFiresToFirestore는 fires.js 내부에서 이미 호출됨
  }
}

async function doFetchAirports() {
  const data = await fetchAirports()
  if (data.length > 0) {
    airportData = data
    saveAirportsToFirestore(data).catch(err => log('Firestore', `Airports save failed: ${err.message}`, 'warn'))
  }
}

log('Socket', `Base intervals — aircraft: ${aircraftInterval}ms  fires: ${firesInterval}ms  jitter: ×${jitterMult}`)

doFetchAirports().catch(err => log('Airports', `Startup fetch failed: ${err.message}`, 'error'))
doFetchAircraft().catch(err => log('OpenSky',  `Startup fetch failed: ${err.message}`, 'error'))
  .finally(() => scheduleWithJitter(doFetchAircraft, aircraftInterval, 'OpenSky'))
doFetchFIRMS().catch(err => log('FIRMS', `Startup fetch failed: ${err.message}`, 'error'))
  .finally(() => scheduleWithJitter(doFetchFIRMS, firesInterval, 'FIRMS'))

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    connections: io.engine.clientsCount,
    counts: { aircraft: aircraftData.length, fires: fireData.length },
  })
})

app.get('/api/aircraft',   (req, res) => res.json(aircraftData))
app.get('/api/fires',      (req, res) => res.json(fireData))
app.get('/api/airports/me',(req, res) => res.json(airportData))

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

// ─── Socket.io ────────────────────────────────────────────────────────────────

// Guard against concurrent on-demand fetches from multiple clients
const fetchLock = { aircraft: false, fires: false, airports: false }

io.on('connection', (socket) => {
  log('Socket', `Client connected: ${socket.id}`)

  socket.on('data:init', () => {
    ;(async () => {
      // ── Airports ──
      const airportsCsv = path.join(__dirname, 'cache/airports.csv')
      if (airportData.length === 0 || !fs.existsSync(airportsCsv)) {
        if (!fetchLock.airports) {
          fetchLock.airports = true
          try {
            log('Airports', airportData.length === 0 ? 'No cache — fetching…' : 'CSV missing — re-fetching…')
            const fetched = await fetchAirports()
            if (fetched.length > 0) airportData = fetched
          } catch (err) {
            log('Airports', `On-demand fetch error: ${err.message}`, 'error')
          } finally {
            fetchLock.airports = false
          }
        }
      }
      socket.emit('airports:update', airportData)
      log('Socket', `airports:update → ${airportData.length} ap → ${socket.id}`)

      // ── Aircraft ──
      if (aircraftData.length === 0 || !latestCacheFile('aircraft')) {
        if (!fetchLock.aircraft) {
          fetchLock.aircraft = true
          try {
            log('OpenSky', aircraftData.length === 0 ? 'No cache — fetching…' : 'CSV missing — re-fetching…')
            const fetched = await fetchAircraft()
            if (fetched.length > 0) {
              aircraftData = fetched
              saveAircraftCache(fetched)
              io.emit('aircraft:update', aircraftData)
              log('Socket', `aircraft:update (on demand) → ${aircraftData.length} ac`)
            }
          } catch (err) {
            log('OpenSky', `On-demand fetch error: ${err.message}`, 'error')
          } finally {
            fetchLock.aircraft = false
          }
        }
      }
      // Always emit current data to requesting client
      socket.emit('aircraft:update', aircraftData)
      log('Socket', `aircraft:update → ${aircraftData.length} ac → ${socket.id}`)

      // ── Fires ──
      if (fireData.length === 0 || !latestCacheFile('fires')) {
        if (!fetchLock.fires) {
          fetchLock.fires = true
          try {
            log('FIRMS', fireData.length === 0 ? 'No cache — fetching…' : 'CSV missing — re-fetching…')
            const fetched = await fetchFIRMS()
            if (fetched.length > 0) {
              fireData = fetched
              io.emit('fires:update', fireData)
              log('Socket', `fires:update (on demand) → ${fireData.length} fires`)
            }
          } catch (err) {
            log('FIRMS', `On-demand fetch error: ${err.message}`, 'error')
          } finally {
            fetchLock.fires = false
          }
        }
      }
      // Always emit current data to requesting client
      socket.emit('fires:update', fireData)
      log('Socket', `fires:update → ${fireData.length} fires → ${socket.id}`)
    })()
  })

  socket.on('disconnect', () => {
    log('Socket', `Client disconnected: ${socket.id}`)
  })
})

// ─── server.listen ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  SENTINEL // CONFLICT MONITOR — BACKEND  ║
║  http://localhost:${PORT}                    ║
╚══════════════════════════════════════════╝`)
})
