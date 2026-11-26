import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { benchmark, executable, characterErrorRate } from "../scripts/benchmark.mjs"

test("comic fixtures preserve artwork and restore annotated clean lettering regions", { skip: !existsSync(executable) }, async () => {
  const report = await benchmark()
  for (const item of report.redraw) {
    if (item.maxMae !== undefined) assert.ok(item.afterMae <= item.maxMae, JSON.stringify(item))
    assert.ok(item.backgroundChangeRate <= .005, JSON.stringify(item))
  }
  for (const item of report.ocr) {
    if (!item.unavailable) assert.ok(item.cer <= item.maxCer, JSON.stringify(item))
  }
})
test("OCR character error handles Unicode and whitespace", () => {
  assert.equal(characterErrorRate("こんにちは", "こ んにちは"), 0)
  assert.equal(characterErrorRate("abc", "axc"), 1 / 3)
})
