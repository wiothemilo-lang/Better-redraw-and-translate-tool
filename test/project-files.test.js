import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import catalog from "../desktop/recovery-catalog.cjs"
import projectFiles from "../desktop/project-files.cjs"

const { ProjectFiles } = projectFiles

async function shell(folder) {
  const library = new catalog.RecoveryCatalog(folder)
  const files = new ProjectFiles(
    { call: async () => ({ result: { id: "native-reader", size: 32 } }) },
    folder,
    () => ({}),
    { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
    null,
  )
  return { library, files }
}

test("opening a recovery snapshot hands the renderer the project title, not the timestamp file name", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-open-"))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const { library, files } = await shell(folder)
  const id = randomUUID()
  await library.update(id, { title: "Chapter 1", path: "/chapter-1.khungthoai", updatedAt: Date.now() })
  const snapshot = await library.prepare(id)
  await writeFile(snapshot, "snapshot")

  const opened = await files.open({ projectId: id, snapshotId: path.basename(snapshot) })
  assert.equal(opened.title, "Chapter 1")
  assert.equal(opened.projectId, id)
  // The name stays what it always was: the renderer chooses which of the two to show.
  assert.match(opened.name, /^\d+-[0-9a-f-]{36}\.khungthoai$/i)
})

test("a project without a catalogue entry reports no title, so its file name survives", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-open-"))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const { library } = await shell(folder)
  const id = randomUUID()
  assert.equal(await library.title(id), null)
  await library.update(id, { title: "   " })
  assert.equal(await library.title(id), null, "an empty title is no title")
  await library.update(id, { title: "  Chapter 3  " })
  assert.equal(await library.title(id), "Chapter 3")
})
