export function buildAircraftPopupHTML(props) {
  const status  = props.militaryStatus || (props.military ? 'military' : 'civilian')
  const acColor = status === 'military' ? '#ef4444' : status === 'suspected' ? '#f59e0b' : '#4ade80'
  const acLabel = status === 'military' ? '🔴 MILITARY' : status === 'suspected' ? '🟡 미식별' : '🟢 CIVILIAN'
  const altFt   = typeof props.altitude === 'number' ? props.altitude.toLocaleString() : props.altitude
  const spd     = typeof props.speed === 'number' ? `${Math.round(props.speed)} kts` : '—'

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

export function buildFirePopupHTML(props) {
  const c         = { LOW: '#60a5fa', MEDIUM: '#fbbf24', HIGH: '#f97316', EXTREME: '#ef4444' }[props.intensity] || '#4ade80'
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

  const ts      = props.acqTimestamp || 0
  const utcStr  = fmtTime(ts, 'UTC')
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
      <div style="margin-top:8px;border-top:1px solid rgba(74,222,128,0.15);padding-top:6px">
        <a href="/guide/firms.html" target="_blank" rel="noopener noreferrer"
          style="color:#60a5fa;font-size:10px;text-decoration:none;letter-spacing:0.05em">
          ↗ 화점 데이터 읽는 법
        </a>
      </div>
      <div style="margin-top:5px;color:rgba(74,222,128,0.4);font-size:10px">NASA FIRMS VIIRS 375m</div>
    </div>`
}

export function buildFireClusterPopupHTML(clickedProps, allProps) {
  const count    = allProps.length
  const totalFrp = allProps.reduce((s, p) => s + (p.frp || 0), 0)
  const maxFrp   = Math.max(...allProps.map(p => p.frp || 0))
  const avgFrp   = totalFrp / count

  const clusterIntensity = totalFrp > 200 ? 'EXTREME' : totalFrp > 80 ? 'HIGH' : totalFrp > 30 ? 'MEDIUM' : 'LOW'
  const clusterColor     = { LOW: '#60a5fa', MEDIUM: '#fbbf24', HIGH: '#f97316', EXTREME: '#ef4444' }[clusterIntensity]

  const byIntensity = { LOW: 0, MEDIUM: 0, HIGH: 0, EXTREME: 0 }
  allProps.forEach(p => { byIntensity[p.intensity || 'LOW']++ })
  const breakdown = Object.entries(byIntensity)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const c = { LOW: '#60a5fa', MEDIUM: '#fbbf24', HIGH: '#f97316', EXTREME: '#ef4444' }[k]
      return `<span style="color:${c}">${k} ${n}</span>`
    }).join(' &middot; ')

  // Determine cluster assessment
  let assessment = ''
  if (totalFrp > 100 && count >= 3) {
    assessment = `<div style="color:#ef4444;margin-top:6px;font-size:10px;line-height:1.5">
      ⚠ 다수 화점이 밀집 — 대규모 화재, 폭격, 또는 다연장 공격 가능성.<br>
      &nbsp;&nbsp;뉴스/SNS와 교차 확인 필요.</div>`
  } else if (count >= 5 && avgFrp < 5) {
    assessment = `<div style="color:#fbbf24;margin-top:6px;font-size:10px;line-height:1.5">
      ℹ 다수의 저강도 화점 밀집 — 농업 소각 또는 요격 잔해 낙하 패턴 가능성.</div>`
  } else if (count >= 3) {
    assessment = `<div style="color:#fbbf24;margin-top:6px;font-size:10px;line-height:1.5">
      ℹ 화점 ${count}개 밀집 — 개별 강도는 낮으나 집중 발생 지역입니다.</div>`
  }

  // Also show the clicked fire's details
  const single = buildFirePopupHTML(clickedProps)

  return `
    <div style="font-family:'Courier New',monospace;font-size:11px;line-height:1.7;color:#4ade80">
      <div style="color:${clusterColor};font-size:13px;font-weight:bold;margin-bottom:6px;
                  border-bottom:1px solid ${clusterColor}44;padding-bottom:4px">
        🔥 화점 ${count}개 밀집
      </div>
      <div><span style="color:#6b7280">총 FRP:</span> <span style="color:${clusterColor};font-weight:bold">${Math.round(totalFrp)} MW</span></div>
      <div><span style="color:#6b7280">최대 FRP:</span> ${Math.round(maxFrp)} MW</div>
      <div><span style="color:#6b7280">평균 FRP:</span> ${Math.round(avgFrp)} MW</div>
      <div><span style="color:#6b7280">밀집 강도:</span> <span style="color:${clusterColor}">${clusterIntensity}</span></div>
      <div style="margin-top:4px;font-size:10px">${breakdown}</div>
      ${assessment}
      <div style="height:1px;background:rgba(251,191,36,0.2);margin:8px 0"></div>
      <div style="color:#6b7280;font-size:10px;margin-bottom:4px;letter-spacing:0.05em">▼ 선택된 화점</div>
    </div>
    ${single}`
}

export function buildAirportPopupHTML(props) {
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
