// Deterministic inward Fast-Marching directional diffusion + local exemplar patch inpainting
// for erasing lettering on complex, non-repeating comic backgrounds without external ML weights.

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)))

function boundaryVariance(rgba, known, width, height, cx, cy, radius) {
  let count = 0
  let sum = 0
  let sumSq = 0
  const x0 = Math.max(0, cx - radius)
  const x1 = Math.min(width - 1, cx + radius)
  const y0 = Math.max(0, cy - radius)
  const y1 = Math.min(height - 1, cy + radius)
  for (let y = y0; y <= y1; y++) {
    const row = y * width
    for (let x = x0; x <= x1; x++) {
      const idx = row + x
      if (!known[idx]) continue
      const off = idx * 4
      const luma = (rgba[off] * 54 + rgba[off + 1] * 183 + rgba[off + 2] * 19) / 256
      sum += luma
      sumSq += luma * luma
      count++
    }
  }
  if (count < 8) return 0
  const mean = sum / count
  return Math.max(0, sumSq / count - mean * mean)
}

function estimateGradient(rgba, known, width, height, x, y) {
  let gx = 0
  let gy = 0
  const left = x > 0 && known[y * width + x - 1]
  const right = x + 1 < width && known[y * width + x + 1]
  const up = y > 0 && known[(y - 1) * width + x]
  const down = y + 1 < height && known[(y + 1) * width + x]
  const lumaAt = (px, py) => {
    const off = (py * width + px) * 4
    return (rgba[off] * 54 + rgba[off + 1] * 183 + rgba[off + 2] * 19) / 256
  }
  if (left && right) gx = (lumaAt(x + 1, y) - lumaAt(x - 1, y)) * .5
  else if (right && known[y * width + x]) gx = lumaAt(x + 1, y) - lumaAt(x, y)
  else if (left && known[y * width + x]) gx = lumaAt(x, y) - lumaAt(x - 1, y)

  if (up && down) gy = (lumaAt(x, y + 1) - lumaAt(x, y - 1)) * .5
  else if (down && known[y * width + x]) gy = lumaAt(x, y + 1) - lumaAt(x, y)
  else if (up && known[y * width + x]) gy = lumaAt(x, y) - lumaAt(x, y - 1)
  return { gx, gy }
}

function exemplarMatch(rgba, originalKnown, known, width, height, x, y, searchRadius = 16) {
  const half = 2
  const patchIndices = []
  for (let dy = -half; dy <= half; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= height) continue
    for (let dx = -half; dx <= half; dx++) {
      const nx = x + dx
      if (nx < 0 || nx >= width) continue
      if (!known[ny * width + nx]) continue
      const off = (ny * width + nx) * 4
      patchIndices.push(dx, dy, rgba[off], rgba[off + 1], rgba[off + 2])
    }
  }
  if (patchIndices.length < 15) return null // need at least 3 known pixels in 5x5 neighborhood

  let bestScore = Infinity
  let bestOff = -1
  const minX = Math.max(half, x - searchRadius)
  const maxX = Math.min(width - 1 - half, x + searchRadius)
  const minY = Math.max(half, y - searchRadius)
  const maxY = Math.min(height - 1 - half, y + searchRadius)

  for (let cy = minY; cy <= maxY; cy += 2) {
    for (let cx = minX; cx <= maxX; cx += 2) {
      if (!originalKnown[cy * width + cx]) continue
      if (Math.abs(cx - x) <= half && Math.abs(cy - y) <= half) continue
      let score = 0
      let valid = true
      for (let i = 0; i < patchIndices.length; i += 5) {
        const sx = cx + patchIndices[i]
        const sy = cy + patchIndices[i + 1]
        if (!originalKnown[sy * width + sx]) {
          valid = false
          break
        }
        const off = (sy * width + sx) * 4
        const dr = rgba[off] - patchIndices[i + 2]
        const dg = rgba[off + 1] - patchIndices[i + 3]
        const db = rgba[off + 2] - patchIndices[i + 4]
        score += dr * dr + dg * dg + db * db
        if (score >= bestScore) {
          valid = false
          break
        }
      }
      if (valid && score < bestScore) {
        bestScore = score
        bestOff = (cy * width + cx) * 4
      }
    }
  }
  if (bestOff < 0) return null
  const avgDiff = Math.sqrt(bestScore / (patchIndices.length / 5) / 3)
  return avgDiff <= 38 ? [rgba[bestOff], rgba[bestOff + 1], rgba[bestOff + 2]] : null
}

/**
 * Reconstruct masked pixels in-place inside `rgba` (Uint8ClampedArray or Uint8Array).
 * `mask[i] === 1` marks pixels to inpaint; `mask[i] === 0` pixels are NEVER modified.
 * Returns count of reconstructed pixels.
 */
export function inpaintRegion(rgba, width, height, mask) {
  const total = width * height
  if (!rgba || !mask || total === 0) return 0

  const originalKnown = new Uint8Array(total)
  const known = new Uint8Array(total)
  const inQueue = new Uint8Array(total)
  const dist = new Float32Array(total)
  const maskList = []

  for (let i = 0; i < total; i++) {
    if (mask[i]) {
      dist[i] = 1e6
      maskList.push(i)
    } else {
      originalKnown[i] = 1
      known[i] = 1
      dist[i] = 0
    }
  }
  if (!maskList.length || maskList.length === total) return 0

  // Determine whether surrounding artwork has noticeable texture (use exemplar blending if so).
  let sumX = 0
  let sumY = 0
  for (const idx of maskList) {
    sumX += idx % width
    sumY += (idx / width) | 0
  }
  const centerX = Math.round(sumX / maskList.length)
  const centerY = Math.round(sumY / maskList.length)
  const textured = boundaryVariance(rgba, originalKnown, width, height, centerX, centerY, Math.min(28, Math.max(12, Math.round(Math.sqrt(maskList.length))))) > 260

  // Seed frontier with masked pixels directly adjacent to known background.
  let frontier = []
  for (const idx of maskList) {
    const x = idx % width
    const y = (idx - x) / width
    if (
      (x > 0 && known[idx - 1]) ||
      (x + 1 < width && known[idx + 1]) ||
      (y > 0 && known[idx - width]) ||
      (y + 1 < height && known[idx + width])
    ) {
      inQueue[idx] = 1
      dist[idx] = 1
      frontier.push(idx)
    }
  }

  let ring = 1
  const radius = 3
  while (frontier.length) {
    const nextFrontier = []
    for (const idx of frontier) {
      const x = idx % width
      const y = (idx - x) / width

      // Compute Telea-style directional + distance-weighted color estimate.
      let wSum = 0
      let rSum = 0
      let gSum = 0
      let bSum = 0
      // Approximate normal pointing inward from local distance gradient.
      const nx = ((x + 1 < width ? dist[idx + 1] : dist[idx]) - (x > 0 ? dist[idx - 1] : dist[idx])) * .5
      const ny = ((y + 1 < height ? dist[idx + width] : dist[idx]) - (y > 0 ? dist[idx - width] : dist[idx])) * .5
      const nLen = Math.hypot(nx, ny) || 1
      const unx = nx / nLen
      const uny = ny / nLen

      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      for (let py = y0; py <= y1; py++) {
        const row = py * width
        for (let px = x0; px <= x1; px++) {
          const nIdx = row + px
          if (!known[nIdx]) continue
          const dx = x - px
          const dy = y - py
          const d2 = dx * dx + dy * dy
          if (d2 === 0) continue
          const d = Math.sqrt(d2)
          const dir = Math.abs((dx * unx + dy * uny) / d) + .15
          const level = 1 / (1 + Math.abs(dist[idx] - dist[nIdx]))
          const geom = 1 / (d2 * d)
          const w = dir * level * geom

          const off = nIdx * 4
          const { gx, gy } = estimateGradient(rgba, known, width, height, px, py)
          // Subtle gradient transport clamped to avoid overshoot on high-contrast ink borders.
          const step = Math.max(-18, Math.min(18, (gx * dx + gy * dy) * .25))
          rSum += w * clampByte(rgba[off] + step)
          gSum += w * clampByte(rgba[off + 1] + step)
          bSum += w * clampByte(rgba[off + 2] + step)
          wSum += w
        }
      }

      const off = idx * 4
      let r = wSum > 0 ? rSum / wSum : 255
      let g = wSum > 0 ? gSum / wSum : 255
      let b = wSum > 0 ? bSum / wSum : 255

      if (textured && maskList.length <= 24000) {
        const match = exemplarMatch(rgba, originalKnown, known, width, height, x, y)
        if (match) {
          r = r * .3 + match[0] * .7
          g = g * .3 + match[1] * .7
          b = b * .3 + match[2] * .7
        }
      }

      rgba[off] = clampByte(r)
      rgba[off + 1] = clampByte(g)
      rgba[off + 2] = clampByte(b)
      rgba[off + 3] = 255
    }

    for (const idx of frontier) {
      known[idx] = 1
      const x = idx % width
      const y = (idx - x) / width
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < width ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y + 1 < height ? idx + width : -1,
      ]
      for (const n of neighbors) {
        if (n >= 0 && !known[n] && !inQueue[n]) {
          inQueue[n] = 1
          dist[n] = ring + 1
          nextFrontier.push(n)
        }
      }
    }
    ring++
    frontier = nextFrontier
  }

  // Two gentle harmonic relaxation passes inside the mask only (eliminates onion-peel seams).
  if (!textured) {
    const scratch = new Uint8Array(rgba.length)
    for (let pass = 0; pass < 2; pass++) {
      scratch.set(rgba)
      for (const idx of maskList) {
        const x = idx % width
        const y = (idx - x) / width
        let count = 0
        let r = 0
        let g = 0
        let b = 0
        const coords = [
          x > 0 ? idx - 1 : -1,
          x + 1 < width ? idx + 1 : -1,
          y > 0 ? idx - width : -1,
          y + 1 < height ? idx + width : -1,
        ]
        for (const n of coords) {
          if (n < 0) continue
          const o = n * 4
          r += scratch[o]
          g += scratch[o + 1]
          b += scratch[o + 2]
          count++
        }
        if (count) {
          const off = idx * 4
          rgba[off] = clampByte((scratch[off] + r / count) * .5)
          rgba[off + 1] = clampByte((scratch[off + 1] + g / count) * .5)
          rgba[off + 2] = clampByte((scratch[off + 2] + b / count) * .5)
        }
      }
    }
  }

  return maskList.length
}
