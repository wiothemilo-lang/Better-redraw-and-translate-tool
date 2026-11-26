import { runAgentTurn } from "../agent-harness.js"
import { createAgentTools } from "../agent-tools.js"

const searchStorageKey = "khung-thoai-search-config"

function appendSafeTextWithLinks(container, text) {
  const lines = String(text || "").split("\n")
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) container.append(document.createElement("br"))
    const urlPattern = /https:\/\/[^\s<>()]+/g
    let lastIndex = 0
    let match
    while ((match = urlPattern.exec(line)) !== null) {
      if (match.index > lastIndex) {
        container.append(document.createTextNode(line.slice(lastIndex, match.index)))
      }
      const rawUrl = match[0].replace(/[.,;:!?)\]]+$/, "")
      const trailing = match[0].slice(rawUrl.length)
      const link = document.createElement("a")
      link.href = rawUrl
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      link.textContent = rawUrl
      container.append(link)
      if (trailing) container.append(document.createTextNode(trailing))
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < line.length) {
      container.append(document.createTextNode(line.slice(lastIndex)))
    }
  })
}

export function setupChat({
  state,
  byId,
  checkpoint,
  render,
  selectedPage,
  selectedIndex,
  projectBusy,
  commitLiveForm,
  readTranslationSettings,
  registerFontName,
  renderFontOptions,
}) {
  const panel = byId("chat-panel")
  const toggleBtn = byId("open-chat")
  const messagesEl = byId("chat-messages")
  const form = byId("chat-form")
  const input = byId("chat-input")
  const sendBtn = byId("chat-send")
  const stopBtn = byId("chat-stop")
  const statusEl = byId("chat-status")
  const providerSelect = byId("chat-search-provider")
  const searchUrlInput = byId("chat-search-url")
  const searchKeyInput = byId("chat-search-key")

  let chatHistory = []
  let activeController = null

  function loadSearchConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(searchStorageKey) || "null")
      if (!saved || typeof saved !== "object") return
      if (["auto", "tavily", "searxng"].includes(saved.provider)) providerSelect.value = saved.provider
      if (typeof saved.searchUrl === "string") searchUrlInput.value = saved.searchUrl
    } catch {
      // Ignore storage access errors.
    }
  }

  function saveSearchConfig() {
    try {
      localStorage.setItem(
        searchStorageKey,
        JSON.stringify({
          provider: providerSelect.value,
          searchUrl: searchUrlInput.value.trim(),
        }),
      )
    } catch {
      // Ignore storage access errors.
    }
  }

  function syncSearchFields() {
    const mode = providerSelect.value
    byId("chat-search-url-field").hidden = mode !== "searxng"
    byId("chat-search-key-field").hidden = mode !== "tavily"
  }

  loadSearchConfig()
  syncSearchFields()
  providerSelect.onchange = () => {
    syncSearchFields()
    saveSearchConfig()
  }
  searchUrlInput.onchange = saveSearchConfig

  function readSearchConfig() {
    return {
      provider: providerSelect.value,
      searchUrl: searchUrlInput.value.trim(),
      searchApiKey: searchKeyInput.value.trim(),
    }
  }

  function readAgentSettings() {
    const base = readTranslationSettings()
    return {
      ...base,
      key: byId("gemini-key").value.trim(),
      apiKey: byId("llm-key").value.trim(),
    }
  }

  function refreshModelBadge() {
    const settings = readTranslationSettings()
    const label = settings.provider === "openai"
      ? (settings.llmModel || "Local/OpenAI LLM")
      : `Gemini (${settings.model})`
    byId("chat-model-badge").textContent = label
  }
  refreshModelBadge()

  const tools = createAgentTools({
    state,
    byId,
    selectedPage,
    selectedIndex,
    checkpoint,
    render,
    commitLiveForm,
    readTranslationSettings,
    registerFontName,
    renderFontOptions,
    searchConfig: readSearchConfig,
  })

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function renderWelcome() {
    messagesEl.replaceChildren()
    const intro = document.createElement("div")
    intro.className = "chat-msg system"
    intro.textContent =
      "Trợ lý AI Harness dùng chung cấu hình Gemini hoặc Local/OpenAI LLM ở cột trái. AI có thể tra cứu web (Wikipedia, Jisho, DuckDuckGo/Tavily/SearXNG), đọc khung thoại, kiểm tra tràn chữ, cập nhật Bảng thuật ngữ và sửa khung thoại trực tiếp (mọi chỉnh sửa đều có thể Hoàn tác bằng Ctrl+Z)."
    messagesEl.append(intro)
  }
  renderWelcome()

  function setOpen(open) {
    panel.hidden = !open
    toggleBtn.setAttribute("aria-pressed", String(open))
    if (open) {
      refreshModelBadge()
      input.focus()
    }
  }

  toggleBtn.onclick = () => setOpen(panel.hidden)
  byId("chat-close").onclick = () => setOpen(false)
  byId("chat-clear").onclick = () => {
    if (activeController) return
    chatHistory = []
    statusEl.textContent = ""
    renderWelcome()
  }

  function createToolTraceCard(event) {
    const card = document.createElement("details")
    card.className = "tool-trace"
    card.dataset.state = "running"
    const summary = document.createElement("summary")
    const icon = document.createElement("span")
    icon.className = "tool-icon"
    icon.textContent = "…"
    const name = document.createElement("code")
    name.textContent = event.name
    const label = document.createElement("span")
    label.className = "tool-summary"
    label.textContent = "Đang chạy…"
    const duration = document.createElement("span")
    duration.className = "tool-duration"
    summary.append(icon, name, label, duration)

    const body = document.createElement("div")
    body.className = "tool-body"
    const argsPre = document.createElement("pre")
    argsPre.textContent = "Tham số: " + JSON.stringify(event.args ?? {}, null, 2)
    const outPre = document.createElement("pre")
    outPre.className = "tool-output"
    body.append(argsPre, outPre)
    card.append(summary, body)
    return { card, icon, label, duration, outPre, body }
  }

  async function sendPrompt(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed || activeController) return
    if (projectBusy()) {
      statusEl.textContent = "Hãy chờ tác vụ hiện tại hoàn tất."
      return
    }

    const userBubble = document.createElement("div")
    userBubble.className = "chat-msg user"
    userBubble.textContent = trimmed
    messagesEl.append(userBubble)

    const turnEl = document.createElement("div")
    turnEl.className = "chat-turn"
    messagesEl.append(turnEl)
    scrollToBottom()

    const traceCards = new Map()
    activeController = new AbortController()
    sendBtn.disabled = true
    input.disabled = true
    stopBtn.hidden = false
    statusEl.textContent = "Đang suy nghĩ…"

    try {
      const result = await runAgentTurn({
        history: chatHistory,
        userMessage: trimmed,
        settings: readAgentSettings(),
        tools,
        allowEdits: byId("chat-allow-edits").checked,
        allowWebSearch: byId("chat-allow-web").checked,
        maxSteps: 8,
        signal: activeController.signal,
        onEvent(event) {
          if (event.type === "step") {
            statusEl.textContent = `Bước ${event.step}/${event.maxSteps}…`
          } else if (event.type === "tool_start") {
            statusEl.textContent = `Đang gọi công cụ ${event.name}…`
            const ref = createToolTraceCard(event)
            traceCards.set(event.id, ref)
            turnEl.append(ref.card)
            scrollToBottom()
          } else if (event.type === "tool_end") {
            const ref = traceCards.get(event.id)
            if (ref) {
              ref.card.dataset.state = event.ok ? "ok" : "error"
              ref.icon.textContent = event.ok ? "✓" : "✗"
              ref.label.textContent = event.summary || (event.ok ? "Hoàn tất" : "Lỗi")
              ref.duration.textContent = `${event.durationMs} ms`
              const previewText = event.ok
                ? JSON.stringify(event.data ?? {}, null, 2)
                : String(event.error || "Lỗi không xác định")
              ref.outPre.textContent = previewText.length > 2400 ? previewText.slice(0, 2400) + "\n…" : previewText
              if (event.ok && Array.isArray(event.data?.results) && event.data.results.length) {
                const linksList = document.createElement("ul")
                linksList.className = "tool-links"
                for (const item of event.data.results.slice(0, 5)) {
                  if (!item?.url?.startsWith("https://")) continue
                  const li = document.createElement("li")
                  const a = document.createElement("a")
                  a.href = item.url
                  a.target = "_blank"
                  a.rel = "noopener noreferrer"
                  a.textContent = item.title || item.url
                  li.append(a)
                  linksList.append(li)
                }
                if (linksList.childElementCount) ref.body.append(linksList)
              }
            }
            scrollToBottom()
          }
        },
      })

      chatHistory = result.updatedHistory
      if (result.thought) {
        const thoughtDetails = document.createElement("details")
        thoughtDetails.className = "chat-thought"
        const thoughtSummary = document.createElement("summary")
        thoughtSummary.textContent = "Suy luận của model"
        const thoughtPre = document.createElement("pre")
        thoughtPre.textContent = result.thought
        thoughtDetails.append(thoughtSummary, thoughtPre)
        turnEl.append(thoughtDetails)
      }
      const assistantBubble = document.createElement("div")
      assistantBubble.className = "chat-msg assistant"
      appendSafeTextWithLinks(assistantBubble, result.answer)
      turnEl.append(assistantBubble)
      statusEl.textContent = result.toolTrace.length
        ? `Hoàn tất (${result.steps} bước · ${result.toolTrace.length} lượt gọi công cụ).`
        : "Hoàn tất."
    } catch (error) {
      const stopped = activeController?.signal.aborted
      const errEl = document.createElement("div")
      errEl.className = "chat-msg error"
      errEl.textContent = stopped ? "Đã dừng lượt xử lý của AI." : "Lỗi: " + (error?.message || String(error))
      turnEl.append(errEl)
      statusEl.textContent = stopped ? "Đã dừng." : "Gặp lỗi."
    } finally {
      activeController = null
      sendBtn.disabled = false
      input.disabled = false
      stopBtn.hidden = true
      scrollToBottom()
      input.focus()
    }
  }

  form.onsubmit = (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ""
    sendPrompt(text)
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  stopBtn.onclick = () => activeController?.abort()

  panel.querySelectorAll("[data-chat-prompt]").forEach((button) => {
    button.onclick = () => {
      if (activeController) return
      sendPrompt(button.dataset.chatPrompt)
    }
  })

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    refreshModelBadge,
  }
}
