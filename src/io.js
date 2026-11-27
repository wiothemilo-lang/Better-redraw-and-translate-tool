const mimeByExtension = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }
export const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"])
const imageExtensions = /\.(png|jpe?g|webp)$/i

export function imageMimeType(name = "", type = "") {
  const normalized = String(type).split(";", 1)[0].trim().toLowerCase()
  if (imageTypes.has(normalized)) return normalized
  const extension = String(name).match(imageExtensions)?.[1].toLowerCase()
  return mimeByExtension[extension] ?? null
}

export function isImageFile(file) {
  const normalized = String(file.type ?? "").split(";", 1)[0].trim().toLowerCase()
  return imageTypes.has(normalized) || (!normalized && imageExtensions.test(file.name))
}

function xmlDocument(source) {
  const doc = new DOMParser().parseFromString(source, "application/xml")
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Tài liệu XML không đọc được.")
  return doc
}

function named(node, name) {
  return Array.from(node.getElementsByTagNameNS("*", name))
}

export function extractSpreadsheetText(node) {
  let output = ""
  for (const child of node.childNodes ?? []) {
    const name = child.localName
    if (!name || name === "rPh") continue
    if (name === "t") output += child.textContent ?? ""
    else output += extractSpreadsheetText(child)
  }
  return output
}

export function extractParagraphText(node) {
  let output = ""
  for (const child of node.childNodes ?? []) {
    const name = child.localName
    if (!name || name === "del" || name === "rt") continue
    if (name === "t") output += child.textContent ?? ""
    else if (name === "br" || name === "cr") output += "\n"
    else if (name === "tab") output += " "
    else output += extractParagraphText(child)
  }
  return output
}

async function zipXml(zip, pathname) {
  const entry = zip.file(pathname)
  if (!entry) throw new Error("Không tìm thấy dữ liệu trong tài liệu.")
  return xmlDocument(await entry.async("string"))
}

function columnIndex(cell) {
  const reference = cell.getAttribute("r")?.match(/^[A-Z]+/)?.[0]
  if (!reference) return null
  return [...reference].reduce((value, ch) => value * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

async function spreadsheetText(zip) {
  const sheets = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
  const path = sheets.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0]
  if (!path) throw new Error("Tệp XLSX không có bảng tính.")
  const worksheet = await zipXml(zip, path)
  const strings = zip.file("xl/sharedStrings.xml")
    ? named(await zipXml(zip, "xl/sharedStrings.xml"), "si").map(extractSpreadsheetText)
    : []
  const rows = named(worksheet, "row").map((row) => {
    const values = []
    for (const cell of named(row, "c")) {
      const value = named(cell, "v")[0]?.textContent ?? ""
      const type = cell.getAttribute("t")
      values[columnIndex(cell) ?? values.length] = (type === "s" ? strings[Number(value)] : type === "inlineStr" ? extractSpreadsheetText(cell) : value) ?? ""
    }
    return values
  })
  const headings = Array.from(rows[0] ?? [], (cell) => String(cell ?? "").trim().toLowerCase())
  const script = headings.findIndex((cell) => ["translation", "bản dịch", "thoại", "text"].includes(cell))
  const page = headings.findIndex((cell) => ["page", "trang", "ảnh"].includes(cell))
  if (script < 0) return rows.map((row) => row.filter(Boolean).join(" ")).filter(Boolean).join("\n")
  let previousPage = ""
  return rows.slice(1).flatMap((row) => {
    const dialogue = row[script]?.trim()
    if (!dialogue) return []
    const currentPage = (page >= 0 ? row[page]?.trim() : "") || previousPage
    const heading = currentPage && currentPage !== previousPage ? ( /^\d+$/.test(currentPage) ? "Trang " + currentPage : "[" + currentPage + "]") : ""
    previousPage = currentPage
    return heading ? [heading, dialogue] : [dialogue]
  }).join("\n")
}

export async function readDialogueFile(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error("Tệp kịch bản vượt quá 2 MB.")
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (extension === "txt") return file.text()
  if (extension !== "docx" && extension !== "xlsx") throw new Error("Chọn một tệp TXT, DOCX hoặc XLSX.")
  const { default: JSZip } = await import("jszip")
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  if (extension === "xlsx") return spreadsheetText(zip)
  return named(await zipXml(zip, "word/document.xml"), "p").map(extractParagraphText).filter(Boolean).join("\n")
}

export function groupDialogue(source) {
  const groups = [{ reference: null, lines: [] }]
  for (const line of source.split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean) continue
    const heading = clean.match(/^\[(.+)\]$/)?.[1].trim() ?? clean
    const numbered = heading.match(/^(?:trang|page)\s+(\d+)\s*:?$/i)
    if (numbered || imageExtensions.test(heading)) {
      groups.push({ reference: numbered ? Number(numbered[1]) - 1 : heading.toLowerCase(), lines: [] })
    } else {
      groups.at(-1).lines.push(clean)
    }
  }
  return groups.filter(({ lines }) => lines.length)
}

export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

// Only a real file extension is dropped. A chapter title such as
// "One Piece - Chương 1.5 - Part 2" ends in a number, not an extension, and cutting at the last dot
// there lost the part that tells two chapters of the same series apart.
const knownExtension = /\.(png|jpe?g|webp|json|txt|docx|xlsx|zip|khungthoai)$/i

export function filenameStem(name) {
  return name.replace(knownExtension, "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 120) || "trang"
}

export function normalizedSearch(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replaceAll("đ", "d").trim()
}
