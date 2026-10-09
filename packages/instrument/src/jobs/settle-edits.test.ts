import { describe, expect, it } from "vitest"
import { applyTextEdits } from "../server-lane/text-edits.js"
import { editHash, heldForReview, keptWithLine, settlementPlan, type AttributedEdit } from "./settle-edits.js"
import type { ManagedTextEdit } from "../types.js"
function entry(before: string, hunks: ManagedTextEdit[], owners: string[][], n = 1): AttributedEdit {
  return { edit: { id: `e${n}`, runId: "run", jobId: "posthog_improve", file: "app.ts", beforeHash: editHash(before), afterHash: editHash(applyTextEdits(before, hunks)), textEdits: hunks, planLineId: null, by: "agent" }, itemIds: [...new Set(owners.flat())], textEditItems: owners }
}
describe("agent edit settlement", () => {
  it("restores the unfinished hunk while preserving an independent verified hunk in the same file", () => {
    const e = entry("one\ntwo\n", [{ offset: 0, removed: "one", inserted: "bad" }, { offset: 4, removed: "two", inserted: "good" }], [["bad"], ["good"]])
    const p = settlementPlan([e], new Map([["app.ts", "bad\ngood\n"]]), new Set(["good"]))
    expect(p.files.get("app.ts")).toBe("one\ngood\n")
    expect(p.kept[0]!.itemIds).toEqual(["good"])
  })
  it("keeps a shared hunk when ANY owner is verified (founder decision), and lists the unverified owner for review", () => {
    const e = entry("one", [{ offset: 0, removed: "one", inserted: "bad" }], [["bad", "good"]])
    const p = settlementPlan([e], new Map([["app.ts", "bad"]]), new Set(["good"]))
    expect(p.files.get("app.ts")).toBe("bad")
    expect(p.kept[0]!.itemIds).toEqual(["bad", "good"])
    expect(p.undone.size).toBe(0)
    expect(p.keptWith.get("bad")).toMatchObject({ why: "shared_lines", with: new Set(["good"]), files: new Set(["app.ts"]) })
    expect(keptWithLine("Bad job", ["Good job"], "shared_lines")).toBe('"Bad job": shared with "Good job", not verified on its own')
  })
  it("puts back a hunk no verified job owns, even when shared by two unverified jobs", () => {
    const e = entry("one", [{ offset: 0, removed: "one", inserted: "bad" }], [["bad", "worse"]])
    const p = settlementPlan([e], new Map([["app.ts", "bad"]]), new Set(["good"]))
    expect(p.files.get("app.ts")).toBe("one")
    expect([...p.undone].sort()).toEqual(["bad", "worse"])
  })
  it("an owner verified on an older tree never vouches for a newer hunk (verified on a tree that held it)", () => {
    const e = { ...entry("one", [{ offset: 0, removed: "one", inserted: "bad" }], [["bad", "good"]]), generation: 2 }
    const p = settlementPlan([e], new Map([["app.ts", "bad"]]), new Set(["good"]), { verifiedAt: new Map([["good", 1]]) })
    expect(p.files.get("app.ts")).toBe("one")
    expect(settlementPlan([e], new Map([["app.ts", "bad"]]), new Set(["good"]), { verifiedAt: new Map([["good", 2]]) }).files.get("app.ts")).toBe("bad")
  })
  it("reanchors later independent edits while restoring earlier unverified edits", () => {
    const a = entry("one\ntwo\n", [{ offset: 0, removed: "one", inserted: "long bad line" }], [["bad"]])
    const b = entry("long bad line\ntwo\n", [{ offset: 14, removed: "two", inserted: "good" }], [["good"]], 2)
    expect(settlementPlan([a, b], new Map([["app.ts", "long bad line\ngood\n"]]), new Set(["good"])).files.get("app.ts")).toBe("one\ngood\n")
  })
  it("keeps an unverified hunk a verified hunk builds on (never fails the verified job), preserving independent jobs", () => {
    const a = entry("one\ntwo\n", [{ offset: 0, removed: "one", inserted: "bad" }], [["bad"]])
    const b = entry("bad\ntwo\n", [{ offset: 0, removed: "bad", inserted: "later" }, { offset: 4, removed: "two", inserted: "good" }], [["dependent"], ["good"]], 2)
    const p = settlementPlan([a, b], new Map([["app.ts", "later\ngood\n"]]), new Set(["dependent", "good"]))
    expect(p.files.get("app.ts")).toBe("later\ngood\n")
    expect([...p.dependent]).toEqual([])
    expect(p.undone.size).toBe(0)
    expect(p.keptWith.get("bad")).toMatchObject({ why: "needed_by", with: new Set(["dependent"]) })
  })
  it("held for review: only open checks that cannot read environment values, or no local check at all", () => {
    const base = { owner: "agent" as const, state: "claimed" as const, claim: { status: "done" as const, note: "", at: "2026-10-08T00:00:00.000Z" } }
    expect(heldForReview({ ...base, checks: [{ id: "ga4_id_applied", tier: "S", state: "undetermined" }, { id: "build", tier: "B", state: "pass" }] })).toBe(true)
    expect(heldForReview({ ...base, checks: [{ id: "adopted_init_guarded", tier: "S", state: "info" }] })).toBe(true)
    expect(heldForReview({ ...base, checks: [{ id: "rehearsal", tier: "RH", state: "not_run" }] })).toBe(true)
    expect(heldForReview({ ...base, checks: [{ id: "click_test", tier: "T0", state: "undetermined" }] })).toBe(false)
    expect(heldForReview({ ...base, checks: [{ id: "ga4_id_applied", tier: "S", state: "undetermined" }, { id: "build", tier: "B", state: "problem" }] })).toBe(false)
    expect(heldForReview({ ...base, state: "pending", checks: [] })).toBe(false)
  })
})
