import { inpaintRegion } from "./inpaint.js"
import { isLayerId, strokeVisible } from "./layers.js"
import { desktop } from "./native.js"

const nativeInpaintCache = new WeakMap()
const strokeOrigins = new WeakMap()

export function shareInpaintOrigins(source, copy) {
  source?.forEach((stroke, index) => {
    if (stroke.mode === "inpaint" || (stroke.mode === "clone" && stroke.seamless)) {
      strokeOrigins.set(copy[index], strokeOrigins.get(stroke) ?? stroke)
    }
  })
}

function inpaintEntry(page, stroke) {
  const entry = nativeInpaintCache.get(strokeOrigins.get(stroke) ?? stroke)
  return entry && entry.image === page.image && entry.geometry === inpaintGeometry(stroke) ? entry : null
}

function inpaintGeometry(stroke) {
  return JSON.stringify([stroke.mode, stroke.size, stroke.points, stroke.offsetX ?? null, stroke.offsetY ?? null, Boolean(stroke.seamless)])
}

export function waitForNativeRetouch(page) {
  return Promise.all((page.retouchStrokes ?? []).flatMap((stroke) => {
    const pending = inpaintEntry(page, stroke)?.pending
    return pending ? [pending] : []
  }))
}

const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
const hexColor = /^#[\da-f]{6}$/i

export function validateRetouchStroke(stroke) {
  if (!stroke || !["paint", "clone", "inpaint", "erase"].includes(stroke.mode)) return null
  const opacity = stroke.opacity ?? 1
  if (!inRange(stroke.size, .00001, 200) || !inRange(opacity, .05, 1) ||
      !Array.isArray(stroke.points) || !stroke.points.length ||
      !stroke.points.every((point) => isFraction(point?.x) && isFraction(point.y))) {
    return null
  }
  if (stroke.hidden !== undefined && typeof stroke.hidden !== "boolean") return null
  if (stroke.layerId !== undefined && !isLayerId(stroke.layerId)) return null
  // The layer the stroke paints into and the per-stroke visibility travel with the stroke, so a
  // single stroke can be hidden, deleted or moved while the rest of the page keeps its layers.
  const marks = { ...(stroke.hidden && { hidden: true }), ...(stroke.layerId && { layerId: stroke.layerId }) }
  const points = stroke.points.map(({ x, y }) => ({ x, y }))
  if (stroke.mode === "paint") {
    if (typeof stroke.color !== "string" || !hexColor.test(stroke.color)) return null
    return { mode: "paint", size: stroke.size, color: stroke.color, ...(opacity !== 1 && { opacity }), ...marks, points }
  }
  if (stroke.mode === "inpaint" || stroke.mode === "erase") {
    return { mode: stroke.mode, size: stroke.size, ...(opacity !== 1 && { opacity }), ...marks, points }
  }
  if (!inRange(stroke.offsetX, -1, 1) || !inRange(stroke.offsetY, -1, 1)) return null
  if (stroke.seamless !== undefined && typeof stroke.seamless !== "boolean") return null
  return {
    mode: "clone", size: stroke.size, offsetX: stroke.offsetX, offsetY: stroke.offsetY,
    ...(stroke.seamless && { seamless: true }),
    ...(opacity !== 1 && { opacity }), ...marks, points,
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

function retouchSignature(strokes, width, height, opacity = 1) {
  return JSON.stringify([width, height, opacity, strokes])
}

function renderRetouchStrokes(context, page, width, height) {
  const strokes = page.retouchStrokes
  const minDimension = Math.min(width, height)
  let painted = false

  for (const stroke of strokes) {
    if (!stroke.points?.length) continue
    const lineWidth = Math.max(1, stroke.size * minDimension)
    const opacity = stroke.opacity ?? 1
    if (stroke.mode === "erase") {
      context.save()
      context.globalCompositeOperation = "destination-out"
      context.globalAlpha = opacity
      context.strokeStyle = "#000"
      context.lineWidth = lineWidth
      context.lineCap = "round"
      context.lineJoin = "round"
      drawStrokePath(context, stroke.points, width, height)
      context.restore()
      continue
    }
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
      if (stroke.seamless) {
        const nativePatch = inpaintEntry(page, stroke)?.patch
        if (nativePatch && nativePatch.width === width && nativePatch.height === height) {
          context.save()
          context.globalAlpha = opacity
          context.drawImage(nativePatch.canvas, nativePatch.left, nativePatch.top)
          context.restore()
          painted = true
          continue
        }
      }
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
      const nativePatch = inpaintEntry(page, stroke)?.patch
      if (nativePatch && nativePatch.width === width && nativePatch.height === height) {
        context.save()
        context.globalAlpha = opacity
        context.drawImage(nativePatch.canvas, nativePatch.left, nativePatch.top)
        context.restore()
        painted = true
        continue
      }
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
        // Any coverage counts. An antialiased edge pixel left outside the mask keeps the old ink and
        // reads as a dark rim around the area the user cleaned.
        if (maskRgba[i * 4 + 3] > 0) mask[i] = 1
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
        // The patch replaces the letters, so it is written opaque: reusing the mask's fractional
        // alpha blended the old text back in (0.5 inpainted + 0.5 letter) and left the halo.
        imageData.data[i * 4 + 3] = mask[i] ? 255 : 0
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

function inpaintBounds(stroke, width, height) {
  const minDimension = Math.min(width, height)
  const lineWidth = Math.max(1, stroke.size * minDimension)
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
  const holeW = Math.max(1, maxX - minX + radius * 2)
  const holeH = Math.max(1, maxY - minY + radius * 2)
  // Match PhotoCraft's generous sampling context around the stroke so PatchMatch has rich texture sources.
  const margin = Math.max(24, Math.min(96, Math.round(Math.sqrt(Math.max(holeW, 50) * Math.max(holeH, 50)))))
  const left = Math.max(0, Math.floor(minX - radius - margin))
  const top = Math.max(0, Math.floor(minY - radius - margin))
  const right = Math.min(width, Math.ceil(maxX + radius + margin))
  const bottom = Math.min(height, Math.ceil(maxY + radius + margin))
  return { left, top, bw: right - left, bh: bottom - top, lineWidth }
}

export async function prepareNativeInpaint(page, stroke) {
  if (!desktop?.native || stroke?.mode !== "inpaint" || !page?.image || !stroke.points?.length) return false
  const cached = inpaintEntry(page, stroke)
  if (cached) return cached.pending ?? Boolean(cached.patch)
  const origin = strokeOrigins.get(stroke) ?? stroke
  const entry = { image: page.image, geometry: inpaintGeometry(stroke), patch: null, pending: null }
  nativeInpaintCache.set(origin, entry)
  entry.pending = buildNativeInpaintPatch(page, stroke).then((patch) => {
    entry.patch = patch
    if (patch) retouchCache.delete(entry.image)
    return Boolean(patch)
  }).catch(() => false).finally(() => {
    entry.pending = null
    if (!entry.patch && nativeInpaintCache.get(origin) === entry) nativeInpaintCache.delete(origin)
  })
  return entry.pending
}

async function buildNativeInpaintPatch(page, stroke) {
  const width = page.image.naturalWidth
  const height = page.image.naturalHeight
  if (!width || !height) return null
  const { left, top, bw, bh, lineWidth } = inpaintBounds(stroke, width, height)
  if (bw <= 2 || bh <= 2 || bw * bh > 2_500_000) return null

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
  let any = false
  for (let i = 0; i < mask.length; i++) {
    if (maskRgba[i * 4 + 3] > 0) {
      mask[i] = 1
      any = true
    }
  }
  if (!any) return null

  const patchCanvas = document.createElement("canvas")
  patchCanvas.width = bw
  patchCanvas.height = bh
  const patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true })
  patchCtx.drawImage(page.image, -left, -top)
  const rgba = patchCtx.getImageData(0, 0, bw, bh).data
  const payload = new Uint8Array(rgba.length + mask.length)
  payload.set(rgba, 0)
  payload.set(mask, rgba.length)

  const response = await desktop.native("inpaint", { width: bw, height: bh, patchRadius: 3, colorAdapt: true }, payload)
  const out = new Uint8ClampedArray(response.data)
  if (out.length !== rgba.length) return null
  // Opaque inside the stroke, nothing outside it: a fractional mask alpha would blend the clean
  // patch with the letters it is meant to erase.
  for (let i = 0; i < mask.length; i++) {
    out[i * 4 + 3] = mask[i] ? 255 : 0
  }
  patchCtx.putImageData(new ImageData(out, bw, bh), 0, 0)
  return { canvas: patchCanvas, left, top, width, height }
}

export async function prepareNativeClone(page, stroke) {
  const bridge = globalThis.khungThoaiDesktop ?? desktop
  if (!bridge?.native || stroke?.mode !== "clone" || !stroke.seamless || !page?.image || !stroke.points?.length) return false
  const cached = inpaintEntry(page, stroke)
  if (cached) return cached.pending ?? Boolean(cached.patch)
  const origin = strokeOrigins.get(stroke) ?? stroke
  const entry = { image: page.image, geometry: inpaintGeometry(stroke), patch: null, pending: null }
  nativeInpaintCache.set(origin, entry)
  entry.pending = buildNativeSeamlessClonePatch(page, stroke, bridge).then((patch) => {
    entry.patch = patch
    if (patch) retouchCache.delete(entry.image)
    return Boolean(patch)
  }).catch(() => false).finally(() => {
    entry.pending = null
    if (!entry.patch && nativeInpaintCache.get(origin) === entry) nativeInpaintCache.delete(origin)
  })
  return entry.pending
}

async function buildNativeSeamlessClonePatch(page, stroke, bridge) {
  const width = page.image.naturalWidth
  const height = page.image.naturalHeight
  if (!width || !height) return null
  const minDimension = Math.min(width, height)
  const lineWidth = Math.max(1, stroke.size * minDimension)
  const radius = Math.ceil(lineWidth / 2) + 2
  const margin = 12
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
  if (bw <= 4 || bh <= 4 || bw * bh > 2_500_000) return null

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
  let any = false
  for (let i = 0; i < mask.length; i++) {
    if (maskRgba[i * 4 + 3] > 0) {
      mask[i] = 1
      any = true
    }
  }
  if (!any) return null

  const dstCanvas = document.createElement("canvas")
  dstCanvas.width = bw
  dstCanvas.height = bh
  const dstCtx = dstCanvas.getContext("2d", { willReadFrequently: true })
  dstCtx.drawImage(page.image, -left, -top)
  const dstRgba = dstCtx.getImageData(0, 0, bw, bh).data

  const srcCanvas = document.createElement("canvas")
  srcCanvas.width = bw
  srcCanvas.height = bh
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true })
  srcCtx.drawImage(page.image, -(left + stroke.offsetX * width), -(top + stroke.offsetY * height))
  const srcRgba = srcCtx.getImageData(0, 0, bw, bh).data

  const payload = new Uint8Array(dstRgba.length * 2 + mask.length)
  payload.set(dstRgba, 0)
  payload.set(srcRgba, dstRgba.length)
  payload.set(mask, dstRgba.length * 2)

  const response = await bridge.native("seamless_clone", { width: bw, height: bh }, payload)
  const out = new Uint8ClampedArray(response.data)
  if (out.length !== dstRgba.length) return null
  // Same rule as the inpaint patch: the cloned pixels replace what is under the stroke.
  for (let i = 0; i < mask.length; i++) {
    out[i * 4 + 3] = mask[i] ? 255 : 0
  }
  dstCtx.putImageData(new ImageData(out, bw, bh), 0, 0)
  return { canvas: dstCanvas, left, top, width, height }
}

// One cache entry per layer key, so a page that paints three retouch layers keeps three rendered
// layers instead of rebuilding the whole stack on every stroke of every layer.
export function paintRetouchStrokes(canvas, page, { strokes, opacity = 1, key = "page" } = {}) {
  const list = (strokes ?? page.retouchStrokes)?.filter(strokeVisible)
  if (!list?.length || opacity <= 0) return false
  const width = canvas.width
  const height = canvas.height
  if (typeof document !== "undefined" && page.image && typeof page.image === "object") {
    const signature = retouchSignature(list, width, height, opacity)
    let cache = retouchCache.get(page.image)
    if (!cache) {
      cache = new Map()
      retouchCache.set(page.image, cache)
    }
    let entry = cache.get(key)
    if (!entry || entry.signature !== signature) {
      const layer = document.createElement("canvas")
      layer.width = width
      layer.height = height
      const painted = renderRetouchStrokes(layer.getContext("2d"), { ...page, retouchStrokes: list }, width, height)
      entry = { signature, layer, painted }
      cache.set(key, entry)
    }
    if (entry.painted) {
      const context = canvas.getContext("2d")
      if (opacity < 1) {
        context.save()
        context.globalAlpha = opacity
        context.drawImage(entry.layer, 0, 0)
        context.restore()
      } else {
        context.drawImage(entry.layer, 0, 0)
      }
    }
    return entry.painted
  }
  return renderRetouchStrokes(canvas.getContext("2d"), { ...page, retouchStrokes: list }, width, height)
}
