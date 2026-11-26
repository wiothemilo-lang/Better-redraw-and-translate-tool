import { autoFitBox as defaultAutoFitBox, clamp, makeBox as defaultMakeBox, textOverflows as defaultTextOverflows } from "./canvas.js"
import { findMatches, replaceMatches } from "./tools.js"
import {
  EXTERNAL_WEB_CONTENT_NOTICE,
  fetchWebPage as defaultFetchWebPage,
  searchWeb as defaultSearchWeb,
  truncateSafe,
} from "./web-search.js"

const hexColor = /^#[\da-f]{6}$/i

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
  checkpoint,
  render,
  commitLiveForm,
  readTranslationSettings,
  registerFontName,
  renderFontOptions,
  searchConfig = () => ({ provider: "auto", searchUrl: "", searchApiKey: "" }),
  searchWebFn = defaultSearchWeb,
  fetchWebPageFn = defaultFetchWebPage,
  makeBoxFn = defaultMakeBox,
  autoFitBoxFn = defaultAutoFitBox,
  textOverflowsFn = defaultTextOverflows,
}) {
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
  ]

  const byName = new Map(catalog.map((tool) => [tool.name, tool]))

  function isEnabled(tool, { allowEdits = true, allowWebSearch = true } = {}) {
    if (tool.category === "web" && !allowWebSearch) return false
    if (tool.category === "write" && !allowEdits) return false
    return true
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
    timeoutMs(name) {
      return byName.get(name)?.timeoutMs ?? 12000
    },
    async execute(name, args, { allowEdits = true, allowWebSearch = true, signal } = {}) {
      const tool = byName.get(name)
      if (!tool) return { ok: false, error: `Công cụ không tồn tại: ${name}` }
      if (!isEnabled(tool, { allowEdits, allowWebSearch })) {
        return { ok: false, error: `Công cụ "${name}" đang bị tắt bởi thiết lập quyền của người dùng.` }
      }
      try {
        const result = await tool.run(args ?? {}, { signal })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    },
  }
}
