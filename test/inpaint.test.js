import assert from "node:assert/strict"
import test from "node:test"
import { inpaintRegion } from "../src/inpaint.js"
import { validateRetouchStroke } from "../src/retouch.js"

test("inpaintRegion reconstructs lettered pixels over a color gradient without altering outside pixels", () => {
  const width = 64
  const height = 64
  const clean = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4
      clean[off] = 60 + x * 2
      clean[off + 1] = 100 + y * 2
      clean[off + 2] = 180 - x
      clean[off + 3] = 255
    }
  }

  const corrupted = new Uint8ClampedArray(clean)
  const mask = new Uint8Array(width * height)
  // Paint dark text block in the center [24..40, 26..38].
  for (let y = 26; y < 38; y++) {
    for (let x = 24; x < 40; x++) {
      const idx = y * width + x
      mask[idx] = 1
      corrupted[idx * 4] = 10
      corrupted[idx * 4 + 1] = 10
      corrupted[idx * 4 + 2] = 10
    }
  }

  let beforeError = 0
  let count = 0
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue
    count++
    for (let c = 0; c < 3; c++) beforeError += Math.abs(clean[i * 4 + c] - corrupted[i * 4 + c])
  }

  const reconstructed = inpaintRegion(corrupted, width, height, mask)
  assert.equal(reconstructed, count)

  let afterError = 0
  let outsideChanges = 0
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) {
      for (let c = 0; c < 3; c++) afterError += Math.abs(clean[i * 4 + c] - corrupted[i * 4 + c])
    } else {
      for (let c = 0; c < 4; c++) {
        if (corrupted[i * 4 + c] !== clean[i * 4 + c]) outsideChanges++
      }
    }
  }

  const beforeMae = beforeError / (count * 3)
  const afterMae = afterError / (count * 3)
  assert.equal(outsideChanges, 0)
  assert.ok(beforeMae > 100)
  assert.ok(afterMae < 10, `Expected low reconstruction MAE, got ${afterMae}`)
})

test("inpaintRegion uses exemplar blending on textured backgrounds and validateRetouchStroke accepts inpaint", () => {
  const width = 64
  const height = 64
  const clean = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stripe = ((x + y) % 6) < 3 ? 220 : 80
      const off = (y * width + x) * 4
      clean[off] = stripe
      clean[off + 1] = stripe
      clean[off + 2] = stripe
      clean[off + 3] = 255
    }
  }
  const corrupted = new Uint8ClampedArray(clean)
  const mask = new Uint8Array(width * height)
  for (let y = 28; y < 36; y++) {
    for (let x = 28; x < 36; x++) {
      const idx = y * width + x
      mask[idx] = 1
      corrupted[idx * 4] = 0
      corrupted[idx * 4 + 1] = 0
      corrupted[idx * 4 + 2] = 0
    }
  }
  const reconstructed = inpaintRegion(corrupted, width, height, mask)
  assert.equal(reconstructed, 64)
  let afterError = 0
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue
    afterError += Math.abs(clean[i * 4] - corrupted[i * 4])
  }
  assert.ok(afterError / 64 < 35, `Expected exemplar stripe recovery, got MAE ${afterError / 64}`)

  assert.deepEqual(
    validateRetouchStroke({ mode: "inpaint", size: .04, opacity: 1, points: [{ x: .2, y: .3 }] }),
    { mode: "inpaint", size: .04, points: [{ x: .2, y: .3 }] },
  )
  assert.equal(validateRetouchStroke({ mode: "inpaint", size: .04, points: [] }), null)
})
