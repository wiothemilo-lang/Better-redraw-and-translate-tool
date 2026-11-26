const dbName = "khung-thoai-autosave"
const storeName = "snapshots"
const latestKey = "latest"

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function saveWebSnapshot(blob, meta = {}) {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite")
      tx.objectStore(storeName).put({
        blob,
        name: meta.name || "phien-web.khungthoai",
        pageCount: meta.pageCount ?? 0,
        savedAt: Date.now(),
        size: blob.size,
      }, latestKey)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

export async function getWebSnapshotInfo() {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readonly")
      const req = tx.objectStore(storeName).get(latestKey)
      req.onsuccess = () => {
        const record = req.result
        db.close()
        if (!record?.blob) return resolve(null)
        resolve({ name: record.name, pageCount: record.pageCount, savedAt: record.savedAt, size: record.size })
      }
      req.onerror = () => { db.close(); resolve(null) }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

export async function loadWebSnapshot() {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readonly")
      const req = tx.objectStore(storeName).get(latestKey)
      req.onsuccess = () => {
        const record = req.result
        db.close()
        if (!record?.blob) return resolve(null)
        resolve(new File([record.blob], record.name || "phien-web.khungthoai", { type: "application/octet-stream" }))
      }
      req.onerror = () => { db.close(); resolve(null) }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

export async function clearWebSnapshot() {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite")
      tx.objectStore(storeName).delete(latestKey)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}
