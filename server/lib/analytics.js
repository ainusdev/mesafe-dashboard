const { log } = require('./logger')

// ─── Config ─────────────────────────────────────────────────────────────────
const HISTORY_MAX = 60          // positions per aircraft (ring buffer)
const PROXIMITY_ALERT_KM = 50   // alert if aircraft within Xkm of military base
const ANOMALY_ALT_DELTA = 5000  // ft change between snapshots
const ANOMALY_SPEED_MIN = 50    // knots — below this at altitude = suspicious
const STATS_WINDOW = 1440       // max snapshot count (~24h at 1/min)

// ─── Military zones for geofencing ──────────────────────────────────────────
const MILITARY_ZONES = [
  { id: 'nsa-bahrain',   name: 'NSA Bahrain',          lat: 26.2361, lon: 50.6120, radiusKm: 30 },
  { id: 'al-udeid',      name: 'Al Udeid AB',          lat: 25.1174, lon: 51.3148, radiusKm: 30 },
  { id: 'al-dhafra',     name: 'Al Dhafra AB',         lat: 24.2482, lon: 54.5478, radiusKm: 30 },
  { id: 'camp-arifjan',  name: 'Camp Arifjan',         lat: 29.0836, lon: 48.1018, radiusKm: 20 },
  { id: 'prince-sultan', name: 'Prince Sultan AB',     lat: 24.0625, lon: 47.5805, radiusKm: 30 },
  { id: 'incirlik',      name: 'Incirlik AB',          lat: 37.0021, lon: 35.4259, radiusKm: 30 },
  { id: 'ali-al-salem',  name: 'Ali Al Salem AB',      lat: 29.3467, lon: 47.5208, radiusKm: 20 },
  { id: 'al-minhad',     name: 'Al Minhad AB',         lat: 25.0270, lon: 55.3652, radiusKm: 20 },
  { id: 'thumrait',      name: 'Thumrait AB',          lat: 17.6660, lon: 54.0246, radiusKm: 30 },
  { id: 'nevatim',       name: 'Nevatim AB',           lat: 31.2083, lon: 34.9330, radiusKm: 30 },
  { id: 'ramon',         name: 'Ramon AB',             lat: 30.7762, lon: 34.6675, radiusKm: 30 },
  { id: 'king-abdulaziz',name: 'King Abdulaziz AB',    lat: 26.2651, lon: 50.1528, radiusKm: 20 },
  { id: 'al-asad',       name: 'Al Asad AB',           lat: 33.7856, lon: 42.4413, radiusKm: 30 },
  // Conflict/restricted zones (approximate centers)
  { id: 'gaza',          name: 'Gaza Zone',            lat: 31.35,   lon: 34.31,   radiusKm: 40 },
  { id: 'golan',         name: 'Golan Heights',        lat: 33.00,   lon: 35.80,   radiusKm: 25 },
  { id: 'yemen-north',   name: 'Yemen North Conflict', lat: 16.00,   lon: 44.00,   radiusKm: 100 },
  { id: 'iraq-anbar',    name: 'Iraq Anbar',           lat: 33.00,   lon: 41.50,   radiusKm: 60 },
  { id: 'syria-east',    name: 'Syria East',           lat: 35.00,   lon: 39.00,   radiusKm: 80 },
]

// ─── FIR region mapping ─────────────────────────────────────────────────────
const FIR_BBOX = {
  UAE:     { latMin: 22, latMax: 26.5, lonMin: 51, lonMax: 56.5 },
  SAUDI:   { latMin: 16, latMax: 32,   lonMin: 34, lonMax: 56 },
  KUWAIT:  { latMin: 28.5, latMax: 30.2, lonMin: 46.5, lonMax: 48.5 },
  QATAR:   { latMin: 24.4, latMax: 26.2, lonMin: 50.7, lonMax: 51.7 },
  BAHRAIN: { latMin: 25.7, latMax: 26.4, lonMin: 50.3, lonMax: 50.8 },
  OMAN:    { latMin: 16.5, latMax: 26.5, lonMin: 51.8, lonMax: 60 },
  IRAQ:    { latMin: 29, latMax: 37.5, lonMin: 38.5, lonMax: 48.5 },
  IRAN:    { latMin: 25, latMax: 40,   lonMin: 44, lonMax: 63.5 },
  JORDAN:  { latMin: 29, latMax: 33.5, lonMin: 34.8, lonMax: 39.3 },
  LEBANON: { latMin: 33, latMax: 34.7, lonMin: 35, lonMax: 36.7 },
  ISRAEL:  { latMin: 29.4, latMax: 33.4, lonMin: 34, lonMax: 35.9 },
  TURKEY:  { latMin: 35.8, latMax: 42.2, lonMin: 25.5, lonMax: 44.8 },
  YEMEN:   { latMin: 12, latMax: 19,   lonMin: 42, lonMax: 54 },
  SYRIA:   { latMin: 32.3, latMax: 37.4, lonMin: 35.5, lonMax: 42.4 },
}

// ─── Haversine distance (km) ────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─── State ──────────────────────────────────────────────────────────────────
const trajectories = new Map()   // callsign → { positions: [{lat,lon,alt,ts}], ... }
const statsHistory = []          // [{ ts, regions: { FIR: { count, mil, avgAlt, avgSpd } }, ... }]
let lastAnalytics = null

// ─── Trajectory tracking ────────────────────────────────────────────────────
function updateTrajectories(aircraft) {
  const now = Date.now()
  const seen = new Set()

  for (const ac of aircraft) {
    const key = ac.callsign || ac.id
    seen.add(key)

    if (!trajectories.has(key)) {
      trajectories.set(key, { positions: [], firstSeen: now, military: ac.military })
    }
    const traj = trajectories.get(key)
    traj.positions.push({ lat: ac.lat, lon: ac.lon, alt: ac.altitude, spd: ac.speed, hdg: ac.heading, ts: now })
    if (traj.positions.length > HISTORY_MAX) traj.positions.shift()
    traj.lastSeen = now
    traj.military = ac.military
  }

  // Prune stale entries (not seen for 10min)
  for (const [key, traj] of trajectories) {
    if (now - traj.lastSeen > 600_000) trajectories.delete(key)
  }
}

// ─── Geofencing — check every aircraft against all zones ────────────────────
function computeGeofencing(aircraft) {
  const alerts = []
  for (const ac of aircraft) {
    for (const zone of MILITARY_ZONES) {
      const dist = haversineKm(ac.lat, ac.lon, zone.lat, zone.lon)
      if (dist <= zone.radiusKm) {
        alerts.push({
          aircraft: ac.callsign || ac.id,
          zone: zone.id,
          zoneName: zone.name,
          distKm: Math.round(dist * 10) / 10,
          military: ac.military,
          alt: ac.altitude,
        })
      }
    }
  }
  return alerts
}

// ─── Anomaly detection ──────────────────────────────────────────────────────
function detectAnomalies(aircraft) {
  const anomalies = []
  const now = Date.now()

  for (const ac of aircraft) {
    const key = ac.callsign || ac.id
    const traj = trajectories.get(key)
    if (!traj || traj.positions.length < 3) continue

    const prev = traj.positions[traj.positions.length - 2]
    const curr = traj.positions[traj.positions.length - 1]

    // Rapid altitude change
    if (prev.alt && curr.alt && Math.abs(curr.alt - prev.alt) > ANOMALY_ALT_DELTA) {
      anomalies.push({
        type: 'RAPID_ALT_CHANGE',
        aircraft: key,
        military: ac.military,
        detail: `${prev.alt}ft → ${curr.alt}ft (Δ${curr.alt - prev.alt}ft)`,
      })
    }

    // Loitering detection (circling pattern)
    if (traj.positions.length >= 10) {
      const recent = traj.positions.slice(-10)
      let totalHeadingChange = 0
      for (let i = 1; i < recent.length; i++) {
        if (recent[i].hdg != null && recent[i - 1].hdg != null) {
          let delta = recent[i].hdg - recent[i - 1].hdg
          if (delta > 180) delta -= 360
          if (delta < -180) delta += 360
          totalHeadingChange += Math.abs(delta)
        }
      }
      if (totalHeadingChange > 300) {
        anomalies.push({
          type: 'LOITERING',
          aircraft: key,
          military: ac.military,
          detail: `Heading change ${Math.round(totalHeadingChange)}° over ${recent.length} samples`,
        })
      }
    }

    // Slow at altitude (potential surveillance)
    if (ac.altitude > 15000 && ac.speed > 0 && ac.speed < ANOMALY_SPEED_MIN) {
      anomalies.push({
        type: 'SLOW_AT_ALTITUDE',
        aircraft: key,
        military: ac.military,
        detail: `${ac.speed}kts at ${ac.altitude}ft`,
      })
    }
  }

  return anomalies
}

// ─── Regional statistics ────────────────────────────────────────────────────
function computeRegionalStats(aircraft) {
  const regions = {}
  for (const [fir, bbox] of Object.entries(FIR_BBOX)) {
    regions[fir] = { count: 0, military: 0, totalAlt: 0, totalSpd: 0 }
  }

  for (const ac of aircraft) {
    for (const [fir, bbox] of Object.entries(FIR_BBOX)) {
      if (ac.lat >= bbox.latMin && ac.lat <= bbox.latMax &&
          ac.lon >= bbox.lonMin && ac.lon <= bbox.lonMax) {
        regions[fir].count++
        if (ac.military) regions[fir].military++
        regions[fir].totalAlt += ac.altitude || 0
        regions[fir].totalSpd += ac.speed || 0
        break // assign to first matching FIR
      }
    }
  }

  for (const r of Object.values(regions)) {
    r.avgAlt = r.count > 0 ? Math.round(r.totalAlt / r.count) : 0
    r.avgSpd = r.count > 0 ? Math.round(r.totalSpd / r.count) : 0
    delete r.totalAlt
    delete r.totalSpd
  }

  return regions
}

// ─── Position interpolation (CPU-intensive) ─────────────────────────────────
function interpolatePositions(aircraft) {
  const now = Date.now()
  const interpolated = []

  for (const ac of aircraft) {
    const key = ac.callsign || ac.id
    const traj = trajectories.get(key)
    if (!traj || traj.positions.length < 2) {
      interpolated.push(ac)
      continue
    }

    const p0 = traj.positions[traj.positions.length - 2]
    const p1 = traj.positions[traj.positions.length - 1]
    const dt = p1.ts - p0.ts
    if (dt <= 0) { interpolated.push(ac); continue }

    const t = Math.min((now - p1.ts) / dt, 2) // extrapolate up to 2x
    const lat = p1.lat + (p1.lat - p0.lat) * t
    const lon = p1.lon + (p1.lon - p0.lon) * t
    const alt = p1.alt + (p1.alt - p0.alt) * t

    // Compute distance traveled for this interpolation step
    const segKm = haversineKm(p1.lat, p1.lon, lat, lon)

    interpolated.push({
      ...ac,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      altitude: Math.round(alt),
      _interpDist: Math.round(segKm * 10) / 10,
    })
  }

  return interpolated
}

// ─── Pairwise separation check (O(n²) — deliberate CPU burn) ───────────────
function computeSeparation(aircraft) {
  const alerts = []
  const SEP_MIN_KM = 10    // horizontal separation minimum
  const SEP_MIN_FT = 1000  // vertical separation minimum

  for (let i = 0; i < aircraft.length; i++) {
    for (let j = i + 1; j < aircraft.length; j++) {
      const a = aircraft[i], b = aircraft[j]
      if (!a.lat || !b.lat) continue

      const hDist = haversineKm(a.lat, a.lon, b.lat, b.lon)
      if (hDist > SEP_MIN_KM * 3) continue // quick skip

      const vDist = Math.abs((a.altitude || 0) - (b.altitude || 0))

      if (hDist < SEP_MIN_KM && vDist < SEP_MIN_FT) {
        alerts.push({
          pair: [a.callsign || a.id, b.callsign || b.id],
          hDistKm: Math.round(hDist * 10) / 10,
          vDistFt: Math.round(vDist),
          avgAlt: Math.round(((a.altitude || 0) + (b.altitude || 0)) / 2),
        })
      }
    }
  }
  return alerts
}

// ─── Main analytics tick ────────────────────────────────────────────────────
function runAnalytics(aircraft) {
  if (!aircraft || aircraft.length === 0) return lastAnalytics
  const t0 = Date.now()

  // 1. Update trajectory history
  updateTrajectories(aircraft)

  // 2. Geofencing — every aircraft × every zone
  const geofenceAlerts = computeGeofencing(aircraft)

  // 3. Anomaly detection
  const anomalies = detectAnomalies(aircraft)

  // 4. Regional statistics
  const regions = computeRegionalStats(aircraft)

  // 5. Position interpolation
  const interpolated = interpolatePositions(aircraft)

  // 6. Pairwise separation (O(n²))
  const separation = computeSeparation(aircraft)

  // 7. Density heatmap grid (O(n) place + O(G²×K²) smooth)
  const density = computeDensityGrid(aircraft)

  // 8. Conflict prediction (O(n²) × simSteps — heaviest computation)
  const conflicts = predictConflicts(aircraft)

  // 9. Trajectory quality scoring
  const trajScores = scoreTrajectories()

  // 10. Layered density (3× density grid computation)
  const layeredDensity = computeLayeredDensity(aircraft)

  // 11. Snapshot for time-series
  const snapshot = { ts: t0, total: aircraft.length, military: aircraft.filter(a => a.military).length, regions }
  statsHistory.push(snapshot)
  if (statsHistory.length > STATS_WINDOW) statsHistory.shift()

  // 10. Compute trend (last 10 snapshots)
  const trend = statsHistory.length >= 2
    ? {
        totalDelta: snapshot.total - statsHistory[Math.max(0, statsHistory.length - 11)].total,
        milDelta: snapshot.military - statsHistory[Math.max(0, statsHistory.length - 11)].military,
        windowMin: statsHistory.length,
      }
    : null

  const elapsed = Date.now() - t0

  lastAnalytics = {
    ts: t0,
    elapsed,
    aircraft: aircraft.length,
    tracked: trajectories.size,
    geofenceAlerts: geofenceAlerts.length,
    geofence: geofenceAlerts.slice(0, 20),
    anomalies: anomalies.slice(0, 20),
    separation: separation.slice(0, 20),
    conflicts,
    density,
    layeredDensity: { LOW: layeredDensity.LOW.count, MED: layeredDensity.MED.count, HIGH: layeredDensity.HIGH.count },
    trajScores: trajScores.slice(0, 10),
    regions,
    trend,
  }

  if (elapsed > 100) {
    log('Analytics', `Tick: ${aircraft.length} ac, ${geofenceAlerts.length} geofence, ${anomalies.length} anomalies, ${separation.length} sep — ${elapsed}ms`)
  }

  return lastAnalytics
}

// ─── Density heatmap grid (CPU-intensive: N aircraft × G² grid cells) ───────
const GRID_SIZE = 200  // 200×200 = 40K cells
const GRID_BOUNDS = { latMin: 12, latMax: 42, lonMin: 25, lonMax: 63 }
const SMOOTH_RADIUS = 5  // cells — Gaussian kernel radius

function computeDensityGrid(aircraft) {
  const latStep = (GRID_BOUNDS.latMax - GRID_BOUNDS.latMin) / GRID_SIZE
  const lonStep = (GRID_BOUNDS.lonMax - GRID_BOUNDS.lonMin) / GRID_SIZE
  const grid = new Float64Array(GRID_SIZE * GRID_SIZE)

  // Place each aircraft in grid
  for (const ac of aircraft) {
    const row = Math.floor((ac.lat - GRID_BOUNDS.latMin) / latStep)
    const col = Math.floor((ac.lon - GRID_BOUNDS.lonMin) / lonStep)
    if (row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE) {
      grid[row * GRID_SIZE + col] += 1
    }
  }

  // Gaussian smoothing pass — O(G² × kernel²)
  const smoothed = new Float64Array(GRID_SIZE * GRID_SIZE)
  const sigma = SMOOTH_RADIUS / 2
  const kernel = []
  for (let dr = -SMOOTH_RADIUS; dr <= SMOOTH_RADIUS; dr++) {
    for (let dc = -SMOOTH_RADIUS; dc <= SMOOTH_RADIUS; dc++) {
      const w = Math.exp(-(dr * dr + dc * dc) / (2 * sigma * sigma))
      kernel.push({ dr, dc, w })
    }
  }

  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      let sum = 0, wSum = 0
      for (const { dr, dc, w } of kernel) {
        const nr = r + dr, nc = c + dc
        if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE) {
          sum += grid[nr * GRID_SIZE + nc] * w
          wSum += w
        }
      }
      smoothed[r * GRID_SIZE + c] = sum / wSum
    }
  }

  // Find hotspots (cells above threshold)
  let maxVal = 0
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] > maxVal) maxVal = smoothed[i]
  }

  const hotspots = []
  const threshold = maxVal * 0.5
  if (threshold > 0) {
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (smoothed[r * GRID_SIZE + c] >= threshold) {
          hotspots.push({
            lat: GRID_BOUNDS.latMin + (r + 0.5) * latStep,
            lon: GRID_BOUNDS.lonMin + (c + 0.5) * lonStep,
            density: Math.round(smoothed[r * GRID_SIZE + c] * 100) / 100,
          })
        }
      }
    }
  }

  return { maxDensity: Math.round(maxVal * 100) / 100, hotspots: hotspots.slice(0, 30) }
}

// ─── Conflict prediction (Monte Carlo — main CPU consumer) ──────────────────
function predictConflicts(aircraft, simSteps = 120, simDt = 15) {
  // For each pair within 100km, simulate forward positions and check for convergence
  const conflicts = []
  const KT_TO_KM_S = 1.852 / 3600  // knots to km/s

  const candidates = []
  for (let i = 0; i < aircraft.length; i++) {
    for (let j = i + 1; j < aircraft.length; j++) {
      const d = haversineKm(aircraft[i].lat, aircraft[i].lon, aircraft[j].lat, aircraft[j].lon)
      if (d < 150) candidates.push([i, j, d])
    }
  }

  for (const [i, j, initDist] of candidates) {
    const a = aircraft[i], b = aircraft[j]
    if (!a.heading || !b.heading) continue

    const aSpd = (a.speed || 0) * KT_TO_KM_S
    const bSpd = (b.speed || 0) * KT_TO_KM_S
    const aHdgRad = (a.heading || 0) * Math.PI / 180
    const bHdgRad = (b.heading || 0) * Math.PI / 180

    let minDist = initDist
    let minTime = 0

    // Simulate forward
    let aLat = a.lat, aLon = a.lon
    let bLat = b.lat, bLon = b.lon
    const degPerKm = 1 / 111.32

    for (let s = 1; s <= simSteps; s++) {
      const t = s * simDt
      aLat += aSpd * simDt * Math.cos(aHdgRad) * degPerKm
      aLon += aSpd * simDt * Math.sin(aHdgRad) * degPerKm / Math.cos(aLat * Math.PI / 180)
      bLat += bSpd * simDt * Math.cos(bHdgRad) * degPerKm
      bLon += bSpd * simDt * Math.sin(bHdgRad) * degPerKm / Math.cos(bLat * Math.PI / 180)

      const d = haversineKm(aLat, aLon, bLat, bLon)
      if (d < minDist) {
        minDist = d
        minTime = t
      }
    }

    if (minDist < 20 && minDist < initDist * 0.5) {
      conflicts.push({
        pair: [a.callsign || a.id, b.callsign || b.id],
        currentDistKm: Math.round(initDist * 10) / 10,
        minDistKm: Math.round(minDist * 10) / 10,
        timeToMinSec: minTime,
      })
    }
  }

  return conflicts.sort((a, b) => a.minDistKm - b.minDistKm).slice(0, 20)
}

// ─── Trajectory quality scoring (uses full history per aircraft) ─────────────
function scoreTrajectories() {
  const scores = []
  for (const [key, traj] of trajectories) {
    if (traj.positions.length < 5) continue
    const pts = traj.positions

    // Compute total distance traveled
    let totalDist = 0
    for (let i = 1; i < pts.length; i++) {
      totalDist += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)
    }

    // Compute straight-line distance (start to end)
    const directDist = haversineKm(pts[0].lat, pts[0].lon, pts[pts.length - 1].lat, pts[pts.length - 1].lon)

    // Efficiency ratio (1.0 = perfectly straight)
    const efficiency = directDist > 0.1 ? Math.min(directDist / totalDist, 1.0) : 0

    // Altitude variance
    const alts = pts.map(p => p.alt).filter(a => a > 0)
    if (alts.length > 1) {
      const mean = alts.reduce((a, b) => a + b) / alts.length
      const variance = alts.reduce((s, a) => s + (a - mean) ** 2, 0) / alts.length
      const altStdDev = Math.sqrt(variance)

      // Speed consistency
      const spds = pts.map(p => p.spd).filter(s => s > 0)
      const spdMean = spds.length > 0 ? spds.reduce((a, b) => a + b) / spds.length : 0
      const spdVar = spds.length > 1 ? spds.reduce((s, v) => s + (v - spdMean) ** 2, 0) / spds.length : 0

      scores.push({
        aircraft: key,
        military: traj.military,
        samples: pts.length,
        totalDistKm: Math.round(totalDist * 10) / 10,
        efficiency: Math.round(efficiency * 1000) / 1000,
        altStdDev: Math.round(altStdDev),
        spdStdDev: Math.round(Math.sqrt(spdVar)),
      })
    }
  }
  return scores.sort((a, b) => a.efficiency - b.efficiency).slice(0, 20)
}

// ─── Multi-pass density with altitude layers ─────────────────────────────────
function computeLayeredDensity(aircraft) {
  const layers = [
    { name: 'LOW', minAlt: 0, maxAlt: 10000 },
    { name: 'MED', minAlt: 10000, maxAlt: 25000 },
    { name: 'HIGH', minAlt: 25000, maxAlt: 60000 },
  ]
  const results = {}
  for (const layer of layers) {
    const filtered = aircraft.filter(ac => ac.altitude >= layer.minAlt && ac.altitude < layer.maxAlt)
    results[layer.name] = { count: filtered.length, grid: computeDensityGrid(filtered) }
  }
  return results
}

function getAnalytics() { return lastAnalytics }
function getStatsHistory() { return statsHistory }

module.exports = { runAnalytics, getAnalytics, getStatsHistory }
