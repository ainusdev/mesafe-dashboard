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
        latestCacheFile,
        uploadAllCsvToStorage, scheduleHourlyStorageSync } = require('./lib/cache')
const { initFirestore,
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
// 안전망 브로드캐스트: fetch 시 이미 io.emit()하므로 긴 주기로만 (기본 5분)
const BROADCAST_MS = parseInt(process.env.SOCKET_BROADCAST_INTERVAL_MS) || 300_000

// ─── 데이터 상태 ─────────────────────────────────────────────────────────────

let aircraftData = loadAircraftCache()
let fireData     = loadFiresCache()
let airportData  = loadAirportsCache()

// ─── 핵심 로직: 부트스트랩 ───────────────────────────────────────────────────

async function bootstrap() {
  try {
    // [보완] Firestore 인증 에러가 나도 서버가 죽지 않도록 방어
    try {
      initFirestore()
      scheduleHourlyStorageSync()

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
        const merged = loadFiresCache()
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
  const jitterMult = parseFloat(process.env.INTERVAL_JITTER_MULTIPLIER) || 3

  const schedule = (fn, baseMs, tag) => {
    const next = Math.round(baseMs + (Math.random() * baseMs * jitterMult))
    setTimeout(async () => {
      await fn().catch(err => log(tag, `Fetch error: ${err.message}`, 'error'))
      schedule(fn, baseMs, tag)
    }, next)
  }

  doFetchAirports().catch(() => {})
  doFetchAircraft().catch(() => {})
  doFetchFIRMS().catch(() => {})

  schedule(doFetchAircraft, acInt, 'OpenSky')
  schedule(doFetchFIRMS, fiInt, 'FIRMS')
}

async function doFetchAircraft() {
  const data = await fetchAircraft()
  if (data.length > 0) {
    aircraftData = data
    io.emit('aircraft:update', aircraftData)
  }
}

async function doFetchFIRMS() {
  const data = await fetchFIRMS()
  if (data.length > 0) {
    fireData = loadFiresCache()
    io.emit('fires:update', fireData)
  }
}

async function doFetchAirports() {
  const data = await fetchAirports()
  if (data.length > 0) {
    airportData = data
    saveAirportsToFirestore(data).catch(() => {})
  }
}

// ─── Socket.io 이벤트 및 브로드캐스트 ───────────────────────────────────────────

// 안전망 브로드캐스트 — fetch 주기에서 이미 push하므로 여기선 긴 주기(5분)로 보험용
// airports는 거의 변하지 않으므로 여기서 제외 (data:init에서만 전송)
setInterval(() => {
  if (io.engine.clientsCount > 0) {
    io.emit('aircraft:update', aircraftData)
    io.emit('fires:update', fireData)
    log('Socket', `Safety broadcast → clients:${io.engine.clientsCount}`)
  }
}, BROADCAST_MS)

const fetchLock = { aircraft: false, fires: false, airports: false }

io.on('connection', (socket) => {
  log('Socket', `Client connected: ${socket.id}`)

  socket.on('data:init', async () => {
    socket.emit('airports:update', airportData)
    socket.emit('aircraft:update', aircraftData)
    socket.emit('fires:update', fireData)

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
    counts: { aircraft: aircraftData.length, fires: fireData.length },
  })
})

app.get('/api/aircraft',    (req, res) => res.json(aircraftData))
app.get('/api/fires',       (req, res) => res.json(fireData))
app.get('/api/airports/me', (req, res) => res.json(airportData))

bootstrap()