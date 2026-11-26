class TaskQueue {
  constructor(createWorker, notify) {
    this.createWorker = createWorker
    this.notify = notify
    this.pending = []
    this.active = null
    this.jobs = new Map()
  }

  submit(id, operation, options, data) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || this.jobs.has(id)) {
      return Promise.reject(new Error("Mã tác vụ không hợp lệ hoặc đã tồn tại."))
    }
    if (this.jobs.size >= 16) return Promise.reject(new Error("Hàng đợi tác vụ đã đầy."))
    return new Promise((resolve, reject) => {
      const job = { id, operation, options, data, resolve, reject, cancelled: false, progress: 0 }
      this.jobs.set(id, job)
      this.pending.push(job)
      this.emit(job, "queued", 0, "Đang chờ")
      this.drain()
    })
  }

  emit(job, state, progress, stage) {
    job.progress = Math.max(job.progress, Math.min(100, Number(progress) || 0))
    this.notify({ id: job.id, operation: job.operation, state, progress: job.progress, stage })
  }

  async drain() {
    if (this.active || !this.pending.length) return
    const job = this.pending.shift()
    this.active = job
    const worker = this.createWorker()
    job.worker = worker
    this.emit(job, "running", 0, "Đang xử lý")
    try {
      const result = await worker.call(job.operation, job.options, job.data,
        (progress, stage) => this.emit(job, "running", progress, stage))
      if (job.cancelled) throw new Error("Đã hủy tác vụ.")
      this.emit(job, "done", 100, "Hoàn tất")
      job.resolve(result)
    } catch (error) {
      this.emit(job, job.cancelled ? "cancelled" : "error", job.progress, job.cancelled ? "Đã hủy" : error.message)
      job.reject(new Error(job.cancelled ? "Đã hủy tác vụ." : error.message))
    } finally {
      worker.close()
      this.jobs.delete(job.id)
      this.active = null
      this.drain()
    }
  }

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) return false
    job.cancelled = true
    if (job === this.active) job.worker.close()
    else {
      this.pending = this.pending.filter((item) => item !== job)
      this.jobs.delete(id)
      this.emit(job, "cancelled", 0, "Đã hủy")
      job.reject(new Error("Đã hủy tác vụ."))
    }
    return true
  }

  close() {
    for (const id of [...this.jobs.keys()]) this.cancel(id)
  }
}
module.exports = { TaskQueue }
