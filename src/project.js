import { imageMimeType, imageTypes } from "./io.js"
import { validateRetouchStroke } from "./retouch.js"

export const projectExtension = ".khungthoai"
export const projectPageLimit = 50
export const projectSettingIds = ["script-text", "direction", "gemini-model", "source-language", "target-language", "translation-notes", "translation-glossary"]

const encoder = new TextEncoder()
// The header stores the UTF-8 manifest length. The original image bytes follow in page order.
const magic = encoder.encode("KHUNGTHOAI\n")
const headerSize = magic.length + 4
const manifestLimit = 16 * 1024 * 1024
const invalidProject = () => new Error("Cấu trúc tệp dự án Khung Thoại không hợp lệ.")
const isText = (value) => typeof value === "string"
const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max

function rectangle(rect) {
  const { x, y, w, h } = rect ?? {}
  if (![x, y, w, h].every(isFraction) || w === 0 || h === 0 || x + w > 1 + Number.EPSILON || y + h > 1 + Number.EPSILON) {
    throw invalidProject()
  }
  return { x, y, w, h }
}

export function projectStyle(style) {
  const {
    size, font, color, align, rotation, fill,
    bold = false, italic = false, uppercase = false, vertical = false,
    lineHeight = 1.15, strokeWidth = 0, strokeColor = "#ffffff",
    fillColor = "#ffffff", fillShape = "rect",
  } = style ?? {}
  if (!inRange(size, 8, 400) || !isText(font) || !font.trim() || font.length > 80 || /[\u0000-\u001f"\\]/.test(font) ||
      !isText(color) || !/^#[\da-f]{6}$/i.test(color) || !["left", "center", "right"].includes(align) ||
      !inRange(rotation, -180, 180) || typeof fill !== "boolean" ||
      typeof bold !== "boolean" || typeof italic !== "boolean" || typeof uppercase !== "boolean" || typeof vertical !== "boolean" ||
      !inRange(lineHeight, .8, 2.2) || !inRange(strokeWidth, 0, 24) ||
      !isText(strokeColor) || !/^#[\da-f]{6}$/i.test(strokeColor) ||
      !isText(fillColor) || !/^#[\da-f]{6}$/i.test(fillColor) ||
      !["rect", "ellipse", "rounded"].includes(fillShape)) {
    throw invalidProject()
  }
  return {
    size, font: font.trim(), color, align, rotation, fill,
    ...(bold && { bold }),
    ...(italic && { italic }),
    ...(uppercase && { uppercase }),
    ...(vertical && { vertical }),
    ...(lineHeight !== 1.15 && { lineHeight }),
    ...(strokeWidth > 0 && { strokeWidth, strokeColor }),
    ...(fillColor.toLowerCase() !== "#ffffff" && { fillColor }),
    ...(fillShape !== "rect" && { fillShape }),
  }
}

function projectStroke(stroke) {
  if (!["erase", "restore"].includes(stroke?.mode) || !inRange(stroke.size, .00001, 200) ||
      !Array.isArray(stroke.points) || !stroke.points.length ||
      !stroke.points.every((point) => isFraction(point?.x) && isFraction(point.y))) throw invalidProject()
  return { mode: stroke.mode, size: stroke.size, points: stroke.points.map(({ x, y }) => ({ x, y })) }
}

function projectBox(box) {
  const { text, cleanup = false, originalBox, cleanupRect, cleanupStrokes, cleanupExpand = 0 } = box ?? {}
  if (!isText(text) || typeof cleanup !== "boolean" || !Number.isInteger(cleanupExpand) || Math.abs(cleanupExpand) > 8 ||
      (cleanupStrokes !== undefined && !Array.isArray(cleanupStrokes))) throw invalidProject()
  return {
    ...rectangle(box), ...projectStyle(box), text, cleanup,
    ...(originalBox && { originalBox: rectangle(originalBox) }),
    ...(cleanupRect && { cleanupRect: rectangle(cleanupRect) }),
    ...(cleanupExpand !== 0 && { cleanupExpand }),
    ...(cleanupStrokes && { cleanupStrokes: cleanupStrokes.map(projectStroke) }),
  }
}

function projectJob(job) {
  if (job === undefined) return undefined
  if (!["pending", "running", "done", "error"].includes(job?.state) ||
      !["translate", "align"].includes(job.kind) || !isText(job.signature) ||
      (job.error !== undefined && !isText(job.error))) throw invalidProject()
  return { kind: job.kind, signature: job.signature, state: job.state === "running" ? "pending" : job.state, error: job.error }
}

function projectLine(line) {
  const { id, text, source, box } = line ?? {}
  if (!isText(id) || !isText(text) || (source !== undefined && !isText(source)) ||
      (box !== null && (!Array.isArray(box) || box.length !== 4 ||
        !box.every((value) => Number.isInteger(value) && inRange(value, 0, 1000)) ||
        box[2] <= box[0] || box[3] <= box[1]))) {
    throw invalidProject()
  }
  return { id, text, source, box }
}

function projectContext(context) {
  if (context === undefined) return undefined
  if (!isText(context?.signature) || !Array.isArray(context.lines) || context.lines.length > 8 ||
      !context.lines.every((line) => isText(line?.source) && isText(line.text))) {
    throw invalidProject()
  }
  return { signature: context.signature, lines: context.lines.map(({ source, text }) => ({ source, text })) }
}

function projectPage(page) {
  const { name, type, size, boxes, unplaced, retouchStrokes, translationContext, translationJob } = page ?? {}
  if (!isText(name) || !name || !imageTypes.has(type) || !Number.isSafeInteger(size) || size <= 0 ||
      !Array.isArray(boxes) || !Array.isArray(unplaced) ||
      (retouchStrokes !== undefined && !Array.isArray(retouchStrokes))) {
    throw invalidProject()
  }
  const cleanedRetouch = retouchStrokes?.length
    ? retouchStrokes.map((stroke) => {
      const valid = validateRetouchStroke(stroke)
      if (!valid) throw invalidProject()
      return valid
    })
    : undefined
  return {
    name, type, size,
    boxes: boxes.map(projectBox),
    unplaced: unplaced.map(projectLine),
    ...(cleanedRetouch && { retouchStrokes: cleanedRetouch }),
    translationContext: projectContext(translationContext),
    translationJob: projectJob(translationJob),
  }
}

function projectData({ pages, queue, settings, currentPage, fit, presets = [] }) {
  settings = { "translation-glossary": "", ...settings }
  if (!Array.isArray(pages) || pages.length > projectPageLimit ||
      !Array.isArray(queue) || !queue.every(isText) || !projectSettingIds.every((id) => isText(settings?.[id])) ||
      !Number.isInteger(currentPage) || (pages.length ? currentPage < 0 || currentPage >= pages.length : currentPage !== -1) ||
      typeof fit !== "boolean" || !Array.isArray(presets) ||
      !presets.every((preset) => isText(preset?.name) && preset.name.trim())) {
    throw invalidProject()
  }
  return { pages: pages.map(projectPage), queue, settings: Object.fromEntries(projectSettingIds.map((id) => [id, settings[id]])), currentPage, fit,
    presets: presets.map(({ name, style }) => ({ name, style: projectStyle(style) })),
  }
}

export function writeProject(project) {
  const pages = project.pages.map(({ file, name, boxes, unplaced, retouchStrokes, translationContext, translationJob }) => ({
    name, type: imageMimeType(name, file.type), size: file.size, boxes, unplaced,
    ...(retouchStrokes?.length && { retouchStrokes }),
    translationContext, translationJob,
  }))
  const manifest = encoder.encode(JSON.stringify({ version: 2, ...projectData({ ...project, pages }) }))
  if (manifest.length > manifestLimit) throw new Error("Dữ liệu biên tập của dự án vượt quá 16 MB.")
  const header = new Uint8Array(headerSize)
  header.set(magic)
  new DataView(header.buffer).setUint32(magic.length, manifest.length, true)
  return new Blob([header, manifest, ...project.pages.map(({ file }) => file)], { type: "application/octet-stream" })
}

export async function readProject(file) {
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  if (header.length !== headerSize || !magic.every((byte, index) => header[index] === byte)) throw invalidProject()
  const length = new DataView(header.buffer).getUint32(magic.length, true)
  let offset = headerSize + length
  if (!length || length > manifestLimit || offset > file.size) throw invalidProject()

  let manifest
  try {
    const bytes = await file.slice(headerSize, offset).arrayBuffer()
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw invalidProject()
  }
  if (!Number.isInteger(manifest?.version) || manifest.version < 1) throw invalidProject()
  if (![1, 2].includes(manifest.version)) throw new Error("Phiên bản tệp dự án này chưa được hỗ trợ.")
  const project = projectData(manifest)
  if (project.pages.reduce((total, page) => total + page.size, offset) !== file.size) throw invalidProject()
  const pages = project.pages.map(({ name, type, size, ...page }) => {
    const bytes = file.slice(offset, offset + size)
    offset += size
    return { ...page, file: new File([bytes], name, { type }) }
  })
  return { ...project, pages }
}
