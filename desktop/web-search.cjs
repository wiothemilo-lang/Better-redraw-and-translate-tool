const dns = require("node:dns")
const https = require("node:https")
const net = require("node:net")
const zlib = require("node:zlib")

const MAX_FETCH_BYTES = 512 * 1024
const MAX_HTML_DEPTH = 512
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 12000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
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

/**
 * Canonicalize an address so a range check cannot be dodged by an alternate spelling.
 * IPv6 goes through the WHATWG URL parser (lowercase, leading zeros dropped, longest zero
 * run compressed); anything it refuses — zone ids included — is reported as unusable.
 */
function normalizeIp(host) {
  const clean = String(host || "").replace(/^\[|\]$/g, "").toLowerCase().trim()
  const version = net.isIP(clean)
  if (version !== 6) return { version, clean }
  try {
    return { version, clean: new URL(`https://[${clean}]/`).hostname.slice(1, -1) }
  } catch {
    return { version, clean: null }
  }
}

function isPrivateIp(host) {
  const { version, clean } = normalizeIp(host)
  if (version === 4) {
    const parts = clean.split(".").map(Number)
    const [a, b, c] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    // Reserved / documentation / benchmark blocks are never legitimate web targets.
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && c === 100) return true
    if (a === 203 && b === 0 && c === 113) return true
    // Multicast, reserved and broadcast space.
    if (a >= 224) return true
    return false
  }
  if (version === 6) {
    if (!clean) return true
    const [first, second] = clean.split(":", 2).map((group) => parseInt(group || "0", 16))
    // IANA's global unicast assignments are in 2000::/3. This also excludes ULA,
    // scoped addresses, translation prefixes, and IPv4-mapped addresses.
    if ((first & 0xe000) !== 0x2000) return true
    if (first === 0x2001 && second === 0x0db8) return true // documentation
    if (first === 0x3fff && (second & 0xf000) === 0) return true // documentation
    if (first === 0x2002) return true // 6to4
    if (first === 0x2001 && second === 0) return true // Teredo
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

function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true })
}

/**
 * Resolve a hostname and refuse to continue if ANY answer points into a private,
 * loopback, link-local or otherwise reserved range. Returns the address to pin the
 * socket to, so DNS cannot be re-pointed after the check (DNS-rebinding / TOCTOU).
 */
async function resolvePublicAddress(hostname, { lookup = defaultLookup } = {}) {
  const clean = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase().trim()
  if (!clean) throw new Error("Đường dẫn không có tên miền hợp lệ.")
  if (net.isIP(clean)) {
    if (isPrivateIp(clean)) throw new Error(`Chặn truy cập địa chỉ IP nội bộ: ${clean}.`)
    return clean
  }
  let records
  try {
    records = await lookup(clean)
  } catch {
    throw new Error(`Không phân giải được tên miền ${clean}.`)
  }
  const addresses = (Array.isArray(records) ? records : [records])
    .map((record) => (typeof record === "string" ? record : record?.address))
    .filter((address) => typeof address === "string" && net.isIP(address) !== 0)
  if (!addresses.length) throw new Error(`Không phân giải được tên miền ${clean}.`)
  const blocked = addresses.find((address) => isPrivateIp(address))
  if (blocked) throw new Error(`Tên miền ${clean} trỏ tới địa chỉ IP nội bộ (${blocked}).`)
  return addresses[0]
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

const SKIP_SUBTREES = new Set(["script", "style", "noscript", "template", "iframe", "object", "svg"])
const BLOCK_END = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article"])

// An element is hidden only when its own attributes say so. Searching the tag for the word anywhere
// also matched a URL such as href="/hidden/page" and deleted text the reader can see.
function hiddenByAttributes(attributes) {
  if (/(^|\s)hidden(\s|=|\/|$)/i.test(attributes)) return true
  if (/aria-hidden\s*=\s*["']?true["']?/i.test(attributes)) return true
  return /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["']/i.test(attributes)
}

// Walks the markup as a token stream so a hidden subtree ends where its own element ends: matching
// `<tag ...hidden...>` up to the first `</tag>` cut a nested block in half and let the rest of the
// hidden text through.
function visibleHtmlText(html) {
  const source = String(html || "")
  const stack = []
  let hidden = 0
  let output = ""
  let pos = 0
  while (pos < source.length) {
    const start = source.indexOf("<", pos)
    if (start < 0) {
      if (!hidden) output += source.slice(pos)
      break
    }
    if (start > pos && !hidden) output += source.slice(pos, start)
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4)
      pos = end < 0 ? source.length : end + 3
      continue
    }
    const end = source.indexOf(">", start + 1)
    if (end < 0) {
      if (!hidden) output += source.slice(start)
      break
    }
    const raw = source.slice(start + 1, end).trim()
    pos = end + 1
    const closing = raw.startsWith("/")
    const name = (closing ? raw.slice(1) : raw).split(/[\s/]/, 1)[0].toLowerCase()
    if (!raw || raw.startsWith("!") || raw.startsWith("?") || !name) {
      if (!hidden) output += " "
      continue
    }
    if (!hidden) output += name === "br" || (closing && BLOCK_END.has(name)) ? "\n" : " "
    if (closing) {
      // Pop to the matching open element, releasing whatever hidden subtrees were opened inside it.
      let at = -1
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) { at = i; break }
      if (at >= 0) {
        for (let i = stack.length - 1; i >= at; i--) if (stack[i].hidden) hidden--
        stack.length = at
      }
      continue
    }
    if (VOID_TAGS.has(name) || raw.endsWith("/")) continue
    const isHidden = SKIP_SUBTREES.has(name) || hiddenByAttributes(raw)
    stack.push({ name, hidden: isHidden })
    if (isHidden) hidden++
  }
  return output
}

function stripHtmlToText(html, maxChars = 8000) {
  const raw = String(html || "")
  if (exceedsHtmlDepth(raw)) return "[Nội dung HTML quá sâu — đã bỏ qua để đảm bảo an toàn.]"
  const text = decodeHtmlEntities(visibleHtmlText(raw))
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

function decodeBody(buffer, contentEncoding, maxBytes = MAX_FETCH_BYTES) {
  const encoding = String(contentEncoding || "").toLowerCase().trim()
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(buffer, { maxOutputLength: maxBytes })
    if (encoding === "deflate") return zlib.inflateSync(buffer, { maxOutputLength: maxBytes })
    if (encoding === "br") return zlib.brotliDecompressSync(buffer, { maxOutputLength: maxBytes })
  } catch {
    throw new Error("Không giải nén được nội dung phản hồi từ máy chủ.")
  }
  return buffer
}

/**
 * Single request against an already-resolved address. Redirects are never followed
 * implicitly: a 3xx is reported back so the caller can validate the next hop.
 */
function requestOnce(targetUrl, { address, headers = {}, maxBytes = MAX_FETCH_BYTES, signal } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl)
    const isIpLiteral = net.isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      settle(value)
    }

    const req = https.request({
      method: "GET",
      // Connect to the pinned IP, but keep TLS verification and the Host header on the
      // original hostname so the certificate is still checked against the real name.
      host: address,
      port: parsed.port ? Number(parsed.port) : 443,
      path: `${parsed.pathname}${parsed.search}`,
      ...(isIpLiteral ? {} : { servername: parsed.hostname }),
      headers: {
        Host: parsed.host,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/json,text/plain;q=0.9",
        // Ask for an uncompressed body; still decode below if the server ignores this.
        "Accept-Encoding": "identity",
        ...headers,
      },
      agent: false,
      signal,
    }, (res) => {
      const status = res.statusCode || 0
      const empty = (location) => finish(resolve, { status, location, text: "" })

      if (REDIRECT_STATUSES.has(status)) {
        // A malformed Location header must not throw inside the socket callback.
        let location = null
        try {
          if (res.headers.location) location = new URL(res.headers.location, targetUrl).href
        } catch {
          location = null
        }
        res.destroy()
        empty(location)
        return
      }
      if (status < 200 || status >= 300) {
        res.destroy()
        empty(null)
        return
      }

      const chunks = []
      let received = 0
      const collect = () => {
        try {
          const body = decodeBody(Buffer.concat(chunks), res.headers["content-encoding"], maxBytes)
          finish(resolve, { status, location: null, text: body.toString("utf8") })
        } catch (error) {
          finish(reject, error)
        }
      }
      res.on("data", (chunk) => {
        if (received >= maxBytes) return
        const remaining = maxBytes - received
        chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
        received += chunk.length
        if (received >= maxBytes) {
          collect()
          res.destroy()
        }
      })
      // An empty 2xx body simply ends the stream; collect() then yields "".
      res.on("end", collect)
      res.on("error", (error) => finish(reject, error))
    })

    req.on("error", (error) => finish(reject, error))
    req.end()
  })
}

async function fetchTextLimited(rawUrl, { headers = {}, maxBytes = MAX_FETCH_BYTES, signal, lookup, request } = {}) {
  const resolveAddress = lookup ?? defaultLookup
  const send = request ?? requestOnce

  let current = isSafePublicHttpsUrl(rawUrl)
  if (!current) throw new Error("Chỉ cho phép truy cập đường dẫn HTTPS công khai.")

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Validate + pin on EVERY hop: DNS is re-resolved after each redirect and the socket
    // goes to that exact address, so an internal target cannot be reached via a rebound
    // name or a redirect chain.
    const address = await resolvePublicAddress(new URL(current).hostname, { lookup: resolveAddress })
    const hopSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS)
    let response
    try {
      response = await send(current, { address, headers, maxBytes, signal: hopSignal })
    } catch (error) {
      if (!signal?.aborted && (error?.name === "AbortError" || error?.name === "TimeoutError")) {
        throw new Error("Hết thời gian chờ phản hồi từ máy chủ.")
      }
      throw error
    }
    if (response.location) {
      const next = isSafePublicHttpsUrl(response.location)
      if (!next) throw new Error("Đường dẫn chuyển hướng không hợp lệ hoặc không an toàn.")
      current = next
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(REDIRECT_STATUSES.has(response.status)
        ? "Đường dẫn chuyển hướng không hợp lệ hoặc không an toàn."
        : `Máy chủ trả mã lỗi ${response.status}.`)
    }
    return { url: current, text: String(response.text ?? "") }
  }
  throw new Error("Đã vượt quá số lần chuyển hướng cho phép.")
}

async function searchWikipedia(query, lang, limit, signal) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`
  try {
    const { text } = await fetchTextLimited(url, { maxBytes: 128 * 1024, signal })
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

async function searchJisho(query, limit, signal) {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(query)}`
  try {
    const { text } = await fetchTextLimited(url, { maxBytes: 128 * 1024, signal })
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
  const { signal } = options
  if (signal?.aborted) throw new Error("Đã hủy yêu cầu tìm kiếm.")
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5))
  const results = []
  const hasJapanese = /[\u3040-\u30ff\u4e00-\u9faf]/.test(clean)

  try {
    const { text } = await fetchTextLimited(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, {
      maxBytes: 256 * 1024,
      signal,
    })
    results.push(...parseDuckDuckGoHtml(text, limit))
  } catch {
    // Fall through to Wikipedia / Jisho.
  }

  if (hasJapanese) {
    const jisho = await searchJisho(clean, Math.min(3, limit), signal)
    results.push(...jisho)
  }

  if (results.length < Math.min(3, limit)) {
    const langs = hasJapanese ? ["ja", "en", "vi"] : ["vi", "en"]
    const wikiGroups = await Promise.all(langs.map((lang) => searchWikipedia(clean, lang, 3, signal)))
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
  const { url, text: raw } = await fetchTextLimited(rawUrl, { signal: options.signal })
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  const title = titleMatch ? stripHtmlToText(titleMatch[1], 200).replace(/\s+/g, " ") : ""
  return { url, title, text: stripHtmlToText(raw, maxChars) }
}

module.exports = {
  isSafePublicHttpsUrl,
  resolvePublicAddress,
  requestOnce,
  fetchTextLimited,
  decodeBody,
  stripHtmlToText,
  parseDuckDuckGoHtml,
  webSearch,
  fetchUrl,
}
