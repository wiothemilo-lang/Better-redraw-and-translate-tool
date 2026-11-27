import assert from "node:assert/strict"
import test from "node:test"
import { parseSlashCommand } from "../src/agent-commands.js"

test("slash command flags only match the first word of the argument", () => {
  // "off now" used to read as a plan prompt, which turned Plan Mode ON for a user who asked to leave it.
  assert.deepEqual(parseSlashCommand("/plan off"), { kind: "plan", enabled: false })
  assert.deepEqual(parseSlashCommand("/plan OFF"), { kind: "plan", enabled: false })
  assert.equal(parseSlashCommand("/plan off now").kind, "usage")
  assert.match(parseSlashCommand("/plan off now").text, /\/plan off/)

  // "ai now" used to fall back to the deterministic compact without telling anyone.
  assert.deepEqual(parseSlashCommand("/compact ai"), { kind: "compact", useLlm: true })
  assert.deepEqual(parseSlashCommand("/compact AI"), { kind: "compact", useLlm: true })
  assert.equal(parseSlashCommand("/compact ai now").kind, "usage")
  assert.equal(parseSlashCommand("/compact ai now").useLlm, undefined)
  assert.deepEqual(parseSlashCommand("/compact"), { kind: "compact", useLlm: false })

  // A plan prompt that starts with any other word still runs as a prompt.
  assert.deepEqual(parseSlashCommand("/plan kiểm tra chương"), { kind: "plan", enabled: true, prompt: "kiểm tra chương" })
  assert.deepEqual(parseSlashCommand("/plan"), { kind: "plan", enabled: true })

  assert.equal(parseSlashCommand("xin chào"), null)
  assert.equal(parseSlashCommand("/help").kind, "help")
  assert.deepEqual(parseSlashCommand("/skill shounen"), { kind: "skill", skillId: "shounen" })
})
