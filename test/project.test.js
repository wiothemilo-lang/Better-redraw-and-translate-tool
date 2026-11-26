import assert from "node:assert/strict"
import test from "node:test"
import { readProject, writeProject } from "../src/project.js"

function sampleProject() {
  const rect = { x: .1, y: .2, w: .5, h: .3 }
  return {
    pages: [
      {
        file: new File([Uint8Array.of(1, 2, 3)], "trang trùng tên.png"),
        name: "trang trùng tên.png",
        boxes: [{
          ...rect, text: "Chào bạn!\nHẹn gặp lại.", size: 24, font: "Georgia", color: "#102030",
          align: "right", rotation: -30, fill: false, cleanup: true,
          originalBox: { ...rect, x: 0 },
        }],
        unplaced: [{ id: "B2", text: "Chưa đặt", source: "未配置", box: null }],
        translationContext: { signature: "settings", lines: [{ source: "未配置", text: "Chưa đặt" }] },
      },
      {
        file: new File([Uint8Array.of(4, 5)], "trang trùng tên.png", { type: "image/webp" }),
        name: "trang trùng tên.png", boxes: [], unplaced: [],
      },
    ],
    queue: ["Không tìm được trang"],
    settings: {
      "script-text": "Trang 1\nChào bạn!",
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Japanese",
      "target-language": "Vietnamese",
      "translation-notes": "Giữ nguyên tên riêng",
      "translation-glossary": "",
      "gemini-key": "never-store-this-key",
    },
    currentPage: 1,
    fit: false,
  }
}

test("project round-trip keeps edit state and original bytes in page order without saving the API key", async () => {
  const project = sampleProject()
  const file = writeProject(project)
  assert.ok(!(await file.text()).includes(project.settings["gemini-key"]))
  const opened = await readProject(file)
  const { "gemini-key": unused, ...settings } = project.settings
  assert.deepEqual(opened.settings, settings)
  assert.deepEqual(opened.queue, project.queue)
  assert.equal(opened.currentPage, 1)
  assert.equal(opened.fit, false)
  assert.deepEqual(opened.pages[0].boxes, project.pages[0].boxes)
  assert.deepEqual(opened.pages[0].unplaced, project.pages[0].unplaced)
  assert.deepEqual(opened.pages[0].translationContext, project.pages[0].translationContext)
  for (const [index, page] of opened.pages.entries()) {
    assert.equal(page.file.name, project.pages[index].file.name)
    assert.equal(page.file.type, index === 0 ? "image/png" : "image/webp")
    assert.deepEqual(await page.file.bytes(), await project.pages[index].file.bytes())
  }
})

test("a script-only project round-trips without a selected page", async () => {
  const project = { ...sampleProject(), pages: [], currentPage: -1 }
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages, [])
  assert.equal(opened.currentPage, -1)
  assert.equal(opened.settings["script-text"], project.settings["script-text"])
})

test("project reader rejects unknown versions, malformed metadata and incomplete image payloads", async () => {
  const file = writeProject(sampleProject())
  const source = await file.text()
  await assert.rejects(readProject(new Blob([source.replace('"version":2', '"version":9')])), /Phiên bản/)
  await assert.rejects(readProject(new Blob([source.replace('"currentPage":1', '"currentPage":2')])), /không hợp lệ/)
  await assert.rejects(readProject(new Blob([source.replace('"rotation":-30', '"rotation":999')])), /không hợp lệ/)
  await assert.rejects(readProject(file.slice(0, -1)), /không hợp lệ/)
  await assert.rejects(readProject(new Blob([file, "trailing bytes"])), /không hợp lệ/)
  await assert.rejects(readProject(new Blob(["not a project"])), /không hợp lệ/)
})

test("version 2 persists independent cleanup strokes, presets and interrupted translation jobs", async () => {
  const project = sampleProject()
  const box = project.pages[0].boxes[0]
  box.cleanupRect = { x: .2, y: .2, w: .3, h: .4 }
  box.cleanupExpand = -2
  box.cleanupStrokes = [{ mode: "erase", size: .05, points: [{ x: .25, y: .3 }, { x: .3, y: .35 }] }]
  project.presets = [{ name: "Thoại", style: { size: box.size, font: box.font, color: box.color, align: box.align, rotation: box.rotation, fill: box.fill } }]
  project.pages[0].translationJob = { kind: "translate", signature: "saved", state: "running" }
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages[0].boxes[0], box)
  assert.deepEqual(opened.presets, project.presets)
  assert.equal(opened.pages[0].translationJob.state, "pending")
})

test("version 1 projects open with empty presets and glossary", async () => {
  const project = sampleProject()
  const file = writeProject(project)
  const headerSize = 15
  const length = new DataView(await file.slice(0, headerSize).arrayBuffer()).getUint32(11, true)
  const metadata = JSON.parse(await file.slice(headerSize, headerSize + length).text())
  metadata.version = 1
  delete metadata.presets
  delete metadata.settings["translation-glossary"]
  const manifest = new TextEncoder().encode(JSON.stringify(metadata))
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  new DataView(header.buffer).setUint32(11, manifest.length, true)
  const oldFile = new Blob([header, manifest, file.slice(headerSize + length)])
  const opened = await readProject(oldFile)
  assert.equal(opened.settings["translation-glossary"], "")
  assert.deepEqual(opened.presets, [])
  assert.equal(opened.pages[0].boxes[0].text, project.pages[0].boxes[0].text)
})

test("invalid masks and preset styles cannot be saved", () => {
  const project = sampleProject()
  project.pages[0].boxes[0].cleanupStrokes = [{ mode: "erase", size: .1, points: [] }]
  assert.throws(() => writeProject(project), /không hợp lệ/)
  delete project.pages[0].boxes[0].cleanupStrokes
  project.presets = [{ name: "Broken", style: { ...project.pages[0].boxes[0], size: -2 } }]
  assert.throws(() => writeProject(project), /không hợp lệ/)
})

test("version 2 persists rich typography styles, shadow, custom font names and retouch strokes", async () => {
  const project = sampleProject()
  Object.assign(project.pages[0].boxes[0], {
    font: "Comic Neue",
    bold: true,
    italic: true,
    uppercase: true,
    vertical: true,
    lineHeight: 1.4,
    strokeWidth: 3,
    strokeColor: "#00ffaa",
    shadowBlur: 6,
    shadowColor: "#222222",
    fillColor: "#111111",
    fillShape: "ellipse",
  })
  project.pages[0].retouchStrokes = [
    { mode: "paint", size: .04, color: "#eeeeee", opacity: .8, points: [{ x: .1, y: .1 }, { x: .2, y: .2 }] },
    { mode: "clone", size: .06, offsetX: -.05, offsetY: .05, points: [{ x: .4, y: .4 }] },
    { mode: "inpaint", size: .05, points: [{ x: .5, y: .5 }, { x: .55, y: .52 }] },
  ]
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages[0].boxes[0], project.pages[0].boxes[0])
  assert.deepEqual(opened.pages[0].retouchStrokes, project.pages[0].retouchStrokes)
})

test("portable projects retain their recovery identity while older projects can omit it", async () => {
  const project = sampleProject()
  project.projectId = "d26b25ce-44de-4fcb-a04a-9c63d471527a"
  assert.equal((await readProject(writeProject(project))).projectId, project.projectId)
  project.projectId = "../escape"
  assert.throws(() => writeProject(project), /không hợp lệ/)
})
