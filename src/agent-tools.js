import { autoFitBox as defaultAutoFitBox, clamp, makeBox as defaultMakeBox, textOverflows as defaultTextOverflows } from "./canvas.js"
import { alignBoxes, distributeBoxes, findMatches, replaceMatches } from "./tools.js"
import { translationSignature } from "./translation.js"
import {
  EXTERNAL_WEB_CONTENT_NOTICE,
  fetchWebPage as defaultFetchWebPage,
  searchWeb as defaultSearchWeb,
  truncateSafe,
} from "./web-search.js"

const hexColor = /^#[\da-f]{6}$/i
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

function validateTodoList(raw) {
  if (!Array.isArray(raw)) throw new Error("Tham số todos phải là một mảng.")
  const todos = []
  const seen = new Set()
  let activeCount = 0
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const content = String(item?.content || "").trim()
    const status = String(item?.status || "").trim()
    if (!content) throw new Error(`todos[${i}].content không được rỗng.`)
    if (!TODO_STATUSES.has(status)) {
      throw new Error(`todos[${i}].status phải thuộc pending | in_progress | completed.`)
    }
    if (seen.has(content)) throw new Error(`todos[${i}].content bị trùng lặp: "${content}".`)
    seen.add(content)
    if (status === "in_progress") activeCount++
    todos.push({ content: content.slice(0, 160), status })
  }
  if (activeCount > 1) {
    throw new Error(`Chỉ được giữ tối đa 1 mục in_progress tại một thời điểm (nhận ${activeCount}).`)
  }
  return todos
}

function firstMarkdownHeading(markdown) {
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim())
    if (match) return match[1]
  }
  return null
}

function resolvePage(state, selectedPage, pageIndex) {
  if (Number.isInteger(pageIndex)) {
    const idx = pageIndex >= 1 && pageIndex <= state.pages.length ? pageIndex - 1 : pageIndex
    return { page: state.pages[idx] ?? null, index: idx }
  }
  const current = selectedPage()
  const index = current ? state.pages.indexOf(current) : -1
  return { page: current ?? null, index }
}

export function createAgentTools({
  state,
  byId,
  selectedPage,
  selectedIndex,
  selectPage,
  checkpoint,
  render,
  commitLiveForm,
  readTranslationSettings,
  registerFontName,
  renderFontOptions,
  onTodosChange,
  onPlanSubmit,
  searchConfig = () => ({ provider: "auto", searchUrl: "", searchApiKey: "" }),
  searchWebFn = defaultSearchWeb,
  fetchWebPageFn = defaultFetchWebPage,
  makeBoxFn = defaultMakeBox,
  autoFitBoxFn = defaultAutoFitBox,
  textOverflowsFn = defaultTextOverflows,
}) {
  let currentTodos = []
  let currentPlan = null
  const catalog = [
    {
      name: "web_search",
      category: "web",
      isConcurrencySafe: true,
      timeoutMs: 18000,
      description:
        "Tìm kiếm thông tin trên web (tên nhân vật manga/anime, wiki, thuật ngữ tiếng Nhật/Hàn/Trung, từ lóng, SFX). Hỗ trợ tra 1 từ khóa (query) hoặc tối đa 5 từ khóa song song (queries).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Một từ khóa tìm kiếm." },
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Danh sách tối đa 5 từ khóa cần tra song song trong một lượt.",
          },
          limit: { type: "integer", description: "Số kết quả tối đa (1-8, mặc định 5)." },
        },
      },
      async run(args, { signal }) {
        const cfg = searchConfig()
        const limit = clamp(Math.round(Number(args?.limit) || 5), 1, 8)
        const rawList = Array.isArray(args?.queries) && args.queries.length
          ? args.queries
          : [args?.query]
        const queries = [...new Set(rawList.map((q) => String(q || "").trim()).filter(Boolean))].slice(0, 5)
        if (!queries.length) throw new Error("Hãy cung cấp query hoặc queries để tìm kiếm.")

        const batches = await Promise.all(queries.map((q) => searchWebFn(q, { ...cfg, limit, signal })))
        const seen = new Set()
        const merged = []
        let provider = "web"
        for (const batch of batches) {
          if (batch?.provider) provider = batch.provider
          for (const item of batch?.results ?? []) {
            if (!item?.url || seen.has(item.url)) continue
            seen.add(item.url)
            const snippet = truncateSafe(String(item.snippet || "").replace(/\s+/g, " ").trim(), 800)
            merged.push({ ...item, snippet })
            if (merged.length >= Math.min(10, limit * queries.length)) break
          }
        }
        const sourcesMarkdown = merged.length
          ? merged.map((s) => `- [${s.title || s.url}](${s.url})${s.snippet ? ` — ${s.snippet}` : ""}`).join("\n")
          : "No results found."
        const modelText = [
          EXTERNAL_WEB_CONTENT_NOTICE,
          `Sources:\n${sourcesMarkdown}`,
          "Cite the relevant URLs above as markdown links in your answer.",
        ].join("\n\n")
        return {
          summary: `Tìm thấy ${merged.length} kết quả (${provider}) cho ${queries.length > 1 ? `${queries.length} từ khóa` : `"${queries[0]}"`}`,
          data: { queries, provider, results: merged },
          modelText,
        }
      },
    },
    {
      name: "fetch_url",
      category: "web",
      isConcurrencySafe: true,
      timeoutMs: 18000,
      description:
        "Đọc nội dung văn bản từ một URL HTTPS công khai (ví dụ bài Wikipedia/Fandom wiki lấy được từ web_search).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Đường dẫn HTTPS công khai cần đọc." },
          maxChars: { type: "integer", description: "Giới hạn ký tự trả về (500-12000, mặc định 6000)." },
        },
        required: ["url"],
      },
      async run(args, { signal }) {
        const maxChars = clamp(Math.round(Number(args?.maxChars) || 6000), 500, 12000)
        const page = await fetchWebPageFn(args?.url, { maxChars, signal })
        const modelText = [
          EXTERNAL_WEB_CONTENT_NOTICE,
          `URL: ${page.url}`,
          page.title ? `Title: ${page.title}` : "",
          page.text,
        ].filter(Boolean).join("\n\n")
        return {
          summary: `Đã đọc "${page.title || page.url}" (${page.text.length} ký tự)`,
          data: page,
          modelText,
        }
      },
    },
    {
      name: "get_project_state",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 8000,
      description: "Xem tổng quan dự án hiện tại: số trang, tên các trang, trang đang mở, ngôn ngữ dịch, ghi chú và bảng thuật ngữ.",
      parameters: { type: "object", properties: {} },
      async run() {
        const settings = readTranslationSettings?.() ?? {}
        const currentIdx = selectedIndex()
        const data = {
          pageCount: state.pages.length,
          currentPageIndex: currentIdx >= 0 ? currentIdx + 1 : null,
          currentPageName: currentIdx >= 0 ? state.pages[currentIdx].name : null,
          pages: state.pages.map((p, i) => ({
            pageIndex: i + 1,
            name: p.name,
            boxCount: p.boxes.length,
            unplacedCount: p.unplaced?.length ?? 0,
            translationState: p.translationJob?.state ?? "none",
          })),
          queueCount: state.queue.length,
          sourceLanguage: settings.source ?? "",
          targetLanguage: settings.target ?? "",
          direction: settings.direction ?? "rtl",
          notes: settings.notes ?? "",
          glossary: settings.glossary ?? "",
        }
        return {
          summary: `${data.pageCount} trang, đang mở trang ${data.currentPageIndex ?? "—"}`,
          data,
        }
      },
    },
    {
      name: "list_boxes",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 8000,
      description: "Liệt kê tất cả khung thoại trên trang hiện tại (hoặc trang chỉ định theo số thứ tự 1-based), kèm cờ tràn khung (overflow).",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số trang (1-based). Bỏ trống để lấy trang đang mở." },
        },
      },
      async run(args) {
        const { page, index } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error("Không tìm thấy trang cần đọc.")
        const boxes = page.boxes.map((box, i) => {
          let overflow = false
          try {
            overflow = Boolean(textOverflowsFn(page, box))
          } catch {
            overflow = false
          }
          return {
            index: i + 1,
            id: box.id,
            text: box.text,
            x: Number(box.x.toFixed(3)),
            y: Number(box.y.toFixed(3)),
            w: Number(box.w.toFixed(3)),
            h: Number(box.h.toFixed(3)),
            size: box.size,
            font: box.font,
            color: box.color,
            align: box.align,
            overflow,
          }
        })
        const overflowCount = boxes.filter((b) => b.overflow).length
        return {
          summary: `Trang ${index + 1} (${page.name}): ${boxes.length} khung${overflowCount ? `, ${overflowCount} tràn chữ` : ""}`,
          data: { pageIndex: index + 1, pageName: page.name, boxes, unplaced: (page.unplaced ?? []).map((u) => u.text) },
        }
      },
    },
    {
      name: "search_chapter_text",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 8000,
      description: "Tìm kiếm từ hoặc cụm từ trong lời thoại toàn bộ chương.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Chuỗi cần tìm." },
          caseSensitive: { type: "boolean", description: "Phân biệt hoa/thường." },
          wholeWord: { type: "boolean", description: "Khớp nguyên từ." },
          includeUnplaced: { type: "boolean", description: "Bao gồm câu chưa đặt." },
        },
        required: ["query"],
      },
      async run(args) {
        const matches = findMatches(state.pages, String(args?.query || ""), {
          caseSensitive: Boolean(args?.caseSensitive),
          wholeWord: Boolean(args?.wholeWord),
          includeUnplaced: Boolean(args?.includeUnplaced),
        })
        return {
          summary: `Tìm thấy ${matches.length} khung khớp "${args?.query}"`,
          data: { matches: matches.slice(0, 40) },
        }
      },
    },
    {
      name: "update_box",
      category: "write",
      description: "Cập nhật nội dung hoặc kiểu chữ của một khung thoại cụ thể theo boxId (tự động tạo mốc Hoàn tác).",
      parameters: {
        type: "object",
        properties: {
          boxId: { type: "string", description: "ID của khung cần sửa (lấy từ list_boxes)." },
          pageIndex: { type: "integer", description: "Số trang (1-based). Bỏ trống để tìm trên trang đang mở." },
          text: { type: "string", description: "Nội dung lời thoại mới." },
          size: { type: "number", description: "Cỡ chữ (8-400)." },
          font: { type: "string", description: "Tên font chữ." },
          color: { type: "string", description: "Màu chữ dạng #rrggbb." },
          align: { type: "string", enum: ["left", "center", "right"] },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
          uppercase: { type: "boolean" },
          vertical: { type: "boolean" },
          lineHeight: { type: "number", description: "Giãn dòng (0.8-2.2)." },
          strokeWidth: { type: "number", description: "Độ dày viền chữ (0-24)." },
          strokeColor: { type: "string", description: "Màu viền chữ dạng #rrggbb." },
          shadowBlur: { type: "number", description: "Độ mờ bóng chữ (0-24)." },
          shadowColor: { type: "string", description: "Màu bóng chữ dạng #rrggbb." },
          fill: { type: "boolean" },
          fillShape: { type: "string", enum: ["rect", "ellipse", "rounded"] },
          fillColor: { type: "string", description: "Màu nền khung dạng #rrggbb." },
          cleanup: { type: "boolean" },
        },
        required: ["boxId"],
      },
      async run(args) {
        const { page } = resolvePage(state, selectedPage, args?.pageIndex)
        const targetPage = page ?? state.pages.find((p) => p.boxes.some((b) => b.id === args?.boxId))
        const box = targetPage?.boxes.find((b) => b.id === args?.boxId)
        if (!box) throw new Error("Không tìm thấy khung thoại với ID: " + args?.boxId)

        commitLiveForm?.()
        checkpoint()
        if (typeof args.text === "string" && args.text.trim()) box.text = args.text.trim()
        if (Number.isFinite(args.size)) box.size = clamp(Math.round(args.size), 8, 400)
        if (typeof args.font === "string" && args.font.trim()) {
          const clean = registerFontName?.(args.font) ?? args.font.trim().slice(0, 80)
          if (clean) {
            box.font = clean
            renderFontOptions?.()
          }
        }
        if (typeof args.color === "string" && hexColor.test(args.color)) box.color = args.color
        if (["left", "center", "right"].includes(args.align)) box.align = args.align
        if (typeof args.bold === "boolean") box.bold = args.bold
        if (typeof args.italic === "boolean") box.italic = args.italic
        if (typeof args.uppercase === "boolean") box.uppercase = args.uppercase
        if (typeof args.vertical === "boolean") box.vertical = args.vertical
        if (Number.isFinite(args.lineHeight)) box.lineHeight = clamp(args.lineHeight, .8, 2.2)
        if (Number.isFinite(args.strokeWidth)) box.strokeWidth = clamp(args.strokeWidth, 0, 24)
        if (typeof args.strokeColor === "string" && hexColor.test(args.strokeColor)) box.strokeColor = args.strokeColor
        if (Number.isFinite(args.shadowBlur)) box.shadowBlur = clamp(args.shadowBlur, 0, 24)
        if (typeof args.shadowColor === "string" && hexColor.test(args.shadowColor)) box.shadowColor = args.shadowColor
        if (typeof args.fill === "boolean") box.fill = args.fill
        if (["rect", "ellipse", "rounded"].includes(args.fillShape)) box.fillShape = args.fillShape
        if (typeof args.fillColor === "string" && hexColor.test(args.fillColor)) box.fillColor = args.fillColor
        if (typeof args.cleanup === "boolean") box.cleanup = args.cleanup
        render()
        return {
          summary: `Đã cập nhật khung "${box.text.slice(0, 40)}"`,
          data: { id: box.id, text: box.text, size: box.size },
        }
      },
    },
    {
      name: "create_box",
      category: "write",
      description: "Tạo một khung thoại mới trên trang hiện tại (tọa độ chuẩn hóa 0..1).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Nội dung lời thoại." },
          x: { type: "number", description: "Tọa độ trái (0..0.97)." },
          y: { type: "number", description: "Tọa độ trên (0..0.97)." },
          w: { type: "number", description: "Chiều rộng (0.03..1)." },
          h: { type: "number", description: "Chiều cao (0.03..1)." },
          pageIndex: { type: "integer", description: "Số trang (1-based). Mặc định trang đang mở." },
          fill: { type: "boolean", description: "Bật nền khung." },
          cleanup: { type: "boolean", description: "Bật xóa chữ gốc trong khung." },
        },
        required: ["text"],
      },
      async run(args) {
        const { page } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error("Chưa có trang nào đang mở để tạo khung.")
        const text = String(args?.text || "").trim()
        if (!text) throw new Error("Nội dung khung không được rỗng.")
        const w = clamp(Number.isFinite(args?.w) ? args.w : .34, .03, 1)
        const h = clamp(Number.isFinite(args?.h) ? args.h : .16, .03, 1)
        const x = clamp(Number.isFinite(args?.x) ? args.x : .33, 0, Math.max(0, 1 - w))
        const y = clamp(Number.isFinite(args?.y) ? args.y : .42, 0, Math.max(0, 1 - h))
        commitLiveForm?.()
        checkpoint()
        const box = makeBoxFn(page, { x, y, w, h }, text)
        if (typeof args?.fill === "boolean") box.fill = args.fill
        if (typeof args?.cleanup === "boolean") box.cleanup = args.cleanup
        page.boxes.push(box)
        state.boxId = box.id
        state.selectedBoxIds?.clear()
        state.selectedBoxIds?.add(box.id)
        render()
        return {
          summary: `Đã tạo khung mới "${text.slice(0, 40)}"`,
          data: { id: box.id, x, y, w, h, text },
        }
      },
    },
    {
      name: "delete_box",
      category: "write",
      description: "Xóa một khung thoại theo boxId.",
      parameters: {
        type: "object",
        properties: {
          boxId: { type: "string", description: "ID của khung cần xóa." },
          pageIndex: { type: "integer", description: "Số trang (1-based). Mặc định tìm trên trang đang mở." },
        },
        required: ["boxId"],
      },
      async run(args) {
        const { page } = resolvePage(state, selectedPage, args?.pageIndex)
        const targetPage = page ?? state.pages.find((p) => p.boxes.some((b) => b.id === args?.boxId))
        if (!targetPage || !targetPage.boxes.some((b) => b.id === args?.boxId)) {
          throw new Error("Không tìm thấy khung cần xóa.")
        }
        commitLiveForm?.()
        checkpoint()
        targetPage.boxes = targetPage.boxes.filter((b) => b.id !== args.boxId)
        if (state.boxId === args.boxId) state.boxId = null
        state.selectedBoxIds?.delete(args.boxId)
        render()
        return { summary: `Đã xóa khung ${args.boxId}`, data: { deleted: args.boxId } }
      },
    },
    {
      name: "replace_chapter_text",
      category: "write",
      description: "Tìm và thay thế hàng loạt lời thoại trên toàn chương (ví dụ sửa tên nhân vật hoặc cách xưng hô).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Từ/cụm cần tìm." },
          replacement: { type: "string", description: "Nội dung thay thế." },
          caseSensitive: { type: "boolean" },
          wholeWord: { type: "boolean" },
          includeUnplaced: { type: "boolean" },
        },
        required: ["query", "replacement"],
      },
      async run(args) {
        const query = String(args?.query || "")
        if (!query) throw new Error("Từ khóa cần thay không được trống.")
        commitLiveForm?.()
        const opts = {
          caseSensitive: Boolean(args?.caseSensitive),
          wholeWord: Boolean(args?.wholeWord),
          includeUnplaced: Boolean(args?.includeUnplaced),
        }
        const preview = findMatches(state.pages, query, opts)
        if (!preview.length) return { summary: `Không có khung nào chứa "${query}"`, data: { replacedItems: 0, replacedOccurrences: 0, skippedEmpty: 0 } }
        checkpoint()
        const result = replaceMatches(state.pages, query, String(args?.replacement ?? ""), opts)
        render()
        return {
          summary: `Đã thay ${result.replacedOccurrences} vị trí trong ${result.replacedItems} mục`,
          data: result,
        }
      },
    },
    {
      name: "update_glossary",
      category: "write",
      description: "Thêm hoặc cập nhật các cặp thuật ngữ / tên nhân vật (dạng 'từ gốc = từ dịch') vào Bảng thuật ngữ của dự án.",
      parameters: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: { type: "string" },
            description: "Danh sách dòng dạng 'Tên gốc = Tên dịch' (ví dụ ['五条悟 = Gojo Satoru']).",
          },
          mode: { type: "string", enum: ["append", "replace"], description: "append (mặc định) để thêm/gộp, replace để thay mới toàn bộ." },
        },
        required: ["entries"],
      },
      async run(args) {
        const field = byId("translation-glossary")
        if (!field) throw new Error("Không tìm thấy trường Bảng thuật ngữ.")
        const rawEntries = Array.isArray(args?.entries) ? args.entries : []
        const cleaned = rawEntries.map((line) => String(line || "").trim()).filter(Boolean)
        if (!cleaned.length) throw new Error("Danh sách thuật ngữ rỗng.")
        commitLiveForm?.()
        checkpoint()
        const mode = args?.mode === "replace" ? "replace" : "append"
        const existingLines = mode === "replace" ? [] : field.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const keyOf = (line) => line.split("=")[0].trim().toLowerCase()
        const merged = new Map()
        for (const line of existingLines) merged.set(keyOf(line), line)
        for (const line of cleaned) merged.set(keyOf(line), line)
        field.value = [...merged.values()].join("\n")
        field.dispatchEvent?.(new Event("input"))
        render()
        return {
          summary: `Đã cập nhật Bảng thuật ngữ (${cleaned.length} mục, tổng ${merged.size} mục)`,
          data: { totalEntries: merged.size, addedOrUpdated: cleaned },
        }
      },
    },
    {
      name: "autofit_page",
      category: "write",
      description: "Tự động chọn cỡ chữ lớn nhất không bị tràn khung cho tất cả các khung trên trang hiện tại (hoặc pageIndex).",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số trang (1-based). Mặc định trang đang mở." },
        },
      },
      async run(args) {
        const { page, index } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error("Không tìm thấy trang cần khớp cỡ.")
        if (!page.boxes.length) return { summary: "Trang không có khung chữ nào.", data: { updated: 0 } }
        commitLiveForm?.()
        checkpoint()
        const changes = []
        for (const box of page.boxes) {
          const prev = box.size
          const next = autoFitBoxFn(page, box)
          if (next !== prev) {
            box.size = next
            changes.push({ id: box.id, from: prev, to: next })
          }
        }
        render()
        return {
          summary: `Đã tự khớp cỡ chữ cho ${changes.length}/${page.boxes.length} khung trên trang ${index + 1}`,
          data: { pageIndex: index + 1, updated: changes.length, changes },
        }
      },
    },
    {
      name: "todo_write",
      category: "meta",
      timeoutMs: 5000,
      description:
        "Ghi hoặc cập nhật toàn bộ danh sách việc cần làm cho tác vụ nhiều bước (bỏ qua nếu chỉ có 1-2 bước đơn giản). Giữ đúng 1 mục `in_progress` khi đang làm và đánh dấu `completed` ngay khi xong.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Toàn bộ danh sách công việc mới (thay thế danh sách trước đó).",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Mô tả ngắn gọn từng bước." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "pending | in_progress | completed",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      async run(args) {
        const todos = validateTodoList(args?.todos)
        currentTodos = todos
        onTodosChange?.(todos)
        const count = (st) => todos.filter((t) => t.status === st).length
        const counts = {
          pending: count("pending"),
          inProgress: count("in_progress"),
          completed: count("completed"),
        }
        return {
          summary: `Danh sách bước: ${counts.completed}/${todos.length} xong (${counts.inProgress} đang làm)`,
          data: { todos, counts },
          modelText: `Đã cập nhật danh sách công việc: ${counts.pending} chờ, ${counts.inProgress} đang làm, ${counts.completed} xong.`,
        }
      },
    },
    {
      name: "submit_plan",
      category: "plan",
      timeoutMs: 5000,
      description:
        "Chỉ dùng khi Chế độ Kế hoạch (Plan Mode) đang bật. Trình bày bản kế hoạch Markdown hoàn chỉnh (bắt đầu bằng tiêu đề `# ...`) để người dùng duyệt trước khi bấm Thực thi kế hoạch.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description: "Bản kế hoạch đầy đủ dạng Markdown, bắt đầu bằng tiêu đề `# Tên kế hoạch`.",
          },
        },
        required: ["plan"],
      },
      async run(args) {
        const planText = String(args?.plan || "").trim()
        if (!/^#\s+\S/.test(planText)) {
          throw new Error("Kế hoạch phải bắt đầu bằng tiêu đề Markdown `# ...` và không được rỗng.")
        }
        const title = firstMarkdownHeading(planText) || "Kế hoạch biên tập"
        currentPlan = { title, markdown: planText, createdAt: Date.now() }
        onPlanSubmit?.(currentPlan)
        return {
          summary: `Đã lập kế hoạch: ${title}`,
          data: { title, markdown: planText },
          modelText: `Đã gửi kế hoạch "${title}" cho người dùng duyệt. Dừng chỉnh sửa và chờ người dùng bấm "Thực thi kế hoạch" hoặc góp ý thêm.`,
        }
      },
    },
    {
      name: "check_export_preflight",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 10000,
      description:
        "Chạy rà soát trước khi xuất (Preflight) trên toàn bộ chương hoặc một trang: phát hiện khung tràn chữ, câu chưa đặt, lỗi dịch và trang bị cũ so với cấu hình dịch mới.",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số trang (1-based). Bỏ trống để kiểm tra toàn bộ chương." },
        },
      },
      async run(args) {
        const targetPages = Number.isInteger(args?.pageIndex)
          ? [resolvePage(state, selectedPage, args.pageIndex).page].filter(Boolean)
          : state.pages
        if (!targetPages.length) {
          return { summary: "Chưa có trang nào trong dự án.", data: { totalIssues: 0, issues: [] } }
        }
        const currentSig = translationSignature(readTranslationSettings?.() ?? {})
        const issues = []
        if (!Number.isInteger(args?.pageIndex) && state.queue.length) {
          issues.push({ type: "queue", text: `${state.queue.length} câu chưa đặt trong hàng chờ chương.` })
        }
        for (const page of targetPages) {
          const pIndex = state.pages.indexOf(page) + 1
          if (page.unplaced?.length) {
            issues.push({ type: "unplaced", pageIndex: pIndex, pageName: page.name, count: page.unplaced.length })
          }
          if (page.translationJob?.state === "error") {
            issues.push({ type: "translation_error", pageIndex: pIndex, pageName: page.name, error: page.translationJob.error })
          }
          if (page.translationJob?.state === "pending") {
            issues.push({ type: "translation_pending", pageIndex: pIndex, pageName: page.name })
          }
          if (page.translationJob?.state === "done" && page.translationJob.signature !== currentSig) {
            issues.push({ type: "translation_stale", pageIndex: pIndex, pageName: page.name })
          }
          for (const box of page.boxes) {
            let overflow = false
            try {
              overflow = Boolean(textOverflowsFn(page, box))
            } catch {
              overflow = false
            }
            if (overflow) {
              issues.push({
                type: "overflow",
                pageIndex: pIndex,
                pageName: page.name,
                boxId: box.id,
                text: box.text.slice(0, 70),
              })
            }
          }
        }
        return {
          summary: issues.length
            ? `Phát hiện ${issues.length} vấn đề trên ${targetPages.length} trang`
            : `Tất cả ${targetPages.length} trang đều đạt chuẩn, sẵn sàng xuất`,
          data: { checkedPages: targetPages.length, totalIssues: issues.length, issues: issues.slice(0, 50) },
        }
      },
    },
    {
      name: "navigate_page",
      category: "read",
      timeoutMs: 5000,
      description: "Chuyển trình biên tập sang trang chỉ định (1-based) để người dùng theo dõi trực tiếp.",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số thứ tự trang cần mở (1-based)." },
        },
        required: ["pageIndex"],
      },
      async run(args) {
        const { page, index } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error(`Không tồn tại trang số ${args?.pageIndex}.`)
        if (selectPage) selectPage(page)
        else {
          state.pageId = page.id
          state.boxId = null
          state.selectedBoxIds?.clear()
          render()
        }
        return {
          summary: `Đã chuyển sang trang ${index + 1} (${page.name})`,
          data: { pageIndex: index + 1, pageName: page.name, boxCount: page.boxes.length },
        }
      },
    },
    {
      name: "align_boxes",
      category: "write",
      description: "Căn thẳng hàng từ 2 khung thoại trở lên theo mép hoặc trục giữa.",
      parameters: {
        type: "object",
        properties: {
          boxIds: { type: "array", items: { type: "string" }, description: "Danh sách ID các khung cần căn (≥ 2)." },
          alignment: {
            type: "string",
            enum: ["left", "centerX", "right", "top", "centerY", "bottom"],
            description: "Kiểu căn hàng.",
          },
          pageIndex: { type: "integer", description: "Số trang (1-based). Mặc định trang đang mở." },
        },
        required: ["boxIds", "alignment"],
      },
      async run(args) {
        const { page, index } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error("Không tìm thấy trang cần căn khung.")
        const ids = Array.isArray(args?.boxIds) ? args.boxIds.map(String) : []
        if (ids.length < 2) throw new Error("Cần ít nhất 2 boxId để căn hàng.")
        commitLiveForm?.()
        checkpoint()
        const changed = alignBoxes(page.boxes, ids, args.alignment)
        render()
        return {
          summary: changed
            ? `Đã căn hàng (${args.alignment}) cho ${ids.length} khung trên trang ${index + 1}`
            : "Các khung đã thẳng hàng sẵn.",
          data: { pageIndex: index + 1, changed, alignment: args.alignment, count: ids.length },
        }
      },
    },
    {
      name: "distribute_boxes",
      category: "write",
      description: "Chia đều khoảng cách ngang hoặc dọc cho từ 3 khung thoại trở lên.",
      parameters: {
        type: "object",
        properties: {
          boxIds: { type: "array", items: { type: "string" }, description: "Danh sách ID các khung (≥ 3)." },
          axis: { type: "string", enum: ["horizontal", "vertical"], description: "Trục chia đều." },
          pageIndex: { type: "integer", description: "Số trang (1-based). Mặc định trang đang mở." },
        },
        required: ["boxIds", "axis"],
      },
      async run(args) {
        const { page, index } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error("Không tìm thấy trang cần chia đều.")
        const ids = Array.isArray(args?.boxIds) ? args.boxIds.map(String) : []
        if (ids.length < 3) throw new Error("Cần ít nhất 3 boxId để chia đều khoảng cách.")
        commitLiveForm?.()
        checkpoint()
        const changed = distributeBoxes(page.boxes, ids, args.axis)
        render()
        return {
          summary: changed
            ? `Đã chia đều (${args.axis}) cho ${ids.length} khung trên trang ${index + 1}`
            : "Khoảng cách giữa các khung đã đều sẵn.",
          data: { pageIndex: index + 1, changed, axis: args.axis, count: ids.length },
        }
      },
    },
    {
      name: "apply_style_preset",
      category: "write",
      description: "Áp dụng một Mẫu dàn chữ (Style Preset) đã lưu trong dự án lên khung, cả trang hoặc cả chương.",
      parameters: {
        type: "object",
        properties: {
          presetName: { type: "string", description: "Tên mẫu dàn chữ đã lưu." },
          scope: { type: "string", enum: ["box", "page", "chapter"], description: "Phạm vi áp dụng (mặc định page)." },
          boxId: { type: "string", description: "ID khung khi scope='box'." },
          pageIndex: { type: "integer", description: "Số trang (1-based) khi scope='page' hoặc 'box'." },
        },
        required: ["presetName"],
      },
      async run(args) {
        const name = String(args?.presetName || "").trim().toLowerCase()
        const preset = (state.presets ?? []).find((p) => p.name.toLowerCase() === name)
        if (!preset) {
          const available = (state.presets ?? []).map((p) => p.name).join(", ")
          throw new Error(available ? `Không tìm thấy mẫu "${args?.presetName}". Mẫu hiện có: ${available}` : "Dự án chưa có mẫu dàn chữ nào.")
        }
        const scope = ["box", "page", "chapter"].includes(args?.scope) ? args.scope : "page"
        let boxes = []
        if (scope === "chapter") {
          boxes = state.pages.flatMap((p) => p.boxes)
        } else {
          const { page } = resolvePage(state, selectedPage, args?.pageIndex)
          if (!page) throw new Error("Không tìm thấy trang để áp dụng mẫu.")
          boxes = scope === "box"
            ? page.boxes.filter((b) => b.id === (args?.boxId || state.boxId))
            : page.boxes
        }
        if (!boxes.length) throw new Error("Không có khung thoại nào trong phạm vi áp dụng.")
        commitLiveForm?.()
        checkpoint()
        const defaults = {
          bold: false, italic: false, uppercase: false, vertical: false,
          lineHeight: 1.15, strokeWidth: 0, strokeColor: "#ffffff",
          shadowBlur: 0, shadowColor: "#000000",
          fillColor: "#ffffff", fillShape: "rect",
        }
        boxes.forEach((box) => Object.assign(box, defaults, preset.style))
        render()
        return {
          summary: `Đã áp dụng mẫu "${preset.name}" cho ${boxes.length} khung (${scope})`,
          data: { presetName: preset.name, scope, updated: boxes.length },
        }
      },
    },
  ]

  const byName = new Map(catalog.map((tool) => [tool.name, tool]))

  function isEnabled(tool, { allowEdits = true, allowWebSearch = true, planMode = false } = {}) {
    if (tool.category === "web" && !allowWebSearch) return false
    if (tool.category === "write" && (!allowEdits || planMode)) return false
    if (tool.category === "plan" && !planMode) return false
    return true
  }

  function getRuntimeSnapshot() {
    const settings = readTranslationSettings?.() ?? {}
    const current = selectedPage?.() ?? null
    const currentIdx = selectedIndex?.() ?? -1
    let overflowCount = 0
    if (current) {
      for (const box of current.boxes) {
        try {
          if (textOverflowsFn(current, box)) overflowCount++
        } catch {
          // Ignore measurement errors in headless test environments.
        }
      }
    }
    const glossaryLines = String(settings.glossary || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return {
      pageCount: state.pages.length,
      currentPageIndex: currentIdx >= 0 ? currentIdx + 1 : null,
      currentPageName: current?.name ?? null,
      currentPageSize: current?.image?.naturalWidth
        ? `${current.image.naturalWidth}×${current.image.naturalHeight}px`
        : "",
      boxCount: current?.boxes.length ?? 0,
      overflowCount,
      unplacedCount: current?.unplaced?.length ?? 0,
      queueCount: state.queue?.length ?? 0,
      glossaryCount: glossaryLines.length,
      presetNames: (state.presets ?? []).map((p) => p.name),
      notesPreview: String(settings.notes || "").replace(/\s+/g, " ").trim().slice(0, 160),
    }
  }

  return {
    definitions(flags = {}) {
      return catalog
        .filter((tool) => isEnabled(tool, flags))
        .map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
    isConcurrencySafe(name) {
      return byName.get(name)?.isConcurrencySafe === true
    },
    categoryOf(name) {
      return byName.get(name)?.category ?? "read"
    },
    timeoutMs(name) {
      return byName.get(name)?.timeoutMs ?? 12000
    },
    getRuntimeSnapshot,
    getTodos() {
      return currentTodos
    },
    getPlan() {
      return currentPlan
    },
    resetTurnState() {
      currentTodos = []
      currentPlan = null
    },
    async execute(name, args, { allowEdits = true, allowWebSearch = true, planMode = false, signal } = {}) {
      const tool = byName.get(name)
      if (!tool) return { ok: false, error: `Công cụ không tồn tại: ${name}` }
      if (!isEnabled(tool, { allowEdits, allowWebSearch, planMode })) {
        return {
          ok: false,
          category: tool.category,
          error: planMode && tool.category === "write"
            ? `Công cụ "${name}" đang bị khóa trong Chế độ Kế hoạch (Plan Mode). Hãy dùng submit_plan trước.`
            : `Công cụ "${name}" đang bị tắt bởi thiết lập quyền của người dùng.`,
        }
      }
      try {
        const result = await tool.run(args ?? {}, { signal })
        return { ok: true, category: tool.category, ...result }
      } catch (error) {
        return { ok: false, category: tool.category, error: error?.message || String(error) }
      }
    },
  }
}
