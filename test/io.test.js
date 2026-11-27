import assert from "node:assert/strict"
import test from "node:test"
import JSZip from "jszip"
import { DOMParser as XmlDOMParser } from "@xmldom/xmldom"
import {
  extractParagraphText,
  extractSpreadsheetText,
  groupDialogue,
  imageMimeType,
  isImageFile,
  readDialogueFile,
} from "../src/io.js"

const el = (localName, children = [], textContent = "") => ({ localName, childNodes: children, textContent })

test("imageMimeType and isImageFile normalize MIME parameters and infer from extensions", () => {
  assert.equal(imageMimeType("01.jpg", ""), "image/jpeg")
  assert.equal(imageMimeType("01.WEBP", ""), "image/webp")
  assert.equal(imageMimeType("/cdn/img?id=1", "image/png; charset=binary"), "image/png")
  assert.equal(imageMimeType("/cdn/img?id=1", "IMAGE/JPEG; charset=utf-8"), "image/jpeg")
  assert.equal(imageMimeType("notes.txt", "application/octet-stream"), null)

  assert.equal(isImageFile({ name: "01.png", type: "image/png; charset=binary" }), true)
  assert.equal(isImageFile({ name: "01.jpg", type: "" }), true)
  assert.equal(isImageFile({ name: "01.gif", type: "image/gif" }), false)
})

test("extractSpreadsheetText ignores phonetic rPh runs in shared strings", () => {
  const sharedString = el("si", [
    el("r", [el("t", [], "漢字")]),
    el("r", [el("t", [], "テスト")]),
    el("rPh", [el("t", [], "かんじ")]),
  ])
  assert.equal(extractSpreadsheetText(sharedString), "漢字テスト")
})

test("extractParagraphText preserves DOCX line breaks and tabs while skipping deletions and ruby text", () => {
  const paragraph = el("p", [
    el("r", [el("t", [], "Trang 1"), el("br"), el("t", [], "Xin"), el("tab"), el("t", [], "chào")]),
    el("del", [el("r", [el("t", [], "bỏ đi")])]),
    el("r", [el("ruby", [
      el("rt", [el("r", [el("t", [], "furigana")])]),
      el("rubyBase", [el("r", [el("t", [], "!")])]),
    ])]),
  ])
  assert.equal(extractParagraphText(paragraph), "Trang 1\nXin chào!")
})

test("groupDialogue trims whitespace inside bracketed page headings", () => {
  const groups = groupDialogue("[ Trang 2 ]\nCâu một\n[ 03.png ]\nCâu hai")
  assert.deepEqual(groups, [
    { reference: 1, lines: ["Câu một"] },
    { reference: "03.png", lines: ["Câu hai"] },
  ])
})

const xlsxFile = async (sheetXml, sharedStringsXml) => {
  const zip = new JSZip()
  zip.file("xl/worksheets/sheet1.xml", sheetXml)
  if (sharedStringsXml) zip.file("xl/sharedStrings.xml", sharedStringsXml)
  const buffer = await zip.generateAsync({ type: "arraybuffer" })
  return new File([buffer], "thoai.xlsx")
}

test("readDialogueFile imports XLSX whose header row omits an interior cell", async (t) => {
  const original = globalThis.DOMParser
  globalThis.DOMParser = XmlDOMParser
  t.after(() => {
    if (original === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = original
  })
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1</v></c></row>
<row r="3"><c r="A3" t="s"><v>3</v></c></row>
<row r="4"><c r="A4" t="s"><v>4</v></c><c r="C4"><v>2</v></c></row>
</sheetData></worksheet>`
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>Bản dịch</t></si><si><t>Trang</t></si><si><t>Xin chào</t></si><si><t>Tạm biệt</t></si><si><t>Hẹn gặp</t></si>
</sst>`
  const text = await readDialogueFile(await xlsxFile(sheet, sharedStrings))
  assert.equal(text, "Trang 1\nXin chào\nTạm biệt\nTrang 2\nHẹn gặp")
})

test("readDialogueFile falls back to plain rows for headerless sparse XLSX", async (t) => {
  const original = globalThis.DOMParser
  globalThis.DOMParser = XmlDOMParser
  t.after(() => {
    if (original === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = original
  })
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Một</t></is></c><c r="C1" t="inlineStr"><is><t>ba</t></is></c></row>
<row r="2"><c r="C2" t="inlineStr"><is><t>chỉ cột C</t></is></c></row>
</sheetData></worksheet>`
  const text = await readDialogueFile(await xlsxFile(sheet))
  assert.equal(text, "Một ba\nchỉ cột C")
})

test("filenameStem strips a real file extension and keeps dots inside a title", async () => {
  const { filenameStem } = await import("../src/io.js")

  // The repro: a chapter titled with a decimal number used to lose " - Part 2" and its own number.
  assert.equal(filenameStem("One Piece - Chương 1.5 - Part 2"), "One Piece - Chương 1.5 - Part 2")
  assert.equal(filenameStem("Chương 12.5"), "Chương 12.5")

  // Formats the app itself works with still lose their extension.
  assert.equal(filenameStem("01.png"), "01")
  assert.equal(filenameStem("trang-02.JPEG"), "trang-02")
  assert.equal(filenameStem("page.webp"), "page")
  assert.equal(filenameStem("kich-ban.docx"), "kich-ban")
  assert.equal(filenameStem("bang-thuat-ngu.xlsx"), "bang-thuat-ngu")
  assert.equal(filenameStem("catalog.json"), "catalog")
  assert.equal(filenameStem("chapter.khungthoai"), "chapter")
  assert.equal(filenameStem("Bản dịch.zip"), "Bản dịch")

  // Reserved characters become underscores, and an empty name still yields a usable stem.
  assert.equal(filenameStem('a/b:c*d?.png'), "a_b_c_d_")
  assert.equal(filenameStem(""), "trang")
  // A name that is nothing but an extension falls back to the generic stem.
  assert.equal(filenameStem(".png"), "trang")
})
