const net = require("node:net")

const MAX_FETCH_BYTES = 512 * 1024
const MAX_HTML_DEPTH = 512
const TIMEOUT_MS = 12000
const USER_AGENT = "KhungThoai/1.0 (Manga Editor Research Harness)"
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])

function exceedsHtmlDepth(html, maxDepth = MAX_HTML_DEPTH) {
  let depth = 0
  let pos = 0
  const source = String(html || "")
  while (pos < source.length) {
    const start = source.indexOf("<", pos)
    if (start < 0) break
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4)
      if (end < 0) break
      pos = end + 3
      continue
    }
    const end = source.indexOf(">", start + 1)
    if (end < 0) break
    const raw = source.slice(start + 1, end).trim()
    pos = end + 1
    if (!raw || raw.startsWith("!") || raw.startsWith("?")) continue
    const closing = raw.startsWith("/")
    const tag = (closing ? raw.slice(1) : raw).split(/[\s/]/, 1)[0].toLowerCase()
    if (!tag || VOID_TAGS.has(tag) || raw.endsWith("/")) continue
    if (closing) depth = Math.max(0, depth - 1)
    else if (++depth > maxDepth) return true
  }
  return false
}

function truncateSafe(text, maxChars) {
  const s = String(text || "")
  if (s.length <= maxChars) return s
  let end = maxChars
  if (end > 0) {
    const code = s.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
  }
  return s.slice(0, end)
}

function isPrivateIp(host) {
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase()
  const version = net.isIP(clean)
  if (version === 4) {
    const parts = clean.split(".").map(Number)
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    return false
  }
  if (version === 6) {
    if (clean === "::1" || clean === "::" || clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80")) {
      return true
    }
    if (clean.startsWith("::ffff:")) return isPrivateIp(clean.slice(7))
    return false
  }
  return false
}

function isSafePublicHttpsUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || "").trim())
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  const host = parsed.hostname.toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return null
  }
  if (isPrivateIp(host)) return null
  return parsed.href
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
    })
}

function stripHtmlToText(html, maxChars = 8000) {
  const raw = String(html || "")
  if (exceedsHtmlDepth(raw)) return "[Nội dung HTML quá sâu — đã bỏ qua để đảm bảo an toàn.]"
  const cleaned = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed\b[^>]*>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    // Strip hidden elements that can smuggle hidden prompt-injection instructions.
    .replace(/<([a-z0-9-]+)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true["']?|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  const text = decodeHtmlEntities(cleaned)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > maxChars ? truncateSafe(text, maxChars) + "\n…(đã rút gọn)" : text
}

function unwrapDuckDuckGoUrl(rawHref) {
  const href = decodeHtmlEntities(rawHref || "").trim()
  if (!href) return null
  try {
    const normalized = href.startsWith("//") ? "https:" + href : href.startsWith("/") ? "https://duckduckgo.com" + href : href
    const parsed = new URL(normalized)
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const uddg = parsed.searchParams.get("uddg")
      return isSafePublicHttpsUrl(uddg)
    }
    return isSafePublicHttpsUrl(parsed.href)
  } catch {
    return null
  }
}

function parseDuckDuckGoHtml(html, limit = 5) {
  const source = String(html || "")
  // Never try to bypass bot/CAPTCHA challenges — return empty so caller falls back cleanly.
  if (/anomaly-modal|captcha|bots use duckduckgo/i.test(source)) return []
  const results = []
  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetPattern = /<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi
  const links = [...source.matchAll(linkPattern)]
  const snippets = [...source.matchAll(snippetPattern)]
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const url = unwrapDuckDuckGoUrl(links[i][1])
    if (!url) continue
    const title = stripHtmlToText(links[i][2], 200).replace(/\s+/g, " ")
    const snippet = snippets[i] ? stripHtmlToText(snippets[i][1], 400).replace(/\s+/g, " ") : ""
    if (!title) continue
    results.push({ title, url, snippet, source: "duckduckgo" })
  }
  return results
}

async function fetchTextLimited(url, { headers = {}, maxBytes = MAX_FETCH_BYTES } = {}) {
  const safe = isSafePublicHttpsUrl(url)
  if (!safe) throw new Error("Chỉ cho phép truy cập đường dẫn HTTPS công khai.")
  const response = await fetch(safe, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json,text/plain;q=0.9", ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!isSafePublicHttpsUrl(response.url || safe)) {
    throw new Error("Đường dẫn chuyển hướng không hợp lệ hoặc không an toàn.")
  }
  if (!response.ok) throw new Error(`Máy chủ trả mã lỗi ${response.status}.`)
  const reader = response.body?.getReader()
  if (!reader) return { url: response.url || safe, text: (await response.text()).slice(0, maxBytes) }
  const chunks = []
  let received = 0
  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - received
    chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value)
    received += value.byteLength
    if (received >= maxBytes) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  const combined = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  return { url: response.url || safe, text: combined.toString("utf8") }
}

async function searchWikipedia(query, lang, limit) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`
  try {
    const { text } = await fetchTextLimited(url, { maxBytes: 128 * 1024 })
    const data = JSON.parse(text)
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

async function searchJisho(query, limit) {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(query)}`
  try {
    const { text } = await fetchTextLimited(url, { maxBytes: 128 * 1024 })
    const data = JSON.parse(text)
    return (data?.data ?? []).slice(0, limit).map((entry) => {
      const jp = entry.japanese?.[0] ?? {}
      const word = jp.word || jp.reading || entry.slug
      const reading = jp.reading && jp.reading !== word ? ` (${jp.reading})` : ""
      const meanings = (entry.senses ?? [])
        .slice(0, 3)
        .map((s) => (s.english_definitions ?? []).join(", "))
        .filter(Boolean)
        .join("; ")
      return {
        title: `${word}${reading}`,
        url: `https://jisho.org/word/${encodeURIComponent(entry.slug || word)}`,
        snippet: meanings,
        source: "jisho",
      }
    })
  } catch {
    return []
  }
}

async function webSearch(query, options = {}) {
  const clean = String(query || "").trim().slice(0, 240)
  if (!clean) throw new Error("Hãy nhập từ khóa tìm kiếm.")
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5))
  const results = []
  const hasJapanese = /[\u3040-\u30ff\u4e00-\u9faf]/.test(clean)

  try {
    const { text } = await fetchTextLimited(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, {
      maxBytes: 256 * 1024,
    })
    results.push(...parseDuckDuckGoHtml(text, limit))
  } catch {
    // Fall through to Wikipedia / Jisho.
  }

  if (hasJapanese) {
    const jisho = await searchJisho(clean, Math.min(3, limit))
    results.push(...jisho)
  }

  if (results.length < Math.min(3, limit)) {
    const langs = hasJapanese ? ["ja", "en", "vi"] : ["vi", "en"]
    const wikiGroups = await Promise.all(langs.map((lang) => searchWikipedia(clean, lang, 3)))
    for (const group of wikiGroups) results.push(...group)
  }

  const deduped = []
  const seen = new Set()
  for (const item of results) {
    if (!item?.url || seen.has(item.url)) continue
    seen.add(item.url)
    deduped.push(item)
    if (deduped.length >= limit) break
  }
  return { query: clean, results: deduped }
}

async function fetchUrl(rawUrl, options = {}) {
  const maxChars = Math.max(500, Math.min(16000, Number(options.maxChars) || 8000))
  const { url, text: raw } = await fetchTextLimited(rawUrl)
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  const title = titleMatch ? stripHtmlToText(titleMatch[1], 200).replace(/\s+/g, " ") : ""
  return { url, title, text: stripHtmlToText(raw, maxChars) }
}

module.exports = {
  isSafePublicHttpsUrl,
  stripHtmlToText,
  parseDuckDuckGoHtml,
  webSearch,
  fetchUrl,
}
