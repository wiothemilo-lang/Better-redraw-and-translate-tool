import { imageMimeType, imageTypes } from "./io.js"
import { serializeLayers, validateLayers } from "./layers.js"
import { qaReviewEntryLimit, qaReviewVersion, validateQaReviewEntry } from "./qa-review.js"
import { validateRetouchStroke } from "./retouch.js"
import {
  translationMemoryEntryLimit,
  translationMemoryVersion,
  validateTranslationMemoryEntry,
} from "./translation-memory.js"
import { normalizeStyleGuide } from "./style-guide.js"
import { DEFAULT_EXPORT_PROFILE_ID } from "./export-presets.js"

export const projectExtension = ".khungthoai"
export const projectPageLimit = 50
export const projectSettingIds = ["script-text", "direction", "gemini-model", "source-language", "target-language", "translation-notes", "translation-glossary", "export-profile"]

const encoder = new TextEncoder()
// The header stores the UTF-8 manifest length. The original image bytes follow in page order.
const magic = encoder.encode("KHUNGTHOAI\n")
const headerSize = magic.length + 4
const manifestLimit = 16 * 1024 * 1024
const invalidProject = () => new Error("Cấu trúc tệp dự án Nixio không hợp lệ.")
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
    bubbleFit = false, warp = "none", warpAmount = 0,
    lineHeight = 1.15, strokeWidth = 0, strokeColor = "#ffffff",
    shadowBlur = 0, shadowColor = "#000000",
    fillColor = "#ffffff", fillShape = "rect",
  } = style ?? {}
  if (!inRange(size, 8, 400) || !isText(font) || !font.trim() || font.length > 80 || /[\u0000-\u001f"\\]/.test(font) ||
      !isText(color) || !/^#[\da-f]{6}$/i.test(color) || !["left", "center", "right"].includes(align) ||
      !inRange(rotation, -180, 180) || typeof fill !== "boolean" ||
      typeof bold !== "boolean" || typeof italic !== "boolean" || typeof uppercase !== "boolean" || typeof vertical !== "boolean" ||
      typeof bubbleFit !== "boolean" || !["none", "arc", "arcDown", "wave"].includes(warp) || !inRange(warpAmount, -50, 50) ||
      !inRange(lineHeight, .8, 2.2) || !inRange(strokeWidth, 0, 24) ||
      !isText(strokeColor) || !/^#[\da-f]{6}$/i.test(strokeColor) ||
      !inRange(shadowBlur, 0, 24) || !isText(shadowColor) || !/^#[\da-f]{6}$/i.test(shadowColor) ||
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
    ...(bubbleFit && { bubbleFit }),
    // A warp mode survives even at zero bend: the box is "curved" and the slider has somewhere to
    // go, whereas dropping the pair silently turned it back into plain text after a save.
    ...(warp !== "none" && { warp, warpAmount }),
    ...(lineHeight !== 1.15 && { lineHeight }),
    ...(strokeWidth > 0 && { strokeWidth, strokeColor }),
    ...(shadowBlur > 0 && { shadowBlur, shadowColor }),
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

// The stamp an incremental box job leaves behind: which source line the text came from, which
// glossary pairs applied, and the digest of every other input. It has to survive a save exactly,
// because the next run compares against it to decide what is stale. Only the shapes are checked —
// a long line or a large glossary must never make an otherwise valid project unsavable.
function projectStamp(stamp) {
  if (stamp === undefined) return undefined
  if (!isText(stamp?.hash) || !/^[0-9a-f]{8,32}$/.test(stamp.hash) ||
      !isText(stamp.source) || !isText(stamp.output) ||
      !Array.isArray(stamp.terms) ||
      !stamp.terms.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every(isText))) {
    throw invalidProject()
  }
  return { hash: stamp.hash, source: stamp.source, output: stamp.output, terms: stamp.terms.map((pair) => [pair[0], pair[1]]) }
}

function projectBox(box) {
  const { text, cleanup = false, cleanupMode = "auto", originalBox, cleanupRect, cleanupStrokes, cleanupExpand = 0, translationStamp } = box ?? {}
  if (!isText(text) || typeof cleanup !== "boolean" || !["auto", "content-aware"].includes(cleanupMode) ||
      !Number.isInteger(cleanupExpand) || Math.abs(cleanupExpand) > 8 ||
      (cleanupStrokes !== undefined && !Array.isArray(cleanupStrokes))) throw invalidProject()
  const stamp = projectStamp(translationStamp)
  return {
    ...rectangle(box), ...projectStyle(box), text, cleanup,
    ...(cleanupMode !== "auto" && { cleanupMode }),
    ...(originalBox && { originalBox: rectangle(originalBox) }),
    ...(cleanupRect && { cleanupRect: rectangle(cleanupRect) }),
    ...(cleanupExpand !== 0 && { cleanupExpand }),
    ...(cleanupStrokes && { cleanupStrokes: cleanupStrokes.map(projectStroke) }),
    ...(stamp && { translationStamp: stamp }),
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

// The translation memory is a project-level record: a file without one (version 1 and 2) opens with
// an empty store, and one invalid pair rejects the file instead of silently losing pairs.
function projectTranslationMemory(memory) {
  if (memory === undefined) return undefined
  if (memory?.version !== translationMemoryVersion ||
      !Array.isArray(memory.entries) || memory.entries.length > translationMemoryEntryLimit) {
    throw invalidProject()
  }
  return {
    version: memory.version,
    entries: memory.entries.map((entry) => {
      const valid = validateTranslationMemoryEntry(entry)
      if (!valid) throw invalidProject()
      return valid
    }),
  }
}

// The triage decisions are a project-level record like the memory: a file without one (version 1
// to 3) opens with an empty board, and one invalid decision rejects the file instead of silently
// dropping a review the user took.
function projectQaReview(review) {
  if (review === undefined) return undefined
  if (review?.version !== qaReviewVersion ||
      !Array.isArray(review.entries) || review.entries.length > qaReviewEntryLimit) {
    throw invalidProject()
  }
  const entries = review.entries.map((entry) => {
    const valid = validateQaReviewEntry(entry)
    if (!valid) throw invalidProject()
    return valid
  })
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw invalidProject()
  return { version: review.version, entries }
}

// A stroke keeps the layer it was painted into only when that layer is written too: the default
// stack has one retouch layer, which every stroke belongs to when no id is stored.
function strokeForLayer(stroke, stack) {
  if (!stroke.layerId) return stroke
  const known = stack?.some((layer) => layer.kind === "retouch" && layer.id === stroke.layerId)
  if (known) return stroke
  const { layerId, ...rest } = stroke
  return rest
}

function projectPage(page) {
  const { name, type, size, boxes, unplaced, retouchStrokes, layers, translationContext, translationJob } = page ?? {}
  if (!isText(name) || !name || !imageTypes.has(type) || !Number.isSafeInteger(size) || size <= 0 ||
      !Array.isArray(boxes) || !Array.isArray(unplaced) ||
      (retouchStrokes !== undefined && !Array.isArray(retouchStrokes))) {
    throw invalidProject()
  }
  const validLayers = validateLayers(layers)
  if (validLayers === null) throw invalidProject()
  // A stack that says nothing beyond the default is not written, so a project that never touched
  // the layers keeps claiming the version every build can read. Reading expands it again, which is
  // why the page carries the full stack and the manifest is compacted on the way out.
  const stack = serializeLayers(validLayers)
  const cleanedRetouch = retouchStrokes?.length
    ? retouchStrokes.map((stroke) => {
      const valid = validateRetouchStroke(stroke)
      if (!valid) throw invalidProject()
      return strokeForLayer(valid, stack)
    })
    : undefined
  return {
    name, type, size,
    boxes: boxes.map(projectBox),
    unplaced: unplaced.map(projectLine),
    ...(cleanedRetouch && { retouchStrokes: cleanedRetouch }),
    ...(validLayers && { layers: validLayers }),
    translationContext: projectContext(translationContext),
    translationJob: projectJob(translationJob),
  }
}

function projectStyleGuide(raw) {
  if (raw === undefined) return undefined
  try {
    return normalizeStyleGuide(raw, { strict: true }) ?? undefined
  } catch {
    throw invalidProject()
  }
}

function projectData({ pages, queue, settings, currentPage, fit, presets = [], projectId, templateId, defaultFont, translationMemory, styleGuide, qaReview }) {
  if (projectId !== undefined && (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId))) throw invalidProject()
  if (templateId !== undefined && (typeof templateId !== "string" || !templateId.trim() || templateId.length > 100)) throw invalidProject()
  if (defaultFont !== undefined && (typeof defaultFont !== "string" || !defaultFont.trim() || defaultFont.length > 100)) throw invalidProject()
  settings = { "translation-glossary": "", "export-profile": DEFAULT_EXPORT_PROFILE_ID, ...settings }
  if (!Array.isArray(pages) || pages.length > projectPageLimit ||
      !Array.isArray(queue) || !queue.every(isText) || !projectSettingIds.every((id) => isText(settings?.[id])) ||
      !Number.isInteger(currentPage) || (pages.length ? currentPage < 0 || currentPage >= pages.length : currentPage !== -1) ||
      typeof fit !== "boolean" || !Array.isArray(presets) ||
      !presets.every((preset) => isText(preset?.name) && preset.name.trim())) {
    throw invalidProject()
  }
  const memory = projectTranslationMemory(translationMemory)
  const guide = projectStyleGuide(styleGuide)
  const review = projectQaReview(qaReview)
  return { pages: pages.map(projectPage), queue, settings: Object.fromEntries(projectSettingIds.map((id) => [id, settings[id]])), currentPage, fit,
    ...(projectId && { projectId }),
    ...(templateId && { templateId }),
    ...(defaultFont && { defaultFont: defaultFont.trim() }),
    ...(memory && { translationMemory: memory }),
    ...(guide && { styleGuide: guide }),
    ...(review && { qaReview: review }),
    presets: presets.map(({ name, style }) => ({ name, style: projectStyle(style) })),
  }
}

export function writeProject(project) {
  const pages = project.pages.map(({ file, name, boxes, unplaced, retouchStrokes, layers, translationContext, translationJob }) => ({
    name, type: imageMimeType(name, file.type), size: file.size, boxes, unplaced,
    ...(retouchStrokes?.length && { retouchStrokes }),
    ...(layers?.length && { layers }),
    translationContext, translationJob,
  }))
  const data = projectData({ ...project, pages })
  // Only what differs from the default stack is written, so a page that never touched a layer name,
  // opacity or order keeps the shortest manifest — and a build that predates layers ignores nothing.
  const written = data.pages.map(({ layers, ...page }) => {
    const stack = layers && serializeLayers(layers)
    return stack ? { ...page, layers: stack } : page
  })
  // A file only claims the version it needs: triage decisions and layer stacks share version 4,
  // remembered pairs claim 3, and a project that used neither stays readable by builds predating both.
  const manifest = encoder.encode(JSON.stringify({
    version: data.qaReview?.entries.length || written.some((page) => page.layers?.length) ? 4
      : data.translationMemory?.entries.length || data.templateId ? 3 : 2,
    ...data,
    pages: written,
  }))
  if (manifest.length > manifestLimit) throw new Error("Dữ liệu biên tập của dự án vượt quá 16 MB.")
  const header = new Uint8Array(headerSize)
  header.set(magic)
  new DataView(header.buffer).setUint32(magic.length, manifest.length, true)
  return new Blob([header, manifest, ...project.pages.map(({ file }) => file)], { type: "application/octet-stream" })
}

// Reads only the header and manifest so recovery snapshots can be identified
// without decoding image payloads.
export async function readProjectIdentity(source) {
  try {
    if (!source || typeof source.size !== "number" || source.size < headerSize) return null
    const header = new Uint8Array(await source.slice(0, headerSize).arrayBuffer())
    if (header.length !== headerSize || !magic.every((byte, index) => header[index] === byte)) return null
    const length = new DataView(header.buffer).getUint32(magic.length, true)
    if (!length || length > manifestLimit || headerSize + length > source.size) return null
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await source.slice(headerSize, headerSize + length).arrayBuffer()))
    const projectId = typeof manifest?.projectId === "string" && /^[0-9a-f-]{36}$/i.test(manifest.projectId) ? manifest.projectId : null
    return {
      projectId,
      version: Number.isInteger(manifest?.version) ? manifest.version : 0,
      pageCount: Array.isArray(manifest?.pages) ? manifest.pages.length : 0,
    }
  } catch {
    return null
  }
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
  if (![1, 2, 3, 4].includes(manifest.version)) throw new Error("Phiên bản tệp dự án này chưa được hỗ trợ.")
  const project = projectData(manifest)
  if (project.pages.reduce((total, page) => total + page.size, offset) !== file.size) throw invalidProject()
  const pages = project.pages.map(({ name, type, size, ...page }) => {
    const bytes = file.slice(offset, offset + size)
    offset += size
    return { ...page, file: new File([bytes], name, { type }) }
  })
  return { ...project, pages }
}
