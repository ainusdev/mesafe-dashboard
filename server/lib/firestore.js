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

async function saveFiresToFirestore(fires) {
  if (!db || fires.length === 0) return
  const col = db.collection('fire_hotspots')
  for (let i = 0; i < fires.length; i += 500) {
    const batch = db.batch()
    for (const f of fires.slice(i, i + 500)) {
      const docId = `${f.acqDate}-${String(f.acqTime).padStart(4, '0')}-${f.coords[1].toFixed(3)}-${f.coords[0].toFixed(3)}`
      batch.set(col.doc(docId), f)
    }
    await batch.commit()
  }
  log('Firestore', `${fires.length} hotspots saved`)
}

async function saveAircraftToFirestore(aircraft) {
  if (!db || aircraft.length === 0) return
  const col = db.collection('aircraft_states')
  for (let i = 0; i < aircraft.length; i += 500) {
    const batch = db.batch()
    for (const ac of aircraft.slice(i, i + 500)) {
      batch.set(col.doc(ac.id), { ...ac, updatedAt: Date.now() })
    }
    await batch.commit()
  }
  log('Firestore', `${aircraft.length} aircraft states saved`)
}

module.exports = { initFirestore, saveFiresToFirestore, saveAircraftToFirestore }
