import assert from "node:assert/strict"
import test from "node:test"
import { canonicalCredentialScope } from "../desktop/credential-ipc.cjs"
import {
  CREDENTIAL_SETTINGS_CODES,
  CREDENTIAL_SETTINGS_CONTRACT,
  LLM_CONFIG_STORAGE_KEY,
  canonicalCredentialEndpoint,
  createCredentialSettings,
  migrateLegacyCredentials,
  requiresCredential,
  resolveCredentialScope,
  sanitizeLlmConfigRecord,
} from "../src/credential-settings.js"

// Every secret in this file is synthetic. No network, no OS vault, no Electron: the bridge is a fake
// with the three channels desktop/preload.cjs exposes, and the storage is a Map.

const GEMINI_KEY = "AIza-synthetic-gemini-1f2e3d4c"
const OPENAI_KEY = "sk-synthetic-openai-9a8b7c6d"
const AMBIGUOUS_KEY = "sk-synthetic-ambiguous-5d6e7f"
const TAVILY_KEY = "tvly-synthetic-out-of-scope-3b4a"
const SECRETS = [GEMINI_KEY, OPENAI_KEY, AMBIGUOUS_KEY]
const OPENAI_BASE = "https://api.example.com/v1"
const SEARCH_CONFIG_KEY = "khung-thoai-search-config"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  const writes = []
  return {
    writes,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      writes.push([key, String(value)])
      map.set(key, String(value))
    },
    removeItem: (key) => map.delete(key),
    raw: (key) => (map.has(key) ? map.get(key) : null),
  }
}

function fakeVault({ status, save, remove } = {}) {
  const calls = { status: [], save: [], remove: [] }
  const api = {
    credentialStatus: async (provider, endpoint) => {
      calls.status.push([provider, endpoint])
      return status ? status(provider, endpoint) : { stored: false, supported: true, protection: "keychain", reason: null }
    },
    credentialSave: async (provider, endpoint, secret) => {
      calls.save.push([provider, endpoint, secret])
      return save ? save(provider, endpoint, secret) : { provider, stored: true }
    },
    credentialRemove: async (provider, endpoint) => {
      calls.remove.push([provider, endpoint])
      return remove ? remove(provider, endpoint) : { provider, removed: true }
    },
  }
  return { api, calls }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function assertNoSecret(value, secrets = SECRETS) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  for (const secret of secrets) assert.equal(text.includes(secret), false, "a result leaked " + secret)
}

function storedConfig(storage) {
  const raw = storage.raw(LLM_CONFIG_STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw)
}

test("the renderer canonicalizer matches the main-process credential scope", () => {
  const endpoints = [
    "https://api.openai.com/v1",
    "https://api.openai.com/v1/",
    "https://API.OpenAI.com:443/v1/",
    "https://openrouter.ai/api/v1",
    "https://api.example.com/v1//",
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
    "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1?key=abc",
    "https://api.example.com/v1#frag",
    "http://example.com/v1",
    "http://0.0.0.0:11434/v1",
    "ftp://api.example.com/v1",
    "",
    "   ",
    "not a url",
  ]
  for (const endpoint of endpoints) {
    let main = null
    try {
      main = canonicalCredentialScope("openai", endpoint ?? undefined).slice("openai:".length)
    } catch {
      main = null
    }
    assert.equal(canonicalCredentialEndpoint(endpoint), main, "canonical form differs for " + JSON.stringify(endpoint))
    assert.equal(resolveCredentialScope("openai", endpoint).ok, main !== null)
  }
  // A fixed-scope provider carries no URL in either implementation, and refuses one if it is offered.
  assert.equal(resolveCredentialScope("gemini", undefined).scopeKey, canonicalCredentialScope("gemini", undefined))
  assert.equal(resolveCredentialScope("gemini", null).ok, true)
  assert.equal(resolveCredentialScope("gemini", "https://api.openai.com/v1").ok, false)
  assert.throws(() => canonicalCredentialScope("gemini", "https://api.openai.com/v1"))
  assert.equal(resolveCredentialScope("tavily", undefined).ok, false)
})

test("the contract states write-only keys and the keyless OpenAI-compatible default", () => {
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.storageKey, "khung-thoai-llm-config")
  assert.deepEqual(CREDENTIAL_SETTINGS_CONTRACT.persistedFields, ["provider", "baseUrl", "llmModel"])
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.keyHandling.direction, "write-only")
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.keyHandling.readback, "never")
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.keyHandling.browserFallback, "session-only")
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.providers.gemini.keyRequired, true)
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.providers.openai.keyRequired, false)
  assert.equal(CREDENTIAL_SETTINGS_CONTRACT.providers.openai.endpointBound, true)
  assert.equal(requiresCredential("gemini"), true)
  assert.equal(requiresCredential("openai"), false)
  assert.equal(Object.isFrozen(CREDENTIAL_SETTINGS_CONTRACT), true)
  assert.equal(Object.isFrozen(CREDENTIAL_SETTINGS_CONTRACT.persistedFields), true)
})

test("sanitizing reports names only and keeps the three non-secret fields", () => {
  const sanitized = sanitizeLlmConfigRecord({
    provider: "openai",
    baseUrl: "  " + OPENAI_BASE + "  ",
    llmModel: " gpt-4o-mini ",
    apiKey: AMBIGUOUS_KEY,
    geminiKey: GEMINI_KEY,
    theme: "dark",
    "not an identifier": GEMINI_KEY,
  })
  assert.deepEqual(sanitized.record, { provider: "openai", baseUrl: OPENAI_BASE, llmModel: "gpt-4o-mini" })
  assert.deepEqual(sanitized.secretFields, ["apiKey", "geminiKey"])
  assert.deepEqual(sanitized.unknownFields, ["theme"])
  assert.equal(sanitized.droppedFields, 4)
  assert.equal(sanitized.changed, true)
  assertNoSecret(sanitized)
  // Nothing to drop, nothing to report, no rewrite.
  const noop = sanitizeLlmConfigRecord({ provider: "gemini", baseUrl: "", llmModel: "" })
  assert.equal(noop.changed, false)
  assert.deepEqual(noop.secretFields, [])
  assert.deepEqual(sanitizeLlmConfigRecord(null).record, {})
})

test("a current config is a migration no-op that never rewrites storage", async () => {
  const current = JSON.stringify({ provider: "openai", baseUrl: OPENAI_BASE, llmModel: "gpt-4o-mini" })
  const storage = memoryStorage({ [LLM_CONFIG_STORAGE_KEY]: current })
  const vault = fakeVault()
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_NOOP)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, false)
  assert.equal(outcome.needsReentry, false)
  assert.deepEqual(outcome.secrets, [])
  assert.equal(storage.writes.length, 0)
  assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY), current)
  assert.equal(vault.calls.status.length + vault.calls.save.length, 0)
})

test("missing, corrupt and non-object records are reported without touching storage", async () => {
  const missing = memoryStorage()
  const missingOutcome = await migrateLegacyCredentials({ storage: missing, api: fakeVault().api })
  assert.equal(missingOutcome.code, CREDENTIAL_SETTINGS_CODES.CONFIG_MISSING)
  assert.equal(missing.writes.length, 0)

  for (const raw of ["{not json", "null", "[]", "\"text\""]) {
    const storage = memoryStorage({ [LLM_CONFIG_STORAGE_KEY]: raw })
    const outcome = await migrateLegacyCredentials({ storage, api: fakeVault().api })
    assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.CONFIG_CORRUPT, raw)
    assert.equal(outcome.changed, false)
    assert.equal(storage.writes.length, 0)
    assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY), raw)
  }
})

test("a Gemini-scoped legacy key is saved to the fixed scope and erased from persistence", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiApiKey: GEMINI_KEY }),
  })
  const vault = fakeVault()
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.needsReentry, false)
  assert.equal(outcome.changed, true)
  assert.equal(outcome.persisted, true)
  assert.deepEqual(vault.calls.save, [["gemini", undefined, GEMINI_KEY]])
  assert.deepEqual(outcome.secrets, [
    { field: "geminiApiKey", provider: "gemini", scopeKey: "gemini:fixed", outcome: "migrated", needsReentry: false },
  ])
  assert.deepEqual(storedConfig(storage), { provider: "gemini", baseUrl: "", llmModel: "" })
  assertNoSecret(outcome)
  assertNoSecret(storage.raw(LLM_CONFIG_STORAGE_KEY))
  assertNoSecret(storage.writes)
  // A second startup has nothing left to do.
  const again = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(again.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_NOOP)
  assert.equal(vault.calls.save.length, 1)
})

test("an OpenAI-compatible key is bound to the base URL recorded beside it", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "openai", baseUrl: OPENAI_BASE + "/", llmModel: "gpt-4o-mini", openaiApiKey: OPENAI_KEY }),
  })
  const vault = fakeVault()
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED)
  assert.deepEqual(vault.calls.save, [["openai", OPENAI_BASE, OPENAI_KEY]])
  assert.equal(outcome.secrets[0].scopeKey, "openai:" + OPENAI_BASE)
  // The key is bound to the canonical endpoint, while the non-secret field keeps exactly what the
  // current writer stored (only whitespace is trimmed), so the settings screen is unchanged.
  assert.deepEqual(storedConfig(storage), { provider: "openai", baseUrl: OPENAI_BASE + "/", llmModel: "gpt-4o-mini" })
  assertNoSecret(outcome)
})

test("ambiguous or unprovable keys are erased, never guessed into a scope", async () => {
  const cases = [
    { label: "ambiguous field", record: { provider: "openai", baseUrl: OPENAI_BASE, llmModel: "", apiKey: AMBIGUOUS_KEY } },
    { label: "legacy llmKey but provider is gemini", record: { provider: "gemini", baseUrl: OPENAI_BASE, llmModel: "", llmKey: OPENAI_KEY } },
    { label: "openai field without a base URL", record: { provider: "openai", baseUrl: "", llmModel: "", openaiKey: OPENAI_KEY } },
    { label: "openai field with a non-loopback http base URL", record: { provider: "openai", baseUrl: "http://api.example.com/v1", llmModel: "", openaiKey: OPENAI_KEY } },
    { label: "provider missing", record: { baseUrl: OPENAI_BASE, llmModel: "", openaiApiKey: OPENAI_KEY } },
  ]
  for (const { label, record } of cases) {
    const storage = memoryStorage({ [LLM_CONFIG_STORAGE_KEY]: JSON.stringify(record) })
    const vault = fakeVault()
    const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
    assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY, label)
    assert.equal(outcome.needsReentry, true, label)
    assert.equal(vault.calls.save.length, 0, label)
    assert.equal(outcome.secrets.length, 1, label)
    assert.equal(outcome.secrets[0].outcome, "unscoped", label)
    assert.equal(outcome.secrets[0].scopeKey, null, label)
    const preserved = { baseUrl: record.baseUrl, llmModel: record.llmModel }
    assert.deepEqual(storedConfig(storage), record.provider === undefined ? preserved : { provider: record.provider, ...preserved }, label)
    assertNoSecret(outcome)
    assertNoSecret(storage.raw(LLM_CONFIG_STORAGE_KEY))
  }
})

test("an existing vault secret is never overwritten and needs no re-entry", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
  })
  const vault = fakeVault({ status: () => ({ stored: true, supported: true, protection: "keychain", reason: null }) })
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(vault.calls.save.length, 0)
  assert.equal(outcome.secrets[0].outcome, "already-stored")
  assert.equal(outcome.needsReentry, false)
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED)
  assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), false)
})

test("migration writes only the first usable legacy key per vault scope", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", geminiKey: GEMINI_KEY, geminiApiKey: AMBIGUOUS_KEY }),
  })
  const vault = fakeVault()

  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })

  assert.deepEqual(vault.calls.status, [["gemini", undefined]])
  assert.deepEqual(vault.calls.save, [["gemini", undefined, GEMINI_KEY]])
  assert.deepEqual(outcome.secrets.map(({ outcome }) => outcome), ["migrated", "already-stored"])
  // The second value is a different key for the scope this run already filled, so it is dropped with a
  // re-entry prompt instead of a success message.
  assert.equal(outcome.secrets[1].needsReentry, true)
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY)
  assert.deepEqual(storedConfig(storage), { provider: "gemini" })
  assertNoSecret(outcome)
})

test("a vault that is not open yet keeps the plaintext key for the next launch", async () => {
  for (const reason of ["unavailable", "api-unavailable"]) {
    const storage = memoryStorage({
      [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
    })
    const vault = fakeVault({ status: () => ({ stored: false, supported: false, protection: null, reason }) })
    const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
    assert.equal(outcome.secrets[0].outcome, "vault-unavailable", reason)
    assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED)
    assert.equal(outcome.needsReentry, false)
    assert.equal(outcome.persisted, false)
    assert.equal(vault.calls.save.length, 0)
    // Nothing was erased: a transient lock must not cost the user the only copy of the key.
    assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), true)
    assertNoSecret(outcome)
  }
})

// Regression for #135: a mixed outcome (one key waiting for the vault, one field that can never be
// scoped) used to skip the per-secret deferral and overwrite the record, deleting the only copy of a
// key the user could still use once the vault opens.
test("a locked vault keeps the usable key while the ambiguous field still leaves", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", geminiKey: GEMINI_KEY, apiKey: AMBIGUOUS_KEY }),
  })
  const vault = fakeVault({ status: () => ({ stored: false, supported: false, protection: null, reason: "unavailable" }) })
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })

  assert.deepEqual(outcome.secrets.map(({ outcome: kind }) => kind), ["vault-unavailable", "unscoped"])
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED)
  assert.deepEqual(outcome.deferredFields, ["geminiKey"])
  assert.equal(outcome.persisted, true, "the ambiguous field is cleaned while the key is kept")
  assert.equal(vault.calls.save.length, 0)
  const stored = storedConfig(storage)
  assert.equal(stored.geminiKey, GEMINI_KEY, "the only copy of the key survives the locked vault")
  assert.equal("apiKey" in stored, false)
  assert.deepEqual(stored, { provider: "gemini", geminiKey: GEMINI_KEY })
  assertNoSecret(outcome)
})

test("a browser without a vault keeps the legacy record untouched too", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
  })
  const outcome = await migrateLegacyCredentials({ storage, api: null })
  assert.equal(outcome.secrets[0].outcome, "no-vault")
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED)
  assert.equal(outcome.needsReentry, false)
  assert.equal(outcome.persisted, false)
  assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), true)
})

test("a permanently unsupported vault erases plaintext and asks for the key again", async () => {
  const scenarios = [
    { reason: "unsupported-provider", outcome: "vault-unsupported", code: CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY },
    { reason: "probe-failed", outcome: "vault-unsupported", code: CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY },
  ]
  for (const scenario of scenarios) {
    const storage = memoryStorage({
      [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
    })
    const vault = fakeVault({ status: () => ({ stored: false, supported: false, protection: null, reason: scenario.reason }) })
    const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
    assert.equal(outcome.secrets[0].outcome, scenario.outcome, scenario.reason)
    assert.equal(outcome.code, scenario.code)
    assert.equal(outcome.needsReentry, true)
    assert.equal(vault.calls.save.length, 0)
    assert.equal(outcome.vault.supported, false)
    assert.equal(outcome.vault.reason, scenario.reason)
    assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), false)
  }
})

test("a failing save is attempted once, then erased and reported as needing re-entry", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
  })
  const vault = fakeVault({ save: () => { throw new Error("native cryptography failure at /home/user/vault") } })
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(vault.calls.save.length, 1)
  assert.equal(outcome.secrets[0].outcome, "rejected")
  assert.equal(outcome.needsReentry, true)
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY)
  // Main's error text is not repeated into a result.
  assert.equal(JSON.stringify(outcome).includes("/home/user/vault"), false)
  assert.equal(JSON.stringify(outcome).includes("native cryptography"), false)
  assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), false)
})

test("a status call that throws fails closed: no save, plaintext erased", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
  })
  const vault = fakeVault({ status: () => { throw new Error("ipc exploded") } })
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(vault.calls.save.length, 0)
  assert.equal(outcome.secrets[0].outcome, "rejected")
  assert.equal(outcome.needsReentry, true)
  assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), false)
})

test("a browser without a vault keeps the plaintext record instead of deleting it", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
  })
  const outcome = await migrateLegacyCredentials({ storage, api: null })
  assert.equal(outcome.secrets[0].outcome, "no-vault")
  // There is no vault to move the key to and the settings screen hides saving in a browser, so erasing
  // it would leave the user with no key and no way to keep one between sessions.
  assert.equal(outcome.needsReentry, false)
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED)
  assert.deepEqual(outcome.vault, { available: false, supported: false, reason: "no-desktop-vault" })
  assert.equal(storage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), true)
})

test("unknown fields leave storage, are named back, and unrelated settings are untouched", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", theme: "dark", retries: 3 }),
    [SEARCH_CONFIG_KEY]: JSON.stringify({ provider: "tavily", searchUrl: "", searchApiKey: TAVILY_KEY }),
  })
  const vault = fakeVault()
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_CLEANED)
  assert.deepEqual(outcome.unknownFields, ["theme", "retries"])
  assert.deepEqual(outcome.secrets, [])
  assert.equal(outcome.needsReentry, false)
  assert.deepEqual(storedConfig(storage), { provider: "gemini", baseUrl: "", llmModel: "" })
  // #60 is about Gemini/OpenAI: the search config, and its Tavily key, are not read or rewritten.
  assert.equal(storage.writes.length, 1)
  assert.equal(storage.writes[0][0], LLM_CONFIG_STORAGE_KEY)
  assert.equal(storage.raw(SEARCH_CONFIG_KEY).includes(TAVILY_KEY), true)
  assert.equal(vault.calls.status.length + vault.calls.save.length, 0)
})

test("empty and unrecognized legacy key values are dropped without a pointless save", async () => {
  const storage = memoryStorage({
    [LLM_CONFIG_STORAGE_KEY]: JSON.stringify({
      provider: "gemini",
      baseUrl: "",
      llmModel: "",
      geminiKey: "   ",
      apiKey: { nested: GEMINI_KEY },
      openaiKey: OPENAI_KEY + "\n",
    }),
  })
  const vault = fakeVault()
  const outcome = await migrateLegacyCredentials({ storage, api: vault.api })
  assert.equal(vault.calls.save.length, 0)
  const byField = Object.fromEntries(outcome.secrets.map((secret) => [secret.field, secret]))
  assert.equal(byField.geminiKey.outcome, "empty")
  assert.equal(byField.geminiKey.needsReentry, false)
  assert.equal(byField.apiKey.outcome, "unrecognized")
  assert.equal(byField.apiKey.needsReentry, true)
  assert.equal(byField.openaiKey.outcome, "unrecognized")
  assert.equal(outcome.needsReentry, true)
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY)
  assert.deepEqual(storedConfig(storage), { provider: "gemini", baseUrl: "", llmModel: "" })
  assertNoSecret(outcome)
  assertNoSecret(storage.raw(LLM_CONFIG_STORAGE_KEY))
})

test("blocked storage is reported and never thrown", async () => {
  const readBlocked = {
    getItem: () => { throw new Error("SecurityError") },
    setItem: () => {},
  }
  const readOutcome = await migrateLegacyCredentials({ storage: readBlocked, api: fakeVault().api })
  assert.equal(readOutcome.code, CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE)
  assert.equal(readOutcome.changed, false)

  const blocked = {
    getItem: () => null,
    setItem: () => {},
  }
  assert.equal((await migrateLegacyCredentials({ storage: blocked, api: null })).code, CREDENTIAL_SETTINGS_CODES.CONFIG_MISSING)
  assert.equal((await migrateLegacyCredentials({ storage: null, api: null })).code, CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE)

  const writeBlocked = {
    getItem: () => JSON.stringify({ provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }),
    setItem: () => { throw new Error("QuotaExceededError") },
  }
  const writeOutcome = await migrateLegacyCredentials({ storage: writeBlocked, api: fakeVault().api })
  assert.equal(writeOutcome.code, CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE)
  assert.equal(writeOutcome.persisted, false)
  assert.equal(writeOutcome.needsReentry, true)
  // The vault copy still happened, so the user's key is not lost even though the erase failed.
  assert.equal(writeOutcome.secrets[0].outcome, "migrated")
})

test("settings scope changes reject an invalid base URL before any vault call", () => {
  const vault = fakeVault()
  const settings = createCredentialSettings({ api: vault.api })
  const invalid = settings.setScope("openai", "http://api.example.com/v1")
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE)
  assert.equal(settings.getScope(), null)
  assert.equal(settings.available, true)

  const scoped = settings.setScope("openai", OPENAI_BASE + "/")
  assert.equal(scoped.ok, true)
  assert.deepEqual(settings.getScope(), { provider: "openai", endpoint: OPENAI_BASE, scopeKey: "openai:" + OPENAI_BASE })
  assert.equal(settings.setScope("gemini", OPENAI_BASE).ok, false)
  assert.equal(settings.getScope(), null)
})

test("status, save and remove run through the vault and never echo the key", async () => {
  const vault = fakeVault()
  const seen = []
  const settings = createCredentialSettings({ api: vault.api, onChange: (value) => seen.push(value) })
  settings.setScope("openai", OPENAI_BASE)

  const status = await settings.refresh()
  assert.equal(status.code, CREDENTIAL_SETTINGS_CODES.STATUS_READY)
  assert.equal(status.supported, true)
  assert.equal(status.protection, "keychain")
  assert.equal(status.stored, false)

  const saved = await settings.save(OPENAI_KEY)
  assert.equal(saved.code, CREDENTIAL_SETTINGS_CODES.SAVED)
  assert.equal(saved.persisted, true)
  assert.deepEqual(vault.calls.save, [["openai", OPENAI_BASE, OPENAI_KEY]])
  assert.equal(settings.getStatus().stored, true)

  // Nothing remembered the key: an empty save still asks the caller instead of resending it.
  const empty = await settings.save("")
  assert.equal(empty.code, CREDENTIAL_SETTINGS_CODES.KEYLESS)
  assert.equal(vault.calls.save.length, 1)

  const removed = await settings.remove()
  assert.equal(removed.code, CREDENTIAL_SETTINGS_CODES.REMOVED)
  assert.equal(removed.removed, true)
  assert.equal(settings.getStatus().stored, false)
  assert.deepEqual(vault.calls.remove, [["openai", OPENAI_BASE]])
  assert.equal(seen.length, 4)
  assertNoSecret(seen)
  assertNoSecret(status)
})

test("Gemini requires a key, OpenAI-compatible endpoints and local servers do not", async () => {
  const vault = fakeVault()
  const gemini = createCredentialSettings({ api: vault.api })
  gemini.setScope("gemini", undefined)
  const missing = await gemini.save("")
  assert.equal(missing.ok, false)
  assert.equal(missing.code, CREDENTIAL_SETTINGS_CODES.KEY_REQUIRED)
  const blank = await gemini.save("   ")
  assert.equal(blank.code, CREDENTIAL_SETTINGS_CODES.INVALID_SECRET)
  const control = await gemini.save("AIza-key\n")
  assert.equal(control.code, CREDENTIAL_SETTINGS_CODES.INVALID_SECRET)
  assert.equal(vault.calls.save.length, 0)
  // A real key still works afterwards.
  assert.equal((await gemini.save(GEMINI_KEY)).code, CREDENTIAL_SETTINGS_CODES.SAVED)

  const openai = createCredentialSettings({ api: vault.api })
  openai.setScope("openai", "http://localhost:11434/v1")
  const keyless = await openai.save("")
  assert.equal(keyless.ok, true)
  assert.equal(keyless.code, CREDENTIAL_SETTINGS_CODES.KEYLESS)
  assert.equal(keyless.persisted, false)
  assert.equal(vault.calls.save.length, 1)
})

test("a save failure is classified from the vault, not from main's error text", async () => {
  const unavailable = fakeVault({
    status: () => ({ stored: false, supported: false, protection: null, reason: "unavailable" }),
    save: () => { throw new Error("ERR_CREDENTIAL_UNAVAILABLE at /secret/path") },
  })
  const first = createCredentialSettings({ api: unavailable.api })
  first.setScope("gemini", undefined)
  const locked = await first.save(GEMINI_KEY)
  assert.equal(locked.code, CREDENTIAL_SETTINGS_CODES.VAULT_UNAVAILABLE)
  assert.equal(locked.persisted, false)
  assert.equal(JSON.stringify(locked).includes("/secret/path"), false)

  const unsupported = fakeVault({
    status: () => ({ stored: false, supported: false, protection: null, reason: "unsupported-provider" }),
    save: () => { throw new Error("nope") },
  })
  const second = createCredentialSettings({ api: unsupported.api })
  second.setScope("gemini", undefined)
  assert.equal((await second.save(GEMINI_KEY)).code, CREDENTIAL_SETTINGS_CODES.VAULT_UNSUPPORTED)

  const rejected = fakeVault({ status: () => ({ stored: false, supported: true, protection: "dpapi", reason: null }), save: () => { throw new Error("disk full") } })
  const third = createCredentialSettings({ api: rejected.api })
  third.setScope("gemini", undefined)
  assert.equal((await third.save(GEMINI_KEY)).code, CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED)

  const removeFails = fakeVault({ remove: () => { throw new Error("io") } })
  const fourth = createCredentialSettings({ api: removeFails.api })
  fourth.setScope("gemini", undefined)
  const removal = await fourth.remove()
  assert.equal(removal.code, CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED)
  assert.equal(removal.removed, false)
})

test("a status that resolves after a provider or endpoint switch is suppressed", async () => {
  const pending = deferred()
  const vault = fakeVault({ status: () => pending.promise })
  const seen = []
  const settings = createCredentialSettings({ api: vault.api, onChange: (value) => seen.push(value) })
  settings.setScope("gemini", undefined)

  const inFlight = settings.refresh()
  settings.setScope("openai", OPENAI_BASE)
  pending.resolve({ stored: true, supported: true, protection: "keychain", reason: null })

  const stale = await inFlight
  assert.equal(stale.code, CREDENTIAL_SETTINGS_CODES.STATUS_STALE)
  assert.equal(stale.ok, false)
  assert.equal(stale.superseded, true)
  assert.equal(stale.scopeKey, "gemini:fixed")
  // The result never reached the callback, so the screen cannot show the old scope's state.
  assert.equal(seen.length, 0)
  assert.equal(settings.getStatus(), null)

  const fresh = await settings.refresh()
  assert.equal(fresh.code, CREDENTIAL_SETTINGS_CODES.STATUS_READY)
  assert.equal(fresh.scopeKey, "openai:" + OPENAI_BASE)
})

test("a save or remove that lands after a switch reports what happened without rendering it", async () => {
  const saved = deferred()
  const vault = fakeVault({ save: () => saved.promise })
  const seen = []
  const settings = createCredentialSettings({ api: vault.api, onChange: (value) => seen.push(value) })
  settings.setScope("gemini", undefined)
  const inFlight = settings.save(GEMINI_KEY)
  settings.setScope("openai", OPENAI_BASE)
  saved.resolve({ provider: "gemini", stored: true })

  const result = await inFlight
  assert.equal(result.code, CREDENTIAL_SETTINGS_CODES.STATUS_STALE)
  assert.equal(result.superseded, true)
  // The write did happen in main, and the caller is told so.
  assert.equal(result.persisted, true)
  assert.equal(seen.length, 0)
  assert.equal(settings.getStatus(), null)
  assertNoSecret(result)

  const removalPending = deferred()
  const failing = fakeVault({ remove: () => removalPending.promise })
  const second = createCredentialSettings({ api: failing.api, onChange: (value) => seen.push(value) })
  second.setScope("gemini", undefined)
  const removal = second.remove()
  second.setScope("gemini", undefined)
  removalPending.resolve({ provider: "gemini", removed: true })
  const outcome = await removal
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.STATUS_STALE)
  assert.equal(outcome.removed, true)
  assert.equal(seen.length, 0)
})

test("a browser controller reports no vault and keeps the key out of storage", async () => {
  const seen = []
  const settings = createCredentialSettings({ api: null, onChange: (value) => seen.push(value) })
  assert.equal(settings.available, false)

  assert.equal((await settings.refresh()).code, CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE)
  settings.setScope("gemini", undefined)
  const status = await settings.refresh()
  assert.equal(status.code, CREDENTIAL_SETTINGS_CODES.NO_VAULT)
  assert.equal(status.supported, false)
  assert.equal(status.stored, false)

  const saved = await settings.save(GEMINI_KEY)
  assert.equal(saved.ok, true)
  assert.equal(saved.code, CREDENTIAL_SETTINGS_CODES.NO_VAULT)
  assert.equal(saved.persisted, false)
  assert.equal(saved.ephemeral, true)
  assert.equal(settings.getStatus(), null)

  const removed = await settings.remove()
  assert.equal(removed.ok, false)
  assert.equal(removed.code, CREDENTIAL_SETTINGS_CODES.NO_VAULT)
  assert.equal(removed.removed, false)
  assertNoSecret(seen)
})

test("the preload surface is discovered by default, and a partial one is treated as a browser", async (t) => {
  t.after(() => { delete globalThis.khungThoaiDesktop })
  const vault = fakeVault()
  globalThis.khungThoaiDesktop = vault.api

  const settings = createCredentialSettings()
  assert.equal(settings.available, true)
  settings.setScope("gemini", undefined)
  assert.equal((await settings.save(GEMINI_KEY)).code, CREDENTIAL_SETTINGS_CODES.SAVED)
  assert.deepEqual(vault.calls.save, [["gemini", undefined, GEMINI_KEY]])

  const legacy = { provider: "gemini", baseUrl: "", llmModel: "", geminiKey: GEMINI_KEY }
  const storage = memoryStorage({ [LLM_CONFIG_STORAGE_KEY]: JSON.stringify(legacy) })
  assert.equal((await migrateLegacyCredentials({ storage })).code, CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED)
  assert.equal(vault.calls.save.length, 2)

  // A document with only some of the three channels is not a vault.
  globalThis.khungThoaiDesktop = { credentialStatus: async () => ({ stored: true, supported: true, protection: "kb" }) }
  assert.equal(createCredentialSettings().available, false)
  const partialStorage = memoryStorage({ [LLM_CONFIG_STORAGE_KEY]: JSON.stringify(legacy) })
  const outcome = await migrateLegacyCredentials({ storage: partialStorage })
  assert.equal(outcome.secrets[0].outcome, "no-vault")
  assert.equal(outcome.code, CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED)
  assert.equal(partialStorage.raw(LLM_CONFIG_STORAGE_KEY).includes(GEMINI_KEY), true)
})

test("a scope-less or failing status is refused instead of being shown", async () => {
  const failing = fakeVault({ status: () => { throw new Error("ipc exploded") } })
  const settings = createCredentialSettings({ api: failing.api })
  assert.equal((await settings.refresh()).code, CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE)
  assert.equal((await settings.save(GEMINI_KEY)).code, CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE)
  assert.equal((await settings.remove()).code, CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE)
  assert.equal(failing.calls.status.length + failing.calls.save.length + failing.calls.remove.length, 0)

  settings.setScope("gemini", undefined)
  const failed = await settings.refresh()
  assert.equal(failed.code, CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED)
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, "status-failed")
  assert.equal(settings.getStatus(), null)
  assert.equal(JSON.stringify(failed).includes("ipc exploded"), false)

  const locked = createCredentialSettings({
    api: fakeVault({ status: () => ({ stored: false, supported: false, protection: null, reason: "unavailable" }) }).api,
  })
  locked.setScope("gemini", undefined)
  const lockedStatus = await locked.refresh()
  assert.equal(lockedStatus.code, CREDENTIAL_SETTINGS_CODES.VAULT_UNAVAILABLE)
  assert.equal(lockedStatus.supported, false)
  assert.equal(lockedStatus.stored, false)
})
