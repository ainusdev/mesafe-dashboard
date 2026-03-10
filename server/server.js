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
const { initFirestore,
        saveAircraftToFirestore, saveFiresToFirestore, saveAirportsToFirestore,
        loadAircraftFromFirestore, loadFiresFromFirestore, loadAirportsFromFirestore,
}                                                 = require('./lib/firestore')
const { fetchAirports }                           = require('./lib/airports')
const { fetchAircraft }                           = require('./lib/aircraft')
const { fetchFIRMS, deduplicateFires }             = require('./lib/fires')
const { fetchAirspaceStatus, getCachedAirspaceStatus }  = require('./lib/notam')
const { fetchWeather, getCachedWeather }                = require('./lib/weather')
const { runAnalytics, getAnalytics, getStatsHistory }   = require('./lib/analytics')

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
// 안전망 브로드캐스트: fetch 시 이미 io.emit()하므로 긴 주기로만 (기본 5분)
const BROADCAST_MS = parseInt(process.env.SOCKET_BROADCAST_INTERVAL_MS) || 300_000

// ─── 데이터 상태 ─────────────────────────────────────────────────────────────

let aircraftData   = loadAircraftCache()
let fireData       = loadFiresCache()
let airportData    = loadAirportsCache()
let airspaceStatus = getCachedAirspaceStatus() || null   // load from CSV cache on boot
let weatherData    = getCachedWeather() || null
const debugLog     = []     // 최근 에러/이벤트 캡쳐 (최대 50개)
function dlog(msg) { debugLog.push(`${new Date().toISOString()} ${msg}`); if (debugLog.length > 50) debugLog.shift() }

// ─── 핵심 로직: 부트스트랩 ───────────────────────────────────────────────────

async function bootstrap() {
  try {
    // [보완] Firestore 인증 에러가 나도 서버가 죽지 않도록 방어
    try {
      initFirestore()

      const needAircraft = aircraftData.length === 0
      const needAirports = airportData.length === 0

      // 문법 에러 수정 완료
      const [fsAircraft, fsFires, fsAirports] = await Promise.all([
        needAircraft ? loadAircraftFromFirestore().catch(() => []) : Promise.resolve([]),
        loadFiresFromFirestore().catch(() => []),
        needAirports ? loadAirportsFromFirestore().catch(() => []) : Promise.resolve([])
      ])

      if (fsAircraft.length > 0) { saveAircraftCache(fsAircraft); aircraftData = loadAircraftCache() }
      if (fsAirports.length > 0) { saveAirportsCache(fsAirports); airportData = loadAirportsCache() }

      if (fsFires.length > 0) {
        saveFiresCache(fsFires)
        const merged = deduplicateFires(loadFiresCache())
        if (merged.length > fireData.length) {
          fireData = merged
          io.emit('fires:update', fireData)
        }
      }
      log('Firestore', 'Sync complete')
    } catch (e) {
      log('System', 'Running in Local Mode (Cloud Auth Missing)', 'warn')
    }

    // ─── [원본 배너 디자인 유지] ───
    server.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════╗
║  MESAFE   // CONFLICT MONITOR — BACKEND  ║
║  http://localhost:${PORT}                   ║
╚══════════════════════════════════════════╝`)
    })

    startPollingCycles()

  } catch (err) {
    log('System', `Critical Error: ${err.message}`, 'error')
  }
}

// ─── 데이터 폴링 로직 ────────────────────────────────────────────────────────

function startPollingCycles() {
  const acInt = parseInt(process.env.AIRCRAFT_INTERVAL_MS) || 300_000
  const fiInt = parseInt(process.env.FIRMS_INTERVAL_MS) || 300_000
  const asInt = parseInt(process.env.AIRSPACE_INTERVAL_MS) || 60_000
  const jitterMult = parseFloat(process.env.INTERVAL_JITTER_MULTIPLIER) || 3

  const schedule = (fn, baseMs, tag) => {
    const next = Math.round(baseMs + (Math.random() * baseMs * jitterMult))
    setTimeout(async () => {
      await fn().catch(err => log(tag, `Fetch error: ${err.message}`, 'error'))
      schedule(fn, baseMs, tag)
    }, next)
  }

  const wxInt = parseInt(process.env.WEATHER_INTERVAL_MS) || 300_000
  const anInt = parseInt(process.env.ANALYTICS_INTERVAL_MS) || 1_000

  doFetchAirports().catch(e => dlog(`airports err: ${e.message}`))
  doFetchAircraft().catch(e => dlog(`aircraft err: ${e.message}`))
  doFetchFIRMS().catch(e => dlog(`fires err: ${e.message}`))
  doFetchAirspace().catch(e => dlog(`airspace err: ${e.message}`))
  doFetchWeather().catch(e => dlog(`weather err: ${e.message}`))

  schedule(doFetchAircraft, acInt, 'OpenSky')
  schedule(doFetchFIRMS, fiInt, 'FIRMS')
  schedule(doFetchAirspace, asInt, 'Airspace')
  schedule(doFetchWeather, wxInt, 'Weather')

  // Analytics tick — runs every 10s, CPU-intensive (geofencing, separation, trajectories)
  setInterval(doAnalyticsTick, anInt)
  log('System', `Analytics engine started (every ${anInt / 1000}s)`)
}

async function doFetchAircraft() {
  const data = await fetchAircraft()
  dlog(`aircraft fetch: ${data.length} items`)
  if (data.length > 0) {
    aircraftData = data
    const bytes = JSON.stringify(aircraftData).length
    log('Socket', `emit aircraft:update → ${aircraftData.length} items (${(bytes / 1024).toFixed(1)} KB) → ${io.engine.clientsCount} clients`)
    io.emit('aircraft:update', aircraftData)
  }
}

async function doFetchFIRMS() {
  try {
    const data = await fetchFIRMS()
    dlog(`fires fetch: ${data.length} items`)
    if (data.length > 0) {
      fireData = deduplicateFires(loadFiresCache())
      dlog(`fires after dedup+cache: ${fireData.length}`)
      const bytes = JSON.stringify(fireData).length
      log('Socket', `emit fires:update → ${fireData.length} items (${(bytes / 1024).toFixed(1)} KB) → ${io.engine.clientsCount} clients`)
      io.emit('fires:update', fireData)
    } else {
      dlog('fires fetch returned 0')
    }
  } catch (err) {
    dlog(`fires fetch ERROR: ${err.message}`)
    throw err
  }
}

async function doFetchAirports() {
  const data = await fetchAirports()
  if (data.length > 0) {
    airportData = data
    saveAirportsToFirestore(data).catch(() => {})
  }
}

async function doFetchAirspace() {
  try {
    const status = await fetchAirspaceStatus()
    if (status) {
      airspaceStatus = status
      const bytes = (JSON.stringify(status).length / 1024).toFixed(1)
      log('Socket', `emit airspace:update → ${Object.keys(status).length} airports (${bytes}KB) → ${io.engine.clientsCount} clients`)
      io.emit('airspace:update', airspaceStatus)
      dlog(`airspace fetch: ${Object.keys(status).length} airports`)
    }
  } catch (err) {
    dlog(`airspace fetch ERROR: ${err.message}`)
  }
}

async function doFetchWeather() {
  try {
    const data = await fetchWeather()
    if (data) {
      weatherData = data
      const count = data.stations ? Object.keys(data.stations).length : 0
      const bytes = (JSON.stringify(data).length / 1024).toFixed(1)
      log('Socket', `emit weather:update → ${count} stations (${bytes}KB) → ${io.engine.clientsCount} clients`)
      io.emit('weather:update', weatherData)
      dlog(`weather fetch: ${count} stations`)
    }
  } catch (err) {
    dlog(`weather fetch ERROR: ${err.message}`)
  }
}

function doAnalyticsTick() {
  try {
    const result = runAnalytics(aircraftData)
    if (result && io.engine.clientsCount > 0) {
      io.emit('analytics:update', result)
    }
  } catch (err) {
    dlog(`analytics ERROR: ${err.message}`)
  }
}

// ─── Socket.io 이벤트 및 브로드캐스트 ───────────────────────────────────────────

// 안전망 브로드캐스트 — fetch 주기에서 이미 push하므로 여기선 긴 주기(5분)로 보험용
// airports는 거의 변하지 않으므로 여기서 제외 (data:init에서만 전송)
setInterval(() => {
  if (io.engine.clientsCount > 0) {
    const acBytes = (JSON.stringify(aircraftData).length / 1024).toFixed(1)
    const frBytes = (JSON.stringify(fireData).length / 1024).toFixed(1)
    log('Socket', `Safety broadcast → ${io.engine.clientsCount} clients | aircraft:${aircraftData.length}(${acBytes}KB) fires:${fireData.length}(${frBytes}KB)`)
    io.emit('aircraft:update', aircraftData)
    io.emit('fires:update', fireData)
  }
}, BROADCAST_MS)

const fetchLock = { aircraft: false, fires: false, airports: false }

io.on('connection', (socket) => {
  log('Socket', `Client connected: ${socket.id}`)

  socket.on('data:init', async () => {
    const sizes = {
      airports: (JSON.stringify(airportData).length / 1024).toFixed(1),
      aircraft: (JSON.stringify(aircraftData).length / 1024).toFixed(1),
      fires:    (JSON.stringify(fireData).length / 1024).toFixed(1),
      airspace: airspaceStatus ? (JSON.stringify(airspaceStatus).length / 1024).toFixed(1) : '0',
    }
    log('Socket', `data:init → ${socket.id} | airports:${airportData.length}(${sizes.airports}KB) aircraft:${aircraftData.length}(${sizes.aircraft}KB) fires:${fireData.length}(${sizes.fires}KB) airspace:${sizes.airspace}KB`)
    socket.emit('airports:update', airportData)
    socket.emit('aircraft:update', aircraftData)
    socket.emit('fires:update', fireData)
    if (airspaceStatus) socket.emit('airspace:update', airspaceStatus)
    if (weatherData) socket.emit('weather:update', weatherData)
    const analytics = getAnalytics()
    if (analytics) socket.emit('analytics:update', analytics)

    if (airportData.length === 0 && !fetchLock.airports) {
      fetchLock.airports = true
      const fetched = await fetchAirports().finally(() => fetchLock.airports = false)
      if (fetched.length > 0) {
        airportData = fetched
        socket.emit('airports:update', airportData)
      }
    }
  })

  socket.on('disconnect', () => {
    log('Socket', `Client disconnected: ${socket.id}`)
  })
})

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    connections: io.engine.clientsCount,
    counts: {
      aircraft: aircraftData.length,
      fires: fireData.length,
      airspaceTracked: airspaceStatus ? Object.keys(airspaceStatus).length : 0,
      weatherStations: weatherData?.stations ? Object.keys(weatherData.stations).length : 0,
      analyticsTracked: getAnalytics()?.tracked || 0,
    },
  })
})

app.get('/api/aircraft',    (req, res) => res.json(aircraftData))
app.get('/api/fires',       (req, res) => res.json(fireData))
app.get('/api/airports/me', (req, res) => res.json(airportData))
app.get('/api/airspace',    (req, res) => res.json(airspaceStatus || {}))
app.get('/api/weather',     (req, res) => res.json(weatherData || {}))
app.get('/api/analytics',   (req, res) => res.json(getAnalytics() || {}))
app.get('/api/stats',       (req, res) => res.json(getStatsHistory()))

bootstrap()