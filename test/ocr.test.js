import test from "node:test"
import assert from "node:assert/strict"
import { groupOcrLines, mapOcrBox } from "../src/ocr.js"

test("crop-relative boxes map back to original page coordinates", () => {
  assert.deepEqual(mapOcrBox([0, 0, 1000, 1000], { left: 100, top: 200, width: 300, height: 400 }, { naturalWidth: 1000, naturalHeight: 2000 }), [100, 100, 400, 300])
})

test("nearby dialogue lines group while separate balloons stay separate", () => {
  const lines = [
    { text: "Hello", box: [100, 100, 300, 140], confidence: 90 },
    { text: "world", box: [120, 150, 280, 190], confidence: 85 },
    { text: "Separate", box: [600, 700, 900, 740], confidence: 88 },
  ]
  const groups = groupOcrLines(lines)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].text, "Hello\nworld")
  assert.deepEqual(groups[0].box, [100, 100, 300, 190])
  assert.equal(groupOcrLines(lines, { group: false }).length, 3)
})

test("vertical dialogue is grouped in right-to-left column order", () => {
  const lines = [
    { text: "左", box: [440, 100, 480, 350] },
    { text: "右", box: [500, 100, 540, 350] },
  ]
  assert.equal(groupOcrLines(lines, { vertical: true })[0].text, "右\n左")
})
