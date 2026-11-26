import { findMatches, replaceMatches } from "../tools.js"

export function setupDialogs({
  state,
  byId,
  status,
  checkpoint,
  render,
  selectPage,
  selectBox,
  listButton,
  projectBusy,
  commitLiveForm,
}) {
  const findDialog = byId("find-replace-dialog")
  const shortcutsDialog = byId("shortcuts-dialog")

  function findOptions() {
    return {
      caseSensitive: byId("find-case").checked,
      wholeWord: byId("find-word").checked,
      includeUnplaced: byId("find-unplaced").checked,
    }
  }

  function renderFindResults() {
    const query = byId("find-query").value
    const results = byId("find-results")
    if (!query) {
      byId("find-summary").textContent = "Nhập từ khóa để tìm trong toàn bộ chương."
      results.replaceChildren()
      return
    }
    const matches = findMatches(state.pages, query, findOptions())
    const totalOccurrences = matches.reduce((sum, item) => sum + item.count, 0)
    byId("find-summary").textContent = matches.length
      ? `Tìm thấy ${totalOccurrences} kết quả trong ${matches.length} mục.`
      : "Không tìm thấy kết quả phù hợp."
    results.replaceChildren(
      ...matches.map((match) => {
        const li = document.createElement("li")
        const prefix = `Trang ${match.pageIndex + 1}${match.isUnplaced ? " (chưa đặt)" : ""} · `
        li.append(
          listButton(prefix + match.text.slice(0, 80), () => {
            findDialog.close()
            const page = state.pages[match.pageIndex]
            if (!page) return
            selectPage(page)
            if (!match.isUnplaced) {
              const box = page.boxes.find((item) => item.id === match.boxId)
              if (box) selectBox(box)
            } else {
              byId("queue-section").scrollIntoView({ block: "nearest" })
            }
          }),
        )
        return li
      }),
    )
  }

  function openFind() {
    if (projectBusy()) return
    commitLiveForm?.()
    if (!findDialog.open) findDialog.showModal()
    renderFindResults()
    byId("find-query").focus()
    byId("find-query").select()
  }

  function openShortcuts() {
    if (!shortcutsDialog.open) shortcutsDialog.showModal()
  }

  byId("open-find").onclick = openFind
  byId("close-find").onclick = () => findDialog.close()
  byId("find-query").oninput = renderFindResults
  byId("find-case").onchange = renderFindResults
  byId("find-word").onchange = renderFindResults
  byId("find-unplaced").onchange = renderFindResults

  byId("replace-all-btn").onclick = () => {
    if (projectBusy()) return
    const query = byId("find-query").value
    if (!query) return status("Hãy nhập nội dung cần tìm.", true)
    const replacement = byId("replace-text").value
    commitLiveForm?.()
    const matches = findMatches(state.pages, query, findOptions())
    if (!matches.length) return status("Không có mục nào khớp để thay thế.")
    checkpoint()
    const { replacedItems, replacedOccurrences, skippedEmpty } = replaceMatches(
      state.pages,
      query,
      replacement,
      findOptions(),
    )
    render()
    renderFindResults()
    const extra = skippedEmpty ? ` (bỏ qua ${skippedEmpty} mục để tránh rỗng)` : ""
    status(`Đã thay ${replacedOccurrences} vị trí trong ${replacedItems} mục.${extra}`)
  }

  byId("open-shortcuts").onclick = openShortcuts
  byId("close-shortcuts").onclick = () => shortcutsDialog.close()

  return { openFind, openShortcuts, renderFindResults }
}
