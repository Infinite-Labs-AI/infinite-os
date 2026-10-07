import { editHash } from "../jobs/settle-edits.js"
// Review I1 P2-1: a review fix round's B verdict is the jobs step's (B26): a build that could not run, or ended
// red with no failure signature, stays UNDETERMINED while the draft PR checks judge the change.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fakeBridge, fakeChecks, fakeRegistry, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import { buildVerdict } from "../checks/build.js"
import type { BuildResult, ChecklistItem } from "../wizard/contracts/jobs.js"
import { verifyFix, settleFixRound } from "./fix.js"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function item(): ChecklistItem {
  return {
    id: "review_comments:f1",
    jobId: "review_comments",
    n: 16,
    title: "Fix the review comment on app/layout.tsx",
    owner: "agent",
    trigger: { finding: "x", evidence: [{ file: "app/layout.tsx", line: 1 }] },
    allow: { files: ["app/layout.tsx"], create: [] },
    checks: [{ id: "build", tier: "B", state: "not_run" }],
    state: "claimed"
  }
}

async function verifyWith(build: BuildResult & { error?: string | null }, baseline: BuildResult = { ok: true, failureSignature: [], durationMs: 1 }, saved?: { localValidation: "measured" | "not_measured"; baselineBuild: BuildResult }) {
  const root = mkdtempSync(join(tmpdir(), "fix-verdict-"))
  dirs.push(root)
  const calls = { build: 0, baseline: 0 }
  const checks = { ...fakeChecks(), build: async () => { calls.build += 1; return build }, buildBaseline: async () => { calls.baseline += 1; return baseline } }
  const deps = testDeps({ bridge: fakeBridge({ capabilities: [] }), agents: {} as never, git: {} as never, host: {} as never, checks, registry: fakeRegistry() })
  const ctx = testContext({ root, state: initialState() })
  if (saved) await deps.fs.writeTextAtomic(join(root, ".infinite/wizard/before.json"), JSON.stringify({ schema: "infinite-tag.before-facts.v1", runId: RUN_ID, measuredAt: "2026-10-06T00:00:00Z", facts: { census: { entries: [] }, keys: {}, hosting: {}, ...saved } }))
  return { ...await verifyFix(ctx, deps, { runId: RUN_ID, items: [item()], editedFiles: ["app/layout.tsx"], edits: [{ id: "e1", file: "app/layout.tsx" }] }), calls }
}

describe("verifyFix: the B verdict (review I1 P2-1)", () => {
  it("a build that could not run (sandbox unavailable) defers to PR checks, and the B check is undetermined, never pass", async () => {
    const result = await verifyWith({ ok: false, failureSignature: [], durationMs: 1, error: "sandbox-exec could not apply the profile" })
    expect(result.buildOk).toBe(false)
    const b = result.items[0]!.checks.find((check) => check.tier === "B")!
    expect(b.state).toBe("undetermined")
    expect(b.reason).toMatch(/^test_error/)
    expect(result.items[0]!.state).toBe("pending")
  })

  it("red with no failure signature is undetermined, never a vacuous pass", async () => {
    const result = await verifyWith({ ok: false, failureSignature: [], durationMs: 1 })
    expect(result.buildOk).toBe(false)
    expect(result.items[0]!.checks.find((check) => check.tier === "B")!.state).toBe("undetermined")
  })

  it("honors the saved not-measured decision without executing another local check", async () => {
    const red = { ok: false, failureSignature: ["lint: app/layout.tsx | no-unused-vars | x"], durationMs: 1 }
    const result = await verifyWith(red, red, { localValidation: "not_measured", baselineBuild: red })
    expect(result.calls).toEqual({ build: 0, baseline: 0 })
    expect(result.items[0]!.checks[0]!.state).toBe("undetermined")
  })

  it("compares a measured fix against the saved base, never retaking a baseline on its edits", async () => {
    const red = { ok: false, failureSignature: ["lint: app/layout.tsx | no-unused-vars | x"], durationMs: 1 }
    const result = await verifyWith(red, red, { localValidation: "measured", baselineBuild: { ok: true, failureSignature: [], durationMs: 1 } })
    expect(result.calls).toEqual({ build: 1, baseline: 0 })
    expect(result.buildOk).toBe(false)
  })

  it("green is a pass; red with only the baseline's own failures is a pass; a new failure is a problem", async () => {
    expect((await verifyWith({ ok: true, failureSignature: [], durationMs: 1 })).buildOk).toBe(true)
    const known = { ok: false, failureSignature: ["TS2304 app/old.tsx"], durationMs: 1 }
    expect((await verifyWith(known, known)).buildOk).toBe(true)
    const fresh = await verifyWith({ ok: false, failureSignature: ["TS2304 app/layout.tsx"], durationMs: 1 }, known)
    expect(fresh.buildOk).toBe(false)
    expect(fresh.items[0]!.checks.find((check) => check.tier === "B")!.state).toBe("problem")
  })
})

describe("verifyFix: a review fix is ticked by its recorded change (LF4 close round 2, P1-1)", () => {
  it("the round's kept edits to the item's own files are recorded on it only when the build stands; another file's edit never is", async () => {
    const green = await verifyWith({ ok: true, failureSignature: [], durationMs: 1 })
    expect(green.items[0]!.edits).toEqual([{ editId: "e1", file: "app/layout.tsx" }])
    // NEGATIVE: a broken build puts the files back, so nothing is recorded on the item.
    const red = await verifyWith({ ok: false, failureSignature: ["TS2304 app/layout.tsx"], durationMs: 1 }, { ok: true, failureSignature: [], durationMs: 1 })
    expect(red.items[0]!.edits).toEqual([])
  })
})

describe("buildVerdict (the one B26 rule)", () => {
  it("reads the baseline only for a red build with a signature", async () => {
    let reads = 0
    const baseline = async () => {
      reads += 1
      return { failureSignature: [] }
    }
    expect(await buildVerdict({ ok: true, failureSignature: [], durationMs: 1 }, baseline)).toEqual({ state: "pass" })
    expect((await buildVerdict({ ok: false, failureSignature: [], durationMs: 1, error: "spawn failed" } as BuildResult, baseline)).state).toBe("undetermined")
    expect(reads).toBe(0)
    expect((await buildVerdict({ ok: false, failureSignature: ["x"], durationMs: 1 }, baseline)).state).toBe("problem")
    expect(reads).toBe(1)
  })
})


it("restores a shared review hunk and cannot close its verified co-owner after all edits are gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "fix-settlement-"))
  dirs.push(root)
  const file = "app/layout.tsx"
  mkdirSync(join(root, "app"))
  writeFileSync(join(root, file), "changed\n", { mode: 0o755 })
  const a = { ...item(), claim: { status: "done" as const, note: "Changed it", at: "2026-10-07T00:00:00Z" } }
  const b = { ...item(), id: "review_comments:f2", state: "blocked" as const, claim: { status: "blocked" as const, note: "Missing context", at: "2026-10-07T00:00:00Z" } }
  const deps = testDeps({ bridge: fakeBridge({ capabilities: [] }), agents: {} as never, git: {} as never, host: {} as never, checks: fakeChecks(), registry: fakeRegistry() })
  const ctx = testContext({ root, state: initialState() })
  const edit = { id: "one", jobId: "review_comments", by: "agent" as const, planLineId: null, file, runId: RUN_ID,
    beforeHash: editHash("original\n"), afterHash: editHash("changed\n"), textEdits: [{ offset: 0, removed: "original\n", inserted: "changed\n" }] }
  const settled = await settleFixRound(ctx, deps, RUN_ID, { items: [a, b], run: {
    outcome: "completed", session: null, claims: [], questions: [], permissionDenials: 0, reverted: [], edits: [edit],
    attribution: [{ editId: edit.id, itemIds: [a.id, b.id], textEditItems: [[a.id, b.id]] }]
  } as never })
  expect(readFileSync(join(root, file), "utf8")).toBe("original\n")
  expect(statSync(join(root, file)).mode & 0o777).toBe(0o755)
  expect(settled.edits).toEqual([])
  expect(settled.items.map(item => item.state)).toEqual(["left_for_you", "left_for_you"])
})
