// Genre-tailored editing & translation skills (inspired by DeepSeek Harness `skill` & `preset/persona`).

const SKILL_STORAGE_KEY = "khung-thoai-agent-skill"

export const BUILTIN_SKILLS = [
  {
    id: "default",
    name: "Mặc định (Đa dụng)",
    description: "Cân bằng giữa dịch tự nhiên, kiểm lỗi dàn chữ và tra cứu thuật ngữ.",
    prompt: "",
  },
  {
    id: "shounen",
    name: "Manga Shounen / Hành động",
    description: "Câu thoại dứt khoát, giàu năng lượng chiến đấu, SFX mạnh, xưng hô ngang hàng/đối đầu rõ.",
    prompt: [
      "Hồ sơ phong cách: **Manga Shounen / Hành động**.",
      "- Ưu tiên câu thoại ngắn, mạnh, dứt khoát, giữ nhịp chiến đấu nhanh; tránh văn phong dài dòng sách vở.",
      "- Phân biệt rõ xưng hô giữa đồng đội (cậu/tớ, ông/tôi, mày/tao khi thân thiết) và đối thủ (ngươi/ta, mi/ta).",
      "- Tên chiêu thức & SFX cần dịch gọn, giàu khí thế; nếu là tên kỹ năng đặc trưng trong series nổi tiếng, hãy dùng `web_search` xác minh tên bản dịch quen thuộc trước khi chốt.",
    ].join("\n"),
  },
  {
    id: "wuxia",
    name: "Cổ trang / Tiên hiệp / Kiếm hiệp",
    description: "Từ vựng Hán-Việt chuẩn, nhất quán danh xưng tại hạ / bản tọa / sư huynh / tiền bối.",
    prompt: [
      "Hồ sơ phong cách: **Cổ trang / Tiên hiệp / Manhwa-Manhua Võ hiệp**.",
      "- Giữ văn phong cổ trang trang trọng, dùng từ Hán-Việt chuẩn xác cho cảnh giới, tông môn, chiêu thức và danh xưng.",
      "- Xưng hô nhất quán theo vai vế (tại hạ/các hạ, đệ tử/sư phụ, vãn bối/tiền bối, bổn tọa/bản tôn, công tử/tiểu thư); tránh trộn ngôn ngữ hiện đại.",
      "- Khi thấy tên môn phái, công pháp hoặc nhân vật mới, đề xuất lưu ngay vào `update_glossary` để đồng bộ cả chương.",
    ].join("\n"),
  },
  {
    id: "romance",
    name: "Shoujo / Romance / Đời thường",
    description: "Tự nhiên, tinh tế về sắc thái cảm xúc và độ thân mật trong xưng hô.",
    prompt: [
      "Hồ sơ phong cách: **Shoujo / Romance / Slice of Life**.",
      "- Dịch mềm mại, tự nhiên như hội thoại đời thường tiếng Việt, chú ý tiểu từ cảm xúc (nhé, nha, đấy, cơ mà, thật sao...).",
      "- Giữ tinh tế sự chuyển đổi xưng hô theo mức độ thân thiết (cậu/tớ, anh/em, chị/em, tôi/anh) — nếu không chắc mối quan hệ nhân vật, hãy dùng `ask_user` hỏi người dùng.",
      "- Tránh câu quá thô cứng hoặc dịch sát nghĩa từng từ (word-by-word).",
    ].join("\n"),
  },
  {
    id: "qc",
    name: "Biên tập viên QC nghiêm ngặt",
    description: "Chuyên rà soát chính tả, tràn khung, lệch thuật ngữ và câu chưa đặt trước khi xuất.",
    prompt: [
      "Hồ sơ phong cách: **Biên tập viên QC (Quality Check) trước khi xuất bản**.",
      "- Luôn chạy `check_export_preflight` trước để liệt kê toàn bộ khung tràn chữ, câu chưa đặt và trang lỗi/lệch cấu hình dịch.",
      "- Soát lỗi chính tả, dấu câu, lặp từ, sự nhất quán tên riêng với Bảng thuật ngữ và kiểm tra xem cỡ chữ có quá nhỏ/lệch giữa các bong bóng tương đương không.",
      "- Báo cáo rõ theo từng trang (`Trang X · Khung Y`) trước khi sửa hàng loạt.",
    ].join("\n"),
  },
]

const byId = new Map(BUILTIN_SKILLS.map((s) => [s.id, s]))

export function getSkill(skillId) {
  return byId.get(skillId) ?? BUILTIN_SKILLS[0]
}

export function resolveSkillPrompt(skillId, customInstructions = "") {
  const skill = getSkill(skillId)
  const parts = []
  if (skill.prompt) parts.push(skill.prompt)
  const custom = String(customInstructions || "").trim()
  if (custom) parts.push(`Chỉ dẫn riêng của người dùng cho dự án:\n${custom.slice(0, 1200)}`)
  return parts.join("\n\n")
}

export function loadSkillPrefs(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(SKILL_STORAGE_KEY) || "null")
    if (!raw || typeof raw !== "object") return { skillId: "default", customInstructions: "" }
    return {
      skillId: byId.has(raw.skillId) ? raw.skillId : "default",
      customInstructions: typeof raw.customInstructions === "string" ? raw.customInstructions.slice(0, 1200) : "",
    }
  } catch {
    return { skillId: "default", customInstructions: "" }
  }
}

export function saveSkillPrefs({ skillId, customInstructions = "" }, storage = globalThis.localStorage) {
  const clean = {
    skillId: byId.has(skillId) ? skillId : "default",
    customInstructions: String(customInstructions || "").trim().slice(0, 1200),
  }
  try {
    storage?.setItem(SKILL_STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Ignore storage quota errors.
  }
  return clean
}
