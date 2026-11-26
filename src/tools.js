const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function resizeBox(start, handle, delta, { minW = .03, minH = .03 } = {}) {
  let left = start.x
  let top = start.y
  let right = start.x + start.w
  let bottom = start.y + start.h

  if (handle.includes("w")) left = clamp(left + delta.x, 0, right - minW)
  if (handle.includes("e")) right = clamp(right + delta.x, left + minW, 1)
  if (handle.includes("n")) top = clamp(top + delta.y, 0, bottom - minH)
  if (handle.includes("s")) bottom = clamp(bottom + delta.y, top + minH, 1)

  return { x: left, y: top, w: right - left, h: bottom - top }
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
  if (!pattern) return { replacedItems: 0, replacedOccurrences: 0 }
  let replacedItems = 0
  let replacedOccurrences = 0
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
      box.text = next
      replacedItems++
      replacedOccurrences += count
    }
    if (!options.includeUnplaced) continue
    for (const line of page.unplaced ?? []) {
      const { next, count } = apply(line.text)
      if (!count) continue
      line.text = next
      replacedItems++
      replacedOccurrences += count
    }
  }
  return { replacedItems, replacedOccurrences }
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
