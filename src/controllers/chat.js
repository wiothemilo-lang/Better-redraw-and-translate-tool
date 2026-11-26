import { runAgentTurn } from "../agent-harness.js"
import { compactChatHistory } from "../agent-context.js"
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
  selectPage,
  projectBusy,
  commitLiveForm,
  readTranslationSettings,
  registerFontName,
  renderFontOptions,
  notify,
  restoreHistory,
}) {
  const panel = byId("chat-panel")
  const toggleBtn = byId("open-chat")
  const messagesEl = byId("chat-messages")
  const form = byId("chat-form")
  const input = byId("chat-input")
  const sendBtn = byId("chat-send")
  const stopBtn = byId("chat-stop")
  const statusEl = byId("chat-status")
  const statsEl = byId("chat-stats")
  const todoBar = byId("chat-todo-bar")
  const todoCount = byId("chat-todo-count")
  const todoList = byId("chat-todo-list")
  const planModeInput = byId("chat-plan-mode")
  const allowEditsInput = byId("chat-allow-edits")
  const allowWebInput = byId("chat-allow-web")
  const compactBtn = byId("chat-compact")
  const providerSelect = byId("chat-search-provider")
  const searchUrlInput = byId("chat-search-url")
  const searchKeyInput = byId("chat-search-key")

  let chatHistory = []
  let activeController = null
  let activeTurnEl = null

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

  function renderTodos(todos) {
    if (!todoBar || !todoList || !todoCount) return
    if (!Array.isArray(todos) || !todos.length) {
      todoBar.hidden = true
      todoList.replaceChildren()
      return
    }
    const done = todos.filter((t) => t.status === "completed").length
    todoCount.textContent = `${done}/${todos.length}`
    todoList.replaceChildren(
      ...todos.map((item) => {
        const li = document.createElement("li")
        li.className = "chat-todo-item"
        li.dataset.status = item.status
        const marker = document.createElement("span")
        marker.setAttribute("aria-hidden", "true")
        marker.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"
        const text = document.createElement("span")
        text.textContent = item.content
        li.append(marker, text)
        return li
      }),
    )
    todoBar.hidden = false
  }

  function renderPlanCard(plan, container) {
    if (!plan || !container) return
    const card = document.createElement("div")
    card.className = "chat-plan-card"

    const head = document.createElement("div")
    head.className = "chat-plan-head"
    const title = document.createElement("strong")
    title.textContent = `Kế hoạch: ${plan.title}`
    const badge = document.createElement("span")
    badge.className = "chat-badge"
    badge.textContent = "Chờ duyệt"
    head.append(title, badge)

    const pre = document.createElement("pre")
    pre.className = "chat-plan-body"
    pre.textContent = plan.markdown

    const actions = document.createElement("div")
    actions.className = "form-actions"
    const execBtn = document.createElement("button")
    execBtn.type = "button"
    execBtn.className = "button primary"
    execBtn.textContent = "Thực thi kế hoạch"
    execBtn.onclick = () => {
      if (activeController) return
      if (planModeInput) planModeInput.checked = false
      if (allowEditsInput) allowEditsInput.checked = true
      badge.textContent = "Đang thực thi"
      execBtn.disabled = true
      sendPrompt("Kế hoạch đã được duyệt. Hãy chuyển sang thực thi từng bước theo kế hoạch trên, cập nhật tiến độ bằng todo_write và báo kết quả sau khi hoàn tất.")
    }
    actions.append(execBtn)

    card.append(head, pre, actions)
    container.append(card)
    scrollToBottom()
  }

  const tools = createAgentTools({
    state,
    byId,
    selectedPage,
    selectedIndex,
    selectPage,
    checkpoint,
    render,
    commitLiveForm,
    readTranslationSettings,
    registerFontName,
    renderFontOptions,
    onTodosChange: renderTodos,
    onPlanSubmit: (plan) => renderPlanCard(plan, activeTurnEl),
    searchConfig: readSearchConfig,
  })

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function renderWelcome() {
    messagesEl.replaceChildren()
    renderTodos([])
    if (statsEl) {
      statsEl.hidden = true
      statsEl.textContent = ""
    }
    const intro = document.createElement("div")
    intro.className = "chat-msg system"
    intro.textContent =
      "Trợ lý AI Harness v2 có sẵn ngữ cảnh trực tiếp của trang/dự án, quy chuẩn biên tập truyện tranh, danh sách tiến độ (todo), Chế độ Kế hoạch (Plan Mode), tự nén ngữ cảnh công cụ cũ và bộ công cụ Web Search + Rà xuất + Chỉnh sửa khung/thuật ngữ (mọi chỉnh sửa đều Hoàn tác được bằng Ctrl+Z)."
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
    tools.resetTurnState?.()
    statusEl.textContent = ""
    renderWelcome()
  }

  if (compactBtn) {
    compactBtn.onclick = () => {
      if (activeController) return
      const res = compactChatHistory(chatHistory, { force: true })
      if (!res.compacted) {
        statusEl.textContent = "Lịch sử chat còn ngắn, chưa cần nén."
        return
      }
      chatHistory = res.history
      statusEl.textContent = `Đã nén ${res.foldedMessages} tin nhắn cũ (tiết kiệm ~${res.charsSaved} ký tự).`
      notify?.({
        kind: "info",
        title: "Đã nén ngữ cảnh Trợ lý AI",
        message: `Đã gộp ${res.foldedMessages} tin nhắn cũ vào mốc tóm tắt, tiết kiệm ~${res.charsSaved} ký tự.`,
        key: "chat-compact",
      })
    }
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
    activeTurnEl = turnEl
    scrollToBottom()

    const traceCards = new Map()
    const planMode = Boolean(planModeInput?.checked)
    activeController = new AbortController()
    sendBtn.disabled = true
    input.disabled = true
    stopBtn.hidden = false
    statusEl.textContent = planMode ? "Đang khảo sát & lập kế hoạch…" : "Đang suy nghĩ…"

    try {
      const result = await runAgentTurn({
        history: chatHistory,
        userMessage: trimmed,
        settings: readAgentSettings(),
        tools,
        allowEdits: allowEditsInput.checked,
        allowWebSearch: allowWebInput.checked,
        planMode,
        maxSteps: 10,
        signal: activeController.signal,
        onEvent(event) {
          if (event.type === "step") {
            statusEl.textContent = `Bước ${event.step}/${event.maxSteps}…`
          } else if (event.type === "compacted") {
            statusEl.textContent = `Đã tự nén ${event.foldedMessages} tin cũ…`
          } else if (event.type === "pruned") {
            statusEl.textContent = `Đang tối ưu ngữ cảnh (-${event.charsSaved} ký tự)…`
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
        ? `Hoàn tất (${result.steps} bước · ${result.toolTrace.length} công cụ).`
        : "Hoàn tất."
      if (statsEl) {
        const parts = [`${(result.elapsedMs / 1000).toFixed(1)}s`]
        if (result.prunedChars > 0) parts.push(`-${result.prunedChars} kt`)
        statsEl.textContent = parts.join(" · ")
        statsEl.hidden = false
      }
      if (result.editsMade > 0) {
        notify?.({
          kind: "success",
          title: "Trợ lý AI đã chỉnh sửa dự án",
          message: `Đã thực hiện ${result.editsMade} thao tác chỉnh sửa. Bạn có thể hoàn tác bất cứ lúc nào.`,
          key: "ai-edits",
          actions: restoreHistory
            ? [{ label: "Hoàn tác", onClick: () => restoreHistory("undo") }]
            : [],
        })
      }
    } catch (error) {
      const stopped = activeController?.signal.aborted
      const errEl = document.createElement("div")
      errEl.className = "chat-msg error"
      errEl.textContent = stopped ? "Đã dừng lượt xử lý của AI." : "Lỗi: " + (error?.message || String(error))
      turnEl.append(errEl)
      statusEl.textContent = stopped ? "Đã dừng." : "Gặp lỗi."
    } finally {
      activeController = null
      activeTurnEl = null
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
