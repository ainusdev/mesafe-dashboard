const axios = require('axios')
const { log } = require('./logger')
const { parseCSVLine, saveAirportsCache } = require('./cache')

const ME_COUNTRIES = new Set([
  'IR','IQ','SA','AE','QA','KW','BH','OM','YE','JO','LB','SY','IL','PS',
])

/** Fetch Middle East airports from OurAirports, save to cache, return array. */
async function fetchAirports() {
  try {
    const res = await axios.get(
      'https://davidmegginson.github.io/ourairports-data/airports.csv',
      { timeout: 30000 },
    )
    const lines = res.data.trim().split('\n')
    const headers = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').trim())

    const airports = []
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i])
      if (vals.length < headers.length) continue

      const row = {}
      headers.forEach((h, idx) => { row[h] = (vals[idx] || '').replace(/"/g, '').trim() })

      if (!ME_COUNTRIES.has(row.iso_country)) continue
      if (!['large_airport', 'medium_airport', 'small_airport'].includes(row.type)) continue

      const lat = parseFloat(row.latitude_deg)
      const lon = parseFloat(row.longitude_deg)
      if (isNaN(lat) || isNaN(lon)) continue

      airports.push({
        id:           row.ident,
        name:         row.name,
        iata:         row.iata_code || '',
        icao:         row.ident,
        type:         row.type,
        country:      row.iso_country,
        municipality: row.municipality || '',
        coords:       [lon, lat],
        elevation:    parseInt(row.elevation_ft) || 0,
      })
    }

    saveAirportsCache(airports)
    log('Airports', `${airports.length} airports loaded (Middle East)`)
    return airports
  } catch (err) {
    log('Airports', `Fetch error: ${err.message}`, 'error')
    return []
  }
}

module.exports = { fetchAirports }
