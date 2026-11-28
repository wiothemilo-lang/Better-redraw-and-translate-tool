import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { decodePng } from "../scripts/lib/png.mjs"
import { BASELINE_APPROVAL_ENV, allowedDiffPixels, compareImages, createDiffImage, resolvePlatform, updateRefusal } from "../scripts/lib/visual-diff.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const configPath = path.join(root, "test/visual/config.json")
const config = JSON.parse(await readFile(configPath, "utf8"))

function image(width, height, color = [20, 30, 40, 255]) {
  const data = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) data.set(color, pixel * 4)
  return { width, height, data }
}

test("baseline updates are operator-only and never run in CI", () => {
  assert.equal(updateRefusal({ update: false, env: {} }), null)
  assert.match(updateRefusal({ update: true, env: {} }), new RegExp(BASELINE_APPROVAL_ENV))
  assert.match(updateRefusal({ update: true, env: { [BASELINE_APPROVAL_ENV]: "1", CI: "true" } }), /CI/)
  assert.equal(updateRefusal({ update: true, env: { [BASELINE_APPROVAL_ENV]: "1", CI: "" } }), null)
})

test("visual regression refuses to rewrite baselines without explicit approval", () => {
  const env = { ...process.env }
  delete env.CI
  delete env[BASELINE_APPROVAL_ENV]
  const refused = spawnSync(process.execPath, [path.join(root, "scripts/visual-regression.mjs"), "--update"], {
    cwd: root,
    encoding: "utf8",
    env,
  })
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /Refusing to rewrite visual baselines/)
  assert.doesNotMatch(refused.stdout, /Updated test\/visual\/baselines/)

  const inCi = spawnSync(process.execPath, [path.join(root, "scripts/visual-regression.mjs"), "--update"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, CI: "true", [BASELINE_APPROVAL_ENV]: "1" },
  })
  assert.equal(inCi.status, 1)
  assert.match(inCi.stderr, /Refusing to rewrite visual baselines in CI/)
})

test("only calibrated platforms receive a tolerance", () => {
  assert.equal(resolvePlatform(config, "linux").supported, true)
  const windows = resolvePlatform(config, "win32")
  assert.equal(windows.supported, false)
  assert.equal(resolvePlatform(config, "darwin").supported, false)
  assert.equal(resolvePlatform(config, "linux").channelThreshold, 8)
})

test("comparison ignores sub-threshold noise and fails beyond the allowed pixel count", () => {
  const tolerance = { channelThreshold: 8, maxDiffPixels: 2, maxDiffPixelRatio: 0 }
  assert.deepEqual([resolvePlatform(config, "linux").maxDiffPixels, resolvePlatform(config, "linux").maxDiffPixelRatio], [40, .000039])
  assert.equal(allowedDiffPixels(tolerance, 1000), 2)
  assert.equal(allowedDiffPixels({ maxDiffPixels: 1, maxDiffPixelRatio: .01 }, 1000), 10)

  const baseline = image(20, 20)
  const quiet = image(20, 20, [28, 38, 48, 255])
  const quietResult = compareImages(baseline, quiet, tolerance)
  assert.equal(quietResult.pass, true)
  assert.equal(quietResult.diffPixels, 0)

  const changed = image(20, 20)
  for (const pixel of [5, 9, 13]) changed.data.set([0, 255, 0, 255], pixel * 4)
  const changedResult = compareImages(baseline, changed, tolerance)
  assert.equal(changedResult.pass, false)
  assert.equal(changedResult.diffPixels, 3)
  assert.match(changedResult.reason, /3 pixels differ/)

  const smaller = image(10, 10)
  const dimensionResult = compareImages(baseline, smaller, tolerance)
  assert.equal(dimensionResult.pass, false)
  assert.match(dimensionResult.reason, /dimensions differ/)
})

test("diff images mark changed pixels and stay readable for review", () => {
  const baseline = image(8, 4)
  const actual = image(8, 4)
  actual.data.set([250, 250, 250, 255], (1 * 8 + 2) * 4)
  const diff = decodePng(createDiffImage(baseline, actual, { channelThreshold: 8 }))
  assert.deepEqual([diff.width, diff.height], [8, 4])
  assert.deepEqual([...diff.data.subarray((1 * 8 + 2) * 4, (1 * 8 + 2) * 4 + 4)], [255, 0, 170, 255])
  assert.notDeepEqual([...diff.data.subarray(0, 4)], [255, 0, 170, 255])
})

test("the visual suite covers the editor in both themes and the library", async () => {
  assert.deepEqual(config.views.map(({ name }) => name), ["editor-light", "editor-dark", "library"])
  assert.equal(config.views.find(({ name }) => name === "editor-light").theme, "light")
  assert.equal(config.views.find(({ name }) => name === "editor-dark").theme, "dark")
  const catalog = JSON.parse(await readFile(path.join(root, config.views.find(({ name }) => name === "library").catalog), "utf8"))
  assert.ok(catalog.series.length >= 2)
  for (const series of catalog.series) {
    assert.ok(series.title && series.chapters.length)
    for (const chapter of series.chapters) {
      for (const page of chapter.pages) assert.match(page, /^\/visual-fixtures\/[a-z0-9-]+\.png$/)
    }
  }
  for (const view of config.views) {
    if (!view.image) continue
    assert.ok(existsSync(path.join(root, view.image)), view.name + " image fixture is missing")
  }
  for (const view of config.views) {
    const baseline = decodePng(await readFile(path.join(root, config.baselineDirectory, "linux", view.name + ".png")))
    assert.deepEqual([baseline.width, baseline.height], [config.viewport.width, config.viewport.height])
  }
})

test("CI compares visual baselines only on the canonical Linux environment and uploads diffs", async () => {
  const workflow = await readFile(path.join(root, ".github", "workflows", "verify.yml"), "utf8")
  assert.match(workflow, /npx playwright install --with-deps chromium/)
  assert.match(workflow, /name: Compare visual baselines[\s\S]*?if: runner\.os == 'Linux'[\s\S]*?run: npm run test:visual/)
  assert.match(workflow, /name: visual-diff-\$\{\{ runner\.os \}\}/)
  assert.match(workflow, /path: artifacts\/visual\//)
  assert.match(workflow, /Upload visual diffs[\s\S]*?if: always\(\)/)
  assert.doesNotMatch(workflow, /test:visual:update/)

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(manifest.scripts["test:visual"], "node scripts/visual-regression.mjs")
  assert.equal(manifest.scripts["test:visual:update"], "node scripts/visual-regression.mjs --update")
  assert.equal(manifest.scripts.test, "node --test")
})

test("visual capture pins text and colour rendering so a baseline is comparable across hosts", async () => {
  const script = await readFile(path.join(root, "scripts/visual-regression.mjs"), "utf8")
  // Greyscale text and a fixed colour profile keep glyph antialiasing out of the comparison: a
  // host that draws LCD subpixel text differs on every glyph while layout, image and palette match.
  assert.match(script, /--disable-lcd-text/)
  assert.match(script, /--force-color-profile=srgb/)
  assert.match(script, /args: launchArgs/)
  assert.match(script, /launchArgs,\n\s+viewport: config\.viewport/)
  assert.match(await readFile(path.join(root, "test/visual/README.md"), "utf8"), /--disable-lcd-text/)
})
