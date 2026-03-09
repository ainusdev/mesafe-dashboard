// ─── Haversine distance (km) ────────────────────────────────────────────────

const RAD = Math.PI / 180

export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const dLat = (lat2 - lat1) * RAD
  const dLon = (lon2 - lon1) * RAD
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─── Proximity alerts ───────────────────────────────────────────────────────

/**
 * Computes proximity alerts: fires near military bases.
 * @param {Array} fires  — fire data with .coords [lon, lat], .frp
 * @param {Array} bases  — MILITARY_BASES entries
 * @param {number} thresholdKm — detection radius (default 15)
 * @returns {Array<{baseId, baseName, fireCount, totalFrp, maxFrp, distanceKm, severity}>}
 */
export function computeProximityAlerts(fires, bases, thresholdKm = 15) {
  const alerts = []

  for (const base of bases) {
    let fireCount = 0
    let totalFrp = 0
    let maxFrp = 0
    let minDist = Infinity

    for (const f of fires) {
      const d = haversineKm(base.coords, f.coords)
      if (d <= thresholdKm) {
        fireCount++
        const frp = f.frp || 0
        totalFrp += frp
        if (frp > maxFrp) maxFrp = frp
        if (d < minDist) minDist = d
      }
    }

    if (fireCount === 0) continue

    let severity = null
    if (fireCount >= 5 && totalFrp > 100) severity = 'CRITICAL'
    else if (fireCount >= 3 || totalFrp > 50) severity = 'WARNING'

    if (severity) {
      alerts.push({
        baseId: base.id,
        baseName: base.name,
        fireCount,
        totalFrp: Math.round(totalFrp),
        maxFrp: Math.round(maxFrp),
        distanceKm: Math.round(minDist * 10) / 10,
        severity,
      })
    }
  }

  // Sort: CRITICAL first, then by fireCount descending
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'CRITICAL' ? -1 : 1
    return b.fireCount - a.fireCount
  })

  return alerts
}
