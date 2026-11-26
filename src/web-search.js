import { desktop } from "./native.js"

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return true
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
  return false
}

export function isSafePublicHttpsUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || "").trim())
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  const host = parsed.hostname.toLowerCase()
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[") ||
    isPrivateIpv4(host)
  ) {
    return null
  }
  return parsed.href
}

export function validateSearchEndpoint(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || "").trim())
  } catch {
    throw new Error("URL máy chủ tìm kiếm không hợp lệ.")
  }
  const isHttps = parsed.protocol === "https:"
  const isLoopback = parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname.toLowerCase())
  if (!isHttps && !isLoopback) {
    throw new Error("Máy chủ tìm kiếm chỉ hỗ trợ HTTPS hoặc HTTP cục bộ (localhost).")
  }
  return parsed.href.replace(/\/+$/, "")
}

export function stripHtmlToText(html, maxChars = 8000) {
  const cleaned = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
  const text = cleaned
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(đã rút gọn)" : text
}

async function searchWikipediaCors(query, lang, limit, signal) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    `&srlimit=${limit}&format=json&origin=*`
  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    })
    if (!response.ok) return []
    const data = await response.json()
    return (data?.query?.search ?? []).map((item) => ({
      title: item.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
      snippet: stripHtmlToText(item.snippet || "", 320).replace(/\s+/g, " "),
      source: `wikipedia:${lang}`,
    }))
  } catch {
    return []
  }
}

async function searchTavily(query, { limit, searchApiKey, signal }) {
  const key = String(searchApiKey || "").trim()
  if (!key) throw new Error("Hãy nhập API Key Tavily trong Cấu hình Web Search.")
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: limit,
      search_depth: "basic",
    }),
  })
  if (!response.ok) throw new Error(`Tavily trả lỗi ${response.status}.`)
  const data = await response.json()
  return (data?.results ?? []).slice(0, limit).map((item) => ({
    title: String(item.title || ""),
    url: String(item.url || ""),
    snippet: String(item.content || "").slice(0, 450),
    source: "tavily",
  }))
}

async function searchSearxng(query, { limit, searchUrl, signal }) {
  const base = validateSearchEndpoint(searchUrl)
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const response = await fetch(url, {
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`SearXNG trả lỗi ${response.status}.`)
  const data = await response.json()
  return (data?.results ?? []).slice(0, limit).map((item) => ({
    title: String(item.title || ""),
    url: String(item.url || ""),
    snippet: stripHtmlToText(item.content || "", 450).replace(/\s+/g, " "),
    source: "searxng",
  }))
}

export async function searchWeb(
  query,
  { limit = 5, provider = "auto", searchUrl = "", searchApiKey = "", signal } = {},
) {
  const clean = String(query || "").trim().slice(0, 240)
  if (!clean) throw new Error("Từ khóa tìm kiếm không được trống.")
  const capped = Math.max(1, Math.min(10, Number(limit) || 5))

  if (provider === "tavily") {
    const results = await searchTavily(clean, { limit: capped, searchApiKey, signal })
    return { query: clean, provider: "tavily", results }
  }
  if (provider === "searxng") {
    const results = await searchSearxng(clean, { limit: capped, searchUrl, signal })
    return { query: clean, provider: "searxng", results }
  }

  // Auto mode: prefer Electron main-process search (DuckDuckGo + Jisho + Wikipedia, no CORS limits).
  if (desktop?.webSearch) {
    const data = await desktop.webSearch(clean, { limit: capped })
    return { query: clean, provider: "desktop", results: data?.results ?? [] }
  }

  // Web browser fallback: CORS-friendly Wikipedia API (vi/en/ja).
  const hasCjk = /[\u3040-\u30ff\u4e00-\u9faf]/.test(clean)
  const langs = hasCjk ? ["ja", "en", "vi"] : ["vi", "en"]
  const groups = await Promise.all(langs.map((lang) => searchWikipediaCors(clean, lang, 3, signal)))
  const seen = new Set()
  const results = []
  for (const list of groups) {
    for (const item of list) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      results.push(item)
      if (results.length >= capped) break
    }
    if (results.length >= capped) break
  }
  return { query: clean, provider: "wikipedia", results }
}

export async function fetchWebPage(rawUrl, { maxChars = 8000, signal } = {}) {
  const safe = isSafePublicHttpsUrl(rawUrl)
  if (!safe) throw new Error("Chỉ cho phép đọc đường dẫn HTTPS công khai.")

  if (desktop?.fetchUrl) {
    return desktop.fetchUrl(safe, { maxChars })
  }

  // On Web browser, use Wikipedia REST/Action API with origin=* for Wikipedia links.
  const wikiMatch = /^https:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i.exec(safe)
  if (wikiMatch) {
    const lang = wikiMatch[1]
    const title = decodeURIComponent(wikiMatch[2].split("#")[0])
    const apiUrl =
      `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1` +
      `&titles=${encodeURIComponent(title)}&format=json&origin=*`
    const response = await fetch(apiUrl, {
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    })
    if (response.ok) {
      const data = await response.json()
      const pages = Object.values(data?.query?.pages ?? {})
      const extract = pages[0]?.extract ?? ""
      if (extract) {
        return {
          url: safe,
          title: pages[0].title || title,
          text: extract.length > maxChars ? extract.slice(0, maxChars) + "\n…(đã rút gọn)" : extract,
        }
      }
    }
  }

  try {
    const response = await fetch(safe, {
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`Máy chủ trả lỗi ${response.status}.`)
    const html = await response.text()
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    const title = titleMatch ? stripHtmlToText(titleMatch[1], 200).replace(/\s+/g, " ") : ""
    return { url: safe, title, text: stripHtmlToText(html, maxChars) }
  } catch (error) {
    throw new Error(
      "Không đọc trực tiếp được trang này trên trình duyệt (có thể do CORS). Dùng app Desktop hoặc cấu hình Tavily/SearXNG. " +
        error.message,
    )
  }
}
