const { isSafePublicHttpsUrl } = require("./web-search.cjs")

const REPO_SLUG = "wiothemilo-lang/Nixio"
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`
const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`
const TIMEOUT_MS = 10000

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
  const safe = isSafePublicHttpsUrl(rawUrl)
  if (!safe) return fallback
  const host = safe.hostname.toLowerCase()
  if (host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com")) {
    return safe.toString()
  }
  return fallback
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

async function checkForUpdates(currentVersion, { fetchImpl = fetch, apiUrl = RELEASES_API_URL, timeoutMs = TIMEOUT_MS } = {}) {
  const checkedAt = new Date().toISOString()
  const version = String(currentVersion || "1.0.0")
  try {
    const safeApi = isSafePublicHttpsUrl(apiUrl)
    if (!safeApi) {
      return { ok: false, currentVersion: version, error: "URL kiểm tra cập nhật không hợp lệ.", checkedAt }
    }
    const response = await fetchImpl(safeApi.toString(), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `KhungThoai/${version}`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    })
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
    if (!response.ok) {
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
    const payload = await response.json()
    return normalizeReleasePayload(payload, version)
  } catch (error) {
    return {
      ok: false,
      currentVersion: version,
      error: error?.name === "TimeoutError"
        ? "Hết thời gian kết nối tới máy chủ cập nhật."
        : (error?.message || "Không thể kết nối máy chủ cập nhật."),
      checkedAt,
    }
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
