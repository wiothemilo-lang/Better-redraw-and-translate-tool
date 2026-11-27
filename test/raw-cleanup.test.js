import assert from "node:assert/strict"
import test from "node:test"

const width = 8
const height = 8
const pixels = new Uint8ClampedArray(width * height * 4).fill(255)

function installCanvas(t) {
  const original = { document: globalThis.document, ImageData: globalThis.ImageData, Worker: globalThis.Worker }
  t.after(() => {
    globalThis.document = original.document
    globalThis.ImageData = original.ImageData
    globalThis.Worker = original.Worker
  })
  globalThis.ImageData = class {
    constructor(data, w, h) {
      this.data = data
      this.width = w
      this.height = h
    }
  }
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0 }
      const context = {
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
        putImageData() {},
      }
      canvas.getContext = () => context
      canvas.toBlob = (callback) => callback(new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" }))
      return canvas
    },
  }
}

function installWorker(t, { reply = false } = {}) {
  const workers = []
  globalThis.Worker = class {
    constructor() {
      this.listeners = new Map()
      this.messages = []
      this.terminated = false
      workers.push(this)
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler)
    }
    postMessage(message) {
      this.messages.push(message)
      if (reply) this.listeners.get("message")?.({ data: { id: message.id, ok: true, data: message.rgba } })
    }
    terminate() {
      this.terminated = true
    }
    emit(type) {
      this.listeners.get(type)?.({ data: null })
    }
  }
  return workers
}

test("a worker message that cannot be deserialized settles the raw cleanup instead of hanging it", async (t) => {
  installCanvas(t)
  const workers = installWorker(t, { reply: false })
  const { cleanRawPageImage } = await import("../src/raw-cleanup.js")

  const page = { name: "01.png", image: { naturalWidth: width, naturalHeight: height } }
  let settled = null
  const run = cleanRawPageImage(page).then((result) => {
    settled = result
    return result
  })

  // The worker reports a message it could not deserialize and never answers the request.
  await Promise.resolve()
  workers[0].emit("messageerror")
  const result = await run
  assert.ok(settled, "the cleanup has to finish")
  // It falls back to the synchronous implementation and still produces the cleaned page.
  assert.equal(result.engine, "js")
  assert.ok(result.file instanceof File)
  assert.equal(workers[0].terminated, true, "the broken worker is dropped")
})

test("a worker that never answers is abandoned after the watchdog expires", async (t) => {
  installCanvas(t)
  const workers = installWorker(t, { reply: false })
  const { runCleanRawInWebWorker } = await import("../src/raw-cleanup.js")

  const started = Date.now()
  const value = await runCleanRawInWebWorker(new Uint8ClampedArray(pixels), width, height, {}, 20)
  assert.equal(value, null, "a wedged request resolves to the JS fallback")
  assert.ok(Date.now() - started < 2000)
  assert.equal(workers[0].terminated, true)

  // The next request starts from a fresh worker rather than queueing behind the dead one.
  const next = runCleanRawInWebWorker(new Uint8ClampedArray(pixels), width, height, {}, 20)
  await next
  assert.equal(workers.length, 2)
})
