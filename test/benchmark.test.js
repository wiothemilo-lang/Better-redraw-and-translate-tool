import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { benchmark, benchmarkRegressions, characterErrorRate } from "../scripts/benchmark.mjs"
import { nativeWorker } from "../scripts/native-worker.mjs"
import { decodePng } from "../scripts/lib/png.mjs"

const { available } = nativeWorker()
const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "test/fixtures/comic")

test("comic fixtures preserve artwork and restore annotated clean lettering regions", { skip: !available }, async () => {
  const report = await benchmark()
  for (const item of report.redraw) {
    if (item.maxMae !== undefined) assert.ok(item.afterMae <= item.maxMae, JSON.stringify(item))
    assert.ok(item.backgroundChangeRate <= item.maxBackgroundChangeRate, JSON.stringify(item))
  }
  for (const item of report.ocr) {
    if (!item.unavailable) assert.ok(item.cer <= item.maxCer, JSON.stringify(item))
  }
})

test("the ground-truth manifest covers screentone and gradient with explained thresholds", async () => {
  const manifest = JSON.parse(await readFile(path.join(fixtures, "manifest.json"), "utf8"))
  assert.equal(manifest.version, 2)
  assert.ok(manifest.thresholds.maxMaeNote.length > 80)
  assert.ok(manifest.thresholds.backgroundChangeNote.length > 80)
  assert.equal(manifest.thresholds.maxBackgroundChangeRate, .005)

  const ids = manifest.pairs.map(({ id }) => id)
  assert.deepEqual(ids, ["greenhouse", "screentone", "gradient"])
  for (const pair of manifest.pairs) {
    assert.ok(pair.provenance.length > 40, pair.id + " needs documented provenance")
    assert.ok(pair.redistribution.length > 20, pair.id + " needs documented redistribution terms")
    assert.ok(Number.isInteger(pair.width) && Number.isInteger(pair.height))
    for (const file of [pair.clean, pair.cleanPixels, pair.lettered, pair.letteredPixels]) {
      assert.ok(existsSync(path.join(fixtures, file)), pair.id + " is missing " + file)
    }
    const png = decodePng(await readFile(path.join(fixtures, pair.clean)))
    assert.deepEqual([png.width, png.height], [pair.width, pair.height])
    assert.ok(pair.cases.length > 0)
    for (const item of pair.cases) {
      assert.ok(!item.conservative || item.maxMae === undefined, pair.id + "/" + item.id)
      if (item.conservative) {
        assert.ok(Number.isFinite(item.maxImprovement) && item.maxImprovement >= 0,
          pair.id + "/" + item.id + " needs a maxImprovement so a guessed patch cannot pass")
      } else {
        assert.ok(item.maxMae > 0 && item.maxMae <= 8, pair.id + "/" + item.id + " needs a measured maxMae")
      }
      const { left, top, right, bottom } = item.rect
      assert.ok(left >= 0 && top >= 0 && right <= pair.width && bottom <= pair.height, pair.id + "/" + item.id + " rect is outside the page")
      assert.ok(right > left && bottom > top)
      assert.ok(Array.isArray(item.text) && item.text.length)
      assert.ok((item.margin ?? 14) > 0)
    }
  }
  for (const pair of manifest.pairs.filter(({ id }) => id !== "greenhouse")) {
    assert.ok(pair.thresholdDerivation.length > 80, pair.id + " needs a threshold derivation note")
  }
})

test("the synthetic fixtures are reproducible from their generator", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/generate-comic-fixtures.mjs"), "--check"], {
    cwd: root,
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Committed fixtures match the generator output/)
})

test("OCR character error handles Unicode and whitespace", () => {
  assert.equal(characterErrorRate("こんにちは", "こ んにちは"), 0)
  assert.equal(characterErrorRate("abc", "axc"), 1 / 3)
})

// Regression for #147: conservative cases have no maxMae, so the old gate never looked at them and a
// worker that guessed on a hard background could improve the error without failing CI.
test("a conservative case fails when the worker guesses instead of deferring", () => {
  const redraw = (overrides = {}) => ({
    pair: "greenhouse",
    id: "irregular-jacket",
    beforeMae: 40,
    afterMae: 40,
    maxMae: undefined,
    maxImprovement: 0.5,
    backgroundChangeRate: 0,
    maxBackgroundChangeRate: 0.005,
    conservative: true,
    ...overrides,
  })
  const report = (overrides = {}) => ({ redraw: [redraw(overrides)], ocr: [] })

  assert.deepEqual(benchmarkRegressions(report()), [])
  assert.equal(benchmarkRegressions(report({ afterMae: 39.6 })).length, 0, "sub-threshold noise still defers")
  assert.match(benchmarkRegressions(report({ afterMae: 12 })).join("\n"), /conservative case changed lettering MAE by 28\.000/)
  assert.match(benchmarkRegressions(report({ afterMae: 45 })).join("\n"), /changed lettering MAE by 5\.000/)
  assert.match(benchmarkRegressions(report({ maxImprovement: undefined })).join("\n"), /needs maxImprovement/)
  assert.match(benchmarkRegressions(report({ backgroundChangeRate: 0.01 })).join("\n"), /background change/)

  const graded = { redraw: [redraw({ conservative: false, maxMae: 4, maxImprovement: undefined, afterMae: 5 })], ocr: [] }
  assert.match(benchmarkRegressions(graded).join("\n"), /lettering MAE 5 > 4/)
  const ocr = { redraw: [], ocr: [{ id: "english", cer: 0.2, maxCer: 0.15 }] }
  assert.match(benchmarkRegressions(ocr).join("\n"), /OCR CER 0\.2 > 0\.15/)
})

test("the redraw benchmark times only the native call, not the pixel comparison", async () => {
  // The comparison loop walks the rect pixel by pixel; counting it as latency made large regions
  // look slower on the same worker and skewed the trend in artifacts/benchmark.json.
  // The script cannot be launched from a test (it needs the Electron renderer and a native worker),
  // so this pins the one expression that decides what is timed. It is a spelling test on purpose:
  // renaming the variable means updating this line too.
  const source = await readFile(path.join(root, "scripts/benchmark.mjs"), "utf8")
  const call = source.indexOf('await worker.call("redraw"')
  const stop = source.indexOf("const milliseconds = performance.now() - start")
  const analysis = source.indexOf("for (let y = top; y < bottom; y++)")
  assert.ok(call > 0 && stop > 0 && analysis > 0)
  assert.ok(stop > call, "the stopwatch has to stop after the worker answers")
  assert.ok(stop < analysis, "and before the pixel comparison starts")
  assert.match(source, /milliseconds,/)
  assert.doesNotMatch(source, /milliseconds: performance\.now\(\) - start/)
})
