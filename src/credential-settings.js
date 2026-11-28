// Renderer-side API-key settings and legacy migration for desktop Gemini/OpenAI-compatible keys
// (Nixio #60, stage 1.5e).
//
// This module is the settings logic and the contract, not the DOM and not the provider calls. It
// answers three questions and nothing else:
//
//   1. Which vault scope do the settings on screen describe? (`resolveCredentialScope`)
//   2. What has to be sanitized out of the legacy LLM config, and can any of it still be saved?
//      (`sanitizeLlmConfigRecord`, `migrateLegacyCredentials`)
//   3. What does the status/save/remove cycle look like, including answers that arrive after the user
//      already switched provider or endpoint? (`createCredentialSettings`)
//
// Two invariants hold for every export here:
//   * A key is never kept in module state, returned in a result, logged, retried or written to
//     renderer storage. The only destination for a key is the write-only `credential-save` channel,
//     and the local that carried it is released when the call returns.
//   * A key is bound only to a scope this module can prove from recorded evidence, never to whatever
//     the settings screen happens to show at migration time. `gemini` has exactly one fixed scope; an
//     OpenAI-compatible key needs a base URL recorded beside it in the same legacy record.
//
// `desktop/credential-ipc.cjs` derives the handle in main from the same provider/endpoint pair, so
// the canonicalization below is a mirror of `canonicalCredentialScope` there. A test keeps the two
// equal; the renderer copy exists so the settings screen can tell "same scope" from "different scope"
// before it renders a status, not so it can compute a handle.

export const LLM_CONFIG_STORAGE_KEY = "khung-thoai-llm-config"

// The three fields the current controller writes (`src/controllers/translation.js`). Everything else
// in the record is either a legacy secret or data no reader in this app consumes.
const PERSISTED_FIELDS = Object.freeze(["provider", "baseUrl", "llmModel"])
// Field names that name their provider, so the scope is provable from the name alone.
const GEMINI_SECRET_FIELDS = Object.freeze(["geminiKey", "geminiApiKey"])
const OPENAI_SECRET_FIELDS = Object.freeze(["openaiKey", "openaiApiKey", "llmKey"])
// Names that could be either provider. They are still erased from persistence, but never guessed into
// a vault scope: a stale record that kept the last used provider cannot prove which key is inside.
const AMBIGUOUS_SECRET_FIELDS = Object.freeze(["apiKey", "key", "token", "secret"])
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_ENDPOINT_LENGTH = 2048
// Kept equal to `LOOPBACK_HOSTS` in desktop/credential-ipc.cjs; `URL` keeps the brackets around an
// IPv6 host, so "[::1]" is the spelling that reaches this set.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
// Same split the credential store makes in `assertProtected`: these two reasons mean the OS vault is
// not open yet, every other reason means this runtime cannot prove OS protection at all.
const UNAVAILABLE_REASONS = new Set(["unavailable", "api-unavailable"])

export const CREDENTIAL_SETTINGS_CODES = Object.freeze({
  // Scope and settings lifecycle
  SCOPE_SET: "SCOPE_SET",
  INVALID_SCOPE: "INVALID_SCOPE",
  KEY_REQUIRED: "KEY_REQUIRED",
  INVALID_SECRET: "INVALID_SECRET",
  KEYLESS: "KEYLESS",
  // Vault channels
  NO_VAULT: "NO_VAULT",
  STATUS_READY: "STATUS_READY",
  STATUS_STALE: "STATUS_STALE",
  SAVED: "SAVED",
  REMOVED: "REMOVED",
  VAULT_UNAVAILABLE: "VAULT_UNAVAILABLE",
  VAULT_UNSUPPORTED: "VAULT_UNSUPPORTED",
  VAULT_REJECTED: "VAULT_REJECTED",
  // Legacy config
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  CONFIG_MISSING: "CONFIG_MISSING",
  CONFIG_CORRUPT: "CONFIG_CORRUPT",
  MIGRATION_NOOP: "MIGRATION_NOOP",
  MIGRATION_CLEANED: "MIGRATION_CLEANED",
  MIGRATION_APPLIED: "MIGRATION_APPLIED",
  MIGRATION_REENTRY: "MIGRATION_REENTRY",
  // Nothing was erased: the vault is not open yet, or this runtime has no vault at all, and the only
  // copy of the key is the legacy record.
  MIGRATION_DEFERRED: "MIGRATION_DEFERRED",
})

// Fixed strings only. Nothing here interpolates a key, a scope URL, a native error or a stack, so a
// result is safe to put straight into a status line or a toast.
export const CREDENTIAL_SETTINGS_MESSAGES = Object.freeze({
  [CREDENTIAL_SETTINGS_CODES.SCOPE_SET]: "Đã xác định phạm vi khóa API cho cấu hình hiện tại.",
  [CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE]: "Base URL chưa gắn được khóa API: chỉ dùng HTTPS, hoặc HTTP với localhost, và không kèm tham số truy vấn.",
  [CREDENTIAL_SETTINGS_CODES.KEY_REQUIRED]: "Hãy nhập khóa API Gemini.",
  [CREDENTIAL_SETTINGS_CODES.INVALID_SECRET]: "Khóa API phải là chuỗi khác rỗng, không có khoảng trắng ở hai đầu và không có ký tự điều khiển.",
  [CREDENTIAL_SETTINGS_CODES.KEYLESS]: "Không có khóa mới để lưu: endpoint này vẫn dùng được mà không cần khóa (ví dụ máy chủ cục bộ).",
  [CREDENTIAL_SETTINGS_CODES.NO_VAULT]: "Bản chạy trên trình duyệt không có kho khóa bảo mật: khóa chỉ nằm trong phiên làm việc này và mất khi tải lại trang.",
  [CREDENTIAL_SETTINGS_CODES.STATUS_READY]: "Đã kiểm tra kho khóa bảo mật của hệ điều hành.",
  [CREDENTIAL_SETTINGS_CODES.STATUS_STALE]: "Đã bỏ qua kết quả cũ vì bạn vừa đổi nhà cung cấp hoặc Base URL.",
  [CREDENTIAL_SETTINGS_CODES.SAVED]: "Đã lưu khóa API vào kho bảo mật của hệ điều hành.",
  [CREDENTIAL_SETTINGS_CODES.REMOVED]: "Đã xóa khóa API khỏi kho bảo mật của hệ điều hành.",
  [CREDENTIAL_SETTINGS_CODES.VAULT_UNAVAILABLE]: "Kho khóa bảo mật của hệ điều hành chưa mở. Khóa chưa được lưu — hãy mở khóa kho rồi nhập lại khóa.",
  [CREDENTIAL_SETTINGS_CODES.VAULT_UNSUPPORTED]: "Hệ điều hành chưa chứng minh được khóa API sẽ được bảo vệ nên Nixio từ chối lưu khóa. Hãy nhập lại khóa khi kho bảo mật đã sẵn sàng.",
  [CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED]: "Không lưu được khóa API vào kho bảo mật. Hãy thử lại hoặc nhập lại khóa.",
  [CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE]: "Trình duyệt chặn bộ nhớ cục bộ nên chưa xử lý được cấu hình AI cũ; hãy nhập lại khóa trong phần cài đặt AI.",
  [CREDENTIAL_SETTINGS_CODES.CONFIG_MISSING]: "Chưa có cấu hình AI nào được lưu nên không có khóa cũ cần chuyển.",
  [CREDENTIAL_SETTINGS_CODES.CONFIG_CORRUPT]: "Cấu hình AI đã lưu bị hỏng nên chưa kiểm tra được khóa cũ. Hãy nhập lại khóa trong phần cài đặt AI.",
  [CREDENTIAL_SETTINGS_CODES.MIGRATION_NOOP]: "Cấu hình AI đã lưu không chứa khóa dạng văn bản thuần.",
  [CREDENTIAL_SETTINGS_CODES.MIGRATION_CLEANED]: "Đã xóa khóa và trường lạ khỏi cấu hình AI đã lưu; không có khóa nào dùng được để chuyển.",
  [CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED]: "Đã chuyển khóa API cũ vào kho bảo mật và xóa khỏi bộ nhớ trình duyệt.",
  [CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY]: "Đã xóa khóa API cũ khỏi bộ nhớ trình duyệt nhưng chưa chuyển được vào kho bảo mật. Hãy nhập lại khóa để dùng tính năng AI.",
  [CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED]: "Kho khóa bảo mật của hệ điều hành chưa mở nên khóa API cũ vẫn được giữ nguyên trong cấu hình. Lần khởi động sau Nixio sẽ thử chuyển lại.",
})

// The parts of the contract the next stage has to satisfy. Data, not behaviour, so the DOM wiring and
// the chat/translation callers agree on one description.
export const CREDENTIAL_SETTINGS_CONTRACT = Object.freeze({
  storageKey: LLM_CONFIG_STORAGE_KEY,
  persistedFields: PERSISTED_FIELDS,
  secretFields: Object.freeze({
    gemini: GEMINI_SECRET_FIELDS,
    openai: OPENAI_SECRET_FIELDS,
    ambiguous: AMBIGUOUS_SECRET_FIELDS,
  }),
  providers: Object.freeze({
    // `gemini` talks to one baked-in endpoint, so its key has no endpoint scope and is always needed.
    gemini: Object.freeze({ endpointBound: false, keyRequired: true }),
    // An OpenAI-compatible endpoint may be a local server, so an empty key stays valid and no
    // Authorization header is sent — the behaviour `#llm-key` already documents.
    openai: Object.freeze({ endpointBound: true, keyRequired: false }),
  }),
  bridge: Object.freeze({ status: "credentialStatus", save: "credentialSave", remove: "credentialRemove" }),
  keyHandling: Object.freeze({
    direction: "write-only",
    readback: "never",
    persistence: "vault-only",
    retries: "none",
    browserFallback: "session-only",
  }),
})

const FAILURE_CODES = new Set([
  CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE,
  CREDENTIAL_SETTINGS_CODES.KEY_REQUIRED,
  CREDENTIAL_SETTINGS_CODES.INVALID_SECRET,
  CREDENTIAL_SETTINGS_CODES.STATUS_STALE,
  CREDENTIAL_SETTINGS_CODES.VAULT_UNAVAILABLE,
  CREDENTIAL_SETTINGS_CODES.VAULT_UNSUPPORTED,
  CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED,
  CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE,
  CREDENTIAL_SETTINGS_CODES.CONFIG_CORRUPT,
])

function result(code, extra = {}) {
  return { ok: extra.ok ?? !FAILURE_CODES.has(code), code, message: CREDENTIAL_SETTINGS_MESSAGES[code], ...extra }
}

// The preload exposes the three channels together, so a document without all three is a browser page,
// not a desktop shell that can hold a key.
function desktopCredentialApi() {
  const api = globalThis.khungThoaiDesktop
  const usable = api && typeof api.credentialStatus === "function" &&
    typeof api.credentialSave === "function" && typeof api.credentialRemove === "function"
  return usable ? api : null
}

export function requiresCredential(provider) {
  return provider === "gemini"
}

// Canonical form of the endpoint a key is bound to. Mirrors `canonicalEndpoint` in
// desktop/credential-ipc.cjs: userinfo, query and fragment never identify an endpoint (a query could
// smuggle a key into a scope), plain HTTP is only accepted for a loopback host, and the default port
// plus trailing slashes are dropped.
export function canonicalCredentialEndpoint(rawEndpoint) {
  if (typeof rawEndpoint !== "string") return null
  const trimmed = rawEndpoint.trim()
  if (!trimmed || trimmed.length > MAX_ENDPOINT_LENGTH) return null
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null
  return url.protocol + "//" + url.host + url.pathname.replace(/\/+$/, "")
}

// `scopeKey` is the renderer's own label for "the credential main would derive here". Main still
// derives the handle itself from the provider/endpoint pair it receives; this key is only compared
// with itself to drop a status that belongs to a previous scope.
export function resolveCredentialScope(provider, endpoint) {
  if (provider === "gemini") {
    if (endpoint !== undefined && endpoint !== null && endpoint !== "") {
      return { ok: false, code: CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE }
    }
    return { ok: true, provider: "gemini", endpoint: undefined, scopeKey: "gemini:fixed" }
  }
  if (provider === "openai") {
    const canonical = canonicalCredentialEndpoint(endpoint)
    if (!canonical) return { ok: false, code: CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE }
    return { ok: true, provider: "openai", endpoint: canonical, scopeKey: "openai:" + canonical }
  }
  return { ok: false, code: CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE }
}

function secretProviderOf(field) {
  if (GEMINI_SECRET_FIELDS.includes(field)) return "gemini"
  if (OPENAI_SECRET_FIELDS.includes(field)) return "openai"
  return null
}

// Splits a legacy record into the fields this app persists and everything that has to leave storage.
// Secret values are kept only here, inside the caller's call frame, because the migration has to hand
// them to the vault before it erases them; the exported `sanitizeLlmConfigRecord` reports names only.
function inspectLlmConfigRecord(record) {
  const source = record && typeof record === "object" && !Array.isArray(record) ? record : {}
  const clean = {}
  for (const field of PERSISTED_FIELDS) {
    const value = source[field]
    if (typeof value !== "string") continue
    // The controller trims both of these before it writes them, so the sanitized record matches what
    // the next `saveStoredLlmConfig` would produce.
    clean[field] = field === "provider" ? value : value.trim()
  }
  const secrets = []
  const unknownFields = []
  let droppedFields = 0
  for (const field of Object.keys(source)) {
    if (PERSISTED_FIELDS.includes(field)) continue
    droppedFields += 1
    const provider = secretProviderOf(field)
    if (provider || AMBIGUOUS_SECRET_FIELDS.includes(field)) {
      secrets.push({ field, provider, value: source[field] })
      continue
    }
    // A name outside the reviewed set might be a secret this stage does not know, so it is dropped
    // too. Only names that look like identifiers are reported back, and only the name, never the value.
    if (FIELD_NAME_PATTERN.test(field)) unknownFields.push(field)
  }
  return { record: clean, secrets, unknownFields, droppedFields, changed: droppedFields > 0 }
}

// Public, name-only view of the sanitizer: what a caller may show, log or assert on.
export function sanitizeLlmConfigRecord(record) {
  const inspection = inspectLlmConfigRecord(record)
  return {
    record: inspection.record,
    secretFields: inspection.secrets.map(({ field }) => field),
    unknownFields: inspection.unknownFields,
    droppedFields: inspection.droppedFields,
    changed: inspection.changed,
  }
}

// Which provider and endpoint a legacy secret may be bound to, or why it may not be bound at all.
// `ambiguous` names are never guessed; an OpenAI-compatible key needs the same record to name the
// provider and carry the base URL it was typed for, because the settings screen may have moved on.
function scopeForSecret({ field, provider }, record) {
  if (!provider) return { ok: false, reason: "ambiguous-field", field }
  if (provider === "gemini") return { ok: true, provider: "gemini", endpoint: undefined, scopeKey: "gemini:fixed" }
  if (record.provider !== "openai") return { ok: false, reason: "unproven-provider", field }
  const canonical = canonicalCredentialEndpoint(record.baseUrl)
  if (!canonical) return { ok: false, reason: "unproven-endpoint", field }
  return { ok: true, provider: "openai", endpoint: canonical, scopeKey: "openai:" + canonical }
}

function secretOutcome(field, scope, outcome, needsReentry) {
  return {
    field,
    provider: scope?.provider ?? null,
    scopeKey: scope?.scopeKey ?? null,
    outcome,
    needsReentry,
  }
}

function usableSecretValue(value) {
  if (typeof value !== "string") return "unrecognized"
  if (!value.trim()) return "empty"
  // A value the store would refuse is not worth an IPC round trip, and quietly trimming a key would
  // mean guessing at secret material, so the key is dropped and re-entry is requested instead.
  if (value !== value.trim() || CONTROL_CHARACTERS.test(value)) return "unrecognized"
  return "usable"
}

// The status answer is already free of anything secret (a handle, a stored flag, the proven key
// provider), so only its reviewed fields survive into a result.
async function probeStatus(bridge, provider, endpoint) {
  let value = null
  try {
    value = await bridge.credentialStatus(provider, endpoint)
  } catch {
    value = null
  }
  if (!value || typeof value !== "object") return null
  return {
    stored: value.stored === true,
    supported: value.supported === true,
    protection: typeof value.protection === "string" ? value.protection : null,
    reason: typeof value.reason === "string" ? value.reason : null,
  }
}

// One status call per scope for a whole migration, so two legacy keys bound to the same endpoint do
// not ask main twice.
async function statusFor(scope, bridge, cache) {
  if (!cache.statuses.has(scope.scopeKey)) {
    cache.statuses.set(scope.scopeKey, await probeStatus(bridge, scope.provider, scope.endpoint))
  }
  return cache.statuses.get(scope.scopeKey)
}

// One legacy secret, one attempt. No retry: a key that failed to reach the vault is dropped from
// persistence and reported as needing re-entry rather than being pushed again.
async function migrateSecret(candidate, record, bridge, cache) {
  const usable = usableSecretValue(candidate.value)
  if (usable !== "usable") return secretOutcome(candidate.field, null, usable, usable === "unrecognized")
  const scope = scopeForSecret(candidate, record)
  if (!scope.ok) return secretOutcome(candidate.field, null, "unscoped", true)
  if (!bridge) return secretOutcome(candidate.field, scope, "no-vault", true)
  const status = await statusFor(scope, bridge, cache)
  if (!status) return secretOutcome(candidate.field, scope, "rejected", true)
  if (!status.supported) {
    cache.vault = { available: true, supported: false, reason: status.reason }
    const reason = UNAVAILABLE_REASONS.has(status.reason) ? "vault-unavailable" : "vault-unsupported"
    return secretOutcome(candidate.field, scope, reason, true)
  }
  cache.vault = { available: true, supported: true, reason: null }
  // A valid vault secret is never replaced by a legacy one: the user may have already entered a newer
  // key, and the vault copy is the one the provider calls use. When this same run filled that scope,
  // the legacy value is a second, different key that is about to be erased, so the user has to hear
  // that one of the two was dropped instead of reading a clean success.
  if (status.stored) return secretOutcome(candidate.field, scope, "already-stored", cache.written.has(scope.scopeKey))
  try {
    await bridge.credentialSave(scope.provider, scope.endpoint, candidate.value)
  } catch {
    return secretOutcome(candidate.field, scope, "rejected", true)
  }
  status.stored = true
  cache.written.add(scope.scopeKey)
  return secretOutcome(candidate.field, scope, "migrated", false)
}

/**
 * Removes plaintext provider keys from the legacy LLM config and hands every provably scoped key to
 * the OS vault first. Non-secret settings (`provider`, `baseUrl`, `llmModel`) are preserved; the
 * record is rewritten only when something was actually dropped, so a current config is a no-op.
 *
 * The save happens before the erase: a failure between the two leaves the user with a key rather than
 * with nothing. `needsReentry` is the signal the settings screen has to surface.
 */
export async function migrateLegacyCredentials({ storage, api } = {}) {
  const target = storage ?? globalThis.localStorage
  const empty = { changed: false, persisted: false, secrets: [], unknownFields: [], needsReentry: false, vault: null }
  if (!target || typeof target.getItem !== "function" || typeof target.setItem !== "function") {
    return result(CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE, empty)
  }
  let raw
  try {
    raw = target.getItem(LLM_CONFIG_STORAGE_KEY)
  } catch {
    return result(CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE, empty)
  }
  if (raw === null || raw === undefined) return result(CREDENTIAL_SETTINGS_CODES.CONFIG_MISSING, empty)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // An unparseable record cannot be sanitized field by field, and deleting data this module cannot
    // read would be a guess, so it is reported and left alone.
    return result(CREDENTIAL_SETTINGS_CODES.CONFIG_CORRUPT, empty)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return result(CREDENTIAL_SETTINGS_CODES.CONFIG_CORRUPT, empty)
  }
  const inspection = inspectLlmConfigRecord(parsed)
  // A record with nothing to drop is left byte for byte as it is: the current writer's own output is
  // a no-op, so an up-to-date install never touches storage on startup.
  if (!inspection.changed) return result(CREDENTIAL_SETTINGS_CODES.MIGRATION_NOOP, empty)
  const bridge = api === undefined ? desktopCredentialApi() : api
  const cache = {
    statuses: new Map(),
    written: new Set(),
    vault: bridge ? { available: true, supported: null, reason: null } : { available: false, supported: false, reason: "no-desktop-vault" },
  }
  const secrets = []
  for (const candidate of inspection.secrets) secrets.push(await migrateSecret(candidate, inspection.record, bridge, cache))
  // Deferral is per secret, not per record: a mixed outcome (one key waiting for the vault and one
  // ambiguous field, say) used to erase the record and destroy the only copy of the usable key. The
  // keys whose vault is not open stay in storage; everything else that has to leave still leaves.
  const deferredFields = new Set(
    secrets
      .filter(({ outcome }) => outcome === "vault-unavailable" || outcome === "no-vault")
      .map(({ field }) => field),
  )
  if (deferredFields.size > 0) {
    const kept = { ...inspection.record }
    for (const candidate of inspection.secrets) {
      if (deferredFields.has(candidate.field)) kept[candidate.field] = candidate.value
    }
    // When the deferred keys are the only fields being dropped, rewriting storage would gain nothing
    // and could reorder the record, so it is left byte for byte as it is.
    let persisted = false
    if (inspection.droppedFields > deferredFields.size) {
      try {
        target.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(kept))
        persisted = true
      } catch {
        persisted = false
      }
    }
    return result(CREDENTIAL_SETTINGS_CODES.MIGRATION_DEFERRED, {
      changed: persisted,
      persisted,
      secrets,
      unknownFields: inspection.unknownFields,
      deferredFields: [...deferredFields],
      needsReentry: secrets.some(({ field, needsReentry }) => needsReentry && !deferredFields.has(field)),
      vault: cache.vault,
    })
  }
  let persisted = false
  try {
    target.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(inspection.record))
    persisted = true
  } catch {
    persisted = false
  }
  if (!persisted) {
    return result(CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE, {
      changed: false,
      persisted: false,
      secrets,
      unknownFields: inspection.unknownFields,
      needsReentry: true,
      vault: cache.vault,
    })
  }
  const needsReentry = secrets.some(({ needsReentry: required }) => required)
  // A record that only held unusable values or unknown fields is cleaned without claiming that a key
  // reached the vault.
  const handedToVault = secrets.some(({ outcome }) => outcome === "migrated" || outcome === "already-stored")
  const code = needsReentry
    ? CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY
    : handedToVault ? CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED : CREDENTIAL_SETTINGS_CODES.MIGRATION_CLEANED
  return result(code, {
    changed: true,
    persisted: true,
    secrets,
    unknownFields: inspection.unknownFields,
    needsReentry,
    vault: cache.vault,
  })
}

function vaultFailureCode(status) {
  if (!status) return CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED
  if (status.supported) return CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED
  return UNAVAILABLE_REASONS.has(status.reason)
    ? CREDENTIAL_SETTINGS_CODES.VAULT_UNAVAILABLE
    : CREDENTIAL_SETTINGS_CODES.VAULT_UNSUPPORTED
}

/**
 * The async status/save/remove cycle the settings screen drives.
 *
 * Every operation captures the generation it started with. `setScope` bumps the generation, so a
 * status, save or remove that resolves after the user switched provider or base URL reports
 * `STATUS_STALE` with `superseded: true` and is not passed to `onChange`. A save that main already
 * performed still reports `persisted: true`; only the rendering of it is dropped.
 *
 * Nothing here keeps a key: `save` forwards its argument and releases it, and no result or status
 * field ever contains one.
 */
export function createCredentialSettings({ api, onChange } = {}) {
  const bridge = api === undefined ? desktopCredentialApi() : api
  let generation = 0
  let scope = null
  let status = null

  const emit = (outcome) => {
    if (typeof onChange === "function") {
      try {
        onChange(outcome)
      } catch {}
    }
    return outcome
  }
  const stale = (extra) => result(CREDENTIAL_SETTINGS_CODES.STATUS_STALE, { superseded: true, ...extra })
  const statusView = () => (status ? { ...status } : null)

  function setScope(provider, endpoint) {
    generation += 1
    status = null
    const resolved = resolveCredentialScope(provider, endpoint)
    if (!resolved.ok) {
      scope = null
      return result(CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE, {
        provider: typeof provider === "string" ? provider : null,
        scopeKey: null,
        endpoint: null,
      })
    }
    scope = { provider: resolved.provider, endpoint: resolved.endpoint, scopeKey: resolved.scopeKey }
    return result(CREDENTIAL_SETTINGS_CODES.SCOPE_SET, {
      provider: scope.provider,
      endpoint: scope.endpoint ?? null,
      scopeKey: scope.scopeKey,
    })
  }

  function getScope() {
    return scope ? { ...scope } : null
  }

  async function refresh() {
    if (!scope) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE, { provider: null, scopeKey: null, stored: false, supported: false }))
    }
    const at = generation
    const { provider, endpoint, scopeKey } = scope
    if (!bridge) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.NO_VAULT, {
        provider,
        scopeKey,
        stored: false,
        supported: false,
        protection: null,
        reason: "no-desktop-vault",
      }))
    }
    const value = await probeStatus(bridge, provider, endpoint)
    if (at !== generation) {
      return stale({ provider, scopeKey, stored: statusView()?.stored ?? false, supported: statusView()?.supported ?? false })
    }
    if (!value) {
      status = null
      return emit(result(CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED, {
        provider,
        scopeKey,
        stored: false,
        supported: false,
        protection: null,
        reason: "status-failed",
      }))
    }
    status = value
    return emit(result(
      value.supported ? CREDENTIAL_SETTINGS_CODES.STATUS_READY : vaultFailureCode(value),
      { provider, scopeKey, stored: value.stored, supported: value.supported, protection: value.protection, reason: value.reason },
    ))
  }

  async function save(secret) {
    if (!scope) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE, { provider: null, scopeKey: null, stored: false, persisted: false }))
    }
    const at = generation
    const { provider, endpoint, scopeKey } = scope
    const empty = secret === undefined || secret === null || secret === ""
    // Only Gemini insists on a key. An OpenAI-compatible endpoint may be a local server, in which case
    // an empty key stays the previous "no Authorization header" behaviour.
    if (empty && requiresCredential(provider)) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.KEY_REQUIRED, { provider, scopeKey, stored: false, persisted: false }))
    }
    if (empty) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.KEYLESS, { provider, scopeKey, stored: false, persisted: false }))
    }
    if (typeof secret !== "string" || secret !== secret.trim() || CONTROL_CHARACTERS.test(secret)) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.INVALID_SECRET, { provider, scopeKey, stored: false, persisted: false }))
    }
    if (!bridge) {
      // A browser keeps the key in the settings object for this session only; nothing is persisted.
      return emit(result(CREDENTIAL_SETTINGS_CODES.NO_VAULT, {
        ok: true,
        provider,
        scopeKey,
        stored: false,
        persisted: false,
        ephemeral: true,
      }))
    }
    try {
      await bridge.credentialSave(provider, endpoint, secret)
    } catch {
      // One classification call, so the screen can say "unlock the vault" instead of "try again"
      // without ever echoing main's error text.
      const probe = await probeStatus(bridge, provider, endpoint)
      if (at !== generation) return stale({ provider, scopeKey, stored: statusView()?.stored ?? false, persisted: false })
      return emit(result(vaultFailureCode(probe), { provider, scopeKey, stored: false, persisted: false }))
    }
    if (at !== generation) return stale({ provider, scopeKey, stored: false, persisted: true })
    // Reaching main's store proves OS protection for this endpoint, whatever the last probe said.
    status = { ...(status ?? { protection: null, reason: null }), supported: true, stored: true }
    return emit(result(CREDENTIAL_SETTINGS_CODES.SAVED, { provider, scopeKey, stored: true, persisted: true }))
  }

  async function remove() {
    if (!scope) {
      return emit(result(CREDENTIAL_SETTINGS_CODES.INVALID_SCOPE, { provider: null, scopeKey: null, removed: false }))
    }
    const at = generation
    const { provider, endpoint, scopeKey } = scope
    if (!bridge) {
      // Nothing was ever stored, so the removal did not happen either.
      return emit(result(CREDENTIAL_SETTINGS_CODES.NO_VAULT, { ok: false, provider, scopeKey, removed: false }))
    }
    let removed
    try {
      const answer = await bridge.credentialRemove(provider, endpoint)
      removed = answer?.removed === true
    } catch {
      if (at !== generation) return stale({ provider, scopeKey, removed: false })
      return emit(result(CREDENTIAL_SETTINGS_CODES.VAULT_REJECTED, { provider, scopeKey, removed: false }))
    }
    if (at !== generation) return stale({ provider, scopeKey, removed })
    status = { ...(status ?? { supported: true, protection: null, reason: null }), stored: false }
    return emit(result(CREDENTIAL_SETTINGS_CODES.REMOVED, { provider, scopeKey, removed, stored: false }))
  }

  return {
    available: Boolean(bridge),
    setScope,
    getScope,
    refresh,
    save,
    remove,
    getStatus: statusView,
  }
}
