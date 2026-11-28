// Renderer-side adapter for the two provider shapes the editor talks to.
//
// In a browser this module is a thin wrapper over `fetch`: the URL, the headers and the abort signal
// are the ones the editor always used, so the browser routes and the offline fixture evaluator keep
// their behaviour. In the desktop app the same call is forwarded to the main process, which owns the
// destination, the headers and the credential. The key from `settings` is never placed in an IPC
// frame and the renderer never falls back to `fetch` while the bridge is present.
//
// Both paths answer with a `Response`, so the provider modules keep one code path for JSON, SSE,
// retry status and cancellation. The desktop path normalizes what crosses the bridge: a status and
// content-type class instead of arbitrary headers, `retry-after` back into header form, and the
// transport's fixed error codes into the error classes `llm-retry` already understands.

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com"
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
// Mirrors the bound desktop/credential-ipc.cjs applies before it derives a credential scope.
const MAX_ENDPOINT_LENGTH = 2048
const DEFAULT_TIMEOUT_MS = 120000
// Mirrors the bounds desktop/provider-transport.cjs validates, so the renderer never sends a deadline
// main would refuse.
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 600000
const CHAT_PATH = "/chat/completions"

// Mirrors the codes in desktop/provider-transport.cjs; a test asserts the two lists stay equal.
export const PROVIDER_BRIDGE_CODES = Object.freeze({
  UNTRUSTED: "ERR_PROVIDER_UNTRUSTED",
  REQUEST: "ERR_PROVIDER_REQUEST",
  OPERATION: "ERR_PROVIDER_OPERATION",
  MODEL: "ERR_PROVIDER_MODEL",
  ENDPOINT: "ERR_PROVIDER_ENDPOINT",
  SCOPE: "ERR_PROVIDER_SCOPE",
  CREDENTIAL: "ERR_PROVIDER_CREDENTIAL",
  POLICY: "ERR_PROVIDER_POLICY",
  REDIRECT: "ERR_PROVIDER_REDIRECT",
  STATUS: "ERR_PROVIDER_STATUS",
  LIMIT: "ERR_PROVIDER_LIMIT",
  TIMEOUT: "ERR_PROVIDER_TIMEOUT",
  NETWORK: "ERR_PROVIDER_NETWORK",
  CANCELLED: "ERR_PROVIDER_CANCELLED",
})

// The canonical base URL: the same form main derives for a credential scope, so a URL this accepts is
// never refused at save time and the browser path does not append "/chat/completions" after a query.
// Userinfo, query strings and fragments are refused rather than dropped because they can hide a key
// or change the destination the user is not looking at.
export function validateEndpointUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim()
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("Base URL của LLM không hợp lệ (ví dụ: http://localhost:11434/v1).")
  }
  if (!trimmed || trimmed.length > MAX_ENDPOINT_LENGTH || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw new Error("Base URL của LLM không hợp lệ (ví dụ: http://localhost:11434/v1).")
  }
  const isHttps = parsed.protocol === "https:"
  const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  if (!isHttps && !isLoopbackHttp) {
    throw new Error("Chỉ cho phép HTTPS hoặc HTTP cục bộ (localhost / 127.0.0.1).")
  }
  return parsed.protocol + "//" + parsed.host + parsed.pathname.replace(/\/+$/, "")
}

function desktopBridge() {
  const api = globalThis.khungThoaiDesktop
  return api && typeof api.providerRequest === "function" && typeof api.providerStream === "function"
    ? api
    : null
}

// True when main owns the API keys, so a provider module may stop demanding one from the settings
// screen. False in a browser, where the key still comes from the settings object.
export function providerCredentialsInMain() {
  return desktopBridge() !== null
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

function nextRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === "string" && uuid) return "q" + uuid.replace(/-/g, "")
  let id = "q"
  for (let index = 0; index < 32; index++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  }
  return id
}

function namedError(name, message) {
  if (typeof DOMException === "function") return new DOMException(message, name)
  const error = new Error(message)
  error.name = name
  return error
}

const abortError = () => namedError("AbortError", "The provider request was cancelled.")
const defaultMessage = "The provider request failed."

function geminiUrl(model, stream) {
  return GEMINI_ORIGIN + "/v1beta/models/" + model +
    (stream ? ":streamGenerateContent?alt=sse" : ":generateContent")
}

function browserCall(spec) {
  const stream = spec.stream === true
  const timeoutMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = spec.signal ? AbortSignal.any([spec.signal, timeoutSignal]) : timeoutSignal
  let url
  let headers
  if (spec.provider === "gemini") {
    url = geminiUrl(spec.model, stream)
    headers = { "Content-Type": "application/json", "x-goog-api-key": spec.key }
  } else {
    url = validateEndpointUrl(spec.endpoint) + CHAT_PATH
    headers = { "Content-Type": "application/json" }
    const token = String(spec.key || "").trim()
    if (token) headers.Authorization = "Bearer " + token
  }
  return fetch(url, {
    method: "POST",
    headers,
    credentials: "omit",
    redirect: "error",
    signal,
    body: JSON.stringify(spec.payload),
  })
}

// The envelope is the whole of what main receives: no key, no header, no URL for the Gemini shape,
// and for the OpenAI-compatible shape only the user-configured base URL that bound the credential.
// The per-call deadline the caller asked for travels with the envelope, so main ends the exchange at
// the same point a browser fetch would. A value outside the range main accepts is clamped here instead
// of turning a working call into a validation error.
function timeoutField(spec) {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) return {}
  return { timeoutMs: Math.min(Math.max(Math.round(spec.timeoutMs), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS) }
}

function envelopeFor(spec, requestId, stream) {
  const timeout = timeoutField(spec)
  if (spec.provider === "gemini") {
    return {
      provider: "gemini",
      operation: stream ? "streamGenerateContent" : "generateContent",
      model: spec.model,
      payload: spec.payload,
      requestId,
      ...timeout,
    }
  }
  return {
    provider: "openai",
    operation: "chat.completions",
    endpoint: spec.endpoint,
    payload: spec.payload,
    requestId,
    ...timeout,
  }
}

function contentTypeHeader(contentType) {
  if (contentType === "json") return "application/json"
  if (contentType === "sse") return "text/event-stream"
  return "text/plain"
}

const bodyAllowed = (status) => status !== 204 && status !== 205 && status !== 304

function safeStatus(status, fallback) {
  return Number.isInteger(status) && status >= 200 && status <= 599 ? status : fallback
}

function bufferedResponse(result) {
  const status = safeStatus(result.status, 200)
  const headers = new Headers({ "content-type": contentTypeHeader(result.contentType) })
  const body = bodyAllowed(status) ? String(result.body ?? "") : null
  return new Response(body, { status, headers })
}

function statusResponse(failure) {
  // Only an error status may become a synthesized response; a redirect is mapped to a network error
  // and is never followed.
  const candidate = safeStatus(failure.status, 502)
  const status = candidate >= 400 ? candidate : 502
  const headers = new Headers()
  if (Number.isInteger(failure.retryAfterMs) && failure.retryAfterMs >= 0) {
    headers.set("retry-after", String(Math.max(0, Math.ceil(failure.retryAfterMs / 1000))))
  }
  return new Response(bodyAllowed(status) ? "" : null, { status, headers })
}

function failureError(failure) {
  const code = typeof failure?.code === "string" ? failure.code : PROVIDER_BRIDGE_CODES.NETWORK
  const message = typeof failure?.message === "string" && failure.message ? failure.message : defaultMessage
  if (code === PROVIDER_BRIDGE_CODES.CANCELLED) return abortError()
  if (code === PROVIDER_BRIDGE_CODES.TIMEOUT) return namedError("TimeoutError", message)
  if (code === PROVIDER_BRIDGE_CODES.NETWORK || code === PROVIDER_BRIDGE_CODES.REDIRECT ||
    code === PROVIDER_BRIDGE_CODES.UNTRUSTED) {
    // The browser path reported these as a rejected fetch, which is a TypeError, so the retry policy
    // that treats a transient network failure as retryable keeps working unchanged.
    return new TypeError(message)
  }
  // Policy, limit and configuration errors are deterministic; a plain Error keeps them out of the
  // retry loop and surfaces the reviewed message instead of a provider status.
  const error = new Error(message)
  error.code = code
  return error
}

function failureOutcome(failure) {
  if (failure?.code === PROVIDER_BRIDGE_CODES.STATUS && Number.isInteger(failure.status)) {
    return { response: statusResponse(failure) }
  }
  return { error: failureError(failure) }
}

function bulkResponse(result) {
  if (result?.ok) return bufferedResponse(result)
  const outcome = failureOutcome(result)
  if (outcome.response) return outcome.response
  throw outcome.error
}

function untilAborted(promise, signal, onAbort) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    onAbort()
    return Promise.reject(abortError())
  }
  return new Promise((resolve, reject) => {
    const detach = () => signal.removeEventListener("abort", onSignalAbort)
    function onSignalAbort() {
      detach()
      onAbort()
      reject(abortError())
    }
    signal.addEventListener("abort", onSignalAbort, { once: true })
    promise.then(
      (value) => { detach(); resolve(value) },
      (error) => { detach(); reject(error) },
    )
  })
}

// One listener for the whole document, routed by ticket. A stream is registered here before its
// ticket is acknowledged, so a frame main flushes on activation can always be routed, and the
// listener is detached again as soon as no stream is open.
let channel = null

function routeFrame(payload) {
  const ticket = payload?.ticket
  if (!channel || typeof ticket !== "string") return
  const sink = channel.tickets.get(ticket)
  if (!sink) return
  if (payload.type === "chunk") {
    if (typeof payload.text === "string") sink.push(payload.text)
    return
  }
  if (payload.type === "end") {
    channel.tickets.delete(ticket)
    sink.end()
    releaseChannel()
    return
  }
  if (payload.type === "error") {
    channel.tickets.delete(ticket)
    sink.error(failureError(payload))
    releaseChannel()
  }
}

function subscribeChannel(current) {
  if (typeof current.api.onProviderEvent !== "function") return
  const unsubscribe = current.api.onProviderEvent(routeFrame)
  if (typeof unsubscribe === "function") current.unsubscribe = unsubscribe
  // A bridge that cannot detach keeps its one listener: routing by ticket makes that harmless, while
  // subscribing again would deliver every frame twice.
  else current.permanent = true
}

function ensureChannel(api) {
  if (channel && channel.api !== api) {
    try { channel.unsubscribe?.() } catch {}
    channel = null
  }
  if (!channel) channel = { api, unsubscribe: null, permanent: false, tickets: new Map() }
  if (!channel.unsubscribe && !channel.permanent) subscribeChannel(channel)
  return channel
}

function releaseChannel() {
  if (!channel || channel.tickets.size > 0 || typeof channel.unsubscribe !== "function") return
  const unsubscribe = channel.unsubscribe
  channel.unsubscribe = null
  try { unsubscribe() } catch {}
}

// One sink per ticket: a ReadableStream that main feeds through the singleton event channel. The
// sink is registered before the ticket is acknowledged and torn down on end, error, abort or a reader
// that deliberately cancels, so the document never keeps a listener it does not need.
function openSink(api, { ticket, requestId, signal }) {
  const encoder = new TextEncoder()
  let controller = null
  let finished = false

  const detachSignal = () => { signal?.removeEventListener("abort", onAbort) }
  const cancelMain = () => {
    try { Promise.resolve(api.providerCancel({ requestId })).catch(() => {}) } catch {}
  }
  const drop = () => { channel?.tickets.delete(ticket); releaseChannel() }

  function onAbort() {
    if (finished) return
    finished = true
    cancelMain()
    try { controller?.error(abortError()) } catch {}
    detachSignal()
    drop()
  }

  const readable = new ReadableStream({
    start(next) { controller = next },
    cancel() {
      if (finished) return
      finished = true
      detachSignal()
      cancelMain()
      drop()
    },
  })

  const sink = {
    readable,
    push(chunk) {
      if (finished) return
      try { controller.enqueue(encoder.encode(chunk)) } catch { finished = true }
    },
    end() {
      if (finished) return
      finished = true
      detachSignal()
      try { controller.close() } catch {}
    },
    error(error) {
      if (finished) return
      finished = true
      detachSignal()
      try { controller.error(error) } catch {}
    },
    discard() {
      if (finished) return
      finished = true
      detachSignal()
      try { controller.close() } catch {}
      drop()
    },
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  return sink
}

async function eventResponse(api, started, requestId, signal) {
  if (typeof api.providerActivate !== "function" || typeof api.onProviderEvent !== "function") {
    throw new TypeError("The desktop bridge cannot deliver provider stream frames.")
  }
  if (signal?.aborted) throw abortError()
  const ticket = started.ticket
  if (typeof ticket !== "string" || !ticket) throw new TypeError("The desktop bridge returned no stream ticket.")
  const status = safeStatus(started.status, 200)
  const current = ensureChannel(api)
  const sink = openSink(api, { ticket, requestId, signal })
  current.tickets.set(ticket, sink)
  try {
    const activated = await untilAborted(api.providerActivate(ticket), signal, () => {})
    if (!activated?.ok || !(activated.active || activated.finished)) {
      throw new TypeError("Provider stream is no longer available.")
    }
  } catch {
    sink.discard()
    if (signal?.aborted) throw abortError()
    throw new TypeError("The desktop bridge could not activate the provider stream.")
  }
  if (!bodyAllowed(status)) {
    current.tickets.delete(ticket)
    sink.discard()
    return new Response(null, { status })
  }
  // Always an incremental body: the provider's own content type decides how the caller reads it, so a
  // non-SSE answer to a streaming request still arrives as one body that the JSON path can parse.
  return new Response(sink.readable, {
    status,
    headers: { "content-type": contentTypeHeader(started.contentType) },
  })
}

async function desktopCall(api, spec) {
  const stream = spec.stream === true
  // A signal that is already aborted must not open anything in main at all.
  if (spec.signal?.aborted) throw abortError()
  const requestId = nextRequestId()
  const envelope = envelopeFor(spec, requestId, stream)
  const cancel = () => {
    try { Promise.resolve(api.providerCancel({ requestId })).catch(() => {}) } catch {}
  }
  if (!stream) {
    return bulkResponse(await untilAborted(api.providerRequest(envelope), spec.signal, cancel))
  }
  const started = await untilAborted(api.providerStream(envelope), spec.signal, cancel)
  if (!started?.ok) {
    const outcome = failureOutcome(started)
    if (outcome.response) return outcome.response
    throw outcome.error
  }
  try {
    return await eventResponse(api, started, requestId, spec.signal)
  } catch (error) {
    cancel()
    throw error
  }
}

/**
 * One provider exchange, whatever the platform.
 *
 * `provider` selects the shape ("gemini" or "openai"), `payload` is the exact JSON body the provider
 * expects, and `key` is used only by the browser path: on the desktop the credential is attached in
 * main and the key in `settings` is ignored.
 */
export async function callProvider(spec) {
  if (!spec || typeof spec !== "object") throw new TypeError("callProvider needs a request description.")
  const api = desktopBridge()
  return api ? desktopCall(api, spec) : browserCall(spec)
}
