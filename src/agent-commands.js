import { BUILTIN_SKILLS } from "./agent-skills.js"

export const SLASH_COMMANDS_HELP = [
  "Các lệnh nhanh trong khung Trợ lý AI:",
  "- `/help` — Hiện danh sách lệnh này.",
  "- `/plan [yêu cầu | off]` — Bật/tắt Chế độ Kế hoạch (hoặc bật và chạy ngay yêu cầu).",
  "- `/qc` — Rà soát toàn chương trước khi xuất (tràn chữ, câu chưa đặt, lỗi dịch, thuật ngữ).",
  "- `/autofit` — Yêu cầu AI kiểm tra và khớp cỡ chữ cho trang đang mở.",
  "- `/compact [ai]` — Nén lịch sử chat (thêm `ai` để nhờ chính LLM viết tóm tắt thông minh).",
  `- \`/skill <id>\` — Đổi nhanh hồ sơ biên tập (${BUILTIN_SKILLS.map((s) => s.id).join(", ")}).`,
  "- `/replay [id|latest]` — Phát lại một lượt đã ghi trong bảng “Ghi & phát lại”: xem lại đúng chuỗi công cụ, không gọi API và không chạy lại công cụ nào.",
  "- `/clear` — Bắt đầu phiên chat mới.",
].join("\n")

export function parseSlashCommand(input) {
  const trimmed = String(input || "").trim()
  if (!trimmed.startsWith("/")) return null
  const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (!match) return null
  const name = match[1].toLowerCase()
  const arg = (match[2] || "").trim()
  // A flag is only the first word: `/plan off now` is a typo for `/plan off`, not a request to turn
  // Plan Mode on with the prompt "off now". Leftover words after a flag are refused with the syntax
  // instead of being guessed at.
  const [flag = "", ...rest] = arg ? arg.split(/\s+/) : []
  const extra = rest.join(" ")

  if (name === "help" || name === "?") {
    return { kind: "help", text: SLASH_COMMANDS_HELP }
  }
  if (name === "clear" || name === "new") {
    return { kind: "clear" }
  }
  if (name === "compact") {
    const mode = flag.toLowerCase()
    if (!arg) return { kind: "compact", useLlm: false }
    if ((mode === "ai" || mode === "llm") && !extra) return { kind: "compact", useLlm: true }
    return { kind: "usage", text: "Cú pháp: `/compact` hoặc `/compact ai` (nhờ LLM viết tóm tắt)." }
  }
  if (name === "plan") {
    if (flag.toLowerCase() === "off") {
      return extra
        ? { kind: "usage", text: "Cú pháp: `/plan` (bật), `/plan off` (tắt) hoặc `/plan <yêu cầu>` (bật và chạy ngay)." }
        : { kind: "plan", enabled: false }
    }
    if (!arg) return { kind: "plan", enabled: true }
    return { kind: "plan", enabled: true, prompt: arg }
  }
  if (name === "qc") {
    return {
      kind: "prompt",
      prompt: arg
        ? `Chạy check_export_preflight và kiểm tra QC toàn chương, tập trung thêm vào: ${arg}`
        : "Chạy check_export_preflight cho toàn bộ chương, kiểm tra khung tràn chữ, câu chưa đặt, lỗi dịch và độ nhất quán với Bảng thuật ngữ rồi báo cáo chi tiết theo từng trang.",
    }
  }
  if (name === "autofit") {
    return {
      kind: "prompt",
      prompt: "Kiểm tra các khung thoại trên trang đang mở và chạy autofit_page để khớp cỡ chữ đẹp nhất không tràn khung.",
    }
  }
  if (name === "skill") {
    return { kind: "skill", skillId: arg.toLowerCase() }
  }
  if (name === "replay") {
    const id = arg.trim()
    return { kind: "replay", id: !id || id === "last" ? "latest" : id }
  }
  return { kind: "unknown", name }
}
