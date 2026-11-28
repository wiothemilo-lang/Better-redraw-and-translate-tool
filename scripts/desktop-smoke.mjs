import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import { _electron } from "playwright"
import JSZip from "jszip"

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, "..")
const packaged = process.argv.includes("--packaged")
// @electron/packager wraps the macOS build in a bundle; Linux and Windows run the binary directly.
function packagedExecutable() {
  const bundle = path.join(root, "desktop-dist", "Nixio-" + process.platform + "-" + process.arch)
  if (process.platform === "darwin") return path.join(bundle, "Nixio.app", "Contents", "MacOS", "Nixio")
  return path.join(bundle, "Nixio" + (process.platform === "win32" ? ".exe" : ""))
}
const executablePath = packaged ? packagedExecutable() : require("electron")
const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-smoke-"))
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const args = ["--no-sandbox", "--disable-gpu", "--user-data-dir=" + directory]
if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless")
if (!packaged) args.push(root)
const app = await _electron.launch({ executablePath, args, env: environment, timeout: 30000 })
const errors = []
// The renderer evaluates its entry script while the window is being created, so a listener attached
// after firstWindow() resolves would miss exactly the startup exception this test exists to catch.
app.on("window", (window) => {
  window.on("pageerror", (error) => errors.push(error.message))
})
let page
async function waitForArtifact(read, description) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for " + description)
}
// Playwright's waitForFunction treats a promise-returning predicate as already truthy, so an async
// projectList() call returns the pending promise instead of polling it. Poll from Node instead.
async function waitForFreshAutosave(before, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await page.evaluate(async (previous) => {
      const projects = await window.khungThoaiDesktop.projectList()
      const project = projects.find((item) => item.id === previous.projectId) ?? projects[0]
      return {
        snapshotId: project?.snapshots?.[0]?.id ?? null,
        status: document.getElementById("autosave-status").textContent,
      }
    }, before)
    if (
      state.snapshotId &&
      state.snapshotId !== before.snapshotId &&
      state.status.includes("Đã tự lưu lúc") &&
      state.status !== before.status
    ) return state.snapshotId
    await page.waitForTimeout(100)
  }
  throw new Error("Timed out waiting for a newer autosave snapshot")
}

// Playwright bounds locators and navigation but not app.evaluate or a page.evaluate that awaits the
// app, so one stuck call could hold the job until its own timeout with no output. The watchdog turns
// that into a bounded failure, and the teardown below owns the successful exit.
const watchdog = setTimeout(() => {
  console.error("The desktop smoke test did not finish in time; see artifacts/desktop-failure.json.")
  process.exit(1)
}, Number(process.env.DESKTOP_SMOKE_TIMEOUT_MS ?? 6 * 60 * 1000))
watchdog.unref()
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await app.evaluate(({ dialog, session }, directory) => {
    globalThis.downloads = []
    dialog.showSaveDialog = async (_window, options) => ({
      canceled: false, filePath: directory + "/" + (options.filters[0].extensions[0] === "zip" ? "chapter.zip" : "chapter.khungthoai"),
    })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory + "/chapter.khungthoai"] })
    session.defaultSession.on("will-download", (_event, item) => {
      item.setSavePath(directory + "/" + item.getFilename())
      item.on("done", () => globalThis.downloads.push(item.getSavePath()))
    })
  }, directory)
  await page.waitForFunction(() => document.getElementById("native-status").textContent.includes("sẵn sàng"))
  const png = await readFile(path.join(root, "test/fixtures/comic/english.png"))
  await page.locator("#images").setInputFiles({ name: "01.png", mimeType: "image/png", buffer: png })
  await page.getByText("Đã thêm 1 ảnh.").waitFor()
  await page.locator("#local-ocr-language").selectOption("eng")
  await page.locator("#local-ocr-layout").selectOption("6")
  await page.locator("#run-local-ocr").click()
  await page.locator("#ocr-review").waitFor({ state: "visible" })
  assert.match(await page.locator("#ocr-review-lines textarea").first().inputValue(), /HELLO WORLD/)
  await page.locator("#ocr-review-lines textarea").first().fill("Reviewed dialogue")
  await page.locator("#apply-ocr").click()
  assert.match(await page.locator("#boxes").textContent(), /Reviewed dialogue/)
  await page.locator("#boxes button").first().click()
  assert.match(await page.locator("#project-dirty").textContent(), /Còn thay đổi/)
  await page.locator("#save-project").click()
  await page.getByText("Đã lưu dự án vào máy.").waitFor()
  assert.match(await page.locator("#project-dirty").textContent(), /Đã lưu/)
  assert.ok((await stat(path.join(directory, "chapter.khungthoai"))).size > 100)
  // Cancellation affects only the isolated image task, then the renderer can run another task.
  const cancelled = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    window.khungThoaiDesktop.onTask((task) => {
      if (task.id === id && task.state === "running") window.khungThoaiDesktop.cancelTask(id)
    })
    try {
      await window.khungThoaiDesktop.native("preprocess", { width: 2000, height: 2000, scale: 1 }, new Uint8Array(2000 * 2000 * 4).fill(255), id)
      return false
    } catch (error) { return error.message.includes("hủy") }
  })
  assert.equal(cancelled, true)
  await page.locator("[data-export=png]").click()
  if (await page.locator("#preflight-dialog").isVisible()) await page.locator("#continue-export").click()
  await page.getByText("Đã tạo tệp xuất.").waitFor()
  const output = await waitForArtifact(() => app.evaluate(() => globalThis.downloads[0]), "PNG download completion")
  assert.equal((await readFile(output)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  await page.locator("#export-all").click()
  await page.locator("#zip-dialog button[value=export]").click()
  if (await page.locator("#preflight-dialog").isVisible()) await page.locator("#continue-export").click()
  await page.getByText("Đã tạo tệp xuất.").waitFor()
  const zipPath = await waitForArtifact(
    () => app.evaluate(() => globalThis.downloads[1] ?? null),
    "profile ZIP download",
  )
  assert.match(zipPath, /nixio-goc\.zip$/)
  const zip = await JSZip.loadAsync(await readFile(zipPath))
  assert.deepEqual(Object.keys(zip.files), ["01-01.png", "manifest.json"])
  // The status line still names the previous heartbeat's save, so its text is only meaningful
  // together with a snapshot id that is newer than the one captured just before this edit.
  const beforeAutosave = await page.evaluate(async () => {
    const [project] = await window.khungThoaiDesktop.projectList()
    return {
      projectId: project?.id ?? null,
      snapshotId: project?.snapshots?.[0]?.id ?? null,
      status: document.getElementById("autosave-status").textContent,
    }
  })
  await page.locator("#box-text").fill("Recover this latest edit")
  await page.locator("#box-form button[type=submit]").click()
  const snapshotId = await waitForFreshAutosave(beforeAutosave)
  await page.reload()
  await page.locator("#recover-project").waitFor({ state: "visible" })
  await page.locator("#recent-projects-button").click()
  await page.locator("#project-library").waitFor({ state: "visible" })
  // Opening the dialog is not the same as filling it: showLibrary awaits projectList(), and the
  // previous render can stay in the DOM long enough to answer a text assertion with stale rows.
  const restore = page.locator(`#recent-projects button[data-snapshot-id="${snapshotId}"]`)
  await restore.waitFor({ state: "visible" })
  assert.match(await restore.textContent(), /^Khôi phục /)
  const restoreButtons = page.locator("#recent-projects button[data-snapshot-id]")
  assert.equal(await restoreButtons.first().getAttribute("data-snapshot-id"), snapshotId)
  await restore.click()
  await page.getByText("Đã mở dự án với 1 trang.").waitFor()
  assert.match(await page.locator("#boxes").textContent(), /Recover this latest edit/)
  assert.match(await page.locator("#project-dirty").textContent(), /Còn thay đổi/)
  assert.deepEqual(errors, [])
  await mkdir(path.join(root, "artifacts"), { recursive: true })
  await writeFile(path.join(root, "artifacts/desktop-smoke.json"), JSON.stringify({ platform: process.platform, packaged, passed: true }, null, 2))
  console.log((packaged ? "Packaged" : "Source") + " desktop workflow passed on " + process.platform)
} catch (error) {
  const artifacts = path.join(root, "artifacts")
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, "desktop-failure.json"), JSON.stringify({
    message: error.message,
    status: page ? await page.locator("#status").textContent().catch(() => null) : null,
    pageErrors: errors,
  }, null, 2))
  if (page) await page.screenshot({ path: path.join(artifacts, "desktop-failure.png"), timeout: 3000 }).catch(() => {})
  throw error
} finally {
  // On macOS the app keeps running after a successful run — closing the last window does not quit
  // there — so a green artifact was written while the step itself stayed alive until the job
  // timeout. The close is bounded and the child is killed if quitting did not happen.
  const application = app.process()
  const closed = await Promise.race([
    app.close().then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
  ])
  if (!closed || application.exitCode === null) application.kill("SIGKILL")
  clearTimeout(watchdog)
}
// Nothing follows the smoke, and a surviving Electron child keeps this process alive, so the
// successful exit is explicit instead of left to the event loop draining.
await new Promise((resolve) => process.stdout.write("", resolve))
process.exit(0)
