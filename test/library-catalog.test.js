import assert from "node:assert/strict"
import test from "node:test"

function fakeElement(tag = "div") {
  const listeners = new Map()
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners,
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    className: "",
    files: [],
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    addEventListener(type, handler) { listeners.set(type, handler) },
    setAttribute(name, value) { element[name] = String(value) },
    focus() {},
    scrollIntoView() {},
    dispatch(type, event) { return listeners.get(type)?.(event) },
  }
  element.onclick = null
  return element
}

function installDom() {
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  globalThis.document = { getElementById: byId, createElement: (tag) => fakeElement(tag) }
  globalThis.Option = class {
    constructor(text, value) {
      this.text = text
      this.value = value
    }
  }
  globalThis.location = { href: "https://example.test/index.html", origin: "https://example.test" }
  return byId
}

const catalog = {
  series: [{
    title: "Truyện A",
    chapters: [{ title: "Chương 1", pages: ["https://cdn.example.test/a/1.png"] }],
  }],
}

test("importing a catalog clears the search that hid the previous one", async () => {
  const byId = installDom()
  const { setupLibrary } = await import("../src/library.js")
  setupLibrary(async () => {})

  // The user searched the old catalogue and kept typing nothing since.
  byId("catalog-search").value = "abc"
  const file = { text: async () => JSON.stringify(catalog) }
  await byId("catalog-file").dispatch("change", { target: { files: [file], value: "" } })

  assert.equal(byId("library-status").textContent, "Đã nhập 1 truyện.")
  assert.equal(byId("catalog-search").value, "", "a filter for the old catalogue must not survive the import")
  const results = byId("catalog-results").children
  assert.equal(results.length, 1)
  assert.equal(results[0].textContent, "Truyện A")
  // The single imported series is selected, so its chapters are ready to use.
  assert.equal(byId("chapter-select").children.length, 1)
  assert.equal(byId("chapter-select").disabled, false)
  assert.equal(byId("read-chapter").disabled, false)
})

test("a search typed after the import still filters the new catalog", async () => {
  const byId = installDom()
  const { setupLibrary } = await import("../src/library.js")
  setupLibrary(async () => {})

  const file = { text: async () => JSON.stringify(catalog) }
  await byId("catalog-file").dispatch("change", { target: { files: [file], value: "" } })

  byId("catalog-search").value = "không có truyện này"
  byId("catalog-search").dispatch("input", {})
  const results = byId("catalog-results").children
  assert.equal(results.length, 1)
  assert.equal(results[0].textContent, "Không tìm thấy truyện.")
})
