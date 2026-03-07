import { COUNTRY_CODE } from './countries.js'

const _flagRequested = new Set()

/** Fire parallel loadImage for every unique ISO code in COUNTRY_CODE at map init. */
export function preloadAllFlags(map) {
  const codes = [...new Set(Object.values(COUNTRY_CODE))]
  codes.forEach(code => {
    const id = `flag-${code}`
    if (map.hasImage(id) || _flagRequested.has(id)) return
    _flagRequested.add(id)
    map.loadImage(
      `https://flagcdn.com/20x15/${code.toLowerCase()}.png`,
      (err, img) => { if (!err && img) map.addImage(id, img) },
    )
  })
}

// No-op kept for call sites — flags are preloaded at map init.
export function ensureAircraftLabels(_aircraft, _map) {}
