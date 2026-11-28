const { app, BrowserWindow, ipcMain, net, protocol, session, dialog, shell, safeStorage, webContents } = require("electron")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { NativeWorker } = require("./native-worker.cjs")
const { TaskQueue } = require("./task-queue.cjs")
const { ProjectFiles } = require("./project-files.cjs")
const { webSearch, fetchUrl, isSafePublicHttpsUrl } = require("./web-search.cjs")
const { checkForUpdates } = require("./updater.cjs")
const { CredentialStore } = require("./credential-store.cjs")
const { CREDENTIAL_CHANNELS, CredentialService, sanitizeCredentialError, trustedChannel } = require("./credential-ipc.cjs")
const { PROVIDER_CHANNELS, ProviderTransport, providerChannel, sanitizeProviderError } = require("./provider-transport.cjs")

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
let providerTransport
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
    title: "Nixio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  const contents = mainWindow.webContents
  // Hash navigation between #editor and #library is an in-place navigation: it must not tear
  // down queued native work or an open project session. Real navigations are blocked below.
  contents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && url !== entry) { tasks?.close(); providerTransport?.cancelAll(); projects?.cancelAll().catch(() => {}) }
  })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.on("will-navigate", (event) => event.preventDefault())
  contents.on("will-attach-webview", (event) => event.preventDefault())
  mainWindow.on("close", (event) => {
    if (closeApproved || mainWindow.webContents.isDestroyed() || mainWindow.webContents.isCrashed()) return
    event.preventDefault()
    mainWindow.webContents.send("khung-thoai:closing")
  })
  mainWindow.once("ready-to-show", () => mainWindow.show())
  mainWindow.on("closed", () => { providerTransport?.cancelAll(); mainWindow = null })
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
  const handle = (channel, action, onError) => ipcMain.handle(channel, trustedChannel(trusted, action, onError))
  // API keys live in the OS vault under userData and never reach the renderer: these channels only
  // accept a newly typed key and return status plus opaque handles.
  const credentialStore = new CredentialStore({ userData: app.getPath("userData"), safeStorage, platform: process.platform })
  const credentials = new CredentialService({ store: credentialStore })
  // Provider traffic is built in main from a provider name and an operation, so a selected-provider
  // call is never a generic privileged fetch. Frames reach only the window that opened the stream.
  providerTransport = new ProviderTransport({
    credentials: credentialStore,
    emit: (senderKey, payload) => {
      const id = Number(senderKey.slice(1))
      const contents = Number.isInteger(id) ? webContents.fromId(id) : null
      if (contents && !contents.isDestroyed()) contents.send(PROVIDER_CHANNELS.event, payload)
    },
  })
  handle(CREDENTIAL_CHANNELS.status, (provider, endpoint) => credentials.status(provider, endpoint), sanitizeCredentialError)
  handle(CREDENTIAL_CHANNELS.save, (provider, endpoint, secret) => credentials.save(provider, endpoint, secret), sanitizeCredentialError)
  handle(CREDENTIAL_CHANNELS.remove, (provider, endpoint) => credentials.remove(provider, endpoint), sanitizeCredentialError)
  const provider = (channel, action) => ipcMain.handle(channel, providerChannel(trusted, action, sanitizeProviderError))
  provider(PROVIDER_CHANNELS.request, (senderKey, request) => providerTransport.execute(senderKey, request))
  provider(PROVIDER_CHANNELS.stream, (senderKey, request) => providerTransport.stream(senderKey, request))
  provider(PROVIDER_CHANNELS.activate, (senderKey, ticket) => providerTransport.activate(senderKey, ticket))
  provider(PROVIDER_CHANNELS.cancel, (senderKey, target) => providerTransport.cancel(senderKey, target))
  handle("khung-thoai:redraw-texture", (input) => imageWorker.available ? imageWorker.redraw(input) : undefined)
  handle("khung-thoai:native", (operation, options, data, taskId) => {
    if (!["capabilities", "mask", "inpaint", "content_aware_cleanup", "seamless_clone", "clean_raw", "preprocess", "ocr", "png"].includes(operation)) throw new Error("Unknown renderer operation.")
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
  // An AbortSignal cannot travel through IPC, so the renderer sends a request id and aborts
  // the in-flight desktop request by that id when the agent turn is cancelled.
  const egressRequests = new Map()
  const cancelable = (options, run) => {
    const id = typeof options?.id === "string" ? options.id : ""
    if (!id) return run(undefined)
    const controller = new AbortController()
    egressRequests.set(id, controller)
    return run(controller.signal).finally(() => { egressRequests.delete(id) })
  }
  handle("khung-thoai:web-search", (query, options) => cancelable(options, (signal) => webSearch(query, { ...options, signal })))
  handle("khung-thoai:fetch-url", (url, options) => cancelable(options, (signal) => fetchUrl(url, { ...options, signal })))
  handle("khung-thoai:abort-request", (id) => { egressRequests.get(id)?.abort(); return true })
  handle("khung-thoai:app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
  }))
  handle("khung-thoai:check-update", () => checkForUpdates(app.getVersion()))
  handle("khung-thoai:open-external", async (url) => {
    const safe = isSafePublicHttpsUrl(url)
    if (!safe) throw new Error("Chỉ cho phép mở liên kết HTTPS công khai.")
    await shell.openExternal(safe.toString())
    return true
  })

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
