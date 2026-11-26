// Staged tool execution pipeline & fail-closed parallel/exclusive batch scheduler,
// inspired by DeepSeek Harness (packages/core/tools/src/pipeline.ts & batch.ts).

export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"

export function deepFreezeSnapshot(value) {
  let cloned
  try {
    cloned = JSON.parse(JSON.stringify(value ?? {}))
  } catch {
    throw new TypeError("Tham số công cụ phải tuần tự hóa JSON hợp lệ.")
  }
  const freeze = (node) => {
    if (node && typeof node === "object" && !Object.isFrozen(node)) {
      Object.freeze(node)
      for (const child of Object.values(node)) freeze(child)
    }
    return node
  }
  return freeze(cloned)
}

function fuseSignals(callerSignal, timeoutMs) {
  const signals = []
  if (callerSignal) signals.push(callerSignal)
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (!signals.length) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

function abortedBeforeDispatchOutcome(call) {
  return {
    id: call.id,
    name: call.name,
    args: call.args ?? {},
    ok: false,
    code: TOOL_ABORTED_BEFORE_DISPATCH,
    summary: "Đã hủy trước khi thực thi.",
    error: "Đã hủy trước khi thực thi.",
    durationMs: 0,
  }
}

async function runSingleCall(call, { tools, allowEdits, allowWebSearch, signal, onEvent }) {
  if (signal?.aborted) return abortedBeforeDispatchOutcome(call)

  let frozenArgs
  try {
    frozenArgs = deepFreezeSnapshot(call.args ?? {})
  } catch (error) {
    const failed = {
      id: call.id,
      name: call.name,
      args: call.args ?? {},
      ok: false,
      summary: error.message,
      error: error.message,
      durationMs: 0,
    }
    onEvent?.({ type: "tool_start", id: call.id, name: call.name, args: call.args ?? {} })
    onEvent?.({ type: "tool_end", ...failed })
    return failed
  }

  const start = performance.now()
  onEvent?.({ type: "tool_start", id: call.id, name: call.name, args: frozenArgs })

  const timeoutMs = tools.timeoutMs?.(call.name) ?? 15000
  const execSignal = fuseSignals(signal, timeoutMs)

  let outcome
  try {
    outcome = await tools.execute(call.name, frozenArgs, {
      allowEdits,
      allowWebSearch,
      signal: execSignal,
    })
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError"
    const message = isTimeout
      ? `Công cụ "${call.name}" vượt quá thời gian cho phép (${Math.round(timeoutMs / 1000)}s).`
      : (error?.message || String(error))
    outcome = { ok: false, error: message }
  }

  const durationMs = Math.round(performance.now() - start)
  const settled = {
    id: call.id,
    name: call.name,
    args: frozenArgs,
    ok: Boolean(outcome?.ok),
    summary: outcome?.ok ? outcome.summary : (outcome?.error || "Lỗi không xác định"),
    data: outcome?.data,
    modelText: outcome?.modelText,
    error: outcome?.error,
    durationMs,
  }
  onEvent?.({ type: "tool_end", ...settled })
  return settled
}

/**
 * Execute one assistant step's tool calls:
 * - Parallel-safe calls (`tools.isConcurrencySafe(name) === true`) run in bounded concurrent pools.
 * - Exclusive calls (mutations or unclassified tools, fail-closed) form strict ordering barriers.
 * - Settled results are ALWAYS returned in exact model call order.
 * - Abort skips unstarted calls with synthetic TOOL_ABORTED_BEFORE_DISPATCH results so history stays valid.
 */
export async function executeToolBatch(
  calls,
  { tools, allowEdits = true, allowWebSearch = true, maxParallel = 4, signal, onEvent } = {},
) {
  const limit = Math.max(1, Math.min(8, Math.floor(Number(maxParallel) || 4)))
  const results = new Array(calls.length)
  let index = 0

  while (index < calls.length) {
    if (signal?.aborted) {
      for (let i = index; i < calls.length; i++) {
        results[i] = abortedBeforeDispatchOutcome(calls[i])
      }
      break
    }

    const safe = tools.isConcurrencySafe?.(calls[index].name) === true
    if (!safe) {
      results[index] = await runSingleCall(calls[index], {
        tools,
        allowEdits,
        allowWebSearch,
        signal,
        onEvent,
      })
      index++
      continue
    }

    // Collect contiguous run of parallel-safe calls up to the next exclusive barrier.
    const groupIndices = []
    while (index < calls.length && tools.isConcurrencySafe?.(calls[index].name) === true) {
      groupIndices.push(index)
      index++
    }

    // Execute the parallel group with a bounded rolling worker pool.
    let cursor = 0
    const workerCount = Math.min(limit, groupIndices.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < groupIndices.length) {
        const slot = groupIndices[cursor++]
        if (signal?.aborted) {
          results[slot] = abortedBeforeDispatchOutcome(calls[slot])
          continue
        }
        results[slot] = await runSingleCall(calls[slot], {
          tools,
          allowEdits,
          allowWebSearch,
          signal,
          onEvent,
        })
      }
    })
    await Promise.all(workers)
  }

  return results
}
