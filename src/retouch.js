const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
const hexColor = /^#[\da-f]{6}$/i

export function validateRetouchStroke(stroke) {
  if (!stroke || (stroke.mode !== "paint" && stroke.mode !== "clone")) return null
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

export function paintRetouchStrokes(canvas, page) {
  const strokes = page.retouchStrokes
  if (!strokes?.length) return false
  const width = canvas.width
  const height = canvas.height
  const minDimension = Math.min(width, height)
  const context = canvas.getContext("2d")
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
    }
  }
  return painted
}
