import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  duplicatePage,
  moveSelectedPages,
  pageIndex,
  pageRangeIds,
  rangeAnchorId,
  selectAllPageIds,
  selectedPages,
  togglePageId,
} from "../src/page-selection.js"

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
const shortcuts = await readFile(new URL("../src/controllers/shortcuts.js", import.meta.url), "utf8")
const translation = await readFile(new URL("../src/controllers/translation.js", import.meta.url), "utf8")
const exports = await readFile(new URL("../src/controllers/export.js", import.meta.url), "utf8")

const pages = (...names) => names.map((name, index) => ({ id: `p${index + 1}`, name }))
const ids = (list) => list.map((page) => page.id)

test("pageRangeIds selects the inclusive chapter-order range between two pages (#74)", () => {
  const list = pages("a", "b", "c", "d", "e")
  assert.deepEqual(pageRangeIds(list, "p2", "p4"), ["p2", "p3", "p4"])
  assert.deepEqual(pageRangeIds(list, "p4", "p2"), ["p2", "p3", "p4"], "a backwards shift-click selects the same range")
  assert.deepEqual(pageRangeIds(list, "p3", "p3"), ["p3"])
  assert.deepEqual(pageRangeIds(list, "p1", "p5"), ids(list))
  assert.deepEqual(pageRangeIds(list, "missing", "p2"), [])
  assert.deepEqual(pageRangeIds(list, "p2", null), [])
})

test("rangeAnchorId falls back to the primary page, then the chapter start (#74)", () => {
  const list = pages("a", "b", "c")
  assert.equal(rangeAnchorId(list, "p2", "p1"), "p2")
  assert.equal(rangeAnchorId(list, "gone", "p3"), "p3")
  assert.equal(rangeAnchorId(list, "gone", "also-gone"), "p1")
  assert.equal(rangeAnchorId([], "gone", "gone"), null)
})

test("togglePageId adds and removes one id without touching the rest (#74)", () => {
  let set = new Set(["p1", "p3"])
  set = togglePageId(set, "p2")
  assert.deepEqual([...set].sort(), ["p1", "p2", "p3"])
  set = togglePageId(set, "p1")
  assert.deepEqual([...set].sort(), ["p2", "p3"])
  assert.deepEqual([...togglePageId(undefined, "p1")], ["p1"])
})

test("selectedPages always acts in chapter order and drops ids that left the chapter (#74)", () => {
  const list = pages("a", "b", "c", "d")
  assert.deepEqual(ids(selectedPages(list, new Set(["p4", "p2"]))), ["p2", "p4"])
  assert.deepEqual(ids(selectedPages(list, new Set(["p2", "gone"]))), ["p2"])
  assert.deepEqual(selectedPages(list, null), [])
  assert.deepEqual(ids(selectedPages(list, selectAllPageIds(list))), ids(list))
})

test("moveSelectedPages shifts a contiguous block one slot per call (#74)", () => {
  const list = pages("a", "b", "c", "d", "e")
  const selected = new Set(["p2", "p3"])
  assert.deepEqual(ids(moveSelectedPages(list, selected, -1)), ["p2", "p3", "p1", "p4", "p5"], "the block moves up as one")
  assert.deepEqual(ids(moveSelectedPages(list, selected, 1)), ["p1", "p4", "p2", "p3", "p5"], "the block moves down as one")
  assert.equal(moveSelectedPages(list, new Set(["p1"]), -1), null, "the top page cannot move up")
  assert.equal(moveSelectedPages(list, new Set(["p5"]), 1), null, "the bottom page cannot move down")
  assert.equal(moveSelectedPages(list, new Set(), 1), null)
  assert.equal(moveSelectedPages(list, selected, 0), null)
})

test("moveSelectedPages bubbles scattered picks past unselected neighbours (#74)", () => {
  const list = pages("a", "b", "c", "d")
  const selected = new Set(["p1", "p3"])
  assert.deepEqual(ids(moveSelectedPages(list, selected, 1)), ["p2", "p1", "p4", "p3"])
  assert.deepEqual(ids(moveSelectedPages(list, selected, -1)), ["p1", "p3", "p2", "p4"])
})

test("duplicatePage copies content with fresh ids and shares the image assets (#74)", () => {
  const image = { naturalWidth: 10 }
  const page = {
    id: "p1",
    name: "01.png",
    image,
    file: { name: "01.png" },
    url: "blob:one",
    boxes: [{ id: "b1", text: "Xin chào", cleanupRect: { x: 0 } }],
    unplaced: [{ source: "s", text: "t" }],
    retouchStrokes: [{ mode: "paint", points: [[0, 0]] }],
    translationJob: { kind: "translate", state: "done" },
  }
  let n = 0
  const copy = duplicatePage(page, () => `new-${++n}`)
  assert.equal(copy.id, "new-1")
  assert.equal(copy.name, "01.png (bản sao)")
  assert.equal(copy.image, image)
  assert.equal(copy.file, page.file)
  assert.equal(copy.url, "blob:one")
  assert.notEqual(copy.boxes, page.boxes)
  assert.equal(copy.boxes[0].id, "new-2")
  assert.equal(copy.boxes[0].text, "Xin chào")
  assert.notEqual(copy.boxes[0].cleanupRect, page.boxes[0].cleanupRect)
  assert.deepEqual(copy.unplaced, page.unplaced)
  assert.notEqual(copy.unplaced, page.unplaced)
  assert.deepEqual(copy.retouchStrokes, page.retouchStrokes)
  assert.notEqual(copy.retouchStrokes, page.retouchStrokes)
  assert.deepEqual(copy.translationJob, page.translationJob)
  assert.equal(page.boxes[0].id, "b1", "the original keeps its ids")
})

test("duplicating a raw-cleaned page keeps the untouched scan instead of cloning it (#review)", () => {
  // A raw cleanup keeps the scan it replaced beside the new image. That scan is an
  // HTMLImageElement, which structuredClone refuses, so the copy has to share it.
  const originalImage = { naturalWidth: 10, tagName: "IMG" }
  const page = {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 10 },
    file: { name: "01.png" },
    url: "blob:clean",
    originalImage,
    originalFile: { name: "01-raw.png" },
    originalUrl: "blob:raw",
    boxes: [{ id: "b1", text: "Xin chào" }],
  }
  let n = 0
  const copy = duplicatePage(page, () => `new-${++n}`)
  assert.equal(copy.originalImage, originalImage)
  assert.equal(copy.originalFile, page.originalFile)
  assert.equal(copy.originalUrl, "blob:raw")
  assert.equal(copy.url, "blob:clean")
  assert.notEqual(copy.boxes, page.boxes)
  assert.equal(copy.boxes[0].id, "new-2")
  // A page that was never raw-cleaned carries none of the three.
  const plain = duplicatePage({ id: "p2", name: "02.png", url: "blob:two", boxes: [] }, () => "id")
  assert.equal("originalImage" in plain, false)
  assert.equal("originalFile" in plain, false)
})

test("the page list offers an additive checkbox and a bulk bar wired to the selection (#74)", () => {
  assert.match(main, /selectedPageIds: new Set\(\)/)
  assert.match(main, /check\.type = "checkbox"/)
  assert.match(main, /check\.onchange = \(\) => togglePageSelection\(page\)/)
  assert.match(main, /pageNameClick\(page, event\)/)
  assert.match(main, /event\.ctrlKey \|\| event\.metaKey\) return togglePageSelection\(page\)/)
  assert.match(main, /event\.shiftKey\) return shiftSelectPage\(page\)/)
  assert.match(main, /state\.selectedPageIds\.clear\(\)/)
  for (const id of ["page-bulk-bar", "page-bulk-count", "bulk-translate", "bulk-duplicate", "bulk-move-up", "bulk-move-down", "bulk-export", "bulk-delete", "bulk-select-all", "bulk-clear"]) {
    assert.match(markup, new RegExp(`id="${id}"`), `index.html must keep #${id}`)
  }
})

test("bulk actions refuse while a task runs and record one checkpoint each (#74)", () => {
  const body = main.slice(main.indexOf("function refuseWhileBusy("), main.indexOf("function projectBusy("))
  assert.match(body, /projectBusy\(\)/)
  assert.match(body, /Hãy chờ tác vụ/)
  for (const name of ["removeSelectedPages", "duplicateSelectedPages", "moveSelectedPagesBy"]) {
    const start = main.indexOf(`function ${name}(`)
    assert.ok(start > 0, `${name} must exist`)
    assert.match(main.slice(start, start + 400), /refuseWhileBusy\(\)/, `${name} must refuse while busy`)
  }
  assert.match(main, /checkpoint\(undefined, \{ label: `Bỏ \$\{pages\.length\} trang`/)
  assert.match(main, /checkpoint\(undefined, \{ label: `Nhân bản \$\{pages\.length\} trang`/)
  assert.match(main, /kind: "page"/)
})

test("keyboard support: Space toggles the focused page, Escape clears, Ctrl+A selects all (#74)", () => {
  assert.match(main, /event\.key !== " " \|\| event\.repeat\) return/)
  assert.match(main, /closest\?\.\(".page-name"\)/)
  assert.match(main, /togglePageSelection\(page\)/)
  assert.match(shortcuts, /pageSelection\?\.count\(\) > 0/)
  assert.match(shortcuts, /pageSelection\.clear\(\)/)
  assert.match(shortcuts, /key === "a" && pageSelection\?\.owns\?\.\(event\.target\)/)
  assert.match(shortcuts, /pageSelection\.selectAll\(\)/)
  assert.match(main, /owns: \(target\) => Boolean\(target\?\.closest\?\.\("#pages"\)\)/)
})

test("bulk translate and export reuse the existing page-array paths (#74)", () => {
  assert.match(translation, /function translatePages\(pages\) \{\s*return processPages\(pages \?\? \[\], imageTranslator, "dịch"\)/)
  assert.match(translation, /translatePages \}/)
  assert.match(exports, /function openZipExport\(pages = null\)/)
  assert.match(exports, /zipPages = pages \? \[\.\.\.pages\] : null/)
  assert.match(exports, /const pages = zipPages \?\? state\.pages/)
  assert.match(exports, /id="zip-name"|byId\("zip-name"\)/)
  assert.match(exports, /return \{ openZipExport, syncProfileSummary \}/)
  assert.match(main, /translation\.translatePages\(selectedPagesInOrder\(\)\)/)
  assert.match(main, /exportUi\.openZipExport\(selectedPagesInOrder\(\)\)/)
  assert.match(main, /syncExportProfileSummary = exportUi\.syncProfileSummary/)
  assert.match(main, /syncExportProfileSummary\(\)/)
})
