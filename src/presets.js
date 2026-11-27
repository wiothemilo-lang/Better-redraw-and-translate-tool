import { projectStyle } from "./project.js"

export const GLOBAL_PRESETS_KEY = "khung-thoai-global-presets"
export const MAX_GLOBAL_PRESETS = 60

// Presets are stored sparse, so a field the preset never mentions keeps whatever the box had.
// Applying one therefore resets the fields a preset is allowed to omit, or a saved SFX curve
// would survive a plain-dialogue preset. The editor button and the agent tool share this list.
export const PRESET_RESET_DEFAULTS = Object.freeze({
  bold: false, italic: false, uppercase: false, vertical: false,
  bubbleFit: false, warp: "none", warpAmount: 0,
  lineHeight: 1.15, strokeWidth: 0, strokeColor: "#ffffff",
  shadowBlur: 0, shadowColor: "#000000",
  fillColor: "#ffffff", fillShape: "rect",
})

export const DEFAULT_STARTER_PRESETS = [
  {
    name: "Thoại thường",
    style: {
      size: 26, font: "Arial", color: "#171717", align: "center", rotation: 0,
      fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.15, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Suy nghĩ (Nghiêng)",
    style: {
      size: 24, font: "Georgia", color: "#2b303a", align: "center", rotation: 0,
      italic: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.2, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Hét / Nhấn mạnh",
    style: {
      size: 32, font: "Arial", color: "#111111", align: "center", rotation: 0,
      bold: true, uppercase: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.05, strokeWidth: 2, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "SFX (Viền + Bóng)",
    style: {
      size: 44, font: "Arial", color: "#ffffff", align: "center", rotation: -8,
      bold: true, uppercase: true, fill: false, fillColor: "#ffffff", fillShape: "rect",
      lineHeight: 1.05, strokeWidth: 4, strokeColor: "#111111", shadowBlur: 6, shadowColor: "#000000",
    },
  },
]

export function validatePreset(raw) {
  if (!raw || typeof raw !== "object") return null
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name || name.length > 80) return null
  try {
    const style = projectStyle(raw.style)
    if (!style) return null
    return { name, style }
  } catch {
    return null
  }
}

export function mergePresets(existing = [], incoming = [], limit = MAX_GLOBAL_PRESETS) {
  const result = []
  const indexByName = new Map()
  for (const item of existing) {
    const valid = validatePreset(item)
    if (!valid) continue
    const key = valid.name.toLowerCase()
    if (indexByName.has(key)) {
      result[indexByName.get(key)] = valid
    } else if (result.length < limit) {
      indexByName.set(key, result.length)
      result.push(valid)
    }
  }
  for (const item of incoming) {
    const valid = validatePreset(item)
    if (!valid) continue
    const key = valid.name.toLowerCase()
    if (indexByName.has(key)) {
      result[indexByName.get(key)] = valid
    } else if (result.length < limit) {
      indexByName.set(key, result.length)
      result.push(valid)
    }
  }
  return result
}

export function loadGlobalPresets(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(GLOBAL_PRESETS_KEY)
    if (raw === null || raw === undefined) {
      return DEFAULT_STARTER_PRESETS.map((p) => validatePreset(p)).filter(Boolean)
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return mergePresets([], parsed)
  } catch {
    return []
  }
}

export function saveGlobalPresets(presets, storage = globalThis.localStorage) {
  const clean = mergePresets([], Array.isArray(presets) ? presets : [])
  try {
    storage?.setItem(GLOBAL_PRESETS_KEY, JSON.stringify(clean))
  } catch {
    // Ignore storage quota or private-mode errors.
  }
  return clean
}

export function serializePresetsJson(presets) {
  const clean = mergePresets([], Array.isArray(presets) ? presets : [])
  return JSON.stringify(
    {
      version: 1,
      app: "khung-thoai",
      exportedAt: new Date().toISOString(),
      presets: clean,
    },
    null,
    2,
  )
}

export function parsePresetsJson(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ""))
  } catch {
    throw new Error("Tệp mẫu dàn chữ không phải JSON hợp lệ.")
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.presets) ? parsed.presets : null
  if (!list) throw new Error("Tệp JSON không chứa danh sách mẫu dàn chữ (presets).")
  const valid = mergePresets([], list)
  if (!valid.length) throw new Error("Không tìm thấy mẫu dàn chữ hợp lệ nào trong tệp.")
  return valid
}
