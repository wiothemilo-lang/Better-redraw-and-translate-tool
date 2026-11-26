const path = require("node:path")
const { existsSync } = require("node:fs")
const { TextureWorker } = require("./worker.cjs")

const maximumData = 512 * 1024 * 1024
const maximumMetadata = 4 * 1024 * 1024

class NativeWorker extends TextureWorker {
  constructor(executable) {
    super(executable)
    this.args = ["--rpc"]
    const ocr = path.join(path.dirname(executable), "ocr")
    const engine = path.join(ocr, "tesseract" + (process.platform === "win32" ? ".exe" : ""))
    this.environment = { ...process.env }
    if (existsSync(engine) && !process.env.KHUNG_THOAI_TESSERACT) {
      this.environment.KHUNG_THOAI_TESSERACT = engine
      this.environment.TESSDATA_PREFIX = path.join(ocr, "tessdata")
    }
  }

  call(operation, options = {}, data = new Uint8Array()) {
    if (!this.available) return Promise.reject(new Error("Chưa biên dịch worker C#. Chạy npm run desktop:native."))
    if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1 || data.byteLength > maximumData || this.queued >= 8) {
      return Promise.reject(new Error("Tác vụ native vượt giới hạn dữ liệu hoặc hàng đợi."))
    }
    const metadata = Buffer.from(JSON.stringify({ version: 1, operation, options }))
    if (metadata.length > maximumMetadata) return Promise.reject(new Error("Metadata native quá lớn."))
    this.queued++
    // Copy at enqueue time so later edits cannot mutate an in-flight request.
    const bytes = Buffer.from(data)
    const run = () => this.request(metadata, bytes, operation === "ocr" ? 90000 : 120000)
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result.finally(() => { this.queued-- })
  }

  redraw(sample) {
    if (!sample || typeof sample !== "object") return Promise.resolve(null)
    const { pixels, ...options } = sample
    return this.call("redraw", options, pixels).then(({ data }) => data.length ? data : null).catch(() => null)
  }

  request(metadata, bytes, timeout) {
    if (!this.child) this.start()
    const child = this.child
    const header = Buffer.alloc(12)
    header.write("KTR1")
    header.writeUInt32LE(metadata.length, 4)
    header.writeUInt32LE(bytes.length, 8)
    return new Promise((resolve, reject) => {
      this.requestInFlight = {
        resolve, reject, deadline: setTimeout(() => this.stop(new Error("Native worker timed out.")), timeout),
        header: Buffer.alloc(12), offset: 0, data: null, metadataLength: 0,
      }
      const fail = (error) => { if (error && this.child === child) this.stop(error) }
      child.stdin.write(header, fail)
      child.stdin.write(metadata, fail)
      child.stdin.write(bytes, fail)
    })
  }

  read(chunk) {
    const pending = this.requestInFlight
    if (!pending) return this.stop(new Error("Unexpected native response."))
    if (!pending.data) {
      const count = Math.min(12 - pending.offset, chunk.length)
      chunk.copy(pending.header, pending.offset, 0, count)
      pending.offset += count
      if (pending.offset < 12) return
      const metadataLength = pending.header.readUInt32LE(4)
      const size = pending.header.readUInt32LE(8)
      if (pending.header.toString("ascii", 0, 4) !== "KTR1" ||
          metadataLength < 2 || metadataLength > maximumMetadata || size > maximumData) {
        return this.stop(new Error("Invalid native response frame."))
      }
      pending.metadataLength = metadataLength
      pending.data = Buffer.alloc(metadataLength + size)
      pending.offset = 0
      chunk = chunk.subarray(count)
    }
    if (chunk.length > pending.data.length - pending.offset) return this.stop(new Error("Oversized native frame."))
    chunk.copy(pending.data, pending.offset)
    pending.offset += chunk.length
    if (pending.offset !== pending.data.length) return
    this.requestInFlight = null
    clearTimeout(pending.deadline)
    try {
      const result = JSON.parse(pending.data.toString("utf8", 0, pending.metadataLength))
      if (result.version !== 1 || typeof result.ok !== "boolean") throw new Error("Unsupported native response.")
      if (!result.ok) pending.reject(new Error(result.error))
      else pending.resolve({ result, data: pending.data.subarray(pending.metadataLength) })
    } catch (error) { pending.reject(error) }
  }
}

module.exports = { NativeWorker }
