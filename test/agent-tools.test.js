import assert from "node:assert/strict"
import test from "node:test"
import { createAgentTools } from "../src/agent-tools.js"

function setup({ pages, selected = 0 } = {}) {
  const state = {
    pages,
    presets: [],
    pageId: pages[selected].id,
    boxId: null,
    selectedBoxIds: new Set(),
    queue: [],
  }
  let boxSeq = 0
  const tools = createAgentTools({
    state,
    byId: () => null,
    selectedPage: () => state.pages.find((page) => page.id === state.pageId) ?? null,
    selectedIndex: () => state.pages.findIndex((page) => page.id === state.pageId),
    // The editor's selectPage drops the box selection, exactly like main.js.
    selectPage: (page) => {
      state.pageId = page.id
      state.boxId = null
      state.selectedBoxIds.clear()
    },
    checkpoint: () => {},
    render: () => {},
    readTranslationSettings: () => ({ source: "Japanese", target: "Vietnamese", glossary: "" }),
    textOverflowsFn: () => false,
    makeBoxFn: (_page, rect, text) => box(`new-${++boxSeq}`, text, rect),
  })
  return { state, tools }
}

const page = (id, boxes = [], unplaced = []) => ({
  id,
  name: `${id}.png`,
  image: { naturalWidth: 800, naturalHeight: 1200 },
  boxes,
  unplaced,
})

const box = (id, text, extra = {}) => ({
  id, text, x: .1, y: .1, w: .2, h: .1, size: 24, font: "Arial", color: "#000000", align: "center", ...extra,
})

test("search_chapter_text reports 1-based page numbers like every other tool", async () => {
  const { tools } = setup({
    pages: [page("p1", [box("b1", "Tạm biệt")]), page("p2", [box("b2", "Chào nhé")]), page("p3", [box("b3", "Chào lần nữa")])],
  })

  const res = await tools.execute("search_chapter_text", { query: "Chào" })
  assert.equal(res.ok, true)
  assert.deepEqual(res.data.matches.map((match) => match.pageIndex), [2, 3])
  assert.deepEqual(res.data.matches.map((match) => match.pageName), ["p2.png", "p3.png"])

  // The page number also has to line up with what navigate_page and list_boxes call the same page.
  const navigation = await tools.execute("navigate_page", { pageIndex: res.data.matches[0].pageIndex })
  assert.equal(navigation.data.pageName, res.data.matches[0].pageName)
})

test("a page-scoped preflight and QA scan report the page's real number and reject a page that is not there", async () => {
  const { tools } = setup({
    pages: [
      page("p1", [box("b1", "Trang một ổn")]),
      // An empty box is what lintChapter reports as empty_or_placeholder.
      page("p2", [box("b2", "   ")]),
    ],
  })

  for (const name of ["check_export_preflight", "lint_chapter_qa"]) {
    const scoped = await tools.execute(name, { pageIndex: 2 })
    assert.equal(scoped.ok, true, name)
    const issues = scoped.data.issues
    assert.ok(issues.length, `${name} should report the empty box`)
    assert.deepEqual([...new Set(issues.map((issue) => issue.pageIndex))], [2], name)
    assert.deepEqual([...new Set(issues.map((issue) => issue.pageName))], ["p2.png"], name)

    // A page that does not exist is an error, never an "empty project" answer.
    const outOfRange = await tools.execute(name, { pageIndex: 99 })
    assert.equal(outOfRange.ok, false, name)
    assert.match(outOfRange.error, /Không tồn tại trang số 99/, name)
  }

  // The full-chapter scan keeps numbering from the start and still sees both pages.
  const whole = await tools.execute("lint_chapter_qa", {})
  assert.equal(whole.ok, true)
  assert.deepEqual([...new Set(whole.data.issues.map((issue) => issue.pageIndex))], [2])
})

test("create_box on another page moves the editor there and keeps the new box reachable", async () => {
  const { state, tools } = setup({ pages: [page("p1", [box("b1", "Trang một")]), page("p2", [])] })

  const created = await tools.execute("create_box", { text: "X", pageIndex: 2 }, { allowEdits: true })
  assert.equal(created.ok, true)
  assert.equal(created.data.pageIndex, 2)
  assert.equal(created.data.pageName, "p2.png")
  assert.equal(state.pageId, "p2", "the editor must show the page the box was created on")
  assert.equal(state.boxId, created.data.id)
  assert.deepEqual([...state.selectedBoxIds], [created.data.id])
  assert.equal(state.pages[1].boxes.length, 1)

  // The model can keep editing the box it just made instead of losing its id.
  const updated = await tools.execute("update_box", { boxId: created.data.id, text: "Y" }, { allowEdits: true })
  assert.equal(updated.ok, true)
  assert.equal(state.pages[1].boxes[0].text, "Y")
})

test("update_box and delete_box reach a box that lives on another page", async () => {
  const { state, tools } = setup({
    pages: [page("p1", [box("b1", "Trang một")]), page("p2", [box("b2", "Trang hai")])],
  })

  const updated = await tools.execute("update_box", { boxId: "b2", text: "Sửa từ xa" }, { allowEdits: true })
  assert.equal(updated.ok, true)
  assert.equal(state.pages[1].boxes[0].text, "Sửa từ xa")

  const deleted = await tools.execute("delete_box", { boxId: "b2" }, { allowEdits: true })
  assert.equal(deleted.ok, true)
  assert.equal(state.pages[1].boxes.length, 0)

  const missing = await tools.execute("update_box", { boxId: "nope", text: "x" }, { allowEdits: true })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Không tìm thấy khung thoại/)
})
