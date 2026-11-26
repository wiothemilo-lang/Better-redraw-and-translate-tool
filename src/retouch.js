import { inpaintRegion } from "./inpaint.js"

const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
const hexColor = /^#[\da-f]{6}$/i

export function validateRetouchStroke(stroke) {
  if (!stroke || (stroke.mode !== "paint" && stroke.mode !== "clone" && stroke.mode !== "inpaint")) return null
  const opacity = stroke.opacity ?? 1
  if (!inRange(stroke.size, .00001, 200) || !inRange(opacity, .05, 1) ||
      !Array.isArray(stroke.points) || !stroke.points.length ||
      !stroke.points.every((point) => isFraction(point?.x) && isFraction(point.y))) {
    return null
  }
  const points = stroke.points.map(({ x, y }) => ({ x, y }))
  if (stroke.mode === "paint") {
    if (typeof stroke.color !== "string" || !hexColor.test(stroke.color)) return null
    return { mode: "paint", size: stroke.size, color: stroke.color, ...(opacity !== 1 && { opacity }), points }
  }
  if (stroke.mode === "inpaint") {
    return { mode: "inpaint", size: stroke.size, ...(opacity !== 1 && { opacity }), points }
  }
  if (!inRange(stroke.offsetX, -1, 1) || !inRange(stroke.offsetY, -1, 1)) return null
  return {
    mode: "clone", size: stroke.size, offsetX: stroke.offsetX, offsetY: stroke.offsetY,
    ...(opacity !== 1 && { opacity }), points,
  }
}

export function samplePixelColor(image, point) {
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) return null
  const x = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)))
  const y = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)))
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, -x, -y)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return "#" + [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")
}

function drawStrokePath(context, points, width, height, left = 0, top = 0) {
  context.beginPath()
  const firstX = points[0].x * width - left
  const firstY = points[0].y * height - top
  context.moveTo(firstX, firstY)
  for (let index = 1; index < points.length; index++) {
    context.lineTo(points[index].x * width - left, points[index].y * height - top)
  }
  if (points.length === 1) context.lineTo(firstX + .01, firstY)
  context.stroke()
}

const retouchCache = new WeakMap()

function retouchSignature(strokes, width, height) {
  let parts = `${width}x${height}:${strokes.length}`
  for (const s of strokes) {
    const pts = s.points ?? []
    const first = pts[0]
    const last = pts[pts.length - 1]
    parts += `|${s.mode},${s.size},${s.color ?? ""},${s.offsetX ?? ""},${s.offsetY ?? ""},${s.opacity ?? 1},${pts.length},${first?.x ?? ""},${first?.y ?? ""},${last?.x ?? ""},${last?.y ?? ""}`
  }
  return parts
}

function renderRetouchStrokes(context, page, width, height) {
  const strokes = page.retouchStrokes
  const minDimension = Math.min(width, height)
  let painted = false

  for (const stroke of strokes) {
    if (!stroke.points?.length) continue
    const lineWidth = Math.max(1, stroke.size * minDimension)
    const opacity = stroke.opacity ?? 1
    if (stroke.mode === "paint") {
      context.save()
      context.globalAlpha = opacity
      context.strokeStyle = stroke.color
      context.lineWidth = lineWidth
      context.lineCap = "round"
      context.lineJoin = "round"
      drawStrokePath(context, stroke.points, width, height)
      context.restore()
      painted = true
      continue
    }
    if (stroke.mode === "clone" && page.image) {
      const radius = Math.ceil(lineWidth / 2) + 2
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const point of stroke.points) {
        const px = point.x * width
        const py = point.y * height
        if (px < minX) minX = px
        if (py < minY) minY = py
        if (px > maxX) maxX = px
        if (py > maxY) maxY = py
      }
      const left = Math.max(0, Math.floor(minX - radius))
      const top = Math.max(0, Math.floor(minY - radius))
      const right = Math.min(width, Math.ceil(maxX + radius))
      const bottom = Math.min(height, Math.ceil(maxY + radius))
      if (right <= left || bottom <= top) continue

      const stamp = document.createElement("canvas")
      stamp.width = right - left
      stamp.height = bottom - top
      const stampContext = stamp.getContext("2d")
      stampContext.strokeStyle = "#fff"
      stampContext.lineWidth = lineWidth
      stampContext.lineCap = "round"
      stampContext.lineJoin = "round"
      drawStrokePath(stampContext, stroke.points, width, height, left, top)
      stampContext.globalCompositeOperation = "source-in"
      stampContext.drawImage(
        page.image,
        -(left + stroke.offsetX * width),
        -(top + stroke.offsetY * height),
      )
      context.save()
      context.globalAlpha = opacity
      context.drawImage(stamp, left, top)
      context.restore()
      painted = true
      continue
    }
    if (stroke.mode === "inpaint" && page.image) {
      const radius = Math.ceil(lineWidth / 2) + 2
      const margin = Math.max(18, Math.min(36, Math.ceil(lineWidth)))
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const point of stroke.points) {
        const px = point.x * width
        const py = point.y * height
        if (px < minX) minX = px
        if (py < minY) minY = py
        if (px > maxX) maxX = px
        if (py > maxY) maxY = py
      }
      const left = Math.max(0, Math.floor(minX - radius - margin))
      const top = Math.max(0, Math.floor(minY - radius - margin))
      const right = Math.min(width, Math.ceil(maxX + radius + margin))
      const bottom = Math.min(height, Math.ceil(maxY + radius + margin))
      const bw = right - left
      const bh = bottom - top
      if (bw <= 2 || bh <= 2) continue

      const maskCanvas = document.createElement("canvas")
      maskCanvas.width = bw
      maskCanvas.height = bh
      const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true })
      maskCtx.strokeStyle = "#fff"
      maskCtx.lineWidth = lineWidth
      maskCtx.lineCap = "round"
      maskCtx.lineJoin = "round"
      drawStrokePath(maskCtx, stroke.points, width, height, left, top)
      const maskRgba = maskCtx.getImageData(0, 0, bw, bh).data
      const mask = new Uint8Array(bw * bh)
      for (let i = 0; i < mask.length; i++) {
        if (maskRgba[i * 4 + 3] >= 32) mask[i] = 1
      }

      const patchCanvas = document.createElement("canvas")
      patchCanvas.width = bw
      patchCanvas.height = bh
      const patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true })
      patchCtx.drawImage(page.image, -left, -top)
      if (context.canvas) patchCtx.drawImage(context.canvas, -left, -top)
      const imageData = patchCtx.getImageData(0, 0, bw, bh)
      if (!inpaintRegion(imageData.data, bw, bh, mask)) continue
      for (let i = 0; i < mask.length; i++) {
        imageData.data[i * 4 + 3] = mask[i] ? maskRgba[i * 4 + 3] : 0
      }
      patchCtx.putImageData(imageData, 0, 0)
      context.save()
      context.globalAlpha = opacity
      context.drawImage(patchCanvas, left, top)
      context.restore()
      painted = true
    }
  }
  return painted
}

export function paintRetouchStrokes(canvas, page) {
  const strokes = page.retouchStrokes
  if (!strokes?.length) return false
  const width = canvas.width
  const height = canvas.height
  if (typeof document !== "undefined" && page.image && typeof page.image === "object") {
    const signature = retouchSignature(strokes, width, height)
    let entry = retouchCache.get(page.image)
    if (!entry || entry.signature !== signature) {
      const layer = document.createElement("canvas")
      layer.width = width
      layer.height = height
      const painted = renderRetouchStrokes(layer.getContext("2d"), page, width, height)
      entry = { signature, layer, painted }
      retouchCache.set(page.image, entry)
    }
    if (entry.painted) canvas.getContext("2d").drawImage(entry.layer, 0, 0)
    return entry.painted
  }
  return renderRetouchStrokes(canvas.getContext("2d"), page, width, height)
}
