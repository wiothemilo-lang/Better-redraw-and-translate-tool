const VALID_KINDS = new Set(["info", "success", "warning", "error", "update"])
const DEFAULT_DURATIONS = {
  info: 5000,
  success: 4500,
  warning: 7500,
  error: 9000,
  update: 12000,
}

export class NotificationStore {
  constructor({ maxItems = 50, maxVisible = 4 } = {}) {
    this.maxItems = maxItems
    this.maxVisible = maxVisible
    this.items = []
    this.visibleIds = []
    this.listeners = new Set()
    this._seq = 0
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  _emit() {
    for (const listener of this.listeners) listener(this.snapshot())
  }

  add({
    kind = "info",
    title = "",
    message = "",
    actions = [],
    durationMs,
    key = "",
    silentToast = false,
  } = {}) {
    const cleanKind = VALID_KINDS.has(kind) ? kind : "info"
    const cleanTitle = String(title || "").trim()
    const cleanMessage = String(message || "").trim()
    if (!cleanTitle && !cleanMessage) return null

    const cleanActions = Array.isArray(actions)
      ? actions.filter((a) => a && typeof a.label === "string" && typeof a.onClick === "function").slice(0, 3)
      : []

    const resolvedDuration = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : (DEFAULT_DURATIONS[cleanKind] ?? 5000)

    const keyStr = String(key || "").trim()
    if (keyStr) {
      const existing = this.items.find((item) => item.key === keyStr)
      if (existing) {
        existing.kind = cleanKind
        existing.title = cleanTitle
        existing.message = cleanMessage
        existing.actions = cleanActions
        existing.durationMs = resolvedDuration
        existing.createdAt = Date.now()
        existing.read = false
        this.items = [existing, ...this.items.filter((i) => i.id !== existing.id)]
        if (!silentToast) {
          this.visibleIds = [existing.id, ...this.visibleIds.filter((id) => id !== existing.id)].slice(0, this.maxVisible)
        }
        this._emit()
        return existing
      }
    }

    const item = {
      id: `notif_${++this._seq}_${Date.now()}`,
      key: keyStr,
      kind: cleanKind,
      title: cleanTitle,
      message: cleanMessage,
      actions: cleanActions,
      durationMs: resolvedDuration,
      createdAt: Date.now(),
      read: false,
    }
    this.items.unshift(item)
    if (this.items.length > this.maxItems) {
      const dropped = this.items.splice(this.maxItems)
      const droppedIds = new Set(dropped.map((d) => d.id))
      this.visibleIds = this.visibleIds.filter((id) => !droppedIds.has(id))
    }
    if (!silentToast) {
      this.visibleIds = [item.id, ...this.visibleIds.filter((id) => id !== item.id)].slice(0, this.maxVisible)
    }
    this._emit()
    return item
  }

  dismissToast(id) {
    const before = this.visibleIds.length
    this.visibleIds = this.visibleIds.filter((itemId) => itemId !== id)
    if (this.visibleIds.length !== before) this._emit()
  }

  markRead(id) {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.read) return
    item.read = true
    this._emit()
  }

  markAllRead() {
    let changed = false
    for (const item of this.items) {
      if (!item.read) {
        item.read = true
        changed = true
      }
    }
    if (changed) this._emit()
  }

  clearAll() {
    if (!this.items.length && !this.visibleIds.length) return
    this.items = []
    this.visibleIds = []
    this._emit()
  }

  unreadCount() {
    let count = 0
    for (const item of this.items) {
      if (!item.read) count++
    }
    return count
  }

  snapshot() {
    const byId = new Map(this.items.map((item) => [item.id, item]))
    return {
      items: [...this.items],
      visible: this.visibleIds.map((id) => byId.get(id)).filter(Boolean),
      unread: this.unreadCount(),
    }
  }
}

const KIND_ICONS = {
  info: "ℹ",
  success: "✓",
  warning: "!",
  error: "×",
  update: "↑",
}

function formatShortTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}

export function createNotificationCenter({ byId, store = new NotificationStore() }) {
  const toastContainer = byId("toast-container")
  const panel = byId("notifications-panel")
  const listEl = byId("notifications-list")
  const emptyEl = byId("notifications-empty")
  const toggleBtn = byId("open-notifications")
  const badgeEl = byId("notif-badge")
  const clearBtn = byId("notifications-clear")
  const closeBtn = byId("notifications-close")

  const timers = new Map()
  const paused = new Set()

  function clearTimer(id) {
    const handle = timers.get(id)
    if (handle) {
      clearTimeout(handle)
      timers.delete(id)
    }
  }

  function scheduleDismiss(item) {
    clearTimer(item.id)
    if (!item.durationMs || paused.has(item.id)) return
    const handle = setTimeout(() => {
      timers.delete(item.id)
      store.dismissToast(item.id)
    }, item.durationMs)
    timers.set(item.id, handle)
  }

  function renderActionButtons(item, { dismissOnClick = false } = {}) {
    if (!item.actions.length) return null
    const row = document.createElement("div")
    row.className = "notif-actions"
    for (const action of item.actions) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = action.primary ? "button primary" : "button"
      btn.textContent = action.label
      btn.onclick = () => {
        store.markRead(item.id)
        if (dismissOnClick) store.dismissToast(item.id)
        try {
          action.onClick()
        } catch {
          // Keep notification center resilient if an action throws.
        }
      }
      row.append(btn)
    }
    return row
  }

  function renderToasts(visible) {
    if (!toastContainer) return
    const activeIds = new Set(visible.map((v) => v.id))
    for (const id of [...timers.keys()]) {
      if (!activeIds.has(id)) clearTimer(id)
    }
    toastContainer.replaceChildren(
      ...visible.map((item) => {
        const card = document.createElement("div")
        card.className = `toast toast-${item.kind}`
        card.setAttribute("role", item.kind === "error" || item.kind === "warning" ? "alert" : "status")
        card.onmouseenter = () => {
          paused.add(item.id)
          clearTimer(item.id)
        }
        card.onmouseleave = () => {
          paused.delete(item.id)
          scheduleDismiss(item)
        }

        const icon = document.createElement("span")
        icon.className = "toast-icon"
        icon.setAttribute("aria-hidden", "true")
        icon.textContent = KIND_ICONS[item.kind] ?? "ℹ"

        const body = document.createElement("div")
        body.className = "toast-body"
        if (item.title) {
          const strong = document.createElement("strong")
          strong.textContent = item.title
          body.append(strong)
        }
        if (item.message) {
          const p = document.createElement("p")
          p.textContent = item.message
          body.append(p)
        }
        const actions = renderActionButtons(item, { dismissOnClick: true })
        if (actions) body.append(actions)

        const close = document.createElement("button")
        close.type = "button"
        close.className = "toast-close"
        close.setAttribute("aria-label", "Đóng thông báo")
        close.textContent = "×"
        close.onclick = () => {
          paused.delete(item.id)
          clearTimer(item.id)
          store.markRead(item.id)
          store.dismissToast(item.id)
        }

        card.append(icon, body, close)
        if (!timers.has(item.id) && !paused.has(item.id)) scheduleDismiss(item)
        return card
      }),
    )
  }

  function renderHistory(items, unread) {
    if (badgeEl) {
      badgeEl.hidden = unread <= 0
      badgeEl.textContent = unread > 99 ? "99+" : String(unread)
    }
    if (emptyEl) emptyEl.hidden = items.length > 0
    if (!listEl) return
    listEl.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li")
        li.className = `notif-item notif-${item.kind}${item.read ? " is-read" : ""}`

        const head = document.createElement("div")
        head.className = "notif-item-head"
        const badge = document.createElement("span")
        badge.className = "notif-item-icon"
        badge.textContent = KIND_ICONS[item.kind] ?? "ℹ"
        const title = document.createElement("strong")
        title.textContent = item.title || "Thông báo"
        const time = document.createElement("span")
        time.className = "notif-time"
        time.textContent = formatShortTime(item.createdAt)
        head.append(badge, title, time)

        li.append(head)
        if (item.message) {
          const p = document.createElement("p")
          p.textContent = item.message
          li.append(p)
        }
        const actions = renderActionButtons(item)
        if (actions) li.append(actions)
        return li
      }),
    )
  }

  function renderSnapshot(snap) {
    renderToasts(snap.visible)
    renderHistory(snap.items, snap.unread)
  }

  store.subscribe(renderSnapshot)
  renderSnapshot(store.snapshot())

  function setPanelOpen(open) {
    if (!panel) return
    panel.hidden = !open
    toggleBtn?.setAttribute("aria-expanded", String(open))
    if (open) store.markAllRead()
  }

  if (toggleBtn) {
    toggleBtn.onclick = () => setPanelOpen(panel?.hidden ?? true)
  }
  if (closeBtn) {
    closeBtn.onclick = () => setPanelOpen(false)
  }
  if (clearBtn) {
    clearBtn.onclick = () => store.clearAll()
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) {
      setPanelOpen(false)
    }
  })

  return {
    store,
    notify(options) {
      return store.add(options)
    },
    dismissToast(id) {
      store.dismissToast(id)
    },
    openPanel: () => setPanelOpen(true),
    closePanel: () => setPanelOpen(false),
  }
}
