import { autoFitBox, clamp, drawPage, makeBox, textOverflows } from "./canvas.js"
import { groupDialogue, isImageFile, readDialogueFile } from "./io.js"
import { setupLibrary } from "./library.js"
import { matchDialogue, toCoordinates, toRectangle } from "./placement.js"
import { projectPageLimit as pageLimit, projectSettingIds, projectStyle } from "./project.js"

import { copyEditor, EditHistory } from "./history.js"
import { cleanupRectangle, paintCleanupMask } from "./cleanup.js"
import { remainingTranslations, translationLabel } from "./translation.js"
import { allFonts, loadCustomFont, registerFontName, restoreCustomFonts } from "./fonts.js"
import { alignBoxes, distributeBoxes, duplicateBox, nudgeBox, reorderBox } from "./tools.js"
import { cleanRawPageImage } from "./raw-cleanup.js"
import { createNotificationCenter } from "./notifications.js"
import {
  APP_VERSION,
  RELEASES_PAGE_URL,
  checkAppUpdate,
  dismissUpdateVersion,
  formatBytes,
  openExternalUrl,
} from "./updater.js"

import { setupTasks } from "./controllers/tasks.js"
import { setupProjects } from "./controllers/project.js"
import { setupTranslation } from "./controllers/translation.js"
import { setupOcr } from "./controllers/ocr.js"
import { setupExports } from "./controllers/export.js"
import { setupDialogs } from "./controllers/dialogs.js"
import { setupGestures } from "./controllers/gestures.js"
import { setupChat } from "./controllers/chat.js"

const history = new EditHistory()
const ownedUrls = new Set()
const byId = (id) => document.getElementById(id)
const stage = byId("stage")
const overlays = byId("overlays")
const pageCanvas = byId("page-canvas")
const viewport = byId("viewport")
const form = byId("box-form")
const editorStatus = byId("status")
const exportButtons = [...document.querySelectorAll("[data-export]")]
const state = {
  pages: [], presets: [], pageId: null, boxId: null, selectedBoxIds: new Set(),
  queue: [], placing: false, fit: true, zoom: null, compareOriginal: false, cloneSource: null,
  exporting: false, importing: false, translating: false, importingScript: false,
  openingProject: false, processingNative: false, savingProject: false,
}
const projectSettings = projectSettingIds.map(byId)
const defaultProjectSettings = projectSettings.map(({ value }) => value)
let previewRedraw
let nativeReady = false
let nativeLanguages = []
let formEditSnapshot = null

const selectedPage = () => state.pages.find((page) => page.id === state.pageId)
const selectedBox = () => selectedPage()?.boxes.find((box) => box.id === state.boxId)
const selectedIndex = () => state.pages.findIndex((page) => page.id === state.pageId)
const boxFields = {
  text: "box-text", size: "box-size", font: "box-font", color: "box-color",
  align: "box-align", rotation: "box-rotation",
  lineHeight: "box-line-height", strokeWidth: "box-stroke-width", strokeColor: "box-stroke-color",
  shadowBlur: "box-shadow-blur", shadowColor: "box-shadow-color",
  fillShape: "box-fill-shape", fillColor: "box-fill-color",
}
const resizeHandleNames = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

function editorSnapshot() {
  return copyEditor({
    pages: state.pages, queue: state.queue, presets: state.presets,
    pageId: state.pageId, boxId: state.boxId,
    settings: Object.fromEntries(projectSettings.map(({ id, value }) => [id, value])),
  })
}

function commitLiveFormCheckpoint() {
  if (!formEditSnapshot) return false
  const before = formEditSnapshot
  formEditSnapshot = null
  checkpoint(before)
  return true
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

function checkpoint(snapshot) {
  if (!snapshot) {
    if (formEditSnapshot) {
      const pending = formEditSnapshot
      formEditSnapshot = null
      projects.changed()
      history.record(pending)
      syncProjectActions()
      return
    }
    snapshot = editorSnapshot()
  }
  projects.changed()
  history.record(snapshot)
  syncProjectActions()
}

function syncSelectionAfterRestore() {
  const page = selectedPage()
  state.selectedBoxIds.clear()
  if (page && state.boxId && page.boxes.some((box) => box.id === state.boxId)) {
    state.selectedBoxIds.add(state.boxId)
  } else {
    state.boxId = null
  }
}

function restoreHistory(direction) {
  if (projectBusy() || gestures.hasGesture()) return
  commitLiveFormCheckpoint()
  const snapshot = history[direction](editorSnapshot())
  if (!snapshot) return
  const { settings, ...editor } = snapshot
  projects.changed()
  Object.assign(state, editor, { placing: false })
  syncSelectionAfterRestore()
  projectSettings.forEach((field) => { field.value = settings[field.id] })
  render()
  releaseUnusedImages()
  status(direction === "undo" ? "Đã hoàn tác." : "Đã làm lại.")
}

function renderFontOptions() {
  const select = byId("box-font")
  const current = select.value
  select.replaceChildren(...allFonts().map((name) => new Option(name, name)))
  if ([...select.options].some((option) => option.value === current)) select.value = current
}

byId("font-file").onchange = async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file || projectBusy()) return
  try {
    const family = await loadCustomFont(file)
    renderFontOptions()
    const box = selectedBox()
    if (box) {
      commitLiveFormCheckpoint()
      checkpoint()
      box.font = family
      byId("box-font").value = family
      renderCanvas()
      renderInspector()
    }
    status(`Đã nạp và lưu font "${family}".`)
  } catch (error) {
    status(error.message, true)
  }
}

byId("undo").onclick = () => restoreHistory("undo")
byId("redo").onclick = () => restoreHistory("redo")

for (const field of projectSettings) {
  field.addEventListener("input", () => { projects.changed() })
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
  const aborted = gestures.abortGesture()
  if (aborted) {
    const { settings, ...editor } = aborted
    Object.assign(state, editor)
    page = state.pages.find((item) => item.id === page?.id)
  }
  state.pageId = page?.id ?? null
  state.boxId = null
  state.selectedBoxIds.clear()
  state.placing = false
  state.cloneSource = null
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
  byId("new-project").disabled = projectBusy()
  byId("images").disabled = projectBusy()
  byId("script-file").disabled = projectBusy()
}

let chat
function syncTranslationActions() {
  byId("resume-translation").disabled = projectBusy() || !remainingTranslations(state.pages, translation.settings()).length
  byId("pages").querySelectorAll(".page-job").forEach((element, index) => {
    const page = state.pages[index]
    element.dataset.state = page.translationJob?.state ?? "pending"
    element.textContent = translationLabel(page, translation.settings())
  })
  chat?.refreshModelBadge()
}

function syncToolControls() {
  const tool = byId("cleanup-tool").value
  const page = selectedPage()
  const hasRetouch = Boolean(page?.retouchStrokes?.length)
  byId("paint-color-field").hidden = tool !== "paint"
  byId("paint-opacity-field").hidden = !["paint", "clone", "inpaint", "retouch-erase"].includes(tool)
  byId("clean-raw").disabled = projectBusy() || !page
  byId("undo-retouch").hidden = !hasRetouch
  byId("clear-retouch").hidden = !hasRetouch
  byId("undo-retouch").disabled = projectBusy() || !hasRetouch
  byId("clear-retouch").disabled = projectBusy() || !hasRetouch
  byId("eyedropper-readout").hidden = tool !== "eyedropper" || !byId("eyedropper-readout").textContent
}

function renderPages() {
  projects.refreshDirty()
  const current = selectedIndex()
  const count = state.pages.length
  if (!state.importing && !state.openingProject) releaseUnusedImages()
  byId("page-count").textContent = count + " / " + pageLimit
  byId("page-indicator").textContent = current === -1 ? "Chưa có trang" : `Trang ${current + 1} / ${count}`
  byId("prev-page").disabled = current <= 0
  byId("next-page").disabled = current < 0 || current >= count - 1
  byId("apply-script").disabled = current < 0 || projectBusy()
  byId("export-script").disabled = !count || projectBusy()
  byId("translate-boxes").disabled = current < 0 || !(selectedPage()?.boxes.length) || projectBusy()
  byId("translate").disabled = current < 0 || projectBusy()
  byId("align-script").disabled = current < 0 || projectBusy()
  byId("translate-all").disabled = !count || projectBusy()
  byId("fit-page").disabled = current < 0
  byId("zoom-in").disabled = current < 0
  byId("zoom-out").disabled = current < 0
  byId("compare-original").disabled = current < 0
  byId("add-box").disabled = current < 0 || projectBusy()
  byId("autofit-page").disabled = current < 0 || !(selectedPage()?.boxes.length) || projectBusy()
  byId("export-all").disabled = !count || projectBusy()
  exportButtons.forEach((button) => { button.disabled = current < 0 || projectBusy() })
  syncProjectActions()
  syncToolControls()
  byId("box-form").inert = projectBusy()
  projectSettings.forEach((field) => { field.disabled = state.translating || state.openingProject })
  byId("resume-translation").disabled = projectBusy() || !remainingTranslations(state.pages, translation.settings()).length
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
    job.textContent = translationLabel(page, translation.settings())
    li.append(button, up, down, remove, job)
    return li
  }))
}

function rectStyle(element, rect) {
  for (const [name, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })) {
    element.style[name] = value * 100 + "%"
  }
  element.style.transform = rect.rotation ? `rotate(${rect.rotation}deg)` : ""
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
  gestures.cancelPendingPaint()
  const page = selectedPage()
  const tool = byId("cleanup-tool").value
  stage.hidden = !page
  byId("canvas-empty").hidden = Boolean(page)
  byId("add-box").setAttribute("aria-pressed", String(state.placing))
  byId("compare-original").setAttribute("aria-pressed", String(state.compareOriginal))
  stage.classList.toggle("placing", state.placing)
  stage.classList.toggle("panning", tool === "pan" || gestures.getSpaceHeld())
  stage.classList.toggle("eyedropper", tool === "eyedropper")
  stage.classList.toggle("bubble", tool === "bubble")
  stage.classList.toggle("cleaning", tool !== "text" && tool !== "pan" && tool !== "eyedropper" && tool !== "bubble")
  gestures.updateZoomDisplay()
  if (!page) {
    overlays.replaceChildren()
    pageCanvas.width = 1
    pageCanvas.height = 1
    return
  }
  const stageWidth = state.zoom
    ? Math.max(120, Math.round(page.image.naturalWidth * state.zoom))
    : Math.min(page.image.naturalWidth, state.fit ? 720 : Infinity)
  stage.style.width = stageWidth + "px"
  stage.style.maxWidth = state.fit && !state.zoom ? "100%" : "none"
  stage.style.flexShrink = state.fit && !state.zoom ? "1" : "0"
  paintPreview(page)

  const multiCount = state.selectedBoxIds.size
  overlays.replaceChildren(...page.boxes.map((box) => {
    const outline = document.createElement("div")
    outline.className = "outline"
    outline.setAttribute("role", "button")
    outline.setAttribute("tabindex", "0")
    outline.setAttribute("aria-label", box.text)
    outline.dataset.box = box.id
    const isPrimary = box.id === state.boxId
    const isMulti = state.selectedBoxIds.has(box.id)
    if (isPrimary) outline.setAttribute("aria-current", "true")
    if (isMulti && multiCount > 1) outline.classList.add("multi-selected")
    outline.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        selectBox(box)
      }
    })
    rectStyle(outline, box)
    if (isPrimary && multiCount <= 1 && tool === "text" && !state.placing && !state.compareOriginal) {
      for (const handle of resizeHandleNames) {
        const dot = document.createElement("span")
        dot.className = "resize-handle"
        dot.dataset.handle = handle
        outline.append(dot)
      }
      const rot = document.createElement("span")
      rot.className = "rotate-handle"
      rot.title = "Kéo để xoay (giữ Shift theo nấc 15°)"
      outline.append(rot)
    }
    return outline
  }))
  renderCleanupOverlay()
  gestures.renderCloneMarker()
}

function freezeCleanup(box) {
  if (box.cleanupRect) return
  const { x, y, w, h } = cleanupRectangle(box)
  box.cleanupRect = { x, y, w, h }
}

function renderCleanupOverlay() {
  const canvas = byId("cleanup-overlay")
  canvas.width = pageCanvas.width
  canvas.height = pageCanvas.height
  const box = selectedBox()
  const tool = byId("cleanup-tool").value
  if (!box || !["region", "erase", "restore"].includes(tool)) return
  const rect = cleanupRectangle(box)
  const left = Math.floor(rect.x * canvas.width)
  const top = Math.floor(rect.y * canvas.height)
  const mask = document.createElement("canvas")
  mask.width = Math.max(1, Math.ceil((rect.x + rect.w) * canvas.width) - left)
  mask.height = Math.max(1, Math.ceil((rect.y + rect.h) * canvas.height) - top)
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
  const box = selectedBox()
  const name = byId("preset-name").value.trim()
  if (!box || projectBusy()) return
  if (!name) return status("Hãy nhập tên mẫu dàn chữ.", true)
  commitLiveFormCheckpoint()
  checkpoint()
  const preset = { name, style: projectStyle(box) }
  const index = state.presets.findIndex((item) => item.name === name)
  if (index < 0) state.presets.push(preset)
  else state.presets[index] = preset
  renderPresets()
  byId("style-preset").value = String(index < 0 ? state.presets.length - 1 : index)
  status("Đã lưu mẫu " + name + ".")
}

byId("apply-preset").onclick = () => {
  const preset = state.presets[Number(byId("style-preset").value)]
  if (!preset || projectBusy()) return
  commitLiveFormCheckpoint()
  const scope = byId("preset-scope").value
  const page = selectedPage()
  const boxes = scope === "chapter"
    ? state.pages.flatMap((p) => p.boxes)
    : scope === "page"
      ? (page?.boxes ?? [])
      : state.selectedBoxIds.size > 1 && page
        ? page.boxes.filter((b) => state.selectedBoxIds.has(b.id))
        : [selectedBox()].filter(Boolean)
  if (!boxes.length) return status("Hãy chọn khung để áp dụng mẫu.", true)
  checkpoint()
  const defaults = {
    bold: false, italic: false, uppercase: false, vertical: false,
    bubbleFit: false, warp: "none", warpAmount: 0,
    lineHeight: 1.15, strokeWidth: 0, strokeColor: "#ffffff",
    shadowBlur: 0, shadowColor: "#000000",
    fillColor: "#ffffff", fillShape: "rect",
  }
  boxes.forEach((box) => Object.assign(box, defaults, preset.style))
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
  commitLiveFormCheckpoint()
  checkpoint()
  delete box.cleanupRect
  delete box.cleanupStrokes
  delete box.cleanupExpand
  freezeCleanup(box)
  render()
}

byId("undo-retouch").onclick = () => {
  const page = selectedPage()
  if (!page?.retouchStrokes?.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  page.retouchStrokes.pop()
  render()
  status("Đã hoàn tác nét cọ gần nhất.")
}

byId("clear-retouch").onclick = () => {
  const page = selectedPage()
  if (!page?.retouchStrokes?.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  page.retouchStrokes = []
  render()
  status("Đã xóa toàn bộ nét vẽ tay trên trang.")
}

byId("clean-raw").onclick = async () => {
  const page = selectedPage()
  if (!page || projectBusy()) return
  commitLiveFormCheckpoint()
  state.processingNative = true
  renderPages()
  status("Đang làm sạch ảnh raw (cân bằng trắng, khử nhiễu, tăng sắc nét)…")
  try {
    const { file, engine } = await cleanRawPageImage(page, { strength: 0.7, denoise: true, sharpen: true })
    const decoded = await openImage(file)
    checkpoint()
    page.file = decoded.file
    page.image = decoded.image
    page.url = decoded.url
    render()
    status(`Đã làm sạch ảnh raw (${engine === "native-cs" ? "C#" : "JS"}). Nhấn Ctrl+Z nếu muốn hoàn tác.`)
    notify({
      kind: "success",
      title: "Đã làm sạch ảnh raw",
      message: `Trang ${page.name} đã được xử lý cân bằng giấy & khử nhiễu (${engine === "native-cs" ? "lõi C#" : "JS"}).`,
      key: `clean-raw-${page.id}`,
      actions: [{ label: "Hoàn tác", onClick: () => restoreHistory("undo") }],
    })
  } catch (error) {
    status("Không thể làm sạch ảnh raw. " + error.message, true)
  } finally {
    state.processingNative = false
    render()
  }
}

byId("cleanup-tool").onchange = () => {
  state.placing = false
  syncToolControls()
  renderCanvas()
  const tool = byId("cleanup-tool").value
  if (tool === "pan") status("Kéo trên ảnh để di chuyển bản vẽ (hoặc giữ phím Space).")
  else if (tool === "bubble") status("Bấm vào bên trong một bong bóng thoại sáng để tự động tạo khung khớp viền.")
  else if (tool === "eyedropper") status("Bấm lên ảnh để hút màu cho cọ vẽ (Shift+bấm để đổi màu chữ).")
  else if (tool === "paint") status("Kéo cọ trên ảnh để vẽ che chữ theo màu cọ đã chọn.")
  else if (tool === "clone") status("Giữ Alt + bấm vùng nền mẫu, sau đó kéo cọ để sao chép nền che chữ.")
  else if (tool === "inpaint") status("Tô cọ lên chữ trên nền tranh phức tạp để tự động tái tạo nền phía sau (PatchMatch + Poisson).")
  else if (tool === "retouch-erase") status("Tô lên vùng đã vẽ/tẩy để xóa cục bộ nét redraw và lộ lại ảnh gốc.")
  else if (tool !== "text") status("Chọn khung thoại rồi khoanh vùng hoặc vẽ cọ trên ảnh.")
}
byId("show-cleanup").onchange = renderCanvas
byId("show-text").onchange = renderCanvas

function selectBox(box) {
  commitLiveFormCheckpoint()
  state.boxId = box.id
  state.selectedBoxIds.clear()
  state.selectedBoxIds.add(box.id)
  renderCanvas()
  renderInspector()
}

function toggleSelectBox(box) {
  commitLiveFormCheckpoint()
  if (state.selectedBoxIds.has(box.id)) {
    state.selectedBoxIds.delete(box.id)
    if (state.boxId === box.id) {
      state.boxId = [...state.selectedBoxIds].at(-1) ?? null
    }
  } else {
    state.selectedBoxIds.add(box.id)
    state.boxId = box.id
  }
  renderCanvas()
  renderInspector()
}

function renderInspector() {
  const page = selectedPage()
  const box = selectedBox()
  const boxes = page?.boxes ?? []
  const multiCount = state.selectedBoxIds.size
  renderPresets()
  syncToolControls()
  byId("autofit-page").disabled = !boxes.length || projectBusy()
  byId("translate-boxes").disabled = !boxes.length || projectBusy()
  byId("cleanup-inspector").hidden = !box
  byId("reset-cleanup").disabled = projectBusy()
  byId("box-count").textContent = boxes.length

  const multiPanel = byId("multi-select-panel")
  multiPanel.hidden = multiCount < 2
  if (multiCount >= 2) {
    byId("multi-select-count").textContent = `Đang chọn ${multiCount} khung (Shift+bấm để thêm/bớt).`
    multiPanel.querySelectorAll("[data-distribute]").forEach((btn) => {
      btn.disabled = multiCount < 3 || projectBusy()
    })
    multiPanel.querySelectorAll("[data-align], #multi-autofit, #multi-delete").forEach((btn) => {
      btn.disabled = projectBusy()
    })
  }

  byId("inspector-empty").hidden = Boolean(box) || multiCount >= 2
  form.hidden = !box
  if (box) {
    registerFontName(box.font)
    renderFontOptions()
    byId("box-text").value = box.text
    byId("box-size").value = box.size
    byId("box-font").value = box.font
    byId("box-color").value = box.color
    byId("box-align").value = box.align
    byId("box-rotation").value = box.rotation
    byId("box-bold").checked = Boolean(box.bold)
    byId("box-italic").checked = Boolean(box.italic)
    byId("box-uppercase").checked = Boolean(box.uppercase)
    byId("box-vertical").checked = Boolean(box.vertical)
    byId("box-bubble-fit").checked = Boolean(box.bubbleFit)
    byId("box-warp").value = box.warp ?? "none"
    byId("box-warp-amount").value = box.warpAmount ?? 0
    byId("box-line-height").value = box.lineHeight ?? 1.15
    byId("box-stroke-width").value = box.strokeWidth ?? 0
    byId("box-stroke-color").value = box.strokeColor ?? "#ffffff"
    byId("box-shadow-blur").value = box.shadowBlur ?? 0
    byId("box-shadow-color").value = box.shadowColor ?? "#000000"
    byId("box-fill").checked = box.fill
    byId("box-fill-shape").value = box.fillShape ?? "rect"
    byId("box-fill-color").value = box.fillColor ?? "#ffffff"
    byId("box-cleanup").checked = Boolean(box.cleanup)
    byId("cleanup-expand").value = box.cleanupExpand ?? 0
    const idx = boxes.findIndex((item) => item.id === box.id)
    byId("box-layer-down").disabled = idx <= 0 || projectBusy()
    byId("box-layer-up").disabled = idx < 0 || idx >= boxes.length - 1 || projectBusy()
  }
  byId("boxes").replaceChildren(...boxes.map((item) => {
    const li = document.createElement("li")
    const button = listButton(item.text, (event) => {
      if (event.shiftKey) toggleSelectBox(item)
      else selectBox(item)
    })
    if (box?.id === item.id || state.selectedBoxIds.has(item.id)) button.setAttribute("aria-current", "true")
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
      commitLiveFormCheckpoint()
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
    return { id: crypto.randomUUID(), name: file.name, file, image, url, boxes: [], unplaced: [], retouchStrokes: [] }
  } catch (error) {
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
    throw error
  }
}

async function importPages(files) {
  if (projectBusy()) return []
  commitLiveFormCheckpoint()
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
  byId("fit-page").textContent = state.fit ? "Vừa trang" : "Kích thước gốc"
}
byId("fit-page").onclick = () => {
  state.zoom = null
  state.fit = !state.fit
  updateFitLabel()
  renderCanvas()
}
byId("compare-original").onclick = () => {
  if (!selectedPage()) return
  state.compareOriginal = !state.compareOriginal
  renderCanvas()
  status(state.compareOriginal ? "Đang xem ảnh gốc (nhấn \\ để quay lại)." : "Đã quay lại bản biên tập.")
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
  commitLiveFormCheckpoint()
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
  notifyOverflowIfAny(current, "sau khi dàn kịch bản")
}

function addBox(rectangle, line, record = true) {
  const page = selectedPage()
  if (!page || projectBusy()) return
  commitLiveFormCheckpoint()
  if (record) checkpoint()
  const box = makeBox(page, rectangle, line)
  page.boxes.push(box)
  state.boxId = box.id
  state.selectedBoxIds.clear()
  state.selectedBoxIds.add(box.id)
  state.placing = false
  renderCanvas()
  renderInspector()
  status("Đã thêm khung chữ.")
}

byId("add-box").onclick = () => {
  byId("cleanup-tool").value = "text"
  syncToolControls()
  state.placing = !state.placing
  renderCanvas()
  if (state.placing) {
    stage.focus()
    status("Bấm hoặc kéo trên ảnh để đặt khung, hoặc nhấn Enter.")
  } else {
    status("Đã thoát chế độ đặt khung.")
  }
}

function applyFormToBox(box, { requireText = false } = {}) {
  const trimmed = byId("box-text").value.trim()
  if (requireText && !trimmed) return false
  if (trimmed) box.text = trimmed
  box.font = byId("box-font").value
  box.size = clamp(Number(byId("box-size").value) || box.size, 8, 400)
  box.lineHeight = clamp(Number(byId("box-line-height").value) || 1.15, .8, 2.2)
  box.color = byId("box-color").value
  box.rotation = clamp(Number(byId("box-rotation").value) || 0, -180, 180)
  box.align = byId("box-align").value
  box.bold = byId("box-bold").checked
  box.italic = byId("box-italic").checked
  box.uppercase = byId("box-uppercase").checked
  box.vertical = byId("box-vertical").checked
  box.bubbleFit = byId("box-bubble-fit").checked
  box.warp = byId("box-warp").value
  box.warpAmount = clamp(Number(byId("box-warp-amount").value) || 0, -50, 50)
  box.strokeWidth = clamp(Number(byId("box-stroke-width").value) || 0, 0, 24)
  box.strokeColor = byId("box-stroke-color").value
  box.shadowBlur = clamp(Number(byId("box-shadow-blur").value) || 0, 0, 24)
  box.shadowColor = byId("box-shadow-color").value
  box.fill = byId("box-fill").checked
  box.fillShape = byId("box-fill-shape").value
  box.fillColor = byId("box-fill-color").value
  box.cleanup = byId("box-cleanup").checked
  if (box.cleanup) freezeCleanup(box)
  return true
}

function liveUpdateForm() {
  const box = selectedBox()
  const page = selectedPage()
  if (!box || !page || projectBusy()) return
  if (!formEditSnapshot) formEditSnapshot = editorSnapshot()
  applyFormToBox(box)
  projects.changed()
  const outline = overlays.querySelector('[aria-current="true"]')
  if (outline) rectStyle(outline, box)
  paintPreview(page)
}
form.addEventListener("input", liveUpdateForm)
form.addEventListener("change", liveUpdateForm)

form.onsubmit = (event) => {
  event.preventDefault()
  const box = selectedBox()
  if (!box || projectBusy()) return
  const text = byId("box-text").value.trim()
  if (!text) return status("Hãy nhập nội dung khung.", true)
  if (!commitLiveFormCheckpoint()) checkpoint()
  applyFormToBox(box, { requireText: true })
  renderPages()
  renderCanvas()
  renderInspector()
  status("Đã lưu khung.")
}

function deleteSelectedBoxes() {
  const page = selectedPage()
  if (!page || projectBusy()) return
  const ids = state.selectedBoxIds.size ? new Set(state.selectedBoxIds) : (state.boxId ? new Set([state.boxId]) : null)
  if (!ids?.size) return
  commitLiveFormCheckpoint()
  checkpoint()
  const removed = page.boxes.filter((box) => ids.has(box.id)).length
  page.boxes = page.boxes.filter((box) => !ids.has(box.id))
  state.boxId = null
  state.selectedBoxIds.clear()
  renderCanvas()
  renderInspector()
  status(removed > 1 ? `Đã xóa ${removed} khung.` : "Đã xóa khung.")
}

byId("delete-box").onclick = deleteSelectedBoxes
byId("multi-delete").onclick = deleteSelectedBoxes

byId("autofit-box").onclick = () => {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  const next = autoFitBox(page, box)
  box.size = next
  byId("box-size").value = next
  renderCanvas()
  renderInspector()
  status(`Đã tự khớp cỡ chữ ${next} px.`)
}

byId("autofit-page").onclick = () => {
  const page = selectedPage()
  if (!page?.boxes.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  page.boxes.forEach((box) => { box.size = autoFitBox(page, box) })
  render()
  status(`Đã khớp cỡ chữ cho ${page.boxes.length} khung trên trang.`)
}

byId("multi-autofit").onclick = () => {
  const page = selectedPage()
  if (!page || state.selectedBoxIds.size < 2 || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  const targets = page.boxes.filter((box) => state.selectedBoxIds.has(box.id))
  targets.forEach((box) => { box.size = autoFitBox(page, box) })
  render()
  status(`Đã khớp cỡ chữ cho ${targets.length} khung đã chọn.`)
}

document.querySelectorAll("[data-align]").forEach((button) => {
  button.onclick = () => {
    const page = selectedPage()
    if (!page || state.selectedBoxIds.size < 2 || projectBusy()) return
    commitLiveFormCheckpoint()
    const before = editorSnapshot()
    if (!alignBoxes(page.boxes, state.selectedBoxIds, button.dataset.align)) return
    checkpoint(before)
    render()
    status("Đã căn hàng các khung đã chọn.")
  }
})

document.querySelectorAll("[data-distribute]").forEach((button) => {
  button.onclick = () => {
    const page = selectedPage()
    if (!page || state.selectedBoxIds.size < 3 || projectBusy()) return
    commitLiveFormCheckpoint()
    const before = editorSnapshot()
    if (!distributeBoxes(page.boxes, state.selectedBoxIds, button.dataset.distribute)) return
    checkpoint(before)
    render()
    status("Đã chia đều khoảng cách các khung đã chọn.")
  }
})

function duplicateSelectedBox() {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  const copy = duplicateBox(box)
  page.boxes.push(copy)
  state.boxId = copy.id
  state.selectedBoxIds.clear()
  state.selectedBoxIds.add(copy.id)
  render()
  status("Đã nhân bản khung.")
}
byId("duplicate-box").onclick = duplicateSelectedBox

function moveBoxLayer(delta) {
  const page = selectedPage()
  if (!page || !state.boxId || projectBusy()) return
  commitLiveFormCheckpoint()
  const result = reorderBox(page.boxes, state.boxId, delta)
  if (!result.moved) return
  checkpoint()
  page.boxes = result.boxes
  render()
  status(delta > 0 ? "Đã đưa khung lên lớp trên." : "Đã đưa khung xuống lớp dưới.")
}
byId("box-layer-up").onclick = () => moveBoxLayer(1)
byId("box-layer-down").onclick = () => moveBoxLayer(-1)

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

byId("cleanup-expand").onchange = () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint()
  box.cleanupExpand = clamp(Math.round(Number(byId("cleanup-expand").value) || 0), -8, 8)
  render()
}

// Global keyboard shortcuts.
document.addEventListener("keydown", (event) => {
  const editingText = Boolean(event.target.closest("input, textarea, select, [contenteditable]"))
  const key = event.key.toLowerCase()
  if (event.ctrlKey || event.metaKey) {
    if (event.altKey) return
    if ((key === "h" || key === "f") && !event.shiftKey) {
      event.preventDefault()
      dialogs.openFind()
      return
    }
    if (editingText) return
    if (key === "z" || key === "y") {
      event.preventDefault()
      restoreHistory(key === "y" || event.shiftKey ? "redo" : "undo")
      return
    }
    if (key === "d" && selectedBox()) {
      event.preventDefault()
      duplicateSelectedBox()
      return
    }
    return
  }
  if (editingText) return
  if (event.key === " " && !event.repeat && selectedPage()) {
    event.preventDefault()
    gestures.setSpaceHeld(true)
    return
  }
  if (event.key === "\\" && selectedPage()) {
    event.preventDefault()
    state.compareOriginal = !state.compareOriginal
    renderCanvas()
    return
  }
  if (event.key === "?") {
    event.preventDefault()
    dialogs.openShortcuts()
    return
  }
  if ((event.key === "Delete" || event.key === "Backspace") && (state.boxId || state.selectedBoxIds.size)) {
    event.preventDefault()
    deleteSelectedBoxes()
    return
  }
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && event.target !== stage) {
    const page = selectedPage()
    const targets = page && state.selectedBoxIds.size > 1
      ? page.boxes.filter((item) => state.selectedBoxIds.has(item.id))
      : [selectedBox()].filter(Boolean)
    if (!targets.length || projectBusy()) return
    event.preventDefault()
    const stepPx = event.shiftKey ? 10 : 1
    const dx = (event.key === "ArrowRight" ? stepPx : event.key === "ArrowLeft" ? -stepPx : 0) / page.image.naturalWidth
    const dy = (event.key === "ArrowDown" ? stepPx : event.key === "ArrowUp" ? -stepPx : 0) / page.image.naturalHeight
    commitLiveFormCheckpoint()
    checkpoint()
    for (const item of targets) Object.assign(item, nudgeBox(item, dx, dy))
    renderCanvas()
  }
})

document.addEventListener("keyup", (event) => {
  if (event.key === " " && gestures.getSpaceHeld()) {
    gestures.setSpaceHeld(false)
  }
})
window.addEventListener("blur", () => {
  if (gestures.getSpaceHeld()) gestures.setSpaceHeld(false)
})

const notifications = createNotificationCenter({ byId })
const notify = (options) => notifications.notify(options)

function notifyOverflowIfAny(page, sourceLabel = "") {
  if (!page?.boxes?.length) return
  let overflowCount = 0
  for (const box of page.boxes) {
    try {
      if (textOverflows(page, box)) overflowCount++
    } catch {
      // Ignore canvas measurement errors.
    }
  }
  if (!overflowCount) return
  notify({
    kind: "warning",
    title: `Có ${overflowCount} khung bị tràn chữ`,
    message: `Trang ${page.name}${sourceLabel ? ` (${sourceLabel})` : ""} có ${overflowCount}/${page.boxes.length} khung chữ vượt quá kích thước khung.`,
    key: `overflow-${page.id}`,
    actions: [
      {
        label: "Khớp cỡ cả trang",
        primary: true,
        onClick: () => {
          if (selectedPage() !== page) selectPage(page)
          byId("autofit-page")?.click()
        },
      },
    ],
  })
}

const updateDialog = byId("update-dialog")
let activeUpdateResult = null
function showUpdateDialog(result) {
  if (!updateDialog || !result) return
  activeUpdateResult = result
  const release = result.release ?? {}
  byId("update-dialog-title").textContent = result.hasUpdate
    ? `Có bản cập nhật mới v${result.latestVersion}`
    : "Khung Thoại đã ở phiên bản mới nhất"
  const dateText = release.publishedAt
    ? " · phát hành " + new Date(release.publishedAt).toLocaleDateString("vi-VN")
    : ""
  byId("update-version-row").textContent = result.hasUpdate
    ? `Hiện tại: v${result.currentVersion} → Mới nhất: v${result.latestVersion}${dateText}`
    : `Phiên bản hiện tại: v${result.currentVersion} (mới nhất${dateText})`
  byId("update-notes").textContent = release.notes
    || (result.hasUpdate
      ? "Mở trang GitHub Releases để tải bản mới nhất và xem đầy đủ thay đổi."
      : "Bạn đang dùng phiên bản mới nhất của Khung Thoại.")

  const assetsEl = byId("update-assets")
  const assets = Array.isArray(release.assets) ? release.assets : []
  assetsEl.hidden = !result.hasUpdate || !assets.length
  if (!assetsEl.hidden) {
    assetsEl.replaceChildren(
      ...assets.map((asset) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "button"
        const nameSpan = document.createElement("span")
        nameSpan.textContent = "↓ " + asset.name
        const sizeSpan = document.createElement("span")
        sizeSpan.className = "muted"
        sizeSpan.textContent = formatBytes(asset.size)
        btn.append(nameSpan, sizeSpan)
        btn.onclick = () => {
          openExternalUrl(asset.downloadUrl).catch(() => {})
        }
        return btn
      }),
    )
  }
  byId("update-dismiss-version").hidden = !result.hasUpdate
  updateDialog.showModal()
}

byId("update-open-release").onclick = () => {
  const url = activeUpdateResult?.release?.url || RELEASES_PAGE_URL
  openExternalUrl(url).catch(() => {})
}
byId("update-dismiss-version").onclick = () => {
  if (activeUpdateResult?.latestVersion) {
    dismissUpdateVersion(activeUpdateResult.latestVersion)
    status(`Đã bỏ qua nhắc cập nhật cho bản v${activeUpdateResult.latestVersion}.`)
  }
  updateDialog.close()
}
byId("update-close").onclick = () => updateDialog.close()

let checkingUpdate = false
async function runUpdateCheck({ force = false } = {}) {
  if (checkingUpdate) return
  checkingUpdate = true
  const checkBtn = byId("check-update")
  if (force && checkBtn) checkBtn.disabled = true
  if (force) status("Đang kiểm tra bản cập nhật mới…")
  try {
    const result = await checkAppUpdate({ force, currentVersion: APP_VERSION })
    if (result.skipped) return
    if (!result.ok) {
      if (force) {
        status(result.error || "Không thể kiểm tra cập nhật.", true)
        notify({
          kind: "warning",
          title: "Không kiểm tra được cập nhật",
          message: result.error || "Hãy kiểm tra kết nối mạng hoặc thử lại sau.",
          key: "app-update",
        })
      }
      return
    }
    if (result.hasUpdate && (!result.dismissed || force)) {
      if (force) status(`Có bản cập nhật mới v${result.latestVersion}.`)
      notify({
        kind: "update",
        title: `Có phiên bản mới v${result.latestVersion}`,
        message: `Bạn đang dùng v${result.currentVersion}. Bấm để xem ghi chú phát hành và tải về.`,
        key: "app-update",
        actions: [
          { label: "Xem bản phát hành", primary: true, onClick: () => showUpdateDialog(result) },
          {
            label: "Bỏ qua bản này",
            onClick: () => {
              dismissUpdateVersion(result.latestVersion)
              status(`Đã bỏ qua nhắc cập nhật v${result.latestVersion}.`)
            },
          },
        ],
      })
      if (force) showUpdateDialog(result)
    } else if (force) {
      status(`Khung Thoại v${result.currentVersion} là phiên bản mới nhất.`)
      notify({
        kind: "success",
        title: "Đã cập nhật mới nhất",
        message: `Khung Thoại v${result.currentVersion} hiện là phiên bản mới nhất.`,
        key: "app-update",
      })
    }
  } catch {
    // Keep silent on unexpected startup check errors.
  } finally {
    checkingUpdate = false
    if (force && checkBtn) checkBtn.disabled = false
  }
}

byId("check-update").onclick = () => runUpdateCheck({ force: true })
byId("notifications-check-update").onclick = () => {
  notifications.closePanel()
  runUpdateCheck({ force: true })
}

window.addEventListener("offline", () => {
  notify({
    kind: "warning",
    title: "Đã mất kết nối mạng",
    message: "OCR cục bộ, cọ Inpaint C# và Ollama cục bộ vẫn hoạt động bình thường; Gemini API và Web Search tạm ngưng.",
    key: "network-state",
  })
})
window.addEventListener("online", () => {
  notify({
    kind: "success",
    title: "Đã kết nối lại mạng",
    message: "Gemini API, Web Search và kiểm tra cập nhật đã sẵn sàng trở lại.",
    key: "network-state",
  })
})

const shared = {
  state, byId, status, checkpoint, renderPages, renderInspector, renderCanvas, render,
  selectedPage, selectedBox, projectBusy, notify, notifyOverflowIfAny,
}
const gestures = setupGestures({
  ...shared, stage, overlays, pageCanvas, viewport, editorSnapshot,
  commitLiveForm: commitLiveFormCheckpoint, selectBox, toggleSelectBox,
  addBox, freezeCleanup, rectStyle, paintPreview, renderCleanupOverlay, changePage,
})
const translation = setupTranslation({
  ...shared,
  pageForScript,
  applyTranslation,
  onSettingsChange: () => {
    syncTranslationActions()
    chat?.refreshModelBadge()
  },
})
const projects = setupProjects({
  ...shared, projectSettings, defaultProjectSettings, history, openImage,
  selectPage, selectedIndex, updateFitLabel, releaseUnusedImages,
  hasGesture: () => gestures.hasGesture(),
  onCapabilities: (ready, languages) => { nativeReady = ready; nativeLanguages = languages },
  commitLiveForm: commitLiveFormCheckpoint,
  registerFontName,
  renderFontOptions,
  onProjectSwitch: () => chat?.syncProjectSession(),
})
const dialogs = setupDialogs({
  ...shared, selectPage, selectBox, listButton, commitLiveForm: commitLiveFormCheckpoint,
})
setupTasks(byId)
setupOcr(shared)
setupExports({
  ...shared, selectPage, selectBox, listButton,
  readTranslationSettings: translation.settings,
  isNativeReady: () => projects.ready,
  commitLiveForm: commitLiveFormCheckpoint,
})
chat = setupChat({
  ...shared,
  selectedIndex,
  selectPage,
  commitLiveForm: commitLiveFormCheckpoint,
  readTranslationSettings: translation.settings,
  registerFontName,
  renderFontOptions,
  restoreHistory,
})

restoreCustomFonts().then((restored) => {
  if (!restored.length) return
  renderFontOptions()
  if (selectedPage()) render()
})

setTimeout(() => {
  runUpdateCheck({ force: false })
}, 4000)

render()
