const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function resizeBox(start, handle, delta, { rotation = 0, aspect = 1, minW = .03, minH = .03 } = {}) {
  if (!rotation) {
    let left = start.x
    let top = start.y
    let right = start.x + start.w
    let bottom = start.y + start.h

    if (handle.includes("w")) left = clamp(left + delta.x, 0, right - minW)
    if (handle.includes("e")) right = clamp(right + delta.x, left + minW, 1)
    if (handle.includes("n")) top = clamp(top + delta.y, 0, bottom - minH)
    if (handle.includes("s")) bottom = clamp(bottom + delta.y, top + minH, 1)

    const w = Math.min(right - left, 1 - left)
    const h = Math.min(bottom - top, 1 - top)
    return { x: left, y: top, w, h }
  }

  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const rad = rotation * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = (start.x + start.w / 2) * ratio
  const cy = start.y + start.h / 2
  const hw = start.w * ratio / 2
  const hh = start.h / 2
  const dx = delta.x * ratio
  const dy = delta.y
  const dLocalX = dx * cos + dy * sin
  const dLocalY = -dx * sin + dy * cos

  let leftLocal = -hw + (handle.includes("w") ? dLocalX : 0)
  let rightLocal = hw + (handle.includes("e") ? dLocalX : 0)
  let topLocal = -hh + (handle.includes("n") ? dLocalY : 0)
  let bottomLocal = hh + (handle.includes("s") ? dLocalY : 0)

  const minLocalW = minW * ratio
  if (handle.includes("w")) leftLocal = Math.min(leftLocal, rightLocal - minLocalW)
  if (handle.includes("e")) rightLocal = Math.max(rightLocal, leftLocal + minLocalW)
  if (handle.includes("n")) topLocal = Math.min(topLocal, bottomLocal - minH)
  if (handle.includes("s")) bottomLocal = Math.max(bottomLocal, topLocal + minH)

  const newW = clamp((rightLocal - leftLocal) / ratio, minW, 1)
  const newH = clamp(bottomLocal - topLocal, minH, 1)
  const shiftX = (leftLocal + rightLocal) / 2
  const shiftY = (topLocal + bottomLocal) / 2
  const newCx = cx + shiftX * cos - shiftY * sin
  const newCy = cy + shiftX * sin + shiftY * cos
  return {
    x: clamp(newCx / ratio - newW / 2, 0, Math.max(0, 1 - newW)),
    y: clamp(newCy - newH / 2, 0, Math.max(0, 1 - newH)),
    w: newW,
    h: newH,
  }
}

export function snapBox(rect, others, { thresholdX = .008, thresholdY = .008 } = {}) {
  const xTargets = [.5]
  const yTargets = [.5]
  for (const other of others) {
    xTargets.push(other.x, other.x + other.w / 2, other.x + other.w)
    yTargets.push(other.y, other.y + other.h / 2, other.y + other.h)
  }

  let bestX = rect.x
  let bestDx = thresholdX + 1e-9
  let guideX = null
  const xOffsets = [0, rect.w / 2, rect.w]
  for (const offset of xOffsets) {
    const edge = rect.x + offset
    for (const target of xTargets) {
      const dist = Math.abs(edge - target)
      if (dist < bestDx) {
        bestDx = dist
        bestX = clamp(target - offset, 0, Math.max(0, 1 - rect.w))
        guideX = target
      }
    }
  }

  let bestY = rect.y
  let bestDy = thresholdY + 1e-9
  let guideY = null
  const yOffsets = [0, rect.h / 2, rect.h]
  for (const offset of yOffsets) {
    const edge = rect.y + offset
    for (const target of yTargets) {
      const dist = Math.abs(edge - target)
      if (dist < bestDy) {
        bestDy = dist
        bestY = clamp(target - offset, 0, Math.max(0, 1 - rect.h))
        guideY = target
      }
    }
  }

  const guides = []
  if (guideX !== null) guides.push({ axis: "x", pos: guideX })
  if (guideY !== null) guides.push({ axis: "y", pos: guideY })
  return { x: bestX, y: bestY, guides }
}

export function alignBoxes(boxes, ids, alignment) {
  const idSet = new Set(ids)
  const targets = boxes.filter((box) => idSet.has(box.id))
  if (targets.length < 2) return false
  const minX = Math.min(...targets.map((box) => box.x))
  const maxX = Math.max(...targets.map((box) => box.x + box.w))
  const minY = Math.min(...targets.map((box) => box.y))
  const maxY = Math.max(...targets.map((box) => box.y + box.h))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  let changed = false
  for (const box of targets) {
    const prevX = box.x
    const prevY = box.y
    if (alignment === "left") box.x = clamp(minX, 0, Math.max(0, 1 - box.w))
    else if (alignment === "centerX") box.x = clamp(centerX - box.w / 2, 0, Math.max(0, 1 - box.w))
    else if (alignment === "right") box.x = clamp(maxX - box.w, 0, Math.max(0, 1 - box.w))
    else if (alignment === "top") box.y = clamp(minY, 0, Math.max(0, 1 - box.h))
    else if (alignment === "centerY") box.y = clamp(centerY - box.h / 2, 0, Math.max(0, 1 - box.h))
    else if (alignment === "bottom") box.y = clamp(maxY - box.h, 0, Math.max(0, 1 - box.h))
    if (Math.abs(box.x - prevX) > 1e-9 || Math.abs(box.y - prevY) > 1e-9) changed = true
  }
  return changed
}

export function distributeBoxes(boxes, ids, axis) {
  const idSet = new Set(ids)
  const targets = boxes.filter((box) => idSet.has(box.id))
  if (targets.length < 3) return false
  const horizontal = axis === "horizontal"
  const sorted = [...targets].sort((a, b) =>
    horizontal ? (a.x + a.w / 2) - (b.x + b.w / 2) : (a.y + a.h / 2) - (b.y + b.h / 2),
  )
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = horizontal ? (last.x + last.w) - first.x : (last.y + last.h) - first.y
  const totalSize = sorted.reduce((sum, box) => sum + (horizontal ? box.w : box.h), 0)
  let changed = false
  if (span > totalSize) {
    const gap = (span - totalSize) / (sorted.length - 1)
    let cursor = horizontal ? first.x + first.w + gap : first.y + first.h + gap
    for (let i = 1; i < sorted.length - 1; i++) {
      const box = sorted[i]
      if (horizontal) {
        const nextX = clamp(cursor, 0, Math.max(0, 1 - box.w))
        if (Math.abs(nextX - box.x) > 1e-9) { box.x = nextX; changed = true }
        cursor += box.w + gap
      } else {
        const nextY = clamp(cursor, 0, Math.max(0, 1 - box.h))
        if (Math.abs(nextY - box.y) > 1e-9) { box.y = nextY; changed = true }
        cursor += box.h + gap
      }
    }
  } else {
    const startCenter = horizontal ? first.x + first.w / 2 : first.y + first.h / 2
    const endCenter = horizontal ? last.x + last.w / 2 : last.y + last.h / 2
    const step = (endCenter - startCenter) / (sorted.length - 1)
    for (let i = 1; i < sorted.length - 1; i++) {
      const box = sorted[i]
      const targetCenter = startCenter + step * i
      if (horizontal) {
        const nextX = clamp(targetCenter - box.w / 2, 0, Math.max(0, 1 - box.w))
        if (Math.abs(nextX - box.x) > 1e-9) { box.x = nextX; changed = true }
      } else {
        const nextY = clamp(targetCenter - box.h / 2, 0, Math.max(0, 1 - box.h))
        if (Math.abs(nextY - box.y) > 1e-9) { box.y = nextY; changed = true }
      }
    }
  }
  return changed
}

export function rotateBox(center, pointer, { snap = false } = {}) {
  const radians = Math.atan2(pointer.x - center.x, -(pointer.y - center.y))
  let degrees = radians * 180 / Math.PI
  if (snap) degrees = Math.round(degrees / 15) * 15
  degrees = Math.round(degrees)
  if (degrees > 180) degrees -= 360
  if (degrees < -180) degrees += 360
  return degrees === 0 ? 0 : degrees
}

export function nudgeBox(box, dx, dy) {
  return {
    x: clamp(box.x + dx, 0, Math.max(0, 1 - box.w)),
    y: clamp(box.y + dy, 0, Math.max(0, 1 - box.h)),
  }
}

export function duplicateBox(box, id = crypto.randomUUID()) {
  const copy = structuredClone(box)
  delete copy.originalBox
  delete copy.cleanupRect
  delete copy.cleanupStrokes
  delete copy.cleanupExpand
  copy.id = id
  copy.cleanup = false
  copy.x = clamp(box.x + .02, 0, Math.max(0, 1 - box.w))
  copy.y = clamp(box.y + .02, 0, Math.max(0, 1 - box.h))
  return copy
}

export function reorderBox(boxes, boxId, delta) {
  const index = boxes.findIndex((box) => box.id === boxId)
  const target = index + delta
  if (index < 0 || target < 0 || target >= boxes.length) return { boxes, moved: false }
  const next = [...boxes]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return { boxes: next, moved: true }
}

export function fitBoxFontSize(page, box, measureOverflow, { min = 8, max = 400 } = {}) {
  let low = min
  let high = max
  let best = min
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (!measureOverflow(page, { ...box, size: mid })) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function searchPattern(query, { caseSensitive = false, wholeWord = false } = {}) {
  if (!query) return null
  const escaped = escapeRegExp(query)
  const source = wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped
  return new RegExp(source, caseSensitive ? "gu" : "giu")
}

export function findMatches(pages, query, options = {}) {
  const pattern = searchPattern(query, options)
  if (!pattern) return []
  const matches = []
  for (const [pageIndex, page] of pages.entries()) {
    for (const box of page.boxes) {
      const hits = box.text.match(pattern)
      if (!hits?.length) continue
      matches.push({
        pageIndex, pageId: page.id, pageName: page.name,
        boxId: box.id, isUnplaced: false, text: box.text, count: hits.length,
      })
    }
    if (!options.includeUnplaced) continue
    for (const [unplacedIndex, line] of (page.unplaced ?? []).entries()) {
      const hits = line.text.match(pattern)
      if (!hits?.length) continue
      matches.push({
        pageIndex, pageId: page.id, pageName: page.name,
        unplacedIndex, isUnplaced: true, text: line.text, count: hits.length,
      })
    }
  }
  return matches
}

export function replaceMatches(pages, query, replacement, options = {}) {
  const pattern = searchPattern(query, options)
  if (!pattern) return { replacedItems: 0, replacedOccurrences: 0, skippedEmpty: 0 }
  let replacedItems = 0
  let replacedOccurrences = 0
  let skippedEmpty = 0
  const apply = (text) => {
    let count = 0
    const next = text.replace(pattern, () => {
      count++
      return replacement
    })
    return { next, count }
  }
  for (const page of pages) {
    for (const box of page.boxes) {
      const { next, count } = apply(box.text)
      if (!count) continue
      if (!next.trim()) {
        skippedEmpty++
        continue
      }
      box.text = next
      replacedItems++
      replacedOccurrences += count
    }
    if (!options.includeUnplaced) continue
    for (const line of page.unplaced ?? []) {
      const { next, count } = apply(line.text)
      if (!count) continue
      if (!next.trim()) {
        skippedEmpty++
        continue
      }
      line.text = next
      replacedItems++
      replacedOccurrences += count
    }
  }
  return { replacedItems, replacedOccurrences, skippedEmpty }
}

function csvCell(value) {
  const text = String(value ?? "")
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
}

export function exportDialogueScript(pages, format = "txt") {
  if (format === "json") {
    return JSON.stringify({
      pages: pages.map((page, index) => ({
        page: index + 1,
        name: page.name,
        boxes: page.boxes.map((box) => ({
          text: box.text, x: box.x, y: box.y, w: box.w, h: box.h,
          font: box.font, size: box.size, color: box.color, align: box.align, rotation: box.rotation,
        })),
        unplaced: (page.unplaced ?? []).map((line) => line.text),
      })),
    }, null, 2)
  }
  if (format === "csv") {
    const rows = [["Page", "File", "Box", "Text"]]
    pages.forEach((page, pageIndex) => {
      page.boxes.forEach((box, boxIndex) => {
        rows.push([pageIndex + 1, page.name, boxIndex + 1, box.text])
      })
    })
    return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
  }
  return pages.map((page, index) => {
    if (!page.boxes.length) return ""
    const lines = page.boxes.map((box) => box.text.replace(/\r?\n/g, " ").trim()).filter(Boolean)
    return lines.length ? `Trang ${index + 1}\n${lines.join("\n")}` : ""
  }).filter(Boolean).join("\n\n")
}
