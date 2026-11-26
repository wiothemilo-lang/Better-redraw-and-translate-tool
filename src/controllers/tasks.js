import { desktop } from "../native.js"

export function setupTasks(byId) {
  if (!desktop?.onTask) return
  const tasks = new Map()
  desktop.onTask((update) => {
    tasks.set(update.id, update)
    const rows = [...tasks.values()].slice(-10)
    byId("task-panel").hidden = false
    byId("task-list").replaceChildren(
      ...rows.map((task) => {
        const row = document.createElement("li")
        const label = document.createElement("span")
        label.textContent = task.operation + " · " + task.stage
        const progress = document.createElement("progress")
        progress.max = 100
        progress.value = task.progress
        progress.setAttribute("aria-label", label.textContent)
        row.append(label, progress)
        if (["running", "queued"].includes(task.state)) {
          const cancel = document.createElement("button")
          cancel.className = "button"
          cancel.textContent = "Hủy"
          cancel.onclick = () => desktop.cancelTask(task.id)
          row.append(cancel)
        }
        return row
      }),
    )
    for (const [id, task] of tasks) {
      if (!rows.includes(task) && !["running", "queued"].includes(task.state))
        tasks.delete(id)
    }
  })
}
