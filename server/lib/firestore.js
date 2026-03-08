const { log } = require('./logger')

let db = null

function initFirestore() {
  try {
    const admin = require('firebase-admin')
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT
      let credential
      if (raw) {
        try {
          credential = admin.credential.cert(JSON.parse(raw))
          log('Firestore', 'Using service account from env var')
        } catch {
          const fs = require('fs')
          const json = JSON.parse(fs.readFileSync(raw, 'utf8'))
          credential = admin.credential.cert(json)
          log('Firestore', `Using service account from file: ${raw}`)
        }
      } else {
        credential = admin.credential.applicationDefault()
        log('Firestore', 'Using Application Default Credentials')
      }
      admin.initializeApp({ credential, projectId: 'conflict-safety-dashboard' })
    }
    db = admin.firestore()
    log('Firestore', 'Connected to conflict-safety-dashboard')
  } catch (err) {
    log('Firestore', `Init failed — data will not be persisted: ${err.message}`, 'warn')
  }
}

// ─── Aircraft — 단일 latest 문서 (덮어쓰기) ──────────────────────────────────
// aircraft_snapshots/latest : { aircraft: [...], savedAt, count }

async function saveAircraftToFirestore(aircraft) {
  if (!db || aircraft.length === 0) return
  await db.collection('aircraft_snapshots').doc('latest').set({
    aircraft, savedAt: Date.now(), count: aircraft.length,
  })
  log('Firestore', `${aircraft.length} aircraft saved → aircraft_snapshots/latest`)
}

async function loadAircraftFromFirestore() {
  if (!db) return []
  const doc = await db.collection('aircraft_snapshots').doc('latest').get()
  if (!doc.exists) return []
  const { aircraft } = doc.data()
  const result = Array.isArray(aircraft) ? aircraft.filter(ac => ac.lat && ac.lon) : []
  log('Firestore', `Loaded ${result.length} aircraft`)
  return result
}

// ─── Fires — 폴 단위 스냅샷, 24h 보관 ────────────────────────────────────────
// fire_snapshots/{ts} : { fires: [...], savedAt, count }

async function saveFiresToFirestore(fires) {
  if (!db || fires.length === 0) return
  const savedAt = Date.now()
  const ts      = new Date(savedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const CHUNK   = 500  // Firestore 문서 1MB 한도 대비
  for (let i = 0; i < fires.length; i += CHUNK) {
    const chunk = fires.slice(i, i + CHUNK)
    const id    = fires.length > CHUNK ? `${ts}_${String(i).padStart(5, '0')}` : ts
    await db.collection('fire_snapshots').doc(id).set({ fires: chunk, savedAt, count: chunk.length })
  }
  log('Firestore', `${fires.length} hotspots saved → fire_snapshots/${ts}`)
}

async function loadFiresFromFirestore() {
  if (!db) return []
  const cutoff = Date.now() - 24 * 3600 * 1000
  const snap   = await db.collection('fire_snapshots')
    .where('savedAt', '>=', cutoff)
    .get()
  const seen = new Map()
  for (const doc of snap.docs) {
    const { fires } = doc.data()
    if (Array.isArray(fires)) {
      for (const f of fires) { if (f.id) seen.set(f.id, f) }
    }
  }
  const result = [...seen.values()]
  log('Firestore', `Loaded ${result.length} hotspots from ${snap.size} snapshots (last 24h)`)
  return result
}

// ─── Airports — 단일 latest 문서 (덮어쓰기) ──────────────────────────────────
// airport_snapshots/latest : { airports: [...], savedAt, count }

async function saveAirportsToFirestore(airports) {
  if (!db || airports.length === 0) return
  await db.collection('airport_snapshots').doc('latest').set({
    airports, savedAt: Date.now(), count: airports.length,
  })
  log('Firestore', `${airports.length} airports saved → airport_snapshots/latest`)
}

async function loadAirportsFromFirestore() {
  if (!db) return []
  const doc = await db.collection('airport_snapshots').doc('latest').get()
  if (!doc.exists) return []
  const { airports } = doc.data()
  const result = Array.isArray(airports) ? airports : []
  log('Firestore', `Loaded ${result.length} airports`)
  return result
}

// ─── Migration: fire_hotspots → fire_snapshots (1회, 구 데이터 손실 없이) ────

async function migrateFireHotspotsToSnapshots() {
  if (!db) return
  const check = await db.collection('fire_hotspots').limit(1).get()
  if (check.empty) {
    log('Firestore', 'fire_hotspots empty — migration skipped')
    return
  }
  const fullSnap = await db.collection('fire_hotspots').get()
  const fires    = fullSnap.docs.map(d => d.data())
  const savedAt  = Date.now()
  const ts       = new Date(savedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const CHUNK    = 500
  for (let i = 0; i < fires.length; i += CHUNK) {
    const chunk = fires.slice(i, i + CHUNK)
    const id    = fires.length > CHUNK ? `migrated_${ts}_${String(i).padStart(5, '0')}` : `migrated_${ts}`
    await db.collection('fire_snapshots').doc(id).set({ fires: chunk, savedAt, count: chunk.length })
  }
  log('Firestore', `Migration complete — ${fires.length} hotspots → fire_snapshots`)
}

module.exports = {
  initFirestore, migrateFireHotspotsToSnapshots,
  saveAircraftToFirestore, saveFiresToFirestore, saveAirportsToFirestore,
  loadAircraftFromFirestore, loadFiresFromFirestore, loadAirportsFromFirestore,
}
