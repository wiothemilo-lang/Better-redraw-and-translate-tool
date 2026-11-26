export const APP_VERSION = "1.0.0"
export const REPO_SLUG = "wiothemilo-lang/Nixio"
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`
export const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`

const STORAGE_KEY = "khung-thoai-update-state"
const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000

export function parseSemver(raw) {
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

export function compareSemver(a, b) {
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
  try {
    const parsed = new URL(String(rawUrl || "").trim())
    if (parsed.protocol !== "https:") return fallback
    const host = parsed.hostname.toLowerCase()
    if (host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com")) {
      return parsed.toString()
    }
  } catch {
    // Fall back to releases page.
  }
  return fallback
}

export function normalizeReleasePayload(payload, currentVersion = APP_VERSION) {
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
    currentVersion: String(currentVersion || APP_VERSION),
    latestVersion: latestVersion || String(currentVersion || APP_VERSION),
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

export function readUpdatePrefs(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) || "null")
    if (!raw || typeof raw !== "object") return { lastCheckedAt: 0, dismissedVersion: "" }
    return {
      lastCheckedAt: Number(raw.lastCheckedAt) || 0,
      dismissedVersion: typeof raw.dismissedVersion === "string" ? raw.dismissedVersion : "",
    }
  } catch {
    return { lastCheckedAt: 0, dismissedVersion: "" }
  }
}

export function writeUpdatePrefs(patch, storage = globalThis.localStorage) {
  try {
    const next = { ...readUpdatePrefs(storage), ...patch }
    storage?.setItem(STORAGE_KEY, JSON.stringify(next))
    return next
  } catch {
    return { lastCheckedAt: 0, dismissedVersion: "", ...patch }
  }
}

export function dismissUpdateVersion(version, storage = globalThis.localStorage) {
  return writeUpdatePrefs({ dismissedVersion: String(version || "").trim() }, storage)
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export async function openExternalUrl(url, desktopBridge = globalThis.window?.khungThoaiDesktop) {
  const clean = String(url || "").trim()
  if (!clean.startsWith("https://")) return false
  if (desktopBridge?.openExternal) {
    await desktopBridge.openExternal(clean)
    return true
  }
  globalThis.window?.open?.(clean, "_blank", "noopener,noreferrer")
  return true
}

export async function checkAppUpdate({
  force = false,
  currentVersion,
  fetchImpl = globalThis.fetch,
  desktopBridge = globalThis.window?.khungThoaiDesktop,
  storage = globalThis.localStorage,
  now = Date.now(),
  cooldownMs = CHECK_COOLDOWN_MS,
  apiUrl = RELEASES_API_URL,
} = {}) {
  const prefs = readUpdatePrefs(storage)
  if (!force && prefs.lastCheckedAt && now - prefs.lastCheckedAt < cooldownMs) {
    return { ok: true, skipped: true, reason: "cooldown", currentVersion: currentVersion || APP_VERSION, hasUpdate: false }
  }

  let version = currentVersion || APP_VERSION
  let result

  if (desktopBridge?.checkUpdate) {
    try {
      result = await desktopBridge.checkUpdate()
      if (result?.currentVersion) version = result.currentVersion
    } catch (error) {
      return {
        ok: false,
        currentVersion: version,
        error: error?.message || "Không thể kiểm tra cập nhật.",
        checkedAt: new Date(now).toISOString(),
      }
    }
  } else {
    try {
      const response = await fetchImpl(apiUrl, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
        credentials: "omit",
        signal: AbortSignal.timeout(10000),
      })
      if (response.status === 404) {
        result = {
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
          checkedAt: new Date(now).toISOString(),
        }
      } else if (!response.ok) {
        return {
          ok: false,
          currentVersion: version,
          status: response.status,
          error: response.status === 403
            ? "GitHub API tạm giới hạn tốc độ, hãy thử lại sau."
            : `Không thể kiểm tra cập nhật (HTTP ${response.status}).`,
          checkedAt: new Date(now).toISOString(),
        }
      } else {
        result = normalizeReleasePayload(await response.json(), version)
      }
    } catch (error) {
      return {
        ok: false,
        currentVersion: version,
        error: error?.name === "TimeoutError"
          ? "Hết thời gian kết nối máy chủ cập nhật."
          : (error?.message || "Không có kết nối mạng để kiểm tra cập nhật."),
        checkedAt: new Date(now).toISOString(),
      }
    }
  }

  if (result?.ok) {
    writeUpdatePrefs({ lastCheckedAt: now }, storage)
  }

  const dismissed = Boolean(!force && result?.hasUpdate && prefs.dismissedVersion && prefs.dismissedVersion === result.latestVersion)
  return { ...result, dismissed }
}
