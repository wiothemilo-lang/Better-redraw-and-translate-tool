const { app, BrowserWindow, ipcMain, net, protocol, session, dialog } = require("electron")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { NativeWorker } = require("./native-worker.cjs")
const { TaskQueue } = require("./task-queue.cjs")
const { ProjectFiles } = require("./project-files.cjs")
const { webSearch, fetchUrl } = require("./web-search.cjs")

const origin = "app://khung-thoai"
const entry = origin + "/index.html"
const files = path.resolve(__dirname, "../dist")
const policy = [
  "default-src 'self'",
  "img-src 'self' https: blob: data:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

function workerExecutable() {
  const platform = { win32: "win", darwin: "osx", linux: "linux" }[process.platform]
  const rid = platform + "-" + process.arch
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, "native-worker")
    : path.join(__dirname, "..", "native", "out", rid, "native-worker")
  return path.join(directory, "KhungThoai.Redraw" + (platform === "win" ? ".exe" : ""))
}

let worker
let imageWorker
let tasks
let projects
let mainWindow
let closeApproved = false

function localFile(url) {
  const { hostname, pathname } = new URL(url)
  if (hostname !== "khung-thoai") return null
  const name = decodeURIComponent(pathname === "/" ? "/index.html" : pathname)
  const target = path.resolve(files, "." + name)
  const relative = path.relative(files, target)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null
}

function createWindow() {
  closeApproved = false
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 930,
    minWidth: 650,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: "Khung Thoại",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  const { webContents } = mainWindow
  webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { tasks?.close(); projects?.cancelAll().catch(() => {}) } })
  webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  webContents.on("will-navigate", (event) => event.preventDefault())
  webContents.on("will-attach-webview", (event) => event.preventDefault())
  mainWindow.on("close", (event) => {
    if (closeApproved || mainWindow.webContents.isDestroyed() || mainWindow.webContents.isCrashed()) return
    event.preventDefault()
    mainWindow.webContents.send("khung-thoai:closing")
  })
  mainWindow.once("ready-to-show", () => mainWindow.show())
  mainWindow.on("closed", () => { mainWindow = null })
  mainWindow.loadURL(entry)
}

app.whenReady().then(() => {
  worker = new NativeWorker(workerExecutable())
  imageWorker = new NativeWorker(workerExecutable())
  tasks = new TaskQueue(() => new NativeWorker(workerExecutable(), { isolated: true }), (update) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("khung-thoai:task", update)
  })
  projects = new ProjectFiles(worker, app.getPath("userData"), () => mainWindow, dialog, (options, data) => tasks.submit(require("node:crypto").randomUUID(), "png", options, data))
  const trusted = (event) => event.sender === mainWindow?.webContents && !event.senderFrame?.parent &&
    event.senderFrame?.url.split("#", 1)[0] === entry
  const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { error: "Untrusted desktop frame." }
    try { return { value: await action(...args) } }
    catch (error) { return { error: error.message } }
  })
  handle("khung-thoai:redraw-texture", (input) => imageWorker.available ? imageWorker.redraw(input) : undefined)
  handle("khung-thoai:native", (operation, options, data, taskId) => {
    if (!["capabilities", "mask", "inpaint", "preprocess", "ocr", "png"].includes(operation)) throw new Error("Unknown renderer operation.")
    if (["ocr", "preprocess", "png"].includes(operation) && taskId) return tasks.submit(taskId, operation, options, data)
    return imageWorker.call(operation, options, data)
  })
  handle("khung-thoai:task-cancel", (id) => tasks.cancel(id))
  handle("khung-thoai:close", () => { closeApproved = true; mainWindow.close() })
  handle("khung-thoai:project-list", () => projects.catalog.list())
  handle("khung-thoai:project-activate", (id, candidate) => projects.activate(id, candidate))
  handle("khung-thoai:project-status", () => projects.status())
  handle("khung-thoai:project-open", (mode) => projects.open(mode))
  handle("khung-thoai:project-read", (id) => projects.read(id))
  handle("khung-thoai:project-discard-open", (id) => projects.discardOpen(id))
  handle("khung-thoai:project-cancel-read", (id) => projects.cancelRead(id))
  handle("khung-thoai:project-begin", (mode, name, projectId) => {
    if (!["autosave", "project", "zip"].includes(mode)) throw new Error("Invalid save mode.")
    return projects.begin(mode, name, projectId)
  })
  handle("khung-thoai:project-write", (id, operation, options, data) => projects.write(id, operation, options, data))
  handle("khung-thoai:web-search", (query, options) => webSearch(query, options))
  handle("khung-thoai:fetch-url", (url, options) => fetchUrl(url, options))

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle("app", async ({ url }) => {
    try {
      const target = localFile(url)
      if (!target) return new Response(null, { status: 404 })
      const response = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(response.headers)
      headers.set("Content-Security-Policy", policy)
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  createWindow()
  app.on("activate", () => { if (!mainWindow) createWindow() })
})

app.on("will-quit", () => { tasks?.close(); imageWorker?.close(); worker?.close() })
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
