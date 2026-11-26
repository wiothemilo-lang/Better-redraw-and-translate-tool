import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"
import native from "../desktop/native-worker.cjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "test/fixtures/comic")
const rid = ({ linux: "linux", win32: "win", darwin: "osx" })[process.platform] + "-" + process.arch
export const executable = path.join(root, "native/out", rid, "native-worker", "KhungThoai.Redraw" + (process.platform === "win32" ? ".exe" : ""))

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
  const clean = gunzipSync(await readFile(path.join(fixtures, "clean.rgba.gz")))
  const lettered = gunzipSync(await readFile(path.join(fixtures, "lettered.rgba.gz")))
  const worker = new native.NativeWorker(executable)
  const report = { redraw: [], ocr: [] }
  try {
    for (const item of manifest.cases) {
      const { left, top, right, bottom } = item.rect
      const margin = item.margin ?? 14
      const sx = Math.max(0, left - margin)
      const sy = Math.max(0, top - margin)
      const width = Math.min(manifest.width, right + margin) - sx
      const height = Math.min(manifest.height, bottom + margin) - sy
      const pixels = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++) lettered.copy(pixels, y * width * 4, ((sy + y) * manifest.width + sx) * 4, ((sy + y) * manifest.width + sx + width) * 4)
      const inner = { left: left - sx, top: top - sy, right: right - sx, bottom: bottom - sy }
      const start = performance.now()
      const { data: patch } = await worker.call("redraw", { width, height, inner }, pixels)
      let count = 0, before = 0, after = 0, background = 0, changedBackground = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const at = (y * manifest.width + x) * 4
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
        id: item.id, beforeMae: before / Math.max(1, count * 3), afterMae: after / Math.max(1, count * 3),
        backgroundChangeRate: changedBackground / Math.max(1, background), milliseconds: performance.now() - start,
        maxMae: item.maxMae, conservative: item.conservative ?? false,
      })
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
      report.redraw.some((item) => item.backgroundChangeRate > .005) ||
      report.ocr.some((item) => item.cer !== undefined && item.cer > item.maxCer)) process.exitCode = 1
}
