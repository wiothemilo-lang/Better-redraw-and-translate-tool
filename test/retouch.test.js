import assert from "node:assert/strict"
import test from "node:test"
import { paintRetouchStrokes, samplePixelColor, validateRetouchStroke } from "../src/retouch.js"

test("validateRetouchStroke validates paint and clone strokes and rejects malformed inputs", () => {
  assert.deepEqual(
    validateRetouchStroke({ mode: "paint", size: .05, color: "#12ab34", opacity: 1, points: [{ x: .1, y: .2 }] }),
    { mode: "paint", size: .05, color: "#12ab34", points: [{ x: .1, y: .2 }] },
  )
  assert.deepEqual(
    validateRetouchStroke({ mode: "clone", size: .08, offsetX: -.1, offsetY: .2, opacity: .6, seamless: true, points: [{ x: .5, y: .5 }] }),
    { mode: "clone", size: .08, offsetX: -.1, offsetY: .2, seamless: true, opacity: .6, points: [{ x: .5, y: .5 }] },
  )
  assert.equal(validateRetouchStroke({ mode: "clone", size: .08, offsetX: 0, offsetY: 0, seamless: "yes", points: [{ x: .5, y: .5 }] }), null)
  assert.equal(validateRetouchStroke({ mode: "paint", size: .05, color: "red", points: [{ x: .1, y: .2 }] }), null)
  assert.equal(validateRetouchStroke({ mode: "clone", size: .05, offsetX: 2, offsetY: 0, points: [{ x: .1, y: .2 }] }), null)
  assert.equal(validateRetouchStroke({ mode: "paint", size: .05, color: "#ffffff", points: [] }), null)
})

test("samplePixelColor reads exact RGB hex at normalized coordinates", (t) => {
  const originalDocument = globalThis.document
  globalThis.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            drawImage(_image, dx, dy) { this.dx = dx; this.dy = dy },
            getImageData() { return { data: new Uint8ClampedArray([18, 62, 50, 255]) } },
          }
        },
      }
    },
  }
  t.after(() => { globalThis.document = originalDocument })
  assert.equal(samplePixelColor({ naturalWidth: 100, naturalHeight: 200 }, { x: .5, y: .25 }), "#123e32")
})

test("paintRetouchStrokes renders paint and clone strokes, caches layer, and invalidates on edits", (t) => {
  const originalDocument = globalThis.document
  const ops = []
  let createdCanvases = 0
  globalThis.document = {
    createElement() {
      createdCanvases++
      const index = createdCanvases
      return {
        width: 0, height: 0,
        getContext() {
          return {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { ops.push(["stroke", index, this.strokeStyle, this.globalAlpha]) },
            drawImage(_img, x, y) { ops.push(["drawImage", index, Math.round(x), Math.round(y), this.globalAlpha]) },
          }
        },
      }
    },
  }
  t.after(() => { globalThis.document = originalDocument })

  let destBlits = 0
  const canvas = {
    width: 100, height: 100,
    getContext() {
      return {
        drawImage() { destBlits++ },
      }
    },
  }
  const page = {
    image: { naturalWidth: 100, naturalHeight: 100 },
    retouchStrokes: [
      { mode: "paint", size: .1, color: "#ffffff", opacity: .8, points: [{ x: .2, y: .2 }, { x: .25, y: .25 }, { x: .3, y: .3 }] },
      { mode: "clone", size: .1, offsetX: -.1, offsetY: .1, opacity: .5, points: [{ x: .5, y: .5 }] },
    ],
  }
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 1)
  assert.ok(ops.some(([op, , color, alpha]) => op === "stroke" && color === "#ffffff" && alpha === .8))
  assert.ok(ops.some(([op, , , , alpha]) => op === "drawImage" && alpha === .5))

  // Second call with unchanged strokes hits cache (no new offscreen canvases or stroke redraws).
  const opsAfterFirst = ops.length
  const canvasesAfterFirst = createdCanvases
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 2)
  assert.equal(ops.length, opsAfterFirst)
  assert.equal(createdCanvases, canvasesAfterFirst)

  page.retouchStrokes[0].points[1].y = .28
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 3)
  assert.ok(createdCanvases > canvasesAfterFirst)

  const canvasesAfterEdit = createdCanvases
  page.retouchStrokes.pop()
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 4)
  assert.ok(createdCanvases > canvasesAfterEdit)
})

test("an inpainted patch is written opaquely so no rim of the old letters survives", async (t) => {
  const originalDocument = globalThis.document
  // Canvas 1 is the retouch layer, 2 the stroke mask, 3 the inpainted patch.
  let created = 0
  let written = null
  const maskAlpha = Array.from({ length: 64 }, (_, i) => (i < 16 || i >= 48 ? 0 : [255, 96, 8][i % 3]))
  globalThis.document = {
    createElement() {
      created++
      const index = created
      const canvas = { width: 0, height: 0 }
      const context = {
        canvas,
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        drawImage() {},
        getImageData: () => {
          if (index === 2) {
            const data = new Uint8ClampedArray(64 * 4)
            // A thick black letter: the mask only decides where the patch is opaque.
            for (let i = 0; i < 64; i++) data.fill(0, i * 4, i * 4 + 4)
            for (let i = 0; i < 64; i++) data[i * 4 + 3] = maskAlpha[i]
            return { data }
          }
          const data = new Uint8ClampedArray(64 * 4).fill(255)
          return { data }
        },
        putImageData: (imageData) => { written = imageData.data },
      }
      canvas.getContext = () => context
      return canvas
    },
  }
  t.after(() => { globalThis.document = originalDocument })

  const target = { width: 8, height: 8, getContext: () => ({ drawImage() {} }) }
  const page = {
    image: { naturalWidth: 8, naturalHeight: 8 },
    retouchStrokes: [{ mode: "inpaint", size: .5, points: [{ x: .5, y: .5 }] }],
  }
  assert.equal(paintRetouchStrokes(target, page), true)
  assert.ok(written, "the patch has to be written back to its canvas")

  // Covered pixels are fully opaque: a fractional alpha would blend the cleaned area with the old
  // letters underneath, which is the halo this guards against.
  for (let i = 0; i < 64; i++) {
    assert.equal(written[i * 4 + 3], maskAlpha[i] > 0 ? 255 : 0, `pixel ${i} with mask ${maskAlpha[i]}`)
  }
  // Including the antialiased edge the old 32-alpha threshold dropped entirely.
  const edge = maskAlpha.findIndex((alpha) => alpha === 8)
  assert.ok(edge >= 0)
  assert.equal(written[edge * 4 + 3], 255)
})
