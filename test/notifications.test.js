import test from "node:test"
import assert from "node:assert/strict"
import { NotificationStore } from "../src/notifications.js"

test("NotificationStore adds, deduplicates by key, caps visible/history, and tracks unread", () => {
  const store = new NotificationStore({ maxItems: 5, maxVisible: 2 })
  let events = 0
  store.subscribe(() => { events++ })

  const a = store.add({ kind: "info", title: "A", message: "first", key: "k1" })
  assert.ok(a)
  assert.equal(store.unreadCount(), 1)
  assert.equal(store.snapshot().visible.length, 1)

  // Updating with same key replaces in place without growing list
  const a2 = store.add({ kind: "warning", title: "A2", message: "updated", key: "k1" })
  assert.equal(a2.id, a.id)
  assert.equal(store.snapshot().items.length, 1)
  assert.equal(store.snapshot().items[0].title, "A2")

  store.add({ kind: "success", title: "B", message: "second" })
  store.add({ kind: "error", title: "C", message: "third" })
  assert.equal(store.snapshot().items.length, 3)
  assert.equal(store.snapshot().visible.length, 2) // capped at maxVisible=2
  assert.equal(store.unreadCount(), 3)

  // Silent toast goes to history/unread without appearing in visible toasts
  const silent = store.add({ kind: "info", title: "Silent", message: "bg", silentToast: true })
  assert.equal(store.snapshot().visible.some((v) => v.id === silent.id), false)
  assert.equal(store.snapshot().items[0].id, silent.id)

  store.markRead(silent.id)
  assert.equal(store.unreadCount(), 3)

  store.markAllRead()
  assert.equal(store.unreadCount(), 0)

  store.dismissToast(store.snapshot().visible[0].id)
  assert.equal(store.snapshot().visible.length, 1)

  store.clearAll()
  assert.equal(store.snapshot().items.length, 0)
  assert.equal(store.snapshot().visible.length, 0)
  assert.ok(events > 0)
})
