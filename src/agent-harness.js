import { validateEndpointUrl } from "./openai-compat.js"

const geminiModelOptions = {
  auto: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
  "gemini-3.1-flash-lite": ["gemini-3.1-flash-lite"],
  "gemini-3.5-flash-lite": ["gemini-3.5-flash-lite"],
}

export function buildSystemPrompt({ allowEdits = true, allowWebSearch = true, sourceLanguage = "Japanese", targetLanguage = "Vietnamese" } = {}) {
  return [
    "Bạn là Trợ lý AI tích hợp theo kiến trúc Agent Harness bên trong ứng dụng biên tập & dịch truyện tranh Khung Thoại.",
    `Ngôn ngữ dịch hiện tại của dự án: ${sourceLanguage} -> ${targetLanguage}. Trả lời ngắn gọn, rõ ràng bằng tiếng Việt.`,
    "Quy tắc làm việc:",
    "- Khi người dùng hỏi về trang hiện tại, khung thoại hoặc bảng thuật ngữ, hãy gọi `get_project_state` hoặc `list_boxes` để đọc dữ liệu thật thay vì đoán.",
    allowWebSearch
      ? "- Khi cần tra tên nhân vật, wiki manga/anime, thành ngữ, từ lóng hoặc SFX tiếng Nhật/Hàn/Trung, hãy dùng `web_search` và nếu cần đọc sâu trang kết quả thì dùng `fetch_url`, sau đó đính kèm link nguồn đã tra."
      : "- Quyền Web Search đang tắt; không bịa đặt thông tin tra cứu web.",
    allowEdits
      ? "- Bạn được phép chỉnh sửa khung thoại, thay thế hàng loạt, tự khớp cỡ chữ và cập nhật Bảng thuật ngữ bằng các công cụ chỉnh sửa (mọi thay đổi đều tự tạo mốc Hoàn tác Ctrl+Z). Sau khi chỉnh sửa, báo tóm tắt ngắn các thay đổi đã làm."
      : "- Chế độ CHỈ ĐỌC đang bật: chỉ tra cứu, phân tích và đề xuất, không gọi công cụ chỉnh sửa.",
  ].join("\n")
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
  throw new Error(`Gemini trả lỗi ${response.status}. Kiểm tra khóa API và hạn mức.`)
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
    throw new Error(`LLM trả lỗi ${response.status}. Kiểm tra Base URL, tên model và API key.`)
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

export async function runAgentTurn({
  history = [],
  userMessage,
  settings,
  tools,
  allowEdits = true,
  allowWebSearch = true,
  maxSteps = 8,
  signal,
  onEvent = () => {},
}) {
  const promptText = String(userMessage || "").trim()
  if (!promptText) throw new Error("Hãy nhập câu hỏi hoặc yêu cầu cho Trợ lý AI.")

  const systemPrompt = buildSystemPrompt({
    allowEdits,
    allowWebSearch,
    sourceLanguage: settings.source,
    targetLanguage: settings.target,
  })
  const toolDefs = tools.definitions({ allowEdits, allowWebSearch })
  const isOpenAi = settings.provider === "openai"
  const toolTrace = []
  const thoughts = []

  // Build provider-specific message thread from clean chat history ({ role: "user"|"assistant", text }).
  const geminiContents = history.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.text }],
  }))
  geminiContents.push({ role: "user", parts: [{ text: promptText }] })

  const openAiMessages = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({ role: msg.role, content: msg.text })),
    { role: "user", content: promptText },
  ]

  let finalAnswer = ""
  let stepsUsed = 0

  for (let step = 1; step <= maxSteps; step++) {
    signal?.throwIfAborted()
    stepsUsed = step
    onEvent({ type: "step", step, maxSteps })

    const reply = isOpenAi
      ? await callOpenAiStep({ settings, messages: openAiMessages, toolDefs, signal })
      : await callGeminiStep({ settings, systemPrompt, contents: geminiContents, toolDefs, signal })

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

    const geminiResponses = []
    for (const call of reply.toolCalls) {
      signal?.throwIfAborted()
      const start = performance.now()
      onEvent({ type: "tool_start", id: call.id, name: call.name, args: call.args })
      const outcome = await tools.execute(call.name, call.args, { allowEdits, allowWebSearch, signal })
      const durationMs = Math.round(performance.now() - start)
      const entry = {
        id: call.id,
        name: call.name,
        args: call.args,
        ok: outcome.ok,
        summary: outcome.ok ? outcome.summary : outcome.error,
        data: outcome.data,
        error: outcome.error,
        durationMs,
      }
      toolTrace.push(entry)
      onEvent({ type: "tool_end", ...entry })

      const serialized = JSON.stringify(outcome.ok ? { ok: true, summary: outcome.summary, data: outcome.data } : { ok: false, error: outcome.error })
      if (isOpenAi) {
        openAiMessages.push({ role: "tool", tool_call_id: call.id, content: serialized })
      } else {
        geminiResponses.push({
          functionResponse: {
            name: call.name,
            response: outcome.ok ? { ok: true, summary: outcome.summary, data: outcome.data } : { ok: false, error: outcome.error },
          },
        })
      }
    }
    if (!isOpenAi) {
      geminiContents.push({ role: "user", parts: geminiResponses })
    }

    if (step === maxSteps) {
      finalAnswer = answer || `Đã thực hiện ${toolTrace.length} bước công cụ (đạt giới hạn ${maxSteps} bước). Bạn có thể nhắn tiếp để AI tiếp tục.`
      onEvent({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
    }
  }

  const updatedHistory = [
    ...history,
    { role: "user", text: promptText },
    { role: "assistant", text: finalAnswer },
  ].slice(-20)

  return {
    answer: finalAnswer,
    thought: thoughts.join("\n\n"),
    steps: stepsUsed,
    toolTrace,
    updatedHistory,
  }
}
