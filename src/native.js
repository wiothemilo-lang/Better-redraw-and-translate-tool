export const desktop = globalThis.khungThoaiDesktop
let capabilities
export async function nativeCapabilities(refresh = false) {
  if (!desktop?.native) return null
  if (!capabilities || refresh) capabilities = desktop.native("capabilities").then(({ result }) => result).catch(() => null)
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
  return desktop.native(operation, options, data, crypto.randomUUID())
}
