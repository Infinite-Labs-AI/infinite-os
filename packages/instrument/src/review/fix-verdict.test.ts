// Review I1 P2-1: a review fix round's B verdict is the jobs step's (B26): a build that could not run, or ended
// red with no failure signature, is UNDETERMINED and the round is not ok, never a vacuous pass.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fakeBridge, fakeChecks, fakeRegistry, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import { buildVerdict } from "../checks/build.js"
import type { BuildResult, ChecklistItem } from "../wizard/contracts/jobs.js"
import { verifyFix } from "./fix.js"

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

async function verifyWith(build: BuildResult & { error?: string | null }, baseline: BuildResult = { ok: true, failureSignature: [], durationMs: 1 }) {
  const root = mkdtempSync(join(tmpdir(), "fix-verdict-"))
  dirs.push(root)
  const checks = { ...fakeChecks(), build: async () => build, buildBaseline: async () => baseline }
  const deps = testDeps({ bridge: fakeBridge({ capabilities: [] }), agents: {} as never, git: {} as never, host: {} as never, checks, registry: fakeRegistry() })
  const ctx = testContext({ root, state: initialState() })
  return verifyFix(ctx, deps, { runId: RUN_ID, items: [item()], editedFiles: ["app/layout.tsx"] })
}

describe("verifyFix: the B verdict (review I1 P2-1)", () => {
  it("a build that could not run (sandbox unavailable) is not ok, and the B check is undetermined, never pass", async () => {
    const result = await verifyWith({ ok: false, failureSignature: [], durationMs: 1, error: "sandbox-exec could not apply the profile" })
    expect(result.buildOk).toBe(false)
    const b = result.items[0]!.checks.find((check) => check.tier === "B")!
    expect(b.state).toBe("undetermined")
    expect(b.reason).toMatch(/^test_error/)
    expect(result.items[0]!.state).toBe("claimed")
  })

  it("red with no failure signature is undetermined, never a vacuous pass", async () => {
    const result = await verifyWith({ ok: false, failureSignature: [], durationMs: 1 })
    expect(result.buildOk).toBe(false)
    expect(result.items[0]!.checks.find((check) => check.tier === "B")!.state).toBe("undetermined")
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
