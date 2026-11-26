import { alignScript, translateImage } from "../gemini.js"
import { remainingTranslations, translationSignature } from "../translation.js"
import { groupDialogue } from "../io.js"

export function setupTranslation({
  state,
  byId,
  status,
  checkpoint,
  renderPages,
  renderInspector,
  renderCanvas,
  render,
  selectedPage,
  pageForScript,
  applyTranslation,
  projectBusy,
}) {
  let translationController
  function readTranslationSettings() {
    return {
      model: byId("gemini-model").value,
      source: byId("source-language").value,
      target: byId("target-language").value,
      notes: byId("translation-notes").value.trim(),
      direction: byId("direction").value,
      glossary: byId("translation-glossary").value.trim(),
    }
  }

  async function processWithGemini(pages, read, action, kind = "translate") {
    const key = byId("gemini-key").value.trim()
    if (projectBusy() || !pages.length) return
    if (!key) return status("Hãy nhập khóa API Gemini.", true)
    const settings = { ...readTranslationSettings(), key }
    const signature = translationSignature(settings)
    const previousPage = state.pages[state.pages.indexOf(pages[0]) - 1]
    let context =
      previousPage?.translationContext?.signature === signature
        ? previousPage.translationContext.lines
        : []
    let completed = 0
    let placed = 0
    let skipped = 0
    checkpoint()
    translationController = new AbortController()
    state.translating = true
    for (const page of pages)
      page.translationJob = { kind, signature, state: "pending" }
    renderPages()
    renderInspector()
    let activePage
    try {
      for (const page of pages) {
        activePage = page
        page.translationJob = { kind, signature, state: "running" }
        renderPages()
        const report = (message) => status(page.name + " · " + message)
        const lines = await read(page, {
          ...settings,
          context,
          report,
          signal: translationController.signal,
        })
        translationController.signal.throwIfAborted()
        if (lines.length) {
          placed += applyTranslation(page, lines)
          skipped += page.unplaced.length
          context = [
            ...context,
            ...lines
              .filter(({ source }) => source)
              .map(({ source, text }) => ({
                source: source.slice(0, 240),
                text: text.slice(0, 240),
              })),
          ].slice(-8)
        } else {
          page.unplaced = []
        }
        page.translationContext = { signature, lines: context }
        page.translationJob = { kind, signature, state: "done" }
        completed++
        if (selectedPage() === page) {
          renderCanvas()
          renderInspector()
        }
      }
      status(
        `Đã ${action} ${completed}/${pages.length} trang. ${placed} câu đã đặt và ${skipped} câu chờ đặt.`,
      )
    } catch (error) {
      const stopped = translationController.signal.aborted
      if (activePage)
        activePage.translationJob = {
          kind,
          signature,
          state: stopped ? "pending" : "error",
          error: stopped ? undefined : error.message,
        }
      status(
        stopped
          ? `Đã dừng sau ${completed} trang. Có thể tiếp tục dịch chương.`
          : `Đã ${action} ${completed}/${pages.length} trang. ${error.message}`,
        !stopped,
      )
    } finally {
      state.translating = false
      translationController = null
      render()
    }
  }
  byId("translate").onclick = () =>
    processWithGemini([selectedPage()].filter(Boolean), translateImage, "dịch")
  byId("translate-all").onclick = () =>
    processWithGemini([...state.pages], translateImage, "dịch")
  byId("resume-translation").onclick = () =>
    processWithGemini(
      remainingTranslations(state.pages, readTranslationSettings()),
      translateImage,
      "dịch",
    )
  byId("stop-translation").onclick = () => translationController?.abort()
  byId("align-script").onclick = () => {
    const page = selectedPage()
    if (!page) return
    const lines = groupDialogue(byId("script-text").value)
      .filter(({ reference }) => pageForScript(reference, page) === page)
      .flatMap(({ lines }) => lines)
    if (!lines.length) return status("Hãy nhập kịch bản cho trang này.", true)
    processWithGemini(
      [page],
      (selected, settings) => alignScript(selected, settings, lines),
      "ghép",
      "align",
    )
  }

  return { settings: readTranslationSettings }
}
