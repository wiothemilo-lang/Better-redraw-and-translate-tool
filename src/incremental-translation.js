import { citesGlossaryTerm, parseGlossary } from "./linter.js"
import { remainingTranslations, translationNotes, translationSignature } from "./translation.js"

// Incremental box translation.
//
// Every box a box job translates keeps a stamp of the inputs its text was produced from: the source
// line that was sent, the glossary pairs that applied to it, and a digest of everything else the
// provider sees (style, geometry, target language, notes, model and the page image). A box is stale
// when any of those moved, so pressing the button again with no edit sends nothing, an edited line
// sends one box, and a glossary edit re-sends only the boxes that cite the term that changed.
//
// The stamp travels with the box through the project file, so a resumed job knows what is stale.
// A project saved by another build or opened on another machine carries no stamps at all: every box
// is then stale, which turns the run into a full pass instead of a silent skip.

// The digest only has to notice a change, not resist an attacker, so it stays synchronous — the
// editor decides what is stale while the user is editing. Two independent rounds keep accidental
// collisions out of reach for the few hundred boxes a chapter holds.
function digest(text) {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0")
}

// A fraction of the page is compared on a 0.01% grid: a drag that lands on the same pixel is not a
// new translation input.
const fraction = (value) => (Number.isFinite(value) ? Number(value.toFixed(4)) : 0)
const numeric = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)
const textual = (value, fallback = "") => (typeof value === "string" ? value : fallback)

// Mirrors the defaults `projectStyle` writes back, so a box keeps its digest across a save and a
// reopen: an omitted `bold` and an explicit `bold: false` must hash the same, and a warp of zero
// amount draws no bend, so the saved pair hashes like no warp at all.
function styleInputs(box) {
  const warpAmount = numeric(box?.warpAmount)
  return {
    size: numeric(box?.size),
    font: textual(box?.font),
    color: textual(box?.color),
    align: textual(box?.align),
    rotation: numeric(box?.rotation),
    fill: Boolean(box?.fill),
    bold: Boolean(box?.bold),
    italic: Boolean(box?.italic),
    uppercase: Boolean(box?.uppercase),
    vertical: Boolean(box?.vertical),
    bubbleFit: Boolean(box?.bubbleFit),
    warp: warpAmount === 0 ? "none" : textual(box?.warp, "none"),
    warpAmount,
    lineHeight: numeric(box?.lineHeight, 1.15),
    strokeWidth: numeric(box?.strokeWidth),
    strokeColor: textual(box?.strokeColor, "#ffffff"),
    shadowBlur: numeric(box?.shadowBlur),
    shadowColor: textual(box?.shadowColor, "#000000"),
    fillColor: textual(box?.fillColor, "#ffffff"),
    fillShape: textual(box?.fillShape, "rect"),
  }
}

// The image the provider is looking at. Replacing or reordering a page therefore invalidates that
// page, while editing its text does not. Only the name and the byte length are used: the mime type
// is derived from the name, and reopening a project rebuilds the file from stored bytes, so a type
// that was missing before the save would otherwise fake a new image on every open. `lastModified`
// has the same problem and is never read.
function pageImageKey(page) {
  const file = page?.file
  return [
    textual(file?.name, textual(page?.name)),
    numeric(file?.size, numeric(page?.size)),
  ].join("\u0000")
}

// `settings` must be the raw settings the controller read, not the request copy whose `notes`
// already contains the skill prompt: `translationNotes` derives the effective notes here.
export function boxFingerprint(box, settings, page) {
  return digest(JSON.stringify({
    geometry: [box?.x, box?.y, box?.w, box?.h].map(fraction),
    style: styleInputs(box),
    source: textual(settings?.source),
    target: textual(settings?.target),
    // The signature the job records includes the writing direction, so the digest has to as well or
    // a left-to-right / right-to-left switch would look like nothing changed.
    direction: textual(settings?.direction),
    notes: textual(translationNotes(settings ?? {})),
    provider: textual(settings?.provider, "gemini"),
    model: textual(settings?.model),
    endpoint: textual(settings?.baseUrl),
    llmModel: textual(settings?.llmModel),
    image: pageImageKey(page),
  }))
}

// The glossary entries whose source term appears in a line, in a stable order.
export function citedGlossary(glossaryText, source) {
  const line = textual(source)
  if (!line) return []
  return parseGlossary(glossaryText)
    .filter(({ source: term }) => citesGlossaryTerm(line, term))
    .map(({ source: term, target }) => [term, target])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

function sameTerms(recorded, current) {
  if (recorded.length !== current.length) return false
  return current.every(([term, target], index) => recorded[index]?.[0] === term && recorded[index]?.[1] === target)
}

function boxStamp(box) {
  const stamp = box?.translationStamp
  return stamp && typeof stamp.hash === "string" ? stamp : null
}

export function hasFingerprints(page) {
  return (page?.boxes ?? []).some((box) => boxStamp(box))
}

// The text the user sees is the reply that was written, so any edit of it — a retyped line or a
// freshly pasted source — counts as a new line to translate.
function boxIsStale(box, settings, page) {
  const stamp = boxStamp(box)
  if (!stamp) return true
  if (textual(box?.text) !== stamp.output) return true
  if (boxFingerprint(box, settings, page) !== stamp.hash) return true
  return !sameTerms(stamp.terms ?? [], citedGlossary(settings?.glossary ?? "", stamp.source))
}

function hasSourceLine(box) {
  return textual(box?.text).trim().length > 0
}

export function staleBoxes(page, settings) {
  return (page?.boxes ?? []).filter((box) => hasSourceLine(box) && boxIsStale(box, settings, page))
}

// Records what this box was translated from, once the new text has been written into it.
export function recordBoxTranslation(box, { source, settings, page }) {
  box.translationStamp = {
    hash: boxFingerprint(box, settings, page),
    source: textual(source),
    output: textual(box?.text),
    terms: citedGlossary(settings?.glossary ?? "", source),
  }
  return box.translationStamp
}

// Writes a box-level answer back. Boxes that were not sent keep their text, so an unchanged line
// never loses an edit, and only the boxes that answered are stamped.
export function applyBoxTranslations(page, boxes, translated, settings, { reused = 0 } = {}) {
  const byBoxId = new Map((translated ?? []).filter(Boolean).map((item) => [item.boxId, item]))
  let updated = 0
  for (const box of boxes ?? []) {
    const match = byBoxId.get(box.id)
    if (!match?.text) continue
    box.text = match.text
    recordBoxTranslation(box, { source: match.source, settings, page })
    updated++
  }
  // Kept counts the boxes that still hold the text they had before this run. Boxes the memory
  // answered were written too, so they are subtracted here instead of being counted twice.
  return { updated, kept: Math.max(0, (page?.boxes?.length ?? 0) - updated - reused) }
}

// Whether the resume button has anything to do: exactly the work a resume run would find, so the
// button can never promise a page the run then skips. It is only re-read when the project or the
// settings change, not on every render.
export function resumePending(pages, settings) {
  const { full, delta } = resumeWork(pages, settings)
  return full.length > 0 || delta.length > 0
}

// Which pages a resume run still has to touch, in page order. A page whose job never finished, or
// that was translated before fingerprints existed and no longer matches the settings, is read again
// from the image. A page that already carries stamps only needs the boxes whose inputs drifted, and
// a page with nothing stale is left alone.
export function resumeWork(pages, settings) {
  const list = pages ?? []
  // Nothing to compare anywhere: this is a project from another build or another machine, so the
  // page-level contract decides the run and the answer is a full pass.
  if (!list.some(hasFingerprints)) return { full: remainingTranslations(list, settings), delta: [] }
  const signature = translationSignature(settings)
  const full = []
  const delta = []
  for (const page of list) {
    const job = page.translationJob
    if (job?.kind !== "translate" || job.state !== "done") {
      full.push(page)
      continue
    }
    if (!hasFingerprints(page)) {
      // No stamp on this page, so the settings are the only thing that can call it stale.
      if (job.signature !== signature) full.push(page)
      continue
    }
    // A changed signature may come from a box-level input — glossary, target language, notes — that
    // the stamps already track, so only the boxes that drifted are sent again.
    if (job.signature !== signature || staleBoxes(page, settings).length) delta.push(page)
  }
  return { full, delta }
}
