require('dotenv').config()
const express = require('express')
const http    = require('http')
const { Server } = require('socket.io')
const cors   = require('cors')
const axios  = require('axios')

const { log }                                     = require('./lib/logger')
const { loadAircraftCache, loadFiresCache, loadAirportsCache } = require('./lib/cache')
const { initFirestore }                           = require('./lib/firestore')
const { fetchAirports }                           = require('./lib/airports')
const { fetchAircraft }                           = require('./lib/aircraft')
const { fetchFIRMS }                              = require('./lib/fires')

// ─── Express + Socket.io ──────────────────────────────────────────────────────

const app = express()
app.set('json spaces', 2)
const server = http.createServer(app)

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
})

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001

// ─── In-memory state ──────────────────────────────────────────────────────────

let aircraftData = loadAircraftCache()
let fireData     = loadFiresCache()
let airportData  = loadAirportsCache()

// ─── Fetch wrappers (fetch → update state → broadcast) ───────────────────────

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
    fireData = data
    io.emit('fires:update', fireData)
  }
}

async function doFetchAirports() {
  const data = await fetchAirports()
  if (data.length > 0) airportData = data
}

// ─── REST API endpoints ───────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    connections: io.engine.clientsCount,
    counts: {
      aircraft: aircraftData.length,
      fires:    fireData.length,
    },
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

// ─── Socket.io connection ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  log('Socket', `Client connected: ${socket.id}`)

  socket.on('data:init', () => {
    // Each type handled independently — no blocking between them

    ;(async () => {
      if (airportData.length === 0) {
        log('Airports', 'No cache — fetching…')
        airportData = await fetchAirports()
      }
      socket.emit('airports:update', airportData)
      log('Socket', `airports:update → ${airportData.length} ap → ${socket.id}`)
    })()

    ;(async () => {
      const ac = loadAircraftCache()
      socket.emit('aircraft:update', ac)
      log('Socket', `aircraft:update → ${ac.length} ac → ${socket.id}`)
    })()

    ;(async () => {
      const fires = loadFiresCache()
      socket.emit('fires:update', fires)
      log('Socket', `fires:update → ${fires.length} fires → ${socket.id}`)
    })()
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

  const aircraftInterval = parseInt(process.env.AIRCRAFT_INTERVAL_MS) || 100_000
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

  log('Socket', `Base intervals — aircraft: ${aircraftInterval}ms  fires: ${firesInterval}ms  jitter: ×${jitterMult}`)

  doFetchAirports().catch(err => log('Airports', `Startup fetch failed: ${err.message}`, 'error'))
  doFetchAircraft().catch(err => log('OpenSky', `Startup fetch failed: ${err.message}`, 'error'))
    .finally(() => scheduleWithJitter(doFetchAircraft, aircraftInterval, 'OpenSky'))
  doFetchFIRMS().catch(err => log('FIRMS', `Startup fetch failed: ${err.message}`, 'error'))
    .finally(() => scheduleWithJitter(doFetchFIRMS, firesInterval, 'FIRMS'))
})
