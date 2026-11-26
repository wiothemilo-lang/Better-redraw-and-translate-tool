const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function pixelLuma(pixels, offset) {
  const r = pixels[offset]
  const g = pixels[offset + 1]
  const b = pixels[offset + 2]
  const a = pixels[offset + 3] ?? 255
  const luma = (r * 54 + g * 183 + b * 19) / 256
  return a === 255 ? luma : (luma * a + 255 * (255 - a)) / 255
}

export function detectBubbleRect(
  pixels,
  width,
  height,
  clickX,
  clickY,
  { minLuma = 185, tolerance = 45, maxAreaFraction = .25, minPixels = 80, insetRatio = .08 } = {},
) {
  if (!pixels || width < 8 || height < 8) return null
  const sx = clamp(Math.floor(clickX * width), 0, width - 1)
  const sy = clamp(Math.floor(clickY * height), 0, height - 1)
  const seedOffset = (sy * width + sx) * 4
  const seedLuma = pixelLuma(pixels, seedOffset)
  if (seedLuma < minLuma) return null

  const seedR = pixels[seedOffset]
  const seedG = pixels[seedOffset + 1]
  const seedB = pixels[seedOffset + 2]
  const maxPixels = Math.max(minPixels, Math.floor(width * height * maxAreaFraction))
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(maxPixels + 4)

  let head = 0
  let tail = 0
  const startIndex = sy * width + sx
  visited[startIndex] = 1
  queue[tail++] = startIndex

  let minX = sx
  let maxX = sx
  let minY = sy
  let maxY = sy
  let count = 0
  let bordersHit = 0

  while (head < tail) {
    const index = queue[head++]
    count++
    if (count > maxPixels) return null

    const x = index % width
    const y = (index - x) / width
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (x === 0) bordersHit |= 1
    if (x === width - 1) bordersHit |= 2
    if (y === 0) bordersHit |= 4
    if (y === height - 1) bordersHit |= 8

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ]
    for (const next of neighbors) {
      if (next < 0 || visited[next]) continue
      const off = next * 4
      const luma = pixelLuma(pixels, off)
      if (luma < minLuma) continue
      if (
        Math.abs(pixels[off] - seedR) > tolerance ||
        Math.abs(pixels[off + 1] - seedG) > tolerance ||
        Math.abs(pixels[off + 2] - seedB) > tolerance
      ) continue
      visited[next] = 1
      if (tail >= queue.length) return null
      queue[tail++] = next
    }
  }

  const borderCount = ((bordersHit & 1) ? 1 : 0) + ((bordersHit & 2) ? 1 : 0) + ((bordersHit & 4) ? 1 : 0) + ((bordersHit & 8) ? 1 : 0)
  if (count < minPixels) return null
  if (borderCount >= 2 && count > width * height * .12) return null

  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  if (bw < 10 || bh < 10) return null

  const insetX = bw * insetRatio
  const insetY = bh * insetRatio
  const left = clamp((minX + insetX) / width, 0, .97)
  const top = clamp((minY + insetY) / height, 0, .97)
  const right = clamp((maxX + 1 - insetX) / width, left + .03, 1)
  const bottom = clamp((maxY + 1 - insetY) / height, top + .03, 1)
  return {
    x: left,
    y: top,
    w: Math.min(right - left, 1 - left),
    h: Math.min(bottom - top, 1 - top),
  }
}

export function detectBubbleOnImage(image, clickX, clickY, options) {
  const natW = image?.naturalWidth ?? 0
  const natH = image?.naturalHeight ?? 0
  if (!natW || !natH) return null
  const scale = Math.min(1, 640 / Math.max(natW, natH))
  const width = Math.max(8, Math.round(natW * scale))
  const height = Math.max(8, Math.round(natH * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  return detectBubbleRect(pixels, width, height, clickX, clickY, options)
}
