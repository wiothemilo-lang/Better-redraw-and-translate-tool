import assert from "node:assert/strict"
import test from "node:test"
import { paintRetouchStrokes, samplePixelColor, validateRetouchStroke } from "../src/retouch.js"

test("validateRetouchStroke validates paint and clone strokes and rejects malformed inputs", () => {
  assert.deepEqual(
    validateRetouchStroke({ mode: "paint", size: .05, color: "#12ab34", opacity: 1, points: [{ x: .1, y: .2 }] }),
    { mode: "paint", size: .05, color: "#12ab34", points: [{ x: .1, y: .2 }] },
  )
  assert.deepEqual(
    validateRetouchStroke({ mode: "clone", size: .08, offsetX: -.1, offsetY: .2, opacity: .6, points: [{ x: .5, y: .5 }] }),
    { mode: "clone", size: .08, offsetX: -.1, offsetY: .2, opacity: .6, points: [{ x: .5, y: .5 }] },
  )
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

test("paintRetouchStrokes renders both paint and clone strokes onto canvas", (t) => {
  const originalDocument = globalThis.document
  const ops = []
  globalThis.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() { ops.push("stamp-stroke") },
            drawImage(_img, x, y) { ops.push(["stamp-source", Math.round(x), Math.round(y)]) },
          }
        },
      }
    },
  }
  t.after(() => { globalThis.document = originalDocument })

  const canvas = {
    width: 100, height: 100,
    getContext() {
      return {
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() { ops.push(["paint", this.strokeStyle, this.globalAlpha]) },
        drawImage(_stamp, left, top) { ops.push(["clone-draw", left, top, this.globalAlpha]) },
      }
    },
  }
  const painted = paintRetouchStrokes(canvas, {
    image: { naturalWidth: 100, naturalHeight: 100 },
    retouchStrokes: [
      { mode: "paint", size: .1, color: "#ffffff", opacity: .8, points: [{ x: .2, y: .2 }, { x: .3, y: .3 }] },
      { mode: "clone", size: .1, offsetX: -.1, offsetY: .1, opacity: .5, points: [{ x: .5, y: .5 }] },
    ],
  })
  assert.equal(painted, true)
  assert.deepEqual(ops[0], ["paint", "#ffffff", .8])
  assert.equal(ops[1], "stamp-stroke")
  assert.equal(ops[2][0], "stamp-source")
  assert.equal(ops[3][0], "clone-draw")
  assert.equal(ops[3][3], .5)
})
