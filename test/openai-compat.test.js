import assert from "node:assert/strict"
import test from "node:test"
import {
  extractJsonObject,
  translateBoxesOpenAi,
  translateImageOpenAi,
  validateEndpointUrl,
} from "../src/openai-compat.js"
import { translationSignature } from "../src/translation.js"

test("validateEndpointUrl allows HTTPS and loopback HTTP while rejecting remote insecure HTTP", () => {
  assert.equal(validateEndpointUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1")
  assert.equal(validateEndpointUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1")
  assert.equal(validateEndpointUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1")
  assert.throws(() => validateEndpointUrl("http://example.com/v1"), /HTTPS hoặc HTTP cục bộ/)
  assert.throws(() => validateEndpointUrl("not-a-url"), /không hợp lệ/)
})

test("extractJsonObject strips reasoning <think> blocks and markdown fences cleanly", () => {
  const raw = '<think>Analyzing Japanese honorifics...</think>\n```json\n{"lines":[{"id":"B1","text":"Xin chào!"}]}\n```'
  assert.deepEqual(extractJsonObject(raw), { lines: [{ id: "B1", text: "Xin chào!" }] })
  assert.throws(() => extractJsonObject("not json"), /JSON không hợp lệ/)
})

test("translateBoxesOpenAi translates existing OCR boxes with local text-only LLMs without API key", async (t) => {
  const originalFetch = globalThis.fetch
  let capturedRequest
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, headers: options.headers, body: JSON.parse(options.body) }
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '<think>ok</think>{"lines":[{"id":"B1","text":"Chào buổi sáng!"},{"id":"B2","text":"Đi thôi nào."}]}',
          },
        }],
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const boxes = [
    { id: "box-1", text: "おはよう" },
    { id: "box-2", text: "行こう" },
  ]
  const result = await translateBoxesOpenAi(boxes, {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    llmModel: "hy-mt2-manga",
    apiKey: "",
    source: "Japanese",
    target: "Vietnamese",
    notes: "Xưng hô thân mật",
    glossary: "おはよう = Chào buổi sáng",
    context: [],
  })

  assert.equal(capturedRequest.url, "http://localhost:11434/v1/chat/completions")
  assert.equal(capturedRequest.headers.Authorization, undefined)
  assert.equal(capturedRequest.body.model, "hy-mt2-manga")
  assert.deepEqual(result, [
    { id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng!" },
    { id: "B2", boxId: "box-2", source: "行こう", text: "Đi thôi nào." },
  ])
})

test("translateImageOpenAi sends image_url multimodal payload and normalizes box_2d", async (t) => {
  const originalFetch = globalThis.fetch
  const originalFileReader = globalThis.FileReader
  let capturedBody
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA"
      queueMicrotask(() => this.onload())
    }
  }
  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body)
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              lines: [{ source: "こんにちは", text: "Xin chào", box_2d: [100, 200, 300, 500] }],
            }),
          },
        }],
      }),
    }
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.FileReader = originalFileReader
  })

  const lines = await translateImageOpenAi(
    { file: { name: "01.png", type: "image/png", size: 64 } },
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      llmModel: "gpt-4o-mini",
      apiKey: "sk-test",
      source: "Japanese",
      target: "Vietnamese",
      direction: "rtl",
    },
  )
  assert.equal(capturedBody.messages[1].content[1].image_url.url, "data:image/png;base64,AAAA")
  assert.deepEqual(lines, [{ id: "B1", box: [200, 100, 500, 300], source: "こんにちは", text: "Xin chào" }])
})

test("translationSignature stays backwards-compatible for Gemini and tracks OpenAI endpoint changes", () => {
  const base = { source: "Japanese", target: "Vietnamese", notes: "", direction: "rtl", model: "auto", glossary: "" }
  assert.equal(translationSignature(base), translationSignature({ ...base, provider: "gemini" }))
  const ollama = translationSignature({ ...base, provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" })
  const lmstudio = translationSignature({ ...base, provider: "openai", baseUrl: "http://localhost:1234/v1", llmModel: "hy-mt2" })
  assert.notEqual(ollama, translationSignature(base))
  assert.notEqual(ollama, lmstudio)
})
