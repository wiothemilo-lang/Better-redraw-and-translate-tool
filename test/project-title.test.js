import assert from "node:assert/strict"
import test from "node:test"
import { createHarness, settingIds } from "../scripts/lib/autosave-harness.mjs"

const harness = createHarness({ capabilities: null })
const { setupProjects } = await import("../src/controllers/project.js")
const { writeProject } = await import("../src/project.js")

function settings() {
  return Object.fromEntries(settingIds.map((id) => [id, ""]).concat([
    ["direction", "ltr"],
    ["gemini-model", "auto"],
    ["source-language", "Japanese"],
    ["target-language", "Vietnamese"],
  ]))
}

function projectBlob() {
  return writeProject({
    pages: [{
      file: new File([Uint8Array.of(1, 2, 3)], "trang-1.png", { type: "image/png" }),
      name: "trang-1.png",
      boxes: [],
      unplaced: [],
    }],
    queue: [],
    settings: settings(),
    currentPage: 0,
    fit: true,
  })
}

const snapshotName = "1764000000000-6f1e0c0d-7f26-4f0d-9a0f-0e0a2f8f1b2c.khungthoai"

test("restoring a timestamped snapshot keeps the project's own title", async () => {
  harness.reset()
  harness.start(setupProjects)

  // What the desktop shell hands over after reading the recovery catalogue: a file named after the
  // moment it was written, next to the title the user gave the project.
  const snapshot = new File([projectBlob()], snapshotName, { type: "application/octet-stream" })
  snapshot.projectTitle = "Chapter 1"
  const input = harness.byId("project-file")
  input.files = [snapshot]
  await input.onchange()
  await harness.drive(() => harness.pending() === 0)
  assert.equal(harness.lastStatus().text, "Đã mở dự án với 1 trang.")

  // "Lưu dự án" suggests the project's name, not the snapshot file name.
  await harness.byId("save-project").onclick()
  await harness.drive(() => harness.pending() === 0)
  const message = harness.notifications.at(-1)?.message ?? ""
  assert.match(message, /Chapter 1\.khungthoai/)
  assert.doesNotMatch(message, /1764000000000/)
  assert.match(harness.byId("project-dirty").textContent, /^Chapter 1 · /)
})

test("a project file with no catalogue title keeps its file name", async () => {
  harness.reset()
  harness.start(setupProjects)

  const plain = new File([projectBlob()], "Chapter 2.khungthoai", { type: "application/octet-stream" })
  const input = harness.byId("project-file")
  input.files = [plain]
  await input.onchange()
  await harness.drive(() => harness.pending() === 0)

  await harness.byId("save-project").onclick()
  await harness.drive(() => harness.pending() === 0)
  assert.match(harness.notifications.at(-1)?.message ?? "", /Chapter 2\.khungthoai/)
})
