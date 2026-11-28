import { spawn, spawnSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { decodePng } from "./lib/png.mjs"
import { BASELINE_APPROVAL_ENV, compareImages, createDiffImage, resolvePlatform, updateRefusal } from "./lib/visual-diff.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const config = JSON.parse(await readFile(path.join(root, "test/visual/config.json"), "utf8"))
const update = process.argv.includes("--update")
const platform = process.platform
const tolerance = resolvePlatform(config, platform)
const base = "http://127.0.0.1:" + (config.port ?? 4173)

const refusal = updateRefusal({ update })
if (refusal) {
  console.error(refusal)
  process.exit(1)
}
if (!tolerance.supported) {
  if (update) {
    console.error(`Refusing to write baselines for ${platform}: only ${Object.keys(config.platforms).join(", ")} is calibrated.`)
    process.exit(1)
  }
  console.log(`Visual baselines are only calibrated for ${Object.keys(config.platforms).join(", ")}; skipping on ${platform}.`)
  process.exit(0)
}

const vite = path.join(root, "node_modules/vite/bin/vite.js")
const build = spawnSync(process.execPath, [vite, "build"], { cwd: root, stdio: "inherit" })
if (build.status !== 0) throw new Error("vite build failed.")

// The library catalog references a same-origin page file, so the built preview must serve one.
const pageImage = config.views.find(({ image }) => image)?.image
if (pageImage) {
  const destination = path.join(root, "dist/visual-fixtures/page-01.png")
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, await readFile(path.join(root, pageImage)))
}

let serverLog = ""
const server = spawn(process.execPath, [vite, "preview", "--host", "127.0.0.1", "--port", String(config.port ?? 4173), "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
})
server.stdout.on("data", (chunk) => { serverLog += chunk })
server.stderr.on("data", (chunk) => { serverLog += chunk })

const deadline = Date.now() + 20000
let ready = false
while (Date.now() < deadline && !ready) {
  if (server.exitCode !== null) throw new Error("vite preview exited early:\n" + serverLog)
  try {
    ready = (await fetch(base + "/")).ok
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
if (!ready) {
  server.kill("SIGTERM")
  throw new Error("Timed out waiting for vite preview:\n" + serverLog)
}

async function capture(browser, view) {
  const context = await browser.newContext({
    viewport: config.viewport,
    deviceScaleFactor: config.deviceScaleFactor ?? 1,
    locale: config.locale,
    timezoneId: config.timezoneId,
    colorScheme: view.theme,
    reducedMotion: "reduce",
  })
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url())
      return url.origin === new URL(base).origin ? route.continue() : route.abort()
    })
    await context.addInitScript((theme) => {
      try { localStorage.setItem("khung-thoai-theme", theme) } catch { /* ignore storage errors */ }
      // Keep autosave and recovery state out of the screenshot: a fresh context already has no
      // snapshot, and this also removes the 20s autosave timer as a variance source on slow runners.
      try { Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true }) } catch { /* ignore */ }
      const style = document.createElement("style")
      style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}"
      document.addEventListener("DOMContentLoaded", () => document.head.append(style), { once: true })
    }, view.theme)
    const page = await context.newPage()
    const pageErrors = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    if (view.page === "library") {
      await page.goto(base + "/#library", { waitUntil: "load" })
      await page.locator("#catalog-file").setInputFiles(path.join(root, view.catalog))
      await page.waitForFunction(() => document.getElementById("library-status").textContent.startsWith("Đã nhập"))
      await page.locator("#catalog-results button").first().click()
      await page.locator("#chapter-select option").first().waitFor({ state: "attached" })
    } else {
      await page.goto(base + "/", { waitUntil: "load" })
      await page.locator("#images").setInputFiles(path.join(root, view.image))
      await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Đã thêm 1 ảnh.")
    }
    await page.evaluate(() => document.fonts.ready.then(() => true))
    await page.evaluate(() => document.activeElement?.blur?.())
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))
    if (pageErrors.length) throw new Error(view.name + " raised page errors: " + pageErrors.join("; "))
    return await page.screenshot({ animations: "disabled", caret: "hide", fullPage: false })
  } finally {
    await context.close()
  }
}

const artifactDirectory = path.join(root, config.artifactDirectory)
const baselineDirectory = path.join(root, config.baselineDirectory, platform)
const entries = []
let failures = 0
let browser
// Text has to rasterize the same way on the machine that captures a baseline and on the one that
// compares against it. Without these, a host whose fontconfig enables LCD subpixel antialiasing
// draws coloured fringes on every glyph and a host without it draws greyscale, so a run on the
// Ubuntu runner differed from a Debian-captured baseline in 35k pixels while every box, image and
// colour matched. Forcing greyscale text and the sRGB profile removes that axis from the comparison.
const launchArgs = ["--disable-lcd-text", "--force-color-profile=srgb"]
try {
  browser = await chromium.launch({
    headless: true,
    // Keep scrollbar geometry identical in headless and desktop captures.
    ignoreDefaultArgs: ["--hide-scrollbars"],
    executablePath: process.env.VISUAL_CHROMIUM_PATH || undefined,
    args: launchArgs,
  })
  await mkdir(artifactDirectory, { recursive: true })
  await rm(path.join(artifactDirectory, "report.json"), { force: true })
  for (const view of config.views) {
    for (const kind of ["actual", "diff"]) {
      await rm(path.join(artifactDirectory, `${view.name}.${kind}.png`), { force: true })
    }
  }
  for (const view of config.views) {
    const screenshot = await capture(browser, view)
    const actual = decodePng(screenshot)
    const baselinePath = path.join(baselineDirectory, view.name + ".png")
    if (update) {
      await mkdir(baselineDirectory, { recursive: true })
      await writeFile(baselinePath, screenshot)
      entries.push({ view: view.name, updated: true, width: actual.width, height: actual.height })
      console.log("Updated " + path.relative(root, baselinePath) + " (" + actual.width + "x" + actual.height + ")")
      continue
    }
    let baseline
    try {
      baseline = decodePng(await readFile(baselinePath))
    } catch {
      throw new Error("Missing or unreadable baseline " + path.relative(root, baselinePath) + ". An operator must run `npm run test:visual:update` with " + BASELINE_APPROVAL_ENV + "=1, review the committed PNG diff, and commit it.")
    }
    const result = compareImages(baseline, actual, tolerance)
    await writeFile(path.join(artifactDirectory, view.name + ".actual.png"), screenshot)
    if (!result.pass) {
      failures++
      await writeFile(path.join(artifactDirectory, view.name + ".diff.png"), createDiffImage(baseline, actual, tolerance))
      console.error("FAIL " + view.name + ": " + result.reason + "; diff: " + path.relative(root, path.join(artifactDirectory, view.name + ".diff.png")))
    } else {
      console.log("PASS " + view.name + ": " + result.diffPixels + " differing pixels (allowed " + result.allowedDiffPixels + " at ±" + result.channelThreshold + ")")
    }
    entries.push({ view: view.name, ...result, baseline: path.relative(root, baselinePath) })
  }
  await writeFile(path.join(artifactDirectory, "report.json"), JSON.stringify({
    platform,
    browser: browser.version(),
    launchArgs,
    viewport: config.viewport,
    deviceScaleFactor: config.deviceScaleFactor ?? 1,
    update,
    passed: failures === 0,
    tolerance: { channelThreshold: tolerance.channelThreshold, maxDiffPixels: tolerance.maxDiffPixels, maxDiffPixelRatio: tolerance.maxDiffPixelRatio },
    views: entries,
  }, null, 2) + "\n")
  if (update) {
    console.log("Baselines written. Review the PNG diff before committing:\n  git diff --stat -- " + config.baselineDirectory + "\n  git diff -- " + config.baselineDirectory)
  }
} finally {
  await browser?.close().catch(() => {})
  server.kill("SIGTERM")
}

if (failures) {
  console.error(failures + " visual view(s) differ from the committed baselines.")
  process.exitCode = 1
}
