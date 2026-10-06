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
