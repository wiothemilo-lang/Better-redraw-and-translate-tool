// Bounded turn transcript and offline replay for one agent turn (Nixio #66).
//
// The harness prunes old tool results between steps, so the prompt a model answered is gone once the
// turn ends and the chat history cannot rebuild it. A turn record keeps the run itself — prompt hash,
// runtime reminder, every model decision, every tool call with arguments and outcome, approval
// decisions, usage, timing and errors — under hard caps and with credentials scrubbed before anything
// is stored. Replay walks the record through the real batch scheduler with a stub that answers only
// from the record: no provider call and no tool execution, so a mutating tool can never run twice.

import {
  TOOL_APPROVAL_REJECTED,
  TOOL_APPROVAL_UNAVAILABLE,
  executeToolBatch,
} from "./agent-pipeline.js"
import { CREDENTIAL_SETTINGS_CONTRACT } from "./credential-settings.js"

export const TURN_RECORD_VERSION = 1
export const REDACTED_MARKER = "[đã ẩn]"
export const TRUNCATED_MARKER = "lược bớt"

export const TURN_RECORD_STATUSES = Object.freeze(["running", "completed", "stopped", "failed", "budget", "capped"])

// Caps are deliberately small: a record lives next to the chat session in project storage, and a
// transcript that outgrows the quota would be dropped silently by the browser instead.
export const TURN_RECORD_LIMITS = Object.freeze({
  steps: 24,
  tools: 80,
  events: 160,
  textChars: 4000,
  argsChars: 1200,
  resultChars: 2400,
  errorChars: 640,
  reminderChars: 1600,
  maxDepth: 8,
})

export const REPLAY_BLOCKED_CODES = Object.freeze({
  outOfOrder: "REPLAY_OUT_OF_ORDER",
})

// The provider layer already names its key fields, so the transcript reuses that list: a rename there
// cannot leave a key behind in a record here. The extra names cover headers and vault wording.
const CREDENTIAL_SECRET_FIELDS = [
  ...CREDENTIAL_SETTINGS_CONTRACT.secretFields.gemini,
  ...CREDENTIAL_SETTINGS_CONTRACT.secretFields.openai,
  ...CREDENTIAL_SETTINGS_CONTRACT.secretFields.ambiguous,
]
const EXTRA_SECRET_FIELDS = [
  "api_key", "api-key", "authorization", "auth", "bearer", "cookie", "set-cookie",
  "password", "passwd", "pwd", "credential", "credentials", "secret", "secrets",
  "access_token", "refresh_token", "id_token", "client_secret", "x-api-key", "x-goog-api-key",
]
const SECRET_KEY = new RegExp(
  `^(?:${[...CREDENTIAL_SECRET_FIELDS, ...EXTRA_SECRET_FIELDS].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  "i",
)

// A key can also leave the app inside free text (an error message echoed back by a provider, a URL a
// tool returned), so the shapes a credential can take are scrubbed from every string as well. Every
// quantifier is bounded: a 4000-character dialogue line must not turn redaction into a backtracking
// search.
const SECRET_TEXT_RULES = [
  [/\b([a-z][a-z0-9+.-]{0,24}:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED_MARKER}@`],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED_MARKER],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED_MARKER],
  [/\btvly-[A-Za-z0-9_-]{8,}\b/g, REDACTED_MARKER],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED_MARKER],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, REDACTED_MARKER],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED_MARKER}`],
  [/([?&](?:api[-_]?key|key|token|access_token|apiKey)=)[^&\s"'<>#]{0,512}/gi, `$1${REDACTED_MARKER}`],
]

let recorderSequence = 0

export function hashText(raw) {
  const text = String(raw ?? "")
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function redactText(raw) {
  let text = String(raw ?? "")
  for (const [pattern, replacement] of SECRET_TEXT_RULES) text = text.replace(pattern, replacement)
  return text
}

export function redactValue(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === "string") return redactText(value)
  if (type === "number") return Number.isFinite(value) ? value : null
  if (type === "boolean") return value
  if (type === "bigint") return String(value)
  if (type !== "object") return null
  if (depth >= TURN_RECORD_LIMITS.maxDepth) return REDACTED_MARKER
  if (seen.has(value)) return REDACTED_MARKER
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1, seen))
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue
      out[key] = SECRET_KEY.test(key) ? REDACTED_MARKER : redactValue(item, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

const TRUNCATION_TAIL = new RegExp(`… \\[${TRUNCATED_MARKER} \\d+ ký tự\\]$`)

// Normalizing a record twice must not truncate it twice: a stored transcript is loaded, re-normalized
// and digested again, so bounding has to be a fixed point.
export function boundText(raw, maxChars = TURN_RECORD_LIMITS.textChars) {
  const text = redactText(raw)
  const limit = Math.max(24, Number(maxChars) || TURN_RECORD_LIMITS.textChars)
  if (text.length <= limit) return { text, omitted: 0 }
  if (text.length <= limit + 48 && TRUNCATION_TAIL.test(text)) return { text, omitted: 0 }
  const omitted = text.length - limit
  return { text: `${text.slice(0, limit)}… [${TRUNCATED_MARKER} ${omitted} ký tự]`, omitted }
}

function boundArgs(raw) {
  // Same fixed point as boundText: an already-truncated argument blob stays as it is.
  if (raw && typeof raw === "object" && raw.truncated === true) {
    return { truncated: true, json: String(raw.json ?? "").slice(0, TURN_RECORD_LIMITS.argsChars) }
  }
  const redacted = redactValue(raw ?? {})
  let json
  try {
    json = JSON.stringify(redacted ?? {})
  } catch {
    return { truncated: true, json: "" }
  }
  if ((json ?? "").length <= TURN_RECORD_LIMITS.argsChars) return redacted
  return { truncated: true, json: json.slice(0, TURN_RECORD_LIMITS.argsChars) }
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function approvalOf({ approvalRequired = false, ok = false, code = null } = {}) {
  if (!approvalRequired) return "not-required"
  if (ok) return "approved"
  if (code === TOOL_APPROVAL_REJECTED) return "rejected"
  if (code === TOOL_APPROVAL_UNAVAILABLE) return "unavailable"
  return "blocked"
}

function usageNumber(raw, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), raw)
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

// The recorder is handed the provider's own usage object, not the harness-normalized one: Gemini
// reports promptTokenCount/candidatesTokenCount/usageMetadata, OpenAI reports prompt_tokens/
// completion_tokens/usage. Keeping only camelCase keys dropped the counts from every real transcript.
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null
  const out = {}
  const prompt = usageNumber(raw, ["promptTokens", "promptTokenCount", "prompt_tokens"])
  const output = usageNumber(raw, ["outputTokens", "completionTokens", "completion_tokens", "candidatesTokenCount"])
  const cached = usageNumber(raw, ["cachedTokens", "cachedContentTokenCount", "prompt_tokens_details.cached_tokens"])
  const total = usageNumber(raw, ["totalTokens", "totalTokenCount", "total_tokens"])
  if (prompt !== undefined) out.promptTokens = prompt
  if (output !== undefined) {
    out.outputTokens = output
    out.completionTokens = output
  }
  if (cached !== undefined) out.cachedTokens = cached
  if (total !== undefined) out.totalTokens = total
  for (const key of ["calls", "costUsd", "unpricedCalls", "estimatedCalls"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) out[key] = raw[key]
  }
  return Object.keys(out).length ? out : null
}

function normalizeStatus(raw) {
  const status = String(raw ?? "completed")
  return TURN_RECORD_STATUSES.includes(status) ? status : "completed"
}

function normalizeSteps(raw, truncated) {
  const list = Array.isArray(raw) ? raw : []
  truncated.steps = Math.max(truncated.steps, list.length - TURN_RECORD_LIMITS.steps)
  return list.slice(0, TURN_RECORD_LIMITS.steps).map((step, index) => ({
    step: Number(step?.step) || index + 1,
    text: boundText(step?.text ?? "", TURN_RECORD_LIMITS.textChars).text,
    thought: boundText(step?.thought ?? "", TURN_RECORD_LIMITS.textChars).text,
    toolCallCount: Number(step?.toolCallCount) || 0,
    usage: normalizeUsage(step?.usage),
  }))
}

function normalizeTools(raw, truncated) {
  const list = Array.isArray(raw) ? raw : []
  truncated.tools = Math.max(truncated.tools, list.length - TURN_RECORD_LIMITS.tools)
  return list.slice(0, TURN_RECORD_LIMITS.tools).map((tool, index) => {
    const ok = tool?.ok === true
    const code = tool?.code ? String(tool.code) : null
    const approvalRequired = tool?.approvalRequired === true
    return {
      step: Number(tool?.step) || 1,
      id: String(tool?.id ?? `tc_${index + 1}`),
      name: String(tool?.name ?? ""),
      args: boundArgs(tool?.args),
      category: String(tool?.category ?? "read"),
      ok,
      code,
      approval: approvalOf({ approvalRequired, ok, code }),
      approvalRequired,
      summary: boundText(tool?.summary ?? "", TURN_RECORD_LIMITS.resultChars).text,
      error: tool?.error ? boundText(tool.error, TURN_RECORD_LIMITS.errorChars).text : null,
      durationMs: Math.max(0, Math.round(Number(tool?.durationMs) || 0)),
    }
  })
}

const EVENT_KEYS = [
  "step", "maxSteps", "toolName", "count", "level", "message", "prunedCount", "charsSaved",
  "foldedMessages", "attempt", "maxRetries", "delayMs", "id", "name", "ok", "durationMs",
]

// A streamed reply produces one delta per token; the record keeps their size, not their text, or the
// transcript would be several times larger than the answer it describes.
function normalizeEvent(event) {
  const type = String(event?.type || "event")
  const at = Math.max(0, Math.round(Number(event?.at) || 0))
  if (type === "delta") {
    return {
      at,
      type,
      step: Number(event?.step) || 0,
      chars: Math.max(0, Number(event?.chars) || String(event?.text ?? "").length),
      thoughtChars: Math.max(0, Number(event?.thoughtChars) || String(event?.thought ?? "").length),
    }
  }
  const out = { at, type }
  for (const key of EVENT_KEYS) {
    const value = event?.[key]
    if (value === undefined || value === null) continue
    out[key] = typeof value === "string" ? boundText(value, 400).text : value
  }
  return out
}

function normalizeEvents(raw, truncated) {
  const list = Array.isArray(raw) ? raw : []
  truncated.events = Math.max(truncated.events, list.length - TURN_RECORD_LIMITS.events)
  return list.slice(0, TURN_RECORD_LIMITS.events).map(normalizeEvent)
}

/**
 * Rebuild a record in its canonical shape: unknown fields dropped, every string re-redacted, every
 * collection re-capped. Both the recorder and the parser run through it, so a record that travelled
 * through storage or a file and came back still has the same digest.
 */
export function normalizeTurnRecord(raw) {
  const source = raw && typeof raw === "object" ? raw : {}
  const model = source.model && typeof source.model === "object" ? source.model : {}
  const flags = source.flags && typeof source.flags === "object" ? source.flags : {}
  const prompt = source.prompt && typeof source.prompt === "object" ? source.prompt : {}
  const timing = source.timing && typeof source.timing === "object" ? source.timing : {}
  const rawTruncated = source.truncated && typeof source.truncated === "object" ? source.truncated : {}
  const truncated = {
    steps: Math.max(0, Number(rawTruncated.steps) || 0),
    tools: Math.max(0, Number(rawTruncated.tools) || 0),
    events: Math.max(0, Number(rawTruncated.events) || 0),
    chars: Math.max(0, Number(rawTruncated.chars) || 0),
  }
  const promptText = boundText(prompt.text ?? "", TURN_RECORD_LIMITS.textChars)
  const reminder = boundText(prompt.runtimeReminder ?? "", TURN_RECORD_LIMITS.reminderChars)
  truncated.chars = Math.max(truncated.chars, promptText.omitted + reminder.omitted)
  return {
    version: TURN_RECORD_VERSION,
    id: String(source.id || "turn"),
    savedAt: Math.max(0, Math.round(Number(source.savedAt) || 0)),
    model: {
      provider: String(model.provider ?? ""),
      name: String(model.name ?? ""),
      promptHash: String(model.promptHash ?? ""),
      systemHash: String(model.systemHash ?? ""),
    },
    flags: {
      allowEdits: flags.allowEdits === true,
      allowWebSearch: flags.allowWebSearch === true,
      planMode: flags.planMode === true,
      confirmBulkEdits: flags.confirmBulkEdits === true,
      maxSteps: Number(flags.maxSteps) || 0,
    },
    prompt: { text: promptText.text, runtimeReminder: reminder.text },
    steps: normalizeSteps(source.steps, truncated),
    tools: normalizeTools(source.tools, truncated),
    usage: normalizeUsage(source.usage),
    timing: {
      startedAt: Math.max(0, Math.round(Number(timing.startedAt) || 0)),
      elapsedMs: Math.max(0, Math.round(Number(timing.elapsedMs) || 0)),
    },
    status: normalizeStatus(source.status),
    error: source.error ? boundText(source.error, TURN_RECORD_LIMITS.errorChars).text : null,
    events: normalizeEvents(source.events, truncated),
    truncated,
  }
}

function planOf(record) {
  return {
    version: record.version,
    model: { provider: record.model.provider, name: record.model.name, promptHash: record.model.promptHash },
    flags: record.flags,
    status: record.status,
    error: record.error,
    steps: record.steps.map((step) => ({
      step: step.step,
      text: step.text,
      thought: step.thought,
      toolCallCount: step.toolCallCount,
      usage: step.usage,
    })),
    tools: record.tools.map((tool) => ({
      step: tool.step,
      id: tool.id,
      name: tool.name,
      args: tool.args,
      ok: tool.ok,
      code: tool.code,
      approval: tool.approval,
    })),
  }
}

/** Stable fingerprint of the decisions a record claims; two runs that decided alike hash alike. */
export function turnDigest(record) {
  const normalized = normalizeTurnRecord(record)
  return hashText(JSON.stringify(planOf(normalized)))
}

export function serializeTurnRecord(record) {
  return JSON.stringify(normalizeTurnRecord(record))
}

export function parseTurnRecord(input) {
  let raw = input
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input)
    } catch {
      return { ok: false, error: "Bản ghi lượt không phải JSON hợp lệ." }
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Bản ghi lượt không hợp lệ." }
  }
  if (Number(raw.version) !== TURN_RECORD_VERSION) {
    return { ok: false, error: `Phiên bản bản ghi không hỗ trợ: ${raw.version ?? "?"}.` }
  }
  if (typeof raw.id !== "string" || !raw.id) {
    return { ok: false, error: "Bản ghi lượt thiếu mã nhận diện." }
  }
  if (!Array.isArray(raw.steps) || !Array.isArray(raw.tools)) {
    return { ok: false, error: "Bản ghi lượt thiếu danh sách bước hoặc công cụ." }
  }
  const record = normalizeTurnRecord(raw)
  let changed = false
  try {
    changed = JSON.stringify(record) !== JSON.stringify(raw)
  } catch {
    changed = true
  }
  return { ok: true, record, changed }
}

export function turnRecordFilename(record) {
  const id = String(record?.id || "turn").replace(/[^\w.-]+/g, "-")
  return `nixio-luot-${id}.json`
}

export function exportTurnRecord(record, { pretty = true } = {}) {
  const parsed = parseTurnRecord(record)
  if (!parsed.ok) throw new Error(parsed.error)
  return {
    filename: turnRecordFilename(parsed.record),
    json: JSON.stringify(parsed.record, null, pretty ? 2 : 0),
  }
}

/**
 * Collects one turn as it runs. Every entry is redacted and capped on insert, so a long turn cannot
 * grow the transcript past the storage quota before anyone notices.
 */
export function createTurnRecorder({ now = Date.now, id = "" } = {}) {
  const cap = TURN_RECORD_LIMITS
  const startedAt = now()
  const recordId = id || `turn-${startedAt.toString(36)}-${(++recorderSequence).toString(36)}`
  const state = {
    version: TURN_RECORD_VERSION,
    id: recordId,
    savedAt: 0,
    model: { provider: "", name: "", promptHash: "", systemHash: "" },
    flags: { allowEdits: true, allowWebSearch: true, planMode: false, confirmBulkEdits: true, maxSteps: 10 },
    prompt: { text: "", runtimeReminder: "" },
    steps: [],
    tools: [],
    usage: null,
    timing: { startedAt, elapsedMs: 0 },
    status: "running",
    error: null,
    events: [],
    truncated: { steps: 0, tools: 0, events: 0, chars: 0 },
  }

  const at = () => Math.max(0, now() - startedAt)
  const addOmitted = (omitted) => { state.truncated.chars += Math.max(0, Number(omitted) || 0) }

  return {
    id: recordId,
    begin({ provider = "", model = "", systemPrompt = "", runtimeReminder = "", userMessage = "", flags = {} } = {}) {
      state.model = {
        provider: String(provider),
        name: String(model),
        promptHash: hashText(`${systemPrompt}\u0000${runtimeReminder}\u0000${userMessage}`),
        systemHash: hashText(systemPrompt),
      }
      const user = boundText(userMessage, cap.textChars)
      const reminder = boundText(runtimeReminder, cap.reminderChars)
      addOmitted(user.omitted + reminder.omitted)
      state.prompt = { text: user.text, runtimeReminder: reminder.text }
      state.flags = {
        allowEdits: flags.allowEdits !== false,
        allowWebSearch: flags.allowWebSearch !== false,
        planMode: flags.planMode === true,
        confirmBulkEdits: flags.confirmBulkEdits !== false,
        maxSteps: Number(flags.maxSteps) || 0,
      }
      return recordId
    },

    step({ step, text = "", thought = "", usage = null, toolCalls = [] } = {}) {
      if (state.steps.length >= cap.steps) {
        state.truncated.steps++
        return
      }
      const answer = boundText(text, cap.textChars)
      const reasoning = boundText(thought, cap.textChars)
      addOmitted(answer.omitted + reasoning.omitted)
      state.steps.push({
        step: Number(step) || state.steps.length + 1,
        text: answer.text,
        thought: reasoning.text,
        toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
        usage: normalizeUsage(usage),
      })
    },

    tool({ step, entry } = {}) {
      if (!entry) return
      if (state.tools.length >= cap.tools) {
        state.truncated.tools++
        return
      }
      const summary = boundText(entry.summary ?? "", cap.resultChars)
      const error = entry.error ? boundText(entry.error, cap.errorChars) : { text: null, omitted: 0 }
      addOmitted(summary.omitted + error.omitted)
      state.tools.push({
        step: Number(step) || state.steps.length || 1,
        id: String(entry.id ?? `tc_${state.tools.length + 1}`),
        name: String(entry.name ?? ""),
        args: boundArgs(entry.args),
        category: String(entry.category ?? "read"),
        ok: entry.ok === true,
        code: entry.code ? String(entry.code) : null,
        approval: approvalOf({ approvalRequired: entry.approvalRequired === true, ok: entry.ok === true, code: entry.code || null }),
        approvalRequired: entry.approvalRequired === true,
        summary: summary.text,
        error: error.text,
        durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
      })
    },

    event(event) {
      if (state.events.length >= cap.events) {
        state.truncated.events++
        return
      }
      state.events.push(normalizeEvent({ ...event, at: at() }))
    },

    usage(totals) {
      state.usage = normalizeUsage(totals)
    },

    error(message) {
      const bounded = boundText(message ?? "", cap.errorChars)
      addOmitted(bounded.omitted)
      state.error = bounded.text
      if (state.status === "running") state.status = "failed"
    },

    finish({ status = "completed", error = null, elapsedMs = null } = {}) {
      state.status = normalizeStatus(status)
      if (error) {
        const bounded = boundText(error, cap.errorChars)
        addOmitted(bounded.omitted)
        state.error = bounded.text
      }
      state.timing.elapsedMs = elapsedMs === null ? at() : Math.max(0, Math.round(Number(elapsedMs) || 0))
    },

    snapshot() {
      const snapshot = normalizeTurnRecord({ ...state, savedAt: now() })
      // A turn that was cut off before anyone called finish() still has to say so.
      if (snapshot.status === "running") snapshot.status = "stopped"
      if (snapshot.status === "stopped" && !snapshot.error) snapshot.error = "Lượt chạy bị dừng trước khi hoàn tất."
      return snapshot
    },
  }
}

function assertReplayStub(tools) {
  if (tools && tools.replayStub !== true) {
    throw new Error("Phát lại chỉ nhận công cụ giả lập dựng từ bản ghi; không được truyền công cụ thật.")
  }
}

/**
 * Tool stand-in for a replay. It answers from the record and counts what it kept from running: a
 * mutating call is served as recorded data, never dispatched to a real tool.
 */
export function createReplayToolStub(record) {
  const entries = Array.isArray(record?.tools) ? record.tools.map((tool) => ({ ...tool })) : []
  const categories = new Map()
  for (const entry of entries) categories.set(entry.name, entry.category || "read")
  const stats = { calls: 0, mutationsPrevented: 0, networkPrevented: 0, outOfOrder: 0 }
  let cursor = 0
  const peek = () => entries[cursor] ?? null

  return {
    replayStub: true,
    total: entries.length,
    definitions: () => [],
    // Recorded outcomes are replayed one at a time: the recorded order is the order to check.
    isConcurrencySafe: () => false,
    categoryOf: (name) => categories.get(name) || "read",
    timeoutMs: () => 0,
    requiresApproval: () => false,
    needsApproval: () => peek()?.approvalRequired === true,
    async execute(name) {
      const entry = peek()
      if (!entry || entry.name !== name) {
        stats.outOfOrder++
        return {
          ok: false,
          category: categories.get(name) || "read",
          code: REPLAY_BLOCKED_CODES.outOfOrder,
          error: `Bản ghi không có lời gọi "${name}" ở vị trí ${cursor + 1}.`,
        }
      }
      cursor++
      stats.calls++
      if (entry.category === "write" || entry.category === "plan") stats.mutationsPrevented++
      if (entry.category === "web") stats.networkPrevented++
      if (entry.ok) {
        return { ok: true, category: entry.category, summary: entry.summary }
      }
      return {
        ok: false,
        category: entry.category,
        error: entry.error || entry.summary || "Lỗi đã ghi trong bản ghi.",
        ...(entry.code && { code: entry.code }),
      }
    },
    snapshot: () => ({ ...stats, remaining: Math.max(0, entries.length - cursor), total: entries.length }),
  }
}

function compareToolEntry(expected, actual) {
  const differences = []
  const base = `tools[${expected.step}:${expected.id}]`
  if (expected.name !== actual.name) {
    differences.push({ path: `${base}.name`, kind: "chain", expected: expected.name, actual: actual.name })
  }
  if (!sameJson(expected.args, actual.args)) {
    differences.push({ path: `${base}.args`, kind: "args", expected: expected.args, actual: actual.args })
  }
  if (Boolean(expected.ok) !== Boolean(actual.ok)) {
    differences.push({ path: `${base}.ok`, kind: "outcome", expected: expected.ok, actual: actual.ok })
  }
  const code = actual.code ?? null
  if ((expected.code ?? null) !== code) {
    differences.push({ path: `${base}.code`, kind: "outcome", expected: expected.code ?? null, actual: code })
  }
  const approval = approvalOf({ approvalRequired: actual.approvalRequired === true, ok: actual.ok === true, code })
  if (expected.approval !== approval) {
    differences.push({ path: `${base}.approval`, kind: "decision", expected: expected.approval, actual: approval })
  }
  return differences
}

/**
 * Walk a record the way the turn ran: same step order, same batch scheduler, same recorded decisions,
 * with the tool stub standing in for every call. Nothing here talks to a provider or a tool.
 */
export async function replayTurnRecord(record, { tools = null } = {}) {
  const parsed = parseTurnRecord(record)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, entries: [], toolChain: [], differences: [], identical: false, stub: null }
  }
  const clean = parsed.record
  const stub = tools ?? createReplayToolStub(clean)
  assertReplayStub(stub)

  const entries = [{
    kind: "turn",
    status: clean.status,
    provider: clean.model.provider,
    model: clean.model.name,
    promptHash: clean.model.promptHash,
    flags: clean.flags,
    toolCount: clean.tools.length,
    stepCount: clean.steps.length,
  }]
  const differences = []
  const warnings = []
  const toolsByStep = new Map()
  for (const entry of clean.tools) {
    if (!toolsByStep.has(entry.step)) toolsByStep.set(entry.step, [])
    toolsByStep.get(entry.step).push(entry)
  }
  const coveredSteps = new Set(clean.steps.map((step) => step.step))
  for (const entry of clean.tools) {
    if (!coveredSteps.has(entry.step)) {
      // A tool row whose step has no model decision cannot be replayed: the record was cut or edited.
      differences.push({ path: `tools[${entry.step}:${entry.id}].step`, kind: "chain", expected: entry.step, actual: null })
      warnings.push(`Công cụ ở bước ${entry.step} không có bản ghi quyết định của model.`)
    }
  }

  for (const step of clean.steps) {
    entries.push({
      kind: "step",
      step: step.step,
      text: step.text,
      thought: step.thought,
      toolCallCount: step.toolCallCount,
      usage: step.usage,
    })
    const recorded = toolsByStep.get(step.step) ?? []
    if (step.toolCallCount !== recorded.length) {
      // The count the model's step carried is the only witness of a call the cap dropped.
      differences.push({
        path: `steps[${step.step}].toolCallCount`,
        kind: "count",
        expected: step.toolCallCount,
        actual: recorded.length,
      })
    }
    if (!recorded.length) continue
    const settled = await executeToolBatch(
      recorded.map((entry) => ({ id: entry.id, name: entry.name, args: entry.args })),
      {
        tools: stub,
        allowEdits: false,
        allowWebSearch: false,
        planMode: false,
        confirmBulkEdits: false,
        forceWriteApproval: false,
        maxParallel: 1,
      },
    )
    settled.forEach((result, index) => {
      const expected = recorded[index]
      const found = compareToolEntry(expected, result)
      differences.push(...found)
      entries.push({
        kind: "tool",
        step: step.step,
        id: expected.id,
        name: expected.name,
        args: expected.args,
        category: expected.category,
        ok: expected.ok,
        code: expected.code,
        approval: expected.approval,
        outcome: expected.ok ? expected.summary : (expected.error || expected.summary),
        durationMs: expected.durationMs,
        // The stub answered from the record; no tool ran during this replay.
        executed: false,
        state: found.length ? "diff" : "match",
      })
    })
  }

  if (clean.truncated.steps || clean.truncated.tools) {
    warnings.push(`Bản ghi đã bị cắt: ${clean.truncated.steps} bước, ${clean.truncated.tools} công cụ.`)
  }
  entries.push({
    kind: "end",
    status: clean.status,
    reason: clean.error || null,
    mutationsPrevented: stub.snapshot?.().mutationsPrevented ?? 0,
    networkPrevented: stub.snapshot?.().networkPrevented ?? 0,
  })

  return {
    ok: true,
    id: clean.id,
    status: clean.status,
    digest: turnDigest(clean),
    entries,
    toolChain: clean.tools.map((tool) => ({ name: tool.name, args: tool.args, ok: tool.ok, approval: tool.approval })),
    differences,
    identical: differences.length === 0,
    warnings,
    stub: stub.snapshot?.() ?? null,
  }
}

/** Does a replay still produce the recorded chain? Used by the debug panel and the tests. */
export function replayMatchesRecord(record, replay) {
  if (!replay?.ok) return false
  return replay.digest === turnDigest(record) && replay.differences.length === 0
}
