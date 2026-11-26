import assert from "node:assert/strict"
import test from "node:test"
import queue from "../desktop/task-queue.cjs"

test("cancelling a queued job never starts it and the next task still runs", async () => {
  const updates = []
  const starts = []
  let release
  const tasks = new queue.TaskQueue(() => ({
    call(operation) {
      starts.push(operation)
      return operation === "first" ? new Promise((resolve) => { release = resolve }) : Promise.resolve(operation)
    },
    close() {},
  }), (event) => updates.push(event))
  const first = tasks.submit("first", "first", {}, new Uint8Array())
  const second = tasks.submit("second", "second", {}, new Uint8Array())
  const rejected = assert.rejects(second, /hủy/)
  assert.equal(tasks.cancel("second"), true)
  release("complete")
  await Promise.all([first, rejected])
  assert.deepEqual(starts, ["first"])
  assert.equal(await tasks.submit("third", "third", {}, new Uint8Array()), "third")
  assert.equal(updates.find((event) => event.id === "second" && event.state === "cancelled").progress, 0)
})

test("cancelling the active worker rejects that task and preserves following jobs", async () => {
  let rejectActive
  const updates = []
  let count = 0
  const tasks = new queue.TaskQueue(() => ({
    call(_operation, _options, _data, report) {
      count++
      report(25, "step")
      return count === 1 ? new Promise((_resolve, reject) => { rejectActive = reject }) : Promise.resolve("next")
    },
    close() { if (count === 1) rejectActive(new Error("stopped")) },
  }), (event) => updates.push(event))
  const first = tasks.submit("first", "ocr", {}, new Uint8Array())
  const second = tasks.submit("second", "png", {}, new Uint8Array())
  const rejected = assert.rejects(first, /hủy/)
  tasks.cancel("first")
  await rejected
  assert.equal(await second, "next")
  assert.ok(updates.some((event) => event.progress === 25))
  assert.equal(updates.at(-1).state, "done")
})
