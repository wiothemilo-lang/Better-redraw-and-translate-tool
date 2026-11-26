import { desktop } from "./native.js"

/**
 * Pure-JS fallback of Smart Manga Raw Page Cleanup (Auto Levels + Edge-Preserving
 * Bilateral Denoise + Gentle Unsharp Mask), matching native/RawCleanup.cs.
 */
export function cleanRawPixels(rgba, width, height, { strength = 0.7, denoise = true, sharpen = true } = {}) {
  const pixelCount = width * height
  if (!rgba || rgba.length !== pixelCount * 4 || pixelCount <= 0) {
    throw new Error("Dữ liệu ảnh không hợp lệ để làm sạch raw.")
  }
  const s = Math.min(1, Math.max(0, Number(strength) || 0.7))
  const out = new Uint8ClampedArray(rgba)

  // 1. Luminance + per-channel histograms & near-grayscale detection.
  const histL = new Int32Array(256)
  const histR = new Int32Array(256)
  const histG = new Int32Array(256)
  const histB = new Int32Array(256)
  let lowSatCount = 0
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4
    const r = out[o], g = out[o + 1], b = out[o + 2]
    const luma = (r * 77 + g * 150 + b * 29) >> 8
    histL[luma]++
    histR[r]++
    histG[g]++
    histB[b]++
    const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b)
    const minC = r < g ? (r < b ? r : b) : (g < b ? g : b)
    if (maxC - minC <= 26) lowSatCount++
  }

  const isMostlyGrayscale = lowSatCount > pixelCount * 0.88
  const blackTarget = Math.floor(pixelCount * (0.012 * s + 0.003))
  const whiteTarget = Math.floor(pixelCount * (1 - (0.055 * s + 0.01)))

  const percentile = (hist, target) => {
    let acc = 0
    for (let i = 0; i < 256; i++) {
      acc += hist[i]
      if (acc >= target) return i
    }
    return 255
  }

  const buildLut = (lo, hi) => {
    lo = Math.min(lo, 68)
    hi = Math.max(hi, 185)
    if (hi - lo < 40) { lo = 0; hi = 255 }
    const lut = new Uint8Array(256)
    const span = hi - lo
    for (let i = 0; i < 256; i++) {
      const norm = Math.min(1, Math.max(0, (i - lo) / span))
      lut[i] = Math.round(norm * 255)
    }
    return lut
  }

  const low = percentile(histL, blackTarget)
  const high = percentile(histL, whiteTarget)
  // On mostly grayscale/sepia scans, stretch R/G/B independently to neutralize paper yellowing cleanly.
  const lutR = isMostlyGrayscale ? buildLut(percentile(histR, blackTarget), percentile(histR, whiteTarget)) : buildLut(low, high)
  const lutG = isMostlyGrayscale ? buildLut(percentile(histG, blackTarget), percentile(histG, whiteTarget)) : lutR
  const lutB = isMostlyGrayscale ? buildLut(percentile(histB, blackTarget), percentile(histB, whiteTarget)) : lutR

  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4
    out[o] = lutR[out[o]]
    out[o + 1] = lutG[out[o + 1]]
    out[o + 2] = lutB[out[o + 2]]
  }

  // 2. 3x3 edge-preserving bilateral denoise.
  if (denoise && s > 0.05) {
    const rangeSigma = 12 + 18 * s
    const invTwoSigmaSq = 1 / (2 * rangeSigma * rangeSigma)
    const src = new Uint8ClampedArray(out)
    for (let y = 1; y < height - 1; y++) {
      const row = y * width
      for (let x = 1; x < width - 1; x++) {
        const co = (row + x) * 4
        const cr = src[co], cg = src[co + 1], cb = src[co + 2]
        let sr = 0, sg = 0, sb = 0, wSum = 0
        for (let dy = -1; dy <= 1; dy++) {
          const nRow = (y + dy) * width
          for (let dx = -1; dx <= 1; dx++) {
            const no = (nRow + x + dx) * 4
            const nr = src[no], ng = src[no + 1], nb = src[no + 2]
            const dr = nr - cr, dg = ng - cg, db = nb - cb
            const distSq = (dr * dr + dg * dg + db * db) / 3
            const spatial = (dx === 0 && dy === 0) ? 1.5 : (dx === 0 || dy === 0 ? 1 : 0.65)
            const w = spatial * Math.exp(-distSq * invTwoSigmaSq)
            sr += nr * w
            sg += ng * w
            sb += nb * w
            wSum += w
          }
        }
        const inv = 1 / wSum
        out[co] = Math.round(sr * inv)
        out[co + 1] = Math.round(sg * inv)
        out[co + 2] = Math.round(sb * inv)
      }
    }
  }

  // 3. Gentle unsharp mask.
  if (sharpen && s > 0.1) {
    const amount = 0.25 + 0.35 * s
    const src = new Uint8ClampedArray(out)
    for (let y = 1; y < height - 1; y++) {
      const row = y * width
      for (let x = 1; x < width - 1; x++) {
        const co = (row + x) * 4
        const up = ((y - 1) * width + x) * 4
        const dn = ((y + 1) * width + x) * 4
        const lf = (row + x - 1) * 4
        const rt = (row + x + 1) * 4
        for (let c = 0; c < 3; c++) {
          const center = src[co + c]
          const blur = (center * 4 + src[up + c] + src[dn + c] + src[lf + c] + src[rt + c]) * 0.125
          const diff = center - blur
          if (Math.abs(diff) < 3) continue
          out[co + c] = Math.round(center + diff * amount)
        }
      }
    }
  }

  return { data: out, blackPoint: low, whitePoint: high, grayscale: isMostlyGrayscale }
}

/**
 * Clean a page's raw image using the C# native worker when available, else JS fallback.
 * Returns a new PNG File ready to replace `page.file` (fully Undoable via checkpoint()).
 */
export async function cleanRawPageImage(page, { strength = 0.7, denoise = true, sharpen = true } = {}) {
  const width = page.image.naturalWidth
  const height = page.image.naturalHeight
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(page.image, 0, 0)
  const imageData = ctx.getImageData(0, 0, width, height)

  let cleanedRgba
  let meta
  let engine = "js"

  if (desktop?.native) {
    try {
      const response = await desktop.native(
        "clean_raw",
        { width, height, strength, denoise, sharpen },
        new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
      )
      if (response?.data?.length === imageData.data.length) {
        cleanedRgba = new Uint8ClampedArray(response.data)
        meta = response.result
        engine = "native-cs"
      }
    } catch {
      // Fall back to JS implementation if native worker is unavailable.
    }
  }

  if (!cleanedRgba) {
    const res = cleanRawPixels(imageData.data, width, height, { strength, denoise, sharpen })
    cleanedRgba = res.data
    meta = res
  }

  ctx.putImageData(new ImageData(cleanedRgba, width, height), 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
  if (!blob) throw new Error("Không thể tạo ảnh sau khi làm sạch raw.")
  const stem = page.name.replace(/\.[^.]+$/, "")
  const file = new File([blob], `${stem}.png`, { type: "image/png" })
  return { file, engine, meta }
}
