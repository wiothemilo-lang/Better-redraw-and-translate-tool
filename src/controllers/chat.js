import { runAgentTurn, summarizeHistoryWithLlm } from "../agent-harness.js"
import { compactChatHistory } from "../agent-context.js"
import { parseSlashCommand } from "../agent-commands.js"
import { BUILTIN_SKILLS, getSkill, loadSkillPrefs, resolveSkillPrompt, saveSkillPrefs } from "../agent-skills.js"
import { createAgentTools } from "../agent-tools.js"
import { clearProjectChatSession, loadProjectChatSession, saveProjectChatSession } from "../chat-storage.js"

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
  const confirmBulkInput = byId("chat-confirm-bulk")
  const compactBtn = byId("chat-compact")
  const skillSelect = byId("chat-skill")
  const skillCustomInput = byId("chat-skill-custom")
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

  // Populate & persist genre Skills.
  if (skillSelect) {
    skillSelect.replaceChildren(...BUILTIN_SKILLS.map((skill) => new Option(skill.name, skill.id)))
    const savedSkill = loadSkillPrefs()
    skillSelect.value = savedSkill.skillId
    if (skillCustomInput) skillCustomInput.value = savedSkill.customInstructions
    const persistSkill = () => {
      saveSkillPrefs({
        skillId: skillSelect.value,
        customInstructions: skillCustomInput?.value || "",
      })
    }
    skillSelect.onchange = persistSkill
    if (skillCustomInput) skillCustomInput.onchange = persistSkill
  }

  function readSkillPrompt() {
    return resolveSkillPrompt(skillSelect?.value || "default", skillCustomInput?.value || "")
  }

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

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function renderSystemNotice(text) {
    const el = document.createElement("div")
    el.className = "chat-msg system"
    appendSafeTextWithLinks(el, text)
    messagesEl.append(el)
    scrollToBottom()
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

  function promptInteractiveQuestion({ header, question, options = [], allowCustom = true, signal }) {
    return new Promise((resolve) => {
      const target = activeTurnEl || messagesEl
      const card = document.createElement("div")
      card.className = "chat-ask-card"

      const head = document.createElement("div")
      head.className = "chat-plan-head"
      const title = document.createElement("strong")
      title.textContent = header || "Cần bạn chọn"
      const badge = document.createElement("span")
      badge.className = "chat-badge"
      badge.textContent = "Đang chờ chọn"
      head.append(title, badge)

      const qText = document.createElement("p")
      qText.className = "chat-ask-question"
      qText.textContent = question
      card.append(head, qText)

      let settled = false
      const finish = (result, label) => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)
        badge.textContent = label
        card.querySelectorAll("button, input").forEach((el) => { el.disabled = true })
        statusEl.textContent = "Đang tiếp tục xử lý…"
        resolve(result)
      }
      const onAbort = () => finish({ cancelled: true }, "Đã hủy")
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      if (options.length) {
        const list = document.createElement("div")
        list.className = "chat-ask-options"
        for (const opt of options) {
          const btn = document.createElement("button")
          btn.type = "button"
          btn.className = "button chat-ask-option"
          const strong = document.createElement("strong")
          strong.textContent = opt.label
          btn.append(strong)
          if (opt.description) {
            const small = document.createElement("small")
            small.textContent = opt.description
            btn.append(small)
          }
          btn.onclick = () => finish({ answer: opt.label, custom: false }, `Đã chọn: ${opt.label}`)
          list.append(btn)
        }
        card.append(list)
      }

      if (allowCustom) {
        const customRow = document.createElement("div")
        customRow.className = "chat-ask-custom"
        const customInput = document.createElement("input")
        customInput.type = "text"
        customInput.placeholder = "Hoặc nhập phương án khác…"
        const sendCustom = document.createElement("button")
        sendCustom.type = "button"
        sendCustom.className = "button primary"
        sendCustom.textContent = "Trả lời"
        const submitCustom = () => {
          const val = customInput.value.trim()
          if (!val) return
          finish({ answer: val, custom: true }, "Đã trả lời")
        }
        sendCustom.onclick = submitCustom
        customInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            submitCustom()
          }
        })
        customRow.append(customInput, sendCustom)
        card.append(customRow)
      }

      const cancelRow = document.createElement("div")
      cancelRow.className = "form-actions"
      const skipBtn = document.createElement("button")
      skipBtn.type = "button"
      skipBtn.className = "button"
      skipBtn.textContent = "Bỏ qua"
      skipBtn.onclick = () => finish({ cancelled: true }, "Đã bỏ qua")
      cancelRow.append(skipBtn)
      card.append(cancelRow)

      target.append(card)
      statusEl.textContent = "AI đang chờ bạn chọn phương án…"
      scrollToBottom()
    })
  }

  function promptToolApproval({ name, args, signal }) {
    return new Promise((resolve) => {
      const target = activeTurnEl || messagesEl
      const card = document.createElement("div")
      card.className = "chat-approval-card"

      const head = document.createElement("div")
      head.className = "chat-plan-head"
      const title = document.createElement("strong")
      title.textContent = `Xác nhận thao tác: ${name}`
      const badge = document.createElement("span")
      badge.className = "chat-badge"
      badge.textContent = "Chờ duyệt"
      head.append(title, badge)

      const pre = document.createElement("pre")
      pre.className = "chat-plan-body"
      pre.textContent = JSON.stringify(args ?? {}, null, 2)

      let settled = false
      const finish = (decision, label) => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)
        badge.textContent = label
        card.querySelectorAll("button").forEach((b) => { b.disabled = true })
        statusEl.textContent = decision.approved ? `Đang chạy ${name}…` : "Đã từ chối thao tác."
        resolve(decision)
      }
      const onAbort = () => finish({ approved: false, reason: "Đã hủy" }, "Đã hủy")
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      const actions = document.createElement("div")
      actions.className = "form-actions"
      const approveBtn = document.createElement("button")
      approveBtn.type = "button"
      approveBtn.className = "button primary"
      approveBtn.textContent = "Chấp nhận"
      approveBtn.onclick = () => finish({ approved: true }, "Đã duyệt")

      const rejectBtn = document.createElement("button")
      rejectBtn.type = "button"
      rejectBtn.className = "button danger"
      rejectBtn.textContent = "Từ chối"
      rejectBtn.onclick = () => finish({ approved: false }, "Đã từ chối")

      actions.append(approveBtn, rejectBtn)
      card.append(head, pre, actions)
      target.append(card)
      statusEl.textContent = `Chờ duyệt thao tác ${name}…`
      scrollToBottom()
    })
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
    onTodosChange: (todos) => {
      renderTodos(todos)
      if (state.projectId) saveProjectChatSession(state.projectId, { history: chatHistory, todos })
    },
    onPlanSubmit: (plan) => renderPlanCard(plan, activeTurnEl),
    onAskUser: promptInteractiveQuestion,
    onApproveTool: promptToolApproval,
    searchConfig: readSearchConfig,
  })

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
      "Trợ lý AI Harness v2.5 hỗ trợ ngữ cảnh dự án trực tiếp, hồ sơ kỹ năng theo thể loại, thẻ hỏi trắc nghiệm, duyệt thao tác hàng loạt, Chế độ Kế hoạch (Plan Mode), tự thử lại khi lỗi mạng/429, chống lặp công cụ và lệnh nhanh (/qc, /plan, /autofit, /compact, /skill, /help)."
    messagesEl.append(intro)
  }

  function renderPersistedSession() {
    renderWelcome()
    if (!chatHistory.length) return
    for (const msg of chatHistory) {
      const bubble = document.createElement("div")
      bubble.className = `chat-msg ${msg.compacted ? "system" : msg.role}`
      appendSafeTextWithLinks(bubble, msg.text)
      messagesEl.append(bubble)
    }
    scrollToBottom()
  }

  function syncProjectSession() {
    if (activeController) return
    const saved = loadProjectChatSession(state.projectId)
    chatHistory = saved.history
    renderPersistedSession()
    tools.setTodos?.(saved.todos)
    statusEl.textContent = chatHistory.length ? `Đã khôi phục ${chatHistory.length} tin nhắn của dự án.` : ""
  }

  syncProjectSession()

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

  function clearSession() {
    if (activeController) return
    chatHistory = []
    tools.resetTurnState?.()
    if (state.projectId) clearProjectChatSession(state.projectId)
    statusEl.textContent = ""
    renderWelcome()
  }
  byId("chat-clear").onclick = clearSession

  async function runCompact({ useLlm = false } = {}) {
    if (activeController) return
    if (useLlm) {
      statusEl.textContent = "Đang dùng AI tóm tắt ngữ cảnh…"
      activeController = new AbortController()
      sendBtn.disabled = true
      stopBtn.hidden = false
      try {
        const res = await summarizeHistoryWithLlm({
          history: chatHistory,
          settings: readAgentSettings(),
          signal: activeController.signal,
        })
        if (!res.compacted) {
          statusEl.textContent = "Lịch sử chat còn ngắn, chưa cần nén."
          return
        }
        chatHistory = res.history
        if (state.projectId) saveProjectChatSession(state.projectId, { history: chatHistory, todos: tools.getTodos?.() ?? [] })
        renderPersistedSession()
        statusEl.textContent = `Đã tóm tắt ${res.foldedMessages} tin nhắn cũ bằng AI (-${res.charsSaved} ký tự).`
        notify?.({
          kind: "info",
          title: "Đã tóm tắt ngữ cảnh bằng AI",
          message: `Đã gộp ${res.foldedMessages} tin nhắn cũ, tiết kiệm ~${res.charsSaved} ký tự.`,
          key: "chat-compact",
        })
      } catch (error) {
        statusEl.textContent = "Không tóm tắt được bằng AI: " + (error?.message || String(error))
      } finally {
        activeController = null
        sendBtn.disabled = false
        stopBtn.hidden = true
      }
      return
    }
    const res = compactChatHistory(chatHistory, { force: true })
    if (!res.compacted) {
      statusEl.textContent = "Lịch sử chat còn ngắn, chưa cần nén."
      return
    }
    chatHistory = res.history
    if (state.projectId) saveProjectChatSession(state.projectId, { history: chatHistory, todos: tools.getTodos?.() ?? [] })
    statusEl.textContent = `Đã nén ${res.foldedMessages} tin nhắn cũ (tiết kiệm ~${res.charsSaved} ký tự).`
    notify?.({
      kind: "info",
      title: "Đã nén ngữ cảnh Trợ lý AI",
      message: `Đã gộp ${res.foldedMessages} tin nhắn cũ vào mốc tóm tắt, tiết kiệm ~${res.charsSaved} ký tự.`,
      key: "chat-compact",
    })
  }

  if (compactBtn) {
    compactBtn.onclick = () => runCompact({ useLlm: false })
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

    const cmd = parseSlashCommand(trimmed)
    if (cmd) {
      if (cmd.kind === "help") {
        renderSystemNotice(cmd.text)
        return
      }
      if (cmd.kind === "clear") {
        clearSession()
        return
      }
      if (cmd.kind === "compact") {
        await runCompact({ useLlm: cmd.useLlm })
        return
      }
      if (cmd.kind === "skill") {
        const target = BUILTIN_SKILLS.find((s) => s.id === cmd.skillId)
        if (!target) {
          renderSystemNotice(`Không có skill "${cmd.skillId}". Các skill sẵn có: ${BUILTIN_SKILLS.map((s) => s.id).join(", ")}.`)
          return
        }
        if (skillSelect) {
          skillSelect.value = target.id
          saveSkillPrefs({ skillId: target.id, customInstructions: skillCustomInput?.value || "" })
        }
        renderSystemNotice(`Đã chuyển hồ sơ biên tập sang: ${target.name} — ${target.description}`)
        return
      }
      if (cmd.kind === "plan") {
        if (planModeInput) planModeInput.checked = cmd.enabled
        if (!cmd.prompt) {
          renderSystemNotice(cmd.enabled ? "Đã bật Chế độ Kế hoạch (Plan Mode)." : "Đã tắt Chế độ Kế hoạch.")
          return
        }
        return sendPrompt(cmd.prompt)
      }
      if (cmd.kind === "prompt") {
        return sendPrompt(cmd.prompt)
      }
      renderSystemNotice(`Lệnh không hợp lệ: /${cmd.name}. Gõ /help để xem danh sách lệnh.`)
      return
    }

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
    const confirmBulkEdits = Boolean(confirmBulkInput?.checked)
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
        confirmBulkEdits,
        skillPrompt: readSkillPrompt(),
        maxSteps: 10,
        signal: activeController.signal,
        onEvent(event) {
          if (event.type === "step") {
            statusEl.textContent = `Bước ${event.step}/${event.maxSteps}…`
          } else if (event.type === "retry") {
            statusEl.textContent = `Thử lại kết nối AI lần ${event.attempt}/${event.maxRetries} (${Math.round(event.delayMs / 100) / 10}s)…`
          } else if (event.type === "guard") {
            statusEl.textContent = `Phát hiện gọi lặp ${event.toolName} (${event.count}×), đang nhắc AI đổi hướng…`
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
      if (state.projectId) {
        saveProjectChatSession(state.projectId, { history: chatHistory, todos: result.todos })
      }
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
        if (result.retriesUsed > 0) parts.push(`${result.retriesUsed} retry`)
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
    syncProjectSession,
    getActiveSkill: () => getSkill(skillSelect?.value || "default"),
  }
}
