import { expect, it } from "vitest"
import { reviewSentence } from "./merge.js"
import { emptyLedger } from "../../review/ledger.js"

it("credits the reviewer recorded in the ledger, not the current selection", async () => {
  const ledger = emptyLedger("fixture")
  ledger.rounds.push({ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null })
  ledger.completeness = { reviewer: "codex", state: "complete", unchecked: [] }
  const deps = { fs: { readText: async () => JSON.stringify(ledger) } } as never
  expect(await reviewSentence({ root: "/fixture" }, deps, "fixture", "claude_code")).toBe("Reviewed by Codex")
})

it("does not credit a selected reviewer when no review round exists", async () => {
  const deps = { fs: { readText: async () => null } } as never
  expect(await reviewSentence({ root: "/fixture" }, deps, "fixture", "codex")).toBe("No second review ran")
})
