import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildInputManifest,
  buildRpmSpec,
  buildTarArgs,
  diffArtifactSets,
  normalizeSourceDateEpoch,
  normalizeTreeTimestamps,
  packageRelease,
  resolveSourceDateEpoch,
  sha256File,
} from "../scripts/package-release.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const EPOCH = 1700000000
// The portable .tar.gz is a Linux artifact: it is built with GNU tar, and the checks below inspect
// it through GNU stat and a POSIX shell. Skipping elsewhere is honest about where the pipeline runs.
const gnuTools = process.platform === "linux" ? undefined : "The .tar.gz pipeline needs GNU tar and GNU stat."

test("normalizeSourceDateEpoch accepts positive integers and rejects junk", () => {
  assert.equal(normalizeSourceDateEpoch("1700000000"), EPOCH)
  assert.equal(normalizeSourceDateEpoch(EPOCH), EPOCH)
  assert.throws(() => normalizeSourceDateEpoch("0"))
  assert.throws(() => normalizeSourceDateEpoch("-5"))
  assert.throws(() => normalizeSourceDateEpoch("not-a-number"))
  assert.throws(() => normalizeSourceDateEpoch(1.5))
})

test("resolveSourceDateEpoch prefers SOURCE_DATE_EPOCH and falls back to git HEAD time", () => {
  assert.equal(resolveSourceDateEpoch({ env: { SOURCE_DATE_EPOCH: "1700000000" }, rootDir: "/nonexistent" }), EPOCH)
  const fallback = resolveSourceDateEpoch({ env: {}, rootDir: root })
  assert.ok(Number.isInteger(fallback) && fallback > 0)
  assert.throws(() => resolveSourceDateEpoch({ env: {}, rootDir: "/nonexistent" }), /SOURCE_DATE_EPOCH/)
})

test("normalizeTreeTimestamps pins every file, directory and symlink to the epoch", { skip: gnuTools }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nixio-mtime-"))
  t.after(() => spawnSync("rm", ["-rf", dir]))
  mkdirSync(path.join(dir, "sub", "deep"), { recursive: true })
  writeFileSync(path.join(dir, "sub", "deep", "a.bin"), "alpha")
  writeFileSync(path.join(dir, "b.txt"), "beta")
  symlinkSync("../b.txt", path.join(dir, "sub", "link"))
  const stale = new Date(1000000000 * 1000)
  utimesSync(path.join(dir, "sub", "deep", "a.bin"), stale, stale)

  normalizeTreeTimestamps(dir, EPOCH)

  for (const rel of ["", "sub", path.join("sub", "deep"), path.join("sub", "deep", "a.bin"), "b.txt", path.join("sub", "link")]) {
    const stat = spawnSync("stat", ["-c", "%Y", path.join(dir, rel)], { encoding: "utf8" })
    assert.equal(Number(stat.stdout.trim()), EPOCH, `${rel} mtime`)
  }
})

test("buildTarArgs produces sorted, owner-normalised, epoch-pinned tar arguments", () => {
  const args = buildTarArgs({
    archivePath: "/out/app.tar",
    stageDir: "/stage",
    folderName: "nixio-1.0.0-linux-x64",
    epochSeconds: EPOCH,
  })
  assert.deepEqual(args.slice(-3), ["-C", "/stage", "nixio-1.0.0-linux-x64"])
  for (const flag of ["--sort=name", "--dereference", `--mtime=@${EPOCH}`, "--owner=0", "--group=0", "--numeric-owner"]) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
  assert.throws(() => buildTarArgs({ archivePath: "a", stageDir: "s", folderName: "f", epochSeconds: "x" }))
})

function packTarball(stageDir, folderName, epoch) {
  const archive = path.join(stageDir, "app.tar")
  const packed = spawnSync("tar", buildTarArgs({ archivePath: archive, stageDir, folderName, epochSeconds: epoch }), { encoding: "utf8" })
  assert.equal(packed.status, 0, packed.stderr)
  const gz = spawnSync("gzip", ["-n", "-f", archive], { encoding: "utf8" })
  assert.equal(gz.status, 0, gz.stderr)
  return archive + ".gz"
}

test("two tar.gz builds from identical trees with different mtimes are byte-identical", { skip: gnuTools }, (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "nixio-tar-"))
  t.after(() => spawnSync("rm", ["-rf", base]))
  const digests = []
  for (const run of ["a", "b"]) {
    const payload = path.join(base, run, "payload")
    mkdirSync(path.join(payload, "zdir"), { recursive: true })
    writeFileSync(path.join(payload, "zdir", "z-last.txt"), "z")
    writeFileSync(path.join(payload, "a-first.txt"), "a")
    mkdirSync(path.join(payload, "adir"))
    writeFileSync(path.join(payload, "adir", "m.bin"), "m")
    const stage = path.join(base, run, "stage")
    mkdirSync(stage)
    symlinkSync(payload, path.join(stage, "nixio-1.0.0-linux-x64"))
    // Give run "b" different mtimes and creation order to prove they are normalised.
    if (run === "b") {
      for (const rel of ["a-first.txt", "zdir/z-last.txt", "adir/m.bin", "zdir", "adir"]) {
        utimesSync(path.join(payload, rel), new Date(500000000 * 1000), new Date(500000000 * 1000))
      }
    }
    digests.push(sha256FileSync(packTarball(stage, "nixio-1.0.0-linux-x64", EPOCH)))
  }
  assert.equal(digests[0], digests[1])
})

function sha256FileSync(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

test("buildInputManifest records sorted input digests, builders and epoch", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nixio-manifest-"))
  t.after(() => spawnSync("rm", ["-rf", dir]))
  mkdirSync(path.join(dir, "native"), { recursive: true })
  mkdirSync(path.join(dir, "scripts"), { recursive: true })
  writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"9.9.9"}')
  writeFileSync(path.join(dir, "package-lock.json"), "{}")
  writeFileSync(path.join(dir, "native", "KhungThoai.Redraw.csproj"), "<Project />")
  writeFileSync(path.join(dir, "native", "packages.lock.json"), "{}")
  writeFileSync(path.join(dir, "native", "Worker.cs"), "class Worker {}")
  writeFileSync(path.join(dir, "scripts", "package-release.mjs"), "export {}")

  const manifest = await buildInputManifest({ rootDir: dir, version: "9.9.9", sourceDateEpoch: EPOCH, env: {} })
  assert.equal(manifest.format, "nixio-release-manifest")
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.appVersion, "9.9.9")
  assert.equal(manifest.sourceDateEpoch, EPOCH)
  assert.ok(manifest.git === null || typeof manifest.git.commit === "string")
  assert.ok(Array.isArray(manifest.builders))
  assert.ok(manifest.builders.some((b) => b.name === "node" && b.version))

  const paths = manifest.inputs.map((i) => i.path)
  assert.deepEqual(paths, [...paths].sort())
  assert.ok(paths.includes("package.json"))
  assert.ok(paths.includes("native/Worker.cs"))
  assert.ok(paths.includes("native/packages.lock.json"))
  const pkg = manifest.inputs.find((i) => i.path === "package.json")
  assert.equal(pkg.sha256, createHash("sha256").update('{"name":"fixture","version":"9.9.9"}').digest("hex"))
  assert.equal(pkg.bytes, '{"name":"fixture","version":"9.9.9"}'.length)
})

test("diffArtifactSets reports identical, missing and mismatched artifacts", () => {
  const a = [{ path: "a.deb", sha256: "1" }, { path: "b.rpm", sha256: "2" }]
  assert.equal(diffArtifactSets(a, a).identical, true)
  const missing = diffArtifactSets(a, [a[0]])
  assert.deepEqual(missing.missingInB, ["b.rpm"])
  assert.equal(missing.identical, false)
  const changed = diffArtifactSets(a, [{ path: "a.deb", sha256: "9" }, a[1]])
  assert.deepEqual(changed.mismatched, ["a.deb"])
})

test("RPM spec normalises buildroot timestamps only when an epoch is pinned", () => {
  const withEpoch = buildRpmSpec({
    version: "1.0.0",
    sourceDir: "/tmp/app",
    iconPath: "/tmp/icon.svg",
    sourceDateEpoch: EPOCH,
  })
  assert.match(withEpoch, new RegExp(`touch -h -d "@${EPOCH}"`))
  const without = buildRpmSpec({ version: "1.0.0", sourceDir: "/tmp/app", iconPath: "/tmp/icon.svg" })
  assert.doesNotMatch(without, /touch -h -d/)
})

test("packageRelease rejects an unpackaged app before doing any work", async () => {
  await assert.rejects(
    () => packageRelease({ rid: "linux-x64", version: "0.0.0-test", outDir: path.join(root, "release-verify-test") }),
    /Packaged desktop app not found/,
  )
})

test("repo pins its release inputs: lock file, deterministic flags and verify script exist", () => {
  const csproj = readFileSync(path.join(root, "native", "KhungThoai.Redraw.csproj"), "utf8")
  assert.match(csproj, /<ContinuousIntegrationBuild>true<\/ContinuousIntegrationBuild>/)
  assert.match(csproj, /<Deterministic>true<\/Deterministic>/)
  assert.match(csproj, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/)
  const lock = JSON.parse(readFileSync(path.join(root, "native", "packages.lock.json"), "utf8"))
  assert.equal(lock.version, 1)
  assert.ok(lock.dependencies["net10.0"])
  const desktopBuild = readFileSync(path.join(root, "scripts", "desktop-build.mjs"), "utf8")
  assert.match(desktopBuild, /RestoreLockedMode=true/)
  const verify = readFileSync(path.join(root, "scripts", "verify-release-repro.mjs"), "utf8")
  assert.match(verify, /diffArtifactSets/)
})
