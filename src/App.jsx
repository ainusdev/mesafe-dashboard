import { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

import { MAPBOX_TOKEN, BACKEND_URL, REGIONS, REGION_TZ, REGION_CODE } from './constants.js'
import { formatTZ } from './utils.js'
import { preloadAllFlags, ensureAircraftLabels } from './flags.js'
import { makeCivilianSVG, makeMilitarySVG, makeUnknownSVG } from './icons.js'
import { generateAircraft, generateFires, tickAircraft, tickFires } from './mock.js'
import { getFilteredAircraft, getFilteredFires, toGeoJSONAircraft, toGeoJSONFires } from './data.js'
import { buildAircraftPopupHTML, buildFirePopupHTML, buildAirportPopupHTML } from './popups.js'

// ─── App ───────────────────────────────────────────────────────────────────

export default function App() {
  const [activeRegion, setActiveRegion] = useState(() => {
    // Preserve only region selection; clear everything else on load
    const saved = localStorage.getItem('mesafe_region')
    const keepKeys = new Set(['mesafe_region'])
    Object.keys(localStorage).forEach(k => { if (!keepKeys.has(k)) localStorage.removeItem(k) })
    return (saved && REGIONS[saved]) ? saved : 'IRAN'
  })
  const [layers, setLayers] = useState({ aircraft: true, fires: true, airports: true, airportsOther: false })
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
  const animFrameRef = useRef(null)
  const animCurrentRef = useRef({})
  const animToRef = useRef([])
  const liveIntervalMsRef = useRef(100000)
  const lastAircraftUpdateRef = useRef(null)
  const pendingAirportsRef = useRef(null)

  useEffect(() => { activeRegionRef.current = activeRegion }, [activeRegion])
  useEffect(() => { aircraftFilterRef.current = aircraftFilter }, [aircraftFilter])
  useEffect(() => { fireHoursFilterRef.current = fireHoursFilter }, [fireHoursFilter])
  useEffect(() => { dataModeRef.current = dataMode }, [dataMode])
  useEffect(() => { mockStateRef.current = mockState }, [mockState])
  useEffect(() => { localStorage.setItem('mesafe_region', activeRegion) }, [activeRegion])

  // ── Stable helpers ────────────────────────────────────────────────────────

  const updateSources = useCallback(() => {
    const map = mapInstanceRef.current
    if (!map?.isStyleLoaded()) return
    const filtered = getFilteredAircraft(aircraftDataRef.current, aircraftFilterRef.current)
    const filteredFires = getFilteredFires(fireDataRef.current, fireHoursFilterRef.current)
    ensureAircraftLabels(filtered, map)
    map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
    map.getSource('fire-source')?.setData(toGeoJSONFires(filteredFires))
    setCounts({ aircraft: filtered.length, fires: filteredFires.length })
  }, [])

  const applyAirports = useCallback((data, map) => {
    map.getSource('airport-source')?.setData({
      type: 'FeatureCollection',
      features: data.map(a => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: a.coords },
        properties: {
          id: a.id, name: a.name, iata: a.iata, icao: a.icao,
          type: a.type, municipality: a.municipality, elevation: a.elevation,
        },
      })),
    })
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
        loadIcon('aircraft-unknown',  makeUnknownSVG,  '#f59e0b'),
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
            'icon-image': ['match', ['get', 'militaryStatus'],
              'military',  'aircraft-military',
              'suspected', 'aircraft-unknown',
              'aircraft-civilian',
            ],
            'icon-size': 1,
            'icon-rotate': ['get', 'heading'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'text-field': ['get', 'callsign'],
            'text-font': ['literal', ['DIN Offc Pro Regular', 'Arial Unicode MS Regular']],
            'text-size': 10,
            'text-anchor': 'top',
            'text-offset': [0, 1.3],
            'text-allow-overlap': false,
            'text-optional': true,
          },
          paint: {
            'text-color': ['match', ['get', 'militaryStatus'],
              'military',  '#ef4444',
              'suspected', '#f59e0b',
              '#4ade80',
            ],
            'text-halo-color': 'rgba(0,0,0,0.85)',
            'text-halo-width': 1,
          },
        })

        map.addLayer({
          id: 'flag-layer',
          type: 'symbol',
          source: 'aircraft-source',
          filter: ['!=', ['get', 'flagKey'], ''],
          layout: {
            'icon-image': ['get', 'flagKey'],
            'icon-anchor': 'bottom',
            'icon-offset': [0, -20],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
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
          minzoom: 9,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 12, 8],
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
          filter: ['==', ['get', 'type'], 'large_airport'],
          paint: {
            'circle-radius': 6,
            'circle-color': '#60a5fa',
            'circle-opacity': 0.9,
            'circle-stroke-width': 1,
            'circle-stroke-color': 'rgba(0,0,0,0.6)',
          },
        })
        map.addLayer({
          id: 'airport-label-layer',
          type: 'symbol',
          source: 'airport-source',
          filter: ['==', ['get', 'type'], 'large_airport'],
          minzoom: 6,
          layout: {
            'text-field': ['coalesce', ['get', 'iata'], ['get', 'icao']],
            'text-size': 10,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-optional': true,
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#60a5fa',
            'text-halo-color': 'rgba(0,0,0,0.9)',
            'text-halo-width': 1,
          },
        })
        map.addLayer({
          id: 'airport-other-circle-layer',
          type: 'circle',
          source: 'airport-source',
          filter: ['!=', ['get', 'type'], 'large_airport'],
          layout: { visibility: 'none' },
          paint: {
            'circle-radius': ['match', ['get', 'type'], 'medium_airport', 4, 3],
            'circle-color': ['match', ['get', 'type'], 'medium_airport', '#94a3b8', '#475569'],
            'circle-opacity': 0.8,
            'circle-stroke-width': 1,
            'circle-stroke-color': 'rgba(0,0,0,0.6)',
          },
        })
        map.addLayer({
          id: 'airport-other-label-layer',
          type: 'symbol',
          source: 'airport-source',
          filter: ['!=', ['get', 'type'], 'large_airport'],
          minzoom: 8,
          layout: {
            visibility: 'none',
            'text-field': ['coalesce', ['get', 'iata'], ['get', 'icao']],
            'text-size': 9,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-optional': true,
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#64748b',
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
        bindPopup('airport-other-circle-layer', buildAirportPopupHTML)

        setMapLoaded(true)
        preloadAllFlags(map)

        if (pendingAirportsRef.current) {
          applyAirports(pendingAirportsRef.current, map)
          pendingAirportsRef.current = null
        }
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
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 10000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      backendConnectedRef.current = true
      setBackendConnected(true)
      socket.emit('data:init')
    })

    socket.on('disconnect', () => {
      backendConnectedRef.current = false
      setBackendConnected(false)
    })

    socket.on('aircraft:update', (data) => {
      if (dataModeRef.current !== 'live') return
      aircraftDataRef.current = data
      const now = performance.now()
      if (lastAircraftUpdateRef.current) {
        const measured = now - lastAircraftUpdateRef.current
        if (measured > 5000 && measured < 300000)
          liveIntervalMsRef.current = liveIntervalMsRef.current * 0.7 + measured * 0.3
      }
      lastAircraftUpdateRef.current = now
      const map = mapInstanceRef.current
      ensureAircraftLabels(data, map)
      setCounts(prev => ({ ...prev, aircraft: getFilteredAircraft(data, aircraftFilterRef.current).length }))
      data.forEach(ac => {
        if (!animCurrentRef.current[ac.id]) {
          animCurrentRef.current[ac.id] = {
            lat: ac.lat, lon: ac.lon,
            heading: ac.heading ?? 0,
            headingRate: 0,
            currentSpeed: (ac.speed ?? 0) * (1852 / 3600 / 111000),
          }
        }
      })
      animToRef.current = data
      startAnimLoop(map)
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

    socket.on('airports:update', (data) => {
      if (!data?.length) return
      const map = mapInstanceRef.current
      if (!map?.isStyleLoaded()) {
        pendingAirportsRef.current = data
        return
      }
      applyAirports(data, map)
    })

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      socket.disconnect()
    }
  }, [])

  // ── 5. Region flyTo + mock reseed ────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const region = REGIONS[activeRegion]
    map.flyTo({ center: region.center, zoom: region.zoom, duration: 1500 })

    if (dataModeRef.current === 'mock' && mockStateRef.current === 'running') {
      aircraftDataRef.current = generateAircraft(region.center)
      fireDataRef.current = generateFires(region.center)
      updateSources()
    }
  }, [activeRegion, mapLoaded, updateSources])

  // ── Mock CSV download ─────────────────────────────────────────────────────
  function downloadMockCSV(aircraft) {
    const headers = [
      'icao24','callsign','origin_country','time_position','last_contact',
      'longitude','latitude','baro_altitude','on_ground','velocity',
      'true_track','vertical_rate','squawk','position_source',
      'military','actype',
    ]
    const rows = [headers.join(',')]
    for (const ac of aircraft) {
      rows.push([
        ac.id,
        ac.callsign,
        ac.origin_country || ac.originCountry || '',
        ac.time_position || '',
        ac.last_contact || '',
        (ac.lon ?? ac.coords?.[0] ?? '').toString(),
        (ac.lat ?? ac.coords?.[1] ?? '').toString(),
        ac.baro_altitude ?? '',
        ac.on_ground ? 1 : 0,
        ac.velocity ?? '',
        ac.true_track ?? ac.heading ?? '',
        ac.vertical_rate ?? '',
        ac.squawk ?? '',
        ac.position_source ?? '',
        ac.military ? 1 : 0,
        ac.actype || '',
      ].join(','))
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `mock_aircraft_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Physics animation loop ────────────────────────────────────────────────
  // Heading: underdamped spring (ζ≈0.8)
  // Speed:   asymmetric exponential decay (accel 2s / decel 4s)
  const HDG_DAMP_S   = 1.6
  const HDG_K_S      = 1.0
  const TAU_ACCEL    = 2.0
  const TAU_DECEL    = 4.0
  const SPD_SNAP_EPS = 0.001

  function startAnimLoop(map) {
    if (animFrameRef.current) return
    let lastTime = null
    const loop = (now) => {
      const dtMs = lastTime ? Math.min(now - lastTime, 100) : 16
      const dt_s = dtMs / 1000
      lastTime = now

      if (map?.isStyleLoaded()) {
        const targets = animToRef.current
        if (targets.length > 0) {
          const isMock = dataModeRef.current === 'mock'
          const rendered = targets.map(ac => {
            let cur = animCurrentRef.current[ac.id]
            if (!cur) {
              const initSpd = isMock ? 0 : (ac.velocity ?? 0) / 111000
              animCurrentRef.current[ac.id] = {
                lat: ac.lat, lon: ac.lon,
                heading: ac.true_track ?? ac.heading ?? 0,
                headingRate: 0,
                currentSpeed: initSpd,
              }
              return { ...ac }
            }

            const targetHdg = ac.targetHeading ?? ac.heading ?? cur.heading
            const diff = ((targetHdg - cur.heading + 540) % 360) - 180
            const headingRate = cur.headingRate * Math.exp(-HDG_DAMP_S * dt_s)
                              + diff * HDG_K_S * dt_s
            const heading = (cur.heading + headingRate * dt_s + 360) % 360

            const targetSpd = isMock
              ? (ac.speedDegS ?? 0.01)
              : (ac.speed ?? 0) * (1852 / 3600 / 111000)
            const speedDiff    = targetSpd - cur.currentSpeed
            const atTarget     = Math.abs(speedDiff) < targetSpd * SPD_SNAP_EPS
            const tau          = speedDiff > 0 ? TAU_ACCEL : TAU_DECEL
            const currentSpeed = atTarget
              ? targetSpd
              : cur.currentSpeed + speedDiff * (1 - Math.exp(-dt_s / tau))

            const dist = currentSpeed * dt_s
            const rad  = heading * Math.PI / 180
            const lon  = cur.lon + Math.sin(rad) * dist
            const lat  = cur.lat + Math.cos(rad) * dist

            animCurrentRef.current[ac.id] = { lat, lon, heading, headingRate, currentSpeed }
            return { ...ac, lat, lon, coords: [lon, lat], heading }
          })

          const filtered = getFilteredAircraft(rendered, aircraftFilterRef.current)
          map.getSource('aircraft-source')?.setData(toGeoJSONAircraft(filtered))
        }
      }
      animFrameRef.current = requestAnimationFrame(loop)
    }
    animFrameRef.current = requestAnimationFrame(loop)
  }

  function stopAnimLoop() {
    cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = null
  }

  // ── Mock controls ─────────────────────────────────────────────────────────

  function switchMode(mode) {
    if (mode === dataModeRef.current) return
    dataModeRef.current = mode
    clearInterval(mockIntervalRef.current)
    stopAnimLoop()
    animCurrentRef.current = {}
    animToRef.current = []
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
    animCurrentRef.current = {}
    aircraftDataRef.current.forEach(ac => {
      animCurrentRef.current[ac.id] = { lat: ac.lat, lon: ac.lon, heading: ac.heading, headingRate: 0, currentSpeed: 0 }
    })
    animToRef.current = aircraftDataRef.current
    updateSources()
    const mockMap = mapInstanceRef.current
    ensureAircraftLabels(aircraftDataRef.current, mockMap)
    startAnimLoop(mockMap)
    clearInterval(mockIntervalRef.current)
    mockIntervalRef.current = setInterval(() => {
      const c = REGIONS[activeRegionRef.current].center
      aircraftDataRef.current = tickAircraft(aircraftDataRef.current, c, animCurrentRef.current)
      fireDataRef.current = tickFires(fireDataRef.current, c)
      animToRef.current = aircraftDataRef.current
      const map = mapInstanceRef.current
      if (map?.isStyleLoaded()) {
        const filtered = getFilteredFires(fireDataRef.current, fireHoursFilterRef.current)
        map.getSource('fire-source')?.setData(toGeoJSONFires(filtered))
      }
    }, 10000)
  }

  function mockStop() {
    clearInterval(mockIntervalRef.current)
    stopAnimLoop()
    mockStateRef.current = 'stopped'
    setMockState('stopped')
    downloadMockCSV(aircraftDataRef.current)
  }

  function mockClear() {
    clearInterval(mockIntervalRef.current)
    stopAnimLoop()
    animCurrentRef.current = {}
    animToRef.current = []
    mockStateRef.current = 'stopped'
    setMockState('stopped')
    clearMapData()
  }

  // ── 6. Fire time filter / aircraft filter ────────────────────────────────
  useEffect(() => {
    if (mapLoaded) updateSources()
  }, [fireHoursFilter, aircraftFilter, mapLoaded, updateSources])

  // ── 7. Layer visibility ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const layerMap = {
      aircraft:     ['aircraft-layer', 'flag-layer'],
      fires:        ['fire-heat-layer', 'fire-circle-layer'],
      airports:     ['airport-circle-layer', 'airport-label-layer'],
      airportsOther:['airport-other-circle-layer', 'airport-other-label-layer'],
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
            { key: 'aircraft',      label: 'ADS-B TRACKS',  count: counts.aircraft, icon: '✈' },
            { key: 'fires',         label: 'FIRE HOTSPOTS', count: counts.fires,    icon: '🔥' },
            { key: 'airports',      label: 'INTL AIRPORTS', count: null,            icon: '🛬' },
            { key: 'airportsOther', label: 'OTHER AIRPORTS', count: null,           icon: '🛩' },
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
            {[
              { f: 'ALL',      icon: '⚪', label: 'ALL' },
              { f: 'MILITARY', icon: '🔴', label: 'MILITARY' },
              { f: 'UNKNOWN',  icon: '🟡', label: '미식별' },
              { f: 'CIVILIAN', icon: '🟢', label: 'CIVILIAN' },
            ].map(({ f, icon, label }) => (
              <button key={f} onClick={() => setAircraftFilter(f)}
                className={`w-full text-left px-3 py-2 md:py-1.5 text-xs border mb-1 transition-all
                  ${aircraftFilter === f
                    ? f === 'MILITARY'
                      ? 'border-red-400/50 bg-red-400/10 text-red-400'
                      : f === 'UNKNOWN'
                        ? 'border-amber-400/50 bg-amber-400/10 text-amber-400'
                        : f === 'CIVILIAN'
                          ? 'border-green-400/50 bg-green-400/10 text-green-400'
                          : 'border-green-400/40 bg-green-400/10 text-green-300'
                    : 'border-green-400/10 text-green-400/30'}`}>
                {icon} {label}
              </button>
            ))}
          </div>

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
