// Consecutive identical tool-call loop guard with escalating reminders,
// inspired by DeepSeek Harness `packages/guard/repeat-tool-reminder`.

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === "object") {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key])
    }
    return sorted
  }
  return value
}

export function canonicalizeArgs(args) {
  try {
    return JSON.stringify(sortJsonValue(args ?? {}))
  } catch {
    return String(args ?? "")
  }
}

function previewArgs(canonical, maxChars = 400) {
  if (canonical.length <= maxChars) return canonical
  return `${canonical.slice(0, maxChars)}… (+${canonical.length - maxChars} ký tự)`
}

export class RepeatToolGuard {
  constructor({ thresholds = [2, 4], previewChars = 400, exclude = ["todo_write"] } = {}) {
    this.thresholds = [...new Set(thresholds.filter((n) => Number.isInteger(n) && n >= 2))].sort((a, b) => a - b)
    if (!this.thresholds.length) this.thresholds = [2, 4]
    this.thresholdSet = new Set(this.thresholds)
    this.previewChars = Math.max(40, Math.floor(Number(previewChars) || 400))
    this.exclude = new Set(exclude)
    this.lastKey = ""
    this.consecutive = 0
  }

  observe(toolName, args) {
    if (!toolName || this.exclude.has(toolName)) return null
    const canonical = canonicalizeArgs(args)
    const key = `${toolName}::${canonical}`
    if (key === this.lastKey) {
      this.consecutive++
    } else {
      this.lastKey = key
      this.consecutive = 1
    }
    if (!this.thresholdSet.has(this.consecutive)) return null
    if (this.consecutive === this.thresholds[0]) {
      return {
        level: "gentle",
        toolName,
        count: this.consecutive,
        reminder:
          `<system-reminder>\nBạn vừa gọi lặp lại đúng công cụ \`${toolName}\` với tham số giống hệt nhau (${this.consecutive} lần liên tiếp). Hãy đọc kỹ kết quả vừa nhận, đổi hướng xử lý hoặc đổi tham số thay vì gọi lặp lại.\n</system-reminder>`,
      }
    }
    return {
      level: "detailed",
      toolName,
      count: this.consecutive,
      reminder:
        `<system-reminder>\nCảnh báo lặp vòng công cụ:\n- Công cụ: ${toolName}\n- Số lần liên tiếp: ${this.consecutive}\n- Tham số: ${previewArgs(canonical, this.previewChars)}\nCác lệnh lặp này không tạo thêm tiến triển. Tuyệt đối KHÔNG gọi lại \`${toolName}\` với tham số y hệt này nữa; hãy dùng công cụ khác hoặc tổng kết kết quả hiện có cho người dùng.\n</system-reminder>`,
    }
  }

  reset() {
    this.lastKey = ""
    this.consecutive = 0
  }
}
