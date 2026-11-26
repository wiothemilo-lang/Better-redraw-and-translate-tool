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

test("NativeWorker.redraw returns null safely for null or malformed samples", async () => {
  const worker = new native.NativeWorker(executable)
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
