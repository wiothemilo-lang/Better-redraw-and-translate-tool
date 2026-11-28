import { DEFAULT_STARTER_PRESETS, mergePresets } from "./presets.js"

export const PROJECT_TEMPLATES_KEY = "khung-thoai-project-templates"
export const MAX_PROJECT_TEMPLATES = 40
export const TEMPLATE_NAME_LIMIT = 80
// A template never carries the script text: that is page content, not a default.
export const TEMPLATE_SETTING_IDS = [
  "direction",
  "gemini-model",
  "source-language",
  "target-language",
  "translation-notes",
  "translation-glossary",
]
export const TEMPLATE_EXPORT_FORMATS = ["png", "psd", "raster"]

const isText = (value) => typeof value === "string"
const templateName = (value) => (isText(value) ? value.trim() : "")
const validFontName = (value) =>
  isText(value) && value.trim() && value.trim().length <= 80 && !/[\u0000-\u001f"\\]/.test(value)

function templateSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const settings = {}
  for (const id of TEMPLATE_SETTING_IDS) {
    if (isText(raw[id])) settings[id] = raw[id]
  }
  return settings
}

function templateExportProfile(raw) {
  const format = raw?.format
  return TEMPLATE_EXPORT_FORMATS.includes(format) ? { format } : undefined
}

export function validateTemplate(raw) {
  if (!raw || typeof raw !== "object") return null
  const name = templateName(raw.name)
  if (!name || name.length > TEMPLATE_NAME_LIMIT) return null
  const settings = templateSettings(raw.settings)
  const presets = mergePresets([], Array.isArray(raw.presets) ? raw.presets : [])
  const font = validFontName(raw.font) ? raw.font.trim() : undefined
  const exportProfile = templateExportProfile(raw.exportProfile)
  const fit = typeof raw.fit === "boolean" ? raw.fit : undefined
  const id = isText(raw.id) && raw.id.trim() && raw.id.trim().length <= 80 ? raw.id.trim() : crypto.randomUUID()
  return {
    id,
    name,
    settings,
    presets,
    ...(fit !== undefined && { fit }),
    ...(font && { font }),
    ...(exportProfile && { exportProfile }),
  }
}

const templateKey = (name) => templateName(name).toLowerCase()

// Dedupe by name the way presets do: a later entry replaces an earlier user
// template, but nothing replaces a catalog entry — user templates never shadow
// the built-in list.
export function mergeTemplates(existing = [], incoming = [], limit = MAX_PROJECT_TEMPLATES) {
  const result = [...existing]
  const indexByName = new Map(result.map((item, index) => [templateKey(item.name), index]))
  for (const item of incoming) {
    const valid = validateTemplate(item)
    if (!valid) continue
    const key = templateKey(valid.name)
    const at = indexByName.get(key)
    if (at !== undefined) {
      if (!result[at].builtin) result[at] = valid
      continue
    }
    if (result.length >= limit) continue
    indexByName.set(key, result.length)
    result.push(valid)
  }
  return result
}

export function upsertTemplate(list, template, { overwrite = false } = {}) {
  const clean = validateTemplate(template)
  if (!clean) throw new Error("Mẫu dự án không hợp lệ.")
  const key = templateKey(clean.name)
  const at = list.findIndex((item) => templateKey(item.name) === key)
  if (at >= 0) {
    if (list[at].builtin)
      throw new Error(`"${clean.name}" là mẫu dựng sẵn chỉ đọc. Hãy đổi tên mẫu mới.`)
    if (!overwrite) throw new Error(`Đã có mẫu tên "${clean.name}". Đổi tên hoặc chọn Ghi đè.`)
    const next = [...list]
    next[at] = { ...clean, id: list[at].id }
    return next
  }
  if (list.length >= MAX_PROJECT_TEMPLATES)
    throw new Error(`Đã đạt tối đa ${MAX_PROJECT_TEMPLATES} mẫu dự án.`)
  return [...list, clean]
}

export function renameTemplate(list, name, newName) {
  const next = templateName(newName)
  if (!next || next.length > TEMPLATE_NAME_LIMIT)
    throw new Error("Tên mẫu mới không hợp lệ.")
  const at = list.findIndex((item) => templateKey(item.name) === templateKey(name))
  if (at < 0) throw new Error(`Không tìm thấy mẫu "${templateName(name)}".`)
  if (list[at].builtin) throw new Error("Mẫu dựng sẵn không đổi tên được.")
  if (list.some((item, index) => index !== at && templateKey(item.name) === templateKey(next)))
    throw new Error(`Đã có mẫu tên "${next}".`)
  const renamed = [...list]
  renamed[at] = { ...list[at], name: next }
  return renamed
}

export function overwriteTemplate(list, name, template) {
  const at = list.findIndex((item) => templateKey(item.name) === templateKey(name))
  if (at < 0) throw new Error(`Không tìm thấy mẫu "${templateName(name)}".`)
  if (list[at].builtin)
    throw new Error(`"${list[at].name}" là mẫu dựng sẵn chỉ đọc. Hãy lưu thiết lập thành mẫu mới.`)
  return upsertTemplate(list, { ...template, name: list[at].name }, { overwrite: true })
}

export function removeTemplate(list, name) {
  const at = list.findIndex((item) => templateKey(item.name) === templateKey(name))
  if (at < 0) throw new Error(`Không tìm thấy mẫu "${templateName(name)}".`)
  if (list[at].builtin) throw new Error("Không xóa được mẫu dựng sẵn.")
  return list.filter((_, index) => index !== at)
}

export function templateByName(list, name) {
  const key = templateKey(name)
  return list.find((item) => templateKey(item.name) === key) ?? null
}

const MANGA_PRESETS = DEFAULT_STARTER_PRESETS

const MANHWA_PRESETS = [
  {
    name: "Thoại Manhwa",
    style: {
      size: 26, font: "Arial", color: "#1f2430", align: "left", rotation: 0,
      fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.2, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Suy nghĩ (Manhwa)",
    style: {
      size: 24, font: "Georgia", color: "#39404f", align: "left", rotation: 0,
      italic: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.25, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Hét / Nhấn mạnh",
    style: {
      size: 34, font: "Arial", color: "#10131a", align: "center", rotation: 0,
      bold: true, uppercase: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.05, strokeWidth: 3, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Chú thích (Webtoon)",
    style: {
      size: 18, font: "Arial", color: "#5a6272", align: "left", rotation: 0,
      italic: true, fill: false, fillColor: "#ffffff", fillShape: "rect", bubbleFit: false,
      lineHeight: 1.3, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
]

const FOUR_KOMA_PRESETS = [
  {
    name: "Thoại 4-koma",
    style: {
      size: 20, font: "Arial", color: "#22252d", align: "center", rotation: 0,
      fill: true, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.15, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Độc thoại (4-koma)",
    style: {
      size: 18, font: "Georgia", color: "#3a3f4b", align: "center", rotation: 0,
      italic: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.2, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Ông thoại cụ",
    style: {
      size: 22, font: "Arial", color: "#17191f", align: "left", rotation: 0,
      fill: false, fillColor: "#ffffff", fillShape: "rect", bubbleFit: false,
      lineHeight: 1.15, strokeWidth: 1, strokeColor: "#9aa1b0", shadowBlur: 0, shadowColor: "#000000",
    },
  },
]

const WEBTOON_PRESETS = [
  {
    name: "Thoại Webtoon",
    style: {
      size: 30, font: "Arial", color: "#20242e", align: "left", rotation: 0,
      fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.25, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Suy nghĩ dài",
    style: {
      size: 26, font: "Georgia", color: "#39404f", align: "left", rotation: 0,
      italic: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.35, strokeWidth: 0, strokeColor: "#ffffff", shadowBlur: 0, shadowColor: "#000000",
    },
  },
  {
    name: "Hét (Webtoon)",
    style: {
      size: 40, font: "Arial", color: "#10131a", align: "center", rotation: 0,
      bold: true, uppercase: true, fill: false, fillColor: "#ffffff", fillShape: "ellipse", bubbleFit: true,
      lineHeight: 1.05, strokeWidth: 4, strokeColor: "#10131a", shadowBlur: 0, shadowColor: "#000000",
    },
  },
]

const BUILTIN_TEMPLATE_DRAFTS = [
  {
    id: "manga-bw-jp-vi",
    name: "Manga trắng đen (Nhật → Việt)",
    settings: {
      direction: "rtl",
      "gemini-model": "auto",
      "source-language": "Japanese",
      "target-language": "Vietnamese",
      "translation-notes": "Giữ tên riêng và xưng hô theo nguyên tác. Không dịch sound effect trong ngoặc.",
      "translation-glossary": "",
    },
    presets: MANGA_PRESETS,
    fit: true,
    font: "Arial",
    exportProfile: { format: "png" },
  },
  {
    id: "manhwa-kr-en",
    name: "Manhwa (Hàn → Anh)",
    settings: {
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Korean",
      "target-language": "English",
      "translation-notes": "Dịch sang tiếng Anh tự nhiên, giữ nhịp đọc webtoon. Danh xưng Hàn (씨, 님) chuyển thành hậu tố tiếng Anh phù hợp.",
      "translation-glossary": "김독자 = Kim Dokja\n@alias 독자님 = Dokja-nim\n성진우 = Sung Jinwoo",
    },
    presets: MANHWA_PRESETS,
    fit: true,
    font: "Arial",
    exportProfile: { format: "png" },
  },
  {
    id: "four-koma",
    name: "4-koma (Nhật → Việt)",
    settings: {
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Japanese",
      "target-language": "Vietnamese",
      "translation-notes": "Truyện ngắn 4 ô: câu dịch phải ngắn gọn để vừa ô nhỏ, giữ nhịp đấm gió và phản ứng của nhân vật.",
      "translation-glossary": "",
    },
    presets: FOUR_KOMA_PRESETS,
    fit: true,
    font: "Arial",
    exportProfile: { format: "png" },
  },
  {
    id: "webtoon-strip",
    name: "Webtoon dọc (cắt dải)",
    settings: {
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Korean",
      "target-language": "English",
      "translation-notes": "Trang dài cắt theo rãnh: ưu tiên thoại chính, chú thích nhỏ để nghiêng. Giữ tên riêng theo bản Latin hóa.",
      "translation-glossary": "",
    },
    presets: WEBTOON_PRESETS,
    fit: true,
    font: "Arial",
    exportProfile: { format: "psd" },
  },
]

export const BUILTIN_PROJECT_TEMPLATES = BUILTIN_TEMPLATE_DRAFTS.map((draft) => ({
  ...validateTemplate(draft),
  builtin: true,
})).filter((template) => template && template.name)

export function loadProjectTemplates(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PROJECT_TEMPLATES_KEY)
    if (raw === null || raw === undefined) return [...BUILTIN_PROJECT_TEMPLATES]
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.templates) ? parsed.templates : null
    if (!list) return [...BUILTIN_PROJECT_TEMPLATES]
    // Stored entries merge over the catalog: a name that matches a builtin is
    // dropped so user data can never shadow the built-in list.
    return mergeTemplates(BUILTIN_PROJECT_TEMPLATES, list)
  } catch {
    return [...BUILTIN_PROJECT_TEMPLATES]
  }
}

export function saveProjectTemplates(templates, storage = globalThis.localStorage) {
  const user = mergeTemplates(
    [],
    (Array.isArray(templates) ? templates : []).filter((item) => item && !item.builtin),
  )
  try {
    storage?.setItem(
      PROJECT_TEMPLATES_KEY,
      JSON.stringify({ version: 1, app: "nixio", templates: user }),
    )
  } catch {
    // Ignore storage quota or private-mode errors.
  }
  return [...BUILTIN_PROJECT_TEMPLATES, ...user]
}

export function serializeProjectTemplatesJson(templates) {
  const clean = mergeTemplates(
    [],
    (Array.isArray(templates) ? templates : []).map((item) =>
      item?.builtin ? { ...item, builtin: undefined } : item,
    ),
  )
  return JSON.stringify(
    {
      version: 1,
      app: "nixio",
      exportedAt: new Date().toISOString(),
      templates: clean,
    },
    null,
    2,
  )
}

export function parseProjectTemplatesJson(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ""))
  } catch {
    throw new Error("Tệp mẫu dự án không phải JSON hợp lệ.")
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.templates) ? parsed.templates : null
  if (!list) throw new Error("Tệp JSON không chứa danh sách mẫu dự án (templates).")
  const valid = mergeTemplates([], list)
  if (!valid.length) throw new Error("Không tìm thấy mẫu dự án hợp lệ nào trong tệp.")
  return valid
}
