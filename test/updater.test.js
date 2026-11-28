import { EventEmitter } from "node:events"
import https from "node:https"
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
      name: "Nixio 1.3.0",
      html_url: "https://evil.example/phish",
      published_at: "2026-11-26T00:00:00Z",
      body: "New features",
      assets: [
        { name: "Nixio-win-x64.zip", size: 1234567, browser_download_url: "https://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.0/app.zip" },
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
    request: async () => ({ status: 404 }),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  })
  assert.equal(res.ok, true)
  assert.equal(res.hasUpdate, false)
  assert.equal(res.latestVersion, "1.0.0")
  assert.equal(formatBytes(2048), "2.0 KB")
})

test("desktop normalization keeps trusted GitHub asset links and falls back for disallowed URLs", () => {
  const trustedHtmlUrl = "https://github.com/wiothemilo-lang/Nixio/releases/tag/v1.3.1"
  const trustedAsset = "https://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.1/Nixio-1.3.1-win-x64.zip"
  const signedAsset = "https://objects.githubusercontent.com/github-production-release-asset-2e65be/123?X-Amz-Signature=abc"
  const result = desktopUpdater.normalizeReleasePayload({
    tag_name: "v1.3.1",
    name: "Nixio 1.3.1",
    html_url: trustedHtmlUrl,
    published_at: "2026-11-27T00:00:00Z",
    body: "Bản phát hành mới",
    assets: [
      { name: "Nixio-1.3.1-win-x64.zip", size: 4096, browser_download_url: trustedAsset },
      { name: "Nixio-1.3.1-mac-arm64.zip", size: 8192, browser_download_url: signedAsset },
      { name: "Nixio-1.3.1-linux-x64.zip", size: 2048, browser_download_url: "https://mirror.example.net/Nixio-1.3.1-linux-x64.zip" },
      { name: "Nixio-1.3.1-insecure.zip", size: 1024, browser_download_url: "http://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.1/insecure.zip" },
    ],
  }, "1.3.0")

  assert.equal(result.ok, true)
  assert.equal(result.hasUpdate, true)
  assert.equal(result.latestVersion, "1.3.1")
  assert.equal(result.release.url, trustedHtmlUrl)
  assert.deepEqual(result.release.assets.map((asset) => asset.downloadUrl), [
    trustedAsset,
    signedAsset,
    desktopUpdater.RELEASES_PAGE_URL,
    desktopUpdater.RELEASES_PAGE_URL,
  ])

  // A host that merely contains "github.com" is never trusted.
  const impostor = desktopUpdater.normalizeReleasePayload({
    tag_name: "v1.3.1",
    html_url: "https://github.com.example/releases/tag/v1.3.1",
    assets: [{ name: "app.zip", size: 1, browser_download_url: "https://github.com.example/app.zip" }],
  }, "1.3.0")
  assert.equal(impostor.release.url, desktopUpdater.RELEASES_PAGE_URL)
  assert.equal(impostor.release.assets[0].downloadUrl, desktopUpdater.RELEASES_PAGE_URL)
})

test("desktop checkForUpdates pins the release API and validates every redirect hop", async () => {
  const apiUrl = desktopUpdater.RELEASES_API_URL
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]
  const payload = JSON.stringify({
    tag_name: "v1.3.1",
    name: "Nixio 1.3.1",
    html_url: "https://github.com/wiothemilo-lang/Nixio/releases/tag/v1.3.1",
    body: "Ghi chú phát hành",
    assets: [{
      name: "Nixio-1.3.1-win-x64.zip",
      size: 4096,
      browser_download_url: "https://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.1/Nixio-1.3.1-win-x64.zip",
    }],
  })
  const requests = []
  const request = async (url, options) => {
    requests.push({ url, ...options })
    if (url === apiUrl) return { status: 200, location: null, text: payload }
    if (url === "https://api.github.com/releases/redirected") {
      return { status: 302, location: "https://api.github.com/releases/redirected/final" }
    }
    if (url === "https://api.github.com/releases/redirected/final") return { status: 200, location: null, text: payload }
    if (url === "https://api.github.com/off-policy") {
      return { status: 302, location: "https://mirror.example.net/releases/latest" }
    }
    if (url === "https://api.github.com/downgrade") {
      return { status: 307, location: "http://api.github.com/repos/wiothemilo-lang/Nixio/releases/latest" }
    }
    if (url === "https://api.github.com/internal-hop") {
      return { status: 301, location: "https://10.0.0.1/latest" }
    }
    if (url === "https://api.github.com/loop") return { status: 302, location: "https://api.github.com/loop" }
    if (url === "https://api.github.com/missing") return { status: 404, location: null, text: "" }
    if (url === "https://api.github.com/limited") return { status: 403, location: null, text: "" }
    if (url === "https://api.github.com/not-json") return { status: 200, location: null, text: "<html>oops</html>" }
    return { status: 200, location: null, text: payload }
  }

  const accepted = await desktopUpdater.checkForUpdates("1.3.0", { request, lookup: publicLookup })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.hasUpdate, true)
  assert.deepEqual(accepted.release.assets.map((asset) => asset.downloadUrl), [
    "https://github.com/wiothemilo-lang/Nixio/releases/download/v1.3.1/Nixio-1.3.1-win-x64.zip",
  ])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, apiUrl)
  assert.equal(requests[0].address, "93.184.216.34")
  assert.equal(requests[0].headers.Accept, "application/vnd.github+json")
  assert.equal(requests[0].headers["User-Agent"], "Nixio/1.3.0")
  assert.ok(requests[0].signal instanceof AbortSignal)

  // A same-host redirect is followed, re-resolved and re-pinned with the same headers.
  requests.length = 0
  const redirected = await desktopUpdater.checkForUpdates("1.3.0", {
    request,
    lookup: publicLookup,
    apiUrl: "https://api.github.com/releases/redirected",
  })
  assert.equal(redirected.ok, true)
  assert.deepEqual(requests.map((entry) => [entry.url, entry.address]), [
    ["https://api.github.com/releases/redirected", "93.184.216.34"],
    ["https://api.github.com/releases/redirected/final", "93.184.216.34"],
  ])
  assert.equal(requests[1].headers["User-Agent"], "Nixio/1.3.0")

  // Off-policy, downgraded and internal hops are refused before any request is sent.
  for (const [url, apiPath] of [
    ["https://api.github.com/off-policy", "https://mirror.example.net/releases/latest"],
    ["https://api.github.com/downgrade", "http://api.github.com/repos/wiothemilo-lang/Nixio/releases/latest"],
    ["https://api.github.com/internal-hop", "https://10.0.0.1/latest"],
  ]) {
    requests.length = 0
    const blocked = await desktopUpdater.checkForUpdates("1.3.0", { request, lookup: publicLookup, apiUrl: url })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /chuyển hướng không hợp lệ/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, url)
    assert.ok(!requests.some((entry) => entry.url === apiPath))
  }

  // The redirect chain is bounded.
  requests.length = 0
  const looped = await desktopUpdater.checkForUpdates("1.3.0", {
    request,
    lookup: publicLookup,
    apiUrl: "https://api.github.com/loop",
  })
  assert.equal(looped.ok, false)
  assert.match(looped.error, /số lần chuyển hướng/)
  assert.equal(requests.length, 6)

  // Not-found, rate-limit and malformed-payload results keep their existing shapes.
  const missing = await desktopUpdater.checkForUpdates("1.0.0", {
    request,
    lookup: publicLookup,
    apiUrl: "https://api.github.com/missing",
  })
  assert.equal(missing.ok, true)
  assert.equal(missing.hasUpdate, false)
  assert.equal(missing.release.name, "Chưa có bản phát hành công khai")
  assert.equal(missing.release.url, desktopUpdater.RELEASES_PAGE_URL)

  const limited = await desktopUpdater.checkForUpdates("1.0.0", {
    request,
    lookup: publicLookup,
    apiUrl: "https://api.github.com/limited",
  })
  assert.equal(limited.ok, false)
  assert.equal(limited.status, 403)
  assert.match(limited.error, /giới hạn tốc độ/)

  const notJson = await desktopUpdater.checkForUpdates("1.0.0", {
    request,
    lookup: publicLookup,
    apiUrl: "https://api.github.com/not-json",
  })
  assert.equal(notJson.ok, false)
  assert.match(notJson.error, /không hợp lệ/)

  // An injected apiUrl outside the release API host never leaves the process.
  requests.length = 0
  const offPolicy = await desktopUpdater.checkForUpdates("1.0.0", {
    request,
    lookup: publicLookup,
    apiUrl: "https://mirror.example.net/releases/latest",
  })
  assert.equal(offPolicy.ok, false)
  assert.match(offPolicy.error, /URL kiểm tra cập nhật không hợp lệ/)
  assert.equal(requests.length, 0)

  // The default transport is the pinned https one, never global fetch, and a DNS answer in
  // a private range is refused before the socket is opened.
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error("global fetch must not be used by the desktop updater")
  }
  try {
    const internalDns = await desktopUpdater.checkForUpdates("1.0.0", {
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
    })
    assert.equal(internalDns.ok, false)
    assert.match(internalDns.error, /IP nội bộ/)
    assert.equal(fetchCalls, 0)
    assert.equal(requests.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }

  // Timeouts stay readable instead of surfacing a raw abort.
  const timedOut = await desktopUpdater.checkForUpdates("1.0.0", {
    request: async () => {
      const error = new Error("The operation was aborted")
      error.name = "AbortError"
      throw error
    },
    lookup: publicLookup,
  })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.error, /Hết thời gian/)

})

test("desktop updater uses a single deadline across DNS and redirect hops", async () => {
  let finishLookup
  let sendCount = 0
  const result = await desktopUpdater.checkForUpdates("1.0.0", {
    timeoutMs: 10,
    lookup: () => new Promise((resolve) => { finishLookup = resolve }),
    request: async () => { sendCount++ },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Hết thời gian/)
  finishLookup([{ address: "93.184.216.34", family: 4 }])
  await new Promise(setImmediate)
  assert.equal(sendCount, 0)

  const signals = []
  const redirected = await desktopUpdater.checkForUpdates("1.0.0", {
    timeoutMs: 1000,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (_url, { signal }) => {
      signals.push(signal)
      return signals.length === 1 ? { status: 302, location: "/next" } : { status: 404 }
    },
  })
  assert.equal(redirected.ok, true)
  assert.equal(signals.length, 2)
  assert.equal(signals[0], signals[1])
})

test("desktop updater accepts only the release API origin with no credentials", async () => {
  for (const apiUrl of [
    "https://api.github.com:8443/releases/latest",
    "https://fixture@api.github.com/releases/latest",
  ]) {
    const response = await desktopUpdater.checkForUpdates("1.0.0", {
      apiUrl,
      lookup: async () => assert.fail("origin validation must precede DNS"),
      request: async () => assert.fail("origin validation must precede requests"),
    })
    assert.equal(response.ok, false)
    assert.match(response.error, /URL kiểm tra cập nhật không hợp lệ/)
  }
})


test("desktop updater uses the pinned HTTPS transport for the release API", async (t) => {
  const host = "api.github.com"
  const addresses = ["93.184.216.34", "93.184.216.35"]
  const requests = []
  let lookups = 0
  t.mock.method(https, "request", (options, onResponse) => {
    requests.push(options)
    const req = new EventEmitter()
    req.end = () => {
      const res = new EventEmitter()
      res.destroy = () => {}
      res.statusCode = requests.length === 1 ? 302 : 200
      res.headers = res.statusCode === 302 ? { location: "/next" } : {}
      onResponse(res)
      if (res.statusCode === 200) {
        res.emit("data", Buffer.from(JSON.stringify({ tag_name: "v1.4.0" })))
        res.emit("end")
      }
    }
    return req
  })
  const result = await desktopUpdater.checkForUpdates("1.3.0", {
    lookup: async (name) => {
      assert.equal(name, host)
      return [{ address: addresses[lookups++], family: 4 }]
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.latestVersion, "1.4.0")
  assert.equal(lookups, 2)
  assert.deepEqual(requests.map(({ host }) => host), addresses)
  for (const { port, servername, headers } of requests) {
    assert.equal(port, 443)
    assert.equal(servername, host)
    assert.equal(headers.Host, host)
  }
})
