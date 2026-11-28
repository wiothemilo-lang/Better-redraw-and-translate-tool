import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

async function jobs() {
  const yaml = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8")
  const blocks = new Map()
  let current = null
  for (const line of yaml.split("\n")) {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line)
    if (header) {
      current = header[1]
      blocks.set(current, [])
      continue
    }
    if (current) blocks.get(current).push(line)
  }
  return blocks
}

const joined = (blocks, name) => (blocks.get(name) ?? []).join("\n")

test("every release build job checks out the commit the release tag points at", async () => {
  const blocks = await jobs()
  for (const name of ["build-linux", "build-windows", "build-macos", "verify-linux-repro"]) {
    const job = joined(blocks, name)
    assert.ok(job, `${name} must exist`)
    assert.match(
      job,
      /uses: actions\/checkout@v\d+\n\s+with:\n(?:\s+#[^\n]*\n)?\s+ref: \$\{\{ needs\.meta\.outputs\.tag \}\}/,
      `${name} must check out needs.meta.outputs.tag, or it packages the dispatching commit with the tag's version`,
    )
  }

  // The metadata job has to read package.json from the dispatching ref: pinning it to a tag would
  // make `ref` depend on its own output.
  assert.doesNotMatch(joined(blocks, "meta"), /ref: \$\{\{ needs\.meta\.outputs\.tag \}\}/)
})

test("the release notes take the RPM file name from the artifacts and every name they mention exists", async () => {
  const blocks = await jobs()
  const publish = joined(blocks, "publish")
  // The RPM file name splits a prerelease version (1.2.0-beta.1 => khung-thoai-1.2.0-0.1.beta.1...),
  // so a name rewritten from the tag does not exist on prereleases.
  assert.doesNotMatch(publish, /khung-thoai-\$\{VER\}-1\.x86_64\.rpm/)
  // A failing `ls` inside $( ) aborts a bash -eo pipefail step before its own guard can explain
  // what was missing, so the glob is read without the `cd` and its exit code cannot leak.
  assert.match(publish, /RPM_FILE=\$\(ls release-assets\/\*\.rpm 2>\/dev\/null \| head -n 1 \|\| true\)/)
  assert.doesNotMatch(publish, /cd release-assets && ls/)
  assert.match(publish, /\| \*\*Fedora Linux \(x64\)\*\* \| \\`\$\{RPM_FILE\}\\` \|/)
  // And the notes are not published until their file names are checked against the assets.
  assert.match(publish, /node scripts\/check-release-notes\.mjs release-notes\.md release-assets/)
})

test("a missing RPM artifact still prints why the notes were refused (#review)", { skip: process.platform === "win32" ? "The release publish step runs in bash." : undefined }, async () => {
  // The publish step runs under bash -eo pipefail. Reading the glob through $( ) with a `cd` made a
  // failing `ls` abort the step before its own guard could say what was missing; this runs the
  // shape the workflow uses now and checks the message survives.
  const { spawnSync } = await import("node:child_process")
  const script = [
    'RPM_FILE=$(ls /nonexistent-dir/*.rpm 2>/dev/null | head -n 1 || true)',
    'if [ -z "$RPM_FILE" ]; then',
    '  echo "No .rpm artifact was uploaded."',
    '  exit 1',
    'fi',
    '',
  ].join("\n")
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stdout + result.stderr, /No \.rpm artifact was uploaded/)
})
