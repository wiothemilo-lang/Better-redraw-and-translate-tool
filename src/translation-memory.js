// Project-scoped translation memory (Nixio #63).
//
// A pair is keyed by the source text plus the context that produced it: the language pair, the
// glossary version and the page/style of the box it came from. Two levels of matching exist:
// "exact" (same text after whitespace and Unicode normalization) and "near" (same text after
// folding case, punctuation and Vietnamese diacritics, or above the similarity threshold).
//
// Only an exact, human-reviewed pair is applied on its own. A near match is a suggestion because
// folding diacritics turns "ma" and "má" into the same key, and a machine pair is never trusted
// silently: it is offered, then approved by the user, and only then reused without a provider.

export const translationMemoryVersion = 1
export const translationMemoryEntryLimit = 4000
// Below this similarity a near match is not worth showing and the provider answers instead.
export const translationMemoryFuzzyThreshold = 0.8
// How much a machine pair is discounted against a reviewed one with the same similarity.
const machineWeight = 0.8
// Similarity reported for a match that only differs in case, punctuation or diacritics.
const foldedSimilarity = 0.95
const sourceLimit = 400
const targetLimit = 400

const isText = (value) => typeof value === "string"
const round = (value) => Math.round(value * 1000) / 1000

// Two texts whose whitespace layout and Unicode composition differ are the same line: a provider
// answer and the OCR line it came from routinely disagree on both.
export function normalizeSourceText(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim()
}

// The comparison key: case, whitespace, punctuation, symbols and diacritics are all removed, so
// "Đã hiểu!" and "da hieu" fold together. Vietnamese "đ" has no Unicode decomposition, hence the
// explicit swap. A folded key is only ever used to *offer* a pair, never to apply one.
export function foldSourceText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[đĐ]/g, "d")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
}

function bigramProfile(text) {
  const counts = new Map()
  for (let index = 0; index < text.length - 1; index++) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  const total = Math.max(0, text.length - 1)
  return { counts, total }
}

// Dice coefficient over two bigram profiles: script-agnostic, so a Vietnamese line and a Japanese
// line are scored the same way and no tokenizer is needed.
function diceFromProfiles(left, right) {
  if (!left.total || !right.total) return 0
  let shared = 0
  for (const [gram, count] of left.counts) shared += Math.min(count, right.counts.get(gram) ?? 0)
  return round((2 * shared) / (left.total + right.total))
}

// An entry's text never changes after it is created, so its comparison keys and its bigram profile
// are computed once. The panel matches on every render and a chapter can hold thousands of pairs,
// which is why this is a per-object cache rather than a field of the persisted record.
const entryKeys = new WeakMap()

function keysOf(entry) {
  const cached = entryKeys.get(entry)
  if (cached) return cached
  const sourceKey = normalizeSourceText(entry.source)
  const record = { sourceKey, foldKey: foldSourceText(entry.source), profile: null }
  entryKeys.set(entry, record)
  return record
}

function profileOf(keys) {
  if (!keys.profile) keys.profile = bigramProfile(keys.foldKey)
  return keys.profile
}

// The glossary's meaning lives in its structure, not only in its letters: folding punctuation away
// made "A = B" and "AB" share a key, so a pair reviewed against a term that was later deleted kept
// being applied. Each line keeps its separator split and its directives, term order stays irrelevant,
// and only case, spacing and diacritics are folded. An unparsable line is kept as its own marker so
// deleting the separator still starts a new version.
function canonicalGlossary(glossary) {
  const terms = []
  let current = null
  for (const rawLine of String(glossary ?? "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith("//")) continue
    const directive = line.match(/^@(\p{L}+)(?:\s+(.*))?$/u)
    if (directive) {
      const marker = "@" + foldSourceText(directive[1]) + ":" + foldSourceText(directive[2] ?? "")
      if (current) current.push(marker)
      else terms.push([marker])
      continue
    }
    const separator = line.includes("=") ? "=" : line.includes("->") ? "->" : line.includes(":") ? ":" : ""
    const index = separator ? line.indexOf(separator) : -1
    const source = index < 0 ? "" : foldSourceText(line.slice(0, index))
    const target = index < 0 ? "" : foldSourceText(line.slice(index + separator.length))
    if (!source || !target) {
      terms.push([`invalid:${foldSourceText(line)}`])
      current = null
      continue
    }
    current = [source, target]
    terms.push(current)
  }
  return terms.map((term) => term.join("\u0001")).sort().join("\u0002")
}

// FNV-1a over the canonical glossary: reformatting the list keeps the memory valid, while adding,
// changing or deleting a term starts a new glossary version, exactly like the translation signature.
export function glossaryVersion(glossary) {
  const canonical = canonicalGlossary(glossary)
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.codePointAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

export function translationMemoryScope(settings) {
  return {
    sourceLanguage: String(settings?.source ?? ""),
    targetLanguage: String(settings?.target ?? ""),
    glossaryKey: glossaryVersion(settings?.glossary ?? ""),
  }
}

// The part of a box that identifies it: the same line set in a different font or size is a
// different box, so a match that also agrees on style wins a tie.
export function boxStyleSignature(box) {
  const size = Number.isFinite(box?.size) ? Math.round(box.size) : ""
  return [box?.font ?? "", size, box?.align ?? ""].join("|")
}

const sameScope = (entry, scope) =>
  entry.sourceLanguage === scope.sourceLanguage &&
  entry.targetLanguage === scope.targetLanguage &&
  entry.glossaryKey === scope.glossaryKey

const normalizeTargetText = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim()

function entryId(scope, sourceKey) {
  const seed = [scope.sourceLanguage, scope.targetLanguage, scope.glossaryKey, sourceKey].join("\u0001")
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.codePointAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return "tm-" + hash.toString(36) + "-" + sourceKey.length.toString(36)
}

// Persistence guard for one entry. Returns the cleaned record or null, so `src/project.js` decides
// what an invalid entry means for the file it is reading.
export function validateTranslationMemoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null
  const {
    id, source, target, sourceLanguage, targetLanguage,
    glossaryKey: version, page = "", style = "", reviewed = false,
    confidence, hits = 0, createdAt = 0, updatedAt = 0,
  } = entry
  if (!isText(id) || !id || id.length > 64) return null
  if (!isText(source) || !normalizeSourceText(source) || source.length > sourceLimit) return null
  if (!isText(target) || !normalizeTargetText(target) || target.length > targetLimit) return null
  if (!isText(sourceLanguage) || !isText(targetLanguage) || sourceLanguage.length > 40 || targetLanguage.length > 40) return null
  if (!isText(version) || !version || version.length > 32) return null
  if (!isText(page) || page.length > 200) return null
  if (!isText(style) || style.length > 120) return null
  if (typeof reviewed !== "boolean") return null
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  if (!Number.isInteger(hits) || hits < 0) return null
  if (!Number.isInteger(createdAt) || createdAt < 0) return null
  if (!Number.isInteger(updatedAt) || updatedAt < 0) return null
  return {
    id, source: normalizeSourceText(source), target: normalizeTargetText(target),
    sourceLanguage, targetLanguage, glossaryKey: version, page, style, reviewed,
    confidence: round(confidence), hits, createdAt, updatedAt,
  }
}

// Lenient counterpart of the guard above: a record from storage keeps every valid entry and drops
// the rest, so one corrupt row cannot cost the whole memory.
export function sanitizeTranslationMemory(memory) {
  const entries = []
  for (const entry of Array.isArray(memory?.entries) ? memory.entries : []) {
    const valid = validateTranslationMemoryEntry(entry)
    if (valid) entries.push(valid)
  }
  return { version: translationMemoryVersion, entries }
}

const emptyMemory = () => ({ version: translationMemoryVersion, entries: [] })

function insertEntry(memory, entry) {
  memory.entries.push(entry)
  pruneTranslationMemory(memory)
  return entry
}

// The store is bounded: the oldest machine pairs go first, because they are the cheapest to lose. A
// reviewed pair is only evicted when nothing else is left — the manifest refuses more than the limit,
// so failing to trim would turn every later save into an invalid-project error.
export function pruneTranslationMemory(memory, limit = translationMemoryEntryLimit) {
  while (memory.entries.length > limit) {
    let oldest = -1
    for (const [index, candidate] of memory.entries.entries()) {
      if (candidate.reviewed) continue
      if (oldest < 0 || candidate.updatedAt < memory.entries[oldest].updatedAt) oldest = index
    }
    // Every remaining pair was reviewed: drop the least recently touched one to keep the cap.
    if (oldest < 0) {
      oldest = 0
      for (const [index, candidate] of memory.entries.entries()) {
        if (candidate.updatedAt < memory.entries[oldest].updatedAt) oldest = index
      }
    }
    memory.entries.splice(oldest, 1)
  }
  return memory
}

// Records the pair the provider produced, or the pair a human confirmed when `reviewed` is set.
// A reviewed pair is never replaced by a machine answer for the same source: the human one wins.
export function recordTranslation(memory, pair, context = {}, options = {}) {
  const { scope = translationMemoryScope({}), page = "", style = "" } = context
  const now = Number.isInteger(options.now) ? options.now : Date.now()
  const reviewed = options.reviewed === true
  const source = normalizeSourceText(pair?.source)
  const target = normalizeTargetText(pair?.target)
  if (!source || !target || source.length > sourceLimit || target.length > targetLimit) return { entry: null, changed: false }
  const confidence = reviewed ? 1 : Number.isFinite(options.confidence) ? Math.min(1, Math.max(0, options.confidence)) : 0.6
  const existing = memory.entries.find((entry) => sameScope(entry, scope) && keysOf(entry).sourceKey === source)
  if (existing) {
    if (existing.reviewed && !reviewed) return { entry: existing, changed: false }
    const changed = existing.target !== target || existing.confidence !== round(confidence) || existing.reviewed !== reviewed
    existing.target = target
    existing.reviewed = reviewed || existing.reviewed
    existing.confidence = round(confidence)
    existing.updatedAt = changed ? now : existing.updatedAt
    if (page && !existing.page) existing.page = page
    if (style && !existing.style) existing.style = style
    return { entry: existing, changed }
  }
  const entry = insertEntry(memory, {
    id: entryId(scope, source), source, target,
    sourceLanguage: scope.sourceLanguage, targetLanguage: scope.targetLanguage, glossaryKey: scope.glossaryKey,
    page, style, reviewed, confidence: round(confidence), hits: 0, createdAt: now, updatedAt: now,
  })
  return { entry, changed: true }
}

export function approveTranslationMemoryEntry(memory, id, options = {}) {
  const now = Number.isInteger(options.now) ? options.now : Date.now()
  const entry = memory.entries.find((candidate) => candidate.id === id)
  if (!entry) return { entry: null, changed: false }
  if (entry.reviewed && entry.confidence === 1) return { entry, changed: false }
  entry.reviewed = true
  entry.confidence = 1
  entry.updatedAt = now
  return { entry, changed: true }
}

function betterMatch(candidate, best) {
  if (candidate.score !== best.score) return candidate.score > best.score
  if (candidate.reviewed !== best.reviewed) return candidate.reviewed
  if (candidate.pageMatch !== best.pageMatch) return candidate.pageMatch
  if (candidate.styleMatch !== best.styleMatch) return candidate.styleMatch
  if (candidate.entry.hits !== best.entry.hits) return candidate.entry.hits > best.entry.hits
  return candidate.entry.updatedAt > best.entry.updatedAt
}

// Best pair for one source line, or null when nothing is close enough for the provider to be spared
// (or for the user to be offered a suggestion).
export function lookupTranslation(memory, query = {}, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : translationMemoryFuzzyThreshold
  const text = normalizeSourceText(query.text)
  if (!text) return null
  const scope = query.scope ?? translationMemoryScope({})
  const folded = foldSourceText(text)
  const profile = bigramProfile(folded)
  let best = null
  for (const entry of memory?.entries ?? []) {
    if (!sameScope(entry, scope)) continue
    const keys = keysOf(entry)
    let kind = ""
    let similarity = 0
    if (keys.sourceKey === text) {
      kind = "exact"
      similarity = 1
    } else if (keys.foldKey === folded) {
      kind = "near"
      similarity = foldedSimilarity
    } else {
      // Dice is at most 2·min/(sum), so a pair of very different lengths can be skipped before the
      // expensive comparison — the difference is what keeps a large memory cheap to search.
      const other = profileOf(keys)
      if (!profile.total || !other.total) continue
      if ((2 * Math.min(profile.total, other.total)) / (profile.total + other.total) < threshold) continue
      similarity = diceFromProfiles(profile, other)
      if (similarity >= threshold) kind = "near"
    }
    if (!kind) continue
    const candidate = {
      kind,
      entry,
      similarity,
      // A machine pair is worth less than a reviewed one with the same text similarity, which is
      // what makes an approved pair outrank a machine pair in one comparison.
      score: round(similarity * (entry.reviewed ? 1 : machineWeight)),
      reviewed: entry.reviewed,
      pageMatch: Boolean(query.page && entry.page && entry.page === query.page),
      styleMatch: Boolean(query.style && entry.style && entry.style === query.style),
      autoApplicable: kind === "exact" && entry.reviewed,
    }
    if (!best || betterMatch(candidate, best)) best = candidate
  }
  return best
}

// Splits a page's boxes into the pairs the memory can apply on its own, the near matches it can
// offer, and the boxes that still need the provider.
export function planBoxTranslations(memory, boxes, context = {}, options = {}) {
  const hits = []
  const suggestions = []
  const pending = []
  for (const box of Array.isArray(boxes) ? boxes : []) {
    const style = boxStyleSignature(box)
    const match = lookupTranslation(memory, { text: box?.text, scope: context.scope, page: context.page, style }, options)
    if (!match) {
      pending.push(box)
      continue
    }
    const item = {
      box, boxId: box.id, style,
      source: normalizeSourceText(box.text),
      target: match.entry.target,
      entry: match.entry, kind: match.kind,
      score: match.score, similarity: match.similarity, reviewed: match.reviewed,
    }
    if (match.autoApplicable) hits.push(item)
    else {
      suggestions.push(item)
      pending.push(box)
    }
  }
  return { hits, suggestions, pending }
}

// Writes the targets of a plan (or of the pairs a user just accepted) into their boxes.
export function applyTranslationMemoryMatches(matches) {
  let applied = 0
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match?.box || !match.target) continue
    match.box.text = match.target
    if (match.entry) match.entry.hits += 1
    applied++
  }
  return applied
}

// A user accepting a suggestion validates that pair: an exact match approves the pair already stored
// for that wording, and a near match records the box's own wording as a reviewed entry instead of
// flipping the entry it happened to match.
export function acceptTranslationSuggestions(memory, suggestions, context = {}, options = {}) {
  const accepted = []
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    if (!suggestion?.target) continue
    if (suggestion.kind === "exact" && suggestion.entry) {
      const approved = approveTranslationMemoryEntry(memory, suggestion.entry.id, options)
      if (approved.entry) accepted.push({ entry: approved.entry, boxId: suggestion.boxId, target: suggestion.target })
      continue
    }
    const style = suggestion.style ?? context.style ?? ""
    const { entry } = recordTranslation(memory, { source: suggestion.source, target: suggestion.target },
      { scope: context.scope, page: context.page ?? "", style }, { ...options, reviewed: true })
    if (entry) accepted.push({ entry, boxId: suggestion.boxId, target: suggestion.target })
  }
  return accepted
}

export function translationMemorySummary(memory, scope) {
  const entries = (memory?.entries ?? []).filter((entry) => sameScope(entry, scope ?? translationMemoryScope({})))
  return {
    total: entries.length,
    reviewed: entries.filter((entry) => entry.reviewed).length,
    machine: entries.filter((entry) => !entry.reviewed).length,
  }
}

// The editor holds one store per project. `revision` lets the panel skip recomputing a plan it has
// already shown, and `replace` is how opening a project hands over the pairs saved in its manifest.
export function createTranslationMemoryStore(initial) {
  let memory = initial === undefined ? emptyMemory() : sanitizeTranslationMemory(initial)
  let revision = 0
  const touch = () => {
    revision++
  }
  return {
    get revision() {
      return revision
    },
    get size() {
      return memory.entries.length
    },
    memory() {
      return memory
    },
    snapshot() {
      return { version: translationMemoryVersion, entries: memory.entries.map((entry) => ({ ...entry })) }
    },
    replace(next) {
      memory = next === undefined ? emptyMemory() : sanitizeTranslationMemory(next)
      touch()
    },
    clear() {
      memory = emptyMemory()
      touch()
    },
    lookup(query, options) {
      return lookupTranslation(memory, query, options)
    },
    plan(boxes, context, options) {
      return planBoxTranslations(memory, boxes, context, options)
    },
    record(pair, context, options) {
      const result = recordTranslation(memory, pair, context, options)
      if (result.changed) touch()
      return result.entry
    },
    approve(id, options) {
      const result = approveTranslationMemoryEntry(memory, id, options)
      if (result.changed) touch()
      return result.entry
    },
    accept(suggestions, context, options) {
      const accepted = acceptTranslationSuggestions(memory, suggestions, context, options)
      if (accepted.length) touch()
      return accepted
    },
    apply(matches) {
      return applyTranslationMemoryMatches(matches)
    },
    summary(scope) {
      return translationMemorySummary(memory, scope)
    },
  }
}
