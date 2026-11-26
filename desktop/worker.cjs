const { spawn } = require("node:child_process")
const { existsSync } = require("node:fs")

class TextureWorker {
  constructor(executable) {
    this.executable = existsSync(executable) ? executable : null
    this.tail = Promise.resolve()
    this.queued = 0
  }

  get available() {
    return this.executable !== null
  }

  redraw(sample) {
    const { width, height, inner, pixels } = sample ?? {}
    if (!this.executable || this.queued >= 8 || !validInput(width, height, inner, pixels)) return null
    this.queued++
    const run = () => this.executable ? this.request(width, height, inner, pixels) : null
    const result = this.tail.then(run)
    this.tail = result.catch(() => null)
    return result.catch(() => null).finally(() => { this.queued-- })
  }

  request(width, height, inner, pixels) {
    if (!this.child) this.start()
    const child = this.child
    const header = Buffer.alloc(24)
    const fields = [width, height, inner.left, inner.top, inner.right, inner.bottom]
    fields.forEach((value, index) => header.writeUInt32LE(value, index * 4))
    const expected = (inner.right - inner.left) * (inner.bottom - inner.top) * 4
    const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)

    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => this.stop(new Error("Texture worker timed out.")), 5000)
      this.requestInFlight = {
        resolve, reject, deadline, expected,
        header: Buffer.alloc(4), offset: 0, data: null,
      }
      const fail = (error) => { if (error && this.child === child) this.stop(error) }
      child.stdin.write(header, fail)
      child.stdin.write(bytes, fail)
    })
  }

  start() {
    const child = spawn(this.executable, this.args ?? [], { windowsHide: true, detached: this.detached ?? false, stdio: ["pipe", "pipe", "ignore"], env: this.environment ?? process.env })
    this.child = child
    child.stdout.on("data", (chunk) => { if (this.child === child) this.read(chunk) })
    child.stdin.on("error", (error) => { if (this.child === child) this.stop(error) })
    child.on("error", (error) => { if (this.child === child) this.stop(error) })
    child.on("exit", () => { if (this.child === child) this.stop(new Error("Texture worker exited.")) })
  }

  read(chunk) {
    const pending = this.requestInFlight
    if (!pending) return this.stop(new Error("Unexpected texture worker response."))
    if (!pending.data) {
      const count = Math.min(pending.header.length - pending.offset, chunk.length)
      chunk.copy(pending.header, pending.offset, 0, count)
      pending.offset += count
      if (pending.offset < pending.header.length) return

      const size = pending.header.readUInt32LE()
      if (size !== 0 && size !== pending.expected) return this.stop(new Error("Invalid texture worker frame."))
      pending.data = Buffer.alloc(size)
      pending.offset = 0
      chunk = chunk.subarray(count)
    }

    if (chunk.length > pending.data.length - pending.offset) return this.stop(new Error("Oversized texture worker frame."))
    chunk.copy(pending.data, pending.offset)
    pending.offset += chunk.length
    if (pending.offset === pending.data.length) {
      this.requestInFlight = null
      clearTimeout(pending.deadline)
      pending.resolve(pending.data.length ? pending.data : null)
    }
  }

  stop(error = new Error("Texture worker stopped.")) {
    const child = this.child
    this.child = null
    child?.kill()
    const pending = this.requestInFlight
    if (pending) {
      this.requestInFlight = null
      clearTimeout(pending.deadline)
      pending.reject(error)
    }
  }

  close() {
    this.executable = null
    this.stop()
  }
}

function validInput(width, height, inner, pixels) {
  if (!inner || !ArrayBuffer.isView(pixels) || pixels.BYTES_PER_ELEMENT !== 1) return false
  const { left, top, right, bottom } = inner
  return [width, height, left, top, right, bottom].every(Number.isSafeInteger) &&
    width > 0 && height > 0 && width * height <= 1_600_000 && pixels.byteLength === width * height * 4 &&
    left >= 0 && top >= 0 && right <= width && bottom <= height && right - left >= 2 && bottom - top >= 2
}

module.exports = { TextureWorker }
