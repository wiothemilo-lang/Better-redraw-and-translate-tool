import assert from "node:assert/strict"
import test from "node:test"
import { canonicalCredentialScope } from "../desktop/credential-ipc.cjs"
import { PROVIDER_CODES } from "../desktop/provider-transport.cjs"
import { isRetryableError, isRetryableStatus, parseRetryAfterMs } from "../src/llm-retry.js"
import {
  PROVIDER_BRIDGE_CODES,
  callProvider,
  providerCredentialsInMain,
  validateEndpointUrl,
} from "../src/provider-bridge.js"

const GEMINI_KEY = "AIza-fake-gemini-6b1d4c8e"
const OPENAI_KEY = "sk-fake-openai-9f3a2c7d"

// A synthetic bridge: exactly the surface desktop/preload.cjs exposes, with every invocation recorded.
function fakeBridge({ request, stream } = {}) {
  const invocations = []
  const activations = []
  const cancels = []
  const listeners = new Set()
  let unsubscribes = 0
  const api = {
    providerRequest: async (envelope) => {
      invocations.push({ channel: "request", envelope })
      return request ? request(envelope) : { ok: true, status: 200, contentType: "json", body: '{"ok":true}' }
    },
    providerStream: async (envelope) => {
      invocations.push({ channel: "stream", envelope })
      return stream ? stream(envelope) : { ok: true, ticket: "s-ticket-1", status: 200, contentType: "sse" }
    },
    providerActivate: async (ticket) => {
      activations.push(ticket)
      return { ok: true, active: true }
    },
    providerCancel: async (target) => {
      cancels.push(target)
      return { ok: true, cancelled: true }
    },
    onProviderEvent: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
        unsubscribes += 1
      }
    },
    emit(payload) {
      for (const listener of [...listeners]) listener(payload)
    },
  }
  return {
    api,
    invocations,
    activations,
    cancels,
    listeners,
    get unsubscribes() { return unsubscribes },
  }
}

function installBridge(t, bridge) {
  const original = globalThis.khungThoaiDesktop
  globalThis.khungThoaiDesktop = bridge?.api
  t.after(() => {
    if (original === undefined) delete globalThis.khungThoaiDesktop
    else globalThis.khungThoaiDesktop = original
  })
  return bridge
}

function installFetch(t, handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => { globalThis.fetch = original })
}

const geminiSpec = (overrides = {}) => ({
  provider: "gemini",
  model: "gemini-2.5-flash-lite",
  payload: { contents: [{ parts: [{ text: "xin chào" }] }] },
  key: GEMINI_KEY,
  ...overrides,
})

const openAiSpec = (overrides = {}) => ({
  provider: "openai",
  endpoint: "https://api.example.com/v1",
  payload: { model: "qwen2.5:7b", messages: [{ role: "user", content: "hi" }] },
  key: OPENAI_KEY,
  ...overrides,
})

const never = () => new Promise(() => {})
const settle = () => new Promise((resolve) => setImmediate(resolve))

test("without a bridge the browser request is byte-for-byte the one the editor always sent", async (t) => {
  installBridge(t, null)
  const calls = []
  installFetch(t, async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ lines: [] }) }
  })
  assert.equal(providerCredentialsInMain(), false)

  await callProvider(geminiSpec())
  await callProvider(geminiSpec({ stream: true }))
  await callProvider(openAiSpec())
  await callProvider(openAiSpec({ key: "" }))

  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent")
  assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse")
  for (const call of calls) {
    assert.equal(call.init.method, "POST")
    assert.equal(call.init.credentials, "omit")
    assert.equal(call.init.redirect, "error")
    assert.ok(call.init.signal instanceof AbortSignal)
    assert.equal(typeof call.init.body, "string")
  }
  assert.equal(calls[0].init.headers["x-goog-api-key"], GEMINI_KEY)
  assert.equal(JSON.parse(calls[0].init.body).contents[0].parts[0].text, "xin chào")

  assert.equal(calls[2].url, "https://api.example.com/v1/chat/completions")
  assert.equal(calls[2].init.headers.Authorization, "Bearer " + OPENAI_KEY)
  // A keyless OpenAI-compatible call keeps working exactly as before: no header, same URL.
  assert.equal(calls[3].url, "https://api.example.com/v1/chat/completions")
  assert.equal("Authorization" in calls[3].init.headers, false)
  assert.equal(validateEndpointUrl("https://api.example.com/v1/"), "https://api.example.com/v1")
})

// Regression for #137: the renderer used to accept a URL the desktop credential scope always refused,
// so a query string, userinfo or fragment reached the browser path and was rejected only at save time.
test("the endpoint validator mirrors the credential scope canonicalizer exactly", () => {
  const accepted = [
    "https://api.example.com/v1",
    "https://api.example.com/v1/",
    "HTTPS://API.Example.com:443/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/",
    "http://[::1]:8000/v1",
  ]
  for (const url of accepted) {
    assert.equal(validateEndpointUrl(url), canonicalCredentialScope("openai", url).slice("openai:".length), url)
  }
  const refused = [
    "https://example.com/v1?key=secret",
    "https://user:pass@example.com/v1",
    "https://example.com/v1#frag",
    "http://example.com/v1",
    "ftp://example.com/v1",
    "https://example.com/" + "a".repeat(2048),
    "",
  ]
  for (const url of refused) {
    assert.throws(() => validateEndpointUrl(url), url)
    assert.throws(() => canonicalCredentialScope("openai", url), url)
  }
})

test("the desktop envelope names the provider and never carries the key", async (t) => {
  const bridge = installBridge(t, fakeBridge())
  assert.equal(providerCredentialsInMain(), true)
  const response = await callProvider(geminiSpec())
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(response.ok, true)
  assert.equal(response.headers.get("content-type"), "application/json")

  const [invocation] = bridge.invocations
  assert.equal(invocation.channel, "request")
  assert.equal(invocation.envelope.provider, "gemini")
  assert.equal(invocation.envelope.operation, "generateContent")
  assert.equal(invocation.envelope.model, "gemini-2.5-flash-lite")
  assert.match(invocation.envelope.requestId, /^[A-Za-z0-9_-]{8,96}$/)
  // The settings key is renderer-only: it must not appear anywhere in what crosses the bridge.
  assert.equal(JSON.stringify(invocation.envelope).includes(GEMINI_KEY), false)
  assert.equal("key" in invocation.envelope, false)
  assert.equal("apiKey" in invocation.envelope, false)

  await callProvider(openAiSpec())
  const openai = bridge.invocations[1].envelope
  assert.equal(openai.provider, "openai")
  assert.equal(openai.operation, "chat.completions")
  assert.equal(openai.endpoint, "https://api.example.com/v1")
  assert.equal(JSON.stringify(openai).includes(OPENAI_KEY), false)
  assert.notEqual(openai.requestId, invocation.envelope.requestId, "two exchanges shared a request token")
})

test("a provider status becomes a Response with retry metadata instead of an arbitrary error", async (t) => {
  installBridge(t, fakeBridge({
    request: async () => ({
      ok: false,
      code: PROVIDER_BRIDGE_CODES.STATUS,
      message: "The provider returned an error status.",
      status: 429,
      retryAfterMs: 2000,
    }),
  }))
  const response = await callProvider(openAiSpec())
  assert.equal(response.ok, false)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "2")
  // What src/llm-retry.js reads from a response is unchanged by the bridge.
  assert.equal(parseRetryAfterMs(response.headers.get("retry-after")), 2000)
  assert.equal(isRetryableStatus(response.status), true)
})

test("transport failures keep the error classes the retry policy understands", async (t) => {
  const cases = [
    [PROVIDER_BRIDGE_CODES.NETWORK, "TypeError"],
    [PROVIDER_BRIDGE_CODES.REDIRECT, "TypeError"],
    [PROVIDER_BRIDGE_CODES.TIMEOUT, "TimeoutError"],
    [PROVIDER_BRIDGE_CODES.CANCELLED, "AbortError"],
    [PROVIDER_BRIDGE_CODES.CREDENTIAL, "Error"],
    [PROVIDER_BRIDGE_CODES.POLICY, "Error"],
    [PROVIDER_BRIDGE_CODES.LIMIT, "Error"],
  ]
  for (const [code, expected] of cases) {
    const bridge = fakeBridge({ request: async () => ({ ok: false, code, message: "fixed message" }) })
    installBridge(t, bridge)
    let thrown
    await callProvider(openAiSpec()).then(() => { throw new Error("resolved") }, (error) => { thrown = error })
    assert.equal(thrown.name, expected, code + " mapped to " + thrown.name)
    // Cancellation reports the abort itself; every other failure keeps main's reviewed message.
    if (expected !== "AbortError") assert.equal(thrown.message, "fixed message")
    // Network, redirect and timeout keep the retry behaviour the browser path had; a policy or a
    // configuration failure does not spin in a retry loop.
    const retryable = isRetryableError(thrown)
    assert.equal(retryable, [PROVIDER_BRIDGE_CODES.NETWORK, PROVIDER_BRIDGE_CODES.REDIRECT, PROVIDER_BRIDGE_CODES.TIMEOUT].includes(code), code + " retryable=" + retryable)
    // No failure may carry a status that would be mistaken for a provider response.
    assert.equal(Number.isInteger(thrown.status), false)
  }
})

test("a direct abort cancels the pending main request through its own token", async (t) => {
  const bridge = installBridge(t, fakeBridge({ request: () => never() }))
  const controller = new AbortController()
  const pending = callProvider(openAiSpec({ signal: controller.signal }))
  await settle()
  const requestId = bridge.invocations[0].envelope.requestId
  controller.abort()
  await assert.rejects(pending, (error) => error.name === "AbortError")
  assert.deepEqual(bridge.cancels, [{ requestId }])
})

test("an already aborted caller never sends a provider frame", async (t) => {
  const bridge = installBridge(t, fakeBridge())
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(callProvider(openAiSpec({ signal: controller.signal })), (error) => error.name === "AbortError")
  assert.equal(bridge.invocations.length, 0)
})

test("streaming subscribes, acknowledges the ticket and yields SSE frames in order", async (t) => {
  const bridge = installBridge(t, fakeBridge())
  const response = await callProvider(geminiSpec({ stream: true, operation: "streamGenerateContent" }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  const envelope = bridge.invocations[0].envelope
  assert.equal(envelope.operation, "streamGenerateContent")
  assert.deepEqual(bridge.activations, ["s-ticket-1"])
  assert.equal(bridge.listeners.size, 1, "the renderer was not listening before it acknowledged")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const read = (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      text += decoder.decode(value, { stream: true })
    }
  })()
  bridge.api.emit({ ticket: "s-ticket-1", type: "chunk", text: "data: a\n\n" })
  bridge.api.emit({ ticket: "s-ticket-1", type: "chunk", text: "data: b\n\n" })
  bridge.api.emit({ ticket: "s-ticket-1", type: "end" })
  await read
  assert.equal(text, "data: a\n\ndata: b\n\n")
  // The singleton listener is detached again once no stream is open.
  assert.equal(bridge.listeners.size, 0)
  assert.equal(bridge.unsubscribes, 1)
  assert.deepEqual(bridge.cancels, [])
})

test("a non-SSE answer to a streaming request keeps the buffered fallback", async (t) => {
  const bridge = installBridge(t, fakeBridge({
    stream: async () => ({ ok: true, ticket: "s-ticket-2", status: 200, contentType: "json" }),
  }))
  const response = await callProvider(openAiSpec({ stream: true, payload: { model: "m", messages: [], stream: true } }))
  assert.equal(response.headers.get("content-type"), "application/json")
  bridge.api.emit({ ticket: "s-ticket-2", type: "chunk", text: '{"choices":' })
  bridge.api.emit({ ticket: "s-ticket-2", type: "chunk", text: "[]}" })
  bridge.api.emit({ ticket: "s-ticket-2", type: "end" })
  assert.deepEqual(await response.json(), { choices: [] })
})

test("aborting a live stream cancels main work and errors the body", async (t) => {
  const bridge = installBridge(t, fakeBridge())
  const controller = new AbortController()
  const response = await callProvider(geminiSpec({ stream: true, signal: controller.signal }))
  const reader = response.body.getReader()
  const requestId = bridge.invocations[0].envelope.requestId
  controller.abort()
  await assert.rejects(reader.read(), (error) => error.name === "AbortError")
  assert.deepEqual(bridge.cancels, [{ requestId }])
  assert.equal(bridge.listeners.size, 0)
})

test("a stream error frame becomes an error on the body and never a plain string", async (t) => {
  const bridge = installBridge(t, fakeBridge())
  const response = await callProvider(geminiSpec({ stream: true }))
  const reader = response.body.getReader()
  bridge.api.emit({ ticket: "s-ticket-1", type: "error", code: PROVIDER_BRIDGE_CODES.TIMEOUT, message: "The provider did not answer in time." })
  await assert.rejects(reader.read(), (error) => error.name === "TimeoutError")
  assert.equal(bridge.listeners.size, 0)
})

test("frames for an unknown ticket and malformed payloads are ignored", async (t) => {
  const bridge = installBridge(t, fakeBridge())
  const response = await callProvider(geminiSpec({ stream: true }))
  const reader = response.body.getReader()
  bridge.api.emit(null)
  bridge.api.emit({ type: "chunk", text: "no ticket" })
  bridge.api.emit({ ticket: "s-unknown", type: "chunk", text: "wrong ticket" })
  bridge.api.emit({ ticket: "s-ticket-1", type: "chunk", text: 42 })
  bridge.api.emit({ ticket: "s-ticket-1", type: "end" })
  assert.deepEqual(await reader.read(), { value: undefined, done: true })
})

test("a bridge without an unsubscribe keeps exactly one listener", async (t) => {
  const bridge = fakeBridge()
  delete bridge.api.onProviderEvent
  bridge.api.onProviderEvent = (callback) => { bridge.listeners.add(callback) }
  installBridge(t, bridge)
  for (let index = 0; index < 3; index++) {
    const response = await callProvider(geminiSpec({ stream: true }))
    bridge.api.emit({ ticket: "s-ticket-1", type: "end" })
    assert.deepEqual(await response.text(), "")
  }
  assert.equal(bridge.listeners.size, 1, "a permanent listener was subscribed twice")
})

test("an activation failure is reported and the exchange is cancelled", async (t) => {
  const bridge = fakeBridge()
  bridge.api.providerActivate = async () => { throw new Error("frame went away") }
  installBridge(t, bridge)
  let thrown
  await callProvider(geminiSpec({ stream: true })).then(() => { throw new Error("resolved") }, (error) => { thrown = error })
  assert.equal(thrown.name, "TypeError")
  assert.equal(bridge.cancels.length, 1)
  assert.equal(bridge.listeners.size, 0)
})

test("an expired ticket rejects activation and removes its listener", async (t) => {
  const bridge = fakeBridge()
  bridge.api.providerActivate = async () => ({ ok: true, active: false })
  installBridge(t, bridge)
  await assert.rejects(callProvider(geminiSpec({ stream: true })), /could not activate/)
  assert.equal(bridge.cancels.length, 1)
  assert.equal(bridge.listeners.size, 0)
})

test("the bridge codes mirror the main-process transport codes exactly", () => {
  assert.deepEqual(Object.keys(PROVIDER_BRIDGE_CODES).sort(), Object.keys(PROVIDER_CODES).sort())
  for (const [name, code] of Object.entries(PROVIDER_CODES)) {
    assert.equal(PROVIDER_BRIDGE_CODES[name], code, name + " drifted from the main process")
  }
})
