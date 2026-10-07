import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { createFakeGh } from "../../test/wizard/fake-gh-harness.js"
import { fakeBridge, fakeInstaller, initialState, scriptedAgents, testContext, testDeps, RUN_ID } from "../../test/wizard/o4-fakes.js"
import { createGitOps } from "../git/index.js"
import { createGhClient } from "../github/gh.js"
import { createGitHubAdapter } from "../hosts/github.js"
import { savePlanApprovals } from "../install/step-inputs.js"
import type { WizardStepRecord } from "./contracts/deps.js"
import { WIZARD_STEP_IDS } from "./contracts/steps.js"
import { runWizard } from "./engine.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })

it.each(["refresh", "blocked", "closed", "merged", "push_retry", "push_retry_pull", "push_retry_pull_decline", "other_branch", "corrupt", "provisioned"] as const)("prepares managed bytes before resumed agents: %s", async (mode) => {
  const fx = createGitFixture({ files: { "lib/infinite-analytics.ts": "// Managed by Infinite\ntype Track = (unused: string) => void\n", ".infinite/install.json": mode === "provisioned" ? JSON.stringify({ providers: ["infinite"], ids: { infinite: { siteSourceKey: "site_saved_fixture" } } }) : "{}\n", ".gitignore": ".infinite/wizard/\n" } })
  fixtures.push(fx)
  const gh = createFakeGh({ dir: fx.dir, remote: fx.remote, env: fx.env })
  const git = createGitOps({ cwd: fx.root, env: gh.env })
  const branch = "infinite/tag/resume-fixture"
  const { baseSha } = await git.createBranch("main", branch)
  await git.push(branch)
  const host = createGitHubAdapter(createGhClient({ cwd: fx.root, env: gh.env }))
  fx.write(".infinite/wizard/pr-body.md", "fixture")
  const pr = await host.createDraftPr({ base: "main", head: branch, title: "fixture", bodyFile: ".infinite/wizard/pr-body.md" })
  const installer = fakeInstaller()
  const order: string[] = []
  installer.scan = async () => ({} as never)
  installer.buildPlan = (_scan, keys) => {
    if (mode === "provisioned") expect(keys.infinite).toMatchObject({ status: "ready", siteSourceKey: "site_saved_fixture", productionHosts: ["example.com"] })
    return {} as never
  }
  const fresh = "// Managed by Infinite\ntype Track = (...args: [string]) => void\n"
  installer.refreshManaged = async () => {
    expect(await git.currentBranch()).toBe(branch)
    order.push("refresh")
    if (mode === "blocked") return { changedFiles: [], blocked: ["lib/infinite-analytics.ts"] }
    if (await git.showFile("HEAD", "lib/infinite-analytics.ts") === fresh) return { changedFiles: [], blocked: [] }
    fx.write("lib/infinite-analytics.ts", fresh)
    fx.write(".infinite/install.json", '{"refreshed":true}\n')
    return { changedFiles: ["lib/infinite-analytics.ts", ".infinite/install.json"], blocked: [] }
  }
  const ctx = testContext({ root: fx.root, answers: { confirm: payload => {
    expect(payload.question).toContain("remote advance fixture")
    expect(payload.question).toContain("not created by this wizard")
    return mode !== "push_retry_pull_decline"
  } }, state: initialState({ root: fx.root, git: { base: "main", baseSource: "vercel", baseSha, headSha: baseSha, branch }, pr: { host: "github", number: pr.number, url: pr.url, nodeId: pr.nodeId, isDraft: true, round: 1, reviewedSha: baseSha, handledThreadIds: [], mergeSha: null } }) })
  ctx.state.update(state => {
    for (const id of WIZARD_STEP_IDS) state.steps[id] = { outcome: "ok", inputHash: id, at: ctx.now().toISOString() }
    state.steps.link!.inputHash = "old-link"
    state.steps.agent!.inputHash = "old-agent"
  })
  const deps = testDeps({ bridge: fakeBridge(), agents: scriptedAgents({}), git, host, installer })
  if (mode === "provisioned") {
    ctx.state.update(state => { state.site = { productionHost: "example.com", source: "answer", decidedAt: ctx.now().toISOString() } })
    const keys = await deps.bridge.keys()
    keys.infinite = { ...keys.infinite, status: "not_provisioned", productionHosts: [], siteSourceKey: null }
    const hosting = await deps.bridge.hosting()
    if (hosting.vercel) hosting.vercel.productionDomains = []
    fx.write(".infinite/wizard/before.json", JSON.stringify({ schema: "infinite-tag.before-facts.v1", runId: RUN_ID, measuredAt: ctx.now().toISOString(), facts: { keys, hosting, census: { entries: [] }, dryLive: null, observedProductionHost: null, localValidation: "measured", baselineBuild: { ok: true, signatureVersion: 3, failureSignature: [], durationMs: 1 } } }))
  }
  await savePlanApprovals(ctx, deps, { planHash: ctx.state.get().plan!.hash, beforeAt: null, candidates: [], approvals: { approved: [], declined: [], edits: {} }, privacyText: null })
  const steps = Object.fromEntries(WIZARD_STEP_IDS.map(id => [id, { id, requiredCapabilities: [], inputHash: () => id, async run() {
    order.push(id)
    if (id === "agent" && mode !== "closed" && mode !== "merged") {
      expect(await git.head()).not.toBe(baseSha)
      expect(fx.remoteSha(branch)).toBe(await git.head())
      expect(await git.showFile("HEAD", "lib/infinite-analytics.ts")).toBe(fresh)
      const trailers = fx.git(["log", mode.startsWith("push_retry_pull") ? "-3" : "-1", "--format=%(trailers:key=Infinite-Tag-Run,valueonly)"]).trim()
      expect(trailers).toContain(RUN_ID)
    }
    return { kind: "ok", status: id }
  } }])) as unknown as WizardStepRecord
  if (mode === "other_branch") await git.switchTo("main")
  if (mode === "corrupt") fx.write(".infinite/wizard/managed-refresh.json", "{broken")
  if (mode === "closed" || mode === "merged") gh.update(state => { state.prs![0]!.state = mode.toUpperCase() })
  if (mode.startsWith("push_retry_pull")) {
    const remote = fx.git(["commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "remote advance fixture"]).trim()
    fx.git(["push", "origin", `${remote}:refs/heads/${branch}`])
    expect((await runWizard(ctx, deps, { steps, afterStep: async () => {} })).exitCode).toBe(3)
    fx.git(["pull", "--no-rebase", "--no-edit", "origin", branch])
    order.length = 0
  }
  if (mode === "push_retry") {
    const push = git.push.bind(git)
    let attempts = 0
    git.push = async branchName => { if (attempts++ === 0) throw new Error("fixture push unavailable"); return push(branchName) }
    expect((await runWizard(ctx, deps, { steps, afterStep: async () => {} })).exitCode).toBe(3)
    expect(order).toEqual(["link", "refresh"])
    expect(fx.remoteSha(branch)).toBe(baseSha)
    order.length = 0
  }
  const result = await runWizard(ctx, deps, { steps, afterStep: async () => {} })
  if (mode.startsWith("push_retry_pull")) expect(ctx.asks.filter(ask => ask.kind === "confirm")).toHaveLength(1)
  if (mode === "push_retry_pull_decline") {
    expect(result.exitCode).toBe(3)
    expect(order).not.toContain("agent")
    expect(fx.remoteSha(branch)).not.toBe(await git.head())
  } else if (mode === "corrupt") {
    expect(result.exitCode).toBe(3)
    expect(order).toEqual(["link"])
    expect(await git.head()).toBe(baseSha)
  } else if (mode === "blocked") {
    expect(result.exitCode).toBe(3)
    expect(order).toEqual(["link", "refresh"])
    expect(await git.head()).toBe(baseSha)
  } else if (mode === "closed" || mode === "merged") {
    expect(result.exitCode).toBe(0)
    expect(order).toEqual(["link", "agent"])
    expect(await git.head()).toBe(baseSha)
  } else {
    expect(result.exitCode).toBe(0)
    const retry = mode === "push_retry" || mode === "push_retry_pull"
    expect(order.slice(0, retry ? 2 : 3)).toEqual(retry ? ["refresh", "agent"] : ["link", "refresh", "agent"])
    expect(await deps.fs.readText(join(fx.root, "lib/infinite-analytics.ts"))).toBe(fresh)
  }
})
