// A review fix round uses the same trusted phase/count status as the jobs step.
import { describe, expect, it } from "vitest"

import { agentItem, baseState, fakeBridge, makeCtx, makeDeps } from "../../test/wizard/agent-step-harness.js"
import type { AgentRunnerImpl } from "../agents/runner.js"
import { runFixRound } from "./fix.js"
import { FIX_ROUND_MINUTES } from "./post.js"
import { createScanner } from "./scan.js"

describe("the review fix round's activity status", () => {
  it("counts tool activity and claims, and returns to writing after a claim", async () => {
    let t = Date.parse("2026-10-03T21:00:00.000Z")
    const clock = { now: () => new Date(t), sleep: async () => undefined }
    const items = [agentItem("review_comments:f1", ["app/signup/page.tsx"]), agentItem("review_comments:f2", ["app/layout.tsx"])]
    const runner = {
      isAgentAlive: () => false,
      killAll: async () => undefined,
      detect: async () => ({ worker: null, reviewer: null, available: [] }),
      review: async () => ({ error: "unparseable" as const }),
      runJobs: async (input: Parameters<AgentRunnerImpl["runJobs"]>[0]) => {
        input.onActivity?.({ kind: "read", path: "app/signup/page.tsx" })
        input.onActivity?.({ kind: "thinking", seconds: 30 })
        input.onNarrate({ agent: "claude_code", role: "worker", text: "Thinking · 30 s" })
        input.onClaim({ jobId: "review_comments:f1", status: "done", note: "moved the call", at: "2026-10-03T21:03:00.000Z" })
        t += 3 * 60_000 + 5_000
        input.onActivity?.({ kind: "thinking", seconds: 215 })
        input.onNarrate({ agent: "claude_code", role: "worker", text: "Thinking · 215 s" })
        input.onActivity?.({ kind: "edit", path: "app/layout.tsx" })
        input.onNarrate({ agent: "claude_code", role: "worker", text: "Editing app/layout.tsx" })
        return { outcome: "completed" as const, session: { kind: "claude" as const, sessionId: "s" }, claims: [], questions: [], permissionDenials: 0, reverted: [], edits: [] }
      }
    }
    const { bridge } = fakeBridge()
    const { ctx, recorded } = makeCtx({ root: "/repo", state: baseState({ root: "/repo" }) })
    const deps = { ...makeDeps({ bridge, agents: runner as never, env: { HOME: "/repo" } }), clock }
    const scanner = createScanner({ literals: [], allowedIds: [] })
    await runFixRound(ctx, deps, { step: "review", worker: "claude_code", items, scanner })
    const beats = recorded.events.filter((event) => event.type === "narrate").map((event) => (event.fields as { text: string }).text)
    expect(beats).toEqual(["Thinking · 30 s", "Thinking · 215 s", "Editing app/layout.tsx"])
    const statuses = recorded.events.filter((event) => event.type === "step.status").map((event) => (event.fields as { text: string }).text)
    expect(statuses).toContain(`Checking its work · job 1 of 2 · 1 files read · 0 edited · thinking 0 s · 1 of 2 claimed · 0 of ${FIX_ROUND_MINUTES} min`)
    expect(statuses.at(-1)).toBe(`Writing the changes · job 2 of 2 · 1 files read · 1 edited · thinking 0 s · 1 of 2 claimed · 3 of ${FIX_ROUND_MINUTES} min`)
  })
})

it.each(["known", "unknown", "claimed"] as const)("records %s consent refusals as informational and keeps unrelated repair items", async ownership => {
  const items = [agentItem("review_comments:f1", ["src/tracking.ts"]), agentItem("review_comments:f2", ["src/other.ts"])]
  const { bridge } = fakeBridge()
  const { ctx } = makeCtx({ root: "/repo", state: baseState({ root: "/repo" }) })
  const deps = makeDeps({ bridge, agents: {} as never })
  deps.agents = { runJobs: async (input: Parameters<AgentRunnerImpl["runJobs"]>[0]) => {
    for (const item of items) await input.onClaim({ jobId: item.id, status: ownership === "claimed" && item === items[0] ? "blocked" : "done", note: ownership === "claimed" && item === items[0] ? "Consent code is in the way" : "done", at: "2026-10-07T00:00:00Z" })
    return { outcome: "completed", session: { kind: "claude", sessionId: "s" }, claims: [], questions: [], permissionDenials: 0, reverted: ["src/tracking.ts"], edits: [],
      blocked: ownership === "known" ? [{ itemId: items[0]!.id, reason: "consent_touched", paths: ["src/tracking.ts"], note: "consent boundary" }] : [],
      strays: ownership === "unknown" ? [{ path: "src/tracking.ts", reason: "consent_touched", note: "owner unknown" }] : []
    } as never
  } } as never
  const result = await runFixRound(ctx, deps, { step: "review", worker: "claude_code", items, scanner: createScanner({ literals: [], allowedIds: [] }) })
  expect(result.items[0]).toMatchObject({ state: "left_for_you", checks: [] })
  expect(result.items[1]).toMatchObject({ state: "claimed" })
})
