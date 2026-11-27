import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
export const controllerDirectory = "src/controllers"

// Measured with `npm run test:coverage` on Node 22.23.3 after the controller
// tests landed: the suite covers 27.10% of the executable lines in
// src/controllers/. The floor sits two points below that so refactors have room
// but dropping controller tests, or adding a controller that no test loads,
// fails CI instead of silently shrinking the report.
export const CONTROLLER_LINE_FLOOR = 25

// fileURLToPath refuses a POSIX-style file URL on Windows ("File URL path must be absolute"),
// and a coverage report can be produced anywhere, so the pathname is the fallback there.
function fromFileUrl(value) {
  try {
    return fileURLToPath(value)
  } catch {
    return decodeURIComponent(new URL(value).pathname)
  }
}

export function normalizeSourcePath(file, rootDirectory = root) {
  const absolute = file.startsWith("file://") ? fromFileUrl(file) : file
  const normalized = absolute.replaceAll("\\", "/")
  const rootPrefix = rootDirectory.replaceAll("\\", "/").replace(/\/+$/, "") + "/"
  const relative = normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : normalized
  return relative.replace(/^(\.\/)+/, "")
}

export function parseLcov(source, rootDirectory = root) {
  const records = new Map()
  let current
  for (const rawLine of source.split(/\r?\n/)) {
    const separator = rawLine.indexOf(":")
    const tag = separator < 0 ? rawLine : rawLine.slice(0, separator)
    const value = separator < 0 ? "" : rawLine.slice(separator + 1)
    if (tag === "SF") {
      current = { file: normalizeSourcePath(value, rootDirectory), lines: new Map() }
      records.set(current.file, current)
      continue
    }
    if (tag === "DA" && current) {
      const [line, hits] = value.split(",")
      current.lines.set(Number(line), Number(hits))
      continue
    }
    if (tag === "end_of_record") current = undefined
  }
  return records
}

export function summarizeControllers(records, controllerFiles) {
  const files = []
  const missing = []
  let linesFound = 0
  let linesHit = 0
  for (const file of controllerFiles) {
    const record = records.get(file)
    if (!record) {
      missing.push(file)
      files.push({ file, found: 0, hit: 0, percentage: 0 })
      continue
    }
    const found = record.lines.size
    const hit = [...record.lines.values()].filter((count) => count > 0).length
    linesFound += found
    linesHit += hit
    files.push({ file, found, hit, percentage: found ? (hit / found) * 100 : 100 })
  }
  return {
    files,
    missing,
    linesFound,
    linesHit,
    percentage: linesFound ? (linesHit / linesFound) * 100 : 0,
  }
}

export function checkControllerCoverage({ lcov, controllerFiles, floor = CONTROLLER_LINE_FLOOR, rootDirectory = root }) {
  const summary = summarizeControllers(parseLcov(lcov, rootDirectory), controllerFiles)
  const failures = []
  for (const file of summary.missing) {
    failures.push(
      `${file} is missing from the coverage report. Import and exercise it from a test so controller coverage measures the module.`,
    )
  }
  if (!summary.linesFound) {
    failures.push("The coverage report contains no executable lines from src/controllers/.")
  } else if (summary.percentage < floor) {
    failures.push(
      `Controller line coverage ${summary.percentage.toFixed(2)}% is below the ${floor}% floor ` +
        `(${summary.linesHit}/${summary.linesFound} lines).`,
    )
  }
  return { ok: failures.length === 0, failures, summary }
}

export async function listControllerFiles(rootDirectory = root) {
  const directory = path.join(rootDirectory, controllerDirectory)
  const entries = await readdir(directory)
  return entries
    .filter((entry) => entry.endsWith(".js"))
    .sort()
    .map((entry) => `${controllerDirectory}/${entry}`)
}

export function formatReport({ summary, floor }) {
  const width = Math.max(...summary.files.map((item) => item.file.length), 10)
  const lines = summary.files.map((item) => {
    const percentage = item.found ? `${item.percentage.toFixed(2)}%` : "not measured"
    return `  ${item.file.padEnd(width)}  ${String(item.hit).padStart(5)}/${String(item.found).padEnd(5)}  ${percentage}`
  })
  const total = summary.linesFound ? `${summary.percentage.toFixed(2)}%` : "not measured"
  lines.push(`  ${"total".padEnd(width)}  ${String(summary.linesHit).padStart(5)}/${String(summary.linesFound).padEnd(5)}  ${total}  (floor ${floor}%)`)
  return lines.join("\n")
}

async function main() {
  const lcovPath = process.argv[2] ?? path.join(root, "artifacts", "coverage", "lcov.info")
  const lcov = await readFile(lcovPath, "utf8")
  const result = checkControllerCoverage({ lcov, controllerFiles: await listControllerFiles() })
  console.log(`Controller coverage from ${path.relative(root, lcovPath)}:`)
  console.log(formatReport({ summary: result.summary, floor: CONTROLLER_LINE_FLOOR }))
  for (const failure of result.failures) console.error(`\nCoverage gate failed: ${failure}`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
