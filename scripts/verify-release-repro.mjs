import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  APP_BINARY,
  buildInputManifest,
  diffArtifactSets,
  normalizeVersion,
  packageRelease,
  resolveSourceDateEpoch,
  sha256File,
} from "./package-release.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))

async function artifactDigests(dir) {
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    if (!statSync(abs).isFile()) continue
    entries.push({ path: name, sha256: await sha256File(abs), bytes: statSync(abs).size })
  }
  return entries
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

export async function verifyReleaseReproducible({
  rid,
  version,
  workDir = path.join(root, "release-verify"),
  buildApp = false,
  keep = false,
} = {}) {
  const resolvedVersion = normalizeVersion(version)
  const epoch = resolveSourceDateEpoch()
  const runs = []

  for (const runName of ["run1", "run2"]) {
    if (buildApp) {
      runNode([path.join(root, "scripts", "desktop-build.mjs"), "app", rid])
    }
    const outDir = path.join(workDir, runName)
    rmSync(outDir, { recursive: true, force: true })
    const { artifacts } = await packageRelease({ rid, version: resolvedVersion, outDir })
    runs.push({ name: runName, outDir, artifacts: await artifactDigests(outDir) })
  }

  const diff = diffArtifactSets(runs[0].artifacts, runs[1].artifacts)
  const manifest = await buildInputManifest({ version: resolvedVersion, sourceDateEpoch: epoch })
  const report = {
    format: "nixio-reproducibility-report",
    formatVersion: 1,
    rid,
    appVersion: resolvedVersion,
    sourceDateEpoch: epoch,
    buildApp,
    identical: diff.identical,
    diff,
    inputs: manifest.inputs,
    builders: manifest.builders,
    git: manifest.git,
    runs: runs.map(({ name, artifacts }) => ({ name, artifacts })),
  }

  mkdirSync(workDir, { recursive: true })
  writeFileSync(path.join(workDir, "reproducibility-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")

  for (const run of runs) {
    for (const artifact of run.artifacts) {
      console.log(`${run.name}: ${artifact.path} sha256=${artifact.sha256}`)
    }
  }
  if (!diff.identical) {
    console.error("Reproducibility check FAILED:")
    for (const p of diff.missingInB) console.error(`  missing in run2: ${p}`)
    for (const p of diff.missingInA) console.error(`  missing in run1: ${p}`)
    for (const p of diff.mismatched) console.error(`  digest mismatch: ${p}`)
  } else {
    console.log(`Reproducibility check PASSED: ${runs[0].artifacts.length} artifacts identical across 2 builds`)
  }

  if (!keep) for (const run of runs) rmSync(run.outDir, { recursive: true, force: true })
  return report
}

async function main() {
  const [rid, rawVersion, ...flags] = process.argv.slice(2)
  if (!rid) {
    console.error("Usage: node scripts/verify-release-repro.mjs <linux-x64|win-x64> [version] [--app] [--keep]")
    process.exit(2)
  }
  const platformName = rid.startsWith("win") ? "win32" : "linux"
  const sourceDir = path.join(root, "desktop-dist", `${APP_BINARY}-${platformName}-${rid.split("-")[1]}`)
  const buildApp = flags.includes("--app")
  if (!buildApp && !existsSync(sourceDir)) {
    console.error(`Packaged desktop app not found at ${sourceDir}. Run with --app to build it twice, or run \`npm run desktop:package -- ${rid}\` first.`)
    process.exit(1)
  }
  const version = normalizeVersion(rawVersion || process.env.RELEASE_VERSION)
  const report = await verifyReleaseReproducible({ rid, version, buildApp, keep: flags.includes("--keep") })
  process.exit(report.identical ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error))
    process.exit(1)
  })
}
