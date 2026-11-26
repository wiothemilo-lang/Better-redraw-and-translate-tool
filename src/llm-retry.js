// Exponential backoff with jitter and cancellable delay for transient LLM errors,
// inspired by DeepSeek Harness `packages/llm/llm-retry`.

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status))
}

export function parseRetryAfterMs(headerValue, maxMs = 15000) {
  if (!headerValue) return null
  const text = String(headerValue).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.min(maxMs, Math.max(0, Math.round(Number(text) * 1000)))
  }
  const dateMs = Date.parse(text)
  if (Number.isFinite(dateMs)) {
    return Math.min(maxMs, Math.max(0, dateMs - Date.now()))
  }
  return null
}

export function computeBackoffDelay(
  attempt,
  { initialDelayMs = 800, maxDelayMs = 8000, jitterRatio = 0.25, random = Math.random } = {},
) {
  const exp = Math.min(Math.max(0, attempt - 1), 16)
  const base = Math.min(initialDelayMs * 2 ** exp, maxDelayMs)
  const factor = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.max(50, Math.round(Math.min(base * factor, maxDelayMs)))
}

export function cancellableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(true)
    }, Math.max(0, delayMs))
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function isRetryableError(error) {
  if (!error) return false
  if (error.name === "AbortError") return false
  if (Number.isFinite(error.status)) return isRetryableStatus(error.status)
  if (error.name === "TimeoutError" || error.name === "TypeError") return true
  const msg = String(error.message || "")
  return /network|failed to fetch|timeout|429|502|503|504/i.test(msg)
}

export async function withLlmRetry(
  operation,
  {
    maxRetries = 2,
    initialDelayMs = 800,
    maxDelayMs = 8000,
    jitterRatio = 0.25,
    signal,
    random = Math.random,
    delayFn = cancellableDelay,
    onRetry,
  } = {},
) {
  let attempt = 0
  while (true) {
    signal?.throwIfAborted()
    try {
      return await operation(attempt)
    } catch (error) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryableError(error)) {
        throw error
      }
      attempt++
      const delayMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
        ? Math.min(error.retryAfterMs, maxDelayMs)
        : computeBackoffDelay(attempt, { initialDelayMs, maxDelayMs, jitterRatio, random })
      onRetry?.({ attempt, maxRetries, delayMs, error })
      const waited = await delayFn(delayMs, signal)
      if (!waited) signal?.throwIfAborted()
    }
  }
}
