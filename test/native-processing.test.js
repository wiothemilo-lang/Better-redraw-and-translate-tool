import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import native from "../desktop/native-worker.cjs"
import JSZip from "jszip"

const rid = ({ linux: "linux", win32: "win", darwin: "osx" })[process.platform] + "-" + process.arch
const executable = path.resolve("native/out", rid, "native-worker", "KhungThoai.Redraw" + (process.platform === "win32" ? ".exe" : ""))
const available = existsSync(executable)
const image = (width = 32, height = 32) => ({ width, height, pixels: new Uint8Array(width * height * 4).fill(255) })

test("NativeWorker.redraw returns null safely for null or malformed samples", async (t) => {
  const worker = new native.NativeWorker(executable)
  t.after(() => worker.close())
  assert.equal(await worker.redraw(null), null)
  assert.equal(await worker.redraw(undefined), null)
  assert.equal(await worker.redraw({ pixels: new Uint8Array(4) }), null)
})

test("native protocol rejects invalid operations and data, then continues serving ordered requests", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  t.after(() => worker.close())
  await assert.rejects(worker.call("not-an-operation"), /Unknown/)
  await assert.rejects(worker.call("preprocess", { width: 100, height: 100 }, new Uint8Array(4)), /dimensions/)
  const results = await Promise.all([worker.call("capabilities"), worker.call("preprocess", { width: 2, height: 2, scale: 2 }, image(2, 2).pixels)])
  assert.ok(results[0].result.operations.includes("ocr"))
  assert.equal(results[1].data.length, 4 * 4 * 4)
})

test("native masks preserve strokes, restore pixels and expand or shrink protected areas", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  t.after(() => worker.close())
  const sample = image()
  const stroke = { mode: "erase", size: .3, points: [{ x: .5, y: .5 }] }
  const at = (16 * 32 + 16) * 4 + 3
  const erased = await worker.call("mask", { width: 32, height: 32, strokes: [stroke] }, sample.pixels)
  assert.equal(erased.data[at], 0)
  assert.equal(erased.data[3], 255)
  const shrunk = await worker.call("mask", { width: 32, height: 32, expand: -1 }, sample.pixels)
  assert.equal(shrunk.data[3], 0)
  assert.equal(shrunk.data[at], 255)
  const restored = await worker.call("mask", { width: 32, height: 32, strokes: [stroke, { ...stroke, mode: "restore" }] }, sample.pixels)
  assert.equal(restored.data[at], 255)
  const expanded = await worker.call("mask", { width: 32, height: 32, strokes: [stroke], expand: 3 }, sample.pixels)
  assert.ok(expanded.data[(16 * 32 + 12) * 4 + 3] > erased.data[(16 * 32 + 12) * 4 + 3])
})

test("native project saves are atomic, keep a backup, and cancelled writes preserve the last saved file", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-test-"))
  t.after(async () => { worker.close(); await rm(folder, { recursive: true, force: true }) })
  const target = path.join(folder, "chapter.khungthoai")
  const save = async (content) => {
    const { result } = await worker.call("fileBegin", { path: target, backup: true })
    await worker.call("fileAppend", { id: result.id }, Buffer.from(content))
    await worker.call("fileCommit", { id: result.id })
  }
  await save("first")
  await save("second")
  assert.equal(await readFile(target, "utf8"), "second")
  assert.equal(await readFile(target + ".bak", "utf8"), "first")
  const { result } = await worker.call("fileBegin", { path: target })
  await worker.call("fileAppend", { id: result.id }, Buffer.from("cancelled"))
  await worker.call("fileCancel", { id: result.id })
  assert.equal(await readFile(target, "utf8"), "second")
  assert.equal((await worker.call("fileRead", { path: target, offset: 2 })).data.toString(), "cond")
})

test("native PNG and ZIP combine alpha layers without changing page order", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-zip-"))
  t.after(async () => { worker.close(); await rm(folder, { recursive: true, force: true }) })
  const base = image(2, 2).pixels
  const overlay = new Uint8Array(base.length)
  overlay.set([255, 0, 0, 255], 0)
  const data = Buffer.concat([base, overlay])
  const options = { width: 2, height: 2, patches: [] }
  const png = (await worker.call("png", options, data)).data
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  const target = path.join(folder, "chapter.zip")
  const { result } = await worker.call("zipBegin", { path: target })
  await worker.call("zipPage", { ...options, id: result.id, name: "01.png" }, data)
  await worker.call("zipPage", { ...options, id: result.id, name: "02.png" }, data)
  await worker.call("fileCommit", { id: result.id })
  const zip = await JSZip.loadAsync(await readFile(target))
  assert.deepEqual(Object.keys(zip.files), ["01.png", "02.png"])
  assert.deepEqual(await zip.file("01.png").async("nodebuffer"), png)
})

test("project readers keep a consistent snapshot across an atomic replacement", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-read-"))
  t.after(async () => { worker.close(); await rm(folder, { recursive: true, force: true }) })
  const target = path.join(folder, "chapter.khungthoai")
  const save = async (data) => {
    const { result } = await worker.call("fileBegin", { path: target })
    await worker.call("fileAppend", { id: result.id }, data)
    await worker.call("fileCommit", { id: result.id })
  }
  const old = Buffer.alloc(4 * 1024 * 1024 + 8, 11)
  await save(old)
  const { result } = await worker.call("fileOpen", { path: target })
  const first = await worker.call("fileReadNext", { id: result.id })
  await save(Buffer.alloc(old.length, 22))
  const last = await worker.call("fileReadNext", { id: result.id })
  assert.deepEqual(Buffer.concat([first.data, last.data]), old)
  await worker.call("fileClose", { id: result.id })
})

test("preprocessing rotation preserves source pixel positions and reports rotated dimensions", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  t.after(() => worker.close())
  const data = Buffer.from([0, 50, 100, 150, 200, 255].flatMap((value) => [value, value, value, 255]))
  const base = await worker.call("preprocess", { width: 2, height: 3, scale: 1, denoise: false }, data)
  const rotated = await worker.call("preprocess", { width: 2, height: 3, scale: 1, denoise: false, rotation: 90 }, data)
  assert.equal(rotated.result.width, 3)
  assert.equal(rotated.result.height, 2)
  assert.equal(rotated.data[0], base.data[4 * 4])
  assert.equal(rotated.data[8], base.data[0])
  await assert.rejects(worker.call("preprocess", { width: 2, height: 3, rotation: 45 }, data), /rotation/)
})

test("OCR maps rotated text boxes back into the input image coordinate system", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  t.after(() => worker.close())
  const { result: capabilities } = await worker.call("capabilities")
  if (!capabilities.languages.includes("eng")) return t.skip("English Tesseract language is unavailable")
  const { gunzipSync } = await import("node:zlib")
  const pixels = gunzipSync(await readFile("test/fixtures/comic/english.rgba.gz"))
  const rotated = Buffer.alloc(pixels.length)
  for (let y = 0; y < 220; y++) {
    for (let x = 0; x < 600; x++) pixels.copy(rotated, (x * 220 + 219 - y) * 4, (y * 600 + x) * 4, (y * 600 + x + 1) * 4)
  }
  const { result } = await worker.call("ocr", { width: 220, height: 600, rotation: 270, scale: 1, denoise: false, language: "eng", psm: 6 }, rotated)
  assert.match(result.lines.map(({ text }) => text).join(" "), /HELLO WORLD/)
  const box = result.lines[0].box
  assert.ok((box[2] - box[0]) * 220 < (box[3] - box[1]) * 600)
  assert.ok(box.every((value) => value >= 0 && value <= 1000))
})

test("native client reads fragmented progress and final frames from a coalesced stdout chunk", async () => {
  const worker = new native.NativeWorker(executable)
  const events = []
  const frame = (metadata, bytes = Buffer.alloc(0)) => {
    const json = Buffer.from(JSON.stringify(metadata))
    const header = Buffer.alloc(12)
    header.write("KTR1")
    header.writeUInt32LE(json.length, 4)
    header.writeUInt32LE(bytes.length, 8)
    return Buffer.concat([header, json, bytes])
  }
  const reply = new Promise((resolve, reject) => {
    worker.requestInFlight = {
      header: Buffer.alloc(12), offset: 0, data: null, metadataLength: 0,
      onProgress: (progress, stage) => events.push({ progress, stage }),
      resolve, reject, deadline: setTimeout(() => reject(new Error("Timed out")), 1000),
    }
  })
  const bytes = Buffer.concat([
    frame({ version: 1, event: "progress", progress: 40, stage: "OCR" }),
    frame({ version: 1, ok: true }, Buffer.from([10, 20])),
  ])
  worker.read(bytes.subarray(0, 7))
  worker.read(bytes.subarray(7))
  const result = await reply
  assert.deepEqual(events, [{ progress: 40, stage: "OCR" }])
  assert.deepEqual([...result.data], [10, 20])
})

test("native PatchMatch inpaint reconstructs masked regions with color adaptation and leaves unmasked pixels untouched", { skip: !available }, async (t) => {
  const worker = new native.NativeWorker(executable)
  t.after(() => worker.close())
  const { result: capabilities } = await worker.call("capabilities")
  assert.ok(capabilities.operations.includes("inpaint"))

  const width = 96
  const height = 96
  const clean = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4
      const stripe = ((x + y) % 8) < 4 ? 210 : 120
      clean[off] = Math.min(255, stripe + Math.round(x * .3))
      clean[off + 1] = Math.min(255, stripe + Math.round(y * .2))
      clean[off + 2] = stripe
      clean[off + 3] = 255
    }
  }
  const corrupted = new Uint8Array(clean)
  const mask = new Uint8Array(width * height)
  let holeCount = 0
  for (let y = 38; y < 58; y++) {
    for (let x = 36; x < 60; x++) {
      const idx = y * width + x
      mask[idx] = 255
      holeCount++
      corrupted[idx * 4] = 10
      corrupted[idx * 4 + 1] = 10
      corrupted[idx * 4 + 2] = 10
    }
  }
  const payload = Buffer.concat([corrupted, mask])
  const { result, data } = await worker.call("inpaint", { width, height, patchRadius: 3, colorAdapt: true }, payload)
  assert.equal(result.filled, holeCount)
  assert.equal(data.length, clean.length)

  let outsideDiffs = 0
  let afterErr = 0
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) {
      for (let c = 0; c < 4; c++) if (data[i * 4 + c] !== clean[i * 4 + c]) outsideDiffs++
    } else {
      for (let c = 0; c < 3; c++) afterErr += Math.abs(data[i * 4 + c] - clean[i * 4 + c])
    }
  }
  assert.equal(outsideDiffs, 0)
  const mae = afterErr / (holeCount * 3)
  assert.ok(mae < 25, `Expected low C# PatchMatch MAE, got ${mae}`)
})
