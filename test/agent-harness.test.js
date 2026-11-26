import assert from "node:assert/strict"
import test from "node:test"
import { parseTextToolCalls, runAgentTurn, stripReasoning } from "../src/agent-harness.js"
import { executeToolBatch, TOOL_ABORTED_BEFORE_DISPATCH } from "../src/agent-pipeline.js"
import { createAgentTools } from "../src/agent-tools.js"
import { EXTERNAL_WEB_CONTENT_NOTICE } from "../src/web-search.js"

function makeHarnessContext() {
  const glossaryField = { value: "先生 = Thầy", dispatchEvent() {} }
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
  })
  return { state, glossaryField, tools, getCheckpoints: () => checkpoints, getRenders: () => renders }
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
  const { tools, glossaryField } = makeHarnessContext()
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
