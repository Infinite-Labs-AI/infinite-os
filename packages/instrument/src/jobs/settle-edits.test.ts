import { describe, expect, it } from "vitest"
import { applyTextEdits } from "../server-lane/text-edits.js"
import { editHash, settlementPlan, type AttributedEdit } from "./settle-edits.js"
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
  it("never keeps an unfinished shared hunk because another job passed", () => {
    const e = entry("one", [{ offset: 0, removed: "one", inserted: "bad" }], [["bad", "good"]])
    const p = settlementPlan([e], new Map([["app.ts", "bad"]]), new Set(["good"]))
    expect(p.files.get("app.ts")).toBe("one")
    expect(p.kept).toEqual([])
  })
  it("reanchors later independent edits while restoring earlier unverified edits", () => {
    const a = entry("one\ntwo\n", [{ offset: 0, removed: "one", inserted: "long bad line" }], [["bad"]])
    const b = entry("long bad line\ntwo\n", [{ offset: 14, removed: "two", inserted: "good" }], [["good"]], 2)
    expect(settlementPlan([a, b], new Map([["app.ts", "long bad line\ngood\n"]]), new Set(["good"])).files.get("app.ts")).toBe("one\ngood\n")
  })
  it("drops a verified job that depends on the unfinished hunk, preserving independent jobs", () => {
    const a = entry("one\ntwo\n", [{ offset: 0, removed: "one", inserted: "bad" }], [["bad"]])
    const b = entry("bad\ntwo\n", [{ offset: 0, removed: "bad", inserted: "later" }, { offset: 4, removed: "two", inserted: "good" }], [["dependent"], ["good"]], 2)
    const p = settlementPlan([a, b], new Map([["app.ts", "later\ngood\n"]]), new Set(["dependent", "good"]))
    expect(p.files.get("app.ts")).toBe("one\ngood\n")
    expect([...p.dependent]).toEqual(["dependent"])
  })
})
