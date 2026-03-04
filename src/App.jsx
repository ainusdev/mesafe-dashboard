import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

// ─── Module-level constants ────────────────────────────────────────────────

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const BACKEND_URL = 'http://localhost:3001'

const REGIONS = {
  TEHRAN:    { name: 'TEHRAN',    center: [51.3890, 35.6892], zoom: 7 },
  GAZA:      { name: 'GAZA',      center: [34.4668, 31.5017], zoom: 8 },
  BEIRUT:    { name: 'BEIRUT',    center: [35.4960, 33.8938], zoom: 8 },
  DAMASCUS:  { name: 'DAMASCUS',  center: [36.2765, 33.5138], zoom: 7 },
  ALEPPO:    { name: 'ALEPPO',    center: [37.1612, 36.2021], zoom: 7 },
  BAGHDAD:   { name: 'BAGHDAD',   center: [44.3661, 33.3152], zoom: 7 },
  MOSUL:     { name: 'MOSUL',     center: [43.1189, 36.3356], zoom: 8 },
  SANAA:     { name: "SANA'A",    center: [44.2066, 15.3694], zoom: 7 },
  ADEN:      { name: 'ADEN',      center: [45.0356, 12.7797], zoom: 8 },
  JERUSALEM: { name: 'JERUSALEM', center: [35.2137, 31.7683], zoom: 8 },
  WESTBANK:  { name: 'WEST BANK', center: [35.2433, 31.9466], zoom: 8 },
  RIYADH:    { name: 'RIYADH',    center: [46.6753, 24.6877], zoom: 7 },
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

const CALLSIGNS = [
  'EAGLE-1','EAGLE-2','VIPER-1','VIPER-3','HAWK-7','HAWK-9',
  'COBRA-2','COBRA-4','FALCON-5','GHOST-3','GHOST-6',
  'BANDIT-1','RAVEN-2','RAVEN-4','WOLF-1','UAE123','EK471',
  'FZ204','MS903','GF452','TK788','QR541','EY302',
]

// ─── Pure utility functions ────────────────────────────────────────────────

function rand(min, max) { return Math.random() * (max - min) + min }
function randInt(min, max) { return Math.floor(rand(min, max + 1)) }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function offsetCoord(center, rangeKm) {
  const d = 1 / 111
  return [center[0] + rand(-rangeKm, rangeKm) * d, center[1] + rand(-rangeKm, rangeKm) * d]
}

function generateAircraft(center) {
  return Array.from({ length: randInt(8, 12) }, (_, i) => ({
    id: `ac-${Date.now()}-${i}`,
    coords: offsetCoord(center, 80),
    heading: rand(0, 360),
    speed: rand(0.002, 0.006),
    callsign: randItem(CALLSIGNS),
    altitude: randInt(5000, 35000),
    actype: randItem(['B77W', 'A320', 'A330', 'F-16', 'C-130', 'UH-60', 'MQ-9']),
    military: Math.random() < 0.3,
    route: Math.random() < 0.6 ? randItem(['DXB→LHR','EWR→DXB','TLV→JFK','THR→VIE','BEY→CDG','DOH→LHR']) : null,
    registration: '',
  }))
}

function generateFires(center) {
  return Array.from({ length: randInt(5, 15) }, (_, i) => {
    const d = new Date(Date.now() - randInt(0, 86400000))
    const hhmm = d.getUTCHours().toString().padStart(2, '0') + d.getUTCMinutes().toString().padStart(2, '0')
    const dateStr = d.toISOString().slice(0, 10)
    return {
      id: `fire-${Date.now()}-${i}`,
      coords: offsetCoord(center, 60),
      brightness: rand(0.3, 1.0),
      frp: rand(5, 200),
      intensity: randItem(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      acqDate: dateStr,
      acqTime: hhmm,
      confidence: randItem(['high', 'medium', 'low', 'nominal']),
    }
  })
}

function tickAircraft(aircraft, center) {
  const d = 1 / 111
  const bound = 90
  return aircraft.map(ac => {
    const heading = (ac.heading + rand(-3, 3) + 360) % 360
    const rad = (heading - 90) * (Math.PI / 180)
    const coords = [
      ac.coords[0] + Math.cos(rad) * ac.speed,
      ac.coords[1] + Math.sin(rad) * ac.speed,
    ]
    const outOfBounds =
      Math.abs(coords[0] - center[0]) / d > bound ||
      Math.abs(coords[1] - center[1]) / d > bound
    return outOfBounds
      ? { ...ac, coords: offsetCoord(center, 70), heading: rand(0, 360) }
      : { ...ac, coords, heading }
  })
}

function tickFires(fires) {
  let result = fires.map(f => ({
    ...f,
    brightness: Math.max(0.1, Math.min(1.0, f.brightness + rand(-0.05, 0.05))),
  }))
  if (Math.random() < 0.3) {
    if (Math.random() < 0.5 && result.length > 5) {
      result = result.slice(0, -1)
    } else {
      const ref = result[0]
      const base = ref ? ref.coords : [51.389, 35.689]
      result.push({
        id: `fire-${Date.now()}`,
        coords: [base[0] + rand(-0.5, 0.5), base[1] + rand(-0.5, 0.5)],
        brightness: rand(0.3, 0.8),
        frp: rand(5, 100),
        intensity: randItem(['LOW', 'MEDIUM', 'HIGH']),
      })
    }
  }
  return result
}

// Aircraft data normalisation (backend vs mock use different field names)
function normaliseAircraft(ac) {
  // Backend sends: { lat, lon, ...} — mock uses: { coords: [lon, lat], ...}
  if (ac.lat !== undefined) {
    return { ...ac, coords: [ac.lon, ac.lat] }
  }
  return ac
}

function getFilteredAircraft(data, filter) {
  const norm = data.map(normaliseAircraft)
  if (filter === 'MILITARY') return norm.filter(a => a.military)
  if (filter === 'CIVILIAN') return norm.filter(a => !a.military)
  return norm
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
        confidence: f.confidence || '',
      },
    })),
  }
}

function buildAircraftPopupHTML(props) {
  const isMil = props.military === 1 || props.military === true
  const acColor = isMil ? '#ef4444' : '#4ade80'
  const acLabel = isMil ? '🔴 MILITARY' : '🟢 CIVILIAN'
  const altFt = typeof props.altitude === 'number' ? props.altitude.toLocaleString() : props.altitude
  const spd = typeof props.speed === 'number' ? `${Math.round(props.speed)} kts` : '—'

  return `
    <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.7;color:#4ade80">
      <div style="color:${acColor};font-size:13px;font-weight:bold;margin-bottom:6px;
                  border-bottom:1px solid ${acColor}44;padding-bottom:4px">
        ✈ ${props.callsign || '???'}
      </div>
      <div style="color:#9ca3af;font-size:10px;margin-bottom:6px">${acLabel}</div>
      ${props.route ? `<div><span style="color:#6b7280">ROUTE:</span> <span style="color:#fbbf24">${props.route}</span></div>` : ''}
      ${props.registration ? `<div><span style="color:#6b7280">REG:</span> ${props.registration}</div>` : ''}
      <div><span style="color:#6b7280">TYPE:</span> ${props.actype || '—'}</div>
      <div><span style="color:#6b7280">ALT:</span> ${altFt} ft</div>
      <div><span style="color:#6b7280">SPD:</span> ${spd}</div>
      <div><span style="color:#6b7280">HDG:</span> ${Math.round(props.heading || 0)}°</div>
      <div style="margin-top:5px;color:rgba(74,222,128,0.4);font-size:10px">ADS-B // SIMULATED DATA</div>
    </div>`
}

function buildFirePopupHTML(props) {
  const c = { LOW: '#60a5fa', MEDIUM: '#fbbf24', HIGH: '#f97316', EXTREME: '#ef4444' }[props.intensity] || '#4ade80'
  const confColor = { high: '#4ade80', nominal: '#4ade80', medium: '#fbbf24', low: '#f87171' }[(props.confidence || '').toLowerCase()] || '#9ca3af'

  // Format acqTime "0625" → "06:25 UTC"
  const rawTime = (props.acqTime || '').toString().padStart(4, '0')
  const timeStr = rawTime.length >= 4 ? `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)} UTC` : '—'
  const dateStr = props.acqDate || '—'

  return `
    <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.7;color:#4ade80">
      <div style="color:#fbbf24;font-size:13px;font-weight:bold;margin-bottom:6px;
                  border-bottom:1px solid #fbbf2444;padding-bottom:4px">
        🔥 FIRE HOTSPOT
      </div>
      <div><span style="color:#6b7280">DETECTED:</span> <span style="color:#e5e7eb">${dateStr}</span></div>
      <div><span style="color:#6b7280">TIME:</span> <span style="color:#e5e7eb">${timeStr}</span></div>
      <div style="height:1px;background:rgba(74,222,128,0.1);margin:5px 0"></div>
      <div><span style="color:#6b7280">INTENSITY:</span> <span style="color:${c}">${props.intensity}</span></div>
      <div><span style="color:#6b7280">FRP:</span> ${Math.round(props.frp || 0)} MW</div>
      <div><span style="color:#6b7280">BRIGHTNESS:</span> ${Math.round(props.brightness * 100)}%</div>
      <div><span style="color:#6b7280">CONFIDENCE:</span> <span style="color:${confColor}">${(props.confidence || '—').toUpperCase()}</span></div>
      <div style="margin-top:5px;color:rgba(74,222,128,0.4);font-size:10px">NASA FIRMS VIIRS 375m</div>
    </div>`
}

// ─── App ───────────────────────────────────────────────────────────────────

export default function App() {
  const [activeRegion, setActiveRegion] = useState(() => {
    const saved = localStorage.getItem('sentinel_region')
    return (saved && REGIONS[saved]) ? saved : 'TEHRAN'
  })
  const [layers, setLayers] = useState({ aircraft: true, fires: true })
  const [counts, setCounts] = useState({ aircraft: 0, fires: 0 })
  const [currentTime, setCurrentTime] = useState(new Date())
  const [cursorCoords, setCursorCoords] = useState(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [backendConnected, setBackendConnected] = useState(false)
  const [aircraftFilter, setAircraftFilter] = useState('ALL') // 'ALL' | 'MILITARY' | 'CIVILIAN'
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const dataIntervalRef = useRef(null)
  const clockIntervalRef = useRef(null)
  const aircraftDataRef = useRef([])
  const fireDataRef = useRef([])
  const activeRegionRef = useRef(activeRegion)
  const aircraftFilterRef = useRef('ALL')
  const backendConnectedRef = useRef(false)
  const popupRef = useRef(null)
  const socketRef = useRef(null)

  useEffect(() => { activeRegionRef.current = activeRegion }, [activeRegion])
  useEffect(() => { aircraftFilterRef.current = aircraftFilter }, [aircraftFilter])
  useEffect(() => { localStorage.setItem('sentinel_region', activeRegion) }, [activeRegion])

  // ── 1. Clock ──────────────────────────────────────────────────────────────
  useEffect(() => {
    clockIntervalRef.current = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(clockIntervalRef.current)
  }, [])

  // ── 2. Map initialisation ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    mapboxgl.accessToken = MAPBOX_TOKEN

    const savedKey = localStorage.getItem('sentinel_region')
    const initRegion = (savedKey && REGIONS[savedKey]) ? REGIONS[savedKey] : REGIONS.TEHRAN

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
      // Load aircraft icons: civilian = airliner shape, military = delta fighter shape
      const loadIcon = (name, svgFn, color) =>
        new Promise(resolve => {
          const img = new Image()
          img.onload = () => { if (!map.hasImage(name)) map.addImage(name, img); resolve() }
          img.src = svgFn(color)
        })

      Promise.all([
        loadIcon('aircraft-civilian', makeCivilianSVG, '#4ade80'),
        loadIcon('aircraft-military', makeMilitarySVG, '#ef4444'),
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
            'icon-image': ['case', ['==', ['get', 'military'], 1], 'aircraft-military', 'aircraft-civilian'],
            'icon-size': 1,
            'icon-rotate': ['get', 'heading'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'text-field': ['get', 'callsign'],
            'text-offset': [0, 1.6],
            'text-size': 10,
            'text-anchor': 'top',
            'text-optional': true,
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['case', ['==', ['get', 'military'], 1], '#ef4444', '#4ade80'],
            'text-halo-color': 'rgba(0,0,0,0.85)',
            'text-halo-width': 1,
          },
        })

        // ── Fires ──
        map.addSource('fire-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        // Heatmap — visible at all zooms, fades out as circles take over above zoom 10
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
        // Circles — always visible, zoom-scaled radius, brightness-scaled color
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

        setMapLoaded(true)
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
      reconnectionAttempts: 10,
      reconnectionDelay: 3000,
      timeout: 5000,
    })
    socketRef.current = socket

    const updateAcSource = (data) => {
      const map = mapInstanceRef.current
      if (!map?.isStyleLoaded()) return
      const src = map.getSource('aircraft-source')
      if (src) src.setData(toGeoJSONAircraft(getFilteredAircraft(data, aircraftFilterRef.current)))
    }
    const updateFireSource = (data) => {
      const map = mapInstanceRef.current
      if (!map?.isStyleLoaded()) return
      map.getSource('fire-source')?.setData(toGeoJSONFires(data))
    }

    socket.on('connect', () => {
      backendConnectedRef.current = true
      setBackendConnected(true)
      console.log('[Socket] Connected to backend')
    })

    socket.on('disconnect', () => {
      backendConnectedRef.current = false
      setBackendConnected(false)
      console.log('[Socket] Disconnected from backend')
    })

    socket.on('aircraft:update', (data) => {
      aircraftDataRef.current = data
      updateAcSource(data)
      // Use filtered count so display never flickers when a filter is active
      const filtered = getFilteredAircraft(data, aircraftFilterRef.current)
      setCounts(prev => ({ ...prev, aircraft: filtered.length }))
    })

    socket.on('fires:update', (data) => {
      // Ignore empty updates — backend may emit [] before FIRMS loads;
      // preserves existing mock/real fire data until real data arrives.
      if (data.length === 0) return
      fireDataRef.current = data
      updateFireSource(data)
      setCounts(prev => ({ ...prev, fires: data.length }))
    })

    return () => socket.disconnect()
  }, [])

  // ── 4. Mock data tick (runs only when backend is NOT connected) ────────────
  useEffect(() => {
    if (!mapLoaded) return

    // Only seed mock data if backend hasn't already populated the refs
    const region = REGIONS[activeRegionRef.current]
    if (aircraftDataRef.current.length === 0) aircraftDataRef.current = generateAircraft(region.center)
    if (fireDataRef.current.length === 0) fireDataRef.current = generateFires(region.center)

    const updateSources = () => {
      const map = mapInstanceRef.current
      if (!map?.isStyleLoaded()) return

      const filtered = getFilteredAircraft(aircraftDataRef.current, aircraftFilterRef.current)
      map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
      map.getSource('fire-source')?.setData(toGeoJSONFires(fireDataRef.current))

      const filteredCount = filtered.length
      setCounts({
        aircraft: filteredCount,
        fires: fireDataRef.current.length,
      })
    }

    updateSources()

    dataIntervalRef.current = setInterval(() => {
      // Mock mode: advance simulation data
      if (!backendConnectedRef.current) {
        const center = REGIONS[activeRegionRef.current].center
        aircraftDataRef.current = tickAircraft(aircraftDataRef.current, center)
        fireDataRef.current = tickFires(fireDataRef.current)
      }

      // Always re-render all sources every tick (live or mock)
      // — prevents fire layer from going blank if a socket event was missed
      updateSources()
    }, 2000)

    return () => clearInterval(dataIntervalRef.current)
  }, [mapLoaded])

  // ── 5. Region flyTo + data re-seed ────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const region = REGIONS[activeRegion]
    map.flyTo({ center: region.center, zoom: region.zoom, duration: 1500 })

    if (!backendConnectedRef.current) {
      aircraftDataRef.current = generateAircraft(region.center)
      fireDataRef.current = generateFires(region.center)

      // Immediately update sources
      if (map.isStyleLoaded()) {
        const filtered = getFilteredAircraft(aircraftDataRef.current, aircraftFilterRef.current)
        map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
        map.getSource('fire-source')?.setData(toGeoJSONFires(fireDataRef.current))
      }
    }
  }, [activeRegion, mapLoaded])

  // ── 6. Layer visibility ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const layerMap = {
      aircraft: ['aircraft-layer'],
      fires: ['fire-heat-layer', 'fire-circle-layer'],
    }
    Object.entries(layers).forEach(([key, visible]) => {
      layerMap[key]?.forEach(id => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      })
    })
  }, [layers, mapLoaded])

  // ── 7. Aircraft filter update ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map?.isStyleLoaded()) return
    const filtered = getFilteredAircraft(aircraftDataRef.current, aircraftFilter)
    map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
    setCounts(prev => ({ ...prev, aircraft: filtered.length }))
  }, [aircraftFilter, mapLoaded])

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
          {/* Desktop AO badge */}
          <div className="hidden md:flex items-center gap-2">
            <span className="text-green-400/40 text-xs tracking-widest">AO</span>
            <span className="px-3 py-1 text-xs tracking-wider border border-green-400/50 bg-green-400/10 text-green-300">
              {REGIONS[activeRegion]?.name || activeRegion}
            </span>
          </div>
          {/* Mobile AO compact */}
          <span className="md:hidden text-green-300 text-xs tracking-wider border border-green-400/30 px-2 py-0.5 truncate">
            {REGIONS[activeRegion]?.name || activeRegion}
          </span>
        </div>

        {/* Center title */}
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
          <span className="text-green-300 text-xs md:text-sm tracking-[0.3em] md:tracking-[0.35em] font-bold">SENTINEL</span>
          <span className="hidden md:block text-green-400/35 text-[10px] tracking-widest">CONFLICT MONITOR</span>
        </div>

        {/* Right: LIVE/MOCK + clock (desktop) */}
        <div className="flex items-center gap-2 shrink-0">
          {/* LIVE/MOCK badge — always visible */}
          <div className={`flex items-center gap-1.5 px-2 py-1 border text-xs
            ${backendConnected
              ? 'border-green-400/30 bg-green-400/10 text-green-400'
              : 'border-amber-400/30 bg-amber-400/10 text-amber-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${backendConnected ? 'bg-green-400 animate-pulse' : 'bg-amber-400'}`} />
            {backendConnected ? 'LIVE' : 'MOCK'}
          </div>

          {/* Desktop only: clock + cursor */}
          <div className="hidden md:block text-right">
            <div className="text-green-300 text-xs tracking-widest">
              {currentTime.toUTCString().slice(17, 25)} UTC
            </div>
            {cursorCoords && (
              <div className="text-green-400/35 text-[10px]">
                {cursorCoords[1].toFixed(4)}N {cursorCoords[0].toFixed(4)}E
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── MAIN ── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Mobile overlay backdrop */}
        {sidebarOpen && (
          <div className="fixed inset-0 bg-black/70 z-40 md:hidden"
            onClick={() => setSidebarOpen(false)} />
        )}

        {/* LEFT sidebar — slide-in drawer on mobile, fixed column on desktop */}
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

          {/* Region selector */}
          <div className="text-green-400/40 text-xs tracking-widest mb-2 border-b border-green-400/20 pb-2">AREA OF OPERATIONS</div>
          {Object.entries(REGIONS).map(([key, r]) => (
            <button key={key} onClick={() => { setActiveRegion(key); setSidebarOpen(false) }}
              className={`w-full text-left px-3 py-2 md:py-1.5 text-xs border mb-0.5 transition-all tracking-wide
                ${activeRegion === key
                  ? 'border-green-400/60 bg-green-400/15 text-green-300'
                  : 'border-green-400/10 text-green-400/40 hover:border-green-400/30 hover:text-green-400/70'}`}>
              {activeRegion === key ? '▶ ' : '  '}{r.name}
            </button>
          ))}

          <div className="text-green-400/40 text-xs tracking-widest mt-3 mb-2 border-b border-green-400/20 pb-2">LAYER CONTROL</div>

          {[
            { key: 'aircraft', label: 'ADS-B TRACKS', count: counts.aircraft, icon: '✈' },
            { key: 'fires',    label: 'FIRE HOTSPOTS', count: counts.fires,   icon: '🔥' },
          ].map(({ key, label, count, icon }) => (
            <button key={key} onClick={() => toggleLayer(key)}
              className={`flex items-center justify-between px-3 py-2 border text-xs tracking-wide transition-all
                ${layers[key]
                  ? 'border-green-400/40 bg-green-400/10 text-green-300'
                  : 'border-green-400/10 text-green-400/30'}`}>
              <span>{icon} {label}</span>
              <span className="tabular-nums">{count}</span>
            </button>
          ))}

          {/* Aircraft filter */}
          <div className="mt-3 border-t border-green-400/20 pt-3">
            <div className="text-green-400/40 text-xs tracking-widest mb-2">AIRCRAFT FILTER</div>
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

          {/* Stats */}
          <div className="mt-2 border-t border-green-400/20 pt-3 space-y-1">
            <div className="text-green-400/40 text-xs tracking-widest mb-2">INTEL SUMMARY</div>
            {[
              ['REGION',   REGIONS[activeRegion]?.name || activeRegion],
              ['DATA SRC', backendConnected ? 'ADS-B/FIRMS' : 'SIMULATED'],
              ['STATUS',   mapLoaded ? (backendConnected ? '● LIVE' : '● MOCK') : '○ INIT'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-green-400/40">{k}</span>
                <span className={k === 'STATUS' && backendConnected ? 'text-green-400 animate-pulse' : 'text-green-300'}>{v}</span>
              </div>
            ))}
            {/* Mobile: show time here */}
            <div className="md:hidden flex justify-between text-xs pt-1">
              <span className="text-green-400/40">UTC</span>
              <span className="text-green-300">{currentTime.toUTCString().slice(17, 25)}</span>
            </div>
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

      {/* ── BOTTOM ── */}
      <footer className="h-6 bg-zinc-900/80 border-t border-green-400/20 flex items-center justify-center z-20 shrink-0">
        <span className="text-green-400/25 text-[10px] md:text-xs tracking-widest text-center px-2">
          ⚠ SIMULATED DATA ONLY // NOT FOR OPERATIONAL USE // SENTINEL v0.2
        </span>
      </footer>
    </div>
  )
}
