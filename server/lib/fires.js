const axios = require('axios')
const fs    = require('fs')
const path  = require('path')
const { log } = require('./logger')
const { FIRMS_CSV_HEADERS, saveFiresCache } = require('./cache')
const { saveFiresToFirestore } = require('./firestore')

// ─── Optional raw FIRMS CSV dump ──────────────────────────────────────────────

function saveFireCSV(fires) {
  try {
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = path.join(__dirname, '../firms_dumps')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    const csvPath = path.join(dir, `firms_${ts}.csv`)
    const rows = [FIRMS_CSV_HEADERS.join(',')]
    for (const f of fires) {
      rows.push([
        f.id, f.coords[0], f.coords[1], f.brightness, f.frp,
        f.confidence, f.acqDate, f.acqTime, f.acqTimestamp, f.intensity,
      ].join(','))
    }
    fs.writeFileSync(csvPath, rows.join('\n'), 'utf8')
    log('FIRMS', `Saved ${fires.length} rows → firms_dumps/firms_${ts}.csv`)
  } catch (err) {
    log('FIRMS', `CSV save error: ${err.message}`, 'error')
  }
}

function loadLatestFireCSV() {
  try {
    const dir = path.join(__dirname, '../firms_dumps')
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => f.startsWith('firms_') && f.endsWith('.csv')).sort()
    if (files.length === 0) return []
    const latest = path.join(dir, files[files.length - 1])
    const lines  = fs.readFileSync(latest, 'utf8').trim().split('\n')
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
    log('FIRMS', `CSV load error: ${err.message}`, 'error')
    return []
  }
}

// ─── Main fetch function ──────────────────────────────────────────────────────

/** Fetch VIIRS 375m fire hotspots from NASA FIRMS. Returns fires array. */
async function fetchFIRMS() {
  const mapKey = process.env.NASA_FIRMS_MAP_KEY
  if (!mapKey) {
    log('FIRMS', 'NASA_FIRMS_MAP_KEY not set — skipping', 'warn')
    return []
  }

  try {
    // Bounding box: west,south,east,north — last 1 day, VIIRS SNPP NRT
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/VIIRS_SNPP_NRT/29,22,60,42/1`
    const res = await axios.get(url, { timeout: 30000 })

    const lines = res.data.trim().split('\n')
    if (lines.length < 2) {
      log('FIRMS', 'No fire data returned', 'warn')
      return []
    }

    const fires = []
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',')
      if (vals.length < 13) continue

      const lat        = parseFloat(vals[0])
      const lon        = parseFloat(vals[1])
      const brightness = parseFloat(vals[2])  // Kelvin
      const frp        = parseFloat(vals[12]) || 0
      const confidence = vals[9] || 'n'
      const acqDate    = vals[5] || ''
      const acqTime    = vals[6] || ''

      if (isNaN(lat) || isNaN(lon)) continue

      const t            = String(acqTime).padStart(4, '0')
      const acqTimestamp = acqDate
        ? new Date(`${acqDate}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`).getTime()
        : Date.now()

      fires.push({
        id:         `fire-${acqDate}-${t}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
        coords:     [lon, lat],
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
      log('Firestore', `Save error: ${err.message}`, 'error'),
    )

    const result = process.env.SAVE_FIRMS_CSV === 'true' ? loadLatestFireCSV() : fires
    saveFiresCache(result)
    log('FIRMS', `${result.length} fire hotspots`)
    return result
  } catch (err) {
    log('FIRMS', `Fetch error: ${err.message}`, 'error')
    return []
  }
}

module.exports = { fetchFIRMS }
