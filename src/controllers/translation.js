import { alignScript, translateBoxesGemini, translateImage } from "../gemini.js"
import {
  alignScriptOpenAi,
  translateBoxesOpenAi,
  translateImageOpenAi,
  validateEndpointUrl,
} from "../openai-compat.js"
import { remainingTranslations, translationSignature } from "../translation.js"
import { groupDialogue } from "../io.js"

const llmStorageKey = "khung-thoai-llm-config"
const llmPresets = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
}

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
  onSettingsChange,
}) {
  let translationController

  function loadStoredLlmConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(llmStorageKey) || "null")
      if (!saved || typeof saved !== "object") return
      if (saved.provider === "openai" || saved.provider === "gemini") {
        byId("translation-provider").value = saved.provider
      }
      if (typeof saved.baseUrl === "string" && saved.baseUrl) byId("llm-base-url").value = saved.baseUrl
      if (typeof saved.llmModel === "string") byId("llm-model").value = saved.llmModel
    } catch {
      // Ignore storage access errors in private browsing.
    }
  }

  function saveStoredLlmConfig() {
    try {
      localStorage.setItem(
        llmStorageKey,
        JSON.stringify({
          provider: byId("translation-provider").value,
          baseUrl: byId("llm-base-url").value.trim(),
          llmModel: byId("llm-model").value.trim(),
        }),
      )
    } catch {
      // Ignore storage access errors.
    }
  }

  function syncProviderFields() {
    const isOpenAi = byId("translation-provider").value === "openai"
    byId("gemini-fields").hidden = isOpenAi
    byId("openai-fields").hidden = !isOpenAi
  }

  loadStoredLlmConfig()
  syncProviderFields()

  byId("translation-provider").onchange = () => {
    syncProviderFields()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-preset").onchange = () => {
    const preset = llmPresets[byId("llm-preset").value]
    if (!preset) return
    byId("llm-base-url").value = preset.baseUrl
    if (preset.model && !byId("llm-model").value.trim()) byId("llm-model").value = preset.model
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-base-url").onchange = () => {
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-model").onchange = () => {
    saveStoredLlmConfig()
    onSettingsChange?.()
  }

  function readTranslationSettings() {
    const provider = byId("translation-provider").value
    return {
      provider,
      model: byId("gemini-model").value,
      baseUrl: byId("llm-base-url").value.trim(),
      llmModel: byId("llm-model").value.trim(),
      source: byId("source-language").value,
      target: byId("target-language").value,
      notes: byId("translation-notes").value.trim(),
      direction: byId("direction").value,
      glossary: byId("translation-glossary").value.trim(),
    }
  }

  function prepareCredentials(settings) {
    if (settings.provider === "openai") {
      validateEndpointUrl(settings.baseUrl)
      if (!settings.llmModel) throw new Error("Hãy nhập tên Model LLM.")
      return { ...settings, apiKey: byId("llm-key").value.trim() }
    }
    const key = byId("gemini-key").value.trim()
    if (!key) throw new Error("Hãy nhập khóa API Gemini.")
    return { ...settings, key }
  }

  async function processPages(pages, read, action, kind = "translate") {
    if (projectBusy() || !pages.length) return
    let settings
    try {
      settings = prepareCredentials(readTranslationSettings())
    } catch (error) {
      return status(error.message, true)
    }
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

  async function translateExistingBoxes() {
    const page = selectedPage()
    if (projectBusy() || !page) return
    if (!page.boxes.length) return status("Trang hiện tại chưa có khung chữ nào để dịch.", true)
    let settings
    try {
      settings = prepareCredentials(readTranslationSettings())
    } catch (error) {
      return status(error.message, true)
    }
    const signature = translationSignature(settings)
    const previousPage = state.pages[state.pages.indexOf(page) - 1]
    const context =
      previousPage?.translationContext?.signature === signature
        ? previousPage.translationContext.lines
        : []
    checkpoint()
    translationController = new AbortController()
    state.translating = true
    page.translationJob = { kind: "translate", signature, state: "running" }
    renderPages()
    renderInspector()
    try {
      const report = (message) => status(page.name + " · " + message)
      const requestSettings = { ...settings, context, report, signal: translationController.signal }
      const translated = settings.provider === "openai"
        ? await translateBoxesOpenAi(page.boxes, requestSettings)
        : await translateBoxesGemini(page, page.boxes, requestSettings)
      translationController.signal.throwIfAborted()
      const byBoxId = new Map(translated.map((item) => [item.boxId, item]))
      let updated = 0
      for (const box of page.boxes) {
        const match = byBoxId.get(box.id)
        if (!match?.text) continue
        box.text = match.text
        updated++
      }
      page.translationContext = {
        signature,
        lines: [
          ...context,
          ...translated.map(({ source, text }) => ({
            source: source.slice(0, 240),
            text: text.slice(0, 240),
          })),
        ].slice(-8),
      }
      page.translationJob = { kind: "translate", signature, state: "done" }
      status(`Đã dịch ${updated}/${page.boxes.length} khung chữ trên trang.`)
    } catch (error) {
      const stopped = translationController.signal.aborted
      page.translationJob = {
        kind: "translate",
        signature,
        state: stopped ? "pending" : "error",
        error: stopped ? undefined : error.message,
      }
      status(stopped ? "Đã dừng dịch khung chữ." : "Không dịch được khung chữ. " + error.message, !stopped)
    } finally {
      state.translating = false
      translationController = null
      render()
    }
  }

  const imageTranslator = (page, settings) =>
    settings.provider === "openai" ? translateImageOpenAi(page, settings) : translateImage(page, settings)
  const scriptAligner = (page, settings, lines) =>
    settings.provider === "openai" ? alignScriptOpenAi(page, settings, lines) : alignScript(page, settings, lines)

  byId("translate-boxes").onclick = translateExistingBoxes
  byId("translate").onclick = () =>
    processPages([selectedPage()].filter(Boolean), imageTranslator, "dịch")
  byId("translate-all").onclick = () =>
    processPages([...state.pages], imageTranslator, "dịch")
  byId("resume-translation").onclick = () =>
    processPages(
      remainingTranslations(state.pages, readTranslationSettings()),
      imageTranslator,
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
    processPages(
      [page],
      (selected, settings) => scriptAligner(selected, settings, lines),
      "ghép",
      "align",
    )
  }

  return { settings: readTranslationSettings }
}
