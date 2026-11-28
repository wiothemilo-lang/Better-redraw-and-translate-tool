import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeRequired, nativeSkip, nativeWorker } from "../scripts/native-worker.mjs"
import {
  CONTROLLER_LINE_FLOOR,
  checkControllerCoverage,
  listControllerFiles,
  parseLcov,
} from "../scripts/check-controller-coverage.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const controllers = ["src/controllers/chat.js", "src/controllers/tasks.js"]

function lcov(records) {
  return records
    .map(([file, hits]) =>
      ["TN:", `SF:${file}`, ...hits.map((hit, index) => `DA:${index + 1},${hit}`), "end_of_record"].join("\n"),
    )
    .join("\n") + "\n"
}

test("REQUIRE_NATIVE accepts explicit truthy values only", () => {
  assert.equal(nativeRequired({ REQUIRE_NATIVE: "1" }), true)
  assert.equal(nativeRequired({ REQUIRE_NATIVE: "true" }), true)
  assert.equal(nativeRequired({ REQUIRE_NATIVE: "yes" }), true)
  assert.equal(nativeRequired({ REQUIRE_NATIVE: "0" }), false)
  assert.equal(nativeRequired({ REQUIRE_NATIVE: "off" }), false)
  assert.equal(nativeRequired({}), false)
})

test("nativeWorker skips locally and throws when CI requires a missing worker", () => {
  const missing = path.join(os.tmpdir(), "khung-thoai-missing-native-worker")
  assert.deepEqual(nativeWorker({ env: {}, file: missing }), { executable: missing, available: false })
  assert.throws(
    () => nativeWorker({ env: { REQUIRE_NATIVE: "1" }, file: missing }),
    /Native worker is required \(REQUIRE_NATIVE=1\) but missing/,
  )
})

test("nativeSkip only skips when strict native runs are not required", () => {
  const skipped = []
  nativeSkip({ skip: (reason) => skipped.push(reason) }, "English Tesseract language is unavailable", {})
  assert.deepEqual(skipped, ["English Tesseract language is unavailable"])
  assert.throws(
    () => nativeSkip({ skip() {} }, "English Tesseract language is unavailable", { REQUIRE_NATIVE: "1" }),
    /REQUIRE_NATIVE=1 forbids skipping native tests/,
  )
})

test("parseLcov keys absolute Windows and POSIX paths by their repository-relative name", () => {
  const windows = parseLcov(lcov([["C:\\repo\\src\\controllers\\chat.js", [1, 0]]]), "C:\\repo")
  assert.deepEqual([...windows.get("src/controllers/chat.js").lines], [[1, 1], [2, 0]])

  const posix = parseLcov(lcov([["/build/nixio/src/controllers/tasks.js", [1]]]), "/build/nixio")
  assert.equal(posix.get("src/controllers/tasks.js").lines.get(1), 1)

  const url = parseLcov(lcov([["file:///build/nixio/src/controllers/ocr.js", [1]]]), "/build/nixio")
  assert.equal(url.get("src/controllers/ocr.js").lines.get(1), 1)
})

test("controller coverage passes above the floor and fails below it", () => {
  const passing = checkControllerCoverage({
    lcov: lcov([[controllers[0], [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]], [controllers[1], [1, 1]]]),
    controllerFiles: controllers,
    floor: 50,
  })
  assert.equal(passing.ok, true)
  assert.equal(passing.summary.linesHit, 10)
  assert.equal(passing.summary.linesFound, 12)
  assert.equal(passing.summary.percentage.toFixed(2), "83.33")

  const failing = checkControllerCoverage({
    lcov: lcov([[controllers[0], [0, 0, 0, 1]], [controllers[1], [0]]]),
    controllerFiles: controllers,
    floor: 50,
  })
  assert.equal(failing.ok, false)
  assert.match(failing.failures.join("\n"), /Controller line coverage 20\.00% is below the 50% floor \(1\/5 lines\)/)
})

test("a controller below its own floor fails even when the aggregate is high", () => {
  // 90/90 lines in chat.js and 3/10 in tasks.js: 84.5% aggregate, so only a per-file rule notices.
  const result = checkControllerCoverage({
    lcov: lcov([
      [controllers[0], Array.from({ length: 90 }, () => 1)],
      [controllers[1], [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]],
    ]),
    controllerFiles: controllers,
    floor: 25,
    fileFloor: 50,
  })
  assert.ok(result.summary.percentage > 50)
  assert.equal(result.ok, false)
  assert.match(
    result.failures.join("\n"),
    /src\/controllers\/tasks\.js line coverage 30\.00% is below the 50% per-file floor \(3\/10 lines\)/,
  )
})

test("a controller module missing from the report fails the coverage gate", () => {
  const result = checkControllerCoverage({
    lcov: lcov([[controllers[0], [1]]]),
    controllerFiles: controllers,
    floor: 0,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.summary.missing, [controllers[1]])
  assert.match(result.failures.join("\n"), /src\/controllers\/tasks\.js is missing from the coverage report/)
})

test("the coverage gate CLI exits non-zero when controllers fall under the floor", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-coverage-"))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const files = await listControllerFiles()
  assert.ok(files.length >= 8)
  const script = path.join(root, "scripts", "check-controller-coverage.mjs")

  const failingFile = path.join(folder, "failing.info")
  await writeFile(failingFile, lcov(files.map((file) => [file, [0, 0, 0, 0]])))
  const failing = spawnSync(process.execPath, [script, failingFile], { cwd: root, encoding: "utf8" })
  assert.equal(failing.status, 1, failing.stderr)
  assert.match(failing.stderr, /Coverage gate failed: Controller line coverage 0\.00% is below the 25% floor/)
  assert.match(failing.stdout, /src\/controllers\/chat\.js/)

  const passingFile = path.join(folder, "passing.info")
  await writeFile(passingFile, lcov(files.map((file) => [file, [1, 1, 1, 1]])))
  const passing = spawnSync(process.execPath, [script, passingFile], { cwd: root, encoding: "utf8" })
  assert.equal(passing.status, 0, passing.stderr)
  assert.match(passing.stdout, /\(floor 25%\)/)
})

test("CI runs, enforces, and uploads coverage for every verify job", async () => {
  const workflow = await readFile(path.join(root, ".github", "workflows", "verify.yml"), "utf8")
  assert.match(workflow, /REQUIRE_NATIVE: "1"/)
  assert.match(workflow, /run: npm run test:coverage/)
  assert.match(workflow, /name: coverage-\$\{\{ runner\.os \}\}/)
  assert.match(workflow, /path: artifacts\/coverage\//)
  assert.match(workflow, /Upload coverage report[\s\S]*?if: always\(\)/)
  assert.match(workflow, /name: verification-\$\{\{ runner\.os \}\}/)

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(manifest.scripts["test:coverage"], "node scripts/coverage.mjs")
  assert.ok(CONTROLLER_LINE_FLOOR > 0)
})
