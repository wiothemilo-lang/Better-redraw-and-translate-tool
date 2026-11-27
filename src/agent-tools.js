import { TOOL_APPROVAL_REJECTED, TOOL_APPROVAL_UNAVAILABLE } from "./agent-pipeline.js"
import { autoFitBox as defaultAutoFitBox, clamp, makeBox as defaultMakeBox, textOverflows as defaultTextOverflows } from "./canvas.js"
import { clonePagesForDraft, describeChange, diffGlossaryChange, diffPages, isRejectedChange } from "./agent-review.js"
import { lintChapter } from "./linter.js"
import {
  findTerm,
  formatTerminologyGraph,
  glossaryStatusText,
  mergeTerminology,
  parseTerminologyGraph,
  resolveTerms,
  termSummary,
} from "./terminology-graph.js"
import { normalizeFontName } from "./fonts.js"
import { PRESET_RESET_DEFAULTS } from "./presets.js"
import { lintStyleGuide, normalizeStyleGuide } from "./style-guide.js"
import { alignBoxes, distributeBoxes, findMatches, replaceMatches } from "./tools.js"
import { createToolRegistry } from "./tool-registry.js"
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
    const idx = pageIndex - 1
    return { page: idx >= 0 && idx < state.pages.length ? state.pages[idx] : null, index: idx }
  }
  const current = selectedPage()
  const index = current ? state.pages.indexOf(current) : -1
  return { page: current ?? null, index }
}

// A page-scoped read still reports project-wide page numbers. The offset is where the filtered
// slice starts in the project, so a finding from a scoped lint never claims to be on page 1, and
// an out-of-range page is an error instead of an empty scan dressed up as an empty project.
function resolveTargetPages(state, selectedPage, pageIndex) {
  if (!Number.isInteger(pageIndex)) return { pages: state.pages, offset: 0 }
  const { page } = resolvePage(state, selectedPage, pageIndex)
  if (!page) throw new Error(`Không tồn tại trang số ${pageIndex}.`)
  return { pages: [page], offset: state.pages.indexOf(page) }
}

function defaultCapturePageImage(page, { box = null, maxDim = 768 } = {}) {
  const img = page?.image
  const natW = img?.naturalWidth ?? 0
  const natH = img?.naturalHeight ?? 0
  if (!natW || !natH || typeof document === "undefined") {
    throw new Error("Không thể chụp ảnh trang hiện tại trong môi trường này.")
  }
  let sx = 0
  let sy = 0
  let sw = natW
  let sh = natH
  let cropped = false
  if (box) {
    const padX = Math.max(0.14, box.w * 0.6)
    const padY = Math.max(0.14, box.h * 0.6)
    const x0 = clamp(box.x - padX, 0, 1)
    const y0 = clamp(box.y - padY, 0, 1)
    const x1 = clamp(box.x + box.w + padX, 0, 1)
    const y1 = clamp(box.y + box.h + padY, 0, 1)
    sx = Math.floor(x0 * natW)
    sy = Math.floor(y0 * natH)
    sw = Math.max(16, Math.ceil((x1 - x0) * natW))
    sh = Math.max(16, Math.ceil((y1 - y0) * natH))
    cropped = true
  }
  const scale = Math.min(1, clamp(Number(maxDim) || 768, 384, 1280) / Math.max(sw, sh))
  const width = Math.max(16, Math.round(sw * scale))
  const height = Math.max(16, Math.round(sh * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height)
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82)
  const comma = dataUrl.indexOf(",")
  if (comma < 0) throw new Error("Không thể mã hóa ảnh trang để AI xem.")
  return {
    mimeType: "image/jpeg",
    base64: dataUrl.slice(comma + 1),
    width,
    height,
    cropped,
  }
}

export function createAgentTools({
  state,
  byId: liveById,
  selectedPage: liveSelectedPage,
  selectedIndex = () => -1,
  selectPage,
  checkpoint: liveCheckpoint,
  render: liveRender,
  commitLiveForm: liveCommitLiveForm,
  readTranslationSettings,
  registerFontName,
  renderFontOptions: liveRenderFontOptions,
  onTodosChange,
  onPlanSubmit,
  onAskUser,
  onApproveTool,
  searchConfig = () => ({ provider: "auto", searchUrl: "", searchApiKey: "" }),
  searchWebFn = defaultSearchWeb,
  fetchWebPageFn = defaultFetchWebPage,
  makeBoxFn = defaultMakeBox,
  autoFitBoxFn = defaultAutoFitBox,
  textOverflowsFn = defaultTextOverflows,
  capturePageImageFn = defaultCapturePageImage,
  // Extra descriptors (a project catalogue, a future desktop-bridged tool) join the built-in ones
  // before registration, so they are validated and dispatched on the same terms.
  extraTools = [],
}) {
  let currentTodos = []
  let currentPlan = null
  let reviewSession = null
  let reviewRejections = []
  // Set while a write tool runs against a draft: nothing may reach the live editor or the history
  // until the user accepts the change, so every mutating callback is muted.
  let draft = null

  const checkpoint = (...args) => {
    if (!draft) liveCheckpoint?.(...args)
  }
  const render = (...args) => {
    if (!draft) liveRender?.(...args)
  }
  const commitLiveForm = (...args) => {
    if (!draft) liveCommitLiveForm?.(...args)
  }
  const renderFontOptions = (...args) => {
    if (!draft) liveRenderFontOptions?.(...args)
  }
  const byId = (id) => (draft ? draft.fields.get(id) ?? null : liveById(id))
  const selectedPage = () => (draft ? draft.pages[selectedIndex()] ?? null : liveSelectedPage?.() ?? null)

  const catalog = [
    {
      name: "web_search",
      category: "web",
      sandbox: { network: true },
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
      sandbox: { network: true },
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
      sandbox: { dom: true },
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
          // findMatches indexes the pages array; every tool the model sees speaks 1-based page
          // numbers, so a match is reported the same way navigate_page and list_boxes do.
          data: { matches: matches.slice(0, 40).map((match) => ({ ...match, pageIndex: match.pageIndex + 1 })) },
        }
      },
    },
    {
      name: "update_box",
      category: "write",
      sandbox: { dom: true },
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
          bubbleFit: { type: "boolean", description: "Bật dàn chữ ôm theo đường cong bong bóng bầu dục." },
          warp: { type: "string", enum: ["none", "arc", "arcDown", "wave"], description: "Kiểu uốn chữ SFX." },
          warpAmount: { type: "number", description: "Độ cong uốn chữ (-50..50)." },
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
          // A staged box is not in the project yet, so the review must not teach the font picker a
          // family the user could still reject; the render that places the box registers it.
          const clean = draft ? normalizeFontName(args.font) : registerFontName?.(args.font) ?? normalizeFontName(args.font)
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
        if (typeof args.bubbleFit === "boolean") box.bubbleFit = args.bubbleFit
        if (["none", "arc", "arcDown", "wave"].includes(args.warp)) box.warp = args.warp
        if (Number.isFinite(args.warpAmount)) box.warpAmount = clamp(Math.round(args.warpAmount), -50, 50)
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
      sandbox: { dom: true },
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
        const box = makeBoxFn(page, { x, y, w, h }, text, state.defaultFont)
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
      sandbox: { dom: true },
      requiresApproval: () => true,
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
      sandbox: { dom: true },
      requiresApproval: () => true,
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
      name: "query_terminology",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 8000,
      description:
        "Tra Bảng thuật ngữ: nhập một dòng thoại để biết thuật ngữ nào áp dụng theo thứ tự ổn định (kèm lý do), hoặc một tên/thuật ngữ để xem alias, biến thể, dạng ưu tiên/dạng bị cấm, dạng từ và quan hệ (broader/narrower/related/conflict).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Dòng thoại hoặc văn bản cần tra thuật ngữ áp dụng." },
          term: { type: "string", description: "Tên gốc, tên dịch hoặc alias cần xem chi tiết." },
          limit: { type: "integer", description: "Số kết quả tối đa (1-40, mặc định 20)." },
        },
      },
      async run(args) {
        const settings = readTranslationSettings?.() ?? {}
        const graph = parseTerminologyGraph(settings.glossary ?? "")
        if (args?.term) {
          const term = findTerm(graph, args.term)
          if (!term) {
            return {
              summary: `Không có thuật ngữ nào khớp "${String(args.term).trim()}"`,
              data: { total: graph.terms.length, term: null },
            }
          }
          const summary = term.translate
            ? `"${term.source}" → "${term.target}"${term.forbidden.length ? ` · cấm: ${term.forbidden.join(", ")}` : ""}`
            : `"${term.source}" giữ nguyên, không dịch`
          return { summary, data: { total: graph.terms.length, term: termSummary(term, graph) } }
        }
        const text = String(args?.text ?? "")
        if (!text.trim()) {
          return {
            summary: glossaryStatusText(graph),
            data: {
              total: graph.terms.length,
              terms: graph.terms.map((term) => termSummary(term, graph)),
            },
          }
        }
        const limit = clamp(Math.round(Number(args?.limit) || 20), 1, 40)
        const matched = resolveTerms(graph, text, {
          sourceLanguage: settings.source ?? "",
          targetLanguage: settings.target ?? "",
          limit,
        })
        return {
          summary: matched.length
            ? `Áp dụng ${matched.length} thuật ngữ cho dòng này: ${matched.map((hit) => `"${hit.target}"`).join(", ")}`
            : `Dòng này không khớp thuật ngữ nào trong ${graph.terms.length} mục`,
          data: { total: graph.terms.length, matched },
        }
      },
    },
    {
      name: "update_glossary",
      category: "write",
      sandbox: { dom: true },
      description:
        "Thêm hoặc cập nhật thuật ngữ / tên nhân vật trong Bảng thuật ngữ của dự án. Mỗi mục là dòng 'nguồn = dịch', có thể kèm chỉ thị thuộc đồ thị: @alias, @variant, @pos, @keep, @prefer, @forbid, @broader, @narrower, @related, @conflict.",
      parameters: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: { type: "string" },
            description:
              "Danh sách mục, ví dụ ['五条悟 = Gojo Satoru', '先生 = Thầy\\n@pos honorific\\n@keep']. Mục trùng nguồn hoặc trùng alias được gộp vào mục đã có.",
          },
          mode: { type: "string", enum: ["append", "replace"], description: "append (mặc định) để thêm/gộp, replace để thay mới toàn bộ." },
        },
        required: ["entries"],
      },
      async run(args) {
        const field = byId("translation-glossary")
        if (!field) throw new Error("Không tìm thấy trường Bảng thuật ngữ.")
        const rawEntries = Array.isArray(args?.entries) ? args.entries : []
        const cleaned = rawEntries.filter((entry) => typeof entry === "string" ? entry.trim() : entry && typeof entry === "object")
        if (!cleaned.length) throw new Error("Danh sách thuật ngữ rỗng.")
        commitLiveForm?.()
        checkpoint()
        const mode = args?.mode === "replace" ? "replace" : "append"
        const base = mode === "replace" ? { terms: [], problems: [] } : parseTerminologyGraph(field.value)
        const merged = mergeTerminology(base, cleaned)
        if (!merged.graph.terms.length) throw new Error("Danh sách thuật ngữ rỗng.")
        field.value = formatTerminologyGraph(merged.graph)
        field.dispatchEvent?.(new Event("input"))
        render()
        return {
          summary: `Đã cập nhật Bảng thuật ngữ (${merged.added.length + merged.updated.length} mục, tổng ${merged.graph.terms.length} mục)`,
          data: {
            totalEntries: merged.graph.terms.length,
            added: merged.added,
            updated: merged.updated,
          },
        }
      },
    },
    {
      name: "autofit_page",
      category: "write",
      sandbox: { dom: true },
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
      sandbox: { dom: true },
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
        const { pages: targetPages, offset } = resolveTargetPages(state, selectedPage, args?.pageIndex)
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
        const settings = readTranslationSettings?.() ?? {}
        const qa = lintChapter(targetPages, {
          glossaryText: settings.glossary ?? "",
          sourceLanguage: settings.source ?? "Japanese",
          targetLanguage: settings.target ?? "Vietnamese",
          maxIssues: 25,
        })
        for (const item of qa.issues) {
          if (item.severity !== "warning") continue
          issues.push({
            type: item.type,
            pageIndex: item.pageIndex + offset,
            pageName: item.pageName,
            boxId: item.boxId,
            text: item.message,
          })
        }
        return {
          summary: issues.length
            ? `Phát hiện ${issues.length} vấn đề trên ${targetPages.length} trang`
            : `Tất cả ${targetPages.length} trang đều đạt chuẩn, sẵn sàng xuất`,
          data: { checkedPages: targetPages.length, totalIssues: issues.length, qaSummary: qa.byType, issues: issues.slice(0, 50) },
        }
      },
    },
    {
      name: "lint_chapter_qa",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 8000,
      description:
        "Quét tức thì toàn bộ chương (hoặc một trang) để tìm lỗi dịch thuật & biên tập: sót chữ gốc (Nhật/Hàn/Trung), lệch tên/thuật ngữ so với Bảng thuật ngữ, khung thoại mẫu/rỗng, và lỗi dấu câu/khoảng trắng thừa.",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số trang (1-based). Bỏ trống để quét cả chương." },
        },
      },
      async run(args) {
        const { pages: targetPages, offset } = resolveTargetPages(state, selectedPage, args?.pageIndex)
        if (!targetPages.length) {
          return { summary: "Không có trang nào để rà QA.", data: { total: 0, byType: {}, issues: [] } }
        }
        const settings = readTranslationSettings?.() ?? {}
        const qa = lintChapter(targetPages, {
          glossaryText: settings.glossary ?? "",
          sourceLanguage: settings.source ?? "Japanese",
          targetLanguage: settings.target ?? "Vietnamese",
        })
        return {
          summary: qa.total
            ? `Phát hiện ${qa.total} lỗi QA (sót gốc: ${qa.byType.untranslated_source}, thuật ngữ: ${qa.byType.glossary_violation}, dấu câu: ${qa.byType.punctuation_spacing})`
            : `Không có lỗi QA nào trên ${targetPages.length} trang`,
          data: { ...qa, issues: qa.issues.map((item) => ({ ...item, pageIndex: item.pageIndex + offset })) },
        }
      },
    },
    {
      name: "check_style_guide",
      category: "read",
      isConcurrencySafe: true,
      timeoutMs: 8000,
      description:
        "Rà ngay lập tức (0-token, không gọi LLM) toàn bộ chương hoặc một trang theo Hướng dẫn phong cách của dự án: dấu ngoặc kép, cách viết hoa và xử lý âm thanh/SFX. Nên chạy trước khi dịch hoặc chỉnh sửa hàng loạt để bắt lỗi theo trang/khung.",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số trang (1-based). Bỏ trống để quét cả chương." },
        },
      },
      async run(args) {
        const guide = normalizeStyleGuide(readTranslationSettings?.()?.styleGuide)
        if (!guide) {
          return {
            summary: "Dự án chưa có Hướng dẫn phong cách; mở 'Hướng dẫn phong cách…' trong phần cài đặt dịch để tạo.",
            data: { active: false, total: 0, byType: {}, issues: [] },
          }
        }
        const { pages: targetPages, offset } = resolveTargetPages(state, selectedPage, args?.pageIndex)
        if (!targetPages.length) {
          return { summary: "Không có trang nào để rà phong cách.", data: { active: true, total: 0, byType: {}, issues: [] } }
        }
        const qa = lintStyleGuide(targetPages, guide)
        return {
          summary: qa.total
            ? `Phát hiện ${qa.total} lỗi phong cách (ngoặc kép: ${qa.byType.quote_style}, viết hoa: ${qa.byType.casing}, SFX: ${qa.byType.sfx})`
            : `Không có lỗi phong cách nào trên ${targetPages.length} trang`,
          data: { active: true, ...qa, issues: qa.issues.map((item) => ({ ...item, pageIndex: item.pageIndex + offset })) },
        }
      },
    },
    {
      name: "inspect_page_image",
      category: "read",
      sandbox: { dom: true },
      isConcurrencySafe: true,
      timeoutMs: 12000,
      description:
        "Xem trực tiếp hình ảnh trang truyện hiện tại (hoặc ảnh cắt phóng to xung quanh một khung thoại cụ thể) để quan sát biểu cảm nhân vật, bối cảnh, đại từ xưng hô hoặc kiểm tra chữ có đè lên nét vẽ không.",
      parameters: {
        type: "object",
        properties: {
          pageIndex: { type: "integer", description: "Số trang (1-based). Mặc định trang đang mở." },
          boxId: { type: "string", description: "Mã khung thoại (tùy chọn) để cắt phóng to xung quanh bong bóng thoại và nhân vật đang nói." },
          maxDim: { type: "integer", description: "Cạnh lớn nhất (px, 384–1280, mặc định 768)." },
        },
      },
      async run(args) {
        const { page, index } = resolvePage(state, selectedPage, args?.pageIndex)
        if (!page) throw new Error("Không tìm thấy trang để xem ảnh.")
        const box = args?.boxId ? page.boxes.find((b) => b.id === args.boxId) : null
        if (args?.boxId && !box) throw new Error(`Không tìm thấy khung "${args.boxId}" trên trang ${index + 1}.`)
        const captured = await capturePageImageFn(page, { box, maxDim: args?.maxDim })
        return {
          summary: box
            ? `Đã đính kèm ảnh cắt quanh khung "${box.id}" (trang ${index + 1}, ${captured.width}×${captured.height})`
            : `Đã đính kèm ảnh trang ${index + 1} (${captured.width}×${captured.height})`,
          data: {
            pageIndex: index + 1,
            pageName: page.name,
            boxId: box?.id ?? null,
            cropped: Boolean(captured.cropped),
            width: captured.width,
            height: captured.height,
          },
          attachment: {
            mimeType: captured.mimeType,
            base64: captured.base64,
          },
        }
      },
    },
    {
      name: "navigate_page",
      category: "read",
      sandbox: { dom: true },
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
      sandbox: { dom: true },
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
      sandbox: { dom: true },
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
      sandbox: { dom: true },
      requiresApproval: (args) => args?.scope === "chapter",
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
        boxes.forEach((box) => Object.assign(box, PRESET_RESET_DEFAULTS, preset.style))
        render()
        return {
          summary: `Đã áp dụng mẫu "${preset.name}" cho ${boxes.length} khung (${scope})`,
          data: { presetName: preset.name, scope, updated: boxes.length },
        }
      },
    },
    {
      name: "ask_user",
      category: "interaction",
      sandbox: { host: ["askUser"] },
      timeoutMs: 0,
      description:
        "Đặt một câu hỏi trắc nghiệm ngắn cho người dùng ngay trong khung chat khi cần xác nhận cách dịch tên riêng, xưng hô hoặc phương án biên tập trước khi tiếp tục.",
      parameters: {
        type: "object",
        properties: {
          header: { type: "string", description: "Tiêu đề ngắn (vd: 'Chọn cách xưng hô')." },
          question: { type: "string", description: "Câu hỏi cụ thể cần người dùng chọn." },
          options: {
            type: "array",
            description: "Danh sách 2-4 lựa chọn gợi ý (đặt lựa chọn khuyên dùng đầu tiên).",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Nhãn ngắn của lựa chọn." },
                description: { type: "string", description: "Giải thích ngắn 1 câu." },
              },
              required: ["label"],
            },
          },
          allowCustom: { type: "boolean", description: "Cho phép người dùng gõ câu trả lời khác (mặc định true)." },
        },
        required: ["question"],
      },
      async run(args, { signal }) {
        const question = String(args?.question || "").trim()
        if (!question) throw new Error("Câu hỏi không được để trống.")
        if (!onAskUser) {
          throw new Error("Giao diện hiện không hỗ trợ thẻ hỏi tương tác; hãy hỏi người dùng trực tiếp trong tin nhắn.")
        }
        const options = Array.isArray(args?.options)
          ? args.options
            .filter((o) => o && typeof o.label === "string" && o.label.trim())
            .slice(0, 5)
            .map((o) => ({ label: o.label.trim().slice(0, 120), description: String(o.description || "").trim().slice(0, 200) }))
          : []
        const reply = await onAskUser({
          header: String(args?.header || "Cần bạn chọn").trim().slice(0, 80),
          question,
          options,
          allowCustom: args?.allowCustom !== false,
          signal,
        })
        if (!reply || reply.cancelled) {
          return {
            summary: "Người dùng đã bỏ qua câu hỏi",
            data: { cancelled: true },
            modelText: "Người dùng đã hủy thẻ hỏi để tự trả lời; hãy dừng chỉnh sửa và chờ chỉ dẫn thêm.",
          }
        }
        return {
          summary: `Người dùng chọn: ${reply.answer}`,
          data: { answer: reply.answer, custom: Boolean(reply.custom) },
          modelText: `Người dùng đã trả lời: ${reply.answer}`,
        }
      },
    },
  ]

  // The catalog above is the whole of what this module knows about a tool; permissions, timeouts and
  // dispatch belong to the registry, which validates every entry as it is registered.
  const registry = createToolRegistry(
    [...catalog, ...(Array.isArray(extraTools) ? extraTools : [])],
    { host: { askUser: Boolean(onAskUser) } },
  )

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
    // Directives belong to a term, so the count the model sees is terms, not text lines.
    const glossaryCount = parseTerminologyGraph(settings.glossary ?? "").terms.length
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
      glossaryCount,
      presetNames: (state.presets ?? []).map((p) => p.name),
      notesPreview: String(settings.notes || "").replace(/\s+/g, " ").trim().slice(0, 160),
      styleGuideActive: Boolean(normalizeStyleGuide(settings.styleGuide)),
    }
  }

  // A write tool runs against a cloned draft while a review is open: the live pages, the live
  // selection and the history stay untouched, and only the difference comes back as proposals.
  async function runStagedReview(tool, args, { signal, callId = "" } = {}) {
    liveCommitLiveForm?.()
    const livePages = state.pages
    const liveSelectedBoxIds = state.selectedBoxIds
    const liveBoxId = state.boxId
    const glossaryField = liveById("translation-glossary")
    const draftField = glossaryField ? { value: String(glossaryField.value ?? ""), dispatchEvent() {} } : null
    const fields = new Map()
    if (draftField) fields.set("translation-glossary", draftField)

    const working = { pages: clonePagesForDraft(livePages), fields }
    draft = working
    state.pages = working.pages
    if (liveSelectedBoxIds) state.selectedBoxIds = new Set([...liveSelectedBoxIds])
    let outcome
    try {
      outcome = await tool.run(args ?? {}, { signal })
    } finally {
      draft = null
      state.pages = livePages
      state.selectedBoxIds = liveSelectedBoxIds
      state.boxId = liveBoxId
    }

    const changes = diffPages(livePages, working.pages, { toolName: tool.name, toolCallId: callId })
    const glossaryChange = draftField ? diffGlossaryChange(glossaryField.value, draftField.value, { toolName: tool.name, toolCallId: callId }) : null
    if (glossaryChange) changes.push(glossaryChange)
    for (const change of changes) change.blocked = isRejectedChange(reviewRejections, change)
    reviewSession?.add(changes)

    if (!changes.length) {
      return {
        summary: outcome?.summary ?? "Không có thay đổi nào",
        data: { ...(outcome?.data ?? {}), staged: true, changes: [] },
      }
    }

    const blocked = changes.filter((change) => change.blocked)
    const fresh = changes.filter((change) => !change.blocked)
    const lines = [`Đã đề xuất ${changes.length} thay đổi và CHƯA áp dụng gì:`]
    for (const change of changes.slice(0, 8)) lines.push(`- ${describeChange(change)}`)
    if (blocked.length) {
      lines.push(`${blocked.length} thay đổi trùng với thay đổi người dùng đã từ chối trước đây; chỉ được áp dụng nếu người dùng chọn lại.`)
    }
    lines.push("Người dùng sẽ tự chọn từng thay đổi để áp dụng, nên đừng coi chúng là đã xong.")
    return {
      summary: fresh.length
        ? `Đã đề xuất ${changes.length} thay đổi, chờ duyệt`
        : `Bỏ qua ${blocked.length} thay đổi đã bị từ chối trước đó`,
      data: { staged: true, proposed: outcome?.data, blocked: blocked.length, changes },
      modelText: lines.join("\n"),
    }
  }

  return {
    definitions(flags = {}) {
      return registry.definitions(flags)
    },
    names() {
      return registry.names()
    },
    isConcurrencySafe(name) {
      return registry.isConcurrencySafe(name)
    },
    categoryOf(name) {
      return registry.categoryOf(name)
    },
    timeoutMs(name) {
      return registry.timeoutMs(name)
    },
    requiresApproval(name, args) {
      return registry.requiresApproval(name, args)
    },
    sandboxOf(name) {
      return registry.sandboxOf(name)
    },
    needsApproval(name, args, { confirmBulkEdits = false, forceWriteApproval = false } = {}) {
      const tool = registry.get(name)
      if (!tool) return false
      // Once the model has read untrusted web content in this turn, every mutation needs a
      // human decision (prompt-injection containment), not just the bulk/destructive ones.
      if (forceWriteApproval && tool.category === "write") return true
      return Boolean(confirmBulkEdits && tool.requiresApproval?.(args) === true)
    },
    getRuntimeSnapshot,
    getTodos() {
      return currentTodos
    },
    setTodos(todos) {
      currentTodos = Array.isArray(todos) ? todos : []
      onTodosChange?.(currentTodos)
    },
    getPlan() {
      return currentPlan
    },
    resetTurnState() {
      currentTodos = []
      currentPlan = null
    },
    // Opens the review window for one turn. Until endReview() every write tool stages its effect
    // instead of applying it; `rejections` is the project's memory of refused changes.
    beginReview(session, { rejections = [] } = {}) {
      reviewSession = session ?? null
      reviewRejections = Array.isArray(rejections) ? rejections : []
      return Boolean(reviewSession)
    },
    endReview() {
      reviewSession = null
      reviewRejections = []
    },
    isReviewing() {
      return Boolean(reviewSession)
    },
    async execute(name, args, { allowEdits = true, allowWebSearch = true, planMode = false, confirmBulkEdits = false, forceWriteApproval = false, signal, callId = "" } = {}) {
      const flags = { allowEdits, allowWebSearch, planMode }
      const tool = registry.get(name)
      if (!tool) return { ok: false, error: `Công cụ không tồn tại: ${name}` }
      if (!registry.isAvailable(tool, flags)) return registry.denial(tool, flags)
      const approvalRequired = (forceWriteApproval && tool.category === "write")
        || Boolean(confirmBulkEdits && tool.requiresApproval?.(args) === true)
      if (approvalRequired) {
        // Fail closed: never mutate without a real approver when approval is required.
        if (!onApproveTool) {
          return {
            ok: false,
            category: tool.category,
            code: TOOL_APPROVAL_UNAVAILABLE,
            error: `Cần người dùng phê duyệt thao tác "${name}" nhưng giao diện hiện không hỗ trợ hộp thoại duyệt.`,
          }
        }
        const decision = await onApproveTool({ name, args, signal })
        if (!decision?.approved) {
          return {
            ok: false,
            category: tool.category,
            code: TOOL_APPROVAL_REJECTED,
            error: decision?.reason
              ? `Người dùng từ chối thao tác "${name}": ${decision.reason}`
              : `Người dùng đã từ chối thực thi thao tác "${name}".`,
          }
        }
      }
      // A write inside a review window runs against a draft and returns the changes it would make,
      // so the registry still owns validation, timeout and error shaping on both paths.
      const staged = Boolean(reviewSession) && tool.category === "write"
      return registry.dispatch(name, args, {
        flags,
        signal,
        ...(staged && {
          run: (target, runArgs, context) => runStagedReview(target, runArgs, { ...context, callId }),
        }),
      })
    },
  }
}
