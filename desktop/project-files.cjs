const { RecoveryCatalog, validId } = require("./recovery-catalog.cjs")
const { stat } = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")

class ProjectFiles {
  constructor(worker, directory, window, dialog, encodePng) {
    this.worker = worker
    this.encodePng = encodePng
    this.dialog = dialog
    this.catalog = new RecoveryCatalog(directory)
    this.activeId = randomUUID()
    this.candidates = new Map()
    this.recovery = path.join(directory, "recovery.khungthoai")
    this.window = window
    this.readers = new Map()
    this.writers = new Map()
    this.projectPath = null
  }

  async status() {
    const exists = async (file) => Boolean(await stat(file).catch(() => null))
    return { recovery: await exists(this.recovery), backup: await exists(this.recovery + ".bak"), projects: (await this.catalog.list()).length }
  }

  async open(mode) {
    let file
    let projectId
    const isRecovery = typeof mode === "object" && Boolean(mode?.snapshotId)
    if (typeof mode === "object" && mode?.projectId) {
      projectId = mode.projectId
      file = await this.catalog.resolve(mode.projectId, mode.snapshotId)
    } else if (mode === "recovery" || mode === "backup") file = this.recovery + (mode === "backup" ? ".bak" : "")
    else {
      const selection = await this.dialog.showOpenDialog(this.window(), {
        filters: [{ name: "Nixio", extensions: ["khungthoai"] }], properties: ["openFile"],
      })
      if (selection.canceled) return null
      file = selection.filePaths[0]
    }
    const { result: info } = await this.worker.call("fileOpen", { path: file })
    const id = randomUUID()
    this.readers.set(id, { nativeId: info.id, size: info.size, offset: 0 })
    if (!isRecovery && !["recovery", "backup"].includes(mode)) this.candidates.set(id, file)
    // A catalogue snapshot is named after its timestamp, so the title the user gave the project
    // travels with the file; without it the renderer would rename the project to that file name.
    const title = projectId ? await this.catalog.title(projectId) : null
    return {
      id, name: path.basename(file), size: info.size, projectId, title,
      recovery: isRecovery || ["recovery", "backup"].includes(mode),
    }
  }

  async read(id) {
    const item = this.readers.get(id)
    if (!item) throw new Error("Phiên đọc dự án đã kết thúc.")
    try {
      const response = await this.worker.call("fileReadNext", { id: item.nativeId })
      if (response.result.size !== item.size) throw new Error("Tệp dự án đã thay đổi trong khi đọc.")
      item.offset += response.data.length
      if (item.offset === item.size) await this.cancelRead(id)
      return response.data
    } catch (error) { await this.cancelRead(id).catch(() => {}); throw error }
  }

  async begin(mode, name, projectId = this.activeId) {
    if (!validId(projectId)) throw new Error("Mã dự án không hợp lệ.")
    const title = String(name || "Nixio").replace(/\.khungthoai$/i, "")
    let file = mode === "autosave" ? await this.catalog.prepare(projectId) : null
    if (!file) {
      const selection = await this.dialog.showSaveDialog(this.window(), {
        defaultPath: mode === "project" && this.projectPath ? this.projectPath : path.basename(String(name || "nixio.khungthoai")),
        filters: [{ name: mode === "zip" ? "ZIP PNG" : "Nixio", extensions: [mode === "zip" ? "zip" : "khungthoai"] }],
      })
      if (selection.canceled) return null
      file = selection.filePath
    }
    const { result } = await this.worker.call(mode === "zip" ? "zipBegin" : "fileBegin", { path: file, backup: mode === "project" })
    const id = randomUUID()
    this.writers.set(id, { nativeId: result.id, file, mode, projectId, title })
    return { id }
  }

  async write(id, operation, options, data) {
    const item = this.writers.get(id)
    if (!item) throw new Error("Phiên ghi tệp đã kết thúc.")
    const allowed = item.mode === "zip" ? ["zipPage", "fileCommit", "fileCancel"] : ["fileAppend", "fileCommit", "fileCancel"]
    if (!allowed.includes(operation)) throw new Error("Thao tác ghi tệp không hợp lệ.")
    if (operation === "zipPage" && this.encodePng) {
      const response = await this.encodePng(options, data)
      data = response.data
      operation = "zipAppend"
    }
    const response = await this.worker.call(operation, { ...options, id: item.nativeId }, data)
    if (operation === "fileCommit" || operation === "fileCancel") {
      this.writers.delete(id)
      if (operation === "fileCommit" && item.mode === "project") this.projectPath = item.file
      if (operation === "fileCommit" && item.mode !== "zip") {
        await this.catalog.committed(item.projectId, item.title, item.mode === "project" ? item.file : null)
      }
    }
    return response.result
  }

  async activate(id, candidate) {
    if (!validId(id)) throw new Error("Mã dự án không hợp lệ.")
    this.activeId = id
    const metadata = await this.catalog.metadata(id)
    this.projectPath = this.candidates.get(candidate) ?? metadata.path
    this.candidates.delete(candidate)
  }

  async cancelAll() {
    for (const id of [...this.writers.keys()]) {
      await this.write(id, "fileCancel").catch(() => {})
      this.writers.delete(id)
    }
    for (const id of [...this.readers.keys()]) await this.cancelRead(id).catch(() => {})
    this.candidates.clear()
  }

  discardOpen(id) { this.candidates.delete(id) }

  async cancelRead(id) {
    const item = this.readers.get(id)
    this.readers.delete(id)
    if (item) await this.worker.call("fileClose", { id: item.nativeId })
  }
}
module.exports = { ProjectFiles }
