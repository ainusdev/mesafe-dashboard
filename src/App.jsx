import { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

// ─── Module-level constants ────────────────────────────────────────────────

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const BACKEND_URL = import.meta.env.DEV
  ? import.meta.env.VITE_BACKEND_DEV_URL
  : import.meta.env.VITE_BACKEND_RELEASE_URL

const REGIONS = {
  IRAN:         { name: 'IRAN',         center: [53.6880, 32.4279], zoom: 5 },
  IRAQ:         { name: 'IRAQ',         center: [43.6793, 33.2232], zoom: 5 },
  ISRAEL:       { name: 'ISRAEL',       center: [34.8516, 31.0461], zoom: 5 },
  JORDAN:       { name: 'JORDAN',       center: [36.2384, 31.2457], zoom: 5 },
  LEBANON:      { name: 'LEBANON',      center: [35.8623, 33.8547], zoom: 5 },
  PALESTINE:    { name: 'PALESTINE',    center: [34.5,    31.8   ], zoom: 5 },
  SAUDI_ARABIA: { name: 'SAUDI ARABIA', center: [45.0792, 23.8859], zoom: 5 },
  SYRIA:        { name: 'SYRIA',        center: [38.9968, 34.8021], zoom: 5 },
  YEMEN:        { name: 'YEMEN',        center: [47.5079, 15.5527], zoom: 5 },
}

const REGION_TZ = {
  IRAN:         'Asia/Tehran',
  IRAQ:         'Asia/Baghdad',
  ISRAEL:       'Asia/Jerusalem',
  JORDAN:       'Asia/Amman',
  LEBANON:      'Asia/Beirut',
  PALESTINE:    'Asia/Gaza',
  SAUDI_ARABIA: 'Asia/Riyadh',
  SYRIA:        'Asia/Damascus',
  YEMEN:        'Asia/Aden',
}

const REGION_CODE = {
  IRAN: 'IRN', IRAQ: 'IRQ', ISRAEL: 'ISR', JORDAN: 'JOR',
  LEBANON: 'LBN', PALESTINE: 'PSE', SAUDI_ARABIA: 'KSA',
  SYRIA: 'SYR', YEMEN: 'YEM',
}

const _tzFmt = {}
function formatTZ(date, tz) {
  if (!_tzFmt[tz]) {
    _tzFmt[tz] = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }
  return _tzFmt[tz].format(date)
}

// Civilian airliner — top-down silhouette (wide body, swept wings + stabilizers)
function makeCivilianSVG(color) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <ellipse cx="16" cy="15" rx="2.5" ry="13" fill="${color}"/>
      <polygon points="16,13 1,22 13.5,20" fill="${color}" opacity="0.88"/>
      <polygon points="16,13 31,22 18.5,20" fill="${color}" opacity="0.88"/>
      <polygon points="16,27 8,31 14.5,29" fill="${color}" opacity="0.72"/>
      <polygon points="16,27 24,31 17.5,29" fill="${color}" opacity="0.72"/>
    </svg>`
  )}`
}

// Military fighter — top-down silhouette (delta wing + canards, F-16 style)
function makeMilitarySVG(color) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <polygon points="16,1 18,30 16,26 14,30" fill="${color}"/>
      <polygon points="16,9 30,28 16,22 2,28" fill="${color}" opacity="0.88"/>
      <polygon points="16,10 23,16 16,13 9,16" fill="${color}" opacity="0.65"/>
    </svg>`
  )}`
}

// Civilian callsigns (airline code + flight number → trip.com link works)
const CALLSIGNS_CIVILIAN = [
  'EK471','EK828','FZ204','QR541','QR007','EY302','MS903',
  'GF452','TK788','GF103','SV872','WY513','ME342',
]
// Korean carrier callsigns
const CALLSIGNS_KOREAN = [
  'KAL001','KAL851','KAL958','AAR271','AAR603','JJA151','JJA225','ABL661',
]
// Military callsigns
const CALLSIGNS_MILITARY = [
  'EAGLE-1','EAGLE-2','VIPER-1','VIPER-3','HAWK-7','HAWK-9',
  'COBRA-2','COBRA-4','FALCON-5','GHOST-3','RAVEN-2','WOLF-1',
]
// Private jets — hex IDs (no real callsign → shows as private)
const CALLSIGNS_PRIVATE = [
  '740123','896185','a3f200','730b4c','710e91','ae1234','3a8bc0',
]

const KOREAN_AIRPORT_CODES = new Set(['RKSI','RKSS','RKPK','RKTN','RKJJ','ICN','GMP','PUS','TAE','CJU'])
const KOREAN_CARRIER_PREFIXES = ['KAL','AAR','JJA','ABL','TWB','ESR']

function isRealCallsign(callsign) {
  return /^[A-Z]{2,3}\d{1,4}[A-Z]?$/i.test((callsign || '').trim())
}

// ─── Pure utility functions ────────────────────────────────────────────────

function rand(min, max) { return Math.random() * (max - min) + min }
function randInt(min, max) { return Math.floor(rand(min, max + 1)) }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function offsetCoord(center, rangeKm) {
  const d = 1 / 111
  return [center[0] + rand(-rangeKm, rangeKm) * d, center[1] + rand(-rangeKm, rangeKm) * d]
}

function generateAircraft(center) {
  const count = randInt(20, 30)
  return Array.from({ length: count }, (_, i) => {
    const r = Math.random()
    // ~20% military, ~15% private, ~15% Korean carrier, ~50% civilian
    const isMilitary = r < 0.20
    const isPrivate  = r < 0.35 && !isMilitary
    const isKorean   = r < 0.50 && !isMilitary && !isPrivate

    let callsign, route, actype
    if (isMilitary) {
      callsign = randItem(CALLSIGNS_MILITARY)
      actype   = randItem(['F-16','F-15','C-130','B-52','MQ-9','UH-60'])
      route    = null
    } else if (isPrivate) {
      callsign = randItem(CALLSIGNS_PRIVATE)
      actype   = randItem(['G650','C560','PC12','E135'])
      route    = null
    } else if (isKorean) {
      callsign = randItem(CALLSIGNS_KOREAN)
      actype   = randItem(['B77W','A380','B787','A330'])
      route    = Math.random() < 0.8 ? randItem(['DOH→ICN','DXB→ICN','MCT→GMP','AUH→ICN','RUH→ICN','AMM→ICN']) : null
    } else {
      callsign = randItem(CALLSIGNS_CIVILIAN)
      actype   = randItem(['B77W','A320','A330','B737','A321'])
      route    = Math.random() < 0.6 ? randItem(['DXB→LHR','EWR→DXB','TLV→JFK','THR→VIE','BEY→CDG','DOH→LHR','MCT→BOM']) : null
    }

    return {
      id: `ac-${Date.now()}-${i}`,
      coords: offsetCoord(center, 200),
      heading: rand(0, 360),
      speed: rand(0.008, 0.018),
      callsign,
      altitude: randInt(isMilitary ? 1000 : 20000, 45000),
      actype,
      military: isMilitary,
      route,
      registration: '',
    }
  })
}

function generateFires(center) {
  return Array.from({ length: randInt(15, 30) }, (_, i) => {
    // 24시간에 걸쳐 고르게 분포 — time window 필터 테스트용
    const ageMs = randInt(0, 86400000)
    const d = new Date(Date.now() - ageMs)
    const hhmm = d.getUTCHours().toString().padStart(2, '0') + d.getUTCMinutes().toString().padStart(2, '0')
    return {
      id: `fire-${Date.now()}-${i}`,
      coords: offsetCoord(center, 150),
      brightness: rand(0.3, 1.0),
      frp: rand(5, 200),
      intensity: randItem(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      acqDate: d.toISOString().slice(0, 10),
      acqTime: hhmm,
      acqTimestamp: d.getTime(),
      confidence: randItem(['high', 'medium', 'low', 'nominal']),
    }
  })
}

function tickAircraft(aircraft, center) {
  const d = 1 / 111
  const bound = 220
  return aircraft.map(ac => {
    const heading = (ac.heading + rand(-5, 5) + 360) % 360
    const rad = (heading - 90) * (Math.PI / 180)
    const coords = [
      ac.coords[0] + Math.cos(rad) * ac.speed,
      ac.coords[1] + Math.sin(rad) * ac.speed,
    ]
    const outOfBounds =
      Math.abs(coords[0] - center[0]) / d > bound ||
      Math.abs(coords[1] - center[1]) / d > bound
    return outOfBounds
      ? { ...ac, coords: offsetCoord(center, 180), heading: rand(0, 360) }
      : { ...ac, coords, heading }
  })
}

function tickFires(fires, center) {
  // 기존 핫스팟 brightness 소폭 변동 (삭제 없음)
  const updated = fires.map(f => ({
    ...f,
    brightness: Math.max(0.1, Math.min(1.0, f.brightness + rand(-0.03, 0.03))),
  }))
  // 매 틱 1~3개 신규 핫스팟 추가 (현재 시각)
  const newCount = randInt(1, 3)
  for (let i = 0; i < newCount; i++) {
    const ts = Date.now() - randInt(0, 86400000)
    const d = new Date(ts)
    const hhmm = d.getUTCHours().toString().padStart(2, '0') + d.getUTCMinutes().toString().padStart(2, '0')
    updated.push({
      id: `fire-${ts}-${Math.random().toString(36).slice(2, 6)}`,
      coords: offsetCoord(center, 150),
      brightness: rand(0.3, 1.0),
      frp: rand(5, 200),
      intensity: randItem(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      acqDate: d.toISOString().slice(0, 10),
      acqTime: hhmm,
      acqTimestamp: ts,
      confidence: randItem(['high', 'medium', 'low', 'nominal']),
    })
  }
  // 최대 1000개 캡 (메모리 보호)
  return updated.length > 1000 ? updated.slice(-1000) : updated
}

// Aircraft data normalisation (backend vs mock use different field names)
function normaliseAircraft(ac) {
  if (ac.lat !== undefined) return { ...ac, coords: [ac.lon, ac.lat] }
  return ac
}

function getFilteredAircraft(data, filter) {
  const norm = data.map(normaliseAircraft)
  if (filter === 'MILITARY') return norm.filter(a => a.military)
  if (filter === 'CIVILIAN') return norm.filter(a => !a.military)
  return norm
}

function getFilteredFires(data, hours) {
  if (!hours || hours >= 24) return data
  const cutoff = Date.now() - hours * 3600 * 1000
  return data.filter(f => !f.acqTimestamp || f.acqTimestamp >= cutoff)
}

function isKoreaBound(ac) {
  if (ac.route) {
    const dest = ac.route.split('→').pop().trim().toUpperCase()
    if (KOREAN_AIRPORT_CODES.has(dest)) return true
  }
  const cs = (ac.callsign || '').toUpperCase()
  return KOREAN_CARRIER_PREFIXES.some(p => cs.startsWith(p))
}

function toGeoJSONAircraft(data) {
  return {
    type: 'FeatureCollection',
    features: data.map(ac => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: ac.coords },
      properties: {
        id: ac.id,
        callsign: ac.callsign,
        heading: ac.heading,
        altitude: typeof ac.altitude === 'number' ? ac.altitude : 0,
        speed: ac.speed || 0,
        actype: ac.actype || 'UNKNOWN',
        military: ac.military ? 1 : 0,
        korean: isKoreaBound(ac) ? 1 : 0,
        hasCallsign: isRealCallsign(ac.callsign) ? 1 : 0,
        route: ac.route || '',
        registration: ac.registration || '',
      },
    })),
  }
}

function toGeoJSONFires(data) {
  return {
    type: 'FeatureCollection',
    features: data.map(f => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: f.coords },
      properties: {
        id: f.id,
        brightness: f.brightness,
        frp: f.frp || 0,
        intensity: f.intensity || 'LOW',
        acqDate: f.acqDate || '',
        acqTime: f.acqTime || '',
        acqTimestamp: f.acqTimestamp || 0,
        confidence: f.confidence || '',
      },
    })),
  }
}

function buildAircraftPopupHTML(props) {
  const isKorean  = props.korean      === 1 || props.korean      === true
  const isMil     = props.military    === 1 || props.military    === true
  const isPrivate = props.hasCallsign === 0 || props.hasCallsign === false
  const acColor = isMil ? '#ef4444' : isPrivate ? '#c4b5fd' : '#4ade80'
  const acLabel = isMil ? '🔴 MILITARY' : isKorean ? '🇰🇷 KOREAN CARRIER' : isPrivate ? '🟣 PRIVATE JET' : '🟢 CIVILIAN'
  const altFt = typeof props.altitude === 'number' ? props.altitude.toLocaleString() : props.altitude
  const spd = typeof props.speed === 'number' ? `${Math.round(props.speed)} kts` : '—'

  return `
    <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.7;color:#4ade80">
      <div style="color:${acColor};font-size:13px;font-weight:bold;margin-bottom:6px;
                  border-bottom:1px solid ${acColor}44;padding-bottom:4px">
        ✈ ${props.callsign || '???'}
      </div>
      <div style="color:#9ca3af;font-size:10px;margin-bottom:6px">${acLabel}</div>
      <div><span style="color:#6b7280">ROUTE:</span> <span style="color:#fbbf24">${props.route || '—'}</span></div>
      ${props.registration ? `<div><span style="color:#6b7280">REG:</span> ${props.registration}</div>` : ''}
      <div><span style="color:#6b7280">TYPE:</span> ${props.actype || '—'}</div>
      <div><span style="color:#6b7280">ALT:</span> ${altFt} ft</div>
      <div><span style="color:#6b7280">SPD:</span> ${spd}</div>
      <div><span style="color:#6b7280">HDG:</span> ${Math.round(props.heading || 0)}°</div>
      ${(() => {
        const cs = (props.callsign || '').trim()
        if (/^[A-Z]{2}\d{1,4}[A-Z]?$/i.test(cs)) {
          return `<div style="margin-top:8px;border-top:1px solid rgba(74,222,128,0.15);padding-top:6px">
            <a href="https://www.trip.com/flights/status-${cs.toLowerCase()}/"
              target="_blank" rel="noopener noreferrer"
              style="color:#60a5fa;font-size:10px;text-decoration:none;letter-spacing:0.05em">
              ↗ 스케줄 보기 (trip.com)
            </a>
          </div>`
        } else if (/^[A-Z]{3}\d{1,4}[A-Z]?$/i.test(cs)) {
          return `<div style="margin-top:8px;border-top:1px solid rgba(74,222,128,0.15);padding-top:6px">
            <a href="https://www.flightaware.com/live/flight/${cs.toUpperCase()}"
              target="_blank" rel="noopener noreferrer"
              style="color:#60a5fa;font-size:10px;text-decoration:none;letter-spacing:0.05em">
              ↗ 스케줄 보기 (FlightAware)
            </a>
          </div>`
        }
        return ''
      })()}
      <div style="margin-top:5px;color:rgba(74,222,128,0.4);font-size:10px">ADS-B // SIMULATED DATA</div>
    </div>`
}

function buildFirePopupHTML(props) {
  const c = { LOW: '#60a5fa', MEDIUM: '#fbbf24', HIGH: '#f97316', EXTREME: '#ef4444' }[props.intensity] || '#4ade80'
  const confColor = { high: '#4ade80', nominal: '#4ade80', medium: '#fbbf24', low: '#f87171' }[(props.confidence || '').toLowerCase()] || '#9ca3af'

  const fmtTime = (ts, tz) => {
    if (!ts) return '—'
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(ts)).replace(',', '')
    } catch { return '—' }
  }

  const ts = props.acqTimestamp || 0
  const utcStr   = fmtTime(ts, 'UTC')
  const localStr = fmtTime(ts, Intl.DateTimeFormat().resolvedOptions().timeZone)

  return `
    <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.7;color:#4ade80">
      <div style="color:#fbbf24;font-size:13px;font-weight:bold;margin-bottom:6px;
                  border-bottom:1px solid #fbbf2444;padding-bottom:4px">
        🔥 FIRE HOTSPOT
      </div>
      <div style="margin-bottom:4px">
        <div><span style="color:#6b7280;display:inline-block;width:36px">UTC</span> <span style="color:#e5e7eb">${utcStr}</span></div>
        <div><span style="color:#6b7280;display:inline-block;width:36px">LCL</span> <span style="color:#e5e7eb">${localStr}</span></div>
      </div>
      <div style="height:1px;background:rgba(74,222,128,0.1);margin:5px 0"></div>
      <div><span style="color:#6b7280">INTENSITY:</span> <span style="color:${c}">${props.intensity}</span></div>
      <div><span style="color:#6b7280">FRP:</span> ${Math.round(props.frp || 0)} MW</div>
      <div><span style="color:#6b7280">BRIGHTNESS:</span> ${Math.round(props.brightness * 100)}%</div>
      <div><span style="color:#6b7280">CONFIDENCE:</span> <span style="color:${confColor}">${(props.confidence || '—').toUpperCase()}</span></div>
      <div style="margin-top:5px;color:rgba(74,222,128,0.4);font-size:10px">NASA FIRMS VIIRS 375m</div>
    </div>`
}

function buildAirportPopupHTML(props) {
  const typeColor = { large_airport: '#60a5fa', medium_airport: '#94a3b8', small_airport: '#475569' }[props.type] || '#4ade80'
  const typeLabel = { large_airport: 'LARGE', medium_airport: 'MEDIUM', small_airport: 'SMALL' }[props.type] || props.type
  return `
    <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.7;color:#4ade80">
      <div style="color:${typeColor};font-size:13px;font-weight:bold;margin-bottom:6px;
                  border-bottom:1px solid ${typeColor}44;padding-bottom:4px">
        ✈ ${props.iata || props.icao || '???'}
      </div>
      <div><span style="color:#6b7280">NAME:</span> <span style="color:#e5e7eb">${props.name}</span></div>
      <div><span style="color:#6b7280">ICAO:</span> ${props.icao || '—'}</div>
      <div><span style="color:#6b7280">IATA:</span> ${props.iata || '—'}</div>
      <div><span style="color:#6b7280">CITY:</span> ${props.municipality || '—'}</div>
      <div><span style="color:#6b7280">TYPE:</span> <span style="color:${typeColor}">${typeLabel}</span></div>
      <div><span style="color:#6b7280">ELEV:</span> ${props.elevation ? props.elevation + ' ft' : '—'}</div>
      <div style="margin-top:8px;border-top:1px solid rgba(74,222,128,0.15);padding-top:6px">
        <a href="${props.iata
          ? `https://www.trip.com/flights/status/${props.iata.toLowerCase()}/`
          : `https://www.flightaware.com/live/airport/${props.icao}`
        }" target="_blank" rel="noopener noreferrer"
          style="color:#60a5fa;font-size:10px;text-decoration:none;letter-spacing:0.05em">
          ↗ 취항노선 보기 (trip.com)
        </a>
      </div>
    </div>`
}

// ─── App ───────────────────────────────────────────────────────────────────

export default function App() {
  const [activeRegion, setActiveRegion] = useState(() => {
    const saved = localStorage.getItem('mesafe_region')
    return (saved && REGIONS[saved]) ? saved : 'IRAN'
  })
  const [layers, setLayers] = useState({ aircraft: true, fires: true, airports: true })
  const [counts, setCounts] = useState({ aircraft: 0, fires: 0 })
  const [fireHoursFilter, setFireHoursFilter] = useState(24)
  const [currentTime, setCurrentTime] = useState(new Date())
  const [cursorCoords, setCursorCoords] = useState(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [backendConnected, setBackendConnected] = useState(false)
  const [aircraftFilter, setAircraftFilter] = useState('ALL')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dataMode, setDataMode] = useState('live')       // 'live' | 'mock'
  const [mockState, setMockState] = useState('stopped')  // 'stopped' | 'running'
  const [koreaBoundList, setKoreaBoundList] = useState([])

  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const mockIntervalRef = useRef(null)
  const clockIntervalRef = useRef(null)
  const aircraftDataRef = useRef([])
  const fireDataRef = useRef([])
  const activeRegionRef = useRef(activeRegion)
  const aircraftFilterRef = useRef('ALL')
  const backendConnectedRef = useRef(false)
  const fireHoursFilterRef = useRef(24)
  const dataModeRef = useRef('live')
  const mockStateRef = useRef('stopped')
  const popupRef = useRef(null)
  const socketRef = useRef(null)

  useEffect(() => { activeRegionRef.current = activeRegion }, [activeRegion])
  useEffect(() => { aircraftFilterRef.current = aircraftFilter }, [aircraftFilter])
  useEffect(() => { fireHoursFilterRef.current = fireHoursFilter }, [fireHoursFilter])
  useEffect(() => { dataModeRef.current = dataMode }, [dataMode])
  useEffect(() => { mockStateRef.current = mockState }, [mockState])
  useEffect(() => { localStorage.setItem('mesafe_region', activeRegion) }, [activeRegion])

  // ── Stable helpers (all deps are refs — never stale) ─────────────────────

  const updateSources = useCallback(() => {
    const map = mapInstanceRef.current
    if (!map?.isStyleLoaded()) return
    const filtered = getFilteredAircraft(aircraftDataRef.current, aircraftFilterRef.current)
    const filteredFires = getFilteredFires(fireDataRef.current, fireHoursFilterRef.current)
    map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
    map.getSource('fire-source')?.setData(toGeoJSONFires(filteredFires))
    setCounts({ aircraft: filtered.length, fires: filteredFires.length })
    setKoreaBoundList(filtered.filter(isKoreaBound))
  }, [])

  const clearMapData = useCallback(() => {
    aircraftDataRef.current = []
    fireDataRef.current = []
    const map = mapInstanceRef.current
    if (map?.isStyleLoaded()) {
      map.getSource('aircraft-source')?.setData({ type: 'FeatureCollection', features: [] })
      map.getSource('fire-source')?.setData({ type: 'FeatureCollection', features: [] })
    }
    setCounts({ aircraft: 0, fires: 0 })
  }, [])

  // ── 1. Clock ──────────────────────────────────────────────────────────────
  useEffect(() => {
    clockIntervalRef.current = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(clockIntervalRef.current)
  }, [])

  // ── 2. Map initialisation ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    mapboxgl.accessToken = MAPBOX_TOKEN

    const savedKey = localStorage.getItem('mesafe_region')
    const initRegion = (savedKey && REGIONS[savedKey]) ? REGIONS[savedKey] : REGIONS.IRAN

    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: initRegion.center,
      zoom: initRegion.zoom,
      attributionControl: false,
    })

    mapInstanceRef.current = map
    map.on('mousemove', e => setCursorCoords([e.lngLat.lng, e.lngLat.lat]))

    map.on('load', () => {
      const loadIcon = (name, svgFn, color) =>
        new Promise(resolve => {
          const img = new Image()
          img.onload = () => { if (!map.hasImage(name)) map.addImage(name, img); resolve() }
          img.src = svgFn(color)
        })

      Promise.all([
        loadIcon('aircraft-civilian', makeCivilianSVG, '#4ade80'),
        loadIcon('aircraft-military', makeMilitarySVG, '#ef4444'),
        loadIcon('aircraft-korean',   makeCivilianSVG, '#f59e0b'),
        loadIcon('aircraft-private',  makeCivilianSVG, '#c4b5fd'),
      ]).then(() => {
        // ── Aircraft ──
        map.addSource('aircraft-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        map.addLayer({
          id: 'aircraft-layer',
          type: 'symbol',
          source: 'aircraft-source',
          layout: {
            'icon-image': ['case',
              ['==', ['get', 'military'],   1], 'aircraft-military',
              ['==', ['get', 'hasCallsign'],0], 'aircraft-private',
              'aircraft-civilian',
            ],
            'icon-size': 1,
            'icon-rotate': ['get', 'heading'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'text-field': ['case',
              ['==', ['get', 'korean'], 1], ['concat', '🇰🇷 ', ['get', 'callsign']],
              ['get', 'callsign'],
            ],
            'text-offset': [0, 1.6],
            'text-size': 10,
            'text-anchor': 'top',
            'text-optional': true,
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['case',
              ['==', ['get', 'military'],   1], '#ef4444',
              ['==', ['get', 'hasCallsign'],0], '#c4b5fd',
              '#4ade80',
            ],
            'text-halo-color': 'rgba(0,0,0,0.85)',
            'text-halo-width': 1,
          },
        })

        // ── Fires ──
        map.addSource('fire-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        map.addLayer({
          id: 'fire-heat-layer',
          type: 'heatmap',
          source: 'fire-source',
          paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['to-number', ['get', 'brightness'], 0], 0, 0.4, 1, 1],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 3, 12, 5],
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0,    'rgba(0,0,0,0)',
              0.1,  'rgba(255,165,0,0.2)',
              0.35, 'rgba(255,80,0,0.6)',
              0.65, 'rgba(255,20,0,0.85)',
              0.85, 'rgba(255,0,0,0.95)',
              1,    'rgba(255,240,180,1)',
            ],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 15, 8, 30, 12, 50],
            'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.85, 12, 0.25],
          },
        })
        map.addLayer({
          id: 'fire-circle-layer',
          type: 'circle',
          source: 'fire-source',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 8, 7, 12, 12],
            'circle-color': [
              'step', ['to-number', ['get', 'brightness'], 0],
              '#fbbf24',
              0.4, '#f97316',
              0.7, '#ef4444',
            ],
            'circle-opacity': 0.95,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': 'rgba(255,140,0,0.7)',
          },
        })

        // ── Airports ──
        map.addSource('airport-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        map.addLayer({
          id: 'airport-circle-layer',
          type: 'circle',
          source: 'airport-source',
          paint: {
            'circle-radius': ['match', ['get', 'type'],
              'large_airport',  6,
              'medium_airport', 4,
              3,
            ],
            'circle-color': ['match', ['get', 'type'],
              'large_airport',  '#60a5fa',
              'medium_airport', '#94a3b8',
              '#475569',
            ],
            'circle-opacity': 0.9,
            'circle-stroke-width': 1,
            'circle-stroke-color': 'rgba(0,0,0,0.6)',
          },
        })
        map.addLayer({
          id: 'airport-label-layer',
          type: 'symbol',
          source: 'airport-source',
          minzoom: 7,
          layout: {
            'text-field': ['coalesce', ['get', 'iata'], ['get', 'icao']],
            'text-size': 10,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-optional': true,
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#94a3b8',
            'text-halo-color': 'rgba(0,0,0,0.9)',
            'text-halo-width': 1,
          },
        })

        // ── Popups ──
        const popup = new mapboxgl.Popup({ className: 'military-popup', closeButton: true, maxWidth: '300px' })
        popupRef.current = popup

        const bindPopup = (layerId, builder) => {
          map.on('click', layerId, e => {
            if (!e.features.length) return
            const { properties, geometry } = e.features[0]
            popup.setLngLat(geometry.coordinates.slice()).setHTML(builder(properties)).addTo(map)
          })
          map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = '' })
        }

        bindPopup('aircraft-layer', buildAircraftPopupHTML)
        bindPopup('fire-circle-layer', buildFirePopupHTML)
        bindPopup('airport-circle-layer', buildAirportPopupHTML)

        setMapLoaded(true)

        // Fetch airports (static, once)
        fetch(`${BACKEND_URL}/api/airports/me`)
          .then(r => r.json())
          .then(data => {
            const geojson = {
              type: 'FeatureCollection',
              features: data.map(a => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: a.coords },
                properties: {
                  id: a.id, name: a.name, iata: a.iata, icao: a.icao,
                  type: a.type, municipality: a.municipality, elevation: a.elevation,
                },
              })),
            }
            map.getSource('airport-source')?.setData(geojson)
          })
          .catch(() => {})
      })
    })

    return () => {
      mapInstanceRef.current?.remove()
      mapInstanceRef.current = null
    }
  }, [])

  // ── 3. Socket.io ──────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(BACKEND_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 3000,
      timeout: 5000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      backendConnectedRef.current = true
      setBackendConnected(true)
    })

    socket.on('disconnect', () => {
      backendConnectedRef.current = false
      setBackendConnected(false)
    })

    socket.on('aircraft:update', (data) => {
      if (dataModeRef.current !== 'live') return
      aircraftDataRef.current = data
      const map = mapInstanceRef.current
      if (!map?.isStyleLoaded()) return
      const filtered = getFilteredAircraft(data, aircraftFilterRef.current)
      map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
      setCounts(prev => ({ ...prev, aircraft: filtered.length }))
      setKoreaBoundList(filtered.filter(isKoreaBound))
    })

    socket.on('fires:update', (data) => {
      if (dataModeRef.current !== 'live' || data.length === 0) return
      fireDataRef.current = data
      const map = mapInstanceRef.current
      if (!map?.isStyleLoaded()) return
      const filtered = getFilteredFires(data, fireHoursFilterRef.current)
      map.getSource('fire-source')?.setData(toGeoJSONFires(filtered))
      setCounts(prev => ({ ...prev, fires: filtered.length }))
    })

    return () => socket.disconnect()
  }, [])

  // ── 5. Region flyTo + mock reseed ────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const region = REGIONS[activeRegion]
    map.flyTo({ center: region.center, zoom: region.zoom, duration: 1500 })

    // Mock 실행 중이면 새 지역 기준으로 즉시 재시드
    if (dataModeRef.current === 'mock' && mockStateRef.current === 'running') {
      aircraftDataRef.current = generateAircraft(region.center)
      fireDataRef.current = generateFires(region.center)
      updateSources()
    }
  }, [activeRegion, mapLoaded, updateSources])

  // ── Mock controls ─────────────────────────────────────────────────────────

  function switchMode(mode) {
    if (mode === dataModeRef.current) return
    dataModeRef.current = mode   // ref는 즉시, state는 re-render용
    clearInterval(mockIntervalRef.current)
    mockStateRef.current = 'stopped'
    setMockState('stopped')
    clearMapData()
    setDataMode(mode)
  }

  function mockStart() {
    if (dataModeRef.current !== 'mock') return
    mockStateRef.current = 'running'
    setMockState('running')
    const center = REGIONS[activeRegionRef.current].center
    aircraftDataRef.current = generateAircraft(center)
    fireDataRef.current = generateFires(center)
    updateSources()
    clearInterval(mockIntervalRef.current)
    mockIntervalRef.current = setInterval(() => {
      const c = REGIONS[activeRegionRef.current].center
      aircraftDataRef.current = tickAircraft(aircraftDataRef.current, c)
      fireDataRef.current = tickFires(fireDataRef.current, c)
      updateSources()
    }, 1000)
  }

  function mockStop() {
    clearInterval(mockIntervalRef.current)
    mockStateRef.current = 'stopped'
    setMockState('stopped')
  }

  function mockClear() {
    clearInterval(mockIntervalRef.current)
    mockStateRef.current = 'stopped'
    setMockState('stopped')
    clearMapData()
  }

  // ── 6. Fire time filter / aircraft filter → re-render ────────────────────
  useEffect(() => {
    if (mapLoaded) updateSources()
  }, [fireHoursFilter, aircraftFilter, mapLoaded, updateSources])

  // ── 7. Layer visibility ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const layerMap = {
      aircraft: ['aircraft-layer'],
      fires: ['fire-heat-layer', 'fire-circle-layer'],
      airports: ['airport-circle-layer', 'airport-label-layer'],
    }
    Object.entries(layers).forEach(([key, visible]) => {
      layerMap[key]?.forEach(id => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      })
    })
  }, [layers, mapLoaded])

  const toggleLayer = key => setLayers(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-green-400 font-mono overflow-hidden select-none">

      {/* ── TOP HUD ── */}
      <header className="flex items-center justify-between px-3 md:px-4 h-12 md:h-14 bg-zinc-900/80 border-b border-green-400/20 shrink-0 z-20 gap-2">

        {/* Left: hamburger (mobile) + AO badge */}
        <div className="flex items-center gap-2 min-w-0">
          <button className="md:hidden p-1.5 border border-green-400/20 text-green-400/60 active:text-green-400 shrink-0"
            onClick={() => setSidebarOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect y="2" width="16" height="1.5" rx="1"/>
              <rect y="7.25" width="16" height="1.5" rx="1"/>
              <rect y="12.5" width="16" height="1.5" rx="1"/>
            </svg>
          </button>
          <div className="hidden md:flex items-center gap-2">
            <span className="text-green-400/40 text-xs tracking-widest">AO</span>
            <span className="px-3 py-1 text-xs tracking-wider border border-green-400/50 bg-green-400/10 text-green-300">
              {REGIONS[activeRegion]?.name || activeRegion}
            </span>
          </div>
          <span className="md:hidden text-green-300 text-xs tracking-wider border border-green-400/30 px-2 py-0.5 truncate">
            {REGIONS[activeRegion]?.name || activeRegion}
          </span>
        </div>

        {/* Center title */}
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
          <span className="text-green-300 text-xs md:text-sm tracking-[0.3em] md:tracking-[0.35em] font-bold">MESAFE</span>
          <span className="hidden md:block text-green-400/35 text-[10px] tracking-widest">MIDDLE EAST SAFETY</span>
        </div>

        {/* Right: mode + connection badge */}
        <div className="flex items-center gap-2 shrink-0">
          {dataMode === 'live' ? (
            <div className={`flex items-center gap-1.5 px-2 py-1 border text-xs tracking-wider
              ${backendConnected
                ? 'border-green-400/40 bg-green-400/10 text-green-400'
                : 'border-amber-400/30 bg-amber-400/10 text-amber-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0
                ${backendConnected ? 'bg-green-400 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
              {backendConnected ? 'LIVE' : 'CONNECTING'}
            </div>
          ) : (
            <div className={`flex items-center gap-1.5 px-2 py-1 border text-xs tracking-wider
              ${mockState === 'running'
                ? 'border-blue-400/40 bg-blue-400/10 text-blue-300'
                : 'border-zinc-500/30 bg-zinc-800/50 text-zinc-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0
                ${mockState === 'running' ? 'bg-blue-400 animate-pulse' : 'bg-zinc-500'}`} />
              {mockState === 'running' ? 'SIM RUNNING' : 'SIM IDLE'}
            </div>
          )}
        </div>
      </header>

      {/* ── TIME HUD (fixed right) ── */}
      <div className="fixed top-12 md:top-14 right-0 z-30 bg-zinc-950/95 border-l border-b border-green-400/20 whitespace-nowrap">
        {[
          ['UTC', 'UTC'],
          ['LCL', Intl.DateTimeFormat().resolvedOptions().timeZone],
          [REGION_CODE[activeRegion] ?? activeRegion.slice(0, 3), REGION_TZ[activeRegion]],
        ].map(([label, tz], i) => (
          <div key={label} className={`flex items-center gap-3 px-3 py-1 ${i < 2 ? 'border-b border-green-400/10' : ''}`}>
            <span className="text-green-400/35 text-[10px] tracking-widest w-7 shrink-0">{label}</span>
            <span className="text-green-300 text-[11px] tracking-widest tabular-nums">{formatTZ(currentTime, tz)}</span>
          </div>
        ))}
      </div>

      {/* ── MAIN ── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Mobile overlay backdrop */}
        {sidebarOpen && (
          <div className="fixed inset-0 bg-black/70 z-40 md:hidden"
            onClick={() => setSidebarOpen(false)} />
        )}

        {/* LEFT sidebar */}
        <aside className={`
          fixed md:relative inset-y-0 left-0
          w-64 md:w-52
          z-50 md:z-10
          bg-zinc-900/98 md:bg-zinc-900/80
          border-r border-green-400/20
          flex flex-col gap-1 p-3 shrink-0 overflow-y-auto
          transition-transform duration-300 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}>
          {/* Mobile close row */}
          <div className="md:hidden flex items-center justify-between mb-1 pb-2 border-b border-green-400/20">
            <span className="text-green-300 text-xs tracking-widest">CONTROL PANEL</span>
            <button onClick={() => setSidebarOpen(false)} className="text-green-400/60 active:text-green-400 text-lg leading-none">✕</button>
          </div>

          {/* Data mode selector */}
          <div className="flex items-center gap-2 mb-2 border-b border-green-400/20 pb-2">
            <span className="w-0.5 h-3 bg-green-400/50 shrink-0" />
            <span className="text-green-400/50 text-xs tracking-widest">DATA MODE</span>
          </div>
          <div className="grid grid-cols-2 gap-1 mb-3">
            {[['live', 'LIVE'], ['mock', 'MOCK']].map(([mode, label]) => (
              <button key={mode} onClick={() => switchMode(mode)}
                className={`py-2 text-xs border transition-all tracking-widest
                  ${dataMode === mode
                    ? mode === 'live'
                      ? 'border-green-400/60 bg-green-400/15 text-green-300'
                      : 'border-blue-400/50 bg-blue-400/10 text-blue-300'
                    : 'border-green-400/10 text-green-400/30 hover:border-green-400/30 hover:text-green-400/60'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Mock simulation controls */}
          {dataMode === 'mock' && (
            <div className="mb-3 border border-blue-400/20 bg-blue-400/5 p-2">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-0.5 h-3 bg-blue-400/50 shrink-0" />
                <span className="text-blue-400/60 text-xs tracking-widest">SIMULATION</span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                <button onClick={mockStart} disabled={mockState === 'running'}
                  className={`py-1.5 text-[11px] border transition-all
                    ${mockState === 'running'
                      ? 'border-blue-400/50 bg-blue-400/15 text-blue-300 cursor-default'
                      : 'border-green-400/30 text-green-400/70 hover:border-green-400/60 hover:text-green-300'}`}>
                  ▶ START
                </button>
                <button onClick={mockStop} disabled={mockState !== 'running'}
                  className={`py-1.5 text-[11px] border transition-all
                    ${mockState !== 'running'
                      ? 'border-green-400/10 text-green-400/20 cursor-default'
                      : 'border-amber-400/40 text-amber-400/80 hover:border-amber-400/70 hover:text-amber-300'}`}>
                  ⏸ STOP
                </button>
                <button onClick={mockClear}
                  className="py-1.5 text-[11px] border border-green-400/20 text-green-400/50 hover:border-red-400/50 hover:text-red-400/80 transition-all">
                  ✕ CLR
                </button>
              </div>
            </div>
          )}

          {/* Region selector */}
          <div className="flex items-center gap-2 mb-2 border-b border-green-400/20 pb-2">
            <span className="w-0.5 h-3 bg-green-400/50 shrink-0" />
            <span className="text-green-400/50 text-xs tracking-widest">COUNTRY</span>
          </div>
          {Object.entries(REGIONS).map(([key, r]) => (
            <button key={key} onClick={() => { setActiveRegion(key); setSidebarOpen(false) }}
              className={`w-full text-left px-3 py-2 md:py-1.5 text-xs border mb-0.5 transition-all tracking-wide
                ${activeRegion === key
                  ? 'border-green-400/60 bg-green-400/15 text-green-300'
                  : 'border-green-400/10 text-green-400/40 hover:border-green-400/30 hover:text-green-400/70'}`}>
              {activeRegion === key ? '▶ ' : '  '}{r.name}
            </button>
          ))}

          {/* Layer control */}
          <div className="flex items-center gap-2 mt-3 mb-2 border-b border-green-400/20 pb-2">
            <span className="w-0.5 h-3 bg-green-400/50 shrink-0" />
            <span className="text-green-400/50 text-xs tracking-widest">LAYER CONTROL</span>
          </div>
          {[
            { key: 'aircraft', label: 'ADS-B TRACKS',  count: counts.aircraft, icon: '✈' },
            { key: 'fires',    label: 'FIRE HOTSPOTS', count: counts.fires,    icon: '🔥' },
            { key: 'airports', label: 'AIRPORTS',      count: null,            icon: '🛬' },
          ].map(({ key, label, count, icon }) => (
            <button key={key} onClick={() => toggleLayer(key)}
              className={`flex items-center justify-between px-3 py-2 border text-xs tracking-wide transition-all
                ${layers[key]
                  ? 'border-green-400/40 bg-green-400/10 text-green-300'
                  : 'border-green-400/10 text-green-400/30'}`}>
              <span>{icon} {label}</span>
              {count !== null && <span className="tabular-nums">{count}</span>}
            </button>
          ))}

          {/* Fire time filter */}
          <div className="mt-3 border-t border-green-400/20 pt-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-0.5 h-3 bg-orange-400/50 shrink-0" />
              <span className="text-green-400/50 text-xs tracking-widest">FIRE TIME WINDOW</span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[1, 6, 12, 24].map(h => (
                <button key={h} onClick={() => setFireHoursFilter(h)}
                  className={`py-1.5 text-xs border transition-all tracking-wide
                    ${fireHoursFilter === h
                      ? 'border-orange-400/60 bg-orange-400/15 text-orange-300'
                      : 'border-green-400/10 text-green-400/30 hover:border-green-400/30 hover:text-green-400/60'}`}>
                  {h}H
                </button>
              ))}
            </div>
          </div>

          {/* Aircraft filter */}
          <div className="mt-3 border-t border-green-400/20 pt-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-0.5 h-3 bg-green-400/50 shrink-0" />
              <span className="text-green-400/50 text-xs tracking-widest">AIRCRAFT FILTER</span>
            </div>
            {['ALL', 'MILITARY', 'CIVILIAN'].map(f => (
              <button key={f} onClick={() => setAircraftFilter(f)}
                className={`w-full text-left px-3 py-2 md:py-1.5 text-xs border mb-1 transition-all
                  ${aircraftFilter === f
                    ? f === 'MILITARY'
                      ? 'border-red-400/50 bg-red-400/10 text-red-400'
                      : f === 'CIVILIAN'
                        ? 'border-green-400/50 bg-green-400/10 text-green-400'
                        : 'border-green-400/40 bg-green-400/10 text-green-300'
                    : 'border-green-400/10 text-green-400/30'}`}>
                {f === 'MILITARY' ? '🔴' : f === 'CIVILIAN' ? '🟢' : '⚪'} {f}
              </button>
            ))}
          </div>

          {/* Korea-bound flights */}
          {koreaBoundList.length > 0 && (
            <div className="mt-2 border-t border-amber-400/20 pt-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-0.5 h-3 bg-amber-400/50 shrink-0" />
                <span className="text-amber-400/60 text-xs tracking-widest">KOREA BOUND</span>
                <span className="ml-auto text-amber-400/40 text-xs">{koreaBoundList.length}</span>
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {koreaBoundList.map(ac => (
                  <div key={ac.id || ac.callsign} className="px-2 py-1 bg-amber-400/5 border border-amber-400/20 text-xs">
                    <div className="text-amber-300 font-bold tracking-wide">{ac.callsign}</div>
                    {ac.route && <div className="text-amber-400/50 text-[10px]">{ac.route}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Intel summary */}
          <div className="mt-2 border-t border-green-400/20 pt-3 space-y-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-0.5 h-3 bg-green-400/50 shrink-0" />
              <span className="text-green-400/50 text-xs tracking-widest">INTEL SUMMARY</span>
            </div>
            {[
              ['REGION',   REGIONS[activeRegion]?.name || activeRegion],
              ['DATA SRC', dataMode === 'live' ? (backendConnected ? 'ADS-B/FIRMS' : 'OFFLINE') : 'SIMULATED'],
              ['STATUS',   mapLoaded
                ? dataMode === 'live'
                  ? backendConnected ? '● LIVE' : '◌ CONNECTING'
                  : mockState === 'running' ? '● SIM RUNNING' : '○ SIM IDLE'
                : '○ INIT'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-green-400/40">{k}</span>
                <span className={
                  k === 'STATUS' && dataMode === 'live' && backendConnected ? 'text-green-400 animate-pulse' :
                  k === 'STATUS' && dataMode === 'mock' && mockState === 'running' ? 'text-blue-400 animate-pulse' :
                  'text-green-300'
                }>{v}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* MAP */}
        <div className="relative flex-1">
          <div ref={mapRef} className="w-full h-full" />
          <div className="scanline-overlay absolute inset-0 z-10 pointer-events-none" />
          {!mapLoaded && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950">
              <span className="text-green-400 text-sm tracking-widest animate-pulse">INITIALIZING MAP...</span>
            </div>
          )}
        </div>
      </div>

      {/* ── BOTTOM STATUS BAR ── */}
      <footer className="h-8 bg-zinc-900/80 border-t border-green-400/20 flex items-center justify-between px-3 md:px-4 z-20 shrink-0 text-[10px] text-green-400/40 tracking-widest tabular-nums">
        <span className="font-mono">
          {cursorCoords
            ? `${cursorCoords[1].toFixed(3)}°N  ${cursorCoords[0].toFixed(3)}°E`
            : '-- --'}
        </span>
        <span className="hidden md:block">
          MESAFE v0.3 // {dataMode === 'live' ? (backendConnected ? 'LIVE' : 'CONNECTING') : mockState === 'running' ? 'SIM RUNNING' : 'SIM IDLE'}
        </span>
        <span>✈ {counts.aircraft}  🔥 {counts.fires}</span>
      </footer>
    </div>
  )
}
