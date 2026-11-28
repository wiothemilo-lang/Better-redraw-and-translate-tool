const { isSafePublicHttpsUrl, requestOnce, resolvePublicAddress } = require("./web-search.cjs")

const REPO_SLUG = "wiothemilo-lang/Nixio"
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`
const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`
const TIMEOUT_MS = 10000
const MAX_REDIRECTS = 5
const MAX_PAYLOAD_BYTES = 512 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// The updater only ever needs the release API host. A redirect or an injected apiUrl that
// leaves this set is refused instead of followed.
const TRUSTED_RELEASE_ORIGIN = new URL(RELEASES_API_URL).origin

function parseSemver(raw) {
  const cleaned = String(raw || "").trim().replace(/^v/i, "")
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
  }
}

function compareSemver(a, b) {
  const va = typeof a === "string" ? parseSemver(a) : a
  const vb = typeof b === "string" ? parseSemver(b) : b
  if (!va || !vb) return 0
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1
  const pa = va.prerelease
  const pb = vb.prerelease
  if (!pa.length && !pb.length) return 0
  if (!pa.length) return 1
  if (!pb.length) return -1
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    if (i >= pa.length) return -1
    if (i >= pb.length) return 1
    const ia = pa[i]
    const ib = pb[i]
    if (ia === ib) continue
    const na = /^\d+$/.test(ia) ? Number(ia) : null
    const nb = /^\d+$/.test(ib) ? Number(ib) : null
    if (na !== null && nb !== null) return na > nb ? 1 : -1
    if (na !== null) return -1
    if (nb !== null) return 1
    return ia > ib ? 1 : -1
  }
  return 0
}

function safeGitHubUrl(rawUrl, fallback = RELEASES_PAGE_URL) {
  // isSafePublicHttpsUrl returns an href string, so the host has to be re-read from a URL.
  const safeHref = isSafePublicHttpsUrl(rawUrl)
  if (!safeHref) return fallback
  const { hostname: host, port, username, password } = new URL(safeHref)
  if (port || username || password) return fallback
  if (host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com")) {
    return safeHref
  }
  return fallback
}

function trustedReleaseUrl(rawUrl) {
  const safeHref = isSafePublicHttpsUrl(rawUrl)
  if (!safeHref) return null
  const url = new URL(safeHref)
  return url.origin === TRUSTED_RELEASE_ORIGIN && !url.username && !url.password ? url : null
}

async function fetchReleasePayload(rawUrl, { version, request, lookup, signal }) {
  let current = trustedReleaseUrl(rawUrl)
  if (!current) throw new Error("URL kiểm tra cập nhật không hợp lệ.")
  const headers = { Accept: "application/vnd.github+json", "User-Agent": `Nixio/${version}` }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal.throwIfAborted()
    const address = await resolvePublicAddress(current.hostname, { lookup })
    signal.throwIfAborted()
    const response = await request(current.href, { address, headers, maxBytes: MAX_PAYLOAD_BYTES, signal })
    signal.throwIfAborted()
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { status: response.status, text: String(response.text ?? "") }
    }
    if (hop === MAX_REDIRECTS) throw new Error("Đã vượt quá số lần chuyển hướng cho phép.")
    try {
      current = response.location && trustedReleaseUrl(new URL(response.location, current))
    } catch {
      current = null
    }
    if (!current) throw new Error("Đường dẫn chuyển hướng không hợp lệ hoặc không an toàn.")
  }
}

function normalizeReleasePayload(payload, currentVersion) {
  const tagName = String(payload?.tag_name || "").trim()
  const parsedLatest = parseSemver(tagName)
  const latestVersion = parsedLatest
    ? `${parsedLatest.major}.${parsedLatest.minor}.${parsedLatest.patch}${parsedLatest.prerelease.length ? "-" + parsedLatest.prerelease.join(".") : ""}`
    : tagName.replace(/^v/i, "")
  const parsedCurrent = parseSemver(currentVersion)
  const hasUpdate = Boolean(parsedLatest && parsedCurrent && compareSemver(parsedLatest, parsedCurrent) > 0)
  const rawBody = String(payload?.body || "").trim()
  const notes = rawBody.length > 4000 ? rawBody.slice(0, 4000) + "…" : rawBody
  const assets = Array.isArray(payload?.assets)
    ? payload.assets
      .filter((asset) => asset && typeof asset.name === "string" && asset.browser_download_url)
      .slice(0, 12)
      .map((asset) => ({
        name: asset.name.slice(0, 180),
        size: Number(asset.size) || 0,
        downloadUrl: safeGitHubUrl(asset.browser_download_url, RELEASES_PAGE_URL),
      }))
    : []

  return {
    ok: true,
    currentVersion: String(currentVersion || "0.0.0"),
    latestVersion: latestVersion || String(currentVersion || "0.0.0"),
    hasUpdate,
    release: {
      tagName,
      name: String(payload?.name || tagName || latestVersion).slice(0, 200),
      url: safeGitHubUrl(payload?.html_url, RELEASES_PAGE_URL),
      publishedAt: typeof payload?.published_at === "string" ? payload.published_at : "",
      notes,
      assets,
    },
    checkedAt: new Date().toISOString(),
  }
}

async function checkForUpdates(currentVersion, {
  request = requestOnce,
  lookup,
  apiUrl = RELEASES_API_URL,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const checkedAt = new Date().toISOString()
  const version = String(currentVersion || "1.0.0")
  const controller = new AbortController()
  let timer
  try {
    const expired = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException("Update request timed out.", "TimeoutError")
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    })
    const response = await Promise.race([
      expired,
      fetchReleasePayload(apiUrl, { version, request, lookup, signal: controller.signal }),
    ])
    if (response.status === 404) {
      return {
        ok: true,
        currentVersion: version,
        latestVersion: version,
        hasUpdate: false,
        release: {
          tagName: "v" + version,
          name: "Chưa có bản phát hành công khai",
          url: RELEASES_PAGE_URL,
          publishedAt: "",
          notes: "",
          assets: [],
        },
        checkedAt,
      }
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        currentVersion: version,
        status: response.status,
        error: response.status === 403
          ? "GitHub API tạm giới hạn tốc độ, hãy thử lại sau."
          : `Không thể kiểm tra cập nhật (HTTP ${response.status}).`,
        checkedAt,
      }
    }
    let payload
    try {
      payload = JSON.parse(response.text)
    } catch {
      return { ok: false, currentVersion: version, error: "Phản hồi cập nhật không hợp lệ.", checkedAt }
    }
    return normalizeReleasePayload(payload, version)
  } catch (error) {
    return {
      ok: false,
      currentVersion: version,
      error: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "Hết thời gian kết nối tới máy chủ cập nhật."
        : (error?.message || "Không thể kết nối máy chủ cập nhật."),
      checkedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  REPO_SLUG,
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  parseSemver,
  compareSemver,
  normalizeReleasePayload,
  checkForUpdates,
}
