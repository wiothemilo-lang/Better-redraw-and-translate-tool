import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

test("the desktop smoke test listens for renderer errors before the first window loads", async () => {
  // The renderer runs its entry script while the window is created, so a pageerror recorded only
  // after firstWindow() resolves would be the one this test exists to catch.
  // The smoke script needs Electron, so the order of its own lines is what gets asserted: a
  // listener registered after firstWindow() is exactly the bug, and moving the code means updating
  // this test with it.
  const source = await readFile(path.join(root, "scripts/desktop-smoke.mjs"), "utf8")
  const launch = source.indexOf("await _electron.launch(")
  const listen = source.indexOf('app.on("window"')
  const firstWindow = source.indexOf("await app.firstWindow(")
  assert.ok(launch > 0 && listen > launch && firstWindow > listen)
  assert.match(source, /app\.on\("window", \(window\) => \{\n\s+window\.on\("pageerror"/)
  // One listener: a second one on the page itself would report the same error twice.
  assert.equal(source.match(/pageerror/g).length, 1)
  assert.match(source, /assert\.deepEqual\(errors, \[\]\)/)
})
