// Step `agent` against the REAL runner's detection over the fake claude/codex binaries, and a fake bridge.
import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { assertBuilt, fakeAgents, makeRunner } from "../../../test/wizard/agents.js"
import { cleanup, runGit, tempDir } from "../../../test/wizard/repo.js"
import { baseState, fakeBridge, makeCtx, makeDeps, STEP_RUN_ID } from "../../../test/wizard/agent-step-harness.js"
import { normalizeRemote, repoFingerprint } from "../../agents/repo-fingerprint.js"
import type { TagCapability } from "../contracts/bridge.js"
import type { WizardOptions } from "../contracts/deps.js"
import { step } from "./agent.js"

// These spawn real node fakes, the built mcp-proxy and git for up to 4 rounds: the 5 s default is too
// tight under a loaded full-suite run (review O3 F15).
vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => assertBuilt())
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

function repo() {
  const root = tempDir("infinite-tag-agent-step-")
  runGit(root, ["init", "-q", "-b", "main"])
  dirs.push(root)
  return root
}

async function runStep(input: { scenario?: unknown; options?: Partial<WizardOptions>; onlyClaude?: boolean; state?: ReturnType<typeof baseState>; startRunError?: unknown; patchRunError?: unknown; missing?: TagCapability[]; dirtyPaths?: string[] }) {
  const root = repo()
  const fakes = fakeAgents(input.scenario ?? {})
  dirs.push(fakes.home)
  if (input.onlyClaude) {
    // A PATH with a claude but no codex: copy the fake bin dir without codex.
    const only = join(fakes.home, "only-claude-bin")
    mkdirSync(only)
    symlinkSync(join(fakes.env.PATH.split(":")[0]!, "claude"), join(only, "claude"))
    fakes.env.PATH = [only, ...fakes.env.PATH.split(":").slice(1)].join(":")
  }
  const runner = makeRunner(fakes, root, { preferWorker: null })
  const { bridge, calls } = fakeBridge({ startRunError: input.startRunError, patchRunError: input.patchRunError, missing: input.missing })
  const { ctx, recorded, state } = makeCtx({ root, state: input.state ?? baseState({ root }), options: input.options })
  const deps = makeDeps({ bridge, agents: runner, ...(input.dirtyPaths ? { dirtyPaths: input.dirtyPaths } : {}) })
  const outcome = await step.run(ctx, deps)
  return { outcome, calls, recorded, state: state(), ctx, root }
}

describe("live run 5: the reviewer choice is remembered, and a changed reviewer reaches the cloud run", () => {
  it("--reviewer brief is kept in the run state; a plain re-run (no flag) reviews from the brief again, without re-detecting Codex", async () => {
    const first = await runStep({ options: { reviewer: "brief" } })
    expect(first.state.agent?.reviewer).toBe("brief")
    expect(first.state.agent?.reviewerChoice).toBe("brief")
    // The plain re-run: the same state, no flag. Codex is installed and logged in, yet the remembered choice wins.
    const again = await runStep({ state: first.state, options: {} })
    expect(again.state.agent?.reviewer).toBe("brief")
    expect(again.outcome).toMatchObject({ kind: "ok" })
    expect((again.outcome as { status: string }).status).toContain("a review brief is printed")
    // The step's inputs are the same with or without the flag once the choice is remembered (no reason to re-run it).
    const hashFlag = step.inputHash({ ...first.ctx, options: { ...first.ctx.options, reviewer: "brief" } } as never)
    const hashPlain = step.inputHash({ ...again.ctx, options: { ...again.ctx.options, reviewer: null } } as never)
    expect(hashPlain).toBe(hashFlag)
  })

  it("a re-run that changes the reviewer patches the cloud run's reviewer (tag.runs.reviewer.v1); an unchanged one sends nothing", async () => {
    const first = await runStep({})
    expect(first.state.agent?.reviewer).toBe("codex")
    const changed = await runStep({ state: first.state, options: { reviewer: "brief" } })
    expect(changed.calls.startRun).toHaveLength(0)
    expect(changed.calls.patchRun.map((call) => [call.runId, call.patch])).toEqual([[STEP_RUN_ID, { reviewer: "brief" }]])
    const same = await runStep({ state: changed.state, options: { reviewer: "brief" } })
    expect(same.calls.patchRun).toEqual([])
    // An older app without the capability is never sent a field it would reject.
    const old = await runStep({ state: first.state, options: { reviewer: "brief" }, missing: ["tag.runs.reviewer.v1"] })
    expect(old.calls.patchRun).toEqual([])
  })

  it("review P2-3: a reviewer change the cloud never acknowledged is sent on the next run (an app without the capability, updated later)", async () => {
    const first = await runStep({})
    expect(first.state.agent?.cloudReviewer).toBe("codex")
    // The old app cannot take the patch: nothing is sent, and the cloud still holds codex.
    const old = await runStep({ state: first.state, options: { reviewer: "brief" }, missing: ["tag.runs.reviewer.v1"] })
    expect(old.calls.patchRun).toEqual([])
    expect(old.state.agent?.cloudReviewer).toBe("codex")
    // The app is updated; a plain re-run (the remembered brief) now sends it, once.
    const updated = await runStep({ state: old.state, options: {} })
    expect(updated.calls.patchRun.map((call) => [call.runId, call.patch])).toEqual([[STEP_RUN_ID, { reviewer: "brief" }]])
    expect(updated.state.agent?.cloudReviewer).toBe("brief")
    const settled = await runStep({ state: updated.state, options: {} })
    expect(settled.calls.patchRun).toEqual([])
  })

  it("review 2 P3-b: a reviewer patch the cloud refuses (an older cloud: unknown field) is a warning, never a stop, and is sent again next run", async () => {
    const first = await runStep({})
    const refused = await runStep({ state: first.state, options: { reviewer: "brief" }, patchRunError: new Error("400 invalid_request: unknown field patch.reviewer") })
    expect(refused.outcome).toMatchObject({ kind: "ok" })
    expect(refused.calls.patchRun).toHaveLength(1)
    expect(refused.state.agent?.cloudReviewer).toBe("codex")
    const subs = refused.recorded.events.filter((event) => event.type === "step.sub").map((event) => String(event.fields.text))
    expect(subs.some((text) => text.startsWith("! Infinite did not record the reviewer change (400 invalid_request") && text.endsWith("it is sent again on the next run."))).toBe(true)
    const retried = await runStep({ state: refused.state, options: {} })
    expect(retried.calls.patchRun.map((call) => call.patch)).toEqual([{ reviewer: "brief" }])
    expect(retried.state.agent?.cloudReviewer).toBe("brief")
  })
})

describe("step agent", () => {
  it("§3y.8 (P3-11): a dirty tree fails DIRTY_TREE BEFORE the cloud run exists (no orphan run at 'before'); the wizard's own paths are exempt", async () => {
    const dirty = await runStep({ dirtyPaths: ["app/layout.tsx", ".gitignore", ".infinite/install.json"] })
    expect(dirty.outcome).toEqual({ kind: "failed", code: "INF_WIZ_DIRTY_TREE", message: "Commit or stash your changes first (app/layout.tsx); the wizard works on its own branch.", next: "halt" })
    expect(dirty.calls.startRun).toHaveLength(0)
    expect(dirty.state.runId).toBeNull()
    // NEGATIVE: only the exempt paths dirty → the run starts as usual.
    const clean = await runStep({ dirtyPaths: [".gitignore", ".infinite/wizard/state.json"] })
    expect(clean.calls.startRun).toHaveLength(1)
  })

  it("both agents: Claude works, Codex reviews; ends with exactly ONE startRun carrying both", async () => {
    const { outcome, calls, state, ctx, root, recorded } = await runStep({})
    expect(outcome).toEqual({ kind: "ok", status: "Claude Code does the work · Codex reviews it" })
    expect(calls.startRun).toHaveLength(1)
    expect(calls.startRun[0]).toEqual({
      tagVersion: "0.0.0-test",
      repoFingerprint: await repoFingerprint({ remoteUrl: "git@github.com:Acme/acme-store.git", root, appRoot: "." }),
      worker: "claude_code",
      reviewer: "codex"
    })
    expect(state.runId).toBe(STEP_RUN_ID)
    expect(ctx.runId).toBe(STEP_RUN_ID)
    expect(state.agent).toEqual({
      worker: "claude_code",
      reviewer: "codex",
      workerSession: null,
      whoPays: { worker: { payer: "plan", label: "your Claude plan (max) pays" }, reviewer: { payer: "plan", label: "your ChatGPT plan pays" } },
      // B22: the pinned models and efforts the run uses (River, 10-02), recorded in the run state
      models: {
        worker: { model: "claude-opus-4-8", effort: "xhigh", fallback: false },
        reviewer: { model: "gpt-6.1-sol", effort: "xhigh", fallback: false }
      },
      // Review P2-3: what the cloud run row was started with.
      cloudReviewer: "codex"
    })
    const subs = recorded.events.filter((event) => event.type === "step.sub").map((event) => event.fields.text)
    expect(subs).toContain("✓ Claude Code 2.1.287 · logged in · your Claude plan (max) pays")
    expect(subs).toContain("✓ Codex found · will review the pull request · your ChatGPT plan pays")
    // startRun is the LAST act: the state was saved after it.
    expect(recorded.saves).toBe(1)
  })

  it("one agent only → the reviewer is the printed brief", async () => {
    const { outcome, calls } = await runStep({ onlyClaude: true })
    expect(calls.startRun[0]).toMatchObject({ worker: "claude_code", reviewer: "brief" })
    expect(outcome).toMatchObject({ kind: "ok", status: "Claude Code does the work · a review brief is printed" })
  })

  it("--worker codex flips the roles; a logged-out Claude is listed, not used", async () => {
    const { calls, recorded } = await runStep({ options: { worker: "codex" }, scenario: { authExit: 1 } })
    expect(calls.startRun[0]).toMatchObject({ worker: "codex", reviewer: "brief" })
    expect(recorded.events.some((event) => event.fields.text === "Claude Code: not logged in")).toBe(true)
  })

  it("--no-agent → worker none (deterministic lanes only), still one startRun", async () => {
    const { calls, outcome } = await runStep({ options: { noAgent: true } })
    expect(calls.startRun).toEqual([expect.objectContaining({ worker: "none" })])
    expect(outcome).toMatchObject({ kind: "ok" })
  })

  it("nested mode: no agent is used; the parent agent does the jobs", async () => {
    const { calls, state } = await runStep({ options: { nested: true } })
    expect(calls.startRun).toEqual([expect.objectContaining({ worker: "none", reviewer: "brief" })])
    expect(state.agent?.worker).toBeNull()
  })

  it("a resumed run with a runId starts NO second run (negative)", async () => {
    const { calls, ctx } = await runStep({ state: baseState({ runId: "11111111-2222-4333-8444-555555555555" }) })
    expect(calls.startRun).toEqual([])
    expect(ctx.runId).toBe("11111111-2222-4333-8444-555555555555")
  })

  it("a missing runs capability → INF_WIZ_BRIDGE_PROTOCOL; a 402 → SUBSCRIPTION_REQUIRED (negatives)", async () => {
    expect((await runStep({ missing: ["tag.runs.v1"] })).outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL" })
    expect((await runStep({ startRunError: { code: "subscription_required" } })).outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
    await expect(runStep({ startRunError: new Error("socket hang up") })).rejects.toThrow(/socket hang up/)
  })
})

describe("repo fingerprint (§3a.3)", () => {
  it("normalises remotes so a credentialed URL never leaks", () => {
    expect(normalizeRemote("git@github.com:Acme/acme-store.git")).toBe("github.com/Acme/acme-store")
    expect(normalizeRemote("https://user:not-a-token@GitHub.com/Acme/acme-store.git?x=1#y")).toBe("github.com/Acme/acme-store")
    expect(normalizeRemote("ssh://git@github.com:22/Acme/acme-store.git")).toBe("github.com/Acme/acme-store")
    expect(normalizeRemote("ssh://git@git.acme.dev:2222/web.git")).toBe("git.acme.dev:2222/web")
    expect(normalizeRemote("")).toBeNull()
  })

  it("is sha256 of remote + appRoot, and of the path when there is no remote", async () => {
    const root = repo()
    const a = await repoFingerprint({ remoteUrl: "https://github.com/acme/web.git", root, appRoot: "apps/web" })
    const b = await repoFingerprint({ remoteUrl: "git@github.com:acme/web.git", root, appRoot: "apps/web" })
    const c = await repoFingerprint({ remoteUrl: "git@github.com:acme/web.git", root, appRoot: "apps/docs" })
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(await repoFingerprint({ remoteUrl: null, root, appRoot: "." })).not.toBe(a)
  })
})
