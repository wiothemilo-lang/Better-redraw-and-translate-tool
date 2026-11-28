// Release notes advertise the installers a user is supposed to download, and a name no artifact
// carries is a dead link that nobody notices until someone clicks it. This collects the artifact
// names the notes promise and fails when the assets directory does not have them.
//
// Only names count: prose such as "run `Khung-Thoai.exe` after unzipping" and bare suffixes like
// `.dmg` are skipped, and every artifact Nixio publishes carries its version in its name.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ASSET_NAME = /^[A-Za-z0-9][\w.+-]*\.(exe|zip|dmg|deb|rpm|tar\.gz)$/i
const VERSIONED = /\d+\.\d+\.\d+/

export function assetsNamedInNotes(notes) {
  const names = new Set()
  for (const match of String(notes ?? "").matchAll(/`([^`\n]+)`/g)) {
    // A note may show the asset path (the workflow used to paste release-assets/... into the table);
    // the artifact itself is still named by its basename, so only the last segment is compared.
    const name = match[1].trim().split(/[\\/]/).pop() ?? ""
    if (!ASSET_NAME.test(name) || !VERSIONED.test(name)) continue
    names.add(name)
  }
  return [...names]
}

export function missingReleaseAssets(notes, available = []) {
  const present = new Set(available)
  return assetsNamedInNotes(notes).filter((name) => !present.has(name))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [notesPath, assetsDir] = process.argv.slice(2)
  if (!notesPath || !assetsDir) {
    console.error("Usage: check-release-notes.mjs <release-notes.md> <assets-dir>")
    process.exit(2)
  }
  const notes = await readFile(notesPath, "utf8")
  const available = await readdir(assetsDir)
  const missing = missingReleaseAssets(notes, available)
  if (missing.length) {
    console.error("Release notes name assets that were never built:\n" + missing.map((name) => "  - " + name).join("\n"))
    console.error("Available:\n" + available.map((name) => "  - " + name).join("\n"))
    process.exit(1)
  }
  console.log(`Release notes name ${assetsNamedInNotes(notes).length} assets, and all of them exist.`)
}
