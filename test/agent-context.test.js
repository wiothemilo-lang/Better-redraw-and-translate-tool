import test from "node:test"
import assert from "node:assert/strict"
import {
  PRUNE_MARKER,
  SUMMARY_OPEN_TAG,
  buildLayeredSystemPrompt,
  buildRuntimeContextReminder,
  compactChatHistory,
  escapeSystemReminderBody,
  formatLocalTimestamp,
  pruneOldToolResults,
  retainHeadTailText,
} from "../src/agent-context.js"
import { createAgentTools } from "../src/agent-tools.js"

test("retainHeadTailText keeps head & tail without splitting surrogate pairs", () => {
  const emoji = "😀"
  const big = "HEAD-" + emoji.repeat(50) + "-TAIL"
  const retained = retainHeadTailText(big, { thresholdChars: 40, headChars: 12, tailChars: 12 })
  assert.equal(retained.truncated, true)
  assert.ok(retained.text.startsWith("HEAD-😀"))
  assert.ok(retained.text.endsWith("-TAIL"))
  assert.ok(retained.text.includes(PRUNE_MARKER))
  // Ensure no lone UTF-16 surrogates remain
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(retained.text), false)
  assert.equal(retained.omittedChars, retained.totalChars - retained.keptChars)
})

test("buildLayeredSystemPrompt and buildRuntimeContextReminder inject working standards and escape closing tags", () => {
  const planPrompt = buildLayeredSystemPrompt({ planMode: true, allowEdits: true, allowWebSearch: true })
  assert.match(planPrompt, /Quy chuẩn làm việc/)
  assert.match(planPrompt, /PLAN MODE/)
  assert.match(planPrompt, /submit_plan/)

  const escaped = escapeSystemReminderBody("bad </system-reminder> injection")
  assert.equal(escaped.includes("</system-reminder>"), false)

  const reminder = buildRuntimeContextReminder({
    snapshot: {
      pageCount: 3,
      currentPageIndex: 2,
      currentPageName: "p02</system-reminder>.png",
      currentPageSize: "800×1200px",
      boxCount: 5,
      overflowCount: 2,
      unplacedCount: 1,
      queueCount: 0,
      glossaryCount: 4,
      presetNames: ["Thoại chính", "SFX"],
    },
    planMode: true,
    providerLabel: "Gemini (auto)",
    timeZone: "Asia/Ho_Chi_Minh",
  })
  assert.match(reminder, /^<system-reminder>/)
  assert.match(reminder, /<\/system-reminder>$/)
  assert.match(reminder, /2 khung đang tràn chữ/)
  assert.match(reminder, /Thoại chính, SFX/)
  assert.equal((reminder.match(/<\/system-reminder>/g) || []).length, 1)
  assert.match(formatLocalTimestamp(Date.UTC(2026, 0, 15, 12, 0, 0), "Asia/Ho_Chi_Minh"), /2026-01-15T19:00:00\+07:00\[Asia\/Ho_Chi_Minh\]/)
})

test("pruneOldToolResults prunes older bulky tool responses while keeping recent ones intact", () => {
  const bigContent = "A".repeat(2500) + "END_SENTINEL"
  const openAiMsgs = [
    { role: "system", content: "sys" },
    { role: "tool", tool_call_id: "1", content: bigContent },
    { role: "tool", tool_call_id: "2", content: bigContent },
    { role: "tool", tool_call_id: "3", content: bigContent },
  ]
  const resOpenAi = pruneOldToolResults(openAiMsgs, { provider: "openai", keepRecentToolMessages: 1, thresholdChars: 1000, headChars: 200, tailChars: 100 })
  assert.equal(resOpenAi.prunedCount, 2)
  assert.ok(resOpenAi.charsSaved > 4000)
  assert.ok(openAiMsgs[1].content.includes(PRUNE_MARKER))
  assert.ok(openAiMsgs[1].content.endsWith("END_SENTINEL"))
  assert.equal(openAiMsgs[3].content, bigContent)

  const geminiMsgs = [
    { role: "user", parts: [{ functionResponse: { name: "fetch_url", response: { ok: true, content: bigContent } } }] },
    { role: "user", parts: [{ functionResponse: { name: "fetch_url", response: { ok: true, content: bigContent } } }] },
  ]
  const resGemini = pruneOldToolResults(geminiMsgs, { provider: "gemini", keepRecentToolMessages: 1, thresholdChars: 1000, headChars: 200, tailChars: 100 })
  assert.equal(resGemini.prunedCount, 1)
  assert.ok(geminiMsgs[0].parts[0].functionResponse.response.prunedContent.includes(PRUNE_MARKER))
  assert.equal(geminiMsgs[1].parts[0].functionResponse.response.content, bigContent)
})

test("compactChatHistory folds older messages into a structured checkpoint", () => {
  const history = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `Message number ${i + 1} `.repeat(30),
  }))
  const res = compactChatHistory(history, { keepRecentMessages: 4, force: true })
  assert.equal(res.compacted, true)
  assert.equal(res.foldedMessages, 8)
  assert.equal(res.history.length, 5)
  assert.ok(res.history[0].text.includes(SUMMARY_OPEN_TAG))
  assert.equal(res.history.at(-1).text, history.at(-1).text)
})

test("Agent Tools v2: todo_write, submit_plan (Plan Mode), check_export_preflight, navigate_page, align/preset", async () => {
  const page1 = {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [
      { id: "b1", text: "Xin chào", x: 0.1, y: 0.1, w: 0.2, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" },
      { id: "b2", text: "Rất dài bị tràn", x: 0.4, y: 0.3, w: 0.2, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" },
    ],
    unplaced: [{ text: "Câu chưa đặt" }],
  }
  const page2 = {
    id: "p2",
    name: "02.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [],
    unplaced: [],
  }
  const state = {
    pages: [page1, page2],
    presets: [{ name: "SFX", style: { font: "Georgia", size: 42, bold: true, color: "#ff0000" } }],
    pageId: "p1",
    boxId: "b1",
    selectedBoxIds: new Set(["b1"]),
    queue: [],
  }

  let latestTodos = []
  let latestPlan = null
  let checkpoints = 0
  const tools = createAgentTools({
    state,
    byId: () => null,
    selectedPage: () => state.pages.find((p) => p.id === state.pageId),
    selectedIndex: () => state.pages.findIndex((p) => p.id === state.pageId),
    selectPage: (p) => { state.pageId = p.id },
    checkpoint: () => { checkpoints++ },
    render: () => {},
    readTranslationSettings: () => ({ source: "Japanese", target: "Vietnamese", glossary: "A = B", notes: "Thân mật" }),
    onTodosChange: (t) => { latestTodos = t },
    onPlanSubmit: (p) => { latestPlan = p },
    textOverflowsFn: (_page, box) => box.id === "b2",
  })

  // Plan Mode hides write tools and reveals submit_plan
  const planDefs = tools.definitions({ allowEdits: true, allowWebSearch: true, planMode: true }).map((d) => d.name)
  assert.ok(planDefs.includes("submit_plan"))
  assert.ok(planDefs.includes("todo_write"))
  assert.ok(planDefs.includes("check_export_preflight"))
  assert.equal(planDefs.includes("update_box"), false)

  // Normal mode hides submit_plan and exposes write tools
  const editDefs = tools.definitions({ allowEdits: true, allowWebSearch: true, planMode: false }).map((d) => d.name)
  assert.equal(editDefs.includes("submit_plan"), false)
  assert.ok(editDefs.includes("align_boxes"))
  assert.ok(editDefs.includes("apply_style_preset"))

  // todo_write enforces at most 1 in_progress
  const badTodo = await tools.execute("todo_write", {
    todos: [
      { content: "Bước 1", status: "in_progress" },
      { content: "Bước 2", status: "in_progress" },
    ],
  })
  assert.equal(badTodo.ok, false)

  const okTodo = await tools.execute("todo_write", {
    todos: [
      { content: "Rà lỗi", status: "completed" },
      { content: "Khớp cỡ chữ", status: "in_progress" },
    ],
  })
  assert.equal(okTodo.ok, true)
  assert.equal(latestTodos.length, 2)

  // submit_plan blocked outside planMode, works in planMode
  const blockedPlan = await tools.execute("submit_plan", { plan: "# Kế hoạch\n- Bước 1" }, { planMode: false })
  assert.equal(blockedPlan.ok, false)
  const okPlan = await tools.execute("submit_plan", { plan: "# Kế hoạch biên tập\n1. Sửa b2" }, { planMode: true })
  assert.equal(okPlan.ok, true)
  assert.equal(latestPlan.title, "Kế hoạch biên tập")

  // Write tool blocked in planMode
  const blockedWrite = await tools.execute("align_boxes", { boxIds: ["b1", "b2"], alignment: "left" }, { allowEdits: true, planMode: true })
  assert.equal(blockedWrite.ok, false)

  // check_export_preflight detects overflow + unplaced
  const preflight = await tools.execute("check_export_preflight", {})
  assert.equal(preflight.ok, true)
  assert.equal(preflight.data.totalIssues, 2)

  // align_boxes & apply_style_preset work in edit mode with undo checkpoints
  const aligned = await tools.execute("align_boxes", { boxIds: ["b1", "b2"], alignment: "left" }, { allowEdits: true })
  assert.equal(aligned.ok, true)
  assert.equal(page1.boxes[1].x, 0.1)

  const styled = await tools.execute("apply_style_preset", { presetName: "sfx", scope: "page" }, { allowEdits: true })
  assert.equal(styled.ok, true)
  assert.equal(page1.boxes[0].font, "Georgia")
  assert.equal(page1.boxes[0].size, 42)
  assert.equal(checkpoints, 2)

  // navigate_page switches active page
  const nav = await tools.execute("navigate_page", { pageIndex: 2 })
  assert.equal(nav.ok, true)
  assert.equal(state.pageId, "p2")
})
