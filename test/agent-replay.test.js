import assert from "node:assert/strict"
import test from "node:test"
import {
  REDACTED_MARKER,
  TURN_RECORD_LIMITS,
  approvalOf,
  createReplayToolStub,
  createTurnRecorder,
  exportTurnRecord,
  parseTurnRecord,
  redactText,
  redactValue,
  replayMatchesRecord,
  replayTurnRecord,
  serializeTurnRecord,
  turnDigest,
} from "../src/agent-replay.js"
import { runAgentTurn } from "../src/agent-harness.js"
import { createAgentTools } from "../src/agent-tools.js"
import {
  clearProjectTurnRecords,
  findProjectTurnRecord,
  loadProjectTurnRecords,
  saveProjectTurnRecord,
} from "../src/chat-storage.js"

function makeTurnContext({ approve } = {}) {
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
  const tools = createAgentTools({
    state,
    byId: (id) => (id === "translation-glossary" ? glossaryField : null),
    selectedPage: () => state.pages[0],
    selectedIndex: () => 0,
    checkpoint: () => {},
    render: () => {},
    readTranslationSettings: () => ({ source: "Japanese", target: "Vietnamese", direction: "rtl", notes: "", glossary: glossaryField.value }),
    makeBoxFn: (_page, rect, text) => ({ id: "b-new", ...rect, text, size: 24, font: "Arial", color: "#171717", align: "center", rotation: 0, fill: true }),
    autoFitBoxFn: () => 22,
    textOverflowsFn: (_page, box) => box.size > 25,
    onApproveTool: async ({ name, args }) => {
      approvals.push({ name, args })
      return approve ? approve(name, args) : { approved: true }
    },
  })
  return { state, glossaryField, tools, getApprovals: () => approvals }
}

// Each entry: the parts the fake provider answers with, one entry per step.
function geminiScript(partsList) {
  let index = 0
  return async () => {
    const parts = partsList[Math.min(index++, partsList.length - 1)]
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ candidates: [{ content: { role: "model", parts } }] }),
    }
  }
}

const geminiSettings = { provider: "gemini", key: "test-key", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese", direction: "rtl" }

test("turn records hide keys, authorization headers and URLs with userinfo", () => {
  const redacted = redactValue({
    apiKey: "sk-live-abcdefghijklmnop",
    baseUrl: "https://user:secret@example.com/v1",
    headers: { Authorization: "Bearer abcdefghijklmnop", "content-type": "application/json" },
    nested: {
      token: "AIzaSyA1234567890abcdefghijklmnop",
      note: "gọi https://admin:pw@host/x?api_key=zzz&page=2",
      title: "Không có gì bí mật",
    },
  })
  assert.equal(redacted.apiKey, REDACTED_MARKER)
  assert.equal(redacted.baseUrl, `https://${REDACTED_MARKER}@example.com/v1`)
  assert.equal(redacted.headers.Authorization, REDACTED_MARKER)
  assert.equal(redacted.headers["content-type"], "application/json")
  assert.equal(redacted.nested.token, REDACTED_MARKER)
  assert.equal(redacted.nested.note, `gọi https://${REDACTED_MARKER}@host/x?api_key=${REDACTED_MARKER}&page=2`)
  assert.equal(redacted.nested.title, "Không có gì bí mật")

  assert.equal(redactText("Authorization: Bearer abcdefghijklmnop"), `Authorization: Bearer ${REDACTED_MARKER}`)
  assert.equal(redactText("key sk-abcdefghijklmnopqrst"), `key ${REDACTED_MARKER}`)
  assert.equal(redactText("tavily tvly-abcdefgh1234"), `tavily ${REDACTED_MARKER}`)
  assert.equal(redactText("https://en.wikipedia.org/wiki/Test"), "https://en.wikipedia.org/wiki/Test")

  // Every field name the credential layer calls a secret stays hidden here as well.
  for (const field of ["geminiKey", "geminiApiKey", "openaiKey", "openaiApiKey", "llmKey", "api_key", "x-goog-api-key"]) {
    assert.equal(redactValue({ [field]: "giá-trị-bí-mật" })[field], REDACTED_MARKER, `${field} must be redacted`)
  }
  assert.equal(redactValue({ provider: "gemini", llmModel: "local" }).llmModel, "local")
})

test("a record is capped field by field, stays JSON-safe and keeps its digest across storage", () => {
  const recorder = createTurnRecorder({ id: "turn-caps", now: () => 1700000000000 })
  recorder.begin({
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    systemPrompt: "Hệ thống",
    runtimeReminder: "Nhắc",
    userMessage: "x".repeat(9000),
    flags: { allowEdits: true, allowWebSearch: false, planMode: false, confirmBulkEdits: true, maxSteps: 10 },
  })
  for (let step = 1; step <= TURN_RECORD_LIMITS.tools + 3; step++) {
    recorder.step({ step, text: "y".repeat(9000), thought: "z".repeat(9000), toolCalls: [{ name: "list_boxes" }] })
    recorder.tool({
      step,
      entry: {
        id: `tc${step}`,
        name: "list_boxes",
        args: { query: "q".repeat(4000) },
        category: "read",
        ok: true,
        summary: "s".repeat(9000),
        durationMs: 12,
      },
    })
    recorder.event({ type: "delta", step, text: "d".repeat(200), thought: "" })
  }
  recorder.finish({ status: "completed", elapsedMs: 900 })

  const record = recorder.snapshot()
  assert.equal(record.steps.length, TURN_RECORD_LIMITS.steps)
  assert.ok(record.truncated.steps >= 3)
  assert.equal(record.tools.length, TURN_RECORD_LIMITS.tools)
  assert.ok(record.truncated.tools >= 3)
  assert.match(record.steps[0].text, /lược bớt/)
  assert.ok(record.prompt.text.length <= TURN_RECORD_LIMITS.textChars + 48)
  assert.deepEqual(record.tools[0].args.truncated, true)
  assert.ok(record.tools[0].args.json.length <= TURN_RECORD_LIMITS.argsChars)
  // Deltas keep their size, never their text: the transcript must not be bigger than the answer.
  const deltas = record.events.filter((event) => event.type === "delta")
  assert.ok(deltas.length > 0 && deltas.every((event) => event.chars === 200 && !("text" in event)))

  // Bounding is a fixed point, otherwise a record kept growing each time it was loaded.
  const once = serializeTurnRecord(record)
  const twice = serializeTurnRecord(JSON.parse(once))
  assert.equal(twice, once)
  assert.equal(turnDigest(record), turnDigest(JSON.parse(twice)))
  assert.equal(JSON.stringify(record).length, JSON.stringify(JSON.parse(once)).length)
})

test("a record that came back from a file is re-redacted before it is trusted", () => {
  const recorder = createTurnRecorder({ id: "turn-parse", now: () => 5 })
  recorder.begin({ provider: "openai", model: "local", userMessage: "Xin chào" })
  recorder.step({ step: 1, text: "Xong", toolCalls: [] })
  recorder.finish({ status: "completed", elapsedMs: 3 })
  const record = recorder.snapshot()

  const tampered = { ...record, tools: [{ ...record.tools[0], name: "panic" }] }
  tampered.tools = [{
    step: 1,
    id: "tc1",
    name: "web_search",
    args: { headers: { Authorization: "Bearer abcdefghijklmnop" }, query: "https://u:p@host/a?token=zzz" },
    category: "web",
    ok: true,
    summary: "ok",
  }, ...record.tools].slice(0, 2)
  const parsed = parseTurnRecord(JSON.stringify(tampered))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.changed, true)
  assert.equal(parsed.record.tools[0].args.headers.Authorization, REDACTED_MARKER)
  assert.equal(parsed.record.tools[0].args.query, `https://${REDACTED_MARKER}@host/a?token=${REDACTED_MARKER}`)

  assert.equal(parseTurnRecord("{}").ok, false)
  assert.match(parseTurnRecord("{oops").error, /JSON/)
  assert.match(parseTurnRecord({ version: 99, id: "x", steps: [], tools: [] }).error, /Phiên bản/)
  assert.match(parseTurnRecord({ version: 1, steps: [], tools: [] }).error, /mã nhận diện/)
})

test("a recorded turn replays the same tool chain without the provider or a single tool call", async (t) => {
  const originalFetch = globalThis.fetch
  const { tools } = makeTurnContext()
  globalThis.fetch = geminiScript([
    [{ functionCall: { name: "list_boxes", args: { pageIndex: 1 } } }],
    [{ functionCall: { name: "search_chapter_text", args: { query: "こんにちは" } } }],
    [{ text: "Đã đọc trang 1 và tìm thấy câu thoại." }],
  ])
  t.after(() => { globalThis.fetch = originalFetch })

  const recorder = createTurnRecorder({ id: "turn-reads" })
  const result = await runAgentTurn({
    userMessage: "Đọc trang 1 rồi tìm câu thoại",
    settings: geminiSettings,
    tools,
    recorder,
  })

  const record = result.turnRecord
  assert.equal(record.status, "completed")
  assert.deepEqual(record.tools.map((entry) => entry.name), ["list_boxes", "search_chapter_text"])
  assert.equal(record.tools[0].approval, "not-required")
  assert.equal(record.prompt.text, "Đọc trang 1 rồi tìm câu thoại")
  assert.ok(record.prompt.runtimeReminder.length > 0)
  assert.match(record.model.promptHash, /^[0-9a-f]{8}$/)
  assert.equal(record.steps.length, 3)

  // Replay must not reach the network, so any fetch from here on is a failure.
  let fetched = 0
  globalThis.fetch = async () => {
    fetched++
    throw new Error("replay không được gọi nhà cung cấp")
  }
  const replay = await replayTurnRecord(record)
  assert.equal(fetched, 0)
  assert.equal(replay.ok, true)
  assert.equal(replay.identical, true)
  assert.equal(replayMatchesRecord(record, replay), true)
  assert.deepEqual(replay.toolChain.map((entry) => entry.name), ["list_boxes", "search_chapter_text"])
  assert.equal(replay.digest, turnDigest(record))
  const toolEntries = replay.entries.filter((entry) => entry.kind === "tool")
  assert.equal(toolEntries.length, 2)
  assert.equal(toolEntries.every((entry) => entry.executed === false && entry.state === "match"), true)
  assert.equal(replay.stub.calls, 2)

  // Determinism: the same transcript replays to the same trace, byte for byte.
  assert.deepEqual(await replayTurnRecord(record), replay)
})

test("a rejected approval is recorded as a decision and replays as the same rejection", async (t) => {
  const originalFetch = globalThis.fetch
  const { tools, state } = makeTurnContext({ approve: () => ({ approved: false, reason: "giữ nguyên bản gốc" }) })
  globalThis.fetch = geminiScript([
    [{ functionCall: { name: "delete_box", args: { boxId: "b1" } } }],
    [{ text: "Đã dừng vì người dùng từ chối." }],
  ])
  t.after(() => { globalThis.fetch = originalFetch })

  const recorder = createTurnRecorder({ id: "turn-rejected" })
  const result = await runAgentTurn({
    userMessage: "Xóa khung b1",
    settings: geminiSettings,
    tools,
    recorder,
    confirmBulkEdits: true,
  })

  const record = result.turnRecord
  assert.equal(record.tools.length, 1)
  assert.equal(record.tools[0].approvalRequired, true)
  assert.equal(record.tools[0].approval, "rejected")
  assert.equal(record.tools[0].ok, false)
  assert.match(record.tools[0].error, /từ chối/)
  // The refusal really did protect the page.
  assert.equal(state.pages[0].boxes.length, 1)

  const before = JSON.stringify(state.pages)
  const replay = await replayTurnRecord(record)
  assert.equal(replay.identical, true)
  const tool = replay.entries.find((entry) => entry.kind === "tool")
  assert.equal(tool.approval, "rejected")
  assert.equal(tool.ok, false)
  assert.match(tool.outcome, /từ chối/)
  assert.equal(replay.stub.mutationsPrevented, 1)
  // Replay never touches the document: the page is byte for byte what it was.
  assert.equal(JSON.stringify(state.pages), before)
})

test("an approved write is replayed from the record and never executed again", async (t) => {
  const originalFetch = globalThis.fetch
  const { tools, state, getApprovals } = makeTurnContext()
  globalThis.fetch = geminiScript([
    [{ functionCall: { name: "delete_box", args: { boxId: "b1" } } }],
    [{ text: "Đã xóa khung." }],
  ])
  t.after(() => { globalThis.fetch = originalFetch })

  const recorder = createTurnRecorder({ id: "turn-approved" })
  const result = await runAgentTurn({ userMessage: "Xóa khung b1", settings: geminiSettings, tools, recorder })
  assert.deepEqual(getApprovals().map((entry) => entry.name), ["delete_box"])
  assert.equal(result.turnRecord.tools[0].approval, "approved")

  const pageAfterTurn = JSON.stringify(state.pages)
  const replay = await replayTurnRecord(result.turnRecord)
  assert.equal(replay.identical, true)
  assert.equal(replay.stub.mutationsPrevented, 1)
  assert.equal(replay.stub.networkPrevented, 0)
  assert.equal(JSON.stringify(state.pages), pageAfterTurn)
  // Approving once must not approve a second time: the replay reads the recorded decision.
  assert.equal(getApprovals().length, 1)
})

test("a stopped turn keeps the steps that ran and replays as stopped", async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("không được gọi mạng trong bài kiểm tra này")
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const controller = new AbortController()
  controller.abort()
  const { tools } = makeTurnContext()
  const recorder = createTurnRecorder({ id: "turn-stopped" })
  await assert.rejects(() => runAgentTurn({
    userMessage: "Rà cả chương",
    settings: geminiSettings,
    tools,
    recorder,
    signal: controller.signal,
  }))
  // The caller closes the record when the turn is cut off.
  recorder.finish({ status: "stopped", error: "Người dùng đã dừng lượt này." })
  const record = recorder.snapshot()
  assert.equal(record.status, "stopped")
  assert.equal(record.steps.length, 0)
  assert.match(record.error, /dừng/)

  const replay = await replayTurnRecord(record)
  assert.equal(replay.status, "stopped")
  const end = replay.entries.at(-1)
  assert.equal(end.kind, "end")
  assert.equal(end.status, "stopped")
  assert.match(end.reason, /dừng/)
  assert.equal(replay.entries.filter((entry) => entry.kind === "step").length, 0)

  // An abandoned recorder (nobody called finish) still has to report a stopped turn.
  const abandoned = createTurnRecorder({ id: "turn-abandoned" })
  abandoned.begin({ provider: "gemini", model: "m", userMessage: "Chạy" })
  abandoned.step({ step: 1, text: "Đang làm", toolCalls: [] })
  const abandonedRecord = abandoned.snapshot()
  assert.equal(abandonedRecord.status, "stopped")
  assert.match(abandonedRecord.error, /dừng/)
})

test("a transcript that no longer matches the decisions is highlighted, not silently accepted", async () => {
  const recorder = createTurnRecorder({ id: "turn-drift", now: () => 7 })
  recorder.begin({ provider: "gemini", model: "m", userMessage: "Kiểm tra" })
  recorder.step({ step: 1, text: "Đọc", toolCalls: [{ name: "list_boxes" }, { name: "read_box" }] })
  recorder.tool({ step: 1, entry: { id: "tc1", name: "list_boxes", args: {}, category: "read", ok: true, summary: "2 khung" } })
  recorder.tool({ step: 1, entry: { id: "tc2", name: "read_box", args: { boxId: "b1" }, category: "read", ok: true, summary: "こんにちは" } })
  recorder.step({ step: 2, text: "Xong", toolCalls: [] })
  recorder.finish({ status: "completed", elapsedMs: 8 })
  const record = recorder.snapshot()

  const clean = await replayTurnRecord(record)
  assert.equal(clean.identical, true)

  // A transcript that lost a call of a step no longer reproduces the turn, and says so.
  const dropped = { ...record, tools: [record.tools[0]] }
  const replay = await replayTurnRecord(dropped)
  assert.equal(replay.ok, true)
  assert.equal(replay.identical, false)
  assert.ok(replay.differences.some((difference) => difference.kind === "count"))
  assert.equal(replayMatchesRecord(dropped, replay), false)

  // A call whose step has no model decision cannot be replayed at all.
  const orphaned = { ...record, steps: [record.steps[1]] }
  const orphanReplay = await replayTurnRecord(orphaned)
  assert.equal(orphanReplay.identical, false)
  assert.ok(orphanReplay.differences.some((difference) => difference.kind === "chain"))
  assert.ok(orphanReplay.warnings.some((warning) => warning.includes("không có bản ghi quyết định")))

  // The approval field is derived from the recorded outcome, never trusted on its own: an export that
  // claims an approval nobody recorded is rewritten, and the record says it was rewritten.
  const invented = {
    ...record,
    tools: record.tools.map((tool, index) => (index === 0 ? { ...tool, approval: "rejected", approvalRequired: true } : tool)),
  }
  const inventedParsed = parseTurnRecord(JSON.stringify(invented))
  assert.equal(inventedParsed.changed, true)
  assert.equal(inventedParsed.record.tools[0].approval, "approved")
  assert.equal((await replayTurnRecord(inventedParsed.record)).identical, true)
})

test("replay refuses real tools and only ever answers from the stub", async () => {
  const recorder = createTurnRecorder({ id: "turn-guard" })
  recorder.begin({ provider: "gemini", model: "m", userMessage: "Xóa" })
  recorder.step({ step: 1, text: "", toolCalls: [{ name: "delete_box" }] })
  recorder.tool({ step: 1, entry: { id: "tc1", name: "delete_box", args: { boxId: "b1" }, category: "write", ok: true, approvalRequired: true, summary: "Đã xóa" } })
  recorder.finish({ status: "completed" })
  const record = recorder.snapshot()

  let executed = 0
  const realTools = {
    definitions: () => [],
    isConcurrencySafe: () => false,
    categoryOf: () => "write",
    timeoutMs: () => 0,
    needsApproval: () => true,
    execute: async () => {
      executed++
      return { ok: true, summary: "đã chạy thật" }
    },
  }
  await assert.rejects(() => replayTurnRecord(record, { tools: realTools }), /công cụ giả lập/)
  assert.equal(executed, 0)

  const stub = createReplayToolStub(record)
  const outOfOrder = await stub.execute("update_box", { boxId: "b1", text: "x" })
  assert.equal(outOfOrder.ok, false)
  assert.equal(outOfOrder.code, "REPLAY_OUT_OF_ORDER")
  const served = await stub.execute("delete_box", { boxId: "b1" })
  assert.equal(served.ok, true)
  assert.equal(served.summary, "Đã xóa")
  assert.deepEqual(stub.snapshot(), { calls: 1, mutationsPrevented: 1, networkPrevented: 0, outOfOrder: 1, remaining: 0, total: 1 })
  assert.equal(executed, 0)
})

test("a record exports to a file that parses back to the same run", async () => {
  const recorder = createTurnRecorder({ id: "turn-export", now: () => 11 })
  recorder.begin({ provider: "openai", model: "local-llm", userMessage: "Tóm tắt" })
  recorder.step({ step: 1, text: "Xong", toolCalls: [] })
  recorder.usage({ calls: 1, promptTokens: 12, completionTokens: 4, cachedTokens: 0, totalTokens: 16, costUsd: 0, unpricedCalls: 1, estimatedCalls: 0 })
  recorder.finish({ status: "completed", elapsedMs: 25 })
  const record = recorder.snapshot()

  const { filename, json } = exportTurnRecord(record)
  assert.equal(filename, "nixio-luot-turn-export.json")
  const parsed = parseTurnRecord(json)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.changed, false)
  assert.equal(turnDigest(parsed.record), turnDigest(record))
  assert.equal(parsed.record.usage.totalTokens, 16)
  assert.equal(exportTurnRecord(record, { pretty: false }).json.includes("\n  "), false)
})

test("a recorded step keeps the provider's own token counts", () => {
  const make = (usage) => {
    const recorder = createTurnRecorder({ id: "turn-usage" })
    recorder.begin({ provider: "gemini", model: "m", userMessage: "Hỏi" })
    recorder.step({ step: 1, text: "Đáp", usage, toolCalls: [] })
    recorder.finish({ status: "completed" })
    return recorder.snapshot().steps[0].usage
  }
  // Gemini's usageMetadata names and OpenAI's usage names both survive normalization.
  assert.deepEqual(make({ promptTokenCount: 21, candidatesTokenCount: 9, cachedContentTokenCount: 3, totalTokenCount: 30 }), {
    promptTokens: 21,
    outputTokens: 9,
    completionTokens: 9,
    cachedTokens: 3,
    totalTokens: 30,
  })
  assert.deepEqual(make({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 2 } }), {
    promptTokens: 12,
    outputTokens: 4,
    completionTokens: 4,
    cachedTokens: 2,
    totalTokens: 16,
  })
  assert.equal(make({ promptTokenCount: "12", unrelated: 3 }), null)
})

test("turn records persist per project, stay bounded and keep the newest first", () => {
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  const makeRecord = (id, extra = {}) => {
    const recorder = createTurnRecorder({ id, now: () => 100 })
    recorder.begin({ provider: "gemini", model: "m", userMessage: "Hỏi" })
    recorder.step({ step: 1, text: "Đáp", toolCalls: [] })
    recorder.finish({ status: "completed", elapsedMs: 5 })
    return { ...recorder.snapshot(), ...extra }
  }

  assert.equal(saveProjectTurnRecord("proj-a", makeRecord("turn-1"), storage), true)
  assert.equal(saveProjectTurnRecord("proj-a", makeRecord("turn-2"), storage), true)
  const stored = loadProjectTurnRecords("proj-a", storage)
  assert.deepEqual(stored.map((record) => record.id), ["turn-2", "turn-1"])
  assert.equal(findProjectTurnRecord("proj-a", "latest", storage).id, "turn-2")
  assert.equal(findProjectTurnRecord("proj-a", "turn-1", storage).id, "turn-1")
  assert.equal(findProjectTurnRecord("proj-a", "missing", storage), null)
  assert.deepEqual(loadProjectTurnRecords("proj-b", storage), [])

  // Re-saving the same id replaces it instead of duplicating.
  assert.equal(saveProjectTurnRecord("proj-a", makeRecord("turn-1"), storage), true)
  assert.deepEqual(loadProjectTurnRecords("proj-a", storage).map((record) => record.id), ["turn-1", "turn-2"])

  for (let index = 0; index < 12; index++) saveProjectTurnRecord("proj-a", makeRecord(`turn-x${index}`), storage)
  const capped = loadProjectTurnRecords("proj-a", storage)
  assert.ok(capped.length <= 8)
  assert.equal(capped[0].id, "turn-x11")

  // A key hidden in an argument never reaches storage, even when it arrives in a hand-made record.
  const leaky = makeRecord("turn-leaky", {
    tools: [{
      step: 1,
      id: "tc1",
      name: "web_search",
      args: { apiKey: "sk-live-abcdefghijklmnop", url: "https://u:p@host/a" },
      category: "web",
      ok: true,
      summary: "ok",
    }],
  })
  saveProjectTurnRecord("proj-c", leaky, storage)
  const raw = store.get("khung-thoai-chat-turn-records")
  assert.equal(raw.includes("sk-live-abcdefghijklmnop"), false)
  assert.equal(raw.includes("u:p@host"), false)
  assert.equal(loadProjectTurnRecords("proj-c", storage)[0].tools[0].args.apiKey, REDACTED_MARKER)

  clearProjectTurnRecords("proj-a", storage)
  assert.deepEqual(loadProjectTurnRecords("proj-a", storage), [])
  assert.equal(loadProjectTurnRecords("proj-c", storage).length, 1)
})

test("approvalOf names the decision the transcript will show", () => {
  assert.equal(approvalOf({ approvalRequired: false }), "not-required")
  assert.equal(approvalOf({ approvalRequired: true, ok: true }), "approved")
  assert.equal(approvalOf({ approvalRequired: true, ok: false, code: "TOOL_APPROVAL_REJECTED" }), "rejected")
  assert.equal(approvalOf({ approvalRequired: true, ok: false, code: "TOOL_APPROVAL_UNAVAILABLE" }), "unavailable")
  assert.equal(approvalOf({ approvalRequired: true, ok: false }), "blocked")
})
