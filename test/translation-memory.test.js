import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { readProject, writeProject } from "../src/project.js"
import {
  applyTranslationMemoryMatches,
  boxStyleSignature,
  createTranslationMemoryStore,
  foldSourceText,
  glossaryVersion,
  lookupTranslation,
  normalizeSourceText,
  planBoxTranslations,
  pruneTranslationMemory,
  sanitizeTranslationMemory,
  translationMemoryEntryLimit,
  translationMemoryScope,
  translationMemorySummary,
  validateTranslationMemoryEntry,
} from "../src/translation-memory.js"

// Nixio #63. The memory is checked as three separate promises: the keys it matches on, the ranking
// that makes a reviewed pair win, and the two places it changes behaviour (no provider call for an
// exact approved pair, a suggestion for everything else). The provider itself is a fake bridge, so
// "no request was made" is measured on the channel a request would actually appear on.

const japaneseVietnamese = (glossary = "") => translationMemoryScope({ source: "Japanese", target: "Vietnamese", glossary })

function seeded(entries) {
  const store = createTranslationMemoryStore()
  for (const [pair, scope, options] of entries) store.record(pair, { scope }, options)
  return store
}

// --- keys ---------------------------------------------------------------------------------------

test("normalization keeps one line, folding erases case, spacing, punctuation and diacritics", () => {
  assert.equal(normalizeSourceText("  Chào   bạn!\n"), "Chào bạn!")
  assert.equal(foldSourceText("Đã hiểu!"), "dahieu")
  assert.equal(foldSourceText("da hieu"), "dahieu")
  assert.equal(foldSourceText("  ĐÃ   HIỂU  "), "dahieu")
  // Japanese punctuation and width variants fold to the same run.
  assert.equal(foldSourceText("おはよう！"), foldSourceText("おはよう"))
  // Folding is never a translation key on its own: "ma" and "má" are different words in Vietnamese.
  assert.equal(foldSourceText("ma"), foldSourceText("má"))
  assert.equal(normalizeSourceText("ma") === normalizeSourceText("má"), false)
})

test("similarity is symmetric, script-agnostic and bounded", () => {
  const scope = japaneseVietnamese()
  const memory = { version: 1, entries: [
    { id: "a", source: "Chào bạn", target: "Xin chào", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, page: "", style: "", reviewed: false, confidence: 0.6, hits: 0, createdAt: 1, updatedAt: 1 },
  ] }
  const fromEntry = lookupTranslation(memory, { text: "Chào bạn nhé", scope })
  const fromQuery = lookupTranslation({ version: 1, entries: [{ ...memory.entries[0], source: "Chào bạn nhé" }] }, { text: "Chào bạn", scope })
  assert.equal(fromEntry.kind, "near")
  assert.equal(fromEntry.similarity, fromQuery.similarity, "the score does not depend on which side is stored")
  assert.equal(fromEntry.similarity < 1, true)
  // A line that shares almost nothing is not a suggestion at all.
  assert.equal(lookupTranslation(memory, { text: "こんばんは、いい天気ですね", scope }), null)
  // A single character has no bigrams to compare, and an empty query matches nothing.
  assert.equal(lookupTranslation(memory, { text: "C", scope }), null)
  assert.equal(lookupTranslation(memory, { text: "", scope }), null)
})

test("the glossary version only changes when a term changes", () => {
  assert.equal(glossaryVersion("先生 = thầy"), glossaryVersion("  先生   = thầy "))
  assert.equal(glossaryVersion("先生 = thầy"), glossaryVersion("先生 = thấy"))
  assert.notEqual(glossaryVersion("先生 = thầy"), glossaryVersion(""))
  // Reordering terms and switching the separator style is reformatting, not a new glossary.
  assert.equal(glossaryVersion("A = B\nC = D"), glossaryVersion("C -> D\nA : B"))
  assert.equal(glossaryVersion("A = B"), glossaryVersion("# ghi chú\nA = B\n// ghi chú"))
})

// Regression for #141: folding punctuation made a deleted term and its two letters share a scope key,
// so a pair recorded for "A = B" was applied to a glossary that now reads "AB".
test("the glossary version keeps the separator that turned a term into two letters", () => {
  assert.notEqual(glossaryVersion("A = B"), glossaryVersion("AB"))
  assert.notEqual(glossaryVersion("A = B"), glossaryVersion("A B"))
  const scoped = japaneseVietnamese("A = B")
  const store = seeded([[{ source: "A", target: "B" }, scoped, { now: 1, reviewed: true }]])
  const edited = japaneseVietnamese("AB")
  assert.equal(store.lookup({ text: "A", scope: edited }), null, "a pair outlives the term it was recorded under")
})

// --- matching and ranking -----------------------------------------------------------------------

test("an exact pair is applied only when a human reviewed it", () => {
  const scope = japaneseVietnamese()
  const store = seeded([
    [{ source: "おはよう", target: "Chào buổi sáng" }, scope, { now: 1 }],
  ])
  const machine = lookupTranslation(store.memory(), { text: "おはよう", scope })
  assert.equal(machine.kind, "exact")
  assert.equal(machine.reviewed, false)
  assert.equal(machine.autoApplicable, false)
  assert.equal(machine.score, 0.8, "a machine pair is discounted against a reviewed one")

  store.approve(store.memory().entries[0].id, { now: 2 })
  const reviewed = lookupTranslation(store.memory(), { text: "おはよう", scope })
  assert.equal(reviewed.autoApplicable, true)
  assert.equal(reviewed.score, 1)
})

test("a reviewed pair outranks a machine pair and a page match breaks a tie", () => {
  const scope = japaneseVietnamese()
  const memory = { version: 1, entries: [
    { id: "m", source: "おはよう", target: "Máy", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, page: "p1", style: "", reviewed: false, confidence: 0.6, hits: 9, createdAt: 1, updatedAt: 1 },
    { id: "r", source: "おはよう", target: "Người duyệt", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, page: "p2", style: "", reviewed: true, confidence: 1, hits: 0, createdAt: 2, updatedAt: 2 },
  ] }
  const best = lookupTranslation(memory, { text: "おはよう", scope })
  assert.equal(best.entry.id, "r")
  assert.equal(best.target ?? best.entry.target, "Người duyệt")

  // Two reviewed entries with the same text: the one from this page wins.
  const samePage = lookupTranslation({ version: 1, entries: [
    { ...memory.entries[1], id: "other", page: "p9" },
    { ...memory.entries[1], id: "here", page: "p1" },
  ] }, { text: "おはよう", scope, page: "p1" })
  assert.equal(samePage.entry.id, "here")
})

test("a near match is a suggestion, and below the threshold the provider answers", () => {
  const scope = japaneseVietnamese()
  const store = seeded([
    [{ source: "Ohayou!", target: "Chào" }, scope, { now: 1, reviewed: true }],
  ])
  const near = lookupTranslation(store.memory(), { text: "ohayou", scope })
  assert.equal(near.kind, "near")
  assert.equal(near.autoApplicable, false, "a folded match is never applied on its own")
  assert.equal(near.similarity, 0.95)

  const plan = planBoxTranslations(store.memory(), [{ id: "b1", text: "ohayou" }], { scope })
  assert.deepEqual(plan.hits, [])
  assert.equal(plan.suggestions.length, 1)
  assert.deepEqual(plan.pending.map((box) => box.id), ["b1"], "a suggestion still needs the provider")

  const none = lookupTranslation(store.memory(), { text: "まったく別の台詞です" }, { scope })
  assert.equal(none, null)
})

test("the memory is scoped by language pair and glossary version", () => {
  const scope = japaneseVietnamese("先生 = thầy")
  const store = seeded([[{ source: "おはよう", target: "Chào" }, scope, { now: 1, reviewed: true }]])
  assert.ok(lookupTranslation(store.memory(), { text: "おはよう", scope }))
  assert.equal(lookupTranslation(store.memory(), { text: "おはよう", scope: japaneseVietnamese("先生 = thầy cô") }), null)
  assert.equal(lookupTranslation(store.memory(), { text: "おはよう", scope: translationMemoryScope({ source: "Korean", target: "Vietnamese", glossary: "先生 = thầy" }) }), null)
  assert.deepEqual(translationMemorySummary(store.memory(), scope), { total: 1, reviewed: 1, machine: 0 })
})

// --- planning, applying, learning ---------------------------------------------------------------

test("a plan applies approved pairs, offers near ones and keeps the rest for the provider", () => {
  const scope = japaneseVietnamese()
  const store = seeded([
    [{ source: "おはよう", target: "Chào buổi sáng" }, scope, { now: 1, reviewed: true }],
    [{ source: "また明日!", target: "Hẹn gặp lại" }, scope, { now: 2 }],
  ])
  const boxes = [
    { id: "b1", text: "おはよう" },
    { id: "b2", text: "まったく新しい台詞" },
  ]
  const plan = planBoxTranslations(store.memory(), boxes, { scope, page: "p1" })
  assert.deepEqual(plan.hits.map((hit) => hit.boxId), ["b1"])
  assert.deepEqual(plan.pending.map((box) => box.id), ["b2"])

  assert.equal(applyTranslationMemoryMatches(plan.hits), 1)
  assert.equal(boxes[0].text, "Chào buổi sáng")
  assert.equal(store.memory().entries.find((entry) => entry.source === "おはよう").hits, 1, "reuse is counted")
})

test("accepting a suggestion records the box's own wording as reviewed", () => {
  const scope = japaneseVietnamese()
  const store = seeded([
    [{ source: "Ohayou!", target: "Chào" }, scope, { now: 1, reviewed: true }],
  ])
  const boxes = [{ id: "b1", text: "ohayou", font: "Arial", size: 21, align: "center" }]
  const plan = planBoxTranslations(store.memory(), boxes, { scope, page: "p1" })
  const accepted = store.accept(plan.suggestions, { scope, page: "p1" })
  assert.equal(accepted.length, 1)
  const learned = store.memory().entries.find((entry) => entry.source === "ohayou")
  assert.equal(learned.target, "Chào")
  assert.equal(learned.reviewed, true)
  assert.equal(learned.page, "p1")
  assert.equal(learned.style, boxStyleSignature(boxes[0]))
  // The next identical line is now an exact approved pair, so it needs no provider.
  const next = planBoxTranslations(store.memory(), [{ id: "b2", text: "ohayou" }], { scope })
  assert.deepEqual(next.hits.map((hit) => hit.boxId), ["b2"])
})

test("a machine answer never overwrites a reviewed pair", () => {
  const scope = japaneseVietnamese()
  const store = seeded([
    [{ source: "おはよう", target: "Chào buổi sáng" }, scope, { now: 5, reviewed: true }],
  ])
  store.record({ source: "おはよう", target: "Chào" }, { scope }, { now: 9 })
  const entries = store.memory().entries
  assert.equal(entries.length, 1, "the same source is one pair, not two")
  assert.equal(entries[0].target, "Chào buổi sáng")
  assert.equal(entries[0].reviewed, true)

  // A later reviewed pair for the same source does replace the text.
  store.record({ source: "おはよう", target: "Chào buổi sáng nhé" }, { scope }, { now: 10, reviewed: true })
  assert.equal(store.memory().entries[0].target, "Chào buổi sáng nhé")
  assert.equal(store.memory().entries[0].confidence, 1)
})

test("the store is bounded and reviewed pairs survive pruning", () => {
  const scope = japaneseVietnamese()
  const memory = sanitizeTranslationMemory({
    entries: [
      { id: "a", source: "aa", target: "A", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, reviewed: false, confidence: 0.6, hits: 0, createdAt: 1, updatedAt: 1 },
      { id: "b", source: "bb", target: "B", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, reviewed: true, confidence: 1, hits: 0, createdAt: 2, updatedAt: 2 },
      { id: "c", source: "cc", target: "C", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, reviewed: false, confidence: 0.6, hits: 0, createdAt: 3, updatedAt: 3 },
    ],
  })
  pruneTranslationMemory(memory, 2)
  assert.deepEqual(memory.entries.map((entry) => entry.id), ["b", "c"], "the oldest machine pair goes first")
})

// Regression for #139: every pair can be reviewed, in which case the old prune loop found nothing to
// evict, the store outgrew the manifest limit and the next save failed instead of trimming.
test("the store stays within its cap when every pair was reviewed", () => {
  const scope = japaneseVietnamese()
  const memory = {
    version: 1,
    entries: Array.from({ length: translationMemoryEntryLimit + 5 }, (_, index) => ({
      id: "e" + index, source: "s" + index, target: "t" + index,
      sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey,
      page: "", style: "", reviewed: true, confidence: 1, hits: 0, createdAt: index, updatedAt: index,
    })),
  }
  pruneTranslationMemory(memory)
  assert.equal(memory.entries.length, translationMemoryEntryLimit)
  assert.equal(memory.entries.some((entry) => entry.id === "e0"), false, "the least recently touched pair goes")
  // Writing the trimmed store is accepted; the untrimmed one is the failure the issue reported.
  assert.doesNotThrow(() => writeProject(projectWith({ version: 1, entries: memory.entries })))
})

test("recording after the cap evicts instead of growing past it", () => {
  const scope = japaneseVietnamese()
  const store = createTranslationMemoryStore({
    version: 1,
    entries: Array.from({ length: translationMemoryEntryLimit }, (_, index) => ({
      id: "e" + index, source: "s" + index, target: "t" + index,
      sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey,
      page: "", style: "", reviewed: true, confidence: 1, hits: 0, createdAt: index, updatedAt: index,
    })),
  })
  store.record({ source: "new", target: "mới" }, { scope }, { now: translationMemoryEntryLimit + 1, reviewed: true })
  assert.equal(store.size, translationMemoryEntryLimit)
  assert.equal(store.memory().entries.some((entry) => entry.source === "new"), true)
})

test("the store reports its revision so the panel knows when to recompute", () => {
  const store = createTranslationMemoryStore()
  assert.equal(store.revision, 0)
  const scope = japaneseVietnamese()
  const entry = store.record({ source: "おはよう", target: "Chào" }, { scope }, { now: 1 })
  assert.equal(store.revision, 1)
  store.record({ source: "おはよう", target: "Chào" }, { scope }, { now: 2 })
  assert.equal(store.revision, 1, "recording an unchanged pair is not a change")
  store.approve(entry.id, { now: 3 })
  assert.equal(store.revision, 2)
  store.replace({ version: 1, entries: [entry] })
  assert.equal(store.revision, 3)
  store.clear()
  assert.equal(store.size, 0)
  assert.equal(store.revision, 4)
})

test("invalid records are dropped on read and refused on save", () => {
  assert.equal(validateTranslationMemoryEntry({ id: "x" }), null)
  assert.equal(validateTranslationMemoryEntry(null), null)
  const scope = japaneseVietnamese()
  const valid = { id: "a", source: "おはよう", target: "Chào", sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: scope.glossaryKey, page: "", style: "", reviewed: true, confidence: 1, hits: 0, createdAt: 1, updatedAt: 1 }
  assert.deepEqual(validateTranslationMemoryEntry(valid), valid)
  assert.equal(validateTranslationMemoryEntry({ ...valid, reviewed: "yes" }), null)
  assert.equal(validateTranslationMemoryEntry({ ...valid, confidence: 2 }), null)
  assert.deepEqual(sanitizeTranslationMemory({ entries: [valid, { nope: true }] }).entries.length, 1)
})

// --- persistence ---------------------------------------------------------------------------------

// The manifest sits after the magic and the uint32 length, exactly where the reader looks for it.
async function manifestOf(file) {
  const headerSize = 15
  const length = new DataView(await file.slice(0, headerSize).arrayBuffer()).getUint32(11, true)
  return JSON.parse(await file.slice(headerSize, headerSize + length).text())
}

function projectWith(memory) {
  const rect = { x: .1, y: .2, w: .5, h: .3 }
  return {
    pages: [{
      file: new File([Uint8Array.of(1, 2, 3)], "trang.png"),
      name: "trang.png",
      boxes: [{ ...rect, text: "Chào", size: 24, font: "Georgia", color: "#102030", align: "left", rotation: 0, fill: true, cleanup: false }],
      unplaced: [],
    }],
    queue: [],
    settings: {
      "script-text": "", direction: "ltr", "gemini-model": "auto",
      "source-language": "Japanese", "target-language": "Vietnamese",
      "translation-notes": "", "translation-glossary": "",
    },
    currentPage: 0,
    fit: true,
    ...(memory && { translationMemory: memory }),
  }
}

test("pairs live in the project file and survive a reload", async () => {
  const scope = japaneseVietnamese()
  const store = seeded([
    [{ source: "おはよう", target: "Chào buổi sáng" }, scope, { now: 4, reviewed: true }],
    [{ source: "また明日", target: "Hẹn gặp lại" }, scope, { now: 5 }],
  ])
  const file = writeProject(projectWith(store.snapshot()))
  const opened = await readProject(file)
  assert.equal(opened.translationMemory.version, 1)
  assert.deepEqual(opened.translationMemory.entries, store.memory().entries)
  // The reopened memory answers without a provider.
  const reopened = createTranslationMemoryStore(opened.translationMemory)
  assert.equal(planBoxTranslations(reopened.memory(), [{ id: "b1", text: "おはよう" }], { scope }).hits.length, 1)
})

test("a file without pairs stays version 2 and opens with an empty memory", async () => {
  const file = writeProject(projectWith())
  const manifest = await manifestOf(file)
  assert.equal(manifest.version, 2)
  assert.equal("translationMemory" in manifest, false)
  const opened = await readProject(file)
  assert.equal(opened.translationMemory, undefined)
  assert.deepEqual(createTranslationMemoryStore(opened.translationMemory).summary(japaneseVietnamese()), { total: 0, reviewed: 0, machine: 0 })
})

test("a file that carries pairs is version 3 and old readers are the only lossy path", async () => {
  const scope = japaneseVietnamese()
  const store = seeded([[{ source: "おはよう", target: "Chào" }, scope, { now: 1, reviewed: true }]])
  const file = writeProject(projectWith(store.snapshot()))
  const manifest = await manifestOf(file)
  assert.equal(manifest.version, 3)
})

test("a project refuses a memory it cannot validate", async () => {
  const broken = { version: 1, entries: [{ id: "", source: "", target: "" }] }
  assert.throws(() => writeProject(projectWith(broken)), /Cấu trúc tệp dự án/)
  assert.throws(() => writeProject(projectWith({ version: 99, entries: [] })), /Cấu trúc tệp dự án/)
  const overflow = {
    version: 1,
    entries: Array.from({ length: translationMemoryEntryLimit + 1 }, (_, index) => ({
      id: "e" + index, source: "s" + index, target: "t" + index,
      sourceLanguage: "Japanese", targetLanguage: "Vietnamese", glossaryKey: "1c8d80e4",
      page: "", style: "", reviewed: false, confidence: 0.6, hits: 0, createdAt: 0, updatedAt: 0,
    })),
  }
  assert.throws(() => writeProject(projectWith(overflow)), /Cấu trúc tệp dự án/)
})

// --- the translation hook ------------------------------------------------------------------------
//
// The controller below is the real one, driven against a fake document and a fake provider bridge.
// Every assertion is about a request that did or did not reach the bridge, or about the memory the
// panel would show.

function fakeElement(id = "div") {
  const listeners = new Map()
  const element = {
    id,
    tagName: "DIV",
    children: [],
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    onclick: null,
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener() {},
    dispatch(type, event) { return listeners.get(type)?.(event) },
    setAttribute(name, value) { element[name] = String(value) },
    getAttribute(name) { return element[name] },
    removeAttribute(name) { delete element[name] },
    querySelectorAll() { return [] },
    querySelector() { return null },
    focus() { element.focused = true },
  }
  return element
}

function installGlobals(t, { desktop }) {
  const previous = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    Option: globalThis.Option,
    FileReader: globalThis.FileReader,
    desktop: globalThis.khungThoaiDesktop,
  }
  const elements = new Map()
  globalThis.document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, fakeElement(id))
      return elements.get(id)
    },
    createElement: (tag) => fakeElement(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.Option = class {
    constructor(text, value) { this.text = text; this.value = value }
  }
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA"
      queueMicrotask(() => this.onload())
    }
  }
  globalThis.khungThoaiDesktop = desktop
  t.after(() => {
    globalThis.document = previous.document
    globalThis.localStorage = previous.localStorage
    globalThis.Option = previous.Option
    globalThis.FileReader = previous.FileReader
    if (previous.desktop === undefined) delete globalThis.khungThoaiDesktop
    else globalThis.khungThoaiDesktop = previous.desktop
  })
  return (id) => globalThis.document.getElementById(id)
}

const geminiAnswer = (text) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ lines: [{ id: "B1", text }] }) }] } }],
})

async function createHarness(t, { source = "おはよう", answer = "Chào buổi sáng.", memory } = {}) {
  const requests = []
  const statuses = []
  const byId = installGlobals(t, {
    desktop: {
      async providerRequest(envelope) {
        requests.push(JSON.parse(JSON.stringify(envelope)))
        return { ok: true, status: 200, contentType: "json", body: JSON.stringify(geminiAnswer(answer)) }
      },
      async providerStream() {
        return { ok: false, code: "ERR_PROVIDER_POLICY", message: "This path does not stream." }
      },
      providerActivate: () => ({ ok: true, active: true }),
      providerCancel() {},
      onProviderEvent: () => () => {},
    },
  })
  byId("translation-provider").value = "gemini"
  byId("gemini-model").value = "auto"
  byId("source-language").value = "Japanese"
  byId("target-language").value = "Vietnamese"
  byId("direction").value = "ltr"
  byId("translation-glossary").value = ""
  const page = {
    id: "p1",
    name: "page-1.png",
    file: { name: "page.png", type: "image/png", size: 64 },
    boxes: [{ id: "b1", text: source, font: "Arial", size: 21, align: "center" }],
    unplaced: [],
  }
  const { setupTranslation } = await import("../src/controllers/translation.js")
  const store = createTranslationMemoryStore(memory)
  const controller = setupTranslation({
    state: { pages: [page] },
    byId,
    status: (message, error = false) => statuses.push({ message, error }),
    checkpoint() {},
    render() {},
    renderPages() {},
    renderInspector() {},
    renderCanvas() {},
    selectedPage: () => page,
    pageForScript: () => page,
    applyTranslation: () => 0,
    projectBusy: () => false,
    onSettingsChange() {},
    notify() {},
    notifyOverflowIfAny() {},
    translationMemory: store,
  })
  return {
    page, requests, statuses, store, controller, byId,
    lastStatus: () => statuses.at(-1),
  }
}

test("an exact approved pair translates the page without a provider request", async (t) => {
  const scope = japaneseVietnamese()
  const seed = seeded([[{ source: "おはよう", target: "Chào buổi sáng" }, scope, { now: 1, reviewed: true }]]).snapshot()
  const harness = await createHarness(t, { memory: seed })

  await harness.byId("translate-boxes").onclick()

  assert.equal(harness.requests.length, 0, "the provider is never asked for a pair the memory already holds")
  assert.equal(harness.page.boxes[0].text, "Chào buổi sáng")
  assert.match(harness.lastStatus().message, /bộ nhớ dịch/)
  assert.match(harness.lastStatus().message, /không gọi API/)
  assert.equal(harness.page.translationJob.state, "done")
  assert.equal(harness.page.translationJob.kind, "translate")
})

test("a machine pair is offered through the panel, not applied behind the user's back", async (t) => {
  const harness = await createHarness(t, { memory: undefined })

  await harness.byId("translate-boxes").onclick()
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.page.boxes[0].text, "Chào buổi sáng.")
  const summary = harness.store.summary(japaneseVietnamese())
  assert.deepEqual(summary, { total: 1, reviewed: 0, machine: 1 })
  assert.equal(harness.store.memory().entries[0].reviewed, false, "a provider answer starts unreviewed")

  // The same source again: an unreviewed pair may not be applied on its own, so the provider runs.
  harness.page.boxes[0].text = "おはよう"
  await harness.byId("translate-boxes").onclick()
  assert.equal(harness.requests.length, 2)

  // The pair is nevertheless offered: the panel counts it and the action is reachable.
  harness.page.boxes[0].text = "おはよう"
  harness.controller.syncMemory()
  assert.match(harness.byId("translation-memory-status").textContent, /1 cặp đã lưu \(0 cặp đã duyệt\)/)
  assert.match(harness.byId("translation-memory-status").textContent, /1 gợi ý từ bộ nhớ/)
  assert.equal(harness.byId("use-approved-translation").disabled, false)
  harness.byId("use-approved-translation").onclick()
  assert.equal(harness.requests.length, 2, "accepting is not a provider call")
  assert.equal(harness.page.boxes[0].text, "Chào buổi sáng.")
  assert.equal(harness.store.memory().entries.length, 1, "an exact suggestion approves the stored pair in place")
  assert.equal(harness.store.memory().entries[0].reviewed, true)

  // Once approved, the same line costs no request at all.
  harness.page.boxes[0].text = "おはよう"
  await harness.byId("translate-boxes").onclick()
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.page.boxes[0].text, "Chào buổi sáng.")
})

test("a near match is a suggestion the user can accept from the panel", async (t) => {
  const scope = japaneseVietnamese()
  // "Ohayou!" (reviewed) is not the box's text: only the folded key matches, so it is a suggestion.
  const seed = seeded([[{ source: "Ohayou!", target: "Chào bạn" }, scope, { now: 1, reviewed: true }]]).snapshot()
  const harness = await createHarness(t, { source: "ohayou", memory: seed })
  harness.controller.syncMemory()

  const button = harness.byId("use-approved-translation")
  assert.equal(button.disabled, false)
  assert.match(button.textContent, /Dùng bản đã duyệt \(1\)/)
  assert.match(harness.byId("translation-memory-status").textContent, /1 gợi ý từ bộ nhớ/)

  button.onclick()

  assert.equal(harness.requests.length, 0, "accepting a suggestion is not a provider call")
  assert.equal(harness.page.boxes[0].text, "Chào bạn")
  assert.match(harness.lastStatus().message, /bộ nhớ dịch/)
  const learned = harness.store.memory().entries.find((entry) => entry.source === "ohayou")
  assert.equal(learned.reviewed, true)
  assert.equal(learned.target, "Chào bạn")
  // The accepted pair is now an exact approved match for that wording.
  harness.controller.syncMemory()
  assert.equal(harness.byId("use-approved-translation").disabled, true)
})

test("the panel markup carries the count and the action", async () => {
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
  assert.match(markup, /id="translation-memory-status"[^>]*role="status"/)
  assert.match(markup, /id="use-approved-translation"[^>]*disabled[^>]*>Dùng bản đã duyệt</)
})
