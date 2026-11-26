import { clamp } from "../canvas.js"
import { detectBubbleOnImage } from "../bubble.js"
import { prepareNativeInpaint, samplePixelColor } from "../retouch.js"
import { resizeBox, rotateBox, snapBox } from "../tools.js"

const zoomSteps = [.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4]

export function setupGestures({
  state,
  byId,
  stage,
  overlays,
  pageCanvas,
  viewport,
  status,
  checkpoint,
  editorSnapshot,
  commitLiveForm,
  selectedPage,
  selectedBox,
  selectBox,
  toggleSelectBox,
  addBox,
  freezeCleanup,
  rectStyle,
  paintPreview,
  renderCleanupOverlay,
  renderCanvas,
  renderInspector,
  render,
  projectBusy,
  changePage,
}) {
  let gesture
  let pendingPaint
  let spaceHeld = false

  function point(event) {
    const area = pageCanvas.getBoundingClientRect()
    if (!area.width || !area.height) return { x: 0, y: 0 }
    return {
      x: clamp((event.clientX - area.left) / area.width, 0, 1),
      y: clamp((event.clientY - area.top) / area.height, 0, 1),
    }
  }

  function placement(a, b) {
    const w = Math.abs(a.x - b.x)
    const h = Math.abs(a.y - b.y)
    if (w < .015 && h < .015) return { x: clamp(a.x - .17, 0, .66), y: clamp(a.y - .08, 0, .84), w: .34, h: .16 }
    return { x: Math.min(a.x, b.x, .97), y: Math.min(a.y, b.y, .97), w: Math.max(.03, w), h: Math.max(.03, h) }
  }

  function clearGuides() {
    overlays.querySelectorAll(".snap-guide").forEach((el) => el.remove())
  }

  function renderGuides(guides) {
    clearGuides()
    for (const guide of guides) {
      const line = document.createElement("div")
      line.className = "snap-guide " + guide.axis
      if (guide.axis === "x") line.style.left = guide.pos * 100 + "%"
      else line.style.top = guide.pos * 100 + "%"
      overlays.append(line)
    }
  }

  function renderCloneMarker() {
    overlays.querySelector(".clone-marker")?.remove()
    if (byId("cleanup-tool").value !== "clone" || !state.cloneSource) return
    const marker = document.createElement("div")
    marker.className = "clone-marker"
    marker.style.left = state.cloneSource.x * 100 + "%"
    marker.style.top = state.cloneSource.y * 100 + "%"
    overlays.append(marker)
  }

  function updateZoomDisplay() {
    byId("zoom-level").textContent = state.zoom ? Math.round(state.zoom * 100) + "%" : (state.fit ? "Vừa trang" : "100%")
  }

  function currentScale() {
    const page = selectedPage()
    if (!page) return 1
    if (state.zoom) return state.zoom
    const rendered = pageCanvas.getBoundingClientRect().width
    return rendered > 0 ? rendered / page.image.naturalWidth : 1
  }

  function setZoom(nextZoom) {
    const page = selectedPage()
    if (!page) return
    state.zoom = clamp(Math.round(nextZoom * 100) / 100, .25, 4)
    state.fit = false
    byId("fit-page").textContent = "Kích thước gốc"
    updateZoomDisplay()
    renderCanvas()
  }

  byId("zoom-in").onclick = () => {
    const cur = currentScale()
    const next = zoomSteps.find((step) => step > cur + .02) ?? 4
    setZoom(next)
  }
  byId("zoom-out").onclick = () => {
    const cur = currentScale()
    const next = [...zoomSteps].reverse().find((step) => step < cur - .02) ?? .25
    setZoom(next)
  }
  viewport.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !selectedPage()) return
    event.preventDefault()
    const cur = currentScale()
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
    setZoom(cur * factor)
  }, { passive: false })

  function drawInpaintPreview(stroke) {
    const canvas = byId("cleanup-overlay")
    canvas.width = pageCanvas.width
    canvas.height = pageCanvas.height
    const ctx = canvas.getContext("2d")
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = "#0284c7"
    ctx.lineWidth = Math.max(1, stroke.size * Math.min(canvas.width, canvas.height))
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.beginPath()
    const first = stroke.points[0]
    ctx.moveTo(first.x * canvas.width, first.y * canvas.height)
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x * canvas.width, stroke.points[i].y * canvas.height)
    }
    if (stroke.points.length === 1) ctx.lineTo(first.x * canvas.width + .01, first.y * canvas.height)
    ctx.stroke()
  }

  function schedulePaint() {
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  }

  stage.addEventListener("pointerdown", (event) => {
    if (projectBusy()) return
    const page = selectedPage()
    if (!page) return
    const tool = byId("cleanup-tool").value

    // Pan with middle mouse button, Hand tool, or Space+Left click.
    if (event.button === 1 || (event.button === 0 && (tool === "pan" || spaceHeld))) {
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      stage.classList.add("dragging-pan")
      gesture = {
        kind: "pan",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      }
      return
    }
    if (event.button !== 0) return

    commitLiveForm()
    const origin = point(event)

    // Eyedropper tool.
    if (tool === "eyedropper") {
      event.preventDefault()
      const color = samplePixelColor(page.image, origin)
      if (!color) return
      byId("paint-color").value = color
      const readout = byId("eyedropper-readout")
      readout.textContent = color.toUpperCase()
      readout.hidden = false
      if (selectedBox() && event.shiftKey) {
        checkpoint()
        selectedBox().color = color
        byId("box-color").value = color
        renderCanvas()
        status(`Đã hút màu ${color.toUpperCase()} cho màu chữ.`)
      } else {
        status(`Đã hút màu ${color.toUpperCase()} cho cọ vẽ (giữ Shift+bấm để đổi màu chữ).`)
      }
      return
    }

    // Magic Bubble Click tool.
    if (tool === "bubble") {
      event.preventDefault()
      const rect = detectBubbleOnImage(page.image, origin.x, origin.y)
      if (!rect) {
        status("Không nhận diện được bong bóng thoại sáng tại vị trí vừa bấm.", true)
        return
      }
      addBox(rect)
      status("Đã tạo khung khớp bong bóng thoại.")
      return
    }

    // Paint, Clone Stamp, Smart Inpaint & Retouch Eraser tools.
    if (tool === "paint" || tool === "clone" || tool === "inpaint" || tool === "retouch-erase") {
      event.preventDefault()
      if (tool === "clone" && event.altKey) {
        state.cloneSource = origin
        renderCloneMarker()
        status("Đã đặt điểm nguồn sao chép nền. Giờ kéo cọ để che chữ.")
        return
      }
      if (tool === "clone" && !state.cloneSource) {
        status("Giữ Alt + bấm vào vùng nền mẫu trước khi dùng cọ sao chép.", true)
        return
      }
      stage.setPointerCapture(event.pointerId)
      const before = editorSnapshot()
      const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
      const opacity = clamp((Number(byId("paint-opacity").value) || 100) / 100, .05, 1)
      const minDim = Math.min(page.image.naturalWidth, page.image.naturalHeight)
      const stroke = tool === "paint"
        ? { mode: "paint", size: size / minDim, color: byId("paint-color").value, ...(opacity !== 1 && { opacity }), points: [origin] }
        : tool === "inpaint"
          ? { mode: "inpaint", size: size / minDim, ...(opacity !== 1 && { opacity }), points: [origin] }
          : tool === "retouch-erase"
            ? { mode: "erase", size: size / minDim, ...(opacity !== 1 && { opacity }), points: [origin] }
            : {
              mode: "clone", size: size / minDim,
              offsetX: clamp(state.cloneSource.x - origin.x, -1, 1),
              offsetY: clamp(state.cloneSource.y - origin.y, -1, 1),
              ...(opacity !== 1 && { opacity }),
              points: [origin],
            }
      if (tool === "inpaint") {
        // Draw fast overlay preview during drag, then commit inpaint reconstruction on pointerup.
        gesture = { kind: "inpaint-preview", pointer: event.pointerId, stroke, before }
        drawInpaintPreview(stroke)
      } else {
        page.retouchStrokes ??= []
        page.retouchStrokes.push(stroke)
        gesture = { kind: "retouch", pointer: event.pointerId, stroke, before }
        paintPreview(page)
      }
      return
    }

    // Rotate handle on active box.
    const rotateEl = event.target.closest?.(".rotate-handle")
    if (tool === "text" && !state.placing && rotateEl) {
      const box = selectedBox()
      if (!box) return
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      const before = editorSnapshot()
      const area = pageCanvas.getBoundingClientRect()
      const center = { x: (box.x + box.w / 2) * area.width, y: (box.y + box.h / 2) * area.height }
      gesture = { kind: "rotate", pointer: event.pointerId, box, center, startRotation: box.rotation, before }
      return
    }

    // Resize handle on active box.
    const handleEl = event.target.closest?.(".resize-handle")
    if (tool === "text" && !state.placing && handleEl) {
      const box = selectedBox()
      if (!box) return
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      const before = editorSnapshot()
      if (box.cleanup) freezeCleanup(box)
      gesture = {
        kind: "resize",
        pointer: event.pointerId,
        box,
        handle: handleEl.dataset.handle,
        origin,
        start: { x: box.x, y: box.y, w: box.w, h: box.h },
        before,
      }
      return
    }

    const clickedOutline = event.target.closest?.("[data-box]")
    const box = tool === "text"
      ? page.boxes.find((item) => item.id === clickedOutline?.dataset.box)
      : selectedBox()

    if (!box && !state.placing) {
      if (tool === "text" && (state.boxId || state.selectedBoxIds.size)) {
        state.boxId = null
        state.selectedBoxIds.clear()
        renderCanvas()
        renderInspector()
      }
      return
    }
    event.preventDefault()
    if (tool === "text" && box && !state.placing && event.shiftKey) {
      toggleSelectBox(box)
      return
    }
    stage.setPointerCapture(event.pointerId)
    const before = editorSnapshot()

    if (tool !== "text") {
      if (!box) return
      freezeCleanup(box)
      box.cleanup = true
      if (tool !== "region") {
        const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
        const stroke = { mode: tool, size: size / Math.min(pageCanvas.width, pageCanvas.height), points: [origin] }
        box.cleanupStrokes ??= []
        box.cleanupStrokes.push(stroke)
        gesture = { kind: "cleanup-stroke", pointer: event.pointerId, box, stroke, before }
        renderCleanupOverlay()
        return
      }
    } else if (box && !state.placing) {
      const keepGroup = state.selectedBoxIds.size > 1 && state.selectedBoxIds.has(box.id)
      if (!keepGroup) selectBox(box)
      const moveBoxes = keepGroup
        ? page.boxes.filter((item) => state.selectedBoxIds.has(item.id))
        : [box]
      for (const item of moveBoxes) {
        if (item.cleanup) freezeCleanup(item)
      }
      gesture = {
        kind: "move",
        pointer: event.pointerId,
        box,
        moveBoxes,
        collapseOnClick: keepGroup,
        origin,
        starts: new Map(moveBoxes.map((item) => [item.id, { x: item.x, y: item.y }])),
        moved: false,
        before,
      }
      return
    }

    const draft = document.createElement("div")
    draft.className = "outline draft"
    overlays.append(draft)
    gesture = { kind: "draft", pointer: event.pointerId, origin, draft, cleanupBox: tool === "region" ? box : null, before }
  })

  stage.addEventListener("pointermove", (event) => {
    if (gesture?.pointer !== event.pointerId) return
    if (gesture.kind === "pan") {
      viewport.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.startX)
      viewport.scrollTop = gesture.scrollTop - (event.clientY - gesture.startY)
      return
    }
    const cursor = point(event)
    if (gesture.kind === "inpaint-preview") {
      gesture.stroke.points.push(cursor)
      drawInpaintPreview(gesture.stroke)
      return
    }
    if (gesture.kind === "retouch") {
      gesture.stroke.points.push(cursor)
      schedulePaint()
      return
    }
    if (gesture.kind === "cleanup-stroke") {
      gesture.stroke.points.push(cursor)
      renderCleanupOverlay()
      return
    }
    if (gesture.kind === "rotate") {
      const area = pageCanvas.getBoundingClientRect()
      const pointerPx = { x: event.clientX - area.left, y: event.clientY - area.top }
      gesture.box.rotation = rotateBox(gesture.center, pointerPx, { snap: event.shiftKey })
      byId("box-rotation").value = gesture.box.rotation
      const outline = overlays.querySelector('[aria-current="true"]')
      if (outline) rectStyle(outline, gesture.box)
      schedulePaint()
      return
    }
    if (gesture.kind === "resize") {
      const aspect = pageCanvas.width / Math.max(1, pageCanvas.height)
      const next = resizeBox(
        gesture.start,
        gesture.handle,
        { x: cursor.x - gesture.origin.x, y: cursor.y - gesture.origin.y },
        { rotation: gesture.box.rotation ?? 0, aspect },
      )
      Object.assign(gesture.box, next)
      const outline = overlays.querySelector('[aria-current="true"]')
      if (outline) rectStyle(outline, gesture.box)
      schedulePaint()
      return
    }
    if (gesture.kind === "move") {
      const page = selectedPage()
      if (!page) return
      let dx = cursor.x - gesture.origin.x
      let dy = cursor.y - gesture.origin.y
      // Clamp dx/dy so all moving boxes stay within [0, 1].
      let minDx = -Infinity, maxDx = Infinity, minDy = -Infinity, maxDy = Infinity
      for (const item of gesture.moveBoxes) {
        const st = gesture.starts.get(item.id)
        minDx = Math.max(minDx, -st.x)
        maxDx = Math.min(maxDx, 1 - item.w - st.x)
        minDy = Math.max(minDy, -st.y)
        maxDy = Math.min(maxDy, 1 - item.h - st.y)
      }
      dx = clamp(dx, minDx, maxDx)
      dy = clamp(dy, minDy, maxDy)

      if (!event.altKey) {
        const movingIds = new Set(gesture.moveBoxes.map((item) => item.id))
        const others = page.boxes.filter((item) => !movingIds.has(item.id))
        const minX = Math.min(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).x))
        const maxX = Math.max(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).x + item.w))
        const minY = Math.min(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).y))
        const maxY = Math.max(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).y + item.h))
        const groupRect = { x: minX + dx, y: minY + dy, w: maxX - minX, h: maxY - minY }
        const snapped = snapBox(groupRect, others)
        dx = clamp(dx + (snapped.x - groupRect.x), minDx, maxDx)
        dy = clamp(dy + (snapped.y - groupRect.y), minDy, maxDy)
        renderGuides(snapped.guides)
      } else {
        clearGuides()
      }

      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) gesture.moved = true
      for (const item of gesture.moveBoxes) {
        const st = gesture.starts.get(item.id)
        item.x = clamp(st.x + dx, 0, Math.max(0, 1 - item.w))
        item.y = clamp(st.y + dy, 0, Math.max(0, 1 - item.h))
        const outline = overlays.querySelector(`[data-box="${item.id}"]`)
        if (outline) rectStyle(outline, item)
      }
      schedulePaint()
      return
    }
    if (gesture.kind === "draft") {
      rectStyle(gesture.draft, placement(gesture.origin, cursor))
    }
  })

  stage.addEventListener("pointerup", (event) => {
    if (gesture?.pointer !== event.pointerId) return
    const completed = gesture
    gesture = undefined
    clearGuides()
    if (completed.kind === "pan") {
      stage.classList.remove("dragging-pan")
      return
    }
    if (completed.kind === "inpaint-preview") {
      const page = selectedPage()
      if (page) {
        page.retouchStrokes ??= []
        page.retouchStrokes.push(completed.stroke)
        checkpoint(completed.before)
        prepareNativeInpaint(page, completed.stroke).then((usedNative) => {
          if (usedNative && selectedPage() === page) {
            paintPreview(page)
            status("Đã tái tạo nền sắc nét bằng C# PatchMatch Inpaint.")
          }
        })
      }
      render()
      status("Đã tẩy chữ và tái tạo nền bằng Inpaint.")
      return
    }
    if (completed.kind === "retouch") {
      checkpoint(completed.before)
      render()
      return
    }
    if (completed.kind === "rotate") {
      if (completed.box.rotation !== completed.startRotation) checkpoint(completed.before)
      render()
      return
    }
    if (completed.kind === "resize") {
      const b = completed.box
      const s = completed.start
      if (b.x !== s.x || b.y !== s.y || b.w !== s.w || b.h !== s.h) checkpoint(completed.before)
      render()
      return
    }
    if (completed.kind === "move") {
      if (completed.moved) checkpoint(completed.before)
      else if (completed.collapseOnClick) selectBox(completed.box)
      render()
      return
    }
    if (completed.kind === "cleanup-stroke") {
      checkpoint(completed.before)
      render()
      return
    }
    if (completed.kind === "draft") {
      checkpoint(completed.before)
      if (completed.cleanupBox) {
        completed.cleanupBox.cleanupRect = placement(completed.origin, point(event))
        completed.cleanupBox.cleanupStrokes = []
      } else {
        addBox(placement(completed.origin, point(event)), undefined, false)
      }
      render()
    }
  })

  stage.addEventListener("pointercancel", (event) => {
    if (gesture?.pointer !== event.pointerId) return
    const cancelled = gesture
    gesture = undefined
    clearGuides()
    if (cancelled.kind === "pan") {
      stage.classList.remove("dragging-pan")
      return
    }
    if (cancelled.before) {
      const { settings, ...editor } = cancelled.before
      Object.assign(state, editor)
    }
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
      renderCanvas()
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const rtl = byId("direction").value === "rtl"
      changePage((event.key === "ArrowLeft") === rtl ? 1 : -1)
      event.preventDefault()
    }
  })

  return {
    hasGesture: () => Boolean(gesture),
    cancelPendingPaint() {
      if (pendingPaint) {
        cancelAnimationFrame(pendingPaint)
        pendingPaint = undefined
      }
    },
    abortGesture() {
      if (!gesture) return null
      const before = gesture.before ?? null
      gesture = undefined
      clearGuides()
      stage.classList.remove("dragging-pan")
      return before
    },
    clearGuides,
    renderCloneMarker,
    updateZoomDisplay,
    getSpaceHeld: () => spaceHeld,
    setSpaceHeld(value) {
      spaceHeld = Boolean(value)
      stage.classList.toggle("panning", byId("cleanup-tool").value === "pan" || spaceHeld)
    },
  }
}
