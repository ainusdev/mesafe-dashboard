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

// ─── Parse FIRMS CSV response ────────────────────────────────────────────────

function parseFIRMScsv(csvText, source) {
  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return []

  const fires = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',')
    if (vals.length < 13) continue

    const lat        = parseFloat(vals[0])
    const lon        = parseFloat(vals[1])
    const brightness = parseFloat(vals[2])
    const frp        = parseFloat(vals[12]) || 0
    const confidence = vals[9] || 'n'
    const acqDate    = vals[5] || ''
    const acqTime    = vals[6] || ''

    if (isNaN(lat) || isNaN(lon)) continue

    const confLower = String(confidence).toLowerCase()
    if (confLower === 'l' || confLower === 'low') continue
    const confNum = parseInt(confidence, 10)
    if (!isNaN(confNum) && confNum < 30) continue

    const t            = String(acqTime).padStart(4, '0')
    const acqTimestamp = acqDate
      ? new Date(`${acqDate}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`).getTime()
      : Date.now()

    fires.push({
      id:         `fire-${source}-${acqDate}-${t}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
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
  return fires
}

// ─── EUMETSAT MTG Active Fire Monitoring (CAP XML) ────────────────────────────

let eumetsatToken = null
let eumetsatTokenExpiry = 0

async function getEumetsatToken() {
  if (eumetsatToken && Date.now() < eumetsatTokenExpiry - 60000) return eumetsatToken

  const key = process.env.EUMETSAT_CONSUMER_KEY
  const secret = process.env.EUMETSAT_CONSUMER_SECRET
  if (!key || !secret) return null

  const basic = Buffer.from(`${key}:${secret}`).toString('base64')
  const res = await axios.post('https://api.eumetsat.int/token', 'grant_type=client_credentials', {
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 15000,
  })

  eumetsatToken = res.data.access_token
  eumetsatTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000
  log('EUMETSAT', `Token obtained — expires in ${res.data.expires_in}s`)
  return eumetsatToken
}

const ME_BBOX = { west: 29, south: 22, east: 60, north: 42 }
const COLLECTION_CAP = 'EO%3AEUM%3ADAT%3A0801'

async function fetchEUMETSAT() {
  const token = await getEumetsatToken()
  if (!token) return []

  try {
    const now = new Date()
    const ymd = now.toISOString().slice(0, 10).split('-') // [YYYY, MM, DD]

    // Get today's products list
    const listUrl = `https://api.eumetsat.int/data/browse/1.0.0/collections/${COLLECTION_CAP}/dates/${ymd[0]}/${ymd[1]}/${ymd[2]}/products?format=json`
    const listRes = await axios.get(listUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    })

    // Parse products — get the latest one
    const productList = listRes.data?.products || []
    if (productList.length === 0) {
      log('EUMETSAT', 'No products found today')
      return []
    }

    // Latest product is first in the list (newest first)
    const latest = productList[0]
    const productId = latest.id || latest.identifier || ''
    if (!productId) {
      log('EUMETSAT', 'No product ID in response')
      return []
    }

    const encodedId = encodeURIComponent(productId)

    // Get product details to find the CAP XML entry
    const detailUrl = `https://api.eumetsat.int/data/browse/1.0.0/collections/${COLLECTION_CAP}/products/${encodedId}?format=json`
    const detailRes = await axios.get(detailUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    })

    // Find the CAP XML download link from SIP entries or direct download
    const detail = detailRes.data
    let downloadUrl = null

    // Check for SIP entries with CAP XML
    const entries = detail?.properties?.links?.data || detail?.distribution || detail?.links || []
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      const href = entry.href || entry.url || ''
      if (href.includes('CAP') || (entry.mediaType || '').includes('xml')) {
        downloadUrl = href
        break
      }
    }

    // Fallback: direct download URL
    if (!downloadUrl) {
      downloadUrl = `https://api.eumetsat.int/data/download/1.0.0/collections/${COLLECTION_CAP}/products/${encodedId}`
    }

    log('EUMETSAT', `Downloading: ${productId.slice(-30)}`)

    const dlRes = await axios.get(downloadUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': '*/*' },
      timeout: 30000,
      responseType: 'arraybuffer',
    })

    let xmlText = ''
    const buf = Buffer.from(dlRes.data)

    // Check if it's a ZIP (PK header)
    if (buf[0] === 0x50 && buf[1] === 0x4B) {
      // Simple ZIP extraction — find the CAP XML file inside
      const AdmZip = require('adm-zip')
      const zip = new AdmZip(buf)
      const entries = zip.getEntries()
      for (const entry of entries) {
        if (entry.entryName.endsWith('.xml') && !entry.entryName.includes('Metadata') && !entry.entryName.includes('manifest')) {
          xmlText = entry.getData().toString('utf8')
          break
        }
      }
      if (!xmlText) {
        // Try any XML
        for (const entry of entries) {
          if (entry.entryName.endsWith('.xml') || entry.entryName.endsWith('.cap')) {
            xmlText = entry.getData().toString('utf8')
            break
          }
        }
      }
    } else {
      xmlText = buf.toString('utf8')
    }

    if (!xmlText) {
      log('EUMETSAT', 'No XML data found in download', 'warn')
      return []
    }

    const fires = parseCAPxml(xmlText)
    log('EUMETSAT', `${fires.length} hotspots from MTG (Middle East bbox)`)
    return fires
  } catch (err) {
    log('EUMETSAT', `Fetch error: ${err.message}`, 'warn')
    return []
  }
}

/** Parse CAP (Common Alerting Protocol) XML — extract fire coordinates */
function parseCAPxml(xml) {
  const fires = []

  // CAP XML has <area> elements with <circle> or <polygon> containing coordinates
  // <circle>lat,lon radius</circle>  OR  <geocode><value>lat lon</value></geocode>
  // Also check for <parameter> with FRP values

  // Extract all <info> blocks which represent individual fire alerts
  const infoBlocks = xml.split(/<info>/i).slice(1)

  for (const block of infoBlocks) {
    // Extract coordinates from <circle> elements: "lat,lon radius"
    const circleMatches = block.match(/<circle>\s*([^<]+)\s*<\/circle>/gi) || []

    for (const cm of circleMatches) {
      const inner = cm.replace(/<\/?circle>/gi, '').trim()
      // Format: "lat,lon radius" or "lat,lon"
      const parts = inner.split(/\s+/)
      const coords = parts[0].split(',')
      if (coords.length < 2) continue

      const lat = parseFloat(coords[0])
      const lon = parseFloat(coords[1])
      if (isNaN(lat) || isNaN(lon)) continue
      if (lat < ME_BBOX.south || lat > ME_BBOX.north) continue
      if (lon < ME_BBOX.west || lon > ME_BBOX.east) continue

      // Try to extract FRP from <parameter> in this block
      let frp = 0
      const frpMatch = block.match(/<valueName>\s*FRP\s*<\/valueName>\s*<value>\s*([^<]+)/i)
      if (frpMatch) frp = parseFloat(frpMatch[1]) || 0

      const now = new Date()
      // Try to get onset time
      const onsetMatch = block.match(/<onset>\s*([^<]+)/i)
      const acqTime = onsetMatch ? new Date(onsetMatch[1].trim()) : now
      const acqDate = acqTime.toISOString().slice(0, 10)
      const acqHHMM = acqTime.toISOString().slice(11, 15).replace(':', '')

      fires.push({
        id: `fire-MTG-${acqDate}-${acqHHMM}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
        coords: [lon, lat],
        brightness: Math.min(1, Math.max(0, frp / 200)),
        frp: Math.max(0, frp),
        confidence: 'h',
        acqDate,
        acqTime: acqHHMM,
        acqTimestamp: acqTime.getTime(),
        intensity: frp > 100 ? 'EXTREME' : frp > 50 ? 'HIGH' : frp > 10 ? 'MEDIUM' : 'LOW',
      })
    }

    // Also try <polygon> elements: "lat1,lon1 lat2,lon2 ..." (centroid)
    const polyMatches = block.match(/<polygon>\s*([^<]+)\s*<\/polygon>/gi) || []
    for (const pm of polyMatches) {
      const inner = pm.replace(/<\/?polygon>/gi, '').trim()
      const points = inner.split(/\s+/)
      if (points.length < 1) continue

      // Use centroid
      let sumLat = 0, sumLon = 0, count = 0
      for (const p of points) {
        const [la, lo] = p.split(',').map(Number)
        if (!isNaN(la) && !isNaN(lo)) { sumLat += la; sumLon += lo; count++ }
      }
      if (count === 0) continue
      const lat = sumLat / count
      const lon = sumLon / count

      if (lat < ME_BBOX.south || lat > ME_BBOX.north) continue
      if (lon < ME_BBOX.west || lon > ME_BBOX.east) continue

      let frp = 0
      const frpMatch = block.match(/<valueName>\s*FRP\s*<\/valueName>\s*<value>\s*([^<]+)/i)
      if (frpMatch) frp = parseFloat(frpMatch[1]) || 0

      const now = new Date()
      const onsetMatch = block.match(/<onset>\s*([^<]+)/i)
      const acqTime = onsetMatch ? new Date(onsetMatch[1].trim()) : now
      const acqDate = acqTime.toISOString().slice(0, 10)
      const acqHHMM = acqTime.toISOString().slice(11, 15).replace(':', '')

      fires.push({
        id: `fire-MTG-${acqDate}-${acqHHMM}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
        coords: [lon, lat],
        brightness: Math.min(1, Math.max(0, frp / 200)),
        frp: Math.max(0, frp),
        confidence: 'h',
        acqDate,
        acqTime: acqHHMM,
        acqTimestamp: acqTime.getTime(),
        intensity: frp > 100 ? 'EXTREME' : frp > 50 ? 'HIGH' : frp > 10 ? 'MEDIUM' : 'LOW',
      })
    }
  }

  return fires
}

// ─── Main fetch function ──────────────────────────────────────────────────────

const BBOX = '29,22,60,42'
const SOURCES = [
  'VIIRS_SNPP_NRT',
  'VIIRS_NOAA20_NRT',
  'MODIS_NRT',
]

async function fetchFIRMS() {
  const [firmsResult, eumetsatResult] = await Promise.allSettled([
    fetchAllFIRMS(),
    fetchEUMETSAT(),
  ])

  const allFires = []
  if (firmsResult.status === 'fulfilled') allFires.push(...firmsResult.value)
  else log('FIRMS', `Failed: ${firmsResult.reason?.message}`, 'warn')

  if (eumetsatResult.status === 'fulfilled') allFires.push(...eumetsatResult.value)
  else log('EUMETSAT', `Failed: ${eumetsatResult.reason?.message}`, 'warn')

  const deduped = deduplicateFires(allFires)

  if (process.env.SAVE_FIRMS_CSV === 'true') saveFireCSV(deduped)

  saveFiresToFirestore(deduped).catch(err =>
    log('Firestore', `Save error: ${err.message}`, 'error'),
  )

  const result = process.env.SAVE_FIRMS_CSV === 'true' ? loadLatestFireCSV() : deduped
  saveFiresCache(result)

  const hasFirms = firmsResult.status === 'fulfilled'
  const hasEumetsat = eumetsatResult.status === 'fulfilled' && eumetsatResult.value.length > 0
  const srcLabel = [hasFirms && 'FIRMS', hasEumetsat && 'EUMETSAT'].filter(Boolean).join('+') || 'none'
  log('FIRMS', `${result.length} hotspots total (${srcLabel})`)
  return result
}

async function fetchAllFIRMS() {
  const mapKey = process.env.NASA_FIRMS_MAP_KEY
  if (!mapKey) {
    log('FIRMS', 'NASA_FIRMS_MAP_KEY not set — skipping', 'warn')
    return []
  }

  const results = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${src}/${BBOX}/1`
      const res = await axios.get(url, { timeout: 30000 })
      const fires = parseFIRMScsv(res.data, src)
      log('FIRMS', `${src}: ${fires.length} hotspots`)
      return fires
    })
  )

  const allFires = []
  for (const r of results) {
    if (r.status === 'fulfilled') allFires.push(...r.value)
    else log('FIRMS', `Source failed: ${r.reason?.message}`, 'warn')
  }
  return allFires
}

function deduplicateFires(fires) {
  const THRESHOLD = 0.005
  const kept = []
  const used = new Set()

  fires.sort((a, b) => b.frp - a.frp)

  for (let i = 0; i < fires.length; i++) {
    if (used.has(i)) continue
    kept.push(fires[i])
    for (let j = i + 1; j < fires.length; j++) {
      if (used.has(j)) continue
      const dlat = Math.abs(fires[i].coords[1] - fires[j].coords[1])
      const dlon = Math.abs(fires[i].coords[0] - fires[j].coords[0])
      if (dlat < THRESHOLD && dlon < THRESHOLD) {
        used.add(j)
      }
    }
  }
  return kept
}

module.exports = { fetchFIRMS }
