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

// Preload all country flags in parallel at map init — avoids 1+ min lazy trickle.
const _flagRequested = new Set()

function preloadAllFlags(map) {
  const codes = [...new Set(Object.values(COUNTRY_CODE))]
  codes.forEach(code => {
    const id = `flag-${code}`
    if (map.hasImage(id) || _flagRequested.has(id)) return
    _flagRequested.add(id)
    map.loadImage(
      `https://flagcdn.com/20x15/${code.toLowerCase()}.png`,
      (err, img) => { if (!err && img) map.addImage(id, img) }
    )
  })
}

// No-op kept for call sites — flags are preloaded at map init.
function ensureAircraftLabels(_aircraft, _map) {}

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

const CALLSIGNS_CIVILIAN = [
  'EK471','EK828','EK204','FZ204','FZ317',
  'QR541','QR007','QR342','EY302','EY451',
  'MS903','GF452','TK788','TK124','SV872',
  'WY513','ME342','GF103','RJ103','PC572',
  'KAL001','KAL851','KAL958','AAR271','AAR603','JJA151','ABL661',
]
const CALLSIGNS_MILITARY = [
  'EAGLE-1','EAGLE-2','VIPER-1','VIPER-3','HAWK-7','HAWK-9',
  'COBRA-2','COBRA-4','FALCON-5','GHOST-3','RAVEN-2','WOLF-1',
  'REACH-1','SPAR-21','DOOM-4','DUKE-7',
]

// Country name → ISO 3166-1 alpha-2 code.
// Includes ICAO formal names (inferred from ICAO 24-bit address allocation).
// Flag emoji is rendered via canvas → Mapbox image (bypasses SDF font limitation).
const COUNTRY_CODE = {
  // A
  'Afghanistan':'AF','Islamic Republic of Afghanistan':'AF',
  'Albania':'AL','Republic of Albania':'AL',
  'Algeria':'DZ','People\'s Democratic Republic of Algeria':'DZ','Democratic and Popular Republic of Algeria':'DZ',
  'Angola':'AO','Republic of Angola':'AO',
  'Argentina':'AR','Argentine Republic':'AR',
  'Armenia':'AM','Republic of Armenia':'AM',
  'Australia':'AU','Commonwealth of Australia':'AU',
  'Austria':'AT','Republic of Austria':'AT',
  'Azerbaijan':'AZ','Republic of Azerbaijan':'AZ',
  // B
  'Bahrain':'BH','Kingdom of Bahrain':'BH','Bahrain, Kingdom of':'BH',
  'Bangladesh':'BD','People\'s Republic of Bangladesh':'BD',
  'Belarus':'BY','Republic of Belarus':'BY',
  'Belgium':'BE','Kingdom of Belgium':'BE',
  'Bolivia':'BO','Bolivia, Plurinational State of':'BO','Plurinational State of Bolivia':'BO',
  'Bosnia and Herzegovina':'BA',
  'Botswana':'BW','Republic of Botswana':'BW',
  'Brazil':'BR','Federative Republic of Brazil':'BR',
  'Brunei Darussalam':'BN','Brunei':'BN','Nation of Brunei':'BN',
  'Bulgaria':'BG','Republic of Bulgaria':'BG',
  'Burkina Faso':'BF',
  'Burundi':'BI','Republic of Burundi':'BI',
  // C
  'Cambodia':'KH',
  'Canada':'CA',
  'Chile':'CL',
  'China':'CN','People\'s Republic of China':'CN',
  'Colombia':'CO','Republic of Colombia':'CO',
  'Congo, Democratic Republic of the':'CD','Democratic Republic of the Congo':'CD','DR Congo':'CD',
  'Congo':'CG','Republic of the Congo':'CG',
  'Croatia':'HR','Republic of Croatia':'HR',
  'Cuba':'CU','Republic of Cuba':'CU',
  'Cyprus':'CY','Republic of Cyprus':'CY',
  'Czech Republic':'CZ','Czechia':'CZ',
  // D
  'Denmark':'DK',
  'Djibouti':'DJ','Republic of Djibouti':'DJ',
  // E
  'Ecuador':'EC',
  'Egypt':'EG','Arab Republic of Egypt':'EG',
  'Eritrea':'ER','State of Eritrea':'ER',
  'Estonia':'EE','Republic of Estonia':'EE',
  'Ethiopia':'ET','Federal Democratic Republic of Ethiopia':'ET',
  // F
  'Finland':'FI','Republic of Finland':'FI',
  'France':'FR','French Republic':'FR',
  // G
  'Georgia':'GE','Republic of Georgia':'GE',
  'Germany':'DE','Federal Republic of Germany':'DE',
  'Ghana':'GH','Republic of Ghana':'GH',
  'Greece':'GR','Hellenic Republic':'GR',
  // H
  'Hungary':'HU',
  // I
  'India':'IN','Republic of India':'IN',
  'Indonesia':'ID','Republic of Indonesia':'ID',
  'Iran':'IR','Iran, Islamic Republic of':'IR','Islamic Republic of Iran':'IR',
  'Iraq':'IQ','Republic of Iraq':'IQ',
  'Ireland':'IE','Republic of Ireland':'IE',
  'Israel':'IL','State of Israel':'IL',
  'Italy':'IT','Italian Republic':'IT',
  // J
  'Japan':'JP',
  'Jordan':'JO','Hashemite Kingdom of Jordan':'JO','Jordan, Hashemite Kingdom of':'JO',
  // K
  'Kazakhstan':'KZ','Republic of Kazakhstan':'KZ',
  'Kenya':'KE','Republic of Kenya':'KE',
  'Korea, Democratic People\'s Republic of':'KP','North Korea':'KP','Democratic People\'s Republic of Korea':'KP',
  'Korea, Republic of':'KR','South Korea':'KR','Republic of Korea':'KR',
  'Kuwait':'KW','State of Kuwait':'KW',
  'Kyrgyzstan':'KG','Kyrgyz Republic':'KG',
  // L
  'Lao People\'s Democratic Republic':'LA','Laos':'LA',
  'Latvia':'LV','Republic of Latvia':'LV',
  'Lebanon':'LB','Lebanese Republic':'LB','Republic of Lebanon':'LB',
  'Libya':'LY','Libyan Arab Jamahiriya':'LY','State of Libya':'LY',
  'Lithuania':'LT','Republic of Lithuania':'LT',
  'Luxembourg':'LU',
  // M
  'Malaysia':'MY',
  'Maldives':'MV','Republic of Maldives':'MV',
  'Malta':'MT','Republic of Malta':'MT',
  'Mauritania':'MR','Islamic Republic of Mauritania':'MR',
  'Mexico':'MX','United Mexican States':'MX',
  'Moldova':'MD','Moldova, Republic of':'MD','Republic of Moldova':'MD',
  'Mongolia':'MN',
  'Montenegro':'ME','Republic of Montenegro':'ME',
  'Morocco':'MA','Kingdom of Morocco':'MA',
  'Mozambique':'MZ','Republic of Mozambique':'MZ',
  'Myanmar':'MM','Republic of the Union of Myanmar':'MM',
  // N
  'Namibia':'NA','Republic of Namibia':'NA',
  'Nepal':'NP','Federal Democratic Republic of Nepal':'NP',
  'Netherlands':'NL','Kingdom of the Netherlands':'NL',
  'New Zealand':'NZ',
  'Nigeria':'NG','Federal Republic of Nigeria':'NG',
  'North Macedonia':'MK','Republic of North Macedonia':'MK','Macedonia':'MK',
  'Norway':'NO','Kingdom of Norway':'NO',
  // O
  'Oman':'OM','Sultanate of Oman':'OM',
  // P
  'Pakistan':'PK','Islamic Republic of Pakistan':'PK',
  'Palestine':'PS','Palestinian Authority':'PS','State of Palestine':'PS','Palestinian Territory':'PS',
  'Peru':'PE','Republic of Peru':'PE',
  'Philippines':'PH','Republic of the Philippines':'PH',
  'Poland':'PL','Republic of Poland':'PL',
  'Portugal':'PT','Portuguese Republic':'PT',
  // Q
  'Qatar':'QA','State of Qatar':'QA',
  // R
  'Romania':'RO','Republic of Romania':'RO',
  'Russia':'RU','Russian Federation':'RU',
  'Rwanda':'RW','Republic of Rwanda':'RW',
  // S
  'Saudi Arabia':'SA','Kingdom of Saudi Arabia':'SA',
  'Senegal':'SN','Republic of Senegal':'SN',
  'Serbia':'RS','Republic of Serbia':'RS',
  'Singapore':'SG','Republic of Singapore':'SG',
  'Slovakia':'SK','Slovak Republic':'SK',
  'Slovenia':'SI','Republic of Slovenia':'SI',
  'Somalia':'SO','Federal Republic of Somalia':'SO',
  'South Africa':'ZA','Republic of South Africa':'ZA',
  'South Sudan':'SS','Republic of South Sudan':'SS',
  'San Marino':'SM','Republic of San Marino':'SM',
  'Spain':'ES','Kingdom of Spain':'ES',
  'Sri Lanka':'LK','Democratic Socialist Republic of Sri Lanka':'LK',
  'Sudan':'SD','Republic of the Sudan':'SD','Republic of Sudan':'SD',
  'Sweden':'SE','Kingdom of Sweden':'SE',
  'Switzerland':'CH','Swiss Confederation':'CH',
  'Syria':'SY','Syrian Arab Republic':'SY',
  // T
  'Taiwan':'TW','Taiwan, Province of China':'TW',
  'Tajikistan':'TJ','Republic of Tajikistan':'TJ',
  'Tanzania':'TZ','Tanzania, United Republic of':'TZ','United Republic of Tanzania':'TZ',
  'Thailand':'TH','Kingdom of Thailand':'TH',
  'Tunisia':'TN','Republic of Tunisia':'TN','Tunisian Republic':'TN',
  'Turkey':'TR','Türkiye':'TR','Republic of Turkey':'TR','Republic of Türkiye':'TR',
  'Turkmenistan':'TM',
  // U
  'Uganda':'UG','Republic of Uganda':'UG',
  'Ukraine':'UA',
  'United Arab Emirates':'AE',
  'United Kingdom':'GB','United Kingdom of Great Britain and Northern Ireland':'GB',
  'United States':'US','United States of America':'US',
  'Uzbekistan':'UZ','Republic of Uzbekistan':'UZ',
  // V
  'Venezuela':'VE','Venezuela, Bolivarian Republic of':'VE','Bolivarian Republic of Venezuela':'VE',
  'Viet Nam':'VN','Vietnam':'VN','Socialist Republic of Viet Nam':'VN',
  // Y
  'Yemen':'YE','Republic of Yemen':'YE',
  // Z
  'Zambia':'ZM','Republic of Zambia':'ZM',
  'Zimbabwe':'ZW','Republic of Zimbabwe':'ZW',
}


// ─── Pure utility functions ────────────────────────────────────────────────

function rand(min, max) { return Math.random() * (max - min) + min }
function randInt(min, max) { return Math.floor(rand(min, max + 1)) }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function offsetCoord(center, rangeKm) {
  const d = 1 / 111
  return [center[0] + rand(-rangeKm, rangeKm) * d, center[1] + rand(-rangeKm, rangeKm) * d]
}

function randHex(len) {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

// Fixed mock fleet — identities never change, only positions update
let mockFleet = null

function buildMockFleet() {
  return Array.from({ length: 30 }, (_, i) => {
    const isMilitary = i < 6  // first 6 are military, rest civilian

    let callsign, actype, originCountry, speedKts, altFt

    if (isMilitary) {
      callsign      = CALLSIGNS_MILITARY[i % CALLSIGNS_MILITARY.length]
      actype        = ['F-16','F-15','C-130','KC-135','MQ-9','UH-60'][i % 6]
      originCountry = ['United States','United Kingdom','Israel','France','Germany','United States'][i % 6]
      speedKts      = randInt(300, 600)
      altFt         = randInt(1000, 35000)
    } else {
      const ci = i - 6
      callsign      = CALLSIGNS_CIVILIAN[ci % CALLSIGNS_CIVILIAN.length]
      actype        = ['B77W','A320','A330','B737','A321','B787','A380'][ci % 7]
      originCountry = ['Turkey','United Arab Emirates','Saudi Arabia','Qatar','Egypt','Germany','United Kingdom','India','Pakistan','Iran','Jordan','Greece','Russia','South Korea','France'][ci % 15]
      speedKts      = randInt(400, 560)
      altFt         = randInt(28000, 43000)
    }

    return {
      id:              `mock-${i.toString().padStart(2, '0')}`,
      callsign,
      origin_country:  originCountry,
      baro_altitude:   Math.round(altFt * 0.3048),
      on_ground:       false,
      velocity:        Math.round(speedKts * 0.514444),
      vertical_rate:   Math.round(rand(-5, 5)),
      squawk:          (1000 + i * 233).toString().padStart(4, '0'),
      position_source: 0,
      altitude:        altFt,
      speed:           speedKts,
      // 5× real speed, converted to deg/s for physics engine
      speedDegS:       speedKts * 5 * 1.852 / 3600 / 111,
      heading:         Math.round(rand(0, 360)),
      targetHeading:   Math.round(rand(0, 360)), // initial turn target (will be updated by tick)
      headingChange:   rand(5, 25),              // magnitude of last heading change (deg)
      actype,
      military:        isMilitary,
      registration:    '',
      originCountry,
      // position will be set by generateAircraft / tickAircraft
      coords:          [0, 0],
      lon:             0,
      lat:             0,
      time_position:   Math.floor(Date.now() / 1000),
      last_contact:    Math.floor(Date.now() / 1000),
    }
  })
}

function generateAircraft(center) {
  if (!mockFleet) mockFleet = buildMockFleet()
  const now = Math.floor(Date.now() / 1000)
  return mockFleet.map(ac => {
    const coords = offsetCoord(center, 200)
    const heading = Math.round(rand(0, 360))
    return { ...ac, coords, lon: coords[0], lat: coords[1], heading, targetHeading: heading, time_position: now, last_contact: now }
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

// physics: animCurrentRef.current — used to read actual current position for bound check
function tickAircraft(aircraft, center, physics) {
  // Only updates targetHeading — position is driven by the physics engine in the anim loop
  const BOUND = 2.5  // degrees from center before steering back to center
  const now   = Math.floor(Date.now() / 1000)
  return aircraft.map(ac => {
    const phy    = physics[ac.id]
    const curLon = phy?.lon ?? ac.lon
    const curLat = phy?.lat ?? ac.lat
    const curHdg = phy?.heading ?? ac.heading

    const dLon = center[0] - curLon
    const dLat = center[1] - curLat
    const dist  = Math.sqrt(dLon * dLon + dLat * dLat)

    let targetHeading, headingChange
    if (dist > BOUND) {
      // Steer back toward center
      targetHeading = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360
      headingChange = ac.headingChange
    } else {
      // ±20% of previous change magnitude, clamped to realistic range (2–45°)
      const prevChange = ac.headingChange || 10
      headingChange = Math.max(2, Math.min(45, prevChange * (0.8 + Math.random() * 0.4)))
      const sign    = Math.random() < 0.5 ? 1 : -1
      targetHeading = (curHdg + sign * headingChange + 360) % 360
    }
    return { ...ac, targetHeading, headingChange, time_position: now, last_contact: now }
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

function lerp(a, b, t) { return a + (b - a) * t }
function lerpAngle(a, b, t) {
  const diff = ((b - a + 540) % 360) - 180
  return (a + diff * t + 360) % 360
}
function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t }


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
        registration: ac.registration || '',
        originCountry: ac.originCountry || ac.origin_country || '',
        countryCode: COUNTRY_CODE[ac.originCountry || ac.origin_country || ''] || '',
        flagKey: COUNTRY_CODE[ac.originCountry || ac.origin_country || ''] ? `flag-${COUNTRY_CODE[ac.originCountry || ac.origin_country || '']}` : '',
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
  const isMil   = props.military === 1 || props.military === true
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
      <div><span style="color:#6b7280">COUNTRY:</span> ${props.originCountry || '—'}</div>
      ${props.registration ? `<div><span style="color:#6b7280">REG:</span> ${props.registration}</div>` : ''}
      <div><span style="color:#6b7280">TYPE:</span> ${props.actype || '—'}</div>
      <div><span style="color:#6b7280">ALT:</span> ${altFt} ft</div>
      <div><span style="color:#6b7280">SPD:</span> ${spd}</div>
      <div><span style="color:#6b7280">HDG:</span> ${Math.round(props.heading || 0)}°</div>
      ${/^[A-Z]{2,3}\d{1,4}[A-Z]?$/i.test((props.callsign || '').trim()) ? `
      <div style="margin-top:8px;border-top:1px solid rgba(74,222,128,0.15);padding-top:6px">
        <a href="https://www.flightaware.com/live/flight/${(props.callsign || '').trim().toUpperCase()}"
          target="_blank" rel="noopener noreferrer"
          style="color:#60a5fa;font-size:10px;text-decoration:none;letter-spacing:0.05em">
          ↗ 스케줄 보기 (FlightAware)
        </a>
      </div>` : ''}
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
        <a href="https://www.flightaware.com/live/airport/${props.iata || props.icao}"
          target="_blank" rel="noopener noreferrer"
          style="color:#60a5fa;font-size:10px;text-decoration:none;letter-spacing:0.05em">
          ↗ 취항노선 보기 (FlightAware)
        </a>
      </div>
    </div>`
}

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
  const animCurrentRef = useRef({}) // id → { lat, lon, heading } (last rendered position)
  const animToRef = useRef([])      // target aircraft list
  const liveIntervalMsRef = useRef(100000) // measured interval between aircraft:update events
  const lastAircraftUpdateRef = useRef(null)
  const pendingAirportsRef = useRef(null)   // airports received before map was ready

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
              ['==', ['get', 'military'], 1], 'aircraft-military',
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
            'text-color': ['case', ['==', ['get', 'military'], 1], '#ef4444', '#4ade80'],
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
        // International airports (large_airport) — visible by default
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

        // Other airports (medium + small) — hidden by default
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

        // Apply airports that arrived before the map was ready
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
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 2000,
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
      // Measure actual interval between updates to tune animation speed
      const now = performance.now()
      if (lastAircraftUpdateRef.current) {
        const measured = now - lastAircraftUpdateRef.current
        // Clamp to sane range (5s–300s) and smooth with EMA to avoid noise
        if (measured > 5000 && measured < 300000)
          liveIntervalMsRef.current = liveIntervalMsRef.current * 0.7 + measured * 0.3
      }
      lastAircraftUpdateRef.current = now
      const map = mapInstanceRef.current
      ensureAircraftLabels(data, map)
      setCounts(prev => ({ ...prev, aircraft: getFilteredAircraft(data, aircraftFilterRef.current).length }))
      data.forEach(ac => {
        if (!animCurrentRef.current[ac.id]) {
          // New aircraft: initialize at GPS position with actual ADS-B speed
          animCurrentRef.current[ac.id] = {
            lat: ac.lat, lon: ac.lon,
            heading: ac.heading ?? 0,
            headingRate: 0,
            currentSpeed: (ac.speed ?? 0) * (1852 / 3600 / 111000), // knots → deg/s
          }
        }
        // Existing aircraft: do NOT snap position — dead reckoning continues uninterrupted.
        // Only heading/speed targets update via animToRef (read each frame in the loop).
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

    // Mock 실행 중이면 새 지역 기준으로 즉시 재시드
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
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mock_aircraft_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Continuous animation loop (unified physics engine) ───────────────────
  // Heading : underdamped spring → natural slip on direction change
  //   ζ = DAMP_S / (2√K_S) = 1.6/2 = 0.8  (lightly underdamped)
  // Speed   : constant at target SPD; ease-in only on increase, ease-out on decrease
  //   tau_accel (2s) < tau_decel (4s) — realistic aircraft feel
  // Live    : position snapped to GPS on each update, velocity integrates between updates
  const HDG_DAMP_S   = 1.6  // angular damping    (per second)
  const HDG_K_S      = 1.0  // angular stiffness  (per second²)
  const TAU_ACCEL    = 2.0  // speed increase time constant (seconds)
  const TAU_DECEL    = 4.0  // speed decrease time constant (seconds)
  const SPD_SNAP_EPS = 0.001 // fraction of target: within 0.1% → snap to target

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
            // ── Init on first frame ────────────────────────────────────────
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

            // ── Heading spring (same for mock & live) ─────────────────────
            const targetHdg = ac.targetHeading ?? ac.heading ?? cur.heading
            const diff = ((targetHdg - cur.heading + 540) % 360) - 180
            const headingRate = cur.headingRate * Math.exp(-HDG_DAMP_S * dt_s)
                              + diff * HDG_K_S * dt_s
            const heading = (cur.heading + headingRate * dt_s + 360) % 360

            // ── Speed: constant at SPD, ease only on change ────────────────
            const targetSpd = isMock
              ? (ac.speedDegS ?? 0.01)
              : (ac.speed ?? 0) * (1852 / 3600 / 111000) // knots → deg/s
            const speedDiff = targetSpd - cur.currentSpeed
            const atTarget  = Math.abs(speedDiff) < targetSpd * SPD_SNAP_EPS
            const tau        = speedDiff > 0 ? TAU_ACCEL : TAU_DECEL
            const currentSpeed = atTarget
              ? targetSpd
              : cur.currentSpeed + speedDiff * (1 - Math.exp(-dt_s / tau))

            // ── Position integration ───────────────────────────────────────
            // heading: 0=North, 90=East, 180=South, 270=West (clockwise from North)
            // lon += sin(heading), lat += cos(heading)
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
    // Seed physics state from initial positions (speed=0 → ease-in starts here)
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
      // Pass physics state so tick can read actual current position for bound check
      aircraftDataRef.current = tickAircraft(aircraftDataRef.current, c, animCurrentRef.current)
      fireDataRef.current = tickFires(fireDataRef.current, c)
      // Update target heading only — physics loop drives position
      animToRef.current = aircraftDataRef.current
      const map = mapInstanceRef.current
      if (map?.isStyleLoaded()) {
        const filtered = getFilteredAircraft(fireDataRef.current, fireHoursFilterRef.current)
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

  // ── 6. Fire time filter / aircraft filter → re-render ────────────────────
  useEffect(() => {
    if (mapLoaded) updateSources()
  }, [fireHoursFilter, aircraftFilter, mapLoaded, updateSources])

  // ── 7. Layer visibility ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapLoaded) return
    const layerMap = {
      aircraft: ['aircraft-layer', 'flag-layer'],
      fires: ['fire-heat-layer', 'fire-circle-layer'],
      airports: ['airport-circle-layer', 'airport-label-layer'],
      airportsOther: ['airport-other-circle-layer', 'airport-other-label-layer'],
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
