const dbName = "khung-thoai-autosave"
const dbVersion = 2
const storeName = "snapshots"
const fontStoreName = "fonts"
const latestKey = "latest"

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(dbName, dbVersion)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName)
        }
        if (!request.result.objectStoreNames.contains(fontStoreName)) {
          request.result.createObjectStore(fontStoreName)
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

export async function saveCustomFont(family, buffer) {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(fontStoreName, "readwrite")
      tx.objectStore(fontStoreName).put({ family, buffer, savedAt: Date.now() }, family)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

export async function listCustomFonts() {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(fontStoreName, "readonly")
      const req = tx.objectStore(fontStoreName).getAll()
      req.onsuccess = () => {
        const items = Array.isArray(req.result) ? req.result : []
        db.close()
        resolve(items.filter((item) => item?.family && item.buffer))
      }
      req.onerror = () => { db.close(); resolve([]) }
    } catch {
      db.close()
      resolve([])
    }
  })
}

export async function deleteCustomFont(family) {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(fontStoreName, "readwrite")
      tx.objectStore(fontStoreName).delete(family)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}
