export const desktop = globalThis.khungThoaiDesktop

// Both ends of the bridge declare this range: `desktop/native-worker.cjs` mirrors it and
// `native/NativeRpc.cs` answers with its own, so a worker built for another framing is found before
// any of its operations is trusted. Move both ends together and only for an incompatible change.
export const PROTOCOL_MIN = 1
export const PROTOCOL_MAX = 1
const PROTOCOL_CODE = "NATIVE_PROTOCOL_INCOMPATIBLE"
const PROTOCOL_PREFIX = "Native protocol incompatible: "

function describeRange(minimum, maximum) {
  return minimum === maximum ? String(minimum) : minimum + "-" + maximum
}

function rangeDetail(workerMinimum, workerMaximum) {
  return "worker supports " + describeRange(workerMinimum, workerMaximum) +
    ", app supports " + describeRange(PROTOCOL_MIN, PROTOCOL_MAX) + "."
}

// One stable error for every incompatible worker. Main sends the same text over IPC, so the renderer
// keeps one error type and one message whatever layer noticed the mismatch.
export class NativeProtocolError extends Error {
  constructor(detail) {
    super(PROTOCOL_PREFIX + detail)
    this.name = "NativeProtocolError"
    this.code = PROTOCOL_CODE
  }
}

export function isNativeProtocolError(error) {
  return error instanceof NativeProtocolError || error?.code === PROTOCOL_CODE ||
    (typeof error?.message === "string" && error.message.startsWith(PROTOCOL_PREFIX))
}

// Read the range the worker reported and pick the version this build speaks. A capabilities reply
// from a worker built before the handshake carries no version at all, and that worker speaks the
// version this build still serves. A range that does not overlap this build's is refused here instead
// of starting an exchange the worker would abandon half-parsed.
export function negotiatedProtocol(reply) {
  const version = Number.isSafeInteger(reply?.protocolVersion) ? reply.protocolVersion : reply?.version
  const minimum = Number.isSafeInteger(reply?.minProtocol) ? reply.minProtocol : version
  const maximum = Number.isSafeInteger(reply?.maxProtocol) ? reply.maxProtocol : version
  if (!Number.isSafeInteger(version) && !Number.isSafeInteger(minimum) && !Number.isSafeInteger(maximum)) return PROTOCOL_MIN
  if (![version, minimum, maximum].every(Number.isSafeInteger) || minimum > maximum) {
    throw new NativeProtocolError(rangeDetail(minimum, maximum))
  }
  const negotiated = Math.min(PROTOCOL_MAX, maximum)
  if (minimum > PROTOCOL_MAX || maximum < PROTOCOL_MIN) throw new NativeProtocolError(rangeDetail(minimum, maximum))
  if (version !== negotiated) {
    throw new NativeProtocolError("worker replied with protocol " + version + " after agreeing on " + negotiated + ".")
  }
  return negotiated
}

let capabilities
let protocolFailure = null

// The stable error an incompatible worker produced, or null. A caller that reports the degraded state
// reads this instead of inventing a second message.
export function nativeProtocolError() {
  return protocolFailure
}

function adoptProtocolError(error) {
  if (error instanceof NativeProtocolError) return error
  return new NativeProtocolError(String(error?.message ?? "").slice(PROTOCOL_PREFIX.length))
}

async function probeCapabilities() {
  protocolFailure = null
  let reply
  try { reply = await desktop.native("capabilities") }
  catch (error) {
    // Main reports an incompatible worker with this same stable error. Every other failure is a
    // missing or crashed build, which keeps its own hint.
    if (isNativeProtocolError(error)) protocolFailure = adoptProtocolError(error)
    return null
  }
  const result = reply?.result ?? null
  if (!result) return null
  try { negotiatedProtocol(result) }
  catch (error) { protocolFailure = error; return null }
  return result
}

export async function nativeCapabilities(refresh = false) {
  if (!desktop?.native) return null
  if (!capabilities || refresh) capabilities = probeCapabilities()
  return capabilities
}

export async function saveDesktopProject(blob, mode, name, projectId) {
  const transfer = await desktop.projectBegin(mode, name, projectId)
  if (!transfer) return false
  try {
    for (let offset = 0; offset < blob.size; offset += 4 * 1024 * 1024) {
      const data = new Uint8Array(await blob.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer())
      await desktop.projectWrite(transfer.id, "fileAppend", {}, data)
    }
    await desktop.projectWrite(transfer.id, "fileCommit")
    return true
  } catch (error) {
    await desktop.projectWrite(transfer.id, "fileCancel").catch(() => {})
    throw error
  }
}

export async function openDesktopProject(mode) {
  const transfer = await desktop.projectOpen(mode)
  if (!transfer) return null
  try {
    const chunks = []
    let length = 0
    while (length < transfer.size) {
      const chunk = await desktop.projectRead(transfer.id)
      if (!chunk.length) throw new Error("Dự án bị thiếu dữ liệu.")
      chunks.push(chunk)
      length += chunk.length
    }
    const file = new File(chunks, transfer.name)
    file.nativeOpenId = transfer.id
    file.projectId = transfer.projectId
    // The catalogue's title for the project, when the shell knows it: a snapshot file is named
    // after its timestamp and must not rename the project.
    file.projectTitle = transfer.title || null
    file.recovery = transfer.recovery
    return file
  } catch (error) {
    await desktop.projectDiscardOpen(transfer.id).catch(() => {})
    throw error
  } finally { await desktop.projectCancelRead(transfer.id) }
}

export function imagePixels(image, region) {
  const canvas = document.createElement("canvas")
  const rect = region ?? { x: 0, y: 0, w: 1, h: 1 }
  const left = Math.floor(rect.x * image.naturalWidth)
  const top = Math.floor(rect.y * image.naturalHeight)
  canvas.width = Math.max(1, Math.ceil((rect.x + rect.w) * image.naturalWidth) - left)
  canvas.height = Math.max(1, Math.ceil((rect.y + rect.h) * image.naturalHeight) - top)
  const context = canvas.getContext("2d")
  context.drawImage(image, -left, -top)
  return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data, left, top }
}


export async function runNativeTask(operation, options, data) {
  // One stable error instead of an exchange the worker already refused: the caller keeps its own
  // implementation, and a second mismatch cannot hang a queued task.
  const failure = nativeProtocolError()
  if (failure) throw failure
  return desktop.native(operation, options, data, crypto.randomUUID())
}
