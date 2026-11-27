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
