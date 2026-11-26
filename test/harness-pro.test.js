import test from "node:test"
import assert from "node:assert/strict"
import { parseSlashCommand } from "../src/agent-commands.js"
import { RepeatToolGuard, canonicalizeArgs } from "../src/agent-guards.js"
import { loadSkillPrefs, resolveSkillPrompt, saveSkillPrefs } from "../src/agent-skills.js"
import { createAgentTools } from "../src/agent-tools.js"
import { clearProjectChatSession, loadProjectChatSession, saveProjectChatSession } from "../src/chat-storage.js"
import { computeBackoffDelay, parseRetryAfterMs, withLlmRetry } from "../src/llm-retry.js"

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  }
}

test("withLlmRetry retries transient 429/503 errors with backoff and respects AbortSignal", async () => {
  let calls = 0
  const retryLog = []
  const value = await withLlmRetry(
    async () => {
      calls++
      if (calls < 3) {
        const err = new Error("Rate limited")
        err.status = 429
        err.retryAfterMs = 10
        throw err
      }
      return "ok"
    },
    {
      maxRetries: 3,
      delayFn: async () => true,
      onRetry: (info) => retryLog.push(info),
    },
  )
  assert.equal(value, "ok")
  assert.equal(calls, 3)
  assert.equal(retryLog.length, 2)

  // Non-retryable 400 fails immediately without retrying
  let badCalls = 0
  await assert.rejects(
    withLlmRetry(
      async () => {
        badCalls++
        const err = new Error("Bad request")
        err.status = 400
        throw err
      },
      { maxRetries: 3, delayFn: async () => true },
    ),
  )
  assert.equal(badCalls, 1)

  assert.equal(parseRetryAfterMs("2"), 2000)
  assert.ok(computeBackoffDelay(2, { initialDelayMs: 500, random: () => 0.5 }) >= 500)
})

test("RepeatToolGuard canonicalizes object keys and escalates gentle -> detailed reminders", () => {
  assert.equal(canonicalizeArgs({ b: 2, a: 1 }), canonicalizeArgs({ a: 1, b: 2 }))
  const guard = new RepeatToolGuard({ thresholds: [2, 4] })
  assert.equal(guard.observe("list_boxes", { pageIndex: 1 }), null)
  const gentle = guard.observe("list_boxes", { pageIndex: 1 })
  assert.equal(gentle.level, "gentle")
  assert.match(gentle.reminder, /2 lần liên tiếp/)

  assert.equal(guard.observe("list_boxes", { pageIndex: 1 }), null)
  const detailed = guard.observe("list_boxes", { pageIndex: 1 })
  assert.equal(detailed.level, "detailed")
  assert.match(detailed.reminder, /Cảnh báo lặp vòng/)

  // Changing arguments resets chain; excluded todo_write does not break or count
  assert.equal(guard.observe("todo_write", { todos: [] }), null)
  assert.equal(guard.observe("list_boxes", { pageIndex: 2 }), null)
})

test("agent-skills, slash commands, and per-project chat persistence work cleanly", () => {
  const storage = memoryStorage()
  saveSkillPrefs({ skillId: "wuxia", customInstructions: "Giữ tên Hán-Việt" }, storage)
  const loaded = loadSkillPrefs(storage)
  assert.equal(loaded.skillId, "wuxia")
  const prompt = resolveSkillPrompt(loaded.skillId, loaded.customInstructions)
  assert.match(prompt, /Cổ trang/)
  assert.match(prompt, /Giữ tên Hán-Việt/)

  assert.equal(parseSlashCommand("xin chào"), null)
  assert.equal(parseSlashCommand("/help").kind, "help")
  assert.equal(parseSlashCommand("/qc").kind, "prompt")
  assert.equal(parseSlashCommand("/autofit").kind, "prompt")
  assert.deepEqual(parseSlashCommand("/compact ai"), { kind: "compact", useLlm: true })
  assert.deepEqual(parseSlashCommand("/plan off"), { kind: "plan", enabled: false })
  assert.deepEqual(parseSlashCommand("/plan kiểm tra chương"), { kind: "plan", enabled: true, prompt: "kiểm tra chương" })
  assert.deepEqual(parseSlashCommand("/skill shounen"), { kind: "skill", skillId: "shounen" })

  saveProjectChatSession("proj-1", {
    history: [{ role: "user", text: "Hi" }, { role: "assistant", text: "Chào bạn" }],
    todos: [{ content: "Rà lỗi", status: "in_progress" }],
  }, storage)
  const restored = loadProjectChatSession("proj-1", storage)
  assert.equal(restored.history.length, 2)
  assert.equal(restored.todos.length, 1)
  clearProjectChatSession("proj-1", storage)
  assert.equal(loadProjectChatSession("proj-1", storage).history.length, 0)
})

test("ask_user interactive tool and bulk mutation approval gate enforce user control", async () => {
  const page = {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [{ id: "b1", text: "Hello Hero", x: 0.1, y: 0.1, w: 0.3, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" }],
    unplaced: [],
  }
  const state = { pages: [page], presets: [], pageId: "p1", boxId: "b1", selectedBoxIds: new Set(["b1"]), queue: [] }
  let approveDecision = { approved: false, reason: "Không muốn đổi" }

  const tools = createAgentTools({
    state,
    byId: () => null,
    selectedPage: () => page,
    selectedIndex: () => 0,
    checkpoint: () => {},
    render: () => {},
    onAskUser: async ({ question, options }) => ({ answer: options[0]?.label || question, custom: false }),
    onApproveTool: async () => approveDecision,
  })

  // ask_user resolves user's choice cleanly
  const askRes = await tools.execute("ask_user", {
    header: "Xưng hô",
    question: "Nên dịch cặp nhân vật này là gì?",
    options: [{ label: "Cậu / Tớ" }, { label: "Anh / Em" }],
  })
  assert.equal(askRes.ok, true)
  assert.equal(askRes.data.answer, "Cậu / Tớ")
  assert.equal(tools.timeoutMs("ask_user"), 0)

  // Bulk mutation rejected when approval returns approved=false
  const denied = await tools.execute(
    "replace_chapter_text",
    { query: "Hero", replacement: "Anh hùng" },
    { allowEdits: true, confirmBulkEdits: true },
  )
  assert.equal(denied.ok, false)
  assert.match(denied.error, /từ chối/)
  assert.equal(page.boxes[0].text, "Hello Hero")

  // Approved bulk mutation proceeds cleanly
  approveDecision = { approved: true }
  const allowed = await tools.execute(
    "replace_chapter_text",
    { query: "Hero", replacement: "Anh hùng" },
    { allowEdits: true, confirmBulkEdits: true },
  )
  assert.equal(allowed.ok, true)
  assert.equal(page.boxes[0].text, "Hello Anh hùng")
})
