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

it.each(["refresh", "refresh_owner_decline"] as const)("prepares managed bytes before resumed agents: %s", async (mode) => {
  const fx = createGitFixture({ files: { "src/consent.ts": 'fbq("consent", "revoke");\n', "lib/infinite-analytics.ts": "// Managed by Infinite\ntype Track = (unused: string) => void\n", ".infinite/install.json": "{}\n", ".gitignore": ".infinite/wizard/\n" } })
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
  installer.buildPlan = () => ({} as never)
  const fresh = "// Managed by Infinite\ntype Track = (...args: [string]) => void\n"
  installer.refreshManaged = async () => {
    expect(await git.currentBranch()).toBe(branch)
    order.push("refresh")
    if (await git.showFile("HEAD", "lib/infinite-analytics.ts") === fresh) return { changedFiles: [], blocked: [] }
    fx.write("lib/infinite-analytics.ts", fresh)
    fx.write(".infinite/install.json", '{"refreshed":true}\n')
    return { changedFiles: ["lib/infinite-analytics.ts", ".infinite/install.json"], blocked: [] }
  }
  const ctx = testContext({ root: fx.root, answers: { confirm: payload => {
    expect(payload.question).toContain("owner consent fixture")
    expect(payload.question).toContain("own commit record")
    return mode !== "refresh_owner_decline"
  } }, state: initialState({ root: fx.root, git: { base: "main", baseSource: "vercel", baseSha, headSha: baseSha, branch }, pr: { host: "github", number: pr.number, url: pr.url, nodeId: pr.nodeId, isDraft: true, round: 1, reviewedSha: baseSha, handledThreadIds: [], mergeSha: null } }) })
  ctx.state.update(state => {
    for (const id of WIZARD_STEP_IDS) state.steps[id] = { outcome: "ok", inputHash: id, at: ctx.now().toISOString() }
    state.steps.link!.inputHash = "old-link"
    state.steps.agent!.inputHash = "old-agent"
  })
  const deps = testDeps({ bridge: fakeBridge(), agents: scriptedAgents({}), git, host, installer })
  await savePlanApprovals(ctx, deps, { planHash: ctx.state.get().plan!.hash, beforeAt: null, candidates: [], approvals: { approved: [], declined: [], edits: {} }, privacyText: null })
  const steps = Object.fromEntries(WIZARD_STEP_IDS.map(id => [id, { id, requiredCapabilities: [], inputHash: () => id, async run() {
    order.push(id)
    if (id === "agent") {
      expect(await git.head()).not.toBe(baseSha)
      expect(fx.remoteSha(branch)).toBe(await git.head())
      expect(await git.showFile("HEAD", "lib/infinite-analytics.ts")).toBe(fresh)
      const trailers = fx.git(["log", "-1", "--format=%(trailers:key=Infinite-Tag-Run,valueonly)"]).trim()
      expect(trailers).toContain(RUN_ID)
    }
    return { kind: "ok", status: id }
  } }])) as unknown as WizardStepRecord
  if (mode === "refresh_owner_decline") {
    fx.write("src/consent.ts", 'fbq("consent", "grant");\n')
    fx.git(["add", "src/consent.ts"]); fx.git(["commit", "-m", `owner consent fixture\n\nInfinite-Tag-Run: ${RUN_ID}`])
  }
  const result = await runWizard(ctx, deps, { steps, afterStep: async () => {} })
  if (mode === "refresh_owner_decline") {
    expect(ctx.asks.filter(ask => ask.kind === "confirm")).toHaveLength(1)
    expect(result.exitCode).toBe(3)
    expect(order).not.toContain("agent")
    expect(fx.remoteSha(branch)).not.toBe(await git.head())
  } else {
    expect(result.exitCode).toBe(0)
    expect(order.slice(0, 3)).toEqual(["link", "refresh", "agent"])
    expect(await deps.fs.readText(join(fx.root, "lib/infinite-analytics.ts"))).toBe(fresh)
  }
})
