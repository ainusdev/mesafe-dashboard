// ─── Military Bases ─────────────────────────────────────────────────────────

export const MILITARY_BASES = [
  { id: 'nsa-bahrain',     name: 'NSA Bahrain / US 5th Fleet', country: 'Bahrain', type: 'naval', operator: 'US Navy',    coords: [50.6120, 26.2361], dangerRadiusKm: 5 },
  { id: 'al-udeid',        name: 'Al Udeid Air Base',          country: 'Qatar',   type: 'air',   operator: 'US Air Force', coords: [51.3148, 25.1174], dangerRadiusKm: 5 },
  { id: 'al-dhafra',       name: 'Al Dhafra Air Base',         country: 'UAE',     type: 'air',   operator: 'US Air Force', coords: [54.5478, 24.2482], dangerRadiusKm: 5 },
  { id: 'camp-arifjan',    name: 'Camp Arifjan',               country: 'Kuwait',  type: 'army',  operator: 'US Army',     coords: [48.1018, 29.0836], dangerRadiusKm: 5 },
  { id: 'prince-sultan',   name: 'Prince Sultan Air Base',     country: 'Saudi',   type: 'air',   operator: 'RSAF / USAF', coords: [47.5805, 24.0625], dangerRadiusKm: 5 },
  { id: 'incirlik',        name: 'Incirlik Air Base',          country: 'Turkey',  type: 'air',   operator: 'US Air Force', coords: [35.4259, 37.0021], dangerRadiusKm: 5 },
  { id: 'camp-buehring',   name: 'Camp Buehring',              country: 'Kuwait',  type: 'army',  operator: 'US Army',     coords: [47.4788, 29.3337], dangerRadiusKm: 5 },
  { id: 'ali-al-salem',    name: 'Ali Al Salem Air Base',      country: 'Kuwait',  type: 'air',   operator: 'USAF / KAF',  coords: [47.5208, 29.3467], dangerRadiusKm: 5 },
  { id: 'al-minhad',       name: 'Al Minhad Air Base',         country: 'UAE',     type: 'air',   operator: 'UAE Air Force', coords: [55.3652, 25.0270], dangerRadiusKm: 5 },
  { id: 'thumrait',        name: 'Thumrait Air Base',          country: 'Oman',    type: 'air',   operator: 'RAFO',        coords: [54.0246, 17.6660], dangerRadiusKm: 5 },
  { id: 'nevatim',         name: 'Nevatim Air Base',           country: 'Israel',  type: 'air',   operator: 'IAF',         coords: [34.9330, 31.2083], dangerRadiusKm: 5 },
  { id: 'ramon',           name: 'Ramon Air Base',             country: 'Israel',  type: 'air',   operator: 'IAF',         coords: [34.6675, 30.7762], dangerRadiusKm: 5 },
  { id: 'king-abdulaziz',  name: 'King Abdulaziz Air Base',    country: 'Saudi',   type: 'air',   operator: 'RSAF',        coords: [50.1528, 26.2651], dangerRadiusKm: 5 },
  { id: 'eskan-village',   name: 'Eskan Village',              country: 'Saudi',   type: 'support', operator: 'US Military', coords: [46.8015, 24.5750], dangerRadiusKm: 5 },
  { id: 'al-salem-iraq',   name: 'Al Asad Air Base',           country: 'Iraq',    type: 'air',   operator: 'US / Iraqi',  coords: [42.4413, 33.7856], dangerRadiusKm: 5 },
]

// ─── Korean Embassies & Consulates ──────────────────────────────────────────

export const EMBASSIES = [
  { id: 'kr-uae',       name: '주UAE 대한민국 대사관',       country: 'UAE',     type: 'korean', address: 'Abu Dhabi, Diplomatic Area',         phone: '+971-2-443-5335', emergency: '+971-50-699-2125', coords: [54.4362, 24.4539], website: 'overseas.mofa.go.kr/ae-ko' },
  { id: 'kr-uae-dubai', name: '주두바이 총영사관',           country: 'UAE',     type: 'korean', address: 'Dubai, Jumeirah',                    phone: '+971-4-223-3526', emergency: '+971-50-652-3693', coords: [55.2271, 25.2135], website: 'overseas.mofa.go.kr/ae-dubai-ko' },
  { id: 'kr-saudi',     name: '주사우디 대한민국 대사관',     country: 'Saudi',   type: 'korean', address: 'Riyadh, Diplomatic Quarter',         phone: '+966-11-488-2211', emergency: '+966-50-291-1991', coords: [46.6256, 24.6787], website: 'overseas.mofa.go.kr/sa-ko' },
  { id: 'kr-saudi-jed', name: '주젯다 총영사관',             country: 'Saudi',   type: 'korean', address: 'Jeddah',                             phone: '+966-12-667-0760', emergency: '+966-50-399-7974', coords: [39.1860, 21.5433], website: 'overseas.mofa.go.kr/sa-jeddah-ko' },
  { id: 'kr-kuwait',    name: '주쿠웨이트 대한민국 대사관',   country: 'Kuwait',  type: 'korean', address: 'Kuwait City, Diplomatic Area',        phone: '+965-2253-3650',  emergency: '+965-9905-7488',  coords: [47.9690, 29.3602], website: 'overseas.mofa.go.kr/kw-ko' },
  { id: 'kr-qatar',     name: '주카타르 대한민국 대사관',     country: 'Qatar',   type: 'korean', address: 'Doha, Diplomatic Area',               phone: '+974-4483-3660',  emergency: '+974-5558-3388',  coords: [51.4472, 25.3113], website: 'overseas.mofa.go.kr/qa-ko' },
  { id: 'kr-bahrain',   name: '주바레인 대한민국 대사관',     country: 'Bahrain', type: 'korean', address: 'Manama, Diplomatic Area',             phone: '+973-1753-1600',  emergency: '+973-3929-0734',  coords: [50.5680, 26.2285], website: 'overseas.mofa.go.kr/bh-ko' },
  { id: 'kr-oman',      name: '주오만 대한민국 대사관',       country: 'Oman',    type: 'korean', address: 'Muscat, Diplomatic Quarter',          phone: '+968-2469-1490',  emergency: '+968-9200-0860',  coords: [58.4174, 23.5899], website: 'overseas.mofa.go.kr/om-ko' },
  { id: 'kr-iraq',      name: '주이라크 대한민국 대사관',     country: 'Iraq',    type: 'korean', address: 'Baghdad, International Zone',         phone: '+964-780-197-0063', emergency: '+964-780-197-0063', coords: [44.3661, 33.3029], website: 'overseas.mofa.go.kr/iq-ko' },
  { id: 'kr-iraq-erbil', name: '주에르빌 총영사관',           country: 'Iraq',    type: 'korean', address: 'Erbil',                              phone: '+964-750-735-5301', emergency: '+964-750-735-5301', coords: [44.0088, 36.1912], website: 'overseas.mofa.go.kr/iq-erbil-ko' },
  { id: 'kr-iran',      name: '주이란 대한민국 대사관',       country: 'Iran',    type: 'korean', address: 'Tehran, Zafaraniyeh',                 phone: '+98-21-2254-4191', emergency: '+98-912-614-0846', coords: [51.4215, 35.8022], website: 'overseas.mofa.go.kr/ir-ko' },
  { id: 'kr-jordan',    name: '주요르단 대한민국 대사관',     country: 'Jordan',  type: 'korean', address: 'Amman, Abdoun',                      phone: '+962-6-593-0745',  emergency: '+962-79-559-5498', coords: [35.8823, 31.9530], website: 'overseas.mofa.go.kr/jo-ko' },
  { id: 'kr-lebanon',   name: '주레바논 대한민국 대사관',     country: 'Lebanon', type: 'korean', address: 'Beirut, Rabieh',                     phone: '+961-4-401-237',   emergency: '+961-3-221-330',  coords: [35.5584, 33.9024], website: 'overseas.mofa.go.kr/lb-ko' },
  { id: 'kr-israel',    name: '주이스라엘 대한민국 대사관',   country: 'Israel',  type: 'korean', address: 'Tel Aviv, Herzliya Pituach',          phone: '+972-9-954-3704',  emergency: '+972-54-343-4733', coords: [34.7913, 32.0853], website: 'overseas.mofa.go.kr/il-ko' },
  { id: 'kr-turkey',    name: '주터키 대한민국 대사관',       country: 'Turkey',  type: 'korean', address: 'Ankara, Çankaya',                    phone: '+90-312-468-4821', emergency: '+90-532-481-4823', coords: [32.8597, 39.9334], website: 'overseas.mofa.go.kr/tr-ko' },
  { id: 'kr-turkey-ist', name: '주이스탄불 총영사관',         country: 'Turkey',  type: 'korean', address: 'Istanbul, Levent',                   phone: '+90-212-368-8368', emergency: '+90-532-271-3351', coords: [29.0130, 41.0082], website: 'overseas.mofa.go.kr/tr-istanbul-ko' },
  { id: 'kr-yemen',     name: '주예멘 대한민국 대사관 (리야드)', country: 'Yemen', type: 'korean', address: 'Riyadh (임시공관)',                  phone: '+966-11-488-2211', emergency: '+966-50-291-1991', coords: [46.6256, 24.6787], website: 'overseas.mofa.go.kr/ye-ko' },
]

// ─── Emergency Contacts ─────────────────────────────────────────────────────

export const EMERGENCY_CONTACTS = {
  global: {
    label: '영사콜센터 24h',
    phone: '+82-2-2100-7999',
    note: '해외 긴급상황 시 외교부 영사콜센터',
  },
  countries: {
    UAE:     { police: '999', ambulance: '998', fire: '997' },
    Saudi:   { police: '999', ambulance: '997', fire: '998' },
    Kuwait:  { police: '112', ambulance: '112', fire: '112' },
    Qatar:   { police: '999', ambulance: '999', fire: '999' },
    Bahrain: { police: '999', ambulance: '999', fire: '999' },
    Oman:    { police: '9999', ambulance: '9999', fire: '9999' },
    Iraq:    { police: '104', ambulance: '122', fire: '115' },
    Iran:    { police: '110', ambulance: '115', fire: '125' },
    Jordan:  { police: '911', ambulance: '911', fire: '911' },
    Lebanon: { police: '112', ambulance: '140', fire: '175' },
    Israel:  { police: '100', ambulance: '101', fire: '102' },
    Turkey:  { police: '155', ambulance: '112', fire: '110' },
    Yemen:   { police: '199', ambulance: '191', fire: '191' },
    Syria:   { police: '112', ambulance: '110', fire: '113' },
  },
}

// Region key → country key mapping for emergency lookups
export const REGION_COUNTRY = {
  IRAN: 'Iran', IRAQ: 'Iraq', ISRAEL: 'Israel', JORDAN: 'Jordan',
  LEBANON: 'Lebanon', PALESTINE: 'Israel', SAUDI_ARABIA: 'Saudi',
  SYRIA: 'Syria', YEMEN: 'Yemen',
}

// ─── Airport Operational Status ─────────────────────────────────────────────

export const AIRPORT_STATUS = {
  // UAE
  OMDB: { status: 'OPEN', note: '' },  // Dubai DXB
  OMAA: { status: 'OPEN', note: '' },  // Abu Dhabi AUH
  OMSJ: { status: 'OPEN', note: '' },  // Sharjah SHJ
  // Saudi
  OEJN: { status: 'OPEN', note: '' },  // Jeddah JED
  OERK: { status: 'OPEN', note: '' },  // Riyadh RUH
  OEDF: { status: 'OPEN', note: '' },  // Dammam DMM
  OEAH: { status: 'OPEN', note: '' },  // Al-Ahsa HOF
  // Kuwait
  OKBK: { status: 'OPEN', note: '' },  // Kuwait KWI
  // Qatar
  OTHH: { status: 'OPEN', note: '' },  // Doha DOH
  // Bahrain
  OBBI: { status: 'OPEN', note: '' },  // Bahrain BAH
  // Oman
  OOMS: { status: 'OPEN', note: '' },  // Muscat MCT
  // Iraq
  ORBI: { status: 'OPEN', note: '' },  // Baghdad BGW
  ORER: { status: 'OPEN', note: '' },  // Erbil EBL
  // Iran
  OIIE: { status: 'OPEN', note: '' },  // Tehran IKA
  OIII: { status: 'OPEN', note: '' },  // Tehran Mehrabad THR
  // Jordan
  OJAI: { status: 'OPEN', note: '' },  // Amman AMM
  // Lebanon
  OLBA: { status: 'OPEN', note: '' },  // Beirut BEY
  // Israel
  LLBG: { status: 'OPEN', note: '' },  // Tel Aviv TLV
  // Turkey
  LTFM: { status: 'OPEN', note: '' },  // Istanbul IST
  LTAC: { status: 'OPEN', note: '' },  // Ankara ESB
  // Yemen
  OYAA: { status: 'OPEN', note: '' },  // Aden ADE
  OYSN: { status: 'OPEN', note: '' },  // Sanaa SAH
  OYSY: { status: 'OPEN', note: '' },  // Sayun GXF
  OYRN: { status: 'OPEN', note: '' },  // Riyan/Mukalla RIY
  OYMK: { status: 'OPEN', note: '' },  // Mocha
}

// ─── FIR (Flight Information Region) approximate boundaries ─────────────────
// ICAO prefix → FIR key auto-mapping (covers all airports dynamically)

const FIR_PREFIX_MAP = {
  OM: 'UAE', OE: 'SAUDI', OK: 'KUWAIT', OT: 'QATAR', OB: 'BAHRAIN',
  OO: 'OMAN', OR: 'IRAQ', OI: 'IRAN', OJ: 'JORDAN', OL: 'LEBANON',
  LL: 'ISRAEL', LT: 'TURKEY', OY: 'YEMEN', OS: 'SYRIA',
}

export function icaoToFir(icao) {
  if (!icao || icao.length < 2) return null
  return FIR_PREFIX_MAP[icao.slice(0, 2)] || null
}

// Build ICAO_TO_FIR dynamically from any airspace status object
export function buildIcaoToFir(airspaceStatus) {
  const map = {}
  for (const icao of Object.keys(airspaceStatus)) {
    const fir = icaoToFir(icao)
    if (fir) map[icao] = fir
  }
  return map
}

// FIR key → ISO 3166-1 alpha-2 (for Mapbox country boundaries vector tile)
export const FIR_TO_ISO = {
  UAE: 'AE', SAUDI: 'SA', KUWAIT: 'KW', QATAR: 'QA', BAHRAIN: 'BH',
  OMAN: 'OM', IRAQ: 'IQ', IRAN: 'IR', JORDAN: 'JO', LEBANON: 'LB',
  ISRAEL: 'IL', TURKEY: 'TR', YEMEN: 'YE', SYRIA: 'SY',
}

export const FIR_BOUNDARIES = {
  // Sourced from Natural Earth / countriesgeojson — simplified real border polygons [lon, lat]
  UAE: [
    [51.58,24.25],[51.76,24.29],[51.79,24.02],[52.58,24.18],[53.40,24.15],
    [54.01,24.12],[54.69,24.80],[55.44,25.44],[56.07,26.06],[56.26,25.71],
    [56.40,24.92],[55.89,24.92],[55.80,24.27],[55.98,24.13],[55.53,23.93],
    [55.53,23.52],[55.23,23.11],[55.21,22.71],[55.01,22.50],[52.00,23.00],
    [51.62,24.01],[51.58,24.25]
  ],
  SAUDI: [
    [42.78,16.35],[42.27,17.47],[40.94,19.49],[39.14,21.29],[38.49,23.69],
    [37.15,24.86],[36.64,25.83],[35.13,28.06],[34.83,28.96],[36.50,29.51],
    [37.67,30.34],[39.00,32.01],[41.89,31.19],[47.46,29.00],[48.81,27.69],
    [50.15,26.69],[50.24,25.61],[50.81,24.75],[51.58,24.25],[55.01,22.50],
    [55.00,20.00],[48.18,18.17],[46.75,17.28],[45.22,17.43],[43.38,17.58],
    [42.78,16.35]
  ],
  KUWAIT: [
    [47.97,29.98],[48.18,29.53],[48.09,29.31],[48.42,28.55],[47.71,28.53],
    [47.46,29.00],[46.57,29.10],[47.30,30.06],[47.97,29.98]
  ],
  QATAR: [
    [50.81,24.75],[50.74,25.48],[51.01,26.01],[51.29,26.11],[51.59,25.80],
    [51.61,25.22],[51.39,24.63],[51.11,24.56],[50.81,24.75]
  ],
  BAHRAIN: [
    [50.61,25.88],[50.57,25.81],[50.54,25.83],[50.47,25.97],[50.49,26.06],
    [50.45,26.19],[50.47,26.23],[50.56,26.25],[50.59,26.24],[50.56,26.20],
    [50.61,26.12],[50.62,26.00],[50.61,25.88]
  ],
  OMAN: [
    [58.86,21.11],[58.49,20.43],[58.03,20.48],[57.83,20.24],[57.79,19.07],
    [57.23,18.95],[56.51,18.09],[55.66,17.88],[55.27,17.23],[54.79,16.95],
    [53.57,16.71],[53.11,16.65],[52.78,17.35],[52.00,19.00],[55.00,20.00],
    [55.67,22.00],[55.21,22.71],[55.23,23.11],[55.53,23.52],[55.98,24.13],
    [55.89,24.92],[56.40,24.92],[56.85,24.24],[57.40,23.88],[58.14,23.75],
    [58.73,23.57],[59.18,22.99],[59.81,22.53],[59.81,22.31],[59.44,21.71],
    [58.86,21.11]
  ],
  IRAQ: [
    [45.42,35.98],[46.08,35.68],[46.15,35.09],[45.65,34.75],[45.42,33.97],
    [46.11,33.02],[47.33,32.47],[47.85,31.71],[47.69,30.98],[48.00,30.99],
    [48.01,30.45],[48.57,29.93],[47.97,29.98],[47.30,30.06],[46.57,29.10],
    [44.71,29.18],[41.89,31.19],[40.40,31.89],[39.20,32.16],[38.79,33.38],
    [41.01,34.42],[41.38,35.63],[41.29,36.36],[41.84,36.61],[42.35,37.23],
    [42.78,37.39],[43.94,37.26],[44.29,37.00],[44.77,37.17],[45.42,35.98]
  ],
  IRAN: [
    [53.92,37.20],[56.18,37.94],[58.44,37.52],[61.12,36.49],[60.53,33.68],
    [60.86,32.18],[61.78,30.74],[61.77,28.70],[63.23,27.22],[61.50,25.08],
    [57.40,25.74],[55.72,26.96],[52.48,27.58],[50.12,30.15],[48.57,29.93],
    [47.69,30.98],[46.11,33.02],[46.15,35.09],[44.77,37.17],[44.11,39.43],
    [45.46,38.87],[47.69,39.51],[48.01,38.79],[49.20,37.58],[52.26,36.70],
    [53.92,37.20]
  ],
  JORDAN: [
    [35.55,32.39],[35.72,32.71],[36.83,32.31],[38.79,33.38],[39.20,32.16],
    [39.00,32.01],[37.00,31.51],[38.00,30.51],[37.67,30.34],[37.50,30.00],
    [36.74,29.87],[36.50,29.51],[36.07,29.20],[34.96,29.36],[34.92,29.50],
    [35.42,31.10],[35.40,31.49],[35.55,31.78],[35.55,32.39]
  ],
  LEBANON: [
    [35.82,33.28],[35.55,33.26],[35.46,33.09],[35.13,33.09],[35.48,33.91],
    [35.98,34.61],[36.00,34.64],[36.45,34.59],[36.61,34.20],[36.07,33.82],
    [35.82,33.28]
  ],
  ISRAEL: [
    [35.72,32.71],[35.55,32.39],[35.18,32.53],[34.97,31.87],[35.23,31.75],
    [34.97,31.62],[34.93,31.35],[35.40,31.49],[35.42,31.10],[34.92,29.50],
    [34.27,31.22],[34.56,31.55],[34.49,31.61],[34.75,32.07],[34.96,32.83],
    [35.10,33.08],[35.13,33.09],[35.46,33.09],[35.55,33.26],[35.82,33.28],
    [35.84,32.87],[35.70,32.72],[35.72,32.71]
  ],
  TURKEY: [
    [36.91,41.34],[39.51,41.10],[41.55,41.54],[43.58,41.09],[43.66,40.25],
    [44.79,39.71],[44.42,38.28],[44.77,37.17],[43.94,37.26],[42.35,37.23],
    [40.67,37.09],[38.70,36.71],[37.07,36.62],[36.69,36.26],[36.15,35.82],
    [36.16,36.65],[34.71,36.80],[32.51,36.11],[30.62,36.68],[29.70,36.14],
    [27.64,36.66],[26.04,37.97],[26.17,39.46],[27.47,40.32],[28.82,40.96],
    [29.36,41.23],[31.15,41.09],[33.51,42.02],[36.91,41.34]
  ],
  YEMEN: [
    [53.11,16.65],[52.19,15.94],[51.17,15.18],[48.68,14.00],[47.94,14.01],
    [46.72,13.40],[45.63,13.29],[45.04,12.63],[44.49,12.72],[43.48,12.64],
    [43.25,13.77],[42.89,14.80],[42.81,15.26],[42.82,15.91],[43.22,16.67],
    [43.38,17.58],[44.06,17.41],[45.40,17.33],[46.75,17.28],[47.47,17.12],
    [49.12,18.62],[52.78,17.35],[53.11,16.65]
  ],
  SYRIA: [
    [38.79,33.38],[36.83,32.31],[35.72,32.71],[35.70,32.72],[35.84,32.87],
    [35.82,33.28],[36.07,33.82],[36.61,34.20],[36.45,34.59],[36.00,34.64],
    [35.91,35.41],[36.15,35.82],[36.42,36.04],[36.69,36.26],[36.74,36.82],
    [37.07,36.62],[38.17,36.90],[38.70,36.71],[39.52,36.72],[40.67,37.09],
    [41.21,37.07],[42.35,37.23],[41.84,36.61],[41.29,36.36],[41.38,35.63],
    [41.01,34.42],[38.79,33.38]
  ],
}

// Shelter instructions (Korean)
export const SHELTER_GUIDE = [
  '군사시설·정부기관 반경 5km 이내 접근 금지',
  '실내 대피 — 가능하면 지하층 또는 내벽 근처',
  '창문에서 최대한 떨어지고, 커튼/블라인드 닫기',
  '비상식량·물·의약품·여권 비상가방 준비',
  '현지 뉴스 및 대사관 공지 수시 확인',
  '통신 두절 대비: 가족에게 집결장소 사전 공유',
]
