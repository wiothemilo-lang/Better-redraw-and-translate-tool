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
const executablePath = packaged ? path.join(root, "desktop-dist", "Khung-Thoai-" + process.platform + "-" + process.arch, "Khung-Thoai" + (process.platform === "win32" ? ".exe" : "")) : require("electron")
const directory = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-smoke-"))
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const args = ["--no-sandbox", "--disable-gpu", "--user-data-dir=" + directory]
if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless")
if (!packaged) args.push(root)
const app = await _electron.launch({ executablePath, args, env: environment, timeout: 30000 })
const errors = []
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
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => errors.push(error.message))
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
  const zipPath = path.join(directory, "chapter.zip")
  await waitForArtifact(async () => {
    const info = await stat(zipPath).catch(() => null)
    return info?.size > 0
  }, "atomic ZIP commit")
  const zip = await JSZip.loadAsync(await readFile(zipPath))
  assert.deepEqual(Object.keys(zip.files), ["01-01.png"])
  await page.locator("#box-text").fill("Recover this latest edit")
  await page.locator("#box-form button[type=submit]").click()
  // The timer makes a project-specific snapshot, then the library opens it through the normal path.
  await page.locator("#autosave-status").filter({ hasText: "Đã tự lưu lúc" }).waitFor({ timeout: 30000 })
  await page.reload()
  await page.locator("#recover-project").waitFor({ state: "visible" })
  await page.locator("#recent-projects-button").click()
  await page.locator("#project-library").waitFor({ state: "visible" })
  assert.match(await page.locator("#recent-projects").textContent(), /Khôi phục/)
  await page.locator("#recent-projects button").filter({ hasText: "Khôi phục" }).first().click()
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
} finally { await app.close() }
