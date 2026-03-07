// ─── Random utilities (internal) ─────────────────────────────────────────────

function rand(min, max) { return Math.random() * (max - min) + min }
function randInt(min, max) { return Math.floor(rand(min, max + 1)) }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function offsetCoord(center, rangeKm) {
  const d = 1 / 111
  return [center[0] + rand(-rangeKm, rangeKm) * d, center[1] + rand(-rangeKm, rangeKm) * d]
}

// ─── Mock callsigns ───────────────────────────────────────────────────────────

export const CALLSIGNS_CIVILIAN = [
  'EK471','EK828','EK204','FZ204','FZ317',
  'QR541','QR007','QR342','EY302','EY451',
  'MS903','GF452','TK788','TK124','SV872',
  'WY513','ME342','GF103','RJ103','PC572',
  'KAL001','KAL851','KAL958','AAR271','AAR603','JJA151','ABL661',
]

export const CALLSIGNS_MILITARY = [
  'EAGLE-1','EAGLE-2','VIPER-1','VIPER-3',
  'REACH-1','SPAR-21','DOOM-4','DUKE-7',
]

export const CALLSIGNS_SUSPECTED = [
  'GHOST-3','WOLF-1','COBRA-2','COBRA-4',
]

// ─── Fixed mock fleet ─────────────────────────────────────────────────────────

let mockFleet = null

function buildMockFleet() {
  return Array.from({ length: 30 }, (_, i) => {
    const isMilitary  = i < 4
    const isSuspected = i >= 4 && i < 8
    const militaryStatus = isMilitary ? 'military' : isSuspected ? 'suspected' : 'civilian'

    let callsign, actype, originCountry, speedKts, altFt

    if (isMilitary) {
      callsign      = CALLSIGNS_MILITARY[i % CALLSIGNS_MILITARY.length]
      actype        = ['F-16','F-15','C-130','KC-135'][i % 4]
      originCountry = ['United States','United Kingdom','Israel','France'][i % 4]
      speedKts      = randInt(300, 600)
      altFt         = randInt(1000, 35000)
    } else if (isSuspected) {
      callsign      = CALLSIGNS_SUSPECTED[(i - 4) % CALLSIGNS_SUSPECTED.length]
      actype        = ['MQ-9','UH-60','C-17','P-8'][( i - 4) % 4]
      originCountry = ['United States','United Kingdom','Israel','France'][(i - 4) % 4]
      speedKts      = randInt(200, 500)
      altFt         = randInt(1000, 40000)
    } else {
      const ci = i - 8
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
      speedDegS:       speedKts * 5 * 1.852 / 3600 / 111,
      heading:         Math.round(rand(0, 360)),
      targetHeading:   Math.round(rand(0, 360)),
      headingChange:   rand(5, 25),
      actype,
      military:        isMilitary || isSuspected,
      militaryStatus,
      registration:    '',
      originCountry,
      coords:          [0, 0],
      lon:             0,
      lat:             0,
      time_position:   Math.floor(Date.now() / 1000),
      last_contact:    Math.floor(Date.now() / 1000),
    }
  })
}

// ─── Data generators ─────────────────────────────────────────────────────────

export function generateAircraft(center) {
  if (!mockFleet) mockFleet = buildMockFleet()
  const now = Math.floor(Date.now() / 1000)
  return mockFleet.map(ac => {
    const coords  = offsetCoord(center, 200)
    const heading = Math.round(rand(0, 360))
    return { ...ac, coords, lon: coords[0], lat: coords[1], heading, targetHeading: heading, time_position: now, last_contact: now }
  })
}

export function generateFires(center) {
  return Array.from({ length: randInt(15, 30) }, (_, i) => {
    const ageMs = randInt(0, 86400000)
    const d     = new Date(Date.now() - ageMs)
    const hhmm  = d.getUTCHours().toString().padStart(2, '0') + d.getUTCMinutes().toString().padStart(2, '0')
    return {
      id:           `fire-${Date.now()}-${i}`,
      coords:       offsetCoord(center, 150),
      brightness:   rand(0.3, 1.0),
      frp:          rand(5, 200),
      intensity:    randItem(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      acqDate:      d.toISOString().slice(0, 10),
      acqTime:      hhmm,
      acqTimestamp: d.getTime(),
      confidence:   randItem(['high', 'medium', 'low', 'nominal']),
    }
  })
}

// ─── Tick functions (10s interval) ───────────────────────────────────────────

export function tickAircraft(aircraft, center, physics) {
  const BOUND = 2.5
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
      targetHeading = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360
      headingChange = ac.headingChange
    } else {
      const prevChange = ac.headingChange || 10
      headingChange    = Math.max(2, Math.min(45, prevChange * (0.8 + Math.random() * 0.4)))
      const sign       = Math.random() < 0.5 ? 1 : -1
      targetHeading    = (curHdg + sign * headingChange + 360) % 360
    }
    return { ...ac, targetHeading, headingChange, time_position: now, last_contact: now }
  })
}

export function tickFires(fires, center) {
  const updated = fires.map(f => ({
    ...f,
    brightness: Math.max(0.1, Math.min(1.0, f.brightness + rand(-0.03, 0.03))),
  }))
  const newCount = randInt(1, 3)
  for (let i = 0; i < newCount; i++) {
    const ts   = Date.now() - randInt(0, 86400000)
    const d    = new Date(ts)
    const hhmm = d.getUTCHours().toString().padStart(2, '0') + d.getUTCMinutes().toString().padStart(2, '0')
    updated.push({
      id:           `fire-${ts}-${Math.random().toString(36).slice(2, 6)}`,
      coords:       offsetCoord(center, 150),
      brightness:   rand(0.3, 1.0),
      frp:          rand(5, 200),
      intensity:    randItem(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      acqDate:      d.toISOString().slice(0, 10),
      acqTime:      hhmm,
      acqTimestamp: ts,
      confidence:   randItem(['high', 'medium', 'low', 'nominal']),
    })
  }
  return updated.length > 1000 ? updated.slice(-1000) : updated
}
