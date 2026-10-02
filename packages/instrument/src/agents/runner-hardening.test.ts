// The runner fixes from the O3 review (F10 crash recovery, F11 the seal, F20 model fallback), against the
// FAKE claude / codex binaries and the real built mcp-proxy. No real agent, no model, no network.
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner, RUN_ID } from "../../test/wizard/agents.js"
import { cleanup, item, makeFenceFixture, write } from "../../test/wizard/repo.js"
import type { RunJobsInput } from "../wizard/contracts/agents.js"
import { claudeModelRejected, modelRejectedText } from "./claude.js"
import { codexModelRejected } from "./codex.js"
import { Fence } from "./fence.js"
import { snapshotDir } from "./paths.js"
import type { AgentRunResultWithExtras } from "./runner.js"

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const ITEMS = [item("meta_improve:landing", ["app/layout.tsx", "app/page.tsx"])]
const CLAIM_DONE = { tool: "job_claim", args: { job_id: "meta_improve:landing", status: "done", note: "done" } }

function setup(scenario: unknown) {
  const { root } = makeFenceFixture()
  const fakes = fakeAgents(scenario)
  dirs.push(root, fakes.home)
  return { root, fakes }
}

function jobsInput() {
  const beats: string[] = []
  const input: RunJobsInput = {
    items: ITEMS,
    brief: "BRIEF",
    budget: { maxTurns: 30, wallMs: 60_000 },
    onClaim: () => undefined,
    onAsk: () => undefined,
    onProgress: () => undefined,
    onNarrate: (beat) => beats.push(beat.text)
  }
  return { input, beats }
}

describe("F10: a turn a killed wizard left open is undone before the next turn starts", () => {
  it("the crashed turn's agent edit is restored (never the new baseline), and the user is told", async () => {
    const { root, fakes } = setup({ turns: [{ steps: [CLAIM_DONE] }] })
    const before = readFileSync(join(root, "app/page.tsx"), "utf8")
    // An earlier process began a turn, the agent edited, and the process died mid-turn.
    const dir = snapshotDir(fakes.home, RUN_ID, "1-99999-old")
    await Fence.begin({ root, snapshotDir: dir, runId: RUN_ID, turn: 1, items: ITEMS })
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" })
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, pid: Number(dead.stdout) }))
    write(root, "app/page.tsx", "// unvetted edit from the crashed turn\n")
    const { input, beats } = jobsInput()
    const result = (await makeRunner(fakes, root).runJobs(input)) as AgentRunResultWithExtras
    expect(result.outcome).toBe("completed")
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).toBe(before)
    expect(result.edits).toEqual([])
    expect(beats.some((beat) => beat.startsWith("Undid an unfinished agent turn from an earlier run: app/page.tsx"))).toBe(true)
  })

  it("negative: with no leftover snapshot nothing is restored and nothing is said", async () => {
    const { root, fakes } = setup({ turns: [{ steps: [CLAIM_DONE] }] })
    const { input, beats } = jobsInput()
    await makeRunner(fakes, root).runJobs(input)
    expect(beats.some((beat) => beat.startsWith("Undid an unfinished agent turn"))).toBe(false)
  })
})

describe("F11: a kept turn returns its seal; an aborted one does not", () => {
  it("completed → seal of the settled tree; toolless → null", async () => {
    const ok = setup({ turns: [{ steps: [CLAIM_DONE] }] })
    const kept = (await makeRunner(ok.fakes, ok.root).runJobs(jobsInput().input)) as AgentRunResultWithExtras
    expect(kept.seal?.root).toBe(ok.root)
    const bad = setup({ turns: [{ mcp: "skip", steps: [] }] })
    const aborted = (await makeRunner(bad.fakes, bad.root).runJobs(jobsInput().input)) as AgentRunResultWithExtras
    expect(aborted.outcome).toBe("toolless")
    expect(aborted.seal).toBeNull()
  })
})

describe("F20: model fallback", () => {
  it("the Codex retry gets a fresh claim channel: a retry that never reaches it is toolless", async () => {
    const { root, fakes } = setup({ turns: [{ rejectModelAfterMcp: true, steps: [] }, { mcp: "skip", steps: [] }] })
    const result = (await makeRunner(fakes, root, { preferWorker: "codex" }).runJobs(jobsInput().input)) as AgentRunResultWithExtras
    expect(result.modelFallback).toBe(true)
    expect(result.outcome).toBe("toolless")
  })

  it("control: a retry that reaches the channel completes", async () => {
    const { root, fakes } = setup({ turns: [{ rejectModelAfterMcp: true, steps: [] }, { steps: [CLAIM_DONE] }] })
    const result = (await makeRunner(fakes, root, { preferWorker: "codex" }).runJobs(jobsInput().input)) as AgentRunResultWithExtras
    expect(result.modelFallback).toBe(true)
    expect(result.outcome).toBe("completed")
  })

  it("only the CLIs' model-not-found shapes for THE pinned model count as a refusal", () => {
    expect(modelRejectedText("There's an issue with the selected model (claude-opus-4-8). It may not exist or you may not have access to it.", "claude-opus-4-8")).toBe(true)
    expect(codexModelRejected("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", "gpt-6.1-sol")).toBe(true)
    expect(modelRejectedText('{"error":{"code":"model_not_found"}}', "gpt-6.1-sol")).toBe(true)
    // Negatives: an unrelated error that says "model … invalid", another model's name, no pinned model.
    expect(modelRejectedText("invalid request: the model output was not valid JSON", "claude-opus-4-8")).toBe(false)
    expect(modelRejectedText("Your data model is invalid: field `x` not found", "claude-opus-4-8")).toBe(false)
    expect(codexModelRejected("The 'gpt-5.5' model is not supported", "gpt-6.1-sol")).toBe(false)
    expect(codexModelRejected("The 'gpt-6.1-sol' model is not supported", null)).toBe(false)
    expect(claudeModelRejected({ kind: "assistant_error", error: "model_not_found" } as never, null)).toBe(false)
    expect(claudeModelRejected({ kind: "assistant_error", error: "model_not_found" } as never, "claude-opus-4-8")).toBe(true)
  })
})
