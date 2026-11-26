// Per-project chat session persistence (inspired by DeepSeek Harness `session-persistence`).

const SESSIONS_KEY = "khung-thoai-chat-sessions"
const MAX_PROJECTS = 12
const MAX_MESSAGES = 24

function readAll(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SESSIONS_KEY) || "null")
    if (!parsed || typeof parsed !== "object") return {}
    return parsed
  } catch {
    return {}
  }
}

function writeAll(map, storage = globalThis.localStorage) {
  try {
    // Keep only the most recently updated MAX_PROJECTS entries.
    const entries = Object.entries(map)
      .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
      .slice(0, MAX_PROJECTS)
    storage?.setItem(SESSIONS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Ignore storage quota errors in private browsing.
  }
}

export function loadProjectChatSession(projectId, storage = globalThis.localStorage) {
  if (!projectId) return { history: [], todos: [] }
  const all = readAll(storage)
  const entry = all[projectId]
  if (!entry || typeof entry !== "object") return { history: [], todos: [] }
  const history = Array.isArray(entry.history)
    ? entry.history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .slice(-MAX_MESSAGES)
    : []
  const todos = Array.isArray(entry.todos)
    ? entry.todos.filter((t) => t && typeof t.content === "string" && ["pending", "in_progress", "completed"].includes(t.status))
    : []
  return { history, todos, updatedAt: entry.updatedAt || 0 }
}

export function saveProjectChatSession(projectId, { history = [], todos = [] } = {}, storage = globalThis.localStorage) {
  if (!projectId) return false
  const all = readAll(storage)
  const cleanHistory = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 6000), ...(m.compacted && { compacted: true }) }))
  const cleanTodos = todos
    .filter((t) => t && typeof t.content === "string" && ["pending", "in_progress", "completed"].includes(t.status))
    .slice(0, 20)
  if (!cleanHistory.length && !cleanTodos.length) {
    delete all[projectId]
  } else {
    all[projectId] = { history: cleanHistory, todos: cleanTodos, updatedAt: Date.now() }
  }
  writeAll(all, storage)
  return true
}

export function clearProjectChatSession(projectId, storage = globalThis.localStorage) {
  if (!projectId) return
  const all = readAll(storage)
  if (projectId in all) {
    delete all[projectId]
    writeAll(all, storage)
  }
}
