import assert from "node:assert/strict"
import test from "node:test"
import { Readable } from "node:stream"
import { credentialHandle } from "../desktop/credential-ipc.cjs"
import {
  PROVIDER_CHANNELS,
  PROVIDER_CODES,
  PROVIDER_MESSAGES,
  ProviderTransport,
  SecretRedactor,
  buildHeaders,
  describeContentType,
  failureOf,
  geminiDestination,
  loopbackAddress,
  openAiDestination,
  parseRetryAfterMs,
  providerChannel,
  providerError,
  sanitizeProviderError,
  senderKeyOf,
} from "../desktop/provider-transport.cjs"

const GEMINI_KEY = "AIza-fake-gemini-6b1d4c8e"
const OPENAI_KEY = "sk-fake-openai-9f3a2c7d"
const PUBLIC_ADDRESS = "93.184.216.34"
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

// Every leakage assertion goes through these two: a carrier is either a JSON string or a raw chunk,
// and neither may contain the key or the half of it that would still be usable.
const carriers = (value) => (typeof value === "string" ? [value] : [JSON.stringify(value ?? null)])
function assertNoSecret(value, secret, label) {
  for (const carrier of carriers(value)) {
    assert.equal(carrier.includes(secret), false, label + " carried the plaintext key")
    assert.equal(carrier.includes(secret.slice(0, Math.floor(secret.length / 2))), false, label + " carried a key prefix")
  }
}

function tracked(stream, signal, onAbort) {
  const destroy = stream.destroy.bind(stream)
  stream.destroy = (error) => destroy(error)
  // An abort while nothing is consuming the stream must not surface as an uncaught exception.
  stream.on("error", () => {})
  signal?.addEventListener?.("abort", () => {
    if (!stream.destroyed) stream.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }))
    onAbort?.()
  }, { once: true })
  return stream
}

function readable(chunks, signal) {
  return tracked(Readable.from(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))), signal)
}

// A response that produces nothing until the caller aborts it, so an exchange can be observed in
// flight without any timer.
function stalled(signal) {
  return tracked(new Readable({ read() {} }), signal)
}

// A fake HTTP layer: it records exactly the options main built and answers with controlled bytes.
function fakeTransport(handler = () => ({ status: 200, headers: {}, chunks: ["{}"] })) {
  const calls = []
  const request = async (options, url) => {
    calls.push({ ...options, url })
    const answer = (await handler(options, calls.length - 1)) ?? {}
    return {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
      response: answer.response ?? readable(answer.chunks ?? [], options.signal),
    }
  }
  return { calls, request }
}

// No test may reach a resolver or a socket: every public hostname answers with one fixed address.
const publicLookup = async () => [{ address: PUBLIC_ADDRESS, family: 4 }]

function fakeStore(keys = {}) {
  const reads = []
  return {
    reads,
    async read(handle) {
      reads.push(handle)
      return Object.hasOwn(keys, handle) ? keys[handle] : null
    },
  }
}

function eventSink() {
  const events = []
  let settled = null
  return {
    events,
    emit(senderKey, payload) {
      events.push({ senderKey, ...payload })
      if (payload.type === "end" || payload.type === "error") {
        const resolve = settled
        settled = null
        resolve?.(payload)
      }
    },
    settled() {
      const terminal = events.find((event) => event.type === "end" || event.type === "error")
      if (terminal) return Promise.resolve(terminal)
      return new Promise((resolve) => { settled = resolve })
    },
    chunks() {
      return events.filter((event) => event.type === "chunk").map((event) => event.text)
    },
  }
}

function provider({ keys = {}, lookup = publicLookup, handler, transport = fakeTransport(handler) } = {}) {
  const store = fakeStore(keys)
  const sink = eventSink()
  const instance = new ProviderTransport({ credentials: store, emit: sink.emit, request: transport.request, lookup })
  return { transport, store, sink, instance }
}

const geminiRequest = (overrides = {}) => ({
  provider: "gemini",
  operation: "generateContent",
  model: "gemini-2.5-flash-lite",
  payload: { contents: [{ parts: [{ text: "xin chào" }] }] },
  ...overrides,
})

const openAiRequest = (overrides = {}) => ({
  provider: "openai",
  operation: "chat.completions",
  endpoint: "https://api.example.com/v1",
  payload: { model: "qwen2.5:7b", temperature: 0.2, messages: [{ role: "user", content: "hi" }] },
  ...overrides,
})

const openAiHandle = credentialHandle("openai:https://api.example.com/v1")
const geminiHandle = credentialHandle("gemini:fixed")

test("Gemini destination is a fixed origin with a validated model and operation", async () => {
  const { instance, transport, sink } = provider({ keys: { [geminiHandle]: GEMINI_KEY } })
  const result = await instance.execute("w1", geminiRequest())
  assert.deepEqual(result, { ok: true, status: 200, contentType: "text", body: "{}" })

  assert.equal(transport.calls.length, 1)
  const [call] = transport.calls
  assert.equal(call.method, "POST")
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent")
  assert.equal(call.host, PUBLIC_ADDRESS)
  assert.equal(call.port, 443)
  assert.equal(call.servername, "generativelanguage.googleapis.com")
  assert.equal(call.path, "/v1beta/models/gemini-2.5-flash-lite:generateContent")
  assert.equal(call.headers.Host, "generativelanguage.googleapis.com")
  assert.equal(call.headers["x-goog-api-key"], GEMINI_KEY)
  assert.equal(call.headers["Content-Type"], "application/json")
  // The Gemini key is header-only: nothing in the URL, the path or the body may carry it.
  assert.equal(call.url.includes(GEMINI_KEY), false)
  assert.equal(String(call.path).includes(GEMINI_KEY), false)
  assert.equal(String(call.body).includes(GEMINI_KEY), false)
  assert.equal("authorization" in call.headers, false)
  assertNoSecret(sink.events, GEMINI_KEY, "events")

  // Streaming selects the other operation and the alt=sse query, both derived in main.
  const streaming = provider({ keys: { [geminiHandle]: GEMINI_KEY } })
  streaming.transport = fakeTransport(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, chunks: ["data: {}\n\n"] }))
  const instance2 = new ProviderTransport({
    credentials: streaming.store, emit: streaming.sink.emit, request: streaming.transport.request, lookup: publicLookup,
  })
  const started = await instance2.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(started.ok, true)
  assert.equal(started.contentType, "sse")
  assert.deepEqual(await instance2.activate("w1", started.ticket), { ok: true, active: true })
  await streaming.sink.settled()
  assert.equal(
    streaming.transport.calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse",
  )
  assert.equal(streaming.transport.calls[0].port, 443)
  assert.match(streaming.transport.calls[0].headers.Accept, /text\/event-stream/)
})

test("Gemini refuses models and operations that are not a single validated segment", () => {
  for (const model of [
    "../../v1/other", "gemini/x", "Gemini-2.5", "gemini:generateContent", "../secrets", "gemini%2Fflash",
    "-leading", "trailing-", "gemini flash", "a".repeat(65), "", 42, null, undefined, {}, ["gemini"],
  ]) {
    for (const operation of ["generateContent", "streamGenerateContent"]) {
      assert.throws(
        () => geminiDestination(model, operation),
        (error) => error.code === PROVIDER_CODES.MODEL,
        "model " + String(model) + " was accepted",
      )
    }
  }
  for (const operation of ["generatecontent", "streamGenerateContent?alt=json", "chat.completions", "../x", ""]) {
    assert.throws(
      () => geminiDestination("gemini-2.5-flash-lite", operation),
      (error) => error.code === PROVIDER_CODES.OPERATION,
    )
  }
  // A dot-dot model cannot be laundered into the path: the assembled URL is re-checked.
  assert.equal(
    geminiDestination("gemini-3.1-flash-lite", "generateContent").url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
  )
})

test("the OpenAI-compatible destination is derived from the canonical credential scope", async () => {
  const { instance, transport, store, sink } = provider({ keys: { [openAiHandle]: OPENAI_KEY } })
  // A trailing slash and a differently-cased host identify the same endpoint, so they reach the same key.
  const result = await instance.execute("w1", openAiRequest({ endpoint: "https://API.example.com/v1/" }))
  assert.equal(result.ok, true)
  assert.deepEqual(store.reads, [openAiHandle], "the key was read under a scope other than the canonical one")
  assert.equal(transport.calls[0].url, "https://api.example.com/v1/chat/completions")
  assert.equal(transport.calls[0].path, "/v1/chat/completions")
  assert.equal(transport.calls[0].host, PUBLIC_ADDRESS)
  assert.equal(transport.calls[0].headers.Authorization, "Bearer " + OPENAI_KEY)
  assert.equal(transport.calls[0].headers.Host, "api.example.com")
  assert.equal("x-goog-api-key" in transport.calls[0].headers, false)
  assertNoSecret(result, OPENAI_KEY, "result")
  assertNoSecret(sink.events, OPENAI_KEY, "events")

  // One character of endpoint difference is a different scope, so the key stored for v1 is never
  // attached to v2. The call itself still happens keyless, as any endpoint without a stored key does.
  const mismatch = await instance.execute("w1", openAiRequest({ endpoint: "https://api.example.com/v2" }))
  assert.equal(mismatch.ok, true)
  assert.equal(store.reads.length, 2)
  assert.equal(store.reads[1], credentialHandle("openai:https://api.example.com/v2"))
  assert.notEqual(store.reads[1], openAiHandle)
  assert.equal(transport.calls.length, 2)
  assert.equal("Authorization" in transport.calls[1].headers, false, "a key was reused for another endpoint")
  assertNoSecret(mismatch, OPENAI_KEY, "scope mismatch")
})

test("the renderer cannot supply a destination, a method or a header", async () => {
  const { instance, transport } = provider({ keys: { [openAiHandle]: OPENAI_KEY } })
  // Extra fields are ignored rather than merged: nothing in the request can redirect the call.
  const hostile = openAiRequest({
    url: "https://evil.example/steal",
    method: "DELETE",
    headers: { Authorization: "Bearer attacker", "x-goog-api-key": "attacker" },
    address: "10.0.0.1",
    path: "/admin",
    handle: "c-forged",
  })
  const result = await instance.execute("w1", hostile)
  assert.equal(result.ok, true)
  const [call] = transport.calls
  assert.equal(call.url, "https://api.example.com/v1/chat/completions")
  assert.equal(call.method, "POST")
  assert.equal(call.host, PUBLIC_ADDRESS)
  assert.equal(call.headers.Authorization, "Bearer " + OPENAI_KEY)
  assert.equal(call.headers["x-goog-api-key"], undefined)
  assert.equal(String(call.body).includes("attacker"), false)

  // Invalid envelopes are refused before any network or credential work.
  for (const request of [null, "gemini", [], {}, { provider: "anthropic", operation: "chat.completions", payload: {} },
    { provider: "gemini", operation: "generateContent", model: "gemini-2.5-flash-lite" },
    { provider: "gemini", operation: "generateContent", model: "gemini-2.5-flash-lite", payload: [] },
    { provider: "openai", operation: "generateContent", endpoint: "https://api.example.com/v1", payload: {} },
    openAiRequest({ payload: { model: "m", messages: [], stream: true } })]) {
    const refused = await instance.execute("w1", request)
    assert.equal(refused.ok, false)
    assert.ok(
      [PROVIDER_CODES.REQUEST, PROVIDER_CODES.OPERATION].includes(refused.code),
      "unexpected code " + refused.code,
    )
  }
  assert.equal(transport.calls.length, 1)
})

test("endpoints that are not HTTPS or do not sit on loopback are refused", async () => {
  const { instance, store } = provider()
  for (const endpoint of [
    "http://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1?key=abc",
    "https://api.example.com/v1#frag",
    "ftp://api.example.com/v1",
    "not a url",
    "",
  ]) {
    const result = await instance.execute("w1", openAiRequest({ endpoint }))
    assert.equal(result.ok, false, endpoint + " was accepted")
    assert.equal(result.code, PROVIDER_CODES.ENDPOINT)
  }
  assert.equal(store.reads.length, 0, "an invalid endpoint reached the credential store")

  // The canonical form is what the request is built from, so no query can survive.
  assert.equal(openAiDestination("https://api.example.com/v1/").url, "https://api.example.com/v1/chat/completions")
  assert.equal(openAiDestination("http://localhost:11434/v1").url, "http://localhost:11434/v1/chat/completions")
  assert.equal(openAiDestination("http://[::1]:8080/v1").url, "http://[::1]:8080/v1/chat/completions")
})

test("keyless local inference keeps working at the configured loopback address", async () => {
  for (const [endpoint, host, port, address] of [
    ["http://localhost:11434/v1", "localhost:11434", 11434, "127.0.0.1"],
    ["http://127.0.0.1:1234/v1", "127.0.0.1:1234", 1234, "127.0.0.1"],
    ["http://[::1]:8080/v1", "[::1]:8080", 8080, "::1"],
  ]) {
    // A resolver that would fail must never be consulted for a loopback literal.
    const lookup = async () => { throw new Error("the resolver must not run for loopback") }
    const { instance, transport } = provider({ lookup })
    const result = await instance.execute("w1", openAiRequest({ endpoint }))
    assert.equal(result.ok, true, endpoint + " failed")
    const [call] = transport.calls
    assert.equal(call.url, endpoint + "/chat/completions")
    assert.equal(call.host, address)
    assert.equal(call.port, port)
    assert.equal(call.headers.Host, host)
    assert.equal("Authorization" in call.headers, false, "a keyless local call carried an Authorization header")
  }
  assert.equal(loopbackAddress("localhost"), "127.0.0.1")
  assert.equal(loopbackAddress("LOCALHOST"), "127.0.0.1")
  assert.equal(loopbackAddress("[::1]"), "::1")
  assert.equal(loopbackAddress("api.example.com"), null)
  assert.equal(loopbackAddress("127.0.0.2"), null)

  // Compatibility decision: an OpenAI-compatible endpoint with no stored key is still called, and the
  // call carries no Authorization header, which is exactly what the renderer did while its key field
  // was empty. The destination stays user-configured, HTTPS-only and pinned by this module, so the
  // call reaches nobody but the endpoint the user named and leaks no credential. Gemini keeps its key
  // requirement because the key is the caller identity there.
  const { instance, transport } = provider()
  const keyless = await instance.execute("w1", openAiRequest())
  assert.equal(keyless.ok, true)
  assert.equal("Authorization" in transport.calls[0].headers, false)
  const gemini = await instance.execute("w1", geminiRequest())
  assert.equal(gemini.code, PROVIDER_CODES.CREDENTIAL)
  assert.equal(transport.calls.length, 1, "a keyless Gemini request reached the network")
})

test("redirects are never followed and never retried", async () => {
  const { instance, transport } = provider({
    keys: { [openAiHandle]: OPENAI_KEY, [geminiHandle]: GEMINI_KEY },
    handler: () => ({
      status: 302,
      headers: { location: "https://127.0.0.1/latest/meta-data", "content-type": "text/plain" },
      chunks: ["moved"],
    }),
  })
  const result = await instance.execute("w1", openAiRequest())
  assert.equal(result.ok, false)
  assert.equal(result.code, PROVIDER_CODES.REDIRECT)
  assert.equal(result.status, 302)
  assert.equal(transport.calls.length, 1, "a redirect was followed")
  assert.equal(transport.calls[0].url, "https://api.example.com/v1/chat/completions")
  assert.equal(JSON.stringify(result).includes("127.0.0.1"), false, "the Location header reached the renderer")

  const streamed = await instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(streamed.ok, false)
  assert.equal(streamed.code, PROVIDER_CODES.REDIRECT)
})

test("public host resolution is pinned and a private answer is refused before any request", async () => {
  const blocked = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    // One internal record is enough: the whole name is refused.
    lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }, { address: "169.254.169.254", family: 4 }],
  })
  const denied = await blocked.instance.execute("w1", openAiRequest())
  assert.equal(denied.code, PROVIDER_CODES.POLICY)
  assert.equal(blocked.transport.calls.length, 0, "a request was sent to a name that resolves internally")

  const allowed = provider({ keys: { [openAiHandle]: OPENAI_KEY } })
  const result = await allowed.instance.execute("w1", openAiRequest())
  assert.equal(result.ok, true)
  // The socket goes to the resolved address while TLS and Host stay on the real name.
  assert.equal(allowed.transport.calls[0].host, PUBLIC_ADDRESS)
  assert.equal(allowed.transport.calls[0].headers.Host, "api.example.com")
  assert.equal(allowed.transport.calls[0].servername, "api.example.com")
  assert.equal(allowed.transport.calls[0].agent, false)
})

test("status, retry metadata and sizes are controlled and bounded", async () => {
  const throttled = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    handler: () => ({
      status: 429,
      headers: { "retry-after": "2", "x-echo": OPENAI_KEY, "set-cookie": "session=" + OPENAI_KEY },
      chunks: ["slow down"],
    }),
  })
  const limited = await throttled.instance.execute("w1", openAiRequest())
  assert.deepEqual(limited, {
    ok: false,
    code: PROVIDER_CODES.STATUS,
    message: PROVIDER_MESSAGES[PROVIDER_CODES.STATUS],
    status: 429,
    retryAfterMs: 2000,
  })
  // Nothing but the reviewed fields travels, so a reflected header cannot reach the renderer.
  assert.equal(JSON.stringify(limited).includes("x-echo"), false)
  assertNoSecret(limited, OPENAI_KEY, "status envelope")

  assert.equal(parseRetryAfterMs("2"), 2000)
  assert.equal(parseRetryAfterMs("999"), 15000)
  assert.equal(parseRetryAfterMs("soon"), null)
  assert.equal(parseRetryAfterMs(undefined), null)

  const huge = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    handler: () => ({ status: 200, headers: {}, chunks: [Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x41)] }),
  })
  assert.equal((await huge.instance.execute("w1", openAiRequest())).code, PROVIDER_CODES.LIMIT)

  const abandoned = provider({ keys: { [openAiHandle]: OPENAI_KEY } })
  const oversized = "x".repeat(21 * 1024 * 1024)
  const refused = await abandoned.instance.execute("w1", openAiRequest({ payload: { model: "m", text: oversized } }))
  assert.equal(refused.code, PROVIDER_CODES.REQUEST)
  assert.equal(abandoned.transport.calls.length, 0, "an oversized body reached the network")

  assert.equal(describeContentType("application/json; charset=utf-8"), "json")
  assert.equal(describeContentType("text/event-stream"), "sse")
  assert.equal(describeContentType(undefined), "text")
})

test("streaming preserves SSE frames, ordering and multi-byte text", async () => {
  const frames = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Xin ',
    'chào"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"bạn"}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]
  const { instance, transport, sink } = provider({
    keys: { [geminiHandle]: GEMINI_KEY },
    handler: () => ({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, chunks: frames }),
  })
  const started = await instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(started.ok, true)
  assert.equal(typeof started.ticket, "string")
  assert.deepEqual(await instance.activate("w1", started.ticket), { ok: true, active: true })
  assert.equal(started.contentType, "sse")
  assert.match(transport.calls[0].headers.Accept, /text\/event-stream/)

  const terminal = await sink.settled()
  assert.equal(terminal.type, "end")
  assert.equal(terminal.ticket, started.ticket)
  // Frames arrive in order and reassemble to the exact byte stream the provider sent.
  assert.equal(sink.chunks().join(""), frames.join(""))
  assert.equal(sink.events.every((event) => event.ticket === started.ticket), true)
  assert.equal(sink.events.every((event) => event.senderKey === "w1"), true)
  assertNoSecret(sink.events, GEMINI_KEY, "stream frames")

  // A multi-byte character split across two chunks is not mangled.
  const split = Buffer.from('data: {"t":"chào"}\n\n', "utf8")
  const cut = split.indexOf(Buffer.from("à", "utf8")) + 1
  const splitProvider = provider({
    keys: { [geminiHandle]: GEMINI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: [split.subarray(0, cut), split.subarray(cut)],
    }),
  })
  const splitStarted = await splitProvider.instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(splitStarted.ok, true)
  await splitProvider.instance.activate("w1", splitStarted.ticket)
  await splitProvider.sink.settled()
  assert.equal(splitProvider.sink.chunks().join(""), split.toString("utf8"))
})

test("a reflected key is redacted, including across chunk boundaries", async () => {
  const echoed = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({ error: "bad key " + OPENAI_KEY + " for this call" })],
    }),
  })
  const buffered = await echoed.instance.execute("w1", openAiRequest())
  assert.equal(buffered.ok, true)
  assert.equal(buffered.body.includes(OPENAI_KEY), false)
  assert.equal(buffered.body.includes("[redacted]"), true)
  assertNoSecret(buffered, OPENAI_KEY, "response body")

  // The key is split so that no single frame contains all of it.
  const head = OPENAI_KEY.slice(0, 6)
  const tail = OPENAI_KEY.slice(6)
  const streaming = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: ["data: {\"echo\":\"" + head, tail + "\"}\n\n", "data: [DONE]\n\n"],
    }),
  })
  const started = await streaming.instance.stream(
    "w1",
    openAiRequest({ payload: { model: "m", messages: [], stream: true } }),
  )
  assert.equal(started.ok, true)
  await streaming.instance.activate("w1", started.ticket)
  const terminal = await streaming.sink.settled()
  assert.equal(terminal.type, "end")
  const joined = streaming.sink.chunks().join("")
  assert.equal(joined.includes(OPENAI_KEY), false, "a key split across frames was emitted whole")
  assert.equal(joined.includes("[redacted]"), true)
  for (const chunk of streaming.sink.chunks()) assertNoSecret(chunk, OPENAI_KEY, "stream chunk")
  assertNoSecret(streaming.sink.events, OPENAI_KEY, "stream events")

  // A partial key is held back too, so no usable prefix ever leaves main.
  const redactor = new SecretRedactor(OPENAI_KEY)
  const first = redactor.push("prefix " + OPENAI_KEY.slice(0, 10))
  assert.equal(first.includes(OPENAI_KEY.slice(0, 10)), false)
  const second = redactor.push(OPENAI_KEY.slice(10) + " suffix")
  const whole = first + second + redactor.flush()
  assert.equal(whole.includes(OPENAI_KEY), false)
  assert.equal(whole, "prefix [redacted] suffix")
  assert.equal(new SecretRedactor(null).push("nothing to hide"), "nothing to hide")

  // Regression for #138: any key longer than the fixed prefix window used to put the redactor in a
  // hold-everything mode, so the first frame never reached the renderer and the whole stream arrived
  // at flush. A long key is still redacted across frames, and unrelated text passes straight through.
  const longKey = "AIza" + "A".repeat(400) + "TAIL"
  const longRedactor = new SecretRedactor(longKey)
  assert.equal(longRedactor.push("hello"), "hello", "a long key must not hold every frame back")
  const longHead = longRedactor.push("x" + longKey.slice(0, 200))
  assert.equal(longHead, "x", "the partial key is held, the text before it is not")
  const longTail = longRedactor.push(longKey.slice(200) + " done")
  assert.equal(longHead + longTail + longRedactor.flush(), "x[redacted] done")
})

test("cancellation only reaches the exchange its own sender opened", async () => {
  const { instance, sink } = provider({
    keys: { [geminiHandle]: GEMINI_KEY },
    transport: fakeTransport(),
  })
  const gated = new ProviderTransport({
    credentials: fakeStore({ [geminiHandle]: GEMINI_KEY }),
    emit: sink.emit,
    lookup: publicLookup,
    request: async (options) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      response: stalled(options.signal),
    }),
  })
  const started = await gated.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(started.ok, true)
  assert.equal(gated.entries.size, 1)
  // The acknowledgement is what lets a live exchange push frames; every cancel assertion below is
  // about a stream the renderer is actually listening to.
  assert.deepEqual(gated.activate("w1", started.ticket), { ok: true, active: true })

  // Another document cannot stop it.
  assert.deepEqual(gated.cancel("w2", started.ticket), { ok: true, cancelled: false })
  assert.equal(gated.entries.size, 1)
  // An unknown or malformed ticket is harmless.
  assert.deepEqual(gated.cancel("w1", "nope"), { ok: true, cancelled: false })
  assert.deepEqual(gated.cancel("w1", 42), { ok: true, cancelled: false })

  assert.deepEqual(gated.cancel("w1", started.ticket), { ok: true, cancelled: true })
  const terminal = await sink.settled()
  assert.equal(terminal.type, "error")
  assert.equal(terminal.code, PROVIDER_CODES.CANCELLED)
  assert.equal(gated.entries.size, 0)

  // A whole-sender teardown aborts everything that sender owns, and nothing else.
  const one = await gated.stream("w7", geminiRequest({ operation: "streamGenerateContent" }))
  const two = await gated.stream("w8", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(gated.cancelSender("w7"), 1)
  assert.equal(gated.entries.has(two.ticket), true)
  assert.equal(gated.cancelAll(), 1)
  assert.equal(gated.entries.size, 0)
  assert.equal(one.ok && two.ok, true)
  assert.equal(instance.entries.size, 0)
})

test("a cancelled buffered request reports cancellation instead of a network error", async () => {
  const { sink } = provider()
  const instance = new ProviderTransport({
    credentials: fakeStore({ [openAiHandle]: OPENAI_KEY }),
    emit: sink.emit,
    lookup: publicLookup,
    // Headers arrive, then the body never does, so the request is in flight when it is cancelled.
    request: async (options) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      response: stalled(options.signal),
    }),
  })
  const inFlight = instance.execute("w1", openAiRequest())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(instance.entries.size, 1)
  assert.equal(instance.cancelAll(), 1)
  const result = await inFlight
  assert.equal(result.ok, false)
  assert.equal(result.code, PROVIDER_CODES.CANCELLED)
  assert.equal(instance.entries.size, 0)
})

test("provider errors stay fixed strings and never carry a cause", async () => {
  const failing = {
    async read() {
      const error = new Error("native keychain said: " + OPENAI_KEY)
      error.code = "ERR_CREDENTIAL_DECRYPT"
      throw error
    },
  }
  const instance = new ProviderTransport({
    credentials: failing,
    emit: eventSink().emit,
    lookup: publicLookup,
    request: fakeTransport().request,
  })
  const result = await instance.execute("w1", openAiRequest())
  assert.deepEqual(result, {
    ok: false,
    code: PROVIDER_CODES.CREDENTIAL,
    message: PROVIDER_MESSAGES[PROVIDER_CODES.CREDENTIAL],
  })
  assertNoSecret(result, OPENAI_KEY, "credential failure")

  assert.equal(sanitizeProviderError(providerError(PROVIDER_CODES.TIMEOUT)), PROVIDER_MESSAGES[PROVIDER_CODES.TIMEOUT])
  // An unrecognized throw becomes one reviewed message rather than its own text.
  assert.equal(sanitizeProviderError(new Error("socket ECONNRESET " + OPENAI_KEY)), PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK])
  assert.deepEqual(failureOf(new Error("raw " + OPENAI_KEY)), {
    ok: false,
    code: PROVIDER_CODES.NETWORK,
    message: PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK],
  })

  const untrusted = providerChannel(() => false, async () => "reached")
  assert.deepEqual(await untrusted({ sender: { id: 3 } }), { error: PROVIDER_MESSAGES[PROVIDER_CODES.UNTRUSTED] })
  const throwing = providerChannel(() => { throw new Error("no frame") }, async () => "reached")
  assert.deepEqual(await throwing({}), { error: PROVIDER_MESSAGES[PROVIDER_CODES.UNTRUSTED] })
  assert.deepEqual(await providerChannel(() => true, async () => "reached")({ sender: {} }), {
    error: PROVIDER_MESSAGES[PROVIDER_CODES.UNTRUSTED],
  })
})

test("the channel derives sender ownership from the validated frame only", async () => {
  const seen = []
  const channel = providerChannel(
    () => true,
    async (senderKey, request) => {
      seen.push([senderKey, request])
      return { ok: true, ticket: "t1" }
    },
    sanitizeProviderError,
  )
  // A renderer-supplied sender key in the argument list is ignored; only the frame decides.
  const reply = await channel({ sender: { id: 42 } }, { senderKey: "w999", ticket: "forged" })
  assert.deepEqual(reply, { value: { ok: true, ticket: "t1" } })
  assert.deepEqual(seen, [["w42", { senderKey: "w999", ticket: "forged" }]])
  assert.equal(senderKeyOf({ sender: { id: 0 } }), null)
  assert.equal(senderKeyOf({ sender: { id: -1 } }), null)
  assert.equal(senderKeyOf({}), null)

  // A throwing action is reported as a reviewed message, never as its own text.
  const failing = providerChannel(() => true, async () => { throw new Error("boom " + OPENAI_KEY) }, sanitizeProviderError)
  assert.deepEqual(await failing({ sender: { id: 1 } }), { error: PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK] })

  // Channels are distinct and namespaced, so a renderer cannot reach a credential channel by proxy.
  assert.equal(PROVIDER_CHANNELS.request, "khung-thoai:provider-request")
  assert.equal(PROVIDER_CHANNELS.stream, "khung-thoai:provider-stream")
  assert.equal(PROVIDER_CHANNELS.activate, "khung-thoai:provider-activate")
  assert.equal(PROVIDER_CHANNELS.cancel, "khung-thoai:provider-cancel")
  assert.equal(PROVIDER_CHANNELS.event, "khung-thoai:provider-event")
  assert.equal(new Set(Object.values(PROVIDER_CHANNELS)).size, 5)
})

test("headers are built in main and a keyless destination carries none", () => {
  const gemini = geminiDestination("gemini-2.5-flash-lite", "generateContent")
  assert.deepEqual(buildHeaders(gemini, GEMINI_KEY, false), {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Accept-Encoding": "identity",
    "User-Agent": "Nixio/1.0 (Manga Editor Provider Transport)",
    "x-goog-api-key": GEMINI_KEY,
  })
  const openai = openAiDestination("https://api.example.com/v1")
  const headers = buildHeaders(openai, OPENAI_KEY, false)
  assert.equal(headers.Authorization, "Bearer " + OPENAI_KEY)
  assert.equal("x-goog-api-key" in headers, false)
  assert.equal(headers["Accept-Encoding"], "identity")
  const keyless = buildHeaders(openAiDestination("http://127.0.0.1:11434/v1"), null, true)
  assert.equal("Authorization" in keyless, false)
  assert.equal("x-goog-api-key" in keyless, false)
  assert.match(keyless.Accept, /text\/event-stream/)
})

// A request seam that never answers headers: it only settles when its own signal aborts, which is what
// a connection stuck before the status line looks like to main.
function pendingHeaders() {
  return (options) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    if (options.signal.aborted) abort()
    else options.signal.addEventListener("abort", abort, { once: true })
  })
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("an exchange is registered before its first await, so a pre-header cancel stops pending work", async () => {
  const transport = fakeTransport()
  const instance = new ProviderTransport({
    credentials: fakeStore({ [geminiHandle]: GEMINI_KEY }),
    emit: eventSink().emit,
    // The resolver never answers: without an early registration this exchange would own nothing a
    // cancel could reach until a header block existed.
    lookup: () => new Promise(() => {}),
    request: transport.request,
  })
  const inFlight = instance.stream("w1", geminiRequest({ operation: "streamGenerateContent", requestId: "q-dns-pending" }))
  assert.equal(instance.entries.size, 1, "the entry did not exist before the resolver was awaited")
  assert.equal(instance.requests.size, 1, "the request token was not registered")
  assert.deepEqual(instance.cancel("w1", { requestId: "q-dns-pending" }), { ok: true, cancelled: true })
  const result = await inFlight
  assert.equal(result.ok, false)
  assert.equal(result.code, PROVIDER_CODES.CANCELLED)
  assert.equal(transport.calls.length, 0, "a cancelled exchange still dispatched a request")
  assert.equal(instance.entries.size, 0)
  assert.equal(instance.requests.size, 0)
})

test("a DNS answer that arrives after cancellation never dispatches a socket", async () => {
  let release
  const transport = fakeTransport()
  const instance = new ProviderTransport({
    credentials: fakeStore({ [openAiHandle]: OPENAI_KEY }),
    emit: eventSink().emit,
    lookup: () => new Promise((resolve) => { release = resolve }),
    request: transport.request,
  })
  const inFlight = instance.execute("w1", openAiRequest({ requestId: "q-late-dns" }))
  await settle()
  assert.equal(instance.cancel("w1", { requestId: "q-late-dns" }).cancelled, true)
  // The resolver answers only after the cancel, and the late answer is discarded rather than used.
  release([{ address: PUBLIC_ADDRESS, family: 4 }])
  const result = await inFlight
  assert.equal(result.code, PROVIDER_CODES.CANCELLED)
  await settle()
  assert.equal(transport.calls.length, 0, "a late DNS answer turned into a dispatch after cancellation")
})

test("a request stuck before headers is cancelled through its own token", async () => {
  const instance = new ProviderTransport({
    credentials: fakeStore({ [geminiHandle]: GEMINI_KEY }),
    emit: eventSink().emit,
    lookup: publicLookup,
    request: pendingHeaders(),
  })
  const inFlight = instance.stream("w1", geminiRequest({ operation: "streamGenerateContent", requestId: "q-header-wait" }))
  await settle()
  assert.equal(instance.entries.size, 1)
  assert.deepEqual(instance.cancel("w1", { requestId: "q-header-wait" }), { ok: true, cancelled: true })
  const result = await inFlight
  assert.equal(result.ok, false)
  assert.equal(result.code, PROVIDER_CODES.CANCELLED)
  assert.equal(instance.entries.size, 0)
})

test("a request token is validated, and only its own sender can cancel it", async () => {
  const { instance } = provider({ keys: { [openAiHandle]: OPENAI_KEY } })
  for (const requestId of ["short", "has space", "x".repeat(97), 42, {}, "../evil", "line\nbreak"]) {
    const refused = await instance.execute("w1", openAiRequest({ requestId }))
    assert.equal(refused.ok, false, String(requestId) + " was accepted as a token")
    assert.equal(refused.code, PROVIDER_CODES.REQUEST)
  }
  assert.equal(instance.entries.size, 0, "an invalid token registered an exchange")
  assert.equal(instance.requests.size, 0)

  const gated = new ProviderTransport({
    credentials: fakeStore({ [openAiHandle]: OPENAI_KEY }),
    emit: eventSink().emit,
    lookup: publicLookup,
    request: pendingHeaders(),
  })
  const inFlight = gated.execute("w1", openAiRequest({ requestId: "q-same-token" }))
  await settle()
  // The same token from another document resolves to nothing, because the table is keyed by sender.
  assert.deepEqual(gated.cancel("w2", { requestId: "q-same-token" }), { ok: true, cancelled: false })
  assert.deepEqual(gated.cancel("w2", "q-same-token"), { ok: true, cancelled: false })
  assert.equal(gated.entries.size, 1)
  assert.deepEqual(gated.cancel("w1", { requestId: "q-same-token" }), { ok: true, cancelled: true })
  assert.equal((await inFlight).code, PROVIDER_CODES.CANCELLED)
})

test("stream frames wait for the sender's acknowledgement and then arrive in order", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const response = Readable.from((async function* () {
    for (const chunk of ["data: a\n\n", "data: b\n\n"]) {
      await gate
      yield Buffer.from(chunk)
    }
  })())
  response.on("error", () => {})
  const sink = eventSink()
  const instance = new ProviderTransport({
    credentials: fakeStore({ [geminiHandle]: GEMINI_KEY }),
    emit: sink.emit,
    lookup: publicLookup,
    request: async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, response }),
  })
  const started = await instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(started.ok, true)
  await settle()
  // No push may precede the acknowledgement, so the reply that carries the ticket cannot race a frame.
  assert.deepEqual(sink.events, [])
  // Another document cannot acknowledge, or steal, this ticket.
  assert.deepEqual(instance.activate("w2", started.ticket), { ok: true, active: false })
  assert.deepEqual(sink.events, [])
  assert.deepEqual(instance.activate("w1", started.ticket), { ok: true, active: true })
  release()
  const terminal = await sink.settled()
  assert.equal(terminal.type, "end")
  assert.equal(terminal.ticket, started.ticket)
  assert.deepEqual(sink.chunks(), ["data: a\n\n", "data: b\n\n"])
  // A second acknowledgement is harmless and cannot replay the frames.
  assert.deepEqual(instance.activate("w1", started.ticket), { ok: true, active: false })
  assert.deepEqual(sink.chunks(), ["data: a\n\n", "data: b\n\n"])
})

test("a stream that ends before its acknowledgement replays every buffered frame", async () => {
  const { instance, sink } = provider({
    keys: { [geminiHandle]: GEMINI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: ["data: a\n\n", "data: b\n\n"],
    }),
  })
  const started = await instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(started.ok, true)
  for (let attempt = 0; attempt < 50 && instance.entries.size > 0; attempt++) await settle()
  assert.equal(instance.entries.size, 0)
  assert.deepEqual(sink.events, [], "a completed stream pushed a frame before its acknowledgement")
  assert.deepEqual(instance.activate("w1", started.ticket), { ok: true, active: false, finished: true })
  assert.deepEqual(sink.chunks(), ["data: a\n\n", "data: b\n\n"])
  assert.equal(sink.events.at(-1).type, "end")
  assert.equal(sink.events.at(-1).ticket, started.ticket)
})

test("an unacknowledged stream is bounded and ends with a limit error", async () => {
  const sink = eventSink()
  const instance = new ProviderTransport({
    credentials: fakeStore({ [geminiHandle]: GEMINI_KEY }),
    emit: sink.emit,
    lookup: publicLookup,
    request: fakeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: Array.from({ length: 40 }, (_, index) => "data: " + index + "\n\n"),
    })).request,
    earlyFrames: 4,
  })
  const started = await instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(started.ok, true)
  for (let attempt = 0; attempt < 50 && instance.entries.size > 0; attempt++) await settle()
  assert.equal(instance.entries.size, 0, "the unacknowledged exchange was never closed")
  assert.deepEqual(sink.events, [], "an unacknowledged stream pushed a frame")
  // The one terminal frame is still available to a renderer that acknowledges late.
  assert.deepEqual(instance.activate("w1", started.ticket), { ok: true, active: false, finished: true })
  const terminal = await sink.settled()
  assert.equal(terminal.type, "error")
  assert.equal(terminal.code, PROVIDER_CODES.LIMIT)
})

test("an exchange that never answers is ended by its own lifetime", async () => {
  const instance = new ProviderTransport({
    credentials: fakeStore({ [geminiHandle]: GEMINI_KEY }),
    emit: eventSink().emit,
    lookup: () => new Promise(() => {}),
    request: fakeTransport().request,
    lifetimeMs: 20,
    streamLifetimeMs: 20,
  })
  const buffered = await instance.execute("w1", openAiRequest())
  assert.equal(buffered.code, PROVIDER_CODES.TIMEOUT)
  const streamed = await instance.stream("w1", geminiRequest({ operation: "streamGenerateContent" }))
  assert.equal(streamed.code, PROVIDER_CODES.TIMEOUT)
  assert.equal(instance.entries.size, 0)
})

test("a caller deadline is bounded and replaces the transport default", async () => {
  const healthy = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    handler: () => ({ status: 200, headers: { "content-type": "application/json" }, chunks: [JSON.stringify({ ok: true })] }),
  })
  // Out-of-range deadlines are refused before an entry exists, never silently replaced.
  for (const timeoutMs of [0, 999, 600001, 1.5, "1000", true]) {
    const refused = await healthy.instance.execute("w1", openAiRequest({ timeoutMs }))
    assert.equal(refused.code, PROVIDER_CODES.REQUEST, "accepted timeoutMs " + String(timeoutMs))
  }
  assert.equal(healthy.instance.entries.size, 0)
  const accepted = await healthy.instance.execute("w1", openAiRequest({ timeoutMs: 1000 }))
  assert.equal(accepted.ok, true)

  // A caller deadline wins over the much shorter transport default: the hanging lookup below would be
  // killed at 20 ms if the default were still in force.
  const hanging = new ProviderTransport({
    credentials: fakeStore({ [openAiHandle]: OPENAI_KEY }),
    emit: eventSink().emit,
    lookup: () => new Promise(() => {}),
    request: fakeTransport().request,
    lifetimeMs: 20,
  })
  const pending = hanging.execute("w1", openAiRequest({ timeoutMs: 5000, requestId: "req-timeout-1" }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(hanging.entries.size, 1, "the transport default outlived the caller deadline")
  hanging.cancel("w1", { requestId: "req-timeout-1" })
  const cancelled = await pending
  assert.equal(cancelled.code, PROVIDER_CODES.CANCELLED)
})

test("an encoded reflection of the key is redacted too", async () => {
  const encoded = Buffer.from(OPENAI_KEY, "utf8").toString("base64")
  const { instance } = provider({
    keys: { [openAiHandle]: OPENAI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "application/json", "x-echo": OPENAI_KEY },
      chunks: [JSON.stringify({ encoded, literal: OPENAI_KEY })],
    }),
  })
  const result = await instance.execute("w1", openAiRequest())
  assert.equal(result.ok, true)
  // The literal secret is removed wherever it appears.
  assert.equal(result.body.includes(OPENAI_KEY), false)
  assert.equal(result.body.includes("[redacted]"), true)
  // A gateway that echoes the Authorization value as base64 is the common case, so those forms are
  // scanned with the same hold-back window as the literal key.
  assert.equal(result.body.includes(encoded), false, "a base64 reflection reached the renderer")
  const bearer = Buffer.from("Bearer " + OPENAI_KEY, "utf8").toString("base64")
  assert.equal(result.body.includes(bearer), false, "an encoded Authorization header reached the renderer")
  assert.equal(JSON.stringify(result).includes("x-echo"), false, "a response header reached the renderer")
})
