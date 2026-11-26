import { executeToolBatch } from "./agent-pipeline.js"
import {
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  buildLayeredSystemPrompt,
  buildRuntimeContextReminder,
  compactChatHistory,
  pruneOldToolResults,
  retainHeadTailText,
} from "./agent-context.js"
import { RepeatToolGuard } from "./agent-guards.js"
import { parseRetryAfterMs, withLlmRetry } from "./llm-retry.js"
import { validateEndpointUrl } from "./openai-compat.js"

const geminiModelOptions = {
  auto: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
  "gemini-3.1-flash-lite": ["gemini-3.1-flash-lite"],
  "gemini-3.5-flash-lite": ["gemini-3.5-flash-lite"],
}

export function buildSystemPrompt({
  allowEdits = true,
  allowWebSearch = true,
  planMode = false,
  sourceLanguage = "Japanese",
  targetLanguage = "Vietnamese",
  direction = "rtl",
  skillPrompt = "",
} = {}) {
  return buildLayeredSystemPrompt({
    allowEdits,
    allowWebSearch,
    planMode,
    sourceLanguage,
    targetLanguage,
    direction,
    skillPrompt,
  })
}

export function stripReasoning(raw) {
  const text = String(raw || "")
  const thoughts = []
  const cleaned = text
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
      if (inner.trim()) thoughts.push(inner.trim())
      return ""
    })
    .trim()
  return { thought: thoughts.join("\n\n"), answer: cleaned }
}

export function parseTextToolCalls(text) {
  const calls = []
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let match
  while ((match = pattern.exec(String(text || ""))) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed.name === "string") {
        calls.push({
          id: "tc_" + (calls.length + 1),
          name: parsed.name,
          args: typeof parsed.arguments === "object" && parsed.arguments !== null ? parsed.arguments : {},
        })
      }
    } catch {
      // Ignore malformed inline tool_call blocks.
    }
  }
  return calls
}

async function callGeminiStep({ settings, systemPrompt, contents, toolDefs, signal }) {
  const key = String(settings.key || "").trim()
  if (!key) throw new Error("Hãy nhập khóa API Gemini ở mục Dịch ảnh & LLM.")
  const models = geminiModelOptions[settings.model] ?? geminiModelOptions.auto
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(toolDefs.length && { tools: [{ functionDeclarations: toolDefs }] }),
  })
  let response
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const timeoutSignal = AbortSignal.timeout(90000)
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        credentials: "omit",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        body,
      },
    )
    if (response.ok) {
      const payload = await response.json()
      const parts = payload.candidates?.[0]?.content?.parts ?? []
      const textParts = []
      const toolCalls = []
      for (const part of parts) {
        if (part.thought) continue
        if (typeof part.text === "string" && part.text) textParts.push(part.text)
        if (part.functionCall?.name) {
          toolCalls.push({
            id: "gem_" + (toolCalls.length + 1) + "_" + Date.now(),
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          })
        }
      }
      return {
        rawModelContent: { role: "model", parts },
        text: textParts.join("\n").trim(),
        toolCalls,
      }
    }
    const canFallback = [404, 429, 500, 502, 503, 504].includes(response.status) && i + 1 < models.length
    if (!canFallback) break
  }
  const err = new Error(`Gemini trả lỗi ${response.status}. Kiểm tra khóa API và hạn mức.`)
  err.status = response.status
  err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
  throw err
}

async function callOpenAiStep({ settings, messages, toolDefs, signal }) {
  const endpoint = validateEndpointUrl(settings.baseUrl) + "/chat/completions"
  const model = String(settings.llmModel || "").trim()
  if (!model) throw new Error("Hãy nhập tên Model LLM ở mục Dịch ảnh & LLM.")
  const headers = { "Content-Type": "application/json" }
  if (settings.apiKey) headers.Authorization = "Bearer " + settings.apiKey

  const body = {
    model,
    temperature: 0.3,
    messages,
    ...(toolDefs.length && {
      tools: toolDefs.map((def) => ({
        type: "function",
        function: { name: def.name, description: def.description, parameters: def.parameters },
      })),
      tool_choice: "auto",
    }),
  }

  const timeoutSignal = AbortSignal.timeout(120000)
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    credentials: "omit",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = new Error(`LLM trả lỗi ${response.status}. Kiểm tra Base URL, tên model và API key.`)
    err.status = response.status
    err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
    throw err
  }
  const payload = await response.json()
  const message = payload.choices?.[0]?.message ?? {}
  const rawText = Array.isArray(message.content)
    ? message.content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n")
    : String(message.content ?? "")

  let toolCalls = []
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    toolCalls = message.tool_calls.map((tc, index) => {
      let args = {}
      try {
        args = typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments || "{}")
          : (tc.function?.arguments ?? {})
      } catch {
        args = {}
      }
      return {
        id: tc.id || "call_" + (index + 1),
        name: tc.function?.name || "",
        args,
      }
    }).filter((tc) => tc.name)
  } else if (rawText.includes("<tool_call>")) {
    toolCalls = parseTextToolCalls(rawText)
  }

  return {
    rawMessage: message,
    text: rawText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim(),
    toolCalls,
  }
}

export async function summarizeHistoryWithLlm({ history = [], settings, keepRecentMessages = 4, signal } = {}) {
  const list = Array.isArray(history) ? history.filter((m) => m && typeof m.text === "string" && m.text.trim()) : []
  if (list.length <= keepRecentMessages + 1) {
    return compactChatHistory(list, { keepRecentMessages, force: true })
  }
  const totalChars = list.reduce((sum, m) => sum + m.text.length, 0)
  const older = list.slice(0, list.length - keepRecentMessages)
  const recent = list.slice(list.length - keepRecentMessages)
  const transcript = older
    .map((m) => `${m.role === "user" ? "Người dùng" : "Trợ lý"}: ${m.text.slice(0, 1000)}`)
    .join("\n\n")
  const directive = [
    "Hãy tóm tắt ngắn gọn bằng tiếng Việt đoạn hội thoại biên tập truyện tranh trên thành một mốc ngữ cảnh (checkpoint) để tiếp tục công việc không mất thông tin quan trọng.",
    "Giữ các mục ngắn dạng gạch đầu dòng: Mục tiêu chính, Tên nhân vật / Xưng hô & Thuật ngữ đã chốt, Các thay đổi đã làm, Việc còn dang dở.",
    "Chỉ xuất nội dung tóm tắt, không gọi công cụ.",
  ].join("\n")

  const isOpenAi = settings?.provider === "openai"
  const reply = isOpenAi
    ? await withLlmRetry(
      () => callOpenAiStep({
        settings,
        messages: [
          { role: "system", content: "Bạn là bộ nén ngữ cảnh cho trình biên tập truyện tranh Nixio." },
          { role: "user", content: `${transcript}\n\n---\n${directive}` },
        ],
        toolDefs: [],
        signal,
      }),
      { maxRetries: 1, signal },
    )
    : await withLlmRetry(
      () => callGeminiStep({
        settings,
        systemPrompt: "Bạn là bộ nén ngữ cảnh cho trình biên tập truyện tranh Nixio.",
        contents: [{ role: "user", parts: [{ text: `${transcript}\n\n---\n${directive}` }] }],
        toolDefs: [],
        signal,
      }),
      { maxRetries: 1, signal },
    )

  const summary = stripReasoning(reply.text).answer.trim()
  if (!summary) return compactChatHistory(list, { keepRecentMessages, force: true })
  const checkpointMessage = {
    role: "assistant",
    compacted: true,
    text: `${SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_CLOSE_TAG}`,
  }
  const nextHistory = [checkpointMessage, ...recent]
  const nextChars = nextHistory.reduce((sum, m) => sum + m.text.length, 0)
  return {
    history: nextHistory,
    compacted: true,
    llmSummarized: true,
    foldedMessages: older.length,
    charsSaved: Math.max(0, totalChars - nextChars),
  }
}

export async function runAgentTurn({
  history = [],
  userMessage,
  settings,
  tools,
  allowEdits = true,
  allowWebSearch = true,
  planMode = false,
  confirmBulkEdits = false,
  skillPrompt = "",
  maxSteps = 10,
  maxRetries = 2,
  signal,
  onEvent = () => {},
}) {
  const promptText = String(userMessage || "").trim()
  if (!promptText) throw new Error("Hãy nhập câu hỏi hoặc yêu cầu cho Trợ lý AI.")

  const turnStart = performance.now()
  const effectiveAllowEdits = Boolean(allowEdits) && !planMode
  const compacted = compactChatHistory(history)
  const workingHistory = compacted.history
  if (compacted.compacted) {
    onEvent({
      type: "compacted",
      foldedMessages: compacted.foldedMessages,
      charsSaved: compacted.charsSaved,
    })
  }

  const systemPrompt = buildSystemPrompt({
    allowEdits: effectiveAllowEdits,
    allowWebSearch,
    planMode,
    sourceLanguage: settings.source,
    targetLanguage: settings.target,
    direction: settings.direction,
    skillPrompt,
  })
  const providerLabel = settings.provider === "openai"
    ? (settings.llmModel || "OpenAI/Local")
    : `Gemini (${settings.model || "auto"})`
  const runtimeReminder = buildRuntimeContextReminder({
    snapshot: tools.getRuntimeSnapshot?.() ?? {},
    allowEdits: effectiveAllowEdits,
    allowWebSearch,
    planMode,
    providerLabel,
  })
  const toolDefs = tools.definitions({ allowEdits: effectiveAllowEdits, allowWebSearch, planMode })
  const isOpenAi = settings.provider === "openai"
  const toolTrace = []
  const thoughts = []
  const repeatGuard = new RepeatToolGuard()
  let totalPrunedChars = compacted.charsSaved
  let editsMade = 0
  let retriesUsed = 0

  // Build provider-specific message thread from clean chat history ({ role: "user"|"assistant", text }).
  const geminiContents = workingHistory.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.text }],
  }))
  geminiContents.push({
    role: "user",
    parts: [{ text: `${runtimeReminder}\n\n${promptText}` }],
  })

  const openAiMessages = [
    { role: "system", content: systemPrompt },
    ...workingHistory.map((msg) => ({ role: msg.role, content: msg.text })),
    { role: "user", content: `${runtimeReminder}\n\n${promptText}` },
  ]

  let finalAnswer = ""
  let stepsUsed = 0

  for (let step = 1; step <= maxSteps; step++) {
    signal?.throwIfAborted()
    stepsUsed = step

    // Replay-safe old tool-result pruning between steps (inspired by DeepSeek Harness).
    if (step > 2) {
      const pruned = pruneOldToolResults(isOpenAi ? openAiMessages : geminiContents, {
        provider: isOpenAi ? "openai" : "gemini",
      })
      if (pruned.charsSaved > 0) {
        totalPrunedChars += pruned.charsSaved
        onEvent({ type: "pruned", prunedCount: pruned.prunedCount, charsSaved: pruned.charsSaved })
      }
    }

    onEvent({ type: "step", step, maxSteps })

    const reply = await withLlmRetry(
      () => (isOpenAi
        ? callOpenAiStep({ settings, messages: openAiMessages, toolDefs, signal })
        : callGeminiStep({ settings, systemPrompt, contents: geminiContents, toolDefs, signal })),
      {
        maxRetries,
        signal,
        onRetry({ attempt, maxRetries: limit, delayMs }) {
          retriesUsed++
          onEvent({ type: "retry", attempt, maxRetries: limit, delayMs })
        },
      },
    )

    signal?.throwIfAborted()
    const { thought, answer } = stripReasoning(reply.text)
    if (thought) thoughts.push(thought)

    if (!reply.toolCalls.length) {
      finalAnswer = answer || "Đã hoàn tất yêu cầu."
      onEvent({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
      break
    }

    if (isOpenAi) {
      openAiMessages.push({
        role: "assistant",
        content: reply.text || null,
        tool_calls: reply.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      })
    } else {
      geminiContents.push(reply.rawModelContent)
    }

    const settled = await executeToolBatch(reply.toolCalls, {
      tools,
      allowEdits: effectiveAllowEdits,
      allowWebSearch,
      planMode,
      confirmBulkEdits,
      maxParallel: 4,
      signal,
      onEvent,
    })

    const geminiResponses = []
    const guardReminders = []
    for (const entry of settled) {
      toolTrace.push(entry)
      if (entry.ok && entry.category === "write") editsMade++
      const guardHit = repeatGuard.observe(entry.name, entry.args)
      if (guardHit) {
        guardReminders.push(guardHit.reminder)
        onEvent({ type: "guard", toolName: guardHit.toolName, count: guardHit.count, level: guardHit.level })
      }

      const rawModelPayload = entry.ok
        ? (entry.modelText ?? JSON.stringify({ ok: true, summary: entry.summary, data: entry.data }))
        : JSON.stringify({ ok: false, error: entry.error, ...(entry.code && { code: entry.code }) })
      const retained = retainHeadTailText(rawModelPayload, {
        thresholdChars: 9000,
        headChars: 5400,
        tailChars: 2400,
      })
      if (retained.truncated) totalPrunedChars += retained.omittedChars

      if (isOpenAi) {
        openAiMessages.push({ role: "tool", tool_call_id: entry.id, content: retained.text })
      } else {
        geminiResponses.push({
          functionResponse: {
            name: entry.name,
            response: entry.ok
              ? (entry.modelText || retained.truncated
                ? { ok: true, summary: entry.summary, content: retained.text }
                : { ok: true, summary: entry.summary, data: entry.data })
              : { ok: false, error: entry.error, ...(entry.code && { code: entry.code }) },
          },
        })
      }
    }
    if (isOpenAi) {
      for (const reminder of guardReminders) {
        openAiMessages.push({ role: "user", content: reminder })
      }
    } else {
      for (const reminder of guardReminders) {
        geminiResponses.push({ text: reminder })
      }
      geminiContents.push({ role: "user", parts: geminiResponses })
    }

    if (step === maxSteps) {
      finalAnswer = answer || `Đã thực hiện ${toolTrace.length} bước công cụ (đạt giới hạn ${maxSteps} bước). Bạn có thể nhắn tiếp để AI tiếp tục.`
      onEvent({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
    }
  }

  const updatedHistory = [
    ...workingHistory,
    { role: "user", text: promptText },
    { role: "assistant", text: finalAnswer },
  ].slice(-20)

  return {
    answer: finalAnswer,
    thought: thoughts.join("\n\n"),
    steps: stepsUsed,
    toolTrace,
    updatedHistory,
    editsMade,
    retriesUsed,
    prunedChars: totalPrunedChars,
    elapsedMs: Math.round(performance.now() - turnStart),
    todos: tools.getTodos?.() ?? [],
    plan: tools.getPlan?.() ?? null,
  }
}
