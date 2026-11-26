const { dialog } = require("electron")
const { stat } = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")

class ProjectFiles {
  constructor(worker, directory, window) {
    this.worker = worker
    this.recovery = path.join(directory, "recovery.khungthoai")
    this.window = window
    this.readers = new Map()
    this.writers = new Map()
    this.projectPath = null
  }

  async status() {
    const exists = async (file) => Boolean(await stat(file).catch(() => null))
    return { recovery: await exists(this.recovery), backup: await exists(this.recovery + ".bak") }
  }

  async open(mode) {
    let file
    if (mode === "recovery" || mode === "backup") file = this.recovery + (mode === "backup" ? ".bak" : "")
    else {
      const selection = await dialog.showOpenDialog(this.window(), {
        filters: [{ name: "Khung Thoại", extensions: ["khungthoai"] }], properties: ["openFile"],
      })
      if (selection.canceled) return null
      file = selection.filePaths[0]
    }
    const { result: info } = await this.worker.call("fileOpen", { path: file })
    if (mode !== "recovery" && mode !== "backup") this.projectPath = file
    const id = randomUUID()
    this.readers.set(id, { nativeId: info.id, size: info.size, offset: 0 })
    return { id, name: path.basename(file), size: info.size }
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

  async begin(mode, name) {
    let file = mode === "autosave" ? this.recovery : null
    if (!file) {
      const selection = await dialog.showSaveDialog(this.window(), {
        defaultPath: mode === "project" && this.projectPath ? this.projectPath : path.basename(String(name || "khung-thoai.khungthoai")),
        filters: [{ name: mode === "zip" ? "ZIP PNG" : "Khung Thoại", extensions: [mode === "zip" ? "zip" : "khungthoai"] }],
      })
      if (selection.canceled) return null
      file = selection.filePath
    }
    const { result } = await this.worker.call(mode === "zip" ? "zipBegin" : "fileBegin", { path: file, backup: mode !== "zip" })
    const id = randomUUID()
    this.writers.set(id, { nativeId: result.id, file, mode })
    return { id }
  }

  async write(id, operation, options, data) {
    const item = this.writers.get(id)
    if (!item) throw new Error("Phiên ghi tệp đã kết thúc.")
    const allowed = item.mode === "zip" ? ["zipPage", "fileCommit", "fileCancel"] : ["fileAppend", "fileCommit", "fileCancel"]
    if (!allowed.includes(operation)) throw new Error("Thao tác ghi tệp không hợp lệ.")
    const response = await this.worker.call(operation, { ...options, id: item.nativeId }, data)
    if (operation === "fileCommit" || operation === "fileCancel") {
      this.writers.delete(id)
      if (operation === "fileCommit" && item.mode === "project") this.projectPath = item.file
    }
    return response.result
  }

  async cancelRead(id) {
    const item = this.readers.get(id)
    this.readers.delete(id)
    if (item) await this.worker.call("fileClose", { id: item.nativeId })
  }
}
module.exports = { ProjectFiles }
