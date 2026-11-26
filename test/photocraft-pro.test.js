import test from "node:test"
import assert from "node:assert/strict"
import { autoFitBox, drawPage, ellipseChordWidth, textOverflows } from "../src/canvas.js"
import { projectStyle } from "../src/project.js"
import { cleanRawPixels } from "../src/raw-cleanup.js"
import { paintRetouchStrokes, validateRetouchStroke } from "../src/retouch.js"

function mockDocument() {
  const prev = globalThis.document
  const ops = []
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return {
            canvas,
            font: "",
            globalCompositeOperation: "source-over",
            save() { ops.push(["save"]) },
            restore() { ops.push(["restore"]) },
            translate(x, y) { ops.push(["translate", x, y]) },
            rotate(a) { ops.push(["rotate", a]) },
            beginPath() {},
            rect() {},
            ellipse() {},
            clip() {},
            clearRect() {},
            fillRect() {},
            drawImage() {},
            moveTo() {},
            lineTo() {},
            stroke() { ops.push(["stroke", this.globalCompositeOperation]) },
            fill() {},
            measureText(text) {
              const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(this.font)
              const size = sizeMatch ? Number(sizeMatch[1]) : 16
              return { width: String(text || "").length * size * 0.55 }
            },
            strokeText(t) { ops.push(["strokeText", t]) },
            fillText(t) { ops.push(["fillText", t]) },
          }
        },
      }
      return canvas
    },
  }
  return { ops, restore: () => { globalThis.document = prev } }
}

test("cleanRawPixels whitens yellowed paper, deepens ink, and validates inputs", () => {
  const width = 32
  const height = 32
  const raw = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const ink = x >= 12 && x <= 19 && y >= 8 && y <= 24
      raw[o] = ink ? 50 : 224
      raw[o + 1] = ink ? 50 : 218
      raw[o + 2] = ink ? 50 : 202
      raw[o + 3] = 255
    }
  }
  const { data, grayscale } = cleanRawPixels(raw, width, height, { strength: 0.7, denoise: true, sharpen: true })
  assert.equal(grayscale, true)
  assert.ok(data[0] >= 245 && data[1] >= 245 && data[2] >= 245)
  const inkO = (16 * width + 15) * 4
  assert.ok(data[inkO] <= 20)
  assert.throws(() => cleanRawPixels(new Uint8ClampedArray(10), 4, 4))
})

test("validateRetouchStroke & paintRetouchStrokes support erase mode via destination-out", () => {
  const eraseStroke = validateRetouchStroke({
    mode: "erase",
    size: 0.05,
    opacity: 0.8,
    points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }],
  })
  assert.deepEqual(eraseStroke, {
    mode: "erase",
    size: 0.05,
    opacity: 0.8,
    points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }],
  })

  const env = mockDocument()
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 200
    canvas.height = 200
    const page = {
      image: { naturalWidth: 200, naturalHeight: 200 },
      retouchStrokes: [
        { mode: "paint", size: 0.06, color: "#ffffff", points: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }] },
        eraseStroke,
      ],
    }
    const painted = paintRetouchStrokes(canvas, page)
    assert.equal(painted, true)
    assert.ok(env.ops.some(([op, mode]) => op === "stroke" && mode === "destination-out"))
  } finally {
    env.restore()
  }
})

test("bubbleFit elliptical wrapping, text warp rendering, and projectStyle persistence work cleanly", () => {
  assert.ok(ellipseChordWidth(200, 100, 0) > ellipseChordWidth(200, 100, 40))

  const style = projectStyle({
    size: 28,
    font: "Arial",
    color: "#111111",
    align: "center",
    rotation: 0,
    fill: true,
    bubbleFit: true,
    warp: "arc",
    warpAmount: 25,
  })
  assert.equal(style.bubbleFit, true)
  assert.equal(style.warp, "arc")
  assert.equal(style.warpAmount, 25)

  assert.throws(() => projectStyle({ ...style, warp: "invalidWarp" }))
  assert.throws(() => projectStyle({ ...style, warpAmount: 90 }))

  const env = mockDocument()
  try {
    const page = {
      image: { naturalWidth: 800, naturalHeight: 1200 },
      boxes: [
        {
          id: "b1",
          x: 0.2,
          y: 0.2,
          w: 0.3,
          h: 0.2,
          text: "Đây là đoạn thoại dài trong bong bóng bầu dục manga",
          size: 36,
          font: "Arial",
          color: "#111111",
          align: "center",
          rotation: 0,
          fill: true,
          fillShape: "ellipse",
          bubbleFit: true,
          warp: "wave",
          warpAmount: 20,
        },
      ],
    }
    const fitted = autoFitBox(page, page.boxes[0])
    assert.ok(fitted >= 8 && fitted <= 400)
    assert.equal(textOverflows(page, { ...page.boxes[0], size: fitted }), false)

    const canvas = document.createElement("canvas")
    drawPage(canvas, page)
    // Warped rendering draws glyphs individually with rotations.
    assert.ok(env.ops.filter(([op]) => op === "fillText").length > 5)
    assert.ok(env.ops.filter(([op]) => op === "rotate").length > 5)
  } finally {
    env.restore()
  }
})
