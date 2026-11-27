import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"
import native from "../desktop/native-worker.cjs"
import { executable } from "./native-worker.mjs"

export { executable }

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "test/fixtures/comic")

export function characterErrorRate(expected, actual) {
  const a = [...expected.replace(/\s/g, "")]
  const b = [...actual.replace(/\s/g, "")]
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = row
  }
  return previous[b.length] / Math.max(1, a.length)
}

export async function benchmark() {
  if (!existsSync(executable)) throw new Error("Build the native worker before running the benchmark.")
  const manifest = JSON.parse(await readFile(path.join(fixtures, "manifest.json"), "utf8"))
  const maxBackgroundChangeRate = manifest.thresholds?.maxBackgroundChangeRate ?? .005
  const worker = new native.NativeWorker(executable)
  const report = { redraw: [], ocr: [] }
  try {
    for (const pair of manifest.pairs) {
      const clean = gunzipSync(await readFile(path.join(fixtures, pair.cleanPixels)))
      const lettered = gunzipSync(await readFile(path.join(fixtures, pair.letteredPixels)))
      const expectedPixels = pair.width * pair.height * 4
      if (clean.length !== expectedPixels || lettered.length !== expectedPixels) {
        throw new Error(`Fixture ${pair.id} pixel dumps must match ${pair.width}x${pair.height}.`)
      }
      for (const item of pair.cases) {
        const { left, top, right, bottom } = item.rect
        const margin = item.margin ?? 14
        const sx = Math.max(0, left - margin)
        const sy = Math.max(0, top - margin)
        const width = Math.min(pair.width, right + margin) - sx
        const height = Math.min(pair.height, bottom + margin) - sy
        const pixels = Buffer.alloc(width * height * 4)
        for (let y = 0; y < height; y++) lettered.copy(pixels, y * width * 4, ((sy + y) * pair.width + sx) * 4, ((sy + y) * pair.width + sx + width) * 4)
        const inner = { left: left - sx, top: top - sy, right: right - sx, bottom: bottom - sy }
        const start = performance.now()
        const { data: patch } = await worker.call("redraw", { width, height, inner }, pixels)
        // Only the native call is timed. The pixel comparison below scales with the rect area, so
        // counting it as latency made big regions look slower than small ones on the same worker.
        const milliseconds = performance.now() - start
        let count = 0, before = 0, after = 0, background = 0, changedBackground = 0
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const at = (y * pair.width + x) * 4
            const out = ((y - top) * (right - left) + x - left) * 4
            const isLetter = [0, 1, 2].some((channel) => Math.abs(clean[at + channel] - lettered[at + channel]) > 2)
            const alpha = (patch[out + 3] ?? 0) / 255
            const value = (channel) => Math.round((patch[out + channel] ?? 0) * alpha + lettered[at + channel] * (1 - alpha))
            if (isLetter) {
              count++
              for (let c = 0; c < 3; c++) {
                before += Math.abs(clean[at + c] - lettered[at + c])
                after += Math.abs(clean[at + c] - value(c))
              }
            } else {
              background++
              if ([0, 1, 2].some((c) => Math.abs(value(c) - lettered[at + c]) > 2)) changedBackground++
            }
          }
        }
        report.redraw.push({
          pair: pair.id, id: item.id, beforeMae: before / Math.max(1, count * 3), afterMae: after / Math.max(1, count * 3),
          backgroundChangeRate: changedBackground / Math.max(1, background), milliseconds,
          maxMae: item.maxMae, maxBackgroundChangeRate, conservative: item.conservative ?? false,
        })
      }
    }
    const { result: capabilities } = await worker.call("capabilities")
    for (const fixture of manifest.ocr) {
      if (!capabilities.languages.includes(fixture.language)) {
        report.ocr.push({ id: fixture.id, unavailable: fixture.language })
        continue
      }
      const pixels = gunzipSync(await readFile(path.join(fixtures, fixture.id + ".rgba.gz")))
      const { result } = await worker.call("ocr", { ...fixture, scale: 2, denoise: true }, pixels)
      const actual = result.lines.map(({ text }) => text).join("")
      report.ocr.push({ id: fixture.id, actual, expected: fixture.text, cer: characterErrorRate(fixture.text, actual), maxCer: fixture.maxCer })
    }
    return report
  } finally { worker.close() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await benchmark()
  const index = process.argv.indexOf("--output")
  if (index >= 0) {
    const target = process.argv[index + 1]
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(report, null, 2) + "\n")
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.redraw.some((item) => item.maxMae !== undefined && item.afterMae > item.maxMae) ||
      report.redraw.some((item) => item.backgroundChangeRate > item.maxBackgroundChangeRate) ||
      report.ocr.some((item) => item.cer !== undefined && item.cer > item.maxCer)) process.exitCode = 1
}
