export const cleanupRectangle = (box) => box.cleanupRect ?? box.originalBox ?? box

export function applyAlphaExpand(alphaBytes, width, height, expand) {
  if (!expand) return alphaBytes
  const radius = Math.abs(expand)
  const dilate = expand > 0
  const temp = new Uint8Array(width * height)
  const output = new Uint8Array(width * height)
  // Separable 1D horizontal then vertical min/max matches square 2D erosion/dilation in O(W*H*R).
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (!dilate && (x < radius || x + radius >= width)) {
        temp[row + x] = 0
        continue
      }
      let value = dilate ? 0 : 255
      const start = Math.max(0, x - radius)
      const end = Math.min(width - 1, x + radius)
      for (let xx = start; xx <= end; xx++) {
        const sample = alphaBytes[row + xx]
        value = dilate ? (sample > value ? sample : value) : (sample < value ? sample : value)
      }
      temp[row + x] = value
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width
    if (!dilate && (y < radius || y + radius >= height)) continue
    const start = Math.max(0, y - radius)
    const end = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x++) {
      let value = dilate ? 0 : 255
      for (let yy = start; yy <= end; yy++) {
        const sample = temp[yy * width + x]
        value = dilate ? (sample > value ? sample : value) : (sample < value ? sample : value)
      }
      output[row + x] = value
    }
  }
  return output
}

// Stroke widths use the shorter image dimension, so masks survive zoom and export.
export function paintCleanupMask(canvas, box, image, left, top) {
  const context = canvas.getContext("2d")
  context.fillStyle = "#fff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.lineCap = "round"
  context.lineJoin = "round"
  for (const stroke of box.cleanupStrokes ?? []) {
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over"
    context.lineWidth = stroke.size * Math.min(image.naturalWidth, image.naturalHeight)
    context.beginPath()
    const points = stroke.points.map(({ x, y }) => ({
      x: x * image.naturalWidth - left, y: y * image.naturalHeight - top,
    }))
    context.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) context.lineTo(point.x, point.y)
    if (points.length === 1) context.lineTo(points[0].x + .01, points[0].y)
    context.stroke()
  }
  context.globalCompositeOperation = "source-over"
  const expand = box.cleanupExpand ?? 0
  if (!expand) return
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const alpha = new Uint8Array(canvas.width * canvas.height)
  for (let index = 0; index < alpha.length; index++) alpha[index] = pixels.data[index * 4 + 3]
  const expanded = applyAlphaExpand(alpha, canvas.width, canvas.height, expand)
  for (let index = 0; index < expanded.length; index++) pixels.data[index * 4 + 3] = expanded[index]
  context.putImageData(pixels, 0, 0)
}

export function maskCleanup(patch, box, image) {
  if (!patch || (!box.cleanupStrokes?.length && !box.cleanupExpand)) return patch
  const mask = document.createElement("canvas")
  mask.width = patch.patch.width
  mask.height = patch.patch.height
  paintCleanupMask(mask, box, image, patch.left, patch.top)
  const context = patch.patch.getContext("2d")
  context.globalCompositeOperation = "destination-in"
  context.drawImage(mask, 0, 0)
  context.globalCompositeOperation = "source-over"
  return patch
}

export async function nativeMaskCleanup(patch, box, image) {
  const native = globalThis.khungThoaiDesktop?.native
  if (!patch || !native) return maskCleanup(patch, box, image)
  if (!box.cleanupStrokes?.length && !box.cleanupExpand) return patch
  const { width, height } = patch.patch
  const context = patch.patch.getContext("2d")
  const pixels = context.getImageData(0, 0, width, height).data
  try {
    const { data } = await native("mask", {
      width, height, left: patch.left, top: patch.top,
      imageWidth: image.naturalWidth, imageHeight: image.naturalHeight,
      strokes: box.cleanupStrokes ?? [], expand: box.cleanupExpand ?? 0,
    }, pixels)
    if (data.length !== pixels.length) throw new Error("Invalid native mask.")
    context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    return patch
  } catch {
    // Preserve brush protection if the optional native worker is unavailable.
    return maskCleanup(patch, box, image)
  }
}
