import assert from "node:assert/strict"
import test from "node:test"
import { parseTextToolCalls, runAgentTurn, stripReasoning } from "../src/agent-harness.js"
import { executeToolBatch, TOOL_ABORTED_BEFORE_DISPATCH } from "../src/agent-pipeline.js"
import { createAgentTools } from "../src/agent-tools.js"
import { EXTERNAL_WEB_CONTENT_NOTICE } from "../src/web-search.js"

function makeHarnessContext({ approve } = {}) {
  const glossaryField = { value: "先生 = Thầy", dispatchEvent() {} }
  const approvals = []
  const state = {
    pages: [{
      id: "p1",
      name: "01.png",
      image: { naturalWidth: 800, naturalHeight: 1200 },
      boxes: [{
        id: "b1", text: "こんにちは", x: .1, y: .1, w: .3, h: .15,
        size: 40, font: "Arial", color: "#171717", align: "center", rotation: 0, fill: true,
      }],
      unplaced: [],
    }],
    queue: [],
    pageId: "p1",
    boxId: "b1",
    selectedBoxIds: new Set(["b1"]),
  }
  let checkpoints = 0
  let renders = 0
  const tools = createAgentTools({
    state,
    byId: (id) => (id === "translation-glossary" ? glossaryField : null),
    selectedPage: () => state.pages[0],
    selectedIndex: () => 0,
    checkpoint: () => { checkpoints++ },
    render: () => { renders++ },
    readTranslationSettings: () => ({ source: "Japanese", target: "Vietnamese", direction: "rtl", notes: "", glossary: glossaryField.value }),
    searchWebFn: async (query) => ({
      query,
      provider: "mock",
      results: [{ title: "Test Wiki", url: "https://en.wikipedia.org/wiki/Test", snippet: "Meaning of term", source: "mock" }],
    }),
    fetchWebPageFn: async (url) => ({ url, title: "Test Wiki", text: "Full wiki content." }),
    makeBoxFn: (_page, rect, text) => ({ id: "b-new", ...rect, text, size: 24, font: "Arial", color: "#171717", align: "center", rotation: 0, fill: true }),
    autoFitBoxFn: () => 22,
    textOverflowsFn: (_page, box) => box.size > 25,
    onApproveTool: async ({ name, args }) => {
      approvals.push({ name, args })
      return approve ? approve(name, args) : { approved: true }
    },
  })
  return {
    state,
    glossaryField,
    tools,
    getCheckpoints: () => checkpoints,
    getRenders: () => renders,
    getApprovals: () => approvals,
  }
}

test("createAgentTools enforces read-only / web-search permissions and checkpoints every mutation", async () => {
  const { state, glossaryField, tools, getCheckpoints } = makeHarnessContext()

  assert.equal(tools.definitions({ allowEdits: false, allowWebSearch: false }).every((d) => !["web_search", "update_box"].includes(d.name)), true)
  const blockedEdit = await tools.execute("update_box", { boxId: "b1", text: "Blocked" }, { allowEdits: false })
  assert.equal(blockedEdit.ok, false)
  assert.equal(state.pages[0].boxes[0].text, "こんにちは")

  const blockedWeb = await tools.execute("web_search", { query: "manga" }, { allowWebSearch: false })
  assert.equal(blockedWeb.ok, false)

  const updated = await tools.execute("update_box", { boxId: "b1", text: "Xin chào!", size: 28 }, { allowEdits: true })
  assert.equal(updated.ok, true)
  assert.equal(state.pages[0].boxes[0].text, "Xin chào!")
  assert.equal(state.pages[0].boxes[0].size, 28)

  const gloss = await tools.execute("update_glossary", { entries: ["五条悟 = Gojo Satoru", "先生 = Thầy giáo"] }, { allowEdits: true })
  assert.equal(gloss.ok, true)
  assert.equal(glossaryField.value, "先生 = Thầy giáo\n五条悟 = Gojo Satoru")

  const fitted = await tools.execute("autofit_page", {}, { allowEdits: true })
  assert.equal(fitted.ok, true)
  assert.equal(state.pages[0].boxes[0].size, 22)
  assert.equal(getCheckpoints(), 3)
})

test("runAgentTurn executes multi-step Gemini functionCall -> functionResponse loop", async (t) => {
  const originalFetch = globalThis.fetch
  const { tools, glossaryField, getApprovals } = makeHarnessContext()
  let callIndex = 0
  globalThis.fetch = async () => {
    callIndex++
    if (callIndex === 1) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              role: "model",
              parts: [{ functionCall: { name: "web_search", args: { query: "五条悟" } } }],
            },
          }],
        }),
      }
    }
    if (callIndex === 2) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              role: "model",
              parts: [{ functionCall: { name: "update_glossary", args: { entries: ["五条悟 = Gojo Satoru"] } } }],
            },
          }],
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: { role: "model", parts: [{ text: "Đã tra web và bổ sung Gojo Satoru vào bảng thuật ngữ." }] },
        }],
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const events = []
  const result = await runAgentTurn({
    userMessage: "Tra nhân vật 五条悟 rồi thêm vào bảng thuật ngữ",
    settings: { provider: "gemini", key: "test-key", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese" },
    tools,
    onEvent: (e) => events.push(e.type),
  })

  assert.equal(result.steps, 3)
  assert.equal(result.toolTrace.length, 2)
  assert.equal(result.toolTrace[0].name, "web_search")
  assert.equal(result.toolTrace[1].name, "update_glossary")
  assert.ok(glossaryField.value.includes("五条悟 = Gojo Satoru"))
  // Reading the web in this turn forces every later write through explicit approval.
  assert.deepEqual(getApprovals().map((a) => a.name), ["update_glossary"])
  assert.match(result.answer, /Gojo Satoru/)
  assert.ok(events.includes("tool_start") && events.includes("tool_end") && events.includes("assistant"))
})

test("runAgentTurn executes OpenAI-compatible tool_calls and parses <tool_call>/<think> fallback", async (t) => {
  const originalFetch = globalThis.fetch
  const { tools } = makeHarnessContext()
  let step = 0
  globalThis.fetch = async () => {
    step++
    if (step === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '<think>Need to inspect boxes first</think><tool_call>{"name":"list_boxes","arguments":{}}</tool_call>',
            },
          }],
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: "<think>Done</think>Trang 1 có 1 khung đang bị tràn chữ (40px).",
          },
        }],
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  assert.equal(parseTextToolCalls('<tool_call>{"name":"web_search","arguments":{"query":"abc"}}</tool_call>')[0].name, "web_search")
  assert.deepEqual(stripReasoning("<think>abc</think>Hello"), { thought: "abc", answer: "Hello" })

  const result = await runAgentTurn({
    userMessage: "Kiểm tra khung trang này",
    settings: {
      provider: "openai",
      baseUrl: "http://localhost:11434/v1",
      llmModel: "qwen2.5:7b",
      apiKey: "",
      source: "Japanese",
      target: "Vietnamese",
    },
    tools,
  })
  assert.equal(result.steps, 2)
  assert.equal(result.toolTrace[0].name, "list_boxes")
  assert.equal(result.toolTrace[0].data.boxes[0].overflow, true)
  assert.equal(result.thought, "Need to inspect boxes first\n\nDone")
  assert.match(result.answer, /tràn chữ/)
})

test("executeToolBatch runs concurrency-safe tools in parallel, enforces exclusive barriers, and preserves order", async () => {
  const timeline = []
  const fakeTools = {
    isConcurrencySafe: (name) => name === "read_a" || name === "read_b",
    timeoutMs: () => 5000,
    async execute(name, args) {
      timeline.push("start:" + name)
      const delay = name === "read_a" ? 30 : name === "read_b" ? 5 : 5
      await new Promise((r) => setTimeout(r, delay))
      timeline.push("end:" + name)
      return { ok: true, summary: name, data: args }
    },
  }
  const results = await executeToolBatch(
    [
      { id: "1", name: "read_a", args: { k: 1 } },
      { id: "2", name: "read_b", args: { k: 2 } },
      { id: "3", name: "mutate", args: { k: 3 } },
    ],
    { tools: fakeTools, maxParallel: 4 },
  )
  // Both reads must start before either finishes; mutate must start strictly after both reads end.
  assert.ok(timeline.indexOf("start:read_b") < timeline.indexOf("end:read_a"))
  assert.ok(timeline.indexOf("start:mutate") > timeline.indexOf("end:read_a"))
  assert.ok(timeline.indexOf("start:mutate") > timeline.indexOf("end:read_b"))
  assert.deepEqual(results.map((r) => r.id), ["1", "2", "3"])

  // Pre-aborted batch synthesizes TOOL_ABORTED_BEFORE_DISPATCH for skipped calls.
  const controller = new AbortController()
  controller.abort()
  const aborted = await executeToolBatch([{ id: "9", name: "read_a", args: {} }], {
    tools: fakeTools,
    signal: controller.signal,
  })
  assert.equal(aborted[0].code, TOOL_ABORTED_BEFORE_DISPATCH)
})

test("web_search supports multi-query deduplication and fences web output with EXTERNAL_WEB_CONTENT_NOTICE", async () => {
  const { tools } = makeHarnessContext()
  assert.equal(tools.isConcurrencySafe("web_search"), true)
  assert.equal(tools.isConcurrencySafe("update_box"), false)

  const searchRes = await tools.execute("web_search", { queries: ["Gojo", "Sukuna", "Gojo"] }, { allowWebSearch: true })
  assert.equal(searchRes.ok, true)
  assert.deepEqual(searchRes.data.queries, ["Gojo", "Sukuna"])
  assert.ok(searchRes.modelText.startsWith(EXTERNAL_WEB_CONTENT_NOTICE))

  const fetchRes = await tools.execute("fetch_url", { url: "https://en.wikipedia.org/wiki/Test" }, { allowWebSearch: true })
  assert.equal(fetchRes.ok, true)
  assert.ok(fetchRes.modelText.startsWith(EXTERNAL_WEB_CONTENT_NOTICE))
})

test("runAgentTurn approves bulk/destructive writes by default and forces approval after web content", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const settings = {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    llmModel: "qwen2.5:7b",
    source: "Japanese",
    target: "Vietnamese",
  }
  const toolReply = (name, args) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "c_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    }),
  })
  const finalReply = {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "Đã xong." } }] }),
  }
  const script = (steps) => {
    let index = 0
    return async () => (index < steps.length ? steps[index++] : finalReply)
  }

  // Default (confirmBulkEdits omitted) now routes a destructive write through approval.
  {
    const { state, tools, getApprovals } = makeHarnessContext()
    globalThis.fetch = script([toolReply("delete_box", { boxId: "b1" })])
    await runAgentTurn({ userMessage: "Xóa khung b1", settings, tools })
    assert.deepEqual(getApprovals().map((a) => a.name), ["delete_box"])
    assert.equal(state.pages[0].boxes.length, 0)
  }

  // Explicit opt-out still skips approval for ordinary (non-bulk) edits.
  {
    const { tools, getApprovals } = makeHarnessContext()
    globalThis.fetch = script([toolReply("update_box", { boxId: "b1", text: "Mới" })])
    await runAgentTurn({ userMessage: "Sửa khung b1", settings, tools, confirmBulkEdits: false })
    assert.equal(getApprovals().length, 0)
  }

  // ...but once the turn has read web content, even confirmBulkEdits: false cannot skip approval.
  {
    const { tools, getApprovals } = makeHarnessContext()
    globalThis.fetch = script([
      toolReply("web_search", { query: "manga" }),
      toolReply("update_box", { boxId: "b1", text: "Nội dung lấy từ web" }),
    ])
    const result = await runAgentTurn({
      userMessage: "Tra web rồi sửa khung",
      settings,
      tools,
      confirmBulkEdits: false,
      maxSteps: 4,
    })
    assert.deepEqual(getApprovals().map((a) => a.name), ["update_box"])
    assert.equal(result.toolTrace[1].ok, true)
  }

  // A denied approval keeps the document untouched.
  {
    const { state, tools, getApprovals } = makeHarnessContext({ approve: () => ({ approved: false, reason: "Không đồng ý" }) })
    globalThis.fetch = script([
      toolReply("web_search", { query: "manga" }),
      toolReply("update_box", { boxId: "b1", text: "Bị chặn" }),
    ])
    const result = await runAgentTurn({
      userMessage: "Tra web rồi sửa khung",
      settings,
      tools,
      confirmBulkEdits: false,
      maxSteps: 4,
    })
    assert.equal(getApprovals().length, 1)
    assert.equal(result.toolTrace[1].ok, false)
    assert.equal(state.pages[0].boxes[0].text, "こんにちは")
  }
})

test("tools.execute fails closed when a write needs approval but no approver is registered", async () => {
  const state = {
    pages: [{
      id: "p1",
      name: "01.png",
      image: { naturalWidth: 800, naturalHeight: 1200 },
      boxes: [{ id: "b1", text: "Giữ nguyên", x: 0.1, y: 0.1, w: 0.3, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" }],
      unplaced: [],
    }],
    queue: [],
    pageId: "p1",
    boxId: "b1",
    selectedBoxIds: new Set(["b1"]),
  }
  const tools = createAgentTools({
    state,
    byId: () => null,
    selectedPage: () => state.pages[0],
    selectedIndex: () => 0,
    checkpoint: () => {},
    render: () => {},
  })

  const blocked = await tools.execute("update_box", { boxId: "b1", text: "Đổi" }, { allowEdits: true, forceWriteApproval: true })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /phê duyệt/)
  assert.equal(state.pages[0].boxes[0].text, "Giữ nguyên")

  assert.equal(tools.needsApproval("update_box", {}, { forceWriteApproval: true }), true)
  assert.equal(tools.needsApproval("update_box", {}, { confirmBulkEdits: false, forceWriteApproval: false }), false)
  assert.equal(tools.needsApproval("delete_box", {}, { confirmBulkEdits: true }), true)
})

test("parseTextToolCalls decodes JSON-string arguments from text-form tool calls", () => {
  const [call] = parseTextToolCalls('<tool_call>{"name":"update_box","arguments":"{\\"boxId\\":\\"b1\\",\\"text\\":\\"hi\\"}"}</tool_call>')
  assert.equal(call.name, "update_box")
  assert.deepEqual(call.args, { boxId: "b1", text: "hi" })
  // Undecodable or non-object arguments degrade to {} instead of throwing.
  assert.deepEqual(parseTextToolCalls('<tool_call>{"name":"web_search","arguments":"{bad"}</tool_call>')[0].args, {})
  assert.deepEqual(parseTextToolCalls('<tool_call>{"name":"list_boxes","arguments":"5"}</tool_call>')[0].args, {})
})

test("runAgentTurn keeps streamed OpenAI tool_call arguments when deltas omit index", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const encoder = new TextEncoder()
  const makeSseStream = (chunks) => new ReadableStream({
    start(controller) {
      for (const line of chunks) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })

  let call = 0
  globalThis.fetch = async () => {
    call++
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: makeSseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"search_chapter_text","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"query\\":\\"こんにちは\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ choices: [{ message: { content: "Xong." } }] }),
    }
  }

  const { tools } = makeHarnessContext()
  const result = await runAgentTurn({
    userMessage: "Tìm khung thoại chứa lời chào",
    settings: {
      provider: "openai",
      baseUrl: "http://localhost:11434/v1",
      llmModel: "qwen2.5:7b",
      source: "Japanese",
      target: "Vietnamese",
    },
    tools,
    stream: true,
  })
  assert.equal(result.toolTrace[0].name, "search_chapter_text")
  assert.deepEqual(result.toolTrace[0].args, { query: "こんにちは" })
  assert.equal(result.toolTrace[0].data.matches.length, 1)
})

// Regression for #136: when the first fragment carried the id and the argument fragments carried
// only the index, the index opened a second slot with no name, and the final filter dropped it, so
// the call ran with empty arguments.
test("streamed tool_call arguments survive id and index arriving in separate fragments", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const encoder = new TextEncoder()
  let call = 0
  globalThis.fetch = async () => {
    call++
    if (call === 1) {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"search_chapter_text","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"こんにちは\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"type":"function","function":{"name":"list_boxes","arguments":"{"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","function":{"arguments":"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            for (const line of chunks) controller.enqueue(encoder.encode(line))
            controller.close()
          },
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ choices: [{ message: { content: "Xong." } }] }),
    }
  }

  const { tools } = makeHarnessContext()
  const result = await runAgentTurn({
    userMessage: "Tìm khung thoại chứa lời chào",
    settings: {
      provider: "openai",
      baseUrl: "http://localhost:11434/v1",
      llmModel: "qwen2.5:7b",
      source: "Japanese",
      target: "Vietnamese",
    },
    tools,
    stream: true,
  })
  assert.equal(result.toolTrace.length, 2)
  assert.equal(result.toolTrace[0].name, "search_chapter_text")
  assert.deepEqual(result.toolTrace[0].args, { query: "こんにちは" })
  assert.equal(result.toolTrace[1].name, "list_boxes")
  assert.deepEqual(result.toolTrace[1].args, {})
})

test("runAgentTurn context budget counts the system prompt once per provider message shape", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const baseSettings = {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    llmModel: "qwen2.5:7b",
    source: "Japanese",
    target: "Vietnamese",
  }

  let openAiBody = null
  globalThis.fetch = async (_url, init) => {
    openAiBody = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ choices: [{ message: { content: "Chào bạn." } }] }),
    }
  }
  const { tools } = makeHarnessContext()
  const openAiResult = await runAgentTurn({ userMessage: "hello", settings: baseSettings, tools })
  // The system prompt already travels as messages[0]; the fallback estimate must not add it twice.
  assert.equal(openAiResult.contextBudget.estimated, true)
  assert.equal(openAiResult.contextBudget.usedTokens, Math.ceil(JSON.stringify(openAiBody.messages).length / 3.6))

  let geminiBody = null
  globalThis.fetch = async (_url, init) => {
    geminiBody = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Chào bạn." }] } }] }),
    }
  }
  const geminiResult = await runAgentTurn({
    userMessage: "hello",
    settings: { ...baseSettings, provider: "gemini", key: "test-key", model: "auto" },
    tools,
  })
  // Gemini keeps systemInstruction outside contents, so its system prompt is still counted.
  assert.equal(geminiResult.contextBudget.estimated, true)
  assert.equal(
    geminiResult.contextBudget.usedTokens,
    Math.ceil((geminiBody.systemInstruction.parts[0].text.length + JSON.stringify(geminiBody.contents).length) / 3.6),
  )
})

test("a host without needsApproval still gates writes after an untrusted read, and the bulk switch (#review)", async () => {
  // Old hosts passed only requiresApproval, so the pipeline has to keep applying both gates itself.
  const tools = {
    timeoutMs: () => 0,
    categoryOf: (name) => (name === "update_box" ? "write" : "read"),
    requiresApproval: (name) => name === "delete_box",
    async execute(name) {
      return { ok: true, summary: name, data: {} }
    },
  }
  const approvalOf = async (name, options) => {
    const [result] = await executeToolBatch([{ id: name, name, args: {} }], { tools, ...options })
    return result.approvalRequired
  }

  assert.equal(await approvalOf("list_boxes", {}), false)
  assert.equal(await approvalOf("update_box", { forceWriteApproval: true }), true, "an untrusted read makes every write wait")
  assert.equal(await approvalOf("update_box", { forceWriteApproval: false }), false)
  assert.equal(await approvalOf("delete_box", { confirmBulkEdits: true }), true)
  assert.equal(await approvalOf("list_boxes", { confirmBulkEdits: true }), false, "reads are never gated by the bulk switch")
})
