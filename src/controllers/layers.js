import {
  addLayer, duplicateLayer, ensurePageLayers, layerLimit, layerNameLimit, moveLayer, pageLayers,
  removeLayer, removeStroke, renameLayer, retargetStroke, setLayerHidden, setLayerOpacity,
  setStrokeHidden, strokeLabel, strokeLayer, strokeTarget,
} from "../layers.js"

// The copy and close actions are drawn instead of written: no installed UI font has a glyph for
// either, so Chromium picked a fallback per distribution and the same button rendered as a thin
// box on one host and a filled double square on another. A vector keeps the row identical
// everywhere, which is also what the visual baselines compare.
function layerActionIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 12 12")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("focusable", "false")
  svg.setAttribute("class", "layer-action-icon")
  const paint = { fill: "none", stroke: "currentColor", "stroke-width": "1.1", "stroke-linecap": "round" }
  const shapes = kind === "copy"
    ? [["rect", { x: 1.5, y: 1.5, width: 6.4, height: 6.4 }], ["rect", { x: 4.1, y: 4.1, width: 6.4, height: 6.4 }]]
    : [["path", { d: "M2.6 2.6 9.4 9.4" }], ["path", { d: "M9.4 2.6 2.6 9.4" }]]
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag)
    for (const [name, value] of Object.entries({ ...paint, ...attributes })) shape.setAttribute(name, String(value))
    svg.append(shape)
  }
  return svg
}

// The layer stack and the strokes inside it are edited here. Each change is recorded as a named
// action — with the snapshot taken before the change — so the timeline can step back through a
// rename, a reorder or one deleted stroke.
export function setupLayers({
  state, byId, status, checkpoint, editorSnapshot, render, selectedPage, projectBusy, commitLiveForm, restoreOriginal,
}) {
  const panel = byId("layers-panel")
  const layerList = byId("layer-list")
  const strokeList = byId("stroke-list")
  const addButton = byId("add-layer")
  const restoreButton = byId("restore-original")
  let signature = ""

  const retouchLayers = (page) => pageLayers(page).filter((layer) => layer.kind === "retouch")

  function edit(label, mutate, message) {
    const page = selectedPage()
    if (!page || projectBusy()) return false
    commitLiveForm?.()
    const before = editorSnapshot()
    // The rows hold the page's own layer objects, so the stack has to exist on the page before a
    // name, opacity or visibility change can be saved with it.
    ensurePageLayers(page)
    if (!mutate(page)) return false
    checkpoint(before, { label: label, kind: "layer" })
    render()
    if (message) status(message)
    return true
  }

  function selectLayer(page, id) {
    if (state.layerId === id) return
    state.layerId = id
    const name = pageLayers(page).find((layer) => layer.id === id)?.name ?? ""
    for (const row of layerList.children) {
      if (row.dataset.layer === id) row.setAttribute("aria-current", "true")
      else row.removeAttribute("aria-current")
    }
    status(`Lớp "${name}" nhận nét cọ mới.`)
  }

  function actionButton(content, label, key, onClick) {
    const button = document.createElement("button")
    button.type = "button"
    if (typeof content === "string") button.textContent = content
    else button.append(content)
    button.setAttribute("aria-label", label)
    button.title = label
    button.dataset.focusKey = key
    button.onclick = onClick
    button.disabled = projectBusy()
    return button
  }

  function layerRow(page, layer, index, total) {
    const li = document.createElement("li")
    li.className = "layer-row"
    li.dataset.layer = layer.id
    li.dataset.kind = layer.kind
    // New strokes go to the layer the user picked, so the marker has to follow that pick rather
    // than falling back to the first retouch layer on every re-render.
    const active = strokeTarget(page, state.layerId)?.id === layer.id
    if (active) li.setAttribute("aria-current", "true")

    const eye = document.createElement("input")
    eye.type = "checkbox"
    eye.className = "layer-visible"
    eye.checked = layer.visible !== false
    eye.disabled = projectBusy()
    eye.dataset.focusKey = "layer-visible:" + layer.id
    eye.setAttribute("aria-label", `Hiện lớp ${layer.name}`)
    eye.onchange = () => edit(
      `${eye.checked ? "Hiện" : "Ẩn"} lớp "${layer.name}"`,
      () => setLayerHidden(layer, !eye.checked),
      `Đã ${eye.checked ? "hiện" : "ẩn"} lớp "${layer.name}".`,
    )

    const name = document.createElement("input")
    name.type = "text"
    name.className = "layer-name"
    name.value = layer.name
    name.maxLength = layerNameLimit
    name.disabled = projectBusy()
    name.dataset.focusKey = "layer-name:" + layer.id
    name.setAttribute("aria-label", `Tên lớp ${layer.name}`)
    name.onchange = () => {
      const previous = layer.name
      if (edit(`Đổi tên lớp "${previous}"`, () => renameLayer(layer, name.value))) {
        status(`Đã đổi tên lớp thành "${layer.name}".`)
      } else {
        name.value = previous
      }
    }

    const opacity = document.createElement("input")
    opacity.type = "range"
    opacity.className = "layer-opacity"
    opacity.min = "0"
    opacity.max = "100"
    opacity.step = "5"
    opacity.value = String(Math.round((layer.opacity ?? 1) * 100))
    opacity.disabled = projectBusy()
    opacity.dataset.focusKey = "layer-opacity:" + layer.id
    opacity.setAttribute("aria-label", `Độ đục lớp ${layer.name} (%)`)
    opacity.title = "Độ đục của lớp (%)"
    opacity.onchange = () => edit(
      `Đổi độ đục lớp "${layer.name}"`,
      () => setLayerOpacity(layer, Number(opacity.value) / 100),
      `Độ đục lớp "${layer.name}": ${opacity.value}%.`,
    )

    const up = actionButton("↑", `Đưa lớp ${layer.name} lên`, "layer-up:" + layer.id,
      () => edit(`Đưa lớp "${layer.name}" lên`, () => moveLayer(page, layer.id, 1), `Đã đưa lớp "${layer.name}" lên trên.`))
    up.disabled = projectBusy() || index >= total - 1
    const down = actionButton("↓", `Đưa lớp ${layer.name} xuống`, "layer-down:" + layer.id,
      () => edit(`Đưa lớp "${layer.name}" xuống`, () => moveLayer(page, layer.id, -1), `Đã đưa lớp "${layer.name}" xuống dưới.`))
    down.disabled = projectBusy() || index <= 0
    const copy = actionButton(layerActionIcon("copy"), `Nhân bản lớp ${layer.name}`, "layer-copy:" + layer.id,
      () => edit(`Nhân bản lớp "${layer.name}"`, () => Boolean(duplicateLayer(page, layer.id)), `Đã nhân bản lớp "${layer.name}".`))
    const remove = actionButton(layerActionIcon("remove"), `Xoá lớp ${layer.name}`, "layer-remove:" + layer.id, () => {
      if (pageLayers(page).length <= 1) return status("Một trang luôn cần ít nhất một lớp.", true)
      edit(`Xoá lớp "${layer.name}"`, () => removeLayer(page, layer.id), `Đã xoá lớp "${layer.name}".`)
    })

    li.append(eye, name, opacity, up, down, copy, remove)
    if (layer.kind === "retouch") {
      li.title = "Bấm vào lớp để nét cọ mới vẽ vào đây"
      li.onclick = (event) => {
        if (event.target.closest("input, button")) return
        selectLayer(page, layer.id)
      }
    }
    return li
  }

  function strokeRow(page, stroke, index, minDimension) {
    const li = document.createElement("li")
    li.className = "stroke-row"
    const owner = strokeLayer(page, stroke)
    const selected = state.stroke === stroke
    if (selected) li.setAttribute("aria-current", "true")
    if (stroke.hidden === true) li.dataset.hidden = "true"
    const badge = retouchLayers(page).length > 1 && owner ? ` · ${owner.name}` : ""

    const pick = document.createElement("button")
    pick.type = "button"
    pick.className = "stroke-pick"
    pick.textContent = strokeLabel(stroke, index, (stroke.size ?? 0) * minDimension) + badge
    pick.setAttribute("aria-label", `Chọn nét ${index + 1}`)
    pick.dataset.focusKey = "stroke-pick:" + index
    pick.onclick = () => {
      state.stroke = selected ? null : stroke
      render()
    }

    const eye = actionButton(stroke.hidden === true ? "Hiện" : "Ẩn", `${stroke.hidden === true ? "Hiện" : "Ẩn"} nét ${index + 1}`, "stroke-visible:" + index,
      () => edit(
        `${stroke.hidden === true ? "Hiện" : "Ẩn"} nét cọ #${index + 1}`,
        () => setStrokeHidden(stroke, stroke.hidden !== true),
        `Đã ${stroke.hidden === true ? "hiện" : "ẩn"} nét cọ #${index + 1}.`,
      ))
    const remove = actionButton("×", `Xoá nét ${index + 1}`, "stroke-remove:" + index,
      () => edit(`Xoá nét cọ #${index + 1}`, () => removeStroke(page, stroke), `Đã xoá nét cọ #${index + 1}.`))

    li.append(pick, eye, remove)
    if (selected) {
      const select = document.createElement("select")
      select.className = "stroke-layer"
      select.disabled = projectBusy() || retouchLayers(page).length < 2
      select.dataset.focusKey = "stroke-layer:" + index
      select.setAttribute("aria-label", `Lớp của nét ${index + 1}`)
      select.replaceChildren(...retouchLayers(page).map((layer) => {
        const option = document.createElement("option")
        option.value = layer.id
        option.textContent = layer.name
        option.selected = layer.id === owner?.id
        return option
      }))
      select.onchange = () => {
        const target = retouchLayers(page).find((layer) => layer.id === select.value)
        edit(
          `Chuyển nét cọ #${index + 1} sang lớp "${target?.name ?? ""}"`,
          () => retargetStroke(page, stroke, select.value),
          `Đã chuyển nét cọ #${index + 1} sang lớp "${target?.name ?? ""}".`,
        )
      }
      li.append(select)
    }
    return li
  }

  function strokeRows(page) {
    const strokes = page.retouchStrokes ?? []
    if (!strokes.length) {
      const li = document.createElement("li")
      li.className = "muted"
      li.textContent = "Chưa có nét cọ nào trên trang."
      return [li]
    }
    const minDimension = Math.min(page.image?.naturalWidth ?? 0, page.image?.naturalHeight ?? 0)
    return strokes.map((stroke, index) => strokeRow(page, stroke, index, minDimension))
  }

  function signatureOf(page) {
    return JSON.stringify([
      page.id,
      pageLayers(page).map((layer) => [layer.id, layer.name, layer.visible !== false, Math.round((layer.opacity ?? 1) * 100)]),
      (page.retouchStrokes ?? []).map((stroke) => [stroke.layerId ?? "", stroke.hidden === true, stroke.mode, stroke.points?.length ?? 0]),
      (page.retouchStrokes ?? []).indexOf(state.stroke),
      // The current-layer marker is part of what the list shows, so a pick has to rebuild the rows.
      strokeTarget(page, state.layerId)?.id ?? "",
      Boolean(page.originalFile),
      projectBusy(),
    ])
  }

  function sync() {
    const page = selectedPage()
    if (!page) {
      panel.hidden = true
      layerList.replaceChildren()
      strokeList.replaceChildren()
      signature = ""
      return
    }
    panel.hidden = false
    if (state.stroke && !(page.retouchStrokes ?? []).includes(state.stroke)) state.stroke = null
    const layers = ensurePageLayers(page)
    if (!layers.some((layer) => layer.id === state.layerId)) state.layerId = strokeTarget(page)?.id ?? null
    const next = signatureOf(page)
    addButton.disabled = projectBusy() || layers.length >= layerLimit
    restoreButton.hidden = !page.originalFile
    restoreButton.disabled = projectBusy()
    if (next === signature) return
    signature = next
    layerList.replaceChildren(...layers.map((layer, index) => layerRow(page, layer, index, layers.length)))
    strokeList.replaceChildren(...strokeRows(page))
    addButton.disabled = projectBusy() || layers.length >= layerLimit
    restoreButton.hidden = !page.originalFile
    restoreButton.disabled = projectBusy()
  }

  addButton.onclick = () => {
    const page = selectedPage()
    if (!page) return
    if (pageLayers(page).length >= layerLimit) return status(`Mỗi trang tối đa ${layerLimit} lớp.`, true)
    let created = null
    const added = edit("Thêm lớp cọ", () => {
      created = addLayer(page, "retouch")
      if (created) state.layerId = created.id
      return Boolean(created)
    })
    if (added) status(`Đã thêm lớp cọ "${created.name}". Nét cọ mới sẽ vẽ vào lớp này.`)
  }
  restoreButton.onclick = () => restoreOriginal?.()

  return { sync }
}
