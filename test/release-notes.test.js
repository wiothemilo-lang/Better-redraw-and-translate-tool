import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assetsNamedInNotes, missingReleaseAssets } from "../scripts/check-release-notes.mjs"
import { rpmVersionParts } from "../scripts/package-release.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const script = path.join(root, "scripts/check-release-notes.mjs")

const notes = [
  "| Windows | `Khung-Thoai-1.2.0-win-x64-setup.exe` |",
  "| Fedora | `khung-thoai-1.2.0-0.1.beta.1.x86_64.rpm` |",
  "| Portable | Giải nén và chạy `Khung-Thoai.exe` |",
  "Kiểm tra toàn vẹn tệp bằng `SHA256SUMS.txt`.",
].join("\n")

test("release notes are checked against the artifacts that were actually built", async (t) => {
  assert.deepEqual(assetsNamedInNotes(notes), [
    "Khung-Thoai-1.2.0-win-x64-setup.exe",
    "khung-thoai-1.2.0-0.1.beta.1.x86_64.rpm",
  ])
  assert.deepEqual(missingReleaseAssets(notes, ["Khung-Thoai-1.2.0-win-x64-setup.exe"]), ["khung-thoai-1.2.0-0.1.beta.1.x86_64.rpm"])

  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-notes-"))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const assets = path.join(folder, "release-assets")
  const notesPath = path.join(folder, "release-notes.md")
  await writeFile(notesPath, notes)
  await import("node:fs/promises").then(({ mkdir }) => mkdir(assets))

  const missing = spawnSync(process.execPath, [script, notesPath, assets], { encoding: "utf8" })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /khung-thoai-1\.2\.0-0\.1\.beta\.1\.x86_64\.rpm/)

  await writeFile(path.join(assets, "Khung-Thoai-1.2.0-win-x64-setup.exe"), "installer")
  await writeFile(path.join(assets, "khung-thoai-1.2.0-0.1.beta.1.x86_64.rpm"), "package")
  const complete = spawnSync(process.execPath, [script, notesPath, assets], { encoding: "utf8" })
  assert.equal(complete.status, 0, complete.stderr)
})

test("a prerelease RPM is named after its split version, not after the tag", () => {
  const { version, release } = rpmVersionParts("1.2.0-beta.1")
  assert.equal(`khung-thoai-${version}-${release}.x86_64.rpm`, "khung-thoai-1.2.0-0.1.beta.1.x86_64.rpm")
  // The name the release notes used to spell out from the tag does not exist.
  assert.notEqual(`khung-thoai-1.2.0-beta.1-1.x86_64.rpm`, "khung-thoai-1.2.0-0.1.beta.1.x86_64.rpm")
})
