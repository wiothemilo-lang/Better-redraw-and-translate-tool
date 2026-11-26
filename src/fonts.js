export const builtInFonts = ["Arial", "Georgia", "Verdana", "Times New Roman"]
const psdFontMap = {
  Arial: "ArialMT",
  Georgia: "Georgia",
  Verdana: "Verdana",
  "Times New Roman": "TimesNewRomanPSMT",
}
const customFonts = new Set()
const fontExtensions = /\.(ttf|otf|woff2?)$/i

export function allFonts() {
  return [...builtInFonts, ...customFonts]
}

export function registerFontName(name) {
  if (typeof name !== "string") return null
  const clean = name.trim().replace(/[\u0000-\u001f"\\]/g, "").slice(0, 80)
  if (!clean) return null
  if (!builtInFonts.includes(clean)) customFonts.add(clean)
  return clean
}

export function psdFontName(font) {
  return psdFontMap[font] ?? (font.replace(/[^a-zA-Z0-9_-]/g, "") || "ArialMT")
}

export async function loadCustomFont(file) {
  if (!file || !fontExtensions.test(file.name)) throw new Error("Chọn tệp font TTF, OTF, WOFF hoặc WOFF2.")
  if (file.size > 15 * 1024 * 1024) throw new Error("Tệp font vượt quá 15 MB.")
  if (typeof FontFace === "undefined" || !document?.fonts) throw new Error("Trình duyệt không hỗ trợ nạp font cục bộ.")
  const family = registerFontName(file.name.replace(fontExtensions, "").replace(/[_-]+/g, " "))
  if (!family) throw new Error("Tên font không hợp lệ.")
  const face = new FontFace(family, await file.arrayBuffer())
  const loaded = await face.load()
  document.fonts.add(loaded)
  return family
}
