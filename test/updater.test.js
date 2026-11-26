import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import {
  RELEASES_PAGE_URL,
  checkAppUpdate,
  compareSemver,
  dismissUpdateVersion,
  formatBytes,
  normalizeReleasePayload,
  parseSemver,
} from "../src/updater.js"

const require = createRequire(import.meta.url)
const desktopUpdater = require("../desktop/updater.cjs")

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  }
}

test("parseSemver and compareSemver handle standard versions, v-prefix, and prereleases", () => {
  assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseSemver("2.0.0-beta.2+build42"), { major: 2, minor: 0, patch: 0, prerelease: ["beta", "2"] })
  assert.equal(parseSemver("not-a-version"), null)

  assert.equal(compareSemver("1.2.0", "1.1.9"), 1)
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0)
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1)
  assert.equal(compareSemver("1.1.0-rc.1", "1.1.0"), -1)
  assert.equal(compareSemver("1.1.0-beta.10", "1.1.0-beta.2"), 1)
  assert.equal(desktopUpdater.compareSemver("v2.0.0", "1.9.9"), 1)
})

test("normalizeReleasePayload sanitizes non-GitHub URLs and detects update", () => {
  const result = normalizeReleasePayload(
    {
      tag_name: "v1.3.0",
      name: "Khung Thoại 1.3.0",
      html_url: "https://evil.example/phish",
      published_at: "2026-11-26T00:00:00Z",
      body: "New features",
      assets: [
        { name: "Khung-Thoai-win-x64.zip", size: 1234567, browser_download_url: "https://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.0/app.zip" },
        { name: "bad.exe", size: 100, browser_download_url: "http://127.0.0.1/bad.exe" },
      ],
    },
    "1.0.0",
  )

  assert.equal(result.ok, true)
  assert.equal(result.hasUpdate, true)
  assert.equal(result.latestVersion, "1.3.0")
  assert.equal(result.release.url, RELEASES_PAGE_URL)
  assert.equal(result.release.assets[0].downloadUrl, "https://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.0/app.zip")
  assert.equal(result.release.assets[1].downloadUrl, RELEASES_PAGE_URL)
})

test("checkAppUpdate respects cooldown, dismissed version, force override, and offline errors", async () => {
  const storage = memoryStorage()
  let calls = 0
  const mockFetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          tag_name: "v1.4.0",
          name: "v1.4.0",
          html_url: "https://github.com/wiothemilo-lang/Nixio/releases/tag/v1.4.0",
          body: "Highlights",
          assets: [],
        }
      },
    }
  }

  const first = await checkAppUpdate({
    force: false,
    currentVersion: "1.0.0",
    fetchImpl: mockFetch,
    desktopBridge: null,
    storage,
    now: 100000,
  })
  assert.equal(first.ok, true)
  assert.equal(first.hasUpdate, true)
  assert.equal(first.dismissed, false)
  assert.equal(calls, 1)

  const withinCooldown = await checkAppUpdate({
    force: false,
    currentVersion: "1.0.0",
    fetchImpl: mockFetch,
    desktopBridge: null,
    storage,
    now: 100500,
  })
  assert.equal(withinCooldown.skipped, true)
  assert.equal(calls, 1)

  dismissUpdateVersion("1.4.0", storage)
  const afterCooldown = await checkAppUpdate({
    force: false,
    currentVersion: "1.0.0",
    fetchImpl: mockFetch,
    desktopBridge: null,
    storage,
    now: 100000 + 25 * 60 * 60 * 1000,
  })
  assert.equal(afterCooldown.hasUpdate, true)
  assert.equal(afterCooldown.dismissed, true)
  assert.equal(calls, 2)

  const forced = await checkAppUpdate({
    force: true,
    currentVersion: "1.0.0",
    fetchImpl: mockFetch,
    desktopBridge: null,
    storage,
    now: 100000 + 25 * 60 * 60 * 1000,
  })
  assert.equal(forced.dismissed, false)
  assert.equal(calls, 3)

  const offline = await checkAppUpdate({
    force: true,
    currentVersion: "1.0.0",
    fetchImpl: async () => { throw new Error("network down") },
    desktopBridge: null,
    storage,
  })
  assert.equal(offline.ok, false)
  assert.match(offline.error, /network down/)
})

test("desktop checkForUpdates handles 404 (no public releases yet) cleanly", async () => {
  const res = await desktopUpdater.checkForUpdates("1.0.0", {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  })
  assert.equal(res.ok, true)
  assert.equal(res.hasUpdate, false)
  assert.equal(res.latestVersion, "1.0.0")
  assert.equal(formatBytes(2048), "2.0 KB")
})
