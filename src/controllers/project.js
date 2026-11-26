import { readProject, writeProject, projectExtension } from "../project.js"
import { filenameStem, saveFile } from "../io.js"
import {
  desktop,
  nativeCapabilities,
  saveDesktopProject,
  openDesktopProject,
} from "../native.js"
import {
  clearWebSnapshot,
  getWebSnapshotInfo,
  loadWebSnapshot,
  saveWebSnapshot,
} from "../web-storage.js"

export function setupProjects({
  state,
  byId,
  projectSettings,
  defaultProjectSettings,
  history,
  openImage,
  selectPage,
  selectedIndex,
  updateFitLabel,
  releaseUnusedImages,
  renderPages,
  status,
  projectBusy,
  hasGesture,
  onCapabilities,
  commitLiveForm,
  registerFontName,
  renderFontOptions,
}) {
  const projectFile = byId("project-file")
  let projectName
  let nativeReady = false
  let revision = 0
  let savedRevision = 0
  let diskRevision = 0
  state.projectId = crypto.randomUUID()
  let autosaving = false
  function projectBlob() {
    const settings = Object.fromEntries(
      projectSettings.map(({ id, value }) => [id, value]),
    )
    return writeProject({
      projectId: state.projectId,
      pages: state.pages,
      presets: state.presets,
      queue: state.queue,
      settings,
      currentPage: selectedIndex(),
      fit: state.fit,
    })
  }

  byId("save-project").onclick = async () => {
    if (projectBusy()) return
    commitLiveForm?.()
    try {
      const file = projectBlob()
      const snapshotRevision = revision
      const name =
        projectName ?? filenameStem(state.pages[0]?.name ?? "khung-thoai")
      if (nativeReady) {
        state.savingProject = true
        renderPages()
        if (
          !(await saveDesktopProject(
            file,
            "project",
            name + projectExtension,
            state.projectId,
          ))
        )
          return
        status("Đã lưu dự án vào máy.")
      } else {
        saveFile(file, name + projectExtension)
        status("Đã tạo tệp dự án.")
      }
      diskRevision = snapshotRevision
      refreshDirty()
    } catch (error) {
      status("Không lưu được dự án. " + error.message, true)
    } finally {
      state.savingProject = false
      renderPages()
    }
  }

  byId("open-project").onclick = () => {
    if (projectBusy()) return
    if (nativeReady) openNativeProject("dialog")
    else projectFile.click()
  }

  projectFile.onchange = async () => {
    const file = projectFile.files[0]
    projectFile.value = ""
    await loadProject(file)
  }

  async function loadProject(file) {
    if (!file || projectBusy()) return
    const loaded = []
    state.openingProject = true
    renderPages()
    status("Đang mở dự án…")
    try {
      const project = await readProject(file)
      for (const field of projectSettings) {
        if (
          field.options &&
          ![...field.options].some(
            ({ value }) => value === project.settings[field.id],
          )
        ) {
          throw new Error("Tệp dự án chứa thiết lập chưa được hỗ trợ.")
        }
      }
      for (const saved of project.pages) {
        let page
        try {
          page = await openImage(saved.file)
        } catch {
          throw new Error("Không đọc được ảnh trong dự án: " + saved.file.name)
        }
        page.boxes = saved.boxes.map((box) => {
          registerFontName?.(box.font)
          return {
            ...box,
            id: crypto.randomUUID(),
          }
        })
        page.unplaced = saved.unplaced
        page.retouchStrokes = saved.retouchStrokes ?? []
        page.translationContext = saved.translationContext
        page.translationJob = saved.translationJob
        loaded.push(page)
      }
      for (const preset of project.presets) registerFontName?.(preset.style.font)
      renderFontOptions?.()
      const hasContent =
        state.pages.length ||
        state.presets.length ||
        state.queue.length ||
        projectSettings.some(
          ({ value }, index) => value !== defaultProjectSettings[index],
        )
      if (
        hasContent &&
        !window.confirm(
          "Mở dự án này sẽ thay thế phiên biên tập hiện tại. Tiếp tục?",
        )
      ) {
        status("Đã hủy mở dự án.")
        return
      }
      const projectId =
        project.projectId ?? file.projectId ?? crypto.randomUUID()
      if (nativeReady)
        await desktop.projectActivate(projectId, file.nativeOpenId)
      commitLiveForm?.()
      revision++
      history.clear()
      state.projectId = projectId
      diskRevision = file.recovery ? -1 : revision
      savedRevision = -1
      state.pages = loaded
      state.queue = project.queue
      state.presets = project.presets
      state.fit = project.fit
      state.zoom = null
      state.selectedBoxIds?.clear()
      updateFitLabel()
      projectSettings.forEach((field) => {
        field.value = project.settings[field.id]
      })
      projectName = filenameStem(file.name)
      selectPage(loaded[project.currentPage])
      status(`Đã mở dự án với ${loaded.length} trang.`)
    } catch (error) {
      status("Không mở được dự án. " + error.message, true)
    } finally {
      if (file.nativeOpenId) await desktop.projectDiscardOpen(file.nativeOpenId)
      releaseUnusedImages()
      state.openingProject = false
      renderPages()
    }
  }

  async function openNativeProject(mode) {
    if (projectBusy()) return
    state.openingProject = true
    renderPages()
    let file
    try {
      file = await openDesktopProject(mode)
    } catch (error) {
      status("Không mở được dự án. " + error.message, true)
    } finally {
      state.openingProject = false
      renderPages()
    }
    if (file) await loadProject(file)
  }
  byId("recover-project").onclick = async () => {
    const info = await desktop.projectStatus()
    if (info.projects) showLibrary()
    else openNativeProject("recovery")
  }
  byId("recover-backup").onclick = () => openNativeProject("backup")

  function displayName() {
    return projectName ?? filenameStem(state.pages[0]?.name ?? "Dự án mới")
  }

  function refreshDirty() {
    byId("project-dirty").textContent =
      displayName() +
      " · " +
      (revision === diskRevision ? "Đã lưu" : "Còn thay đổi chưa lưu")
  }

  async function showLibrary() {
    try {
      const projects = await desktop.projectList()
      const destination = byId("recent-projects")
      destination.replaceChildren()
      for (const project of projects) {
        const section = document.createElement("section")
        const heading = document.createElement("h3")
        heading.textContent = project.title
        section.append(heading)
        if (project.path) {
          const open = document.createElement("button")
          open.className = "button"
          open.textContent = "Mở tệp đã lưu"
          open.onclick = () => {
            byId("project-library").close()
            openNativeProject({ projectId: project.id })
          }
          section.append(open)
        }
        for (const snapshot of project.snapshots) {
          const restore = document.createElement("button")
          restore.className = "button"
          restore.textContent =
            "Khôi phục " + new Date(snapshot.updatedAt).toLocaleString("vi-VN")
          restore.onclick = () => {
            byId("project-library").close()
            openNativeProject({
              projectId: project.id,
              snapshotId: snapshot.id,
            })
          }
          section.append(restore)
        }
        destination.append(section)
      }
      const legacy = await desktop.projectStatus()
      byId("legacy-recovery").hidden = !legacy.recovery
      byId("project-library-empty").hidden =
        Boolean(projects.length) || legacy.recovery
      byId("project-library").showModal()
    } catch (error) {
      status(error.message, true)
    }
  }
  byId("legacy-recovery").onclick = () => {
    byId("project-library").close()
    openNativeProject("recovery")
  }
  byId("recent-projects-button").onclick = showLibrary
  byId("new-project").onclick = async () => {
    if (projectBusy()) return
    commitLiveForm?.()
    if (
      (state.pages.length || revision !== diskRevision) &&
      !window.confirm("Tạo dự án mới và thay phiên hiện tại?")
    )
      return
    history.clear()
    state.pages = []
    state.queue = []
    state.presets = []
    state.zoom = null
    state.selectedBoxIds?.clear()
    state.projectId = crypto.randomUUID()
    projectName = undefined
    revision = savedRevision = diskRevision = 0
    projectSettings.forEach((field, index) => {
      field.value = defaultProjectSettings[index]
    })
    if (nativeReady) await desktop.projectActivate(state.projectId)
    selectPage()
    releaseUnusedImages()
    refreshDirty()
  }

  async function refreshRecovery() {
    const info = await desktop.projectStatus()
    byId("recover-project").hidden = !info.recovery && !info.projects
    byId("recover-backup").hidden = !info.backup
  }

  async function autosave() {
    if (
      !nativeReady ||
      autosaving ||
      projectBusy() ||
      hasGesture() ||
      savedRevision === revision
    )
      return
    autosaving = true
    const snapshotRevision = revision
    const snapshotProjectId = state.projectId
    try {
      await saveDesktopProject(
        projectBlob(),
        "autosave",
        displayName() + projectExtension,
        state.projectId,
      )
      if (state.projectId !== snapshotProjectId) {
        await refreshRecovery()
        return
      }
      savedRevision = snapshotRevision
      byId("autosave-status").textContent =
        "Đã tự lưu lúc " + new Date().toLocaleTimeString("vi-VN")
      await refreshRecovery()
    } catch (error) {
      byId("autosave-status").textContent = "Tự lưu thất bại. " + error.message
    } finally {
      autosaving = false
    }
  }
  if (desktop?.native) {
    byId("local-processing").hidden = false
    byId("native-status").textContent = "Đang kiểm tra worker C#…"
    nativeCapabilities()
      .then(async (capabilities) => {
        nativeReady = Boolean(capabilities)
        const nativeLanguages = capabilities?.languages ?? []
        onCapabilities(nativeReady, nativeLanguages)
        byId("native-status").textContent = capabilities
          ? (capabilities.ocrError ?? "OCR cục bộ sẵn sàng.")
          : "Chạy npm run desktop:native để bật xử lý C#."
        byId("local-ocr-language").replaceChildren(
          ...nativeLanguages.map((language) => new Option(language, language)),
        )
        byId("native-mask-control").hidden = !nativeReady
        byId("desktop-recovery").hidden = !nativeReady
        if (nativeReady) {
          await desktop.projectActivate(state.projectId)
          await refreshRecovery()
          setInterval(autosave, 20000)
          byId("autosave-status").textContent =
            "Tự lưu mỗi 20 giây và khi đóng app."
        }
        renderPages()
      })
      .catch((error) => status(error.message, true))
  }
  let webAutosaving = false
  async function refreshWebRecovery() {
    if (desktop?.native) return
    const info = await getWebSnapshotInfo()
    const panel = byId("web-recovery")
    if (!panel) return
    panel.hidden = !info
    if (info) {
      const time = new Date(info.savedAt).toLocaleTimeString("vi-VN")
      byId("web-autosave-status").textContent =
        `Bản tự lưu web (${info.pageCount} trang) lúc ${time}.`
    }
  }
  async function webAutosave() {
    if (
      desktop?.native ||
      webAutosaving ||
      projectBusy() ||
      hasGesture() ||
      savedRevision === revision ||
      !state.pages.length
    )
      return
    webAutosaving = true
    const snapshotRevision = revision
    try {
      const saved = await saveWebSnapshot(projectBlob(), {
        name: displayName() + projectExtension,
        pageCount: state.pages.length,
      })
      if (saved) {
        savedRevision = snapshotRevision
        await refreshWebRecovery()
      }
    } catch {
      // Ignore storage quota or private browsing errors.
    } finally {
      webAutosaving = false
    }
  }
  if (!desktop?.native) {
    refreshWebRecovery()
    setInterval(webAutosave, 20000)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") webAutosave()
    })
    window.addEventListener("pagehide", () => {
      webAutosave()
    })
  }
  const recoverWebBtn = byId("recover-web")
  if (recoverWebBtn) {
    recoverWebBtn.onclick = async () => {
      if (projectBusy()) return
      const file = await loadWebSnapshot()
      if (!file) return status("Không còn bản lưu tạm trên trình duyệt.", true)
      file.recovery = true
      await loadProject(file)
    }
  }
  const clearWebBtn = byId("clear-web-recovery")
  if (clearWebBtn) {
    clearWebBtn.onclick = async () => {
      await clearWebSnapshot()
      await refreshWebRecovery()
      status("Đã xóa bản tự lưu trên trình duyệt.")
    }
  }

  let closing = false
  desktop?.onClose?.(() => {
    if (!nativeReady || savedRevision === revision) {
      desktop.closeWindow()
      return
    }
    if (closing) return
    closing = true
    const finish = async () => {
      // Let a running snapshot finish, then save the latest edit before closing.
      while (autosaving)
        await new Promise((resolve) => setTimeout(resolve, 100))
      if (projectBusy()) {
        status("Hãy chờ tác vụ hiện tại hoàn tất trước khi đóng app.", true)
        closing = false
        return
      }
      await autosave()
      if (
        savedRevision === revision ||
        window.confirm("Tự lưu thất bại. Đóng app và bỏ các thay đổi chưa lưu?")
      ) {
        savedRevision = revision
        await desktop.closeWindow()
      }
      closing = false
    }
    finish().catch((error) => {
      closing = false
      status(error.message, true)
    })
  })

  return {
    changed() {
      revision++
      refreshDirty()
    },
    refreshDirty,
    get ready() {
      return nativeReady
    },
  }
}
