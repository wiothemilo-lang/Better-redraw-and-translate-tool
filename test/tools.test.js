import assert from "node:assert/strict"
import test from "node:test"
import { groupDialogue } from "../src/io.js"
import {
  alignBoxes,
  distributeBoxes,
  duplicateBox,
  exportDialogueScript,
  findMatches,
  fitBoxFontSize,
  nudgeBox,
  reorderBox,
  replaceMatches,
  resizeBox,
  rotateBox,
  snapBox,
} from "../src/tools.js"

function assertRectClose(actual, expected) {
  for (const key of ["x", "y", "w", "h"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} !== ${expected[key]}`)
  }
}

test("resizeBox resizes all 8 handles while respecting bounds and minimum dimensions", () => {
  const start = { x: .2, y: .2, w: .4, h: .3 }
  assertRectClose(resizeBox(start, "se", { x: .1, y: .1 }), { x: .2, y: .2, w: .5, h: .4 })
  assertRectClose(resizeBox(start, "nw", { x: -.1, y: -.1 }), { x: .1, y: .1, w: .5, h: .4 })
  const shrunk = resizeBox(start, "w", { x: .9, y: 0 })
  assert.ok(Math.abs(shrunk.w - .03) < 1e-9)
  assert.ok(Math.abs(shrunk.x - .57) < 1e-9)
  const clamped = resizeBox(start, "ne", { x: 2, y: -2 })
  assert.equal(clamped.y, 0)
  assert.ok(clamped.x + clamped.w <= 1)
  const floatEdge = resizeBox({ x: 1 / 3, y: 1 / 7, w: .4, h: .4 }, "se", { x: 2, y: 2 })
  assert.ok(floatEdge.x + floatEdge.w <= 1)
  assert.ok(floatEdge.y + floatEdge.h <= 1)
})

test("rotateBox calculates angles and snaps to 15-degree increments when requested", () => {
  const center = { x: .5, y: .5 }
  assert.equal(rotateBox(center, { x: .5, y: .2 }), 0)
  assert.equal(rotateBox(center, { x: .8, y: .5 }), 90)
  assert.equal(rotateBox(center, { x: .2, y: .5 }), -90)
  assert.equal(rotateBox(center, { x: .6, y: .25 }, { snap: true }), 15)
})

test("nudgeBox, duplicateBox and reorderBox manipulate box positions and Z-order safely", () => {
  const box = { id: "a", x: .9, y: .9, w: .2, h: .2, text: "Hi", cleanup: true, originalBox: { x: .1, y: .1, w: .2, h: .2 } }
  assert.deepEqual(nudgeBox(box, .5, -1), { x: .8, y: 0 })
  const copy = duplicateBox(box, "b")
  assert.equal(copy.id, "b")
  assert.equal(copy.cleanup, false)
  assert.equal(copy.originalBox, undefined)
  assert.equal(copy.x, .8)

  const list = [{ id: "1" }, { id: "2" }, { id: "3" }]
  const moved = reorderBox(list, "2", 1)
  assert.equal(moved.moved, true)
  assert.deepEqual(moved.boxes.map(({ id }) => id), ["1", "3", "2"])
  assert.equal(reorderBox(list, "1", -1).moved, false)
})

test("fitBoxFontSize binary-searches the largest fitting font size", () => {
  const size = fitBoxFontSize({}, { text: "Hello" }, (_page, candidate) => candidate.size > 37)
  assert.equal(size, 37)
  assert.equal(fitBoxFontSize({}, { text: "Too big" }, () => true, { min: 10, max: 50 }), 10)
  assert.equal(fitBoxFontSize({}, { text: "Tiny" }, () => false, { min: 10, max: 50 }), 50)
})

test("findMatches and replaceMatches handle Unicode, regex characters, whole-word and unplaced lines", () => {
  const pages = [
    {
      id: "p1", name: "01.png",
      boxes: [{ id: "b1", text: "Anh ấy nói: anh khỏe không?!" }],
      unplaced: [{ id: "u1", text: "Anh trai ơi?!" }],
    },
  ]
  const ciMatches = findMatches(pages, "anh", { caseSensitive: false, wholeWord: true })
  assert.equal(ciMatches.length, 1)
  assert.equal(ciMatches[0].count, 2)

  const withUnplaced = findMatches(pages, "?!", { includeUnplaced: true })
  assert.equal(withUnplaced.length, 2)

  const { replacedItems, replacedOccurrences, skippedEmpty } = replaceMatches(pages, "anh", "cậu", { wholeWord: true, includeUnplaced: true })
  assert.equal(replacedItems, 2)
  assert.equal(replacedOccurrences, 3)
  assert.equal(skippedEmpty, 0)
  assert.equal(pages[0].boxes[0].text, "cậu ấy nói: cậu khỏe không?!")
  assert.equal(pages[0].unplaced[0].text, "cậu trai ơi?!")

  const emptyGuardPages = [{ id: "p2", name: "02.png", boxes: [{ id: "b2", text: "Chỉ có chữ này" }, { id: "b3", text: "Chỉ có chữ này thêm" }], unplaced: [] }]
  const guarded = replaceMatches(emptyGuardPages, "Chỉ có chữ này", "   ")
  assert.equal(guarded.skippedEmpty, 1)
  assert.equal(guarded.replacedItems, 1)
  assert.equal(emptyGuardPages[0].boxes[0].text, "Chỉ có chữ này")
  assert.equal(emptyGuardPages[0].boxes[1].text, "    thêm")
})

test("exportDialogueScript outputs valid TXT, CSV and JSON formats", () => {
  const pages = [
    { name: "01.png", boxes: [{ text: 'Nói "xin chào",\nbạn nhé!', x: .1, y: .1, w: .3, h: .2, font: "Arial", size: 20, color: "#000000", align: "center", rotation: 0 }], unplaced: [{ text: "Chờ" }] },
    { name: "02.png", boxes: [{ text: "Trang hai", x: .2, y: .2, w: .3, h: .2, font: "Arial", size: 20, color: "#000000", align: "center", rotation: 0 }], unplaced: [] },
  ]
  const txt = exportDialogueScript(pages, "txt")
  assert.deepEqual(groupDialogue(txt), [
    { reference: 0, lines: ['Nói "xin chào", bạn nhé!'] },
    { reference: 1, lines: ["Trang hai"] },
  ])
  const csv = exportDialogueScript(pages, "csv")
  assert.ok(csv.startsWith("\uFEFFPage,File,Box,Text\r\n"))
  assert.ok(csv.includes('1,01.png,1,"Nói ""xin chào"",\nbạn nhé!"'))
  const json = JSON.parse(exportDialogueScript(pages, "json"))
  assert.equal(json.pages.length, 2)
  assert.deepEqual(json.pages[0].unplaced, ["Chờ"])
})

test("resizeBox projects pointer deltas into local frame for rotated boxes", () => {
  const start = { x: .3, y: .3, w: .2, h: .1 }
  // Rotated 90 deg clockwise: local +x (east handle) points downward (+y in page coords).
  const grown = resizeBox(start, "e", { x: 0, y: .1 }, { rotation: 90, aspect: 1 })
  assert.ok(Math.abs(grown.w - .3) < 1e-9)
  assert.ok(Math.abs(grown.h - .1) < 1e-9)
  // Center moved +0.05 downward while keeping the west (top) edge anchored at y = 0.25.
  assert.ok(Math.abs((grown.y + grown.h / 2) - .4) < 1e-9)
  assert.ok(Math.abs((grown.x + grown.w / 2) - .4) < 1e-9)

  // Non-square page (aspect = 0.5) rotated 90 deg: dragging east handle down by dy=0.1
  // increases local width in y-units by 0.1, which is 0.2 in normalized x-units!
  const aspectGrown = resizeBox({ x: .4, y: .4, w: .2, h: .1 }, "e", { x: 0, y: .1 }, { rotation: 90, aspect: .5 })
  assert.ok(Math.abs(aspectGrown.w - .4) < 1e-9)
  assert.ok(Math.abs(aspectGrown.h - .1) < 1e-9)
})

test("snapBox snaps box edges and centers to page center and neighbor boxes", () => {
  const others = [{ x: .1, y: .15, w: .15, h: .1 }]
  // Near page center x = 0.5 (box center at 0.504).
  const centerSnap = snapBox({ x: .404, y: .6, w: .2, h: .1 }, others, { thresholdX: .01, thresholdY: .01 })
  assert.ok(Math.abs(centerSnap.x - .4) < 1e-9)
  assert.deepEqual(centerSnap.guides, [{ axis: "x", pos: .5 }])

  // Near neighbor left edge (0.1) and bottom edge (0.25).
  const edgeSnap = snapBox({ x: .105, y: .254, w: .15, h: .1 }, others, { thresholdX: .01, thresholdY: .01 })
  assert.ok(Math.abs(edgeSnap.x - .1) < 1e-9)
  assert.ok(Math.abs(edgeSnap.y - .25) < 1e-9)
  assert.equal(edgeSnap.guides.length, 2)
})

test("alignBoxes and distributeBoxes align and evenly space multi-selected boxes", () => {
  const boxes = [
    { id: "a", x: .1, y: .1, w: .1, h: .1 },
    { id: "b", x: .3, y: .3, w: .2, h: .1 },
    { id: "c", x: .7, y: .5, w: .1, h: .2 },
  ]
  assert.equal(alignBoxes(boxes, ["a", "b"], "left"), true)
  assert.equal(boxes[0].x, .1)
  assert.equal(boxes[1].x, .1)

  assert.equal(alignBoxes(boxes, ["a", "c"], "bottom"), true)
  assert.ok(Math.abs(boxes[0].y - .6) < 1e-9)

  // Reset positions for horizontal distribution: span 0.1..0.8 (0.7), total widths = 0.4, gap = 0.15.
  boxes[0].x = .1; boxes[1].x = .25; boxes[2].x = .7
  assert.equal(distributeBoxes(boxes, ["a", "b", "c"], "horizontal"), true)
  assert.ok(Math.abs(boxes[1].x - .35) < 1e-9)

  // Vertical distribution: span 0.1..0.8 (0.7), total heights = 0.4, gap = 0.15.
  boxes[0].y = .1; boxes[1].y = .15; boxes[2].y = .6
  assert.equal(distributeBoxes(boxes, ["a", "b", "c"], "vertical"), true)
  assert.ok(Math.abs(boxes[1].y - .35) < 1e-9)
})
