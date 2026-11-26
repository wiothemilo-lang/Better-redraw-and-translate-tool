import { copyEditor } from "../history.js"
import { exportPage, nativePageLayers, textOverflows } from "../canvas.js"
import { filenameStem, saveFile } from "../io.js"
import { translationSignature } from "../translation.js"
import { exportDialogueScript } from "../tools.js"
import { desktop } from "../native.js"

export function setupExports({
  state,
  byId,
  status,
  renderPages,
  selectedPage,
  selectPage,
  selectBox,
  listButton,
  projectBusy,
  readTranslationSettings,
  isNativeReady,
  commitLiveForm,
}) {
  const exportButtons = [...document.querySelectorAll("[data-export]")]
  function extensionFor(format) {
    return format === "png" ? "png" : "psd"
  }

  async function performExport(action) {
    if (state.exporting || state.openingProject) return
    state.exporting = true
    renderPages()
    try {
      await action()
      status("Đã tạo tệp xuất.")
    } catch (error) {
      status("Xuất thất bại. " + error.message, true)
    } finally {
      state.exporting = false
      renderPages()
    }
  }

  const preflightDialog = byId("preflight-dialog")
  let pendingExport
  function exportIssues(pages) {
    const issues = []
    if (state.queue.length)
      issues.push({ text: `${state.queue.length} câu chưa đặt trong chương.` })
    for (const page of pages) {
      const prefix = page.name + " · "
      if (page.unplaced.length)
        issues.push({
          page,
          text: prefix + `${page.unplaced.length} câu chưa đặt.`,
        })
      if (page.translationJob?.state === "error")
        issues.push({
          page,
          text: prefix + "Lỗi dịch. " + page.translationJob.error,
        })
      if (page.translationJob?.state === "pending")
        issues.push({ page, text: prefix + "Chưa xử lý xong lượt dịch." })
      if (
        page.translationJob?.state === "done" &&
        page.translationJob.signature !==
          translationSignature(readTranslationSettings())
      ) {
        issues.push({
          page,
          text: prefix + "Thiết lập dịch đã đổi sau lần xử lý gần nhất.",
        })
      }
      for (const box of page.boxes) {
        if (textOverflows(page, box))
          issues.push({
            page,
            box,
            text: prefix + "Chữ tràn khung · " + box.text.slice(0, 70),
          })
      }
    }
    return issues
  }

  function showPreflight(issues, action) {
    pendingExport = action
    byId("continue-export").hidden = !action
    byId("preflight-summary").textContent = issues.length
      ? `Có ${issues.length} mục cần kiểm tra.`
      : "Các trang đã sẵn sàng để xuất."
    byId("preflight-issues").replaceChildren(
      ...issues.map((issue) => {
        const li = document.createElement("li")
        li.append(
          listButton(issue.text, () => {
            preflightDialog.close()
            location.hash = "editor"
            if (issue.page) selectPage(issue.page)
            if (issue.box) selectBox(issue.box)
            if (!issue.page)
              byId("queue-section").scrollIntoView({ block: "nearest" })
            status(issue.text)
          }),
        )
        return li
      }),
    )
    preflightDialog.showModal()
  }

  function requestExport(pages, action) {
    if (projectBusy()) return
    commitLiveForm?.()
    const issues = exportIssues(pages)
    if (issues.length) showPreflight(issues, action)
    else action()
  }
  byId("check-export").onclick = () => {
    commitLiveForm?.()
    showPreflight(exportIssues(state.pages))
  }
  byId("close-preflight").onclick = () => preflightDialog.close()
  byId("continue-export").onclick = () => {
    const action = pendingExport
    preflightDialog.close()
    action?.()
  }
  preflightDialog.addEventListener("close", () => {
    pendingExport = null
  })

  for (const button of exportButtons) {
    button.onclick = () => {
      const page = selectedPage()
      const format = button.dataset.export
      if (!page) return
      requestExport([page], () =>
        performExport(async () => {
          status("Đang xuất trang…")
          const snapshot = copyEditor({ pages: [page] }).pages[0]
          saveFile(
            await exportPage(snapshot, format),
            filenameStem(page.name) + "." + extensionFor(format),
          )
        }),
      )
    }
  }

  const zipDialog = byId("zip-dialog")
  byId("export-all").onclick = () => {
    zipDialog.returnValue = ""
    zipDialog.showModal()
  }
  zipDialog.addEventListener("close", () => {
    if (zipDialog.returnValue !== "export") return
    const format = byId("zip-format").value
    requestExport(state.pages, () =>
      performExport(async () => {
        const pages = copyEditor({ pages: state.pages }).pages
        if (format === "png" && isNativeReady()) {
          const transfer = await desktop.projectBegin(
            "zip",
            "khung-thoai-png.zip",
          )
          if (!transfer) return
          try {
            for (const [index, page] of pages.entries()) {
              status(`Đang xuất PNG bằng C# ${index + 1}/${pages.length}…`)
              const { options, data } = await nativePageLayers(page)
              const name =
                String(index + 1).padStart(2, "0") +
                "-" +
                filenameStem(page.name) +
                ".png"
              await desktop.projectWrite(
                transfer.id,
                "zipPage",
                { ...options, name },
                data,
              )
            }
            await desktop.projectWrite(transfer.id, "fileCommit")
          } catch (error) {
            await desktop
              .projectWrite(transfer.id, "fileCancel")
              .catch(() => {})
            throw error
          }
          return
        }
        const { default: JSZip } = await import("jszip")
        const zip = new JSZip()
        for (const [index, page] of pages.entries()) {
          status(`Đang xuất trang ${index + 1} / ${pages.length}…`)
          const name =
            String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name)
          zip.file(
            name + "." + extensionFor(format),
            await exportPage(page, format),
          )
        }
        saveFile(
          await zip.generateAsync({ type: "blob" }),
          "khung-thoai-" + format + ".zip",
        )
      }),
    )
  })

  const exportScriptBtn = byId("export-script")
  if (exportScriptBtn) {
    exportScriptBtn.onclick = () => {
      if (projectBusy() || !state.pages.length) return
      commitLiveForm?.()
      const format = byId("export-script-format").value
      const content = exportDialogueScript(state.pages, format)
      if (!content) return status("Chưa có lời thoại nào để xuất.", true)
      const mime =
        format === "json"
          ? "application/json;charset=utf-8"
          : format === "csv"
            ? "text/csv;charset=utf-8"
            : "text/plain;charset=utf-8"
      const stem = filenameStem(state.pages[0]?.name ?? "kich-ban")
      saveFile(new Blob([content], { type: mime }), `${stem}-kich-ban.${format}`)
      status(`Đã xuất kịch bản (${format.toUpperCase()}).`)
    }
  }
}
