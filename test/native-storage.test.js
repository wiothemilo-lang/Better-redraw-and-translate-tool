import assert from "node:assert/strict"
import test from "node:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import native from "../desktop/native-worker.cjs"
import { nativeWorker } from "../scripts/native-worker.mjs"
import JSZip from "jszip"

/*
 * Project storage failure paths (issues #49 and #51).
 *
 * The worker must never publish a page it has not composed and validated, and it must never
 * publish an incomplete archive over a valid destination. Commit publishes the primary first
 * and the staged backup second, so a failure at any step has an observable, non-destructive
 * outcome:
 *   invalid page          rejected before the archive and the page count change
 *   write error           transfer marked damaged, commit refused, destination untouched
 *   damaged temporary     commit verification refused, destination untouched
 *   staging error         existing primary and `.bak` untouched
 *   primary publish error existing primary and `.bak` untouched, temporary removed
 *   backup publish error  primary published, older `.bak` preserved, reply `backup: "kept"`
 *
 * Failure injection uses only controlled filesystem conditions. POSIX can unlink a file the
 * worker still holds open, which makes the reopen and the atomic replacement fail exactly
 * where the real error would. A second worker runs through a `ulimit -f` wrapper so a real
 * page write fails with EFBIG mid-archive; the same wrapper fails a project write on Linux,
 * while Darwin accepts that append under the limit and the project case skips there. Windows
 * denies both, so those cases skip there.
 */

const { available, executable } = nativeWorker()
const unavailable = !available && "Native worker is not built; run `npm run desktop:native`."
const posixOnly = process.platform === "win32" && "Windows cannot unlink a file the worker holds open."
const shellOnly = process.platform === "win32" && "The injection needs a POSIX shell file-size limit."
const notLinux = process.platform !== "linux" && "Only Linux reports this file-size limit at the project append; Darwin accepts the write there."
const notRoot = process.getuid?.() === 0 && "A root user can read a file without permissions."

const sample = async (worker) => (await worker.call("png", { width: 2, height: 2, patches: [] },
  Buffer.concat([Buffer.alloc(16, 255), Buffer.alloc(16)]))).data
const temporaryNames = async (directory) => (await readdir(directory)).filter((name) => name.endsWith(".tmp") || name.endsWith(".tmp.bak"))
const pngHeader = Buffer.from("89504e470d0a1a0a", "hex")

test("native ZIP rejects invalid pages before the archive changes and publishes no empty entry", { skip: unavailable }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-zip-invalid-"))
  t.after(async () => { worker.close(); await rm(directory, { recursive: true, force: true }) })
  const page = await sample(worker)
  const target = path.join(directory, "chapter.zip")
  const { result } = await worker.call("zipBegin", { path: target })
  for (const name of ["01.jpg", "../01.png", "pages\\01.png", "01.png.txt"])
    await assert.rejects(worker.call("zipAppend", { id: result.id, name }, page), /Invalid ZIP page name/)
  for (const name of ["01.png", "02.png"]) {
    await assert.rejects(worker.call("zipAppend", { id: result.id, name }, Buffer.from("not a png image")), /Invalid PNG page/)
    await assert.rejects(worker.call("zipPage", { id: result.id, name, width: 2, height: 2 }, Buffer.from([1, 2, 3, 4])), /Missing image layers/)
  }
  assert.equal((await worker.call("fileCommit", { id: result.id })).result.backup, "none")
  const zip = await JSZip.loadAsync(await readFile(target))
  assert.deepEqual(Object.keys(zip.files), [])
  assert.deepEqual(await readdir(directory), ["chapter.zip"])
  await assert.rejects(worker.call("fileCommit", { id: result.id }), /Unknown transfer/)
})

test("native ZIP page limit counts written pages and keeps accepting valid pages on the same transfer", { skip: unavailable }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-zip-limit-"))
  t.after(async () => { worker.close(); await rm(directory, { recursive: true, force: true }) })
  const page = await sample(worker)
  const target = path.join(directory, "chapter.zip")
  const { result } = await worker.call("zipBegin", { path: target })
  for (let attempt = 0; attempt < 3; attempt += 1)
    await assert.rejects(worker.call("zipAppend", { id: result.id, name: "00.png" }, Buffer.from("not a png image")), /Invalid PNG page/)
  for (let index = 1; index <= 50; index += 1) await worker.call("zipAppend", { id: result.id, name: `${index}.png` }, page)
  await assert.rejects(worker.call("zipAppend", { id: result.id, name: "51.png" }, page), /Invalid ZIP page count/)
  await worker.call("fileCommit", { id: result.id })
  const zip = await JSZip.loadAsync(await readFile(target))
  assert.deepEqual(Object.keys(zip.files), Array.from({ length: 50 }, (unused, index) => `${index + 1}.png`))
  for (const name of Object.keys(zip.files)) assert.equal((await zip.file(name).async("nodebuffer")).length, page.length)
  assert.deepEqual(await readdir(directory), ["chapter.zip"])
})

test("a real archive write failure blocks commit and preserves the previous archive", { skip: unavailable || shellOnly }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-write-damage-"))
  const wrapper = path.join(directory, "limited-worker.sh")
  // The limit has to sit well above what the runtime itself needs, or the runtime aborts with
  // "Out of memory" before the write under test happens (4 MiB was enough to do that). 32 MiB
  // leaves that headroom and still refuses a 64 MiB page.
  await writeFile(wrapper, `#!/bin/sh\ntrap '' XFSZ\nulimit -f 65536\nexec "${executable}" "$@"\n`)
  await chmod(wrapper, 0o755)
  const limited = new native.NativeWorker(wrapper)
  t.after(async () => { worker.close(); limited.close(); await rm(directory, { recursive: true, force: true }) })
  // The runtime needs file budget of its own; a machine whose runtime needs more than the limit
  // cannot run the injection, so it reports a skip instead of a failure.
  if (!await limited.call("preprocess", { width: 2, height: 2, scale: 1 }, Buffer.alloc(16, 128)).then(() => true, () => false))
    return t.skip("The native worker needs more than the 32 MiB file size limit to start.")
  const target = path.join(directory, "chapter.zip")
  const { result } = await worker.call("zipBegin", { path: target })
  await worker.call("zipAppend", { id: result.id, name: "01.png" }, pngHeader)
  await worker.call("fileCommit", { id: result.id })
  const original = await readFile(target)
  const transfer = await limited.call("zipBegin", { path: target })
  await assert.rejects(
    limited.call("zipAppend", { id: transfer.result.id, name: "02.png" }, Buffer.concat([pngHeader, Buffer.alloc(64 * 1024 * 1024)])),
    /Could not write the ZIP page/,
  )
  await assert.rejects(limited.call("fileCommit", { id: transfer.result.id }), /temporary archive is incomplete/)
  assert.deepEqual(await readFile(target), original)
  const retry = await limited.call("zipBegin", { path: path.join(directory, "retry.zip") })
  await limited.call("zipAppend", { id: retry.result.id, name: "01.png" }, pngHeader)
  await limited.call("fileCommit", { id: retry.result.id })
  assert.deepEqual(await temporaryNames(directory), [])
  assert.deepEqual((await readdir(directory)).sort(), ["chapter.zip", "limited-worker.sh", "retry.zip"])
})

test("a real project write failure blocks commit and preserves the previous project", { skip: unavailable || shellOnly || notLinux }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-project-damage-"))
  const wrapper = path.join(directory, "limited-worker.sh")
  // Same 32 MiB limit as the archive case, and the same reason it sits far above what the
  // runtime needs of its own budget. Here the project write fails at the append, so no publish
  // is reached and the previous project has to survive untouched.
  await writeFile(wrapper, `#!/bin/sh\ntrap '' XFSZ\nulimit -f 65536\nexec "${executable}" "$@"\n`)
  await chmod(wrapper, 0o755)
  const limited = new native.NativeWorker(wrapper)
  t.after(async () => { limited.close(); await rm(directory, { recursive: true, force: true }) })
  if (!await limited.call("preprocess", { width: 2, height: 2, scale: 1 }, Buffer.alloc(16, 128)).then(() => true, () => false))
    return t.skip("The native worker needs more than the 32 MiB file size limit to start.")
  const project = path.join(directory, "chapter.khungthoai")
  const first = await limited.call("fileBegin", { path: project, backup: true })
  await limited.call("fileAppend", { id: first.result.id }, Buffer.from("valid project"))
  await limited.call("fileCommit", { id: first.result.id })
  const saved = await readFile(project)
  const damaged = await limited.call("fileBegin", { path: project, backup: true })
  await assert.rejects(limited.call("fileAppend", { id: damaged.result.id }, Buffer.alloc(64 * 1024 * 1024)), /Could not write the project file/)
  await assert.rejects(limited.call("fileCommit", { id: damaged.result.id }), /temporary file is incomplete/)
  assert.deepEqual(await readFile(project), saved)
  assert.deepEqual(await temporaryNames(directory), [])
  assert.deepEqual((await readdir(directory)).sort(), ["chapter.khungthoai", "limited-worker.sh"])
})

test("a damaged temporary archive never replaces a valid destination", { skip: unavailable || posixOnly }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-zip-swap-"))
  t.after(async () => { worker.close(); await rm(directory, { recursive: true, force: true }) })
  const page = await sample(worker)
  const target = path.join(directory, "chapter.zip")
  const first = await worker.call("zipBegin", { path: target })
  await worker.call("zipAppend", { id: first.result.id, name: "01.png" }, page)
  await worker.call("fileCommit", { id: first.result.id })
  const original = await readFile(target)
  const second = await worker.call("zipBegin", { path: target })
  await worker.call("zipAppend", { id: second.result.id, name: "02.png" }, page)
  const [temporary] = await temporaryNames(directory)
  await unlink(path.join(directory, temporary))
  await writeFile(path.join(directory, temporary), "not an archive")
  await assert.rejects(worker.call("fileCommit", { id: second.result.id }), /temporary archive is incomplete/)
  assert.deepEqual(await readFile(target), original)
  const zip = await JSZip.loadAsync(original)
  assert.deepEqual(Object.keys(zip.files), ["01.png"])
  assert.deepEqual(await readdir(directory), ["chapter.zip"])
})

test("a failed primary replacement keeps the previous backup and the previous project", { skip: unavailable || posixOnly }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-commit-primary-"))
  t.after(async () => { worker.close(); await rm(directory, { recursive: true, force: true }) })
  const target = path.join(directory, "chapter.khungthoai")
  const save = async (content, backup = true) => {
    const { result } = await worker.call("fileBegin", { path: target, backup })
    await worker.call("fileAppend", { id: result.id }, Buffer.from(content))
    return (await worker.call("fileCommit", { id: result.id })).result
  }
  assert.equal((await save("first")).backup, "none")
  assert.equal((await save("second")).backup, "written")
  assert.equal(await readFile(target + ".bak", "utf8"), "first")
  const { result } = await worker.call("fileBegin", { path: target, backup: true })
  await worker.call("fileAppend", { id: result.id }, Buffer.from("third"))
  const [temporary] = await temporaryNames(directory)
  await unlink(path.join(directory, temporary))
  await assert.rejects(worker.call("fileCommit", { id: result.id }), /Could not replace the destination file/)
  assert.equal(await readFile(target, "utf8"), "second")
  assert.equal(await readFile(target + ".bak", "utf8"), "first")
  assert.equal((await save("fourth")).backup, "written")
  assert.equal(await readFile(target, "utf8"), "fourth")
  assert.equal(await readFile(target + ".bak", "utf8"), "second")
  assert.deepEqual(await temporaryNames(directory), [])
})

test("a failed backup publication still publishes the primary and keeps the older backup", { skip: unavailable }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-commit-backup-"))
  t.after(async () => { worker.close(); await rm(directory, { recursive: true, force: true }) })
  const target = path.join(directory, "chapter.khungthoai")
  const save = async (content, backup = true) => {
    const { result } = await worker.call("fileBegin", { path: target, backup })
    await worker.call("fileAppend", { id: result.id }, Buffer.from(content))
    return (await worker.call("fileCommit", { id: result.id })).result
  }
  await save("first")
  await save("second")
  await rm(target + ".bak")
  await mkdir(path.join(target + ".bak", "keep"), { recursive: true })
  await writeFile(path.join(target + ".bak", "keep", "older.txt"), "older")
  assert.equal((await save("third")).backup, "kept")
  assert.equal(await readFile(target, "utf8"), "third")
  assert.equal(await readFile(path.join(target + ".bak", "keep", "older.txt"), "utf8"), "older")
  assert.equal((await save("fourth", false)).backup, "none")
  assert.equal(await readFile(target, "utf8"), "fourth")
  assert.equal(await readFile(path.join(target + ".bak", "keep", "older.txt"), "utf8"), "older")
  assert.deepEqual(await temporaryNames(directory), [])
})

test("a failed backup staging leaves the primary and the previous backup untouched", { skip: unavailable || posixOnly || notRoot }, async (t) => {
  const worker = new native.NativeWorker(executable)
  const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-commit-stage-"))
  t.after(async () => { worker.close(); await rm(directory, { recursive: true, force: true }) })
  const target = path.join(directory, "chapter.khungthoai")
  const save = async (content) => {
    const { result } = await worker.call("fileBegin", { path: target, backup: true })
    await worker.call("fileAppend", { id: result.id }, Buffer.from(content))
    return worker.call("fileCommit", { id: result.id })
  }
  await save("first")
  await save("second")
  await chmod(target, 0o000)
  const { result } = await worker.call("fileBegin", { path: target, backup: true })
  await worker.call("fileAppend", { id: result.id }, Buffer.from("third"))
  await assert.rejects(worker.call("fileCommit", { id: result.id }), /Could not prepare the backup copy/)
  await chmod(target, 0o644)
  assert.equal(await readFile(target, "utf8"), "second")
  assert.equal(await readFile(target + ".bak", "utf8"), "first")
  assert.deepEqual(await temporaryNames(directory), [])
  await save("fourth")
  assert.equal(await readFile(target, "utf8"), "fourth")
  assert.equal(await readFile(target + ".bak", "utf8"), "second")
})
