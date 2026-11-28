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

test("the desktop smoke test waits for a snapshot newer than the edit, not a stale status", async () => {
  // The heartbeat had already written "Đã tự lưu lúc ..." before the edit, so waiting on that text
  // reloaded before the new autosave and could restore the previous snapshot (#146).
  const source = await readFile(path.join(root, "scripts/desktop-smoke.mjs"), "utf8")
  assert.match(source, /const beforeAutosave = await page\.evaluate/)
  assert.match(source, /latest\.id !== before\.snapshotId/)
  assert.match(source, /status !== before\.status/)
  assert.match(source, /data-snapshot-id/)
  // The dialog is filled asynchronously, so its text cannot be read just because it is visible.
  assert.match(source, /const restore = page\.locator/)
  assert.match(source, /await restore\.waitFor\(\{ state: "visible" \}\)/)
  assert.doesNotMatch(source, /#recent-projects"\)\.textContent\(\), \/Khôi phục\//)
  assert.doesNotMatch(source, /#autosave-status"\)\.filter\(\{ hasText: "Đã tự lưu lúc"/)
})

test("the desktop smoke test cannot hold a job open after it passes or hangs", async () => {
  // macOS keeps the app alive after the last window closes, so a successful run wrote its artifact
  // and then sat there until the 25 minute job timeout. The successful exit is explicit, the
  // teardown is bounded and the run has its own watchdog.
  const source = await readFile(path.join(root, "scripts/desktop-smoke.mjs"), "utf8")
  assert.match(source, /const watchdog = setTimeout\(/)
  assert.match(source, /watchdog\.unref\(\)/)
  assert.match(source, /Promise\.race\(\[\n\s+app\.close\(\)/)
  assert.match(source, /application\.kill\("SIGKILL"\)/)
  assert.match(source, /clearTimeout\(watchdog\)/)
  assert.match(source, /process\.exit\(0\)/)
})
