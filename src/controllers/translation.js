import {
  imageTranslatorForProvider,
  remainingTranslations,
  scriptAlignerForProvider,
  translateBoxesForProvider,
  translationNotes,
  translationSignature,
} from "../translation.js"
import {
  boxStyleSignature,
  createTranslationMemoryStore,
  normalizeSourceText,
  translationMemoryEntryLimit,
  translationMemoryScope,
} from "../translation-memory.js"
import {
  applyBoxTranslations,
  hasFingerprints,
  recordBoxTranslation,
  resumeWork,
  staleBoxes,
} from "../incremental-translation.js"
import { resolveProvider } from "../provider-registry.js"
import { resolveSkillPrompt } from "../agent-skills.js"
import { glossaryStatusText, parseTerminologyGraph } from "../terminology-graph.js"
import { groupDialogue } from "../io.js"
import { createCredentialSettings } from "../credential-settings.js"
import { PROVIDER_BRIDGE_CODES, providerCredentialsInMain } from "../provider-bridge.js"

const llmStorageKey = "khung-thoai-llm-config"
const llmPresets = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
}

export function setupTranslation({
  state,
  byId,
  status,
  checkpoint,
  renderPages,
  renderInspector,
  renderCanvas,
  render,
  selectedPage,
  pageForScript,
  applyTranslation,
  projectBusy,
  onSettingsChange,
  configWritesReady,
  notify,
  notifyOverflowIfAny,
  translationMemory,
  usageLedger,
}) {
  let translationController
  // The project owns the pairs; a caller that does not supply a store (tests, the browser panel
  // alone) still gets a working memory for this session.
  const memory = translationMemory ?? createTranslationMemoryStore()

  function loadStoredLlmConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(llmStorageKey) || "null")
      if (!saved || typeof saved !== "object") return
      if (saved.provider === "openai" || saved.provider === "gemini") {
        byId("translation-provider").value = saved.provider
      }
      if (typeof saved.baseUrl === "string" && saved.baseUrl) byId("llm-base-url").value = saved.baseUrl
      if (typeof saved.llmModel === "string") byId("llm-model").value = saved.llmModel
    } catch {
      // Ignore storage access errors in private browsing.
    }
  }

  // The startup migration erases plaintext keys from this record, so a write that landed before it
  // finished would put them back. Every write therefore waits for `configWritesReady`; the record
  // itself is captured when the user makes the change, not when the promise settles.
  const configReady = configWritesReady ? Promise.resolve(configWritesReady).catch(() => {}) : null

  function writeStoredLlmConfig(record) {
    const write = () => {
      try {
        localStorage.setItem(llmStorageKey, JSON.stringify(record))
      } catch {
        // Ignore storage access errors.
      }
    }
    if (!configReady) {
      write()
      return Promise.resolve()
    }
    return configReady.then(write, write)
  }

  function saveStoredLlmConfig() {
    return writeStoredLlmConfig({
      provider: byId("translation-provider").value,
      baseUrl: byId("llm-base-url").value.trim(),
      llmModel: byId("llm-model").value.trim(),
    })
  }

  function syncProviderFields() {
    const isOpenAi = byId("translation-provider").value === "openai"
    byId("gemini-fields").hidden = isOpenAi
    byId("openai-fields").hidden = !isOpenAi
  }

  // --- Credential vault (Nixio #60) ------------------------------------------------------------
  //
  // The password fields are write-only: a value typed here is handed to main once, on submit, and the
  // field is emptied before the answer arrives. No result, status or error ever carries a key back, so
  // nothing can prefill these inputs. A browser has no vault at all and keeps the value on screen for
  // this session only.
  const credentials = createCredentialSettings()
  // The vault controls need the three credential channels, which only the desktop preload exposes.
  const vaultOwnsKeys = credentials.available
  const credentialInputIds = { gemini: "gemini-key", openai: "llm-key" }
  const credentialStatusIds = { gemini: "gemini-key-status", openai: "llm-key-status" }
  const credentialRemoveIds = { gemini: "gemini-key-remove", openai: "llm-key-remove" }
  let boundScopeKey = null

  function credentialProvider() {
    return byId("translation-provider").value === "openai" ? "openai" : "gemini"
  }

  // Gemini has one fixed destination, so its key is bound to the provider alone; an OpenAI-compatible
  // key is bound to the exact Base URL that is on screen right now.
  function scopeEndpoint(provider) {
    return provider === "openai" ? byId("llm-base-url").value.trim() : undefined
  }

  function clearCredentialInputs() {
    for (const id of Object.values(credentialInputIds)) byId(id).value = ""
  }

  function clearCredentialStatus(provider) {
    const element = byId(credentialStatusIds[provider])
    element.textContent = ""
    element.dataset.error = "false"
    byId(credentialRemoveIds[provider]).disabled = true
  }

  function renderCredentialStatus(outcome) {
    const provider = outcome?.provider === "openai" || outcome?.provider === "gemini"
      ? outcome.provider
      : credentialProvider()
    const element = byId(credentialStatusIds[provider])
    element.textContent = outcome?.message || ""
    element.dataset.error = outcome?.ok === false ? "true" : "false"
    byId(credentialRemoveIds[provider]).disabled = outcome?.stored !== true
  }

  // The status line and a provider request both read these same two inputs, so the scope the screen
  // describes is the scope main binds the stored key to. Every question is issued with a sequence
  // number per provider and only the answer to the newest question is rendered: a scope probe issued
  // before a save would otherwise answer after it and replace "đã lưu khóa" with a plain status. The
  // call itself is made synchronously, so a save is bound to the scope that was on screen when the
  // user clicked, never to one they switched to while it was in flight.
  const credentialIssued = new Map()
  let credentialSequence = 0

  function issueCredential(provider, operation) {
    const sequence = ++credentialSequence
    credentialIssued.set(provider, sequence)
    return operation().then((outcome) => {
      // A superseded answer means the user already moved on, and the helper reports it without
      // claiming anything about the scope that is now on screen.
      if (credentialIssued.get(provider) === sequence && outcome?.superseded !== true) {
        renderCredentialStatus(outcome)
      }
      return outcome
    })
  }

  function bindCredentialScope(provider = credentialProvider(), { refresh = true } = {}) {
    const applied = credentials.setScope(provider, scopeEndpoint(provider))
    const scopeKey = applied.ok ? applied.scopeKey : null
    if (scopeKey !== boundScopeKey) {
      // A value typed for the previous provider or endpoint must not be saved under this one.
      clearCredentialInputs()
      for (const name of Object.keys(credentialStatusIds)) clearCredentialStatus(name)
      boundScopeKey = scopeKey
    }
    if (refresh) {
      // `refresh` still answers when the scope is unusable, so the status line explains why.
      void issueCredential(provider, () => credentials.refresh()).catch(() => {})
    }
    return applied
  }

  async function saveCredential(provider) {
    // Bind first: this is what clears a value that was typed for a different endpoint.
    const applied = bindCredentialScope(provider, { refresh: false })
    if (!applied.ok) return issueCredential(provider, () => credentials.refresh())
    const input = byId(credentialInputIds[provider])
    const secret = input.value
    // Emptied before the round trip, so a rejected save cannot leave the key in the field.
    input.value = ""
    return issueCredential(provider, () => credentials.save(secret))
  }

  async function removeCredential(provider) {
    const applied = bindCredentialScope(provider, { refresh: false })
    if (!applied.ok) return issueCredential(provider, () => credentials.refresh())
    return issueCredential(provider, () => credentials.remove())
  }

  function syncCredentialControls() {
    for (const id of ["gemini-key-actions", "llm-key-actions"]) byId(id).hidden = !vaultOwnsKeys
    for (const id of Object.values(credentialRemoveIds)) byId(id).disabled = true
  }

  loadStoredLlmConfig()
  syncProviderFields()
  syncCredentialControls()
  bindCredentialScope()

  byId("translation-provider").onchange = () => {
    syncProviderFields()
    bindCredentialScope()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-preset").onchange = () => {
    const preset = llmPresets[byId("llm-preset").value]
    if (!preset) return
    byId("llm-base-url").value = preset.baseUrl
    if (preset.model && !byId("llm-model").value.trim()) byId("llm-model").value = preset.model
    bindCredentialScope()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-base-url").onchange = () => {
    bindCredentialScope()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-model").onchange = () => {
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  for (const provider of Object.keys(credentialInputIds)) {
    byId(credentialInputIds[provider] + "-save").onclick = () => saveCredential(provider)
    byId(credentialInputIds[provider] + "-remove").onclick = () => removeCredential(provider)
  }

  function readTranslationSettings() {
    const provider = byId("translation-provider").value
    return {
      provider,
      model: byId("gemini-model").value,
      baseUrl: byId("llm-base-url").value.trim(),
      llmModel: byId("llm-model").value.trim(),
      source: byId("source-language").value,
      target: byId("target-language").value,
      notes: byId("translation-notes").value.trim(),
      styleGuide: state.styleGuide,
      skillPrompt: resolveSkillPrompt(byId("chat-skill")?.value, byId("chat-skill-custom")?.value),
      direction: byId("direction").value,
      glossary: byId("translation-glossary").value.trim(),
    }
  }

  // --- Translation memory panel (Nixio #63) ----------------------------------------------------
  //
  // The panel only ever reports the store and offers the near matches for the page on screen. The
  // pairs themselves are applied by `translateExistingBoxes` below, so the count and the action here
  // describe the same store the translation path reads.
  function memoryScope() {
    return translationMemoryScope(readTranslationSettings())
  }

  // A plan is recomputed only when something that can change its answer changed: the store, the
  // page, or the text of its boxes. `render()` runs on every canvas frame, so this stays O(boxes).
  let memoryPlanKey = null
  let memoryPlan = { hits: [], suggestions: [], pending: [] }

  function pageMemoryPlan(page) {
    const settings = readTranslationSettings()
    const key = [
      memory.revision, page?.id ?? "", settings.source, settings.target, settings.glossary,
      (page?.boxes ?? []).map((box) => box.text).join("\u0000"),
    ].join("\u0001")
    if (key !== memoryPlanKey) {
      memoryPlanKey = key
      memoryPlan = page
        ? memory.plan(page.boxes, { scope: memoryScope(), page: page.name })
        : { hits: [], suggestions: [], pending: [] }
    }
    return memoryPlan
  }

  function syncMemory() {
    const summary = memory.summary(memoryScope())
    const page = selectedPage()
    const suggestions = page ? pageMemoryPlan(page).suggestions.length : 0
    // Reaching the cap is data loss the user did not ask for; say how many pairs the store dropped
    // instead of letting the new count hide it behind a number that never changes.
    const evicted = memory.evicted ?? 0
    byId("translation-memory-status").textContent = summary.total
      ? `Bộ nhớ dịch: ${summary.total} cặp đã lưu (${summary.reviewed} cặp đã duyệt)` +
        (suggestions ? ` · ${suggestions} gợi ý từ bộ nhớ cho trang này.` : ".") +
        (evicted ? ` Đã bỏ ${evicted} cặp cũ để giữ giới hạn ${translationMemoryEntryLimit}.` : "")
      : "Bộ nhớ dịch: chưa có cặp nào trong dự án."
    const button = byId("use-approved-translation")
    button.disabled = !suggestions || projectBusy()
    button.textContent = suggestions ? `Dùng bản đã duyệt (${suggestions})` : "Dùng bản đã duyệt"
  }

  // Accepting a suggestion writes the pair into the boxes and records it as reviewed, so the next
  // identical line is reused without the provider ever being asked again.
  function useApprovedTranslation() {
    const page = selectedPage()
    if (!page || projectBusy()) return
    const plan = pageMemoryPlan(page)
    if (!plan.suggestions.length) return status("Không có bản gần đúng nào trong bộ nhớ dịch cho trang này.", true)
    checkpoint(undefined, { label: `Dùng bộ nhớ dịch cho trang ${page.name}`, kind: "translate" })
    const accepted = memory.accept(plan.suggestions, { scope: memoryScope(), page: page.name })
    const applied = memory.apply(plan.suggestions)
    status(`Đã dùng ${applied} bản từ bộ nhớ dịch cho trang ${page.name} và duyệt ${accepted.length} cặp.`)
    render()
  }

  // Main answers a request that has no stored credential through a fixed code, so the article status
  // stays Vietnamese while the renderer never repeats main's own wording or a raw provider header.
  function providerFailureText(error, provider) {
    if (error?.code === PROVIDER_BRIDGE_CODES.CREDENTIAL) {
      return resolveProvider({ provider }).credential.vaultMessage
    }
    return error?.message || String(error)
  }

  function prepareCredentials(settings) {
    // On the desktop main attaches the stored key, so the password fields are never read for a
    // request: an unconfigured provider is rejected by main instead of by a value left on screen. A
    // browser has no vault and keeps using the field for this session only.
    return resolveProvider(settings).prepareCredential(settings, {
      vaultKeys: vaultOwnsKeys || providerCredentialsInMain(),
      readField: (id) => byId(id).value.trim(),
    })
  }

  // Earlier dialogue from the page before this one, when it was translated with the same settings.
  function carriedContext(page, signature) {
    const previousPage = state.pages[state.pages.indexOf(page) - 1]
    return previousPage?.translationContext?.signature === signature
      ? previousPage.translationContext.lines
      : []
  }

  // A translation call is a paid call like an agent step, so it lands in the same project ledger the
  // chat panel reads (#65 d). The page id keeps the per-page rollup honest across a chapter batch.
  function recordUsage(page, call) {
    usageLedger?.record({ ...call, pageId: page?.id })
  }

  function budgetStopMessage() {
    const gate = usageLedger?.gate?.()
    return gate?.blocked ? gate.message : ""
  }

  // The soft budget refuses the next batch instead of starting pages the project cannot pay for.
  function stopForBudget() {
    const message = budgetStopMessage()
    if (!message) return false
    status(message, true)
    notify?.({ kind: "error", title: "Đã chặn lượt dịch AI", message, key: "usage-budget-stop" })
    return true
  }

  async function processPages(pages, read, action, kind = "translate") {
    if (projectBusy() || !pages.length) return false
    if (stopForBudget()) return false
    let settings
    try {
      settings = prepareCredentials(readTranslationSettings())
    } catch (error) {
      status(error.message, true)
      return false
    }
    const signature = translationSignature(settings)
    const scope = translationMemoryScope(settings)
    let context = carriedContext(pages[0], signature)
    let completed = 0
    let placed = 0
    let skipped = 0
    checkpoint(undefined, { label: `Dịch ${pages.length} trang`, kind: "translate" })
    translationController = new AbortController()
    state.translating = true
    for (const page of pages)
      page.translationJob = { kind, signature, state: "pending" }
    renderPages()
    renderInspector()
    let activePage
    let budgetStopped = false
    try {
      for (const page of pages) {
        if (usageLedger?.gate?.().blocked) {
          budgetStopped = true
          break
        }
        activePage = page
        page.translationJob = { kind, signature, state: "running" }
        renderPages()
        const report = (message) => status(page.name + " · " + message)
        const lines = await read(page, {
          ...settings,
          notes: translationNotes(settings),
          context,
          report,
          signal: translationController.signal,
          onUsage: (call) => recordUsage(page, call),
        })
        translationController.signal.throwIfAborted()
        if (lines.length) {
          // A whole-page pass rewrites every box it places, so each one is stamped with the input it
          // came from and a later box job knows it does not have to send it again.
          placed += applyTranslation(page, lines, (box, line) =>
            recordBoxTranslation(box, { source: line.source, settings, page }))
          skipped += page.unplaced.length
          // Page translation learns the same pairs the box path does, so a later identical line is
          // already in the memory when the user asks for it there.
          for (const { source, text } of lines) {
            if (!source || !text) continue
            memory.record({ source, target: text }, { scope, page: page.name })
          }
          context = [
            ...context,
            ...lines
              .filter(({ source }) => source)
              .map(({ source, text }) => ({
                source: source.slice(0, 240),
                text: text.slice(0, 240),
              })),
          ].slice(-8)
        } else {
          page.unplaced = []
        }
        page.translationContext = { signature, lines: context }
        page.translationJob = { kind, signature, state: "done" }
        completed++
        if (selectedPage() === page) {
          renderCanvas()
          renderInspector()
        }
      }
      const budgetMessage = budgetStopped ? budgetStopMessage() : ""
      status(
        budgetMessage
          ? `${budgetMessage} Đã dừng sau ${completed}/${pages.length} trang.`
          : `Đã ${action} ${completed}/${pages.length} trang. ${placed} câu đã đặt và ${skipped} câu chờ đặt.`,
        Boolean(budgetMessage),
      )
      if (budgetMessage) {
        notify?.({ kind: "error", title: "Đã chặn lượt dịch AI", message: budgetMessage, key: "usage-budget-stop" })
      } else if (pages.length > 1) {
        notify?.({
          kind: "success",
          title: `Hoàn tất ${action} chương`,
          message: `Đã xử lý ${completed}/${pages.length} trang (${placed} câu đã đặt, ${skipped} câu chờ đặt).`,
          key: "batch-translate",
        })
      }
      const active = selectedPage()
      if (active && pages.includes(active)) notifyOverflowIfAny?.(active, "sau khi dịch")
      return true
    } catch (error) {
      const stopped = translationController.signal.aborted
      const reason = providerFailureText(error, settings.provider)
      if (activePage)
        activePage.translationJob = {
          kind,
          signature,
          state: stopped ? "pending" : "error",
          error: stopped ? undefined : reason,
        }
      status(
        stopped
          ? `Đã dừng sau ${completed} trang. Có thể tiếp tục dịch chương.`
          : `Đã ${action} ${completed}/${pages.length} trang. ${reason}`,
        !stopped,
      )
      if (!stopped && pages.length > 1) {
        notify?.({
          kind: "error",
          title: `Lỗi khi ${action} chương`,
          message: `Hoàn tất ${completed}/${pages.length} trang. ${reason}`,
          key: "batch-translate",
        })
      }
      return false
    } finally {
      state.translating = false
      translationController = null
      render()
    }
  }

  // One page of a box job: only the boxes that were stale are sent, and only the boxes that answered
  // are written back and stamped. The job signature becomes the current one, so the page stops
  // reporting "settings changed" once its boxes are up to date.
  async function translateBoxesOnPage(page, boxes, settings, signature) {
    const context = carriedContext(page, signature)
    // The memory is keyed on the source text, and a translation overwrites that text, so the sources
    // are read before anything writes to a box. An approved pair is applied without a provider call
    // and only the boxes the memory cannot answer are sent.
    const scope = translationMemoryScope(settings)
    const sources = new Map(boxes.map((box) => [box.id, normalizeSourceText(box.text)]))
    const plan = memory.plan(boxes, { scope, page: page.name })
    const reused = memory.apply(plan.hits)
    for (const hit of plan.hits) {
      recordBoxTranslation(hit.box, { source: sources.get(hit.boxId) ?? "", settings, page })
    }
    page.translationJob = { kind: "translate", signature, state: "running" }
    renderPages()
    if (!plan.pending.length) {
      page.translationJob = { kind: "translate", signature, state: "done" }
      status(`Đã dùng bộ nhớ dịch cho ${reused}/${boxes.length} khung chữ, không gọi API.`)
      return { updated: 0, kept: Math.max(0, page.boxes.length - reused), reused }
    }
    const report = (message) => status(page.name + " · " + message)
    const translated = await translateBoxesForProvider(settings.provider, page, plan.pending, {
      ...settings,
      notes: translationNotes(settings),
      context,
      report,
      signal: translationController.signal,
      onUsage: (call) => recordUsage(page, call),
    })
    translationController.signal.throwIfAborted()
    const applied = applyBoxTranslations(page, plan.pending, translated, settings, { reused })
    // A provider answer is remembered unreviewed: it is offered next time, never trusted silently.
    const byBoxId = new Map(translated.map((item) => [item.boxId, item]))
    for (const box of plan.pending) {
      const match = byBoxId.get(box.id)
      if (!match?.text) continue
      memory.record(
        { source: sources.get(box.id) ?? "", target: match.text },
        { scope, page: page.name, style: boxStyleSignature(box) },
      )
    }
    page.translationContext = {
      signature,
      lines: [
        ...context,
        ...translated
          .filter(({ source }) => source)
          .map(({ source, text }) => ({ source: source.slice(0, 240), text: text.slice(0, 240) })),
      ].slice(-8),
    }
    page.translationJob = { kind: "translate", signature, state: "done" }
    return { updated: applied.updated, kept: applied.kept, reused }
  }
  // Incremental translation job. Only boxes whose inputs changed since their last translation are
  // sent, so a second press costs no request at all and a glossary edit re-translates just the boxes
  // that cite the term. Pages are still walked in page order and keep the same job states, progress
  // checkpoint and stop button as the whole-page job.
  async function translateChangedBoxes(pages) {
    if (projectBusy() || !pages.length) return false
    if (stopForBudget()) return false
    let settings
    try {
      settings = prepareCredentials(readTranslationSettings())
    } catch (error) {
      status(error.message, true)
      return false
    }
    const signature = translationSignature(settings)
    const plan = pages
      .map((page) => ({ page, boxes: staleBoxes(page, settings) }))
      .filter(({ boxes }) => boxes.length)
    if (!plan.length) {
      // Nothing is stale, but a page whose settings moved past its boxes still reports a stale job;
      // its text already matches the current settings, so the job signature can catch up for free.
      let refreshed = false
      for (const page of pages) {
        if (!hasFingerprints(page) || page.translationJob?.signature === signature) continue
        page.translationJob = { kind: "translate", signature, state: "done" }
        refreshed = true
      }
      if (refreshed) renderPages()
      status("Không có khung nào cần dịch lại: mọi khung đã khớp thiết lập hiện tại.")
      return true
    }
    checkpoint(undefined, {
      label: plan.length === 1 ? `Dịch trang ${plan[0].page.name}` : `Dịch ${plan.length} trang thay đổi`,
      kind: "translate",
    })
    translationController = new AbortController()
    state.translating = true
    renderInspector()
    let updated = 0
    let kept = 0
    let reusedMemory = 0
    let completed = 0
    let activePage
    let budgetStopped = false
    try {
      for (const { page, boxes } of plan) {
        // The gate is read per page: one press can spend across several pages, so a limit reached
        // mid-job must stop the next page rather than only the next press.
        if (usageLedger?.gate?.().blocked) {
          budgetStopped = true
          break
        }
        activePage = page
        const applied = await translateBoxesOnPage(page, boxes, settings, signature)
        updated += applied.updated
        kept += applied.kept
        reusedMemory += applied.reused
        completed++
        if (selectedPage() === page) {
          renderCanvas()
          renderInspector()
        }
      }
      // A run the memory answered on its own says so: the user did not spend a call for it.
      const budgetMessage = budgetStopped ? budgetStopMessage() : ""
      if (budgetMessage) {
        status(`${budgetMessage} Đã dừng sau ${completed}/${plan.length} trang.`, true)
        notify?.({ kind: "error", title: "Đã chặn lượt dịch AI", message: budgetMessage, key: "usage-budget-stop" })
      } else if (!updated && reusedMemory) {
        status(`Đã dùng bộ nhớ dịch cho ${reusedMemory} khung chữ, không gọi API.`)
      } else {
        status(
          plan.length === 1
            ? `Đã dịch ${updated} khung thay đổi, giữ nguyên ${kept} khung trên trang.` +
              (reusedMemory ? ` Dùng lại ${reusedMemory} cặp từ bộ nhớ dịch.` : "")
            : `Đã dịch ${updated} khung thay đổi trên ${completed}/${pages.length} trang, giữ nguyên ${kept} khung.` +
              (reusedMemory ? ` Dùng lại ${reusedMemory} cặp từ bộ nhớ dịch.` : ""),
        )
      }
      for (const { page } of plan) notifyOverflowIfAny?.(page, "sau khi dịch khung chữ")
      return true
    } catch (error) {
      const stopped = translationController.signal.aborted
      const reason = providerFailureText(error, settings.provider)
      if (activePage)
        activePage.translationJob = {
          kind: "translate",
          signature,
          state: stopped ? "pending" : "error",
          error: stopped ? undefined : reason,
        }
      status(
        stopped
          ? "Đã dừng dịch khung chữ."
          : `Không dịch được khung chữ. ${completed}/${plan.length} trang đã xong. ${reason}`,
        !stopped,
      )
      return false
    } finally {
      state.translating = false
      translationController = null
      render()
    }
  }

  async function translateExistingBoxes() {
    const page = selectedPage()
    if (projectBusy() || !page) return
    if (!page.boxes.length) return status("Trang hiện tại chưa có khung chữ nào để dịch.", true)
    await translateChangedBoxes([page])
  }

  // Resume patches the boxes that drifted first, then reads the pages that still need a whole-page
  // pass — so a stale glossary or one edited line no longer costs an OCR pass over the chapter, and
  // the run still ends on the page count of the work that actually had to be re-read.
  async function resumeTranslation() {
    if (projectBusy()) return
    const work = resumeWork(state.pages, readTranslationSettings())
    if (!work.full.length && !work.delta.length) {
      status("Không còn trang nào cần dịch.")
      return
    }
    if (work.delta.length && !(await translateChangedBoxes(work.delta))) return
    if (work.full.length) await processPages(work.full, imageTranslator, "dịch")
  }

  const imageTranslator = (page, settings) => imageTranslatorForProvider(settings.provider)(page, settings)
  const scriptAligner = (page, settings, lines) => scriptAlignerForProvider(settings.provider)(page, settings, lines)

  // The field stays one editable textarea; the status line reads the terminology graph out of
  // it so aliases, variants and relations are visible while typing instead of only in the model.
  function refreshGlossaryStatus() {
    const field = byId("translation-glossary")
    const target = byId("glossary-status")
    if (!field || !target) return ""
    const text = glossaryStatusText(parseTerminologyGraph(field.value))
    target.textContent = text
    return text
  }

  // The bulk bar's translate runs the same whole-page job as "Dịch cả lượt", just over the
  // selected subset: per-page job states, the stop button, budget gate and resume all behave
  // exactly as they do for the full chapter.
  function translatePages(pages) {
    return processPages(pages ?? [], imageTranslator, "dịch")
  }

  byId("translate-boxes").onclick = translateExistingBoxes
  byId("use-approved-translation").onclick = useApprovedTranslation
  byId("translate").onclick = () =>
    processPages([selectedPage()].filter(Boolean), imageTranslator, "dịch")
  byId("translate-all").onclick = () =>
    processPages([...state.pages], imageTranslator, "dịch")
  byId("resume-translation").onclick = resumeTranslation
  byId("stop-translation").onclick = () => translationController?.abort()
  byId("align-script").onclick = () => {
    const page = selectedPage()
    if (!page) return
    const lines = groupDialogue(byId("script-text").value)
      .filter(({ reference }) => pageForScript(reference, page) === page)
      .flatMap(({ lines }) => lines)
    if (!lines.length) return status("Hãy nhập kịch bản cho trang này.", true)
    processPages(
      [page],
      (selected, settings) => scriptAligner(selected, settings, lines),
      "ghép",
      "align",
    )
  }

  byId("translation-glossary")?.addEventListener("input", refreshGlossaryStatus)
  refreshGlossaryStatus()
  syncMemory()

  return { settings: readTranslationSettings, refreshGlossaryStatus, syncMemory, translatePages }
}
