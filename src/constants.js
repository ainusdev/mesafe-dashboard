export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
export const BACKEND_URL  = import.meta.env.DEV
  ? import.meta.env.VITE_BACKEND_DEV_URL
  : import.meta.env.VITE_BACKEND_RELEASE_URL

export const REGIONS = {
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

export const REGION_TZ = {
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

export const REGION_CODE = {
  IRAN: 'IRN', IRAQ: 'IRQ', ISRAEL: 'ISR', JORDAN: 'JOR',
  LEBANON: 'LBN', PALESTINE: 'PSE', SAUDI_ARABIA: 'KSA',
  SYRIA: 'SYR', YEMEN: 'YEM',
}
