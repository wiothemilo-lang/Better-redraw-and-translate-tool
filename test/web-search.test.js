import assert from "node:assert/strict"
import test from "node:test"
import desktopSearch from "../desktop/web-search.cjs"
import { isSafePublicHttpsUrl, searchWeb, stripHtmlToText, validateSearchEndpoint } from "../src/web-search.js"

test("SSRF URL guards reject HTTP, loopback, private IPs and local hostnames", () => {
  for (const fn of [isSafePublicHttpsUrl, desktopSearch.isSafePublicHttpsUrl]) {
    assert.equal(fn("https://en.wikipedia.org/wiki/Manga"), "https://en.wikipedia.org/wiki/Manga")
    assert.equal(fn("http://en.wikipedia.org/wiki/Manga"), null)
    assert.equal(fn("https://localhost/secret"), null)
    assert.equal(fn("https://127.0.0.1/admin"), null)
    assert.equal(fn("https://192.168.1.1/router"), null)
    assert.equal(fn("https://10.0.0.1/internal"), null)
    assert.equal(fn("https://169.254.169.254/latest/meta-data"), null)
    assert.equal(fn("https://printer.local/"), null)
    assert.equal(fn("file:///etc/passwd"), null)
  }
  assert.equal(validateSearchEndpoint("http://localhost:8080/"), "http://localhost:8080")
  assert.throws(() => validateSearchEndpoint("http://evil.example.com"), /HTTPS hoặc HTTP cục bộ/)
})

test("parseDuckDuckGoHtml unwraps result URLs, strips markup, and yields empty on bot challenge", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FGintama&amp;rut=1">Gintama &amp; Wiki</a>
      <a class="result__snippet">A Japanese <b>manga</b> series.</a>
    </div>
    <div class="result">
      <a class="result__a" href="http://insecure.example.com/page">Insecure</a>
      <a class="result__snippet">Should be skipped</a>
    </div>
  `
  const results = desktopSearch.parseDuckDuckGoHtml(html, 5)
  assert.deepEqual(results, [{
    title: "Gintama & Wiki",
    url: "https://en.wikipedia.org/wiki/Gintama",
    snippet: "A Japanese manga series.",
    source: "duckduckgo",
  }])

  const challenge = '<div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div>'
  assert.deepEqual(desktopSearch.parseDuckDuckGoHtml(challenge, 5), [])
})

test("stripHtmlToText removes scripts/styles and truncates safely", () => {
  const text = stripHtmlToText("<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>Tiêu đề</h1><p>Nội dung &amp; ví dụ</p></body></html>")
  assert.equal(text, "Tiêu đề\nNội dung & ví dụ")
  assert.ok(stripHtmlToText("a".repeat(200), 50).includes("đã rút gọn"))
})

test("searchWeb supports Wikipedia CORS fallback, Tavily and SearXNG", async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? "GET" })
    if (url.includes("wikipedia.org")) {
      return {
        ok: true,
        json: async () => ({
          query: {
            search: [{ title: "Manga", snippet: "<span>Truyện tranh Nhật Bản</span>" }],
          },
        }),
      }
    }
    if (url === "https://api.tavily.com/search") {
      return {
        ok: true,
        json: async () => ({
          results: [{ title: "Tavily Result", url: "https://example.org/manga", content: "Details" }],
        }),
      }
    }
    if (url.startsWith("http://localhost:8080/search")) {
      return {
        ok: true,
        json: async () => ({
          results: [{ title: "SearXNG Result", url: "https://example.org/sfx", content: "<b>SFX</b>" }],
        }),
      }
    }
    return { ok: false, status: 404 }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const wiki = await searchWeb("Manga", { provider: "auto", limit: 3 })
  assert.equal(wiki.provider, "wikipedia")
  assert.equal(wiki.results[0].title, "Manga")
  assert.equal(wiki.results[0].snippet, "Truyện tranh Nhật Bản")

  const tavily = await searchWeb("Gojo", { provider: "tavily", searchApiKey: "tvly-key", limit: 2 })
  assert.equal(tavily.results[0].source, "tavily")

  const searxng = await searchWeb("SFX", { provider: "searxng", searchUrl: "http://localhost:8080", limit: 2 })
  assert.equal(searxng.results[0].snippet, "SFX")
})
