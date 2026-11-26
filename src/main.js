import { autoFitBox, clamp, drawPage, exportPage, makeBox, textOverflows, nativePageLayers } from "./canvas.js"
import { allFonts, loadCustomFont, registerFontName } from "./fonts.js"
import { filenameStem, groupDialogue, isImageFile, readDialogueFile, saveFile } from "./io.js"
import { alignScript, translateImage } from "./gemini.js"
import { setupLibrary } from "./library.js"
import { matchDialogue, toCoordinates, toRectangle, overlapScore } from "./placement.js"
import { projectExtension, projectPageLimit as pageLimit, projectSettingIds, readProject, writeProject, projectStyle } from "./project.js"

import { copyEditor, EditHistory } from "./history.js"
import { cleanupRectangle, paintCleanupMask } from "./cleanup.js"
import { samplePixelColor } from "./retouch.js"
import { duplicateBox, exportDialogueScript, findMatches, nudgeBox, reorderBox, replaceMatches, resizeBox, rotateBox } from "./tools.js"
import { remainingTranslations, translationLabel, translationSignature } from "./translation.js"
import { clearWebSnapshot, getWebSnapshotInfo, loadWebSnapshot, saveWebSnapshot } from "./web-storage.js"

import { desktop, nativeCapabilities, saveDesktopProject, openDesktopProject, imagePixels } from "./native.js"

const history = new EditHistory()
const ownedUrls = new Set()
const byId = (id) => document.getElementById(id)
const stage = byId("stage")
const viewport = byId("viewport")
const overlays = byId("overlays")
const pageCanvas = byId("page-canvas")
const form = byId("box-form")
const editorStatus = byId("status")
const exportButtons = [...document.querySelectorAll("[data-export]")]
const state = {
  pages: [], presets: [], pageId: null, boxId: null, queue: [], placing: false, fit: true, zoom: 1, compareOriginal: false,
  exporting: false, importing: false, translating: false, importingScript: false, openingProject: false, processingNative: false, savingProject: false,
}
const projectSettings = projectSettingIds.map(byId)
const defaultProjectSettings = projectSettings.map(({ value }) => value)
const projectFile = byId("project-file")
let projectName
let gesture
let pendingPaint
let pendingOverlay
let previewRedraw
let translationController
let nativeReady = false
let nativeLanguages = []
let revision = 0
let savedRevision = 0
let autosaving = false
let cloneOrigin = null
let spacePan = false
let formEditSnapshot = null
let formEditBoxId = null

const selectedPage = () => state.pages.find((page) => page.id === state.pageId)
const selectedBox = () => selectedPage()?.boxes.find((box) => box.id === state.boxId)
const selectedIndex = () => state.pages.findIndex((page) => page.id === state.pageId)
const boxFields = { text: "box-text", size: "box-size", font: "box-font", color: "box-color", align: "box-align", rotation: "box-rotation" }
const resizeHandles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

function editorSnapshot() {
  return copyEditor({
    pages: state.pages, queue: state.queue, presets: state.presets,
    pageId: state.pageId, boxId: state.boxId,
    settings: Object.fromEntries(projectSettings.map(({ id, value }) => [id, value])),
  })
}

function releaseUnusedImages() {
  const snapshots = [state, ...history.past, ...history.future]
  const used = new Set(snapshots.flatMap(({ pages }) => pages.map(({ url }) => url)))
  for (const url of ownedUrls) {
    if (used.has(url)) continue
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
  }
}

function checkpoint(snapshot = editorSnapshot()) {
  revision++
  history.record(snapshot)
  syncProjectActions()
}

function restoreHistory(direction) {
  if (projectBusy() || gesture) return
  commitLiveFormCheckpoint()
  const snapshot = history[direction](editorSnapshot())
  if (!snapshot) return
  const { settings, ...editor } = snapshot
  revision++
  Object.assign(state, editor, { placing: false })
  projectSettings.forEach((field) => { field.value = settings[field.id] })
  render()
  releaseUnusedImages()
  status(direction === "undo" ? "Đã hoàn tác." : "Đã làm lại.")
}

byId("undo").onclick = () => restoreHistory("undo")
byId("redo").onclick = () => restoreHistory("redo")
document.addEventListener("keydown", (event) => {
  const editingField = Boolean(event.target.closest("input, textarea, select, [contenteditable]"))
  if (event.code === "Space" && !editingField && !event.repeat && selectedPage()) {
    spacePan = true
    stage.classList.add("panning")
    event.preventDefault()
    return
  }
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (!editingField && (key === "z" || key === "y")) {
      event.preventDefault()
      restoreHistory(key === "y" || event.shiftKey ? "redo" : "undo")
      return
    }
    if (!editingField && key === "d" && selectedBox()) {
      event.preventDefault()
      duplicateSelectedBox()
      return
    }
    if (key === "h" || (key === "f" && !editingField)) {
      event.preventDefault()
      openFindDialog()
      return
    }
  }
  if (editingField || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === "\\") {
    if (!selectedPage()) return
    event.preventDefault()
    toggleCompareOriginal()
  } else if (event.key === "?") {
    event.preventDefault()
    byId("shortcuts-dialog").showModal()
  } else if ((event.key === "Delete" || event.key === "Backspace") && selectedBox() && !projectBusy()) {
    event.preventDefault()
    deleteSelectedBox()
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && selectedBox() && !projectBusy()) {
    const page = selectedPage()
    const box = selectedBox()
    if (!page || !box) return
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    const dx = event.key === "ArrowLeft" ? -step / page.image.naturalWidth : event.key === "ArrowRight" ? step / page.image.naturalWidth : 0
    const dy = event.key === "ArrowUp" ? -step / page.image.naturalHeight : event.key === "ArrowDown" ? step / page.image.naturalHeight : 0
    checkpoint()
    Object.assign(box, nudgeBox(box, dx, dy))
    renderCanvas()
    renderInspector()
  }
})
document.addEventListener("keyup", (event) => {
  if (event.code === "Space" && spacePan) {
    spacePan = false
    if (byId("cleanup-tool").value !== "pan") stage.classList.remove("panning")
  }
})
window.addEventListener("blur", () => {
  spacePan = false
  if (byId("cleanup-tool").value !== "pan") stage.classList.remove("panning")
})
for (const field of projectSettings) {
  field.addEventListener("input", () => { revision++ })
  let before
  field.addEventListener("focus", () => { before = editorSnapshot() })
  field.addEventListener("change", () => {
    if (before && before.settings[field.id] !== field.value) checkpoint(before)
    before = editorSnapshot()
    syncTranslationActions()
  })
}

function status(message, error = false) {
  editorStatus.textContent = message
  editorStatus.toggleAttribute("data-error", error)
}

function listButton(text, onClick, label = text) {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = text
  button.setAttribute("aria-label", label)
  button.onclick = onClick
  return button
}

function setView() {
  const library = location.hash === "#library"
  byId("editor").hidden = library
  byId("library").hidden = !library
  document.querySelectorAll("nav a[data-view]").forEach((link) => {
    if ((link.dataset.view === "library") === library) link.setAttribute("aria-current", "page")
    else link.removeAttribute("aria-current")
  })
}
window.addEventListener("hashchange", setView)
setView()

function selectPage(page) {
  commitLiveFormCheckpoint()
  if (gesture?.before) {
    const { settings, ...editor } = gesture.before
    Object.assign(state, editor)
    page = state.pages.find((item) => item.id === page?.id)
  }
  state.pageId = page?.id ?? null
  state.boxId = null
  state.placing = false
  gesture = undefined
  cloneOrigin = null
  render()
}

function changePage(delta) {
  const page = state.pages[selectedIndex() + delta]
  if (page) selectPage(page)
}

function movePage(index, delta) {
  if (projectBusy()) return
  const target = index + delta
  if (target < 0 || target >= state.pages.length) return
  checkpoint()
  const [page] = state.pages.splice(index, 1)
  state.pages.splice(target, 0, page)
  renderPages()
  const button = document.getElementById("move-" + page.id + "-" + delta)
  const fallback = document.getElementById("move-" + page.id + "-" + -delta)
  ;(button && !button.disabled ? button : fallback)?.focus()
}

function removePage(index) {
  if (projectBusy()) return
  checkpoint()
  const [page] = state.pages.splice(index, 1)
  if (!page) return
  if (page.id === state.pageId) selectPage(state.pages[Math.min(index, state.pages.length - 1)])
  else renderPages()
  status("Đã bỏ " + page.name + ".")
}

function projectBusy() {
  return state.openingProject || state.importing || state.importingScript || state.translating || state.exporting || state.processingNative || state.savingProject
}

function syncProjectActions() {
  byId("undo").disabled = projectBusy() || !history.past.length
  byId("redo").disabled = projectBusy() || !history.future.length
  byId("open-project").disabled = projectBusy()
  byId("save-project").disabled = projectBusy()
  byId("images").disabled = projectBusy()
  byId("script-file").disabled = projectBusy()
}

function syncTranslationActions() {
  byId("resume-translation").disabled = projectBusy() || !remainingTranslations(state.pages, readTranslationSettings()).length
  byId("pages").querySelectorAll(".page-job").forEach((element, index) => {
    const page = state.pages[index]
    element.dataset.state = page.translationJob?.state ?? "pending"
    element.textContent = translationLabel(page, readTranslationSettings())
  })
}

function renderPages() {
  const current = selectedIndex()
  const count = state.pages.length
  if (!state.importing && !state.openingProject) releaseUnusedImages()
  byId("page-count").textContent = count + " / " + pageLimit
  byId("page-indicator").textContent = current === -1 ? "Chưa có trang" : `Trang ${current + 1} / ${count}`
  byId("prev-page").disabled = current <= 0
  byId("next-page").disabled = current < 0 || current >= count - 1
  byId("apply-script").disabled = current < 0 || projectBusy()
  byId("export-script").disabled = !count || projectBusy()
  byId("translate").disabled = current < 0 || projectBusy()
  byId("align-script").disabled = current < 0 || projectBusy()
  byId("translate-all").disabled = !count || projectBusy()
  byId("zoom-out").disabled = current < 0
  byId("zoom-in").disabled = current < 0
  byId("fit-page").disabled = current < 0
  byId("compare-original").disabled = current < 0
  byId("add-box").disabled = current < 0 || projectBusy()
  byId("export-all").disabled = !count || projectBusy()
  exportButtons.forEach((button) => { button.disabled = current < 0 || projectBusy() })
  byId("autofit-page").disabled = current < 0 || !(selectedPage()?.boxes.length) || projectBusy()
  byId("clear-retouch").hidden = !(selectedPage()?.retouchStrokes?.length)
  byId("clear-retouch").disabled = projectBusy()
  syncProjectActions()
  byId("box-form").inert = projectBusy()
  projectSettings.forEach((field) => { field.disabled = state.translating || state.openingProject })
  byId("resume-translation").disabled = projectBusy() || !remainingTranslations(state.pages, readTranslationSettings()).length
  byId("stop-translation").disabled = !state.translating
  renderPresets()
  byId("check-export").disabled = projectBusy()
  byId("preview-ocr").disabled = projectBusy() || current < 0 || !nativeReady
  byId("run-local-ocr").disabled = projectBusy() || current < 0 || !nativeLanguages.length
  byId("cleanup-expand").disabled = projectBusy()
  byId("pages").replaceChildren(...state.pages.map((page, index) => {
    const li = document.createElement("li")
    const button = listButton(`${index + 1}. ${page.name}`, () => selectPage(page))
    button.className = "page-name"
    if (current === index) button.setAttribute("aria-current", "true")
    const up = listButton("↑", () => movePage(index, -1), "Đưa lên " + page.name)
    up.disabled = index === 0 || projectBusy()
    up.id = "move-" + page.id + "--1"
    const down = listButton("↓", () => movePage(index, 1), "Đưa xuống " + page.name)
    down.disabled = index === count - 1 || projectBusy()
    down.id = "move-" + page.id + "-1"
    const remove = listButton("×", () => removePage(index), "Bỏ " + page.name)
    remove.disabled = projectBusy()
    const job = document.createElement("span")
    job.className = "page-job"
    job.dataset.state = page.translationJob?.state ?? "pending"
    job.textContent = translationLabel(page, readTranslationSettings())
    li.append(button, up, down, remove, job)
    return li
  }))
}

function rectStyle(element, rect) {
  for (const [name, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })) {
    element.style[name] = value * 100 + "%"
  }
  element.style.transform = rect.rotation ? "rotate(" + rect.rotation + "deg)" : ""
}

function paintPreview(page) {
  const showCleanup = !state.compareOriginal && byId("show-cleanup").checked
  const showText = !state.compareOriginal && byId("show-text").checked
  const pending = drawPage(pageCanvas, page, { showCleanup, showText })
  if (!pending || previewRedraw === pending) return
  previewRedraw = pending
  pending.then(() => {
    if (previewRedraw !== pending) return
    previewRedraw = null
    if (selectedPage() === page) paintPreview(page)
  })
}

function renderCanvas() {
  if (pendingPaint) {
    cancelAnimationFrame(pendingPaint)
    pendingPaint = undefined
  }
  const page = selectedPage()
  const tool = byId("cleanup-tool").value
  stage.hidden = !page
  byId("canvas-empty").hidden = Boolean(page)
  byId("add-box").setAttribute("aria-pressed", String(state.placing))
  byId("compare-original").setAttribute("aria-pressed", String(state.compareOriginal))
  stage.classList.toggle("placing", state.placing)
  stage.classList.toggle("panning", tool === "pan" || spacePan)
  stage.classList.toggle("eyedropper", tool === "eyedropper")
  stage.classList.toggle("cleaning", ["region", "erase", "restore", "paint", "clone"].includes(tool))
  overlays.hidden = state.compareOriginal
  byId("cleanup-overlay").hidden = state.compareOriginal
  if (!page) {
    overlays.replaceChildren()
    pageCanvas.width = 1
    pageCanvas.height = 1
    return
  }
  const stageWidth = state.fit
    ? Math.min(page.image.naturalWidth, 720)
    : Math.max(120, Math.round(page.image.naturalWidth * state.zoom))
  stage.style.width = stageWidth + "px"
  stage.style.maxWidth = state.fit ? "100%" : "none"
  stage.style.flexShrink = state.fit ? "1" : "0"
  paintPreview(page)
  overlays.replaceChildren(...page.boxes.map((box) => {
    const outline = listButton("", () => selectBox(box), box.text)
    outline.className = "outline"
    outline.dataset.box = box.id
    if (box.id === state.boxId) {
      outline.setAttribute("aria-current", "true")
      for (const handle of resizeHandles) {
        const dot = document.createElement("span")
        dot.className = "resize-handle"
        dot.dataset.handle = handle
        dot.dataset.box = box.id
        outline.append(dot)
      }
      const rotator = document.createElement("span")
      rotator.className = "rotate-handle"
      rotator.dataset.rotate = box.id
      rotator.title = "Kéo để xoay (giữ Shift: nấc 15°)"
      outline.append(rotator)
    }
    rectStyle(outline, box)
    return outline
  }))
  if (tool === "clone" && cloneOrigin) {
    const marker = document.createElement("div")
    marker.className = "clone-marker"
    marker.style.left = cloneOrigin.x * 100 + "%"
    marker.style.top = cloneOrigin.y * 100 + "%"
    overlays.append(marker)
  }
  renderCleanupOverlay()
}

function freezeCleanup(box) {
  if (box.cleanupRect) return
  const { x, y, w, h } = cleanupRectangle(box)
  box.cleanupRect = { x, y, w, h }
}

function scheduleCleanupOverlay() {
  pendingOverlay ??= requestAnimationFrame(() => {
    pendingOverlay = undefined
    renderCleanupOverlay()
  })
}

function renderCleanupOverlay() {
  const canvas = byId("cleanup-overlay")
  canvas.width = pageCanvas.width
  canvas.height = pageCanvas.height
  const box = selectedBox()
  const tool = byId("cleanup-tool").value
  if (!box || !["region", "erase", "restore"].includes(tool)) return
  const rect = cleanupRectangle(box)
  const left = Math.max(0, Math.floor(rect.x * canvas.width))
  const top = Math.max(0, Math.floor(rect.y * canvas.height))
  const right = Math.min(canvas.width, Math.ceil((rect.x + rect.w) * canvas.width))
  const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.h) * canvas.height))
  if (right <= left || bottom <= top) return
  const mask = document.createElement("canvas")
  mask.width = Math.max(1, right - left)
  mask.height = Math.max(1, bottom - top)
  paintCleanupMask(mask, box, selectedPage().image, left, top)
  const context = mask.getContext("2d")
  context.globalCompositeOperation = "source-in"
  context.fillStyle = "#ed9f24"
  context.fillRect(0, 0, mask.width, mask.height)
  canvas.getContext("2d").drawImage(mask, left, top)
  const outline = document.createElement("div")
  outline.className = "outline cleanup-region"
  rectStyle(outline, rect)
  overlays.querySelector(".cleanup-region")?.remove()
  overlays.append(outline)
}

function renderPresets() {
  const select = byId("style-preset")
  const value = select.value
  select.replaceChildren(...state.presets.map((preset, index) => new Option(preset.name, index)))
  if (state.presets[Number(value)]) select.value = value
  byId("save-preset").disabled = !selectedBox() || projectBusy()
  byId("apply-preset").disabled = !state.presets.length || !state.pages.length || projectBusy()
  byId("delete-preset").disabled = !state.presets.length || projectBusy()
}

byId("save-preset").onclick = () => {
  commitLiveFormCheckpoint()
  const box = selectedBox()
  const name = byId("preset-name").value.trim()
  if (!box || projectBusy()) return
  if (!name) return status("Hãy nhập tên mẫu dàn chữ.", true)
  checkpoint()
  const preset = { name, style: projectStyle(box) }
  const index = state.presets.findIndex((item) => item.name === name)
  if (index < 0) state.presets.push(preset)
  else state.presets[index] = preset
  renderPresets()
  byId("style-preset").value = String(index < 0 ? state.presets.length - 1 : index)
  status("Đã lưu mẫu " + name + ".")
}
const optionalStyleKeys = ["bold", "italic", "uppercase", "vertical", "lineHeight", "strokeWidth", "strokeColor", "fillColor", "fillShape"]
byId("apply-preset").onclick = () => {
  commitLiveFormCheckpoint()
  const preset = state.presets[Number(byId("style-preset").value)]
  if (!preset || projectBusy()) return
  const scope = byId("preset-scope").value
  const pages = scope === "chapter" ? state.pages : [selectedPage()].filter(Boolean)
  const boxes = scope === "box" ? [selectedBox()].filter(Boolean) : pages.flatMap((page) => page.boxes)
  if (!boxes.length) return status("Hãy chọn khung để áp dụng mẫu.", true)
  checkpoint()
  boxes.forEach((box) => {
    for (const key of optionalStyleKeys) delete box[key]
    Object.assign(box, preset.style)
  })
  render()
  status(`Đã áp dụng mẫu cho ${boxes.length} khung.`)
}
byId("delete-preset").onclick = () => {
  if (projectBusy() || !state.presets.length) return
  checkpoint()
  state.presets.splice(Number(byId("style-preset").value), 1)
  renderPresets()
}
byId("reset-cleanup").onclick = () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  checkpoint()
  delete box.cleanupRect
  delete box.cleanupStrokes
  delete box.cleanupExpand
  freezeCleanup(box)
  render()
}
byId("cleanup-tool").onchange = () => {
  state.placing = false
  const tool = byId("cleanup-tool").value
  renderCanvas()
  const messages = {
    pan: "Kéo trên ảnh để di chuyển vùng nhìn (hoặc giữ phím Space).",
    region: "Chọn khung thoại rồi khoanh vùng xóa chữ trên ảnh.",
    erase: "Chọn khung thoại rồi tô cọ để giữ lại nét vẽ gốc.",
    restore: "Chọn khung thoại rồi tô cọ để thêm lại vùng xóa.",
    paint: "Kéo trên ảnh để vẽ che chữ bằng màu cọ đã chọn.",
    clone: "Giữ Alt và bấm vào nền sạch để đặt điểm nguồn, sau đó kéo để sao chép nền.",
    eyedropper: "Bấm vào ảnh để hút màu cho cọ vẽ.",
  }
  if (messages[tool]) status(messages[tool])
}
byId("clear-retouch").onclick = () => {
  const page = selectedPage()
  if (!page?.retouchStrokes?.length || projectBusy()) return
  checkpoint()
  page.retouchStrokes = []
  render()
  status("Đã xóa toàn bộ nét vẽ/sao chép tay trên trang này.")
}
byId("show-cleanup").onchange = renderCanvas
byId("show-text").onchange = renderCanvas

function syncFontOptions(selected) {
  const select = byId("box-font")
  if (selected) registerFontName(selected)
  const fonts = allFonts()
  select.replaceChildren(...fonts.map((name) => new Option(name, name)))
  if (selected && fonts.includes(selected)) select.value = selected
}

byId("font-file").onchange = async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file) return
  try {
    const family = await loadCustomFont(file)
    syncFontOptions(family)
    const box = selectedBox()
    if (box && !projectBusy()) {
      checkpoint()
      box.font = family
      byId("box-font").value = family
      renderCanvas()
    }
    status(`Đã nạp font "${family}".`)
  } catch (error) {
    status("Không nạp được font. " + error.message, true)
  }
}

function selectBox(box) {
  if (state.boxId !== box.id) commitLiveFormCheckpoint()
  state.boxId = box.id
  renderCanvas()
  renderInspector()
}

function renderInspector() {
  const page = selectedPage()
  const box = selectedBox()
  const boxes = page?.boxes ?? []
  renderPresets()
  byId("cleanup-inspector").hidden = !box
  byId("reset-cleanup").disabled = projectBusy()
  byId("box-count").textContent = boxes.length
  byId("autofit-page").disabled = !boxes.length || projectBusy()
  byId("inspector-empty").hidden = Boolean(box)
  form.hidden = !box
  if (box) {
    syncFontOptions(box.font)
    for (const [key, id] of Object.entries(boxFields)) byId(id).value = box[key]
    byId("box-line-height").value = box.lineHeight ?? 1.15
    byId("box-stroke-width").value = box.strokeWidth ?? 0
    byId("box-stroke-color").value = box.strokeColor ?? "#ffffff"
    byId("box-fill-shape").value = box.fillShape ?? "rect"
    byId("box-fill-color").value = box.fillColor ?? "#ffffff"
    byId("box-bold").checked = Boolean(box.bold)
    byId("box-italic").checked = Boolean(box.italic)
    byId("box-uppercase").checked = Boolean(box.uppercase)
    byId("box-vertical").checked = Boolean(box.vertical)
    byId("cleanup-expand").value = box.cleanupExpand ?? 0
    byId("box-fill").checked = box.fill
    byId("box-cleanup").checked = Boolean(box.cleanup)
    const boxIndex = boxes.findIndex((item) => item.id === box.id)
    byId("box-layer-up").disabled = boxIndex >= boxes.length - 1 || projectBusy()
    byId("box-layer-down").disabled = boxIndex <= 0 || projectBusy()
  }
  byId("boxes").replaceChildren(...boxes.map((item) => {
    const li = document.createElement("li")
    const button = listButton(item.text, () => selectBox(item))
    if (box?.id === item.id) button.setAttribute("aria-current", "true")
    li.append(button)
    return li
  }))
  const queue = [
    ...state.queue.map((text, index) => ({ text, remove: () => state.queue.splice(index, 1) })),
    ...(page?.unplaced ?? []).map((line, index) => ({
      ...line, remove: () => page.unplaced.splice(index, 1),
    })),
  ]
  byId("queue-section").hidden = !queue.length
  byId("queue").replaceChildren(...queue.map((line) => {
    const li = document.createElement("li")
    const button = listButton(line.text, () => {
      if (!selectedPage() || projectBusy()) return
      checkpoint()
      line.remove()
      addBox({ x: .32, y: .4, w: .36, h: .16 }, line.text, false)
    })
    button.disabled = !page || projectBusy()
    li.append(button)
    return li
  }))
}

function render() {
  renderPages()
  renderCanvas()
  renderInspector()
}

async function openImage(file) {
  const url = URL.createObjectURL(file)
  ownedUrls.add(url)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    if (image.naturalWidth * image.naturalHeight > 28000000) throw new Error("Ảnh vượt giới hạn kích thước.")
    return { id: crypto.randomUUID(), name: file.name, file, image, url, boxes: [], unplaced: [] }
  } catch (error) {
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
    throw error
  }
}

function projectBlob() {
  const settings = Object.fromEntries(projectSettings.map(({ id, value }) => [id, value]))
  return writeProject({ pages: state.pages, presets: state.presets, queue: state.queue, settings, currentPage: selectedIndex(), fit: state.fit })
}

byId("save-project").onclick = async () => {
  if (projectBusy()) return
  commitLiveFormCheckpoint()
  try {
    const file = projectBlob()
    const name = projectName ?? filenameStem(state.pages[0]?.name ?? "khung-thoai")
    if (nativeReady) {
      state.savingProject = true
      renderPages()
      if (!await saveDesktopProject(file, "project", name + projectExtension)) return
      savedRevision = revision
      status("Đã lưu dự án vào máy.")
    } else {
      saveFile(file, name + projectExtension)
      savedRevision = revision
      status("Đã tạo tệp dự án.")
    }
  } catch (error) {
    status("Không lưu được dự án. " + error.message, true)
  } finally {
    state.savingProject = false
    renderPages()
  }
}

byId("open-project").onclick = () => {
  if (projectBusy()) return
  if (nativeReady) openNativeProject("dialog")
  else projectFile.click()
}

projectFile.onchange = async () => {
  const file = projectFile.files[0]
  projectFile.value = ""
  await loadProject(file)
}

async function loadProject(file) {
  if (!file || projectBusy()) return
  const loaded = []
  state.openingProject = true
  renderPages()
  status("Đang mở dự án…")
  try {
    const project = await readProject(file)
    for (const field of projectSettings) {
      if (field.options && ![...field.options].some(({ value }) => value === project.settings[field.id])) {
        throw new Error("Tệp dự án chứa thiết lập chưa được hỗ trợ.")
      }
    }
    for (const saved of project.pages) {
      let page
      try {
        page = await openImage(saved.file)
      } catch {
        throw new Error("Không đọc được ảnh trong dự án: " + saved.file.name)
      }
      page.boxes = saved.boxes.map((box) => {
        registerFontName(box.font)
        return { ...box, id: crypto.randomUUID() }
      })
      page.unplaced = saved.unplaced
      page.retouchStrokes = saved.retouchStrokes ?? []
      page.translationContext = saved.translationContext
      page.translationJob = saved.translationJob
      loaded.push(page)
    }
    const hasContent = state.pages.length || state.presets.length || state.queue.length ||
      projectSettings.some(({ value }, index) => value !== defaultProjectSettings[index])
    if (hasContent && !window.confirm("Mở dự án này sẽ thay thế phiên biên tập hiện tại. Tiếp tục?")) {
      status("Đã hủy mở dự án.")
      return
    }
    revision++
    savedRevision = revision
    history.clear()
    project.presets.forEach(({ style }) => registerFontName(style.font))
    state.pages = loaded
    state.queue = project.queue
    state.presets = project.presets
    state.fit = project.fit
    state.zoom = 1
    cloneOrigin = null
    updateFitLabel()
    projectSettings.forEach((field) => { field.value = project.settings[field.id] })
    if (file.name !== "recovery.khungthoai" && file.name !== "recovery.khungthoai.bak") {
      projectName = filenameStem(file.name)
    }
    selectPage(loaded[project.currentPage])
    status(`Đã mở dự án với ${loaded.length} trang.`)
  } catch (error) {
    status("Không mở được dự án. " + error.message, true)
  } finally {
    releaseUnusedImages()
    state.openingProject = false
    renderPages()
  }
}

async function importPages(files) {
  if (projectBusy()) return []
  state.importing = true
  syncProjectActions()
  const loaded = []
  const rejected = []
  try {
    for (const file of files) {
      if (state.pages.length + loaded.length >= pageLimit || !isImageFile(file)) {
        rejected.push(file.name)
        continue
      }
      try {
        loaded.push(await openImage(file))
      } catch {
        rejected.push(file.name)
      }
    }
    if (loaded.length) checkpoint()
    state.pages.push(...loaded)
    if (loaded.length && !selectedPage()) selectPage(loaded[0])
    else render()
    if (rejected.length) {
      status(`Đã thêm ${loaded.length} ảnh. Bỏ qua ${rejected.length} tệp do định dạng, kích thước hoặc giới hạn 50 trang.`, true)
    } else if (loaded.length) {
      status(`Đã thêm ${loaded.length} ảnh.`)
    }
    return loaded
  } finally {
    state.importing = false
    renderPages()
    releaseUnusedImages()
    byId("images").value = ""
  }
}
byId("images").onchange = (event) => importPages([...event.target.files])
const dropzone = byId("dropzone")
dropzone.ondragover = (event) => {
  event.preventDefault()
  dropzone.classList.add("dragging")
}
dropzone.ondragleave = () => dropzone.classList.remove("dragging")
dropzone.ondrop = (event) => {
  event.preventDefault()
  dropzone.classList.remove("dragging")
  importPages([...event.dataTransfer.files])
}
setupLibrary(async (files) => {
  const pages = await importPages(files)
  if (!pages.length) throw new Error("Không còn chỗ hoặc không đọc được ảnh.")
  selectPage(pages[0])
  location.hash = "editor"
})

byId("prev-page").onclick = () => changePage(-1)
byId("next-page").onclick = () => changePage(1)
function updateFitLabel() {
  byId("fit-page").textContent = state.fit ? "100%" : "Vừa trang"
  byId("zoom-level").textContent = state.fit ? "Vừa trang" : Math.round(state.zoom * 100) + "%"
}
function setZoom(next) {
  state.fit = false
  state.zoom = clamp(Math.round(next * 100) / 100, .25, 4)
  updateFitLabel()
  renderCanvas()
}
function toggleCompareOriginal() {
  state.compareOriginal = !state.compareOriginal
  renderCanvas()
  status(state.compareOriginal ? "Đang xem ảnh gốc (nhấn \\ để quay lại)." : "Đã quay lại bản biên tập.")
}
byId("zoom-in").onclick = () => setZoom((state.fit ? 1 : state.zoom) + .25)
byId("zoom-out").onclick = () => setZoom((state.fit ? 1 : state.zoom) - .25)
byId("fit-page").onclick = () => {
  state.fit = !state.fit
  if (!state.fit) state.zoom = 1
  updateFitLabel()
  renderCanvas()
}
byId("compare-original").onclick = toggleCompareOriginal
viewport.addEventListener("wheel", (event) => {
  if (!(event.ctrlKey || event.metaKey) || !selectedPage()) return
  event.preventDefault()
  const base = state.fit ? 1 : state.zoom
  setZoom(base + (event.deltaY < 0 ? .15 : -.15))
}, { passive: false })

byId("export-script").onclick = () => {
  if (!state.pages.length || projectBusy()) return
  const format = byId("export-script-format").value
  const content = exportDialogueScript(state.pages, format)
  const mime = { txt: "text/plain;charset=utf-8", csv: "text/csv;charset=utf-8", json: "application/json;charset=utf-8" }[format]
  const name = (projectName ?? filenameStem(state.pages[0]?.name ?? "khung-thoai")) + "-kich-ban." + format
  saveFile(new Blob([content], { type: mime }), name)
  status(`Đã xuất kịch bản (${format.toUpperCase()}).`)
}
byId("script-file").onchange = async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file || projectBusy()) return
  state.importingScript = true
  syncProjectActions()
  try {
    const script = await readDialogueFile(file)
    checkpoint()
    byId("script-text").value = script
    status("Đã đọc " + file.name + ".")
  } catch (error) {
    status("Không nhập được kịch bản. " + error.message, true)
  } finally {
    state.importingScript = false
    renderPages()
  }
}

function distribute(page, lines, direction) {
  const columns = lines.length > 4 ? 2 : 1
  const rows = Math.ceil(lines.length / columns)
  const width = columns === 1 ? .48 : .4
  const height = Math.min(.16, .79 / rows)
  return lines.map((line, index) => {
    const column = index % columns
    const x = columns === 1 ? .26 : direction === "rtl" ? .55 - column * .49 : .06 + column * .49
    const y = .07 + Math.floor(index / columns) * (.86 / rows)
    const box = makeBox(page, { x, y, w: width, h: height }, line)
    box.size = clamp(Math.round(Math.min(box.size, height * page.image.naturalHeight * .44)), 8, 400)
    return box
  })
}

function pageForScript(reference, current) {
  if (reference === null) return current
  if (typeof reference === "number") return state.pages[reference]
  return state.pages.find((page) => page.name.toLowerCase() === reference)
}

byId("apply-script").onclick = () => {
  const current = selectedPage()
  const groups = groupDialogue(byId("script-text").value)
  if (projectBusy()) return
  if (!current || !groups.length) return status("Hãy thêm ảnh và nhập lời thoại.", true)
  checkpoint()
  const unplaced = []
  let placed = 0
  for (const { reference, lines } of groups) {
    const page = pageForScript(reference, current)
    if (!page) {
      unplaced.push(...lines)
      continue
    }
    const available = Math.max(0, 24 - page.boxes.length)
    const chosen = lines.slice(0, available)
    page.boxes.push(...distribute(page, chosen, byId("direction").value))
    placed += chosen.length
    unplaced.push(...lines.slice(available))
  }
  state.queue.push(...unplaced)
  render()
  status(`Đã đặt ${placed} câu. ${unplaced.length} câu chờ đặt thủ công.`)
}

function addBox(rectangle, line, record = true) {
  const page = selectedPage()
  if (!page) return
  if (projectBusy()) return
  if (record) checkpoint()
  const box = makeBox(page, rectangle, line)
  page.boxes.push(box)
  state.boxId = box.id
  state.placing = false
  renderCanvas()
  renderInspector()
  status("Đã thêm khung chữ.")
}

byId("add-box").onclick = () => {
  byId("cleanup-tool").value = "text"
  state.placing = !state.placing
  renderCanvas()
  if (state.placing) {
    stage.focus()
    status("Bấm hoặc kéo trên ảnh để đặt khung, hoặc nhấn Enter.")
  } else {
    status("Đã thoát chế độ đặt khung.")
  }
}
function point(event) {
  const area = pageCanvas.getBoundingClientRect()
  const x = area.width > 0 ? clamp((event.clientX - area.left) / area.width, 0, 1) : 0
  const y = area.height > 0 ? clamp((event.clientY - area.top) / area.height, 0, 1) : 0
  return { x, y }
}

function placement(a, b) {
  const w = Math.abs(a.x - b.x)
  const h = Math.abs(a.y - b.y)
  if (w < .015 && h < .015) return { x: clamp(a.x - .17, 0, .66), y: clamp(a.y - .08, 0, .84), w: .34, h: .16 }
  return { x: Math.min(a.x, b.x, .97), y: Math.min(a.y, b.y, .97), w: Math.max(.03, w), h: Math.max(.03, h) }
}

stage.addEventListener("pointerdown", (event) => {
  const page = selectedPage()
  if (!page) return
  const tool = byId("cleanup-tool").value
  if (event.button === 1 || (event.button === 0 && (spacePan || tool === "pan"))) {
    event.preventDefault()
    stage.setPointerCapture(event.pointerId)
    stage.classList.add("dragging-pan")
    gesture = {
      pointer: event.pointerId, pan: true,
      clientX: event.clientX, clientY: event.clientY,
      scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
    }
    return
  }
  if (event.button !== 0 || projectBusy()) return
  const origin = point(event)

  if (tool === "eyedropper") {
    event.preventDefault()
    const sampled = samplePixelColor(page.image, origin)
    if (!sampled) return
    byId("paint-color").value = sampled
    const readout = byId("eyedropper-readout")
    readout.textContent = sampled.toUpperCase()
    readout.hidden = false
    status(`Đã hút màu ${sampled.toUpperCase()} cho cọ vẽ.`)
    return
  }

  const before = editorSnapshot()
  if (tool === "paint" || tool === "clone") {
    event.preventDefault()
    if (tool === "clone" && event.altKey) {
      cloneOrigin = origin
      renderCanvas()
      status("Đã đặt điểm nguồn sao chép. Kéo trên ảnh để tô.")
      return
    }
    if (tool === "clone" && !cloneOrigin) {
      status("Giữ Alt và bấm vào vùng nền sạch để đặt điểm nguồn sao chép trước.", true)
      return
    }
    stage.setPointerCapture(event.pointerId)
    const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
    const opacity = clamp((Number(byId("paint-opacity").value) || 100) / 100, .05, 1)
    const minDim = Math.max(1, Math.min(pageCanvas.width, pageCanvas.height))
    const stroke = tool === "paint"
      ? { mode: "paint", size: size / minDim, color: byId("paint-color").value, opacity, points: [origin] }
      : { mode: "clone", size: size / minDim, offsetX: cloneOrigin.x - origin.x, offsetY: cloneOrigin.y - origin.y, opacity, points: [origin] }
    page.retouchStrokes ??= []
    page.retouchStrokes.push(stroke)
    gesture = { pointer: event.pointerId, retouchStroke: stroke, before }
    paintPreview(page)
    return
  }

  const rotateTarget = event.target.dataset?.rotate
  if (tool === "text" && !state.placing && rotateTarget) {
    const box = page.boxes.find((item) => item.id === rotateTarget)
    if (!box) return
    event.preventDefault()
    stage.setPointerCapture(event.pointerId)
    gesture = { pointer: event.pointerId, box, rotating: true, startRotation: box.rotation, before }
    return
  }

  const handle = event.target.dataset?.handle
  if (tool === "text" && !state.placing && handle) {
    const box = page.boxes.find((item) => item.id === event.target.dataset.box)
    if (!box) return
    event.preventDefault()
    stage.setPointerCapture(event.pointerId)
    if (box.cleanup) freezeCleanup(box)
    gesture = {
      pointer: event.pointerId, box, handle, origin,
      start: { x: box.x, y: box.y, w: box.w, h: box.h }, before,
    }
    return
  }

  const box = tool === "text" ? page.boxes.find((item) => item.id === event.target.dataset.box) : selectedBox()
  if (!box && !state.placing) return
  event.preventDefault()
  stage.setPointerCapture(event.pointerId)
  if (tool !== "text") {
    if (!box) return
    freezeCleanup(box)
    box.cleanup = true
    if (tool !== "region") {
      const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
      const stroke = { mode: tool, size: size / Math.max(1, Math.min(pageCanvas.width, pageCanvas.height)), points: [origin] }
      box.cleanupStrokes ??= []
      box.cleanupStrokes.push(stroke)
      gesture = { pointer: event.pointerId, box, stroke, before }
      scheduleCleanupOverlay()
      return
    }
  } else if (box) {
    selectBox(box)
    if (box.cleanup) freezeCleanup(box)
    gesture = { pointer: event.pointerId, box, origin, start: { x: box.x, y: box.y }, before }
    return
  }
  const draft = document.createElement("div")
  draft.className = "outline draft"
  overlays.append(draft)
  gesture = { pointer: event.pointerId, origin, draft, cleanupBox: tool === "region" ? box : null, before }
})

stage.addEventListener("pointermove", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  if (gesture.pan) {
    viewport.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.clientX)
    viewport.scrollTop = gesture.scrollTop - (event.clientY - gesture.clientY)
    return
  }
  const cursor = point(event)
  if (gesture.retouchStroke) {
    gesture.retouchStroke.points.push(cursor)
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  } else if (gesture.rotating) {
    const { box } = gesture
    const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    box.rotation = rotateBox(center, cursor, { snap: event.shiftKey })
    const outline = overlays.querySelector('[aria-current="true"]')
    if (outline) outline.style.transform = box.rotation ? "rotate(" + box.rotation + "deg)" : ""
    byId("box-rotation").value = box.rotation
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  } else if (gesture.handle) {
    const { box, handle, origin, start } = gesture
    const next = resizeBox(start, handle, { x: cursor.x - origin.x, y: cursor.y - origin.y })
    Object.assign(box, next)
    const outline = overlays.querySelector('[aria-current="true"]')
    if (outline) rectStyle(outline, box)
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  } else if (gesture.stroke) {
    gesture.stroke.points.push(cursor)
    scheduleCleanupOverlay()
  } else if (gesture.box) {
    const { box, origin, start } = gesture
    box.x = clamp(start.x + cursor.x - origin.x, 0, 1 - box.w)
    box.y = clamp(start.y + cursor.y - origin.y, 0, 1 - box.h)
    const outline = overlays.querySelector('[aria-current="true"]')
    if (outline) rectStyle(outline, box)
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  } else {
    rectStyle(gesture.draft, placement(gesture.origin, cursor))
  }
})

stage.addEventListener("pointerup", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  const completed = gesture
  gesture = undefined
  if (completed.pan) {
    stage.classList.remove("dragging-pan")
    return
  }
  const changed = completed.draft || completed.stroke || completed.retouchStroke ||
    (completed.rotating && completed.box.rotation !== completed.startRotation) ||
    (completed.handle && (completed.box.x !== completed.start.x || completed.box.y !== completed.start.y ||
      completed.box.w !== completed.start.w || completed.box.h !== completed.start.h)) ||
    (completed.box && completed.start && (completed.box.x !== completed.start.x || completed.box.y !== completed.start.y))
  if (changed) checkpoint(completed.before)
  if (completed.cleanupBox) {
    completed.cleanupBox.cleanupRect = placement(completed.origin, point(event))
    completed.cleanupBox.cleanupStrokes = []
  } else if (completed.draft) {
    addBox(placement(completed.origin, point(event)), undefined, false)
  }
  render()
})
stage.addEventListener("pointercancel", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  const completed = gesture
  gesture = undefined
  stage.classList.remove("dragging-pan")
  if (completed.pan) return
  const { settings, ...editor } = completed.before
  Object.assign(state, editor)
  render()
})

stage.addEventListener("keydown", (event) => {
  if (event.target !== stage) return
  if (event.key === "Enter") {
    event.preventDefault()
    addBox({ x: .33, y: .42, w: .34, h: .16 })
    byId("box-text").focus()
  } else if (event.key === "Escape") {
    state.placing = false
    state.boxId = null
    renderCanvas()
    renderInspector()
  } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !selectedBox()) {
    const rtl = byId("direction").value === "rtl"
    changePage((event.key === "ArrowLeft") === rtl ? 1 : -1)
    event.preventDefault()
  }
})

function applyFormToBox(box) {
  const text = byId("box-text").value.trim()
  if (!text) return false
  for (const [key, id] of Object.entries(boxFields)) box[key] = byId(id).value
  box.text = text
  box.size = clamp(Number(box.size) || 24, 8, 400)
  box.rotation = clamp(Number(box.rotation) || 0, -180, 180)
  const lineHeight = clamp(Number(byId("box-line-height").value) || 1.15, .8, 2.2)
  if (lineHeight === 1.15) delete box.lineHeight
  else box.lineHeight = lineHeight
  const strokeWidth = clamp(Number(byId("box-stroke-width").value) || 0, 0, 24)
  if (strokeWidth > 0) {
    box.strokeWidth = strokeWidth
    box.strokeColor = byId("box-stroke-color").value
  } else {
    delete box.strokeWidth
    delete box.strokeColor
  }
  box.fill = byId("box-fill").checked
  const fillShape = byId("box-fill-shape").value
  if (fillShape === "rect") delete box.fillShape
  else box.fillShape = fillShape
  const fillColor = byId("box-fill-color").value
  if (fillColor.toLowerCase() === "#ffffff") delete box.fillColor
  else box.fillColor = fillColor
  for (const [prop, id] of [["bold", "box-bold"], ["italic", "box-italic"], ["uppercase", "box-uppercase"], ["vertical", "box-vertical"]]) {
    if (byId(id).checked) box[prop] = true
    else delete box[prop]
  }
  box.cleanup = byId("box-cleanup").checked
  if (box.cleanup) freezeCleanup(box)
  return true
}

function liveUpdateBox() {
  const box = selectedBox()
  if (!box || projectBusy()) return
  if (formEditBoxId !== box.id) {
    formEditBoxId = box.id
    formEditSnapshot = editorSnapshot()
  }
  if (!applyFormToBox(box)) return
  revision++
  renderCanvas()
  const activeButton = byId("boxes").querySelector('[aria-current="true"]')
  if (activeButton) activeButton.textContent = box.text
}

function commitLiveFormCheckpoint() {
  if (!formEditSnapshot) return
  checkpoint(formEditSnapshot)
  formEditSnapshot = null
  formEditBoxId = null
}

form.addEventListener("input", liveUpdateBox)
form.addEventListener("change", () => {
  liveUpdateBox()
  commitLiveFormCheckpoint()
})
form.onsubmit = (event) => {
  event.preventDefault()
  const box = selectedBox()
  if (!box || projectBusy()) return
  const hadLiveEdit = Boolean(formEditSnapshot)
  const before = formEditSnapshot ?? editorSnapshot()
  const beforeBox = JSON.stringify(box)
  if (!applyFormToBox(box)) return status("Hãy nhập nội dung khung.", true)
  if (hadLiveEdit || JSON.stringify(box) !== beforeBox) checkpoint(before)
  formEditSnapshot = null
  formEditBoxId = null
  renderPages()
  renderCanvas()
  renderInspector()
  status("Đã lưu khung.")
}

function deleteSelectedBox() {
  const page = selectedPage()
  if (!page || !state.boxId || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  page.boxes = page.boxes.filter((box) => box.id !== state.boxId)
  state.boxId = null
  renderCanvas()
  renderInspector()
  status("Đã xóa khung.")
}

function duplicateSelectedBox() {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  const copy = duplicateBox(box)
  page.boxes.push(copy)
  state.boxId = copy.id
  renderCanvas()
  renderInspector()
  status("Đã nhân bản khung.")
}

function moveSelectedBoxLayer(delta) {
  const page = selectedPage()
  if (!page || !state.boxId || projectBusy()) return
  commitLiveFormCheckpoint()
  const { boxes, moved } = reorderBox(page.boxes, state.boxId, delta)
  if (!moved) return
  checkpoint()
  page.boxes = boxes
  renderCanvas()
  renderInspector()
}

byId("delete-box").onclick = deleteSelectedBox
byId("duplicate-box").onclick = duplicateSelectedBox
byId("box-layer-up").onclick = () => moveSelectedBoxLayer(1)
byId("box-layer-down").onclick = () => moveSelectedBoxLayer(-1)
byId("autofit-box").onclick = () => {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box || projectBusy()) return
  commitLiveFormCheckpoint()
  const fitted = autoFitBox(page, box)
  if (fitted === box.size) return status("Cỡ chữ hiện tại đã vừa khung.")
  checkpoint()
  box.size = fitted
  renderCanvas()
  renderInspector()
  status(`Đã tự khớp cỡ chữ thành ${fitted} px.`)
}
byId("autofit-page").onclick = () => {
  const page = selectedPage()
  if (!page?.boxes.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  let adjusted = 0
  for (const box of page.boxes) {
    const fitted = autoFitBox(page, box)
    if (fitted !== box.size) {
      box.size = fitted
      adjusted++
    }
  }
  renderCanvas()
  renderInspector()
  status(`Đã khớp cỡ chữ cho ${adjusted}/${page.boxes.length} khung.`)
}

function applyTranslation(page, lines) {
  const regions = page.boxes.length ? page.boxes.map((box) => ({ box: toCoordinates(box.originalBox ?? box), existing: box }))
    : lines.filter((line) => line.box).map((line) => ({ box: line.box }))
  const { placed, unplaced } = matchDialogue(lines, regions)
  for (const { line, region } of placed) {
    const box = region.existing ?? makeBox(page, toRectangle(region.box), line.text)
    box.text = line.text
    box.originalBox = toRectangle(line.box)
    if (!region.existing) {
      box.fill = false
      box.cleanup = true
      page.boxes.push(box)
    }
  }
  page.unplaced = unplaced
  return placed.length
}

function readTranslationSettings() {
  return {
    model: byId("gemini-model").value,
    source: byId("source-language").value,
    target: byId("target-language").value,
    notes: byId("translation-notes").value.trim(),
    direction: byId("direction").value,
    glossary: byId("translation-glossary").value.trim(),
  }
}

async function processWithGemini(pages, read, action, kind = "translate") {
  const key = byId("gemini-key").value.trim()
  if (projectBusy() || !pages.length) return
  if (!key) return status("Hãy nhập khóa API Gemini.", true)
  const settings = { ...readTranslationSettings(), key }
  const signature = translationSignature(settings)
  const previousPage = state.pages[state.pages.indexOf(pages[0]) - 1]
  let context = previousPage?.translationContext?.signature === signature ? previousPage.translationContext.lines : []
  let completed = 0
  let placed = 0
  let skipped = 0
  checkpoint()
  translationController = new AbortController()
  state.translating = true
  for (const page of pages) page.translationJob = { kind, signature, state: "pending" }
  renderPages()
  renderInspector()
  let activePage
  try {
    for (const page of pages) {
      activePage = page
      page.translationJob = { kind, signature, state: "running" }
      renderPages()
      const report = (message) => status(page.name + " · " + message)
      const lines = await read(page, { ...settings, context, report, signal: translationController.signal })
      translationController.signal.throwIfAborted()
      if (lines.length) {
        placed += applyTranslation(page, lines)
        skipped += page.unplaced.length
        context = [...context, ...lines.filter(({ source }) => source).map(({ source, text }) => ({
          source: source.slice(0, 240), text: text.slice(0, 240),
        }))].slice(-8)
      } else {
        page.unplaced = []
      }
      page.translationContext = { signature, lines: context }
      page.translationJob = { kind, signature, state: "done" }
      completed++
      if (selectedPage() === page) {
        renderCanvas()
        renderInspector()
      }
    }
    status(`Đã ${action} ${completed}/${pages.length} trang. ${placed} câu đã đặt và ${skipped} câu chờ đặt.`)
  } catch (error) {
    const stopped = translationController.signal.aborted
    if (activePage) activePage.translationJob = {
      kind, signature, state: stopped ? "pending" : "error", error: stopped ? undefined : error.message,
    }
    status(stopped ? `Đã dừng sau ${completed} trang. Có thể tiếp tục dịch chương.` :
      `Đã ${action} ${completed}/${pages.length} trang. ${error.message}`, !stopped)
  } finally {
    state.translating = false
    translationController = null
    render()
  }
}
byId("translate").onclick = () => processWithGemini([selectedPage()].filter(Boolean), translateImage, "dịch")
byId("translate-all").onclick = () => processWithGemini([...state.pages], translateImage, "dịch")
byId("resume-translation").onclick = () => processWithGemini(remainingTranslations(state.pages, readTranslationSettings()), translateImage, "dịch")
byId("stop-translation").onclick = () => translationController?.abort()
byId("align-script").onclick = () => {
  const page = selectedPage()
  if (!page) return
  const lines = groupDialogue(byId("script-text").value)
    .filter(({ reference }) => pageForScript(reference, page) === page)
    .flatMap(({ lines }) => lines)
  if (!lines.length) return status("Hãy nhập kịch bản cho trang này.", true)
  processWithGemini([page], (selected, settings) => alignScript(selected, settings, lines), "ghép", "align")
}

function extensionFor(format) {
  return format === "png" ? "png" : "psd"
}

async function performExport(action) {
  if (state.exporting || state.openingProject) return
  state.exporting = true
  renderPages()
  try {
    await action()
    status("Đã tạo tệp xuất.")
  } catch (error) {
    status("Xuất thất bại. " + error.message, true)
  } finally {
    state.exporting = false
    renderPages()
  }
}

async function openNativeProject(mode) {
  if (projectBusy()) return
  state.openingProject = true
  renderPages()
  let file
  try { file = await openDesktopProject(mode) }
  catch (error) { status("Không mở được dự án. " + error.message, true) }
  finally { state.openingProject = false; renderPages() }
  if (file) await loadProject(file)
}
byId("recover-project").onclick = () => openNativeProject("recovery")
byId("recover-backup").onclick = () => openNativeProject("backup")

async function refreshRecovery() {
  const info = await desktop.projectStatus()
  byId("recover-project").hidden = !info.recovery
  byId("recover-backup").hidden = !info.backup
}

async function autosave() {
  if (!nativeReady || autosaving || projectBusy() || gesture || savedRevision === revision) return
  autosaving = true
  const snapshotRevision = revision
  try {
    await saveDesktopProject(projectBlob(), "autosave", "recovery.khungthoai")
    savedRevision = snapshotRevision
    byId("autosave-status").textContent = "Đã tự lưu lúc " + new Date().toLocaleTimeString("vi-VN")
    await refreshRecovery()
  } catch (error) {
    byId("autosave-status").textContent = "Tự lưu thất bại. " + error.message
  } finally { autosaving = false }
}
if (desktop?.native) {
  byId("local-processing").hidden = false
  byId("native-status").textContent = "Đang kiểm tra worker C#…"
  nativeCapabilities().then(async (capabilities) => {
    nativeReady = Boolean(capabilities)
    nativeLanguages = capabilities?.languages ?? []
    byId("native-status").textContent = capabilities ? (capabilities.ocrError ?? "OCR cục bộ sẵn sàng.") : "Chạy npm run desktop:native để bật xử lý C#."
    byId("local-ocr-language").replaceChildren(...nativeLanguages.map((language) => new Option(language, language)))
    byId("native-mask-control").hidden = !nativeReady
    byId("desktop-recovery").hidden = !nativeReady
    if (nativeReady) {
      await refreshRecovery()
      setInterval(autosave, 20000)
      byId("autosave-status").textContent = "Tự lưu mỗi 20 giây và khi đóng app."
    }
    renderPages()
  }).catch((error) => status(error.message, true))
}
let closing = false
desktop?.onClose?.(() => {
  if (!nativeReady || savedRevision === revision) {
    desktop.closeWindow()
    return
  }
  if (closing) return
  closing = true
  const finish = async () => {
    // Let a running snapshot finish, then save the latest edit before closing.
    while (autosaving) await new Promise((resolve) => setTimeout(resolve, 100))
    if (projectBusy()) {
      status("Hãy chờ tác vụ hiện tại hoàn tất trước khi đóng app.", true)
      closing = false
      return
    }
    await autosave()
    if (savedRevision === revision || window.confirm("Tự lưu thất bại. Đóng app và bỏ các thay đổi chưa lưu?")) {
      savedRevision = revision
      await desktop.closeWindow()
    }
    closing = false
  }
  finish().catch((error) => { closing = false; status(error.message, true) })
})

byId("cleanup-expand").onchange = () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  checkpoint()
  box.cleanupExpand = clamp(Math.round(Number(byId("cleanup-expand").value) || 0), -8, 8)
  render()
}

async function localProcessing(preview) {
  const page = selectedPage()
  if (!page || projectBusy()) return
  const crop = byId("ocr-crop").checked ? selectedBox() : null
  if (byId("ocr-crop").checked && !crop) return status("Hãy chọn khung để cắt vùng OCR.", true)
  state.processingNative = true
  renderPages()
  status(preview ? "Đang tiền xử lý ảnh…" : "Đang nhận dạng chữ trên máy…")
  try {
    const sample = imagePixels(page.image, crop)
    const options = { width: sample.width, height: sample.height, scale: Number(byId("ocr-scale").value),
      denoise: byId("ocr-denoise").checked, language: byId("local-ocr-language").value, psm: Number(byId("local-ocr-layout").value) }
    const { result, data } = await desktop.native(preview ? "preprocess" : "ocr", options, sample.pixels)
    if (preview) {
      const canvas = byId("ocr-preview-canvas")
      canvas.width = result.width
      canvas.height = result.height
      canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), result.width, result.height), 0, 0)
      byId("ocr-preview").showModal()
      status("Đã tạo ảnh tiền xử lý.")
    } else {
      checkpoint()
      let added = 0
      for (const line of result.lines) {
        const left = clamp(Math.round((sample.left + line.box[0] / 1000 * sample.width) / page.image.naturalWidth * 1000), 0, 999)
        const top = clamp(Math.round((sample.top + line.box[1] / 1000 * sample.height) / page.image.naturalHeight * 1000), 0, 999)
        const right = clamp(Math.round((sample.left + line.box[2] / 1000 * sample.width) / page.image.naturalWidth * 1000), left + 1, 1000)
        const bottom = clamp(Math.round((sample.top + line.box[3] / 1000 * sample.height) / page.image.naturalHeight * 1000), top + 1, 1000)
        line.box = [left, top, right, bottom]
        const overlapping = page.boxes.find((box) => overlapScore(toCoordinates(box), line.box) > .5)
        if (overlapping) {
          if (overlapping.text !== line.text && !page.unplaced.some((item) => item.text === line.text)) page.unplaced.push(line)
        } else {
          const box = makeBox(page, toRectangle(line.box), line.text)
          box.fill = false
          page.boxes.push(box)
          added++
        }
      }
      status(`Đã nhận dạng ${result.lines.length} dòng (${added} khung mới). Dòng chồng khung có sẵn được đưa vào Chưa đặt.`)
    }
  } catch (error) { status(error.message, true) }
  finally { state.processingNative = false; render() }
}
byId("preview-ocr").onclick = () => localProcessing(true)
byId("run-local-ocr").onclick = () => localProcessing(false)

const preflightDialog = byId("preflight-dialog")
let pendingExport
function exportIssues(pages) {
  const issues = []
  if (state.queue.length) issues.push({ text: `${state.queue.length} câu chưa đặt trong chương.` })
  for (const page of pages) {
    const prefix = page.name + " · "
    if (page.unplaced.length) issues.push({ page, text: prefix + `${page.unplaced.length} câu chưa đặt.` })
    if (page.translationJob?.state === "error") issues.push({ page, text: prefix + "Lỗi dịch. " + page.translationJob.error })
    if (page.translationJob?.state === "pending") issues.push({ page, text: prefix + "Chưa xử lý xong lượt dịch." })
    if (page.translationJob?.state === "done" && page.translationJob.signature !== translationSignature(readTranslationSettings())) {
      issues.push({ page, text: prefix + "Thiết lập dịch đã đổi sau lần xử lý gần nhất." })
    }
    for (const box of page.boxes) {
      if (textOverflows(page, box)) issues.push({ page, box, text: prefix + "Chữ tràn khung · " + box.text.slice(0, 70) })
    }
  }
  return issues
}

function showPreflight(issues, action) {
  pendingExport = action
  byId("continue-export").hidden = !action
  byId("preflight-summary").textContent = issues.length ? `Có ${issues.length} mục cần kiểm tra.` : "Các trang đã sẵn sàng để xuất."
  byId("preflight-issues").replaceChildren(...issues.map((issue) => {
    const li = document.createElement("li")
    li.append(listButton(issue.text, () => {
      preflightDialog.close()
      location.hash = "editor"
      if (issue.page) selectPage(issue.page)
      if (issue.box) selectBox(issue.box)
      if (!issue.page) byId("queue-section").scrollIntoView({ block: "nearest" })
      status(issue.text)
    }))
    return li
  }))
  preflightDialog.showModal()
}

function requestExport(pages, action) {
  if (projectBusy()) return
  const issues = exportIssues(pages)
  if (issues.length) showPreflight(issues, action)
  else action()
}
byId("check-export").onclick = () => showPreflight(exportIssues(state.pages))
byId("close-preflight").onclick = () => preflightDialog.close()
byId("continue-export").onclick = () => {
  const action = pendingExport
  preflightDialog.close()
  action?.()
}
preflightDialog.addEventListener("close", () => { pendingExport = null })

for (const button of exportButtons) {
  button.onclick = () => {
    const page = selectedPage()
    const format = button.dataset.export
    if (!page) return
    requestExport([page], () => performExport(async () => {
      status("Đang xuất trang…")
      const snapshot = copyEditor({ pages: [page] }).pages[0]
      saveFile(await exportPage(snapshot, format), filenameStem(page.name) + "." + extensionFor(format))
    }))
  }
}

const zipDialog = byId("zip-dialog")
byId("export-all").onclick = () => {
  zipDialog.returnValue = ""
  zipDialog.showModal()
}
zipDialog.addEventListener("close", () => {
  if (zipDialog.returnValue !== "export") return
  const format = byId("zip-format").value
  requestExport(state.pages, () => performExport(async () => {
    const pages = copyEditor({ pages: state.pages }).pages
    if (format === "png" && nativeReady) {
      const transfer = await desktop.projectBegin("zip", "khung-thoai-png.zip")
      if (!transfer) return
      try {
        for (const [index, page] of pages.entries()) {
          status(`Đang xuất PNG bằng C# ${index + 1}/${pages.length}…`)
          const { options, data } = await nativePageLayers(page)
          const name = String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name) + ".png"
          await desktop.projectWrite(transfer.id, "zipPage", { ...options, name }, data)
        }
        await desktop.projectWrite(transfer.id, "fileCommit")
      } catch (error) {
        await desktop.projectWrite(transfer.id, "fileCancel").catch(() => {})
        throw error
      }
      return
    }
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    for (const [index, page] of pages.entries()) {
      status(`Đang xuất trang ${index + 1} / ${pages.length}…`)
      const name = String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name)
      zip.file(name + "." + extensionFor(format), await exportPage(page, format))
    }
    saveFile(await zip.generateAsync({ type: "blob" }), "khung-thoai-" + format + ".zip")
  }))
})

const findDialog = byId("find-replace-dialog")
function findOptions() {
  return {
    caseSensitive: byId("find-case").checked,
    wholeWord: byId("find-word").checked,
    includeUnplaced: byId("find-unplaced").checked,
  }
}
function renderFindResults() {
  const query = byId("find-query").value
  const matches = findMatches(state.pages, query, findOptions())
  const totalHits = matches.reduce((sum, item) => sum + item.count, 0)
  byId("find-summary").textContent = query
    ? `Tìm thấy ${totalHits} vị trí trong ${matches.length} mục.`
    : "Nhập từ khóa để tìm trong toàn bộ chương."
  byId("replace-all-btn").disabled = !matches.length || projectBusy()
  byId("find-results").replaceChildren(...matches.map((match) => {
    const li = document.createElement("li")
    const label = `Trang ${match.pageIndex + 1}${match.isUnplaced ? " (Chưa đặt)" : ""}: ${match.text.slice(0, 80)}`
    li.append(listButton(label, () => {
      findDialog.close()
      location.hash = "editor"
      const page = state.pages[match.pageIndex]
      if (page) selectPage(page)
      if (!match.isUnplaced) {
        const box = page?.boxes.find((item) => item.id === match.boxId)
        if (box) selectBox(box)
      } else {
        byId("queue-section").scrollIntoView({ block: "nearest" })
      }
    }))
    return li
  }))
}
function openFindDialog() {
  if (!findDialog.open) findDialog.showModal()
  renderFindResults()
  byId("find-query").focus()
}
byId("open-find").onclick = openFindDialog
byId("close-find").onclick = () => findDialog.close()
for (const id of ["find-query", "find-case", "find-word", "find-unplaced"]) {
  byId(id).addEventListener("input", renderFindResults)
  byId(id).addEventListener("change", renderFindResults)
}
byId("replace-all-btn").onclick = () => {
  const query = byId("find-query").value
  if (!query || projectBusy()) return
  commitLiveFormCheckpoint()
  const before = editorSnapshot()
  const { replacedItems, replacedOccurrences, skippedEmpty } = replaceMatches(
    state.pages, query, byId("replace-text").value, findOptions(),
  )
  if (!replacedOccurrences) {
    if (skippedEmpty) status(`Bỏ qua ${skippedEmpty} khung vì thay thế sẽ làm trống nội dung.`, true)
    return
  }
  checkpoint(before)
  render()
  renderFindResults()
  status(
    `Đã thay thế ${replacedOccurrences} vị trí trong ${replacedItems} mục.` +
    (skippedEmpty ? ` Bỏ qua ${skippedEmpty} khung tránh để trống.` : ""),
  )
}

const shortcutsDialog = byId("shortcuts-dialog")
byId("open-shortcuts").onclick = () => shortcutsDialog.showModal()
byId("close-shortcuts").onclick = () => shortcutsDialog.close()

async function refreshWebRecovery() {
  if (desktop?.native) return
  const info = await getWebSnapshotInfo()
  byId("web-recovery").hidden = !info
  if (info) {
    const time = new Date(info.savedAt).toLocaleTimeString("vi-VN")
    byId("web-autosave-status").textContent = `Bản tự lưu web (${info.pageCount} trang · ${time})`
  }
}
async function webAutosave() {
  if (desktop?.native || autosaving || projectBusy() || gesture || !state.pages.length || savedRevision === revision) return
  autosaving = true
  const snapshotRevision = revision
  try {
    const ok = await saveWebSnapshot(projectBlob(), {
      name: (projectName ?? filenameStem(state.pages[0]?.name ?? "khung-thoai")) + projectExtension,
      pageCount: state.pages.length,
    })
    if (ok) {
      savedRevision = snapshotRevision
      await refreshWebRecovery()
    }
  } catch {
    // Ignore transient IndexedDB or quota errors during background web autosave.
  } finally {
    autosaving = false
  }
}
if (!desktop?.native) {
  refreshWebRecovery()
  setInterval(webAutosave, 25000)
}
byId("recover-web").onclick = async () => {
  const file = await loadWebSnapshot()
  if (!file) return status("Không tìm thấy bản tự lưu web.", true)
  await loadProject(file)
}
byId("clear-web-recovery").onclick = async () => {
  await clearWebSnapshot()
  await refreshWebRecovery()
  status("Đã xóa bản tự lưu trình duyệt.")
}

updateFitLabel()
render()
