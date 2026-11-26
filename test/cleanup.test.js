import assert from "node:assert/strict"
import test from "node:test"
import { applyAlphaExpand } from "../src/cleanup.js"

function bruteForceExpand(source, width, height, expand) {
  if (!expand) return source
  const out = new Uint8Array(source.length)
  const radius = Math.abs(expand)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let alpha = expand > 0 ? 0 : 255
      if (expand < 0 && (x < radius || y < radius || x + radius >= width || y + radius >= height)) alpha = 0
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          const value = source[yy * width + xx]
          alpha = expand > 0 ? Math.max(alpha, value) : Math.min(alpha, value)
        }
      }
      out[y * width + x] = alpha
    }
  }
  return out
}

test("separable applyAlphaExpand matches brute-force 2D dilation and erosion exactly", () => {
  const width = 23
  const height = 19
  const source = new Uint8Array(width * height)
  let seed = 1337
  for (let i = 0; i < source.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    source[i] = seed & 255
  }
  for (const expand of [-8, -3, -1, 0, 1, 3, 8]) {
    assert.deepEqual(
      applyAlphaExpand(source, width, height, expand),
      bruteForceExpand(source, width, height, expand),
      `mismatch for expand=${expand}`,
    )
  }
})
