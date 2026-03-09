import { COUNTRY_CODE } from './countries.js'

export function normaliseAircraft(ac) {
  if (ac.lat !== undefined) return { ...ac, coords: [ac.lon, ac.lat] }
  return ac
}

export function getFilteredAircraft(data, filter) {
  const norm = data.map(normaliseAircraft)
  if (filter === 'MILITARY') return norm.filter(a => a.militaryStatus === 'military')
  if (filter === 'UNKNOWN')  return norm.filter(a => a.militaryStatus === 'suspected')
  if (filter === 'CIVILIAN') return norm.filter(a => !a.military && a.militaryStatus !== 'suspected')
  return norm
}

export function getFilteredFires(data, hours) {
  if (!hours) return data
  const cutoff = Date.now() - hours * 3600 * 1000
  return data.filter(f => f.acqTimestamp > 0 && f.acqTimestamp >= cutoff)
}

export function lerp(a, b, t) { return a + (b - a) * t }

export function lerpAngle(a, b, t) {
  const diff = ((b - a + 540) % 360) - 180
  return (a + diff * t + 360) % 360
}

export function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t }

export function toGeoJSONAircraft(data) {
  return {
    type: 'FeatureCollection',
    features: data.map(ac => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: ac.coords },
      properties: {
        id:            ac.id,
        callsign:      ac.callsign,
        heading:       ac.heading,
        altitude:      typeof ac.altitude === 'number' ? ac.altitude : 0,
        speed:         ac.speed || 0,
        actype:        ac.actype || 'UNKNOWN',
        military:      ac.military ? 1 : 0,
        militaryStatus: ac.militaryStatus || (ac.military ? 'military' : 'civilian'),
        registration:  ac.registration || '',
        originCountry: ac.originCountry || ac.origin_country || '',
        countryCode:   COUNTRY_CODE[ac.originCountry || ac.origin_country || ''] || '',
        flagKey:       COUNTRY_CODE[ac.originCountry || ac.origin_country || '']
          ? `flag-${COUNTRY_CODE[ac.originCountry || ac.origin_country || '']}`
          : '',
      },
    })),
  }
}

export function toGeoJSONBases(bases) {
  return {
    type: 'FeatureCollection',
    features: bases.map(b => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: b.coords },
      properties: {
        id: b.id, name: b.name, country: b.country,
        type: b.type, operator: b.operator,
        dangerRadiusKm: b.dangerRadiusKm,
      },
    })),
  }
}

export function toGeoJSONEmbassies(embassies) {
  return {
    type: 'FeatureCollection',
    features: embassies.map(e => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: e.coords },
      properties: {
        id: e.id, name: e.name, country: e.country,
        type: e.type, address: e.address,
        phone: e.phone, emergency: e.emergency,
        website: e.website || '',
      },
    })),
  }
}

export function toGeoJSONAirspaceClosure(closedFirs, restrictedFirs, FIR_BOUNDARIES) {
  const features = []
  for (const [fir, coords] of Object.entries(FIR_BOUNDARIES)) {
    let severity = null
    if (closedFirs.includes(fir)) severity = 'CLOSED'
    else if (restrictedFirs.includes(fir)) severity = 'RESTRICTED'
    if (!severity) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coords.map(c => [c[0], c[1]])] },
      properties: { fir, severity },
    })
  }
  return { type: 'FeatureCollection', features }
}

export function toGeoJSONFires(data) {
  return {
    type: 'FeatureCollection',
    features: data.map(f => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: f.coords },
      properties: {
        id:           f.id,
        brightness:   f.brightness,
        frp:          f.frp || 0,
        intensity:    f.intensity || 'LOW',
        acqDate:      f.acqDate || '',
        acqTime:      f.acqTime || '',
        acqTimestamp: f.acqTimestamp || 0,
        confidence:   f.confidence || '',
      },
    })),
  }
}
