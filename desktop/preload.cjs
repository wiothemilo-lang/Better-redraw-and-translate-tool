const { contextBridge, ipcRenderer } = require("electron")

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke("khung-thoai:" + channel, ...args)
  if (response.error) throw new Error(response.error)
  return response.value
}
contextBridge.exposeInMainWorld("khungThoaiDesktop", {
  redrawTexture: (sample) => invoke("redraw-texture", sample),
  native: (operation, options, data, taskId) => invoke("native", operation, options, data, taskId),
  onTask: (callback) => ipcRenderer.on("khung-thoai:task", (_event, update) => callback(update)),
  cancelTask: (id) => invoke("task-cancel", id),
  onClose: (callback) => ipcRenderer.on("khung-thoai:closing", () => callback()),
  closeWindow: () => invoke("close"),
  projectList: () => invoke("project-list"),
  projectActivate: (id, candidate) => invoke("project-activate", id, candidate),
  projectStatus: () => invoke("project-status"),
  projectOpen: (mode) => invoke("project-open", mode),
  projectDiscardOpen: (id) => invoke("project-discard-open", id),
  projectRead: (id) => invoke("project-read", id),
  projectCancelRead: (id) => invoke("project-cancel-read", id),
  projectBegin: (mode, name, projectId) => invoke("project-begin", mode, name, projectId),
  projectWrite: (id, operation, options, data) => invoke("project-write", id, operation, options, data),
})
