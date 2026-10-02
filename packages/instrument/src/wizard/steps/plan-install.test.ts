// Steps `plan` and `install` (lane O7), run against fakes (bridge, registry, agents) and a real
// fixture site on disk. No network, no agent, no cloud.
import { afterEach, describe, expect, it } from "vitest"

import {
  ADOPTED_POSTHOG_HTML,
  candidate,
  cleanupSites,
  fakeBefore,
  fakeContext,
  fakeDeps,
  fakeHosting,
  fakeKeys,
  fakeProductionDeniedConflict,
  fakeRegistry,
  IDS,
  makeSite,
  read,
  STATIC_HTML,
  type FakeContext
} from "../../../test/wizard/o7-fakes.js"
import { writeBeforeFacts } from "../../install/before-facts.js"
import { WizardInstaller } from "../../install/installer.js"
import type { WizardBeforeFacts } from "../../install/plan-model.js"
import { readInstallManifest } from "../../manifest.js"
import type { AskPayloads } from "../contracts/asks.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import type { RunPatch, SiteSourceBody } from "../contracts/bridge.js"
import type { WizardDeps } from "../contracts/deps.js"

import { step as installStep } from "./install.js"
import { step as planStep } from "./plan.js"

afterEach(cleanupSites)

interface Harness {
  ctx: FakeContext
  deps: WizardDeps
  patches: RunPatch[]
  siteSourceCalls: SiteSourceBody[]
  agentAlive: { value: boolean }
}

async function setup(input: {
  files: Record<string, string>
  answers?: unknown[]
  candidates?: ChecklistItem[]
  consentFlag?: "required" | "not_required" | null
  before?: WizardBeforeFacts
  siteSourceError?: { code: string }
}): Promise<Harness> {
  const root = makeSite(input.files)
  const ctx = fakeContext({ root, answers: input.answers, options: { consentMode: input.consentFlag ?? null } })
  ctx.state.update((state) => {
    state.jobs = input.candidates ?? []
  })
  const patches: RunPatch[] = []
  const siteSourceCalls: SiteSourceBody[] = []
  const agentAlive = { value: false }
  const installer = new WizardInstaller({
    repoFingerprint: IDS.fingerprint,
    runId: () => IDS.run,
    agent: () => ({ worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } }),
    consentFlag: () => input.consentFlag ?? null,
    productionDeniedConflict: fakeProductionDeniedConflict,
    build: async () => ({ ok: true, failureSignature: [], durationMs: 1 })
  })
  const deps = fakeDeps({
    installer,
    registry: fakeRegistry(),
    agents: { isAgentAlive: () => agentAlive.value } as WizardDeps["agents"],
    bridge: {
      has: () => true,
      patchRun: async (_runId: string, patch: RunPatch) => {
        patches.push(patch)
        return {} as never
      },
      ensureSiteSource: async (body: { productionHosts: string[]; consentMode: "required" | "not_required" }) => {
        siteSourceCalls.push({ protocolVersion: 1, requestId: "x", ...body })
        if (input.siteSourceError) throw Object.assign(new Error(input.siteSourceError.code), input.siteSourceError)
        return { protocolVersion: 1, requestId: "x", siteSourceKey: IDS.siteSource, productionHosts: body.productionHosts, consentMode: body.consentMode, created: false }
      }
    }
  })
  await writeBeforeFacts(deps.fs, root, IDS.run, input.before ?? fakeBefore())
  return { ctx, deps, patches, siteSourceCalls, agentAlive }
}

/** The answer a user gives by approving every approval line and picking a consent mode. */
function approveAllFrom(ctx: FakeContext, consentMode = "not_required") {
  const payload = ctx.asks[0]!.payload as AskPayloads["plan"]
  return {
    approved: payload.lines.filter((line) => line.requires === "approval").map((line) => line.id),
    declined: [],
    edits: { consent_mode: consentMode }
  }
}

describe("step plan", () => {
  it("opens exactly ONE ask (the plan), whose only questions are the four decisions; persists answers; PATCHes approvedConversions", async () => {
    const ga4Line = `install_provider:ga4:${IDS.ga4}`
    const answer = { approved: ["consent_mode", "conversion_names", ga4Line], declined: [], edits: { consent_mode: "required", conversion_names: "start_trial" } }
    const h = await setup({ files: { "index.html": STATIC_HTML }, answers: [answer], candidates: [candidate("server_conversions", "start_trial")] })
    const outcome = await planStep.run(h.ctx, h.deps)
    expect(outcome.kind).toBe("ok")
    expect(h.ctx.asks).toHaveLength(1)
    expect(h.ctx.asks[0]!.kind).toBe("plan")
    const payload = h.ctx.asks[0]!.payload as AskPayloads["plan"]
    expect(payload.lines.filter((line) => line.editable).map((line) => line.id).sort()).toEqual(["consent_mode", "conversion_names", "privacy_text"])
    expect(Object.keys(payload.decisions).sort()).toEqual(["consentMode", "conversionNames", "npmInstall", "privacyText"])
    const plan = h.ctx.stateValue().plan!
    expect(plan.answers).toMatchObject({ consentMode: "required", conversions: ["start_trial"] })
    expect(plan.lines.find((line) => line.id === ga4Line)?.approved).toBe(true)
    // Lines the user did not answer stay unanswered (null), never approved by default.
    expect(plan.lines.find((line) => line.id === `install_provider:meta:${IDS.meta}`)?.approved).toBeNull()
    expect(h.patches).toEqual([{ approvedConversions: ["start_trial"] }])
  })

  it("NEGATIVE: an unanswered consent mode ALWAYS parks the run here (INF_WIZ_NEEDS_ANSWERS); no PATCH, no jobs seeded", async () => {
    const answer = { approved: ["conversion_names"], declined: [], edits: {} }
    const h = await setup({ files: { "index.html": STATIC_HTML }, answers: [answer], candidates: [candidate("server_conversions", "start_trial")] })
    const outcome = await planStep.run(h.ctx, h.deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS" })
    expect(h.patches).toEqual([])
    expect(h.ctx.stateValue().plan?.answers.consentMode).toBeNull()
    // install never runs without it
    expect(await installStep.run(h.ctx, h.deps)).toMatchObject({ kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS" })
    expect(h.siteSourceCalls).toEqual([])
  })

  it("NEGATIVE: a cancelled plan ask parks, it never approves anything", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, answers: ["__cancelled__"] })
    expect(await planStep.run(h.ctx, h.deps)).toMatchObject({ kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS" })
    expect(h.ctx.stateValue().plan!.lines.every((line) => line.approved === null)).toBe(true)
  })

  it("--consent-mode answers the consent line; a resume of the same plan asks nothing again", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, answers: [{ approved: [], declined: [], edits: {} }], consentFlag: "not_required" })
    expect((await planStep.run(h.ctx, h.deps)).kind).toBe("ok")
    expect(h.ctx.stateValue().plan!.answers.consentMode).toBe("not_required")
    const asked = h.ctx.asks.length
    expect((await planStep.run(h.ctx, h.deps)).kind).toBe("ok")
    expect(h.ctx.asks.length).toBe(asked)
  })

  it("adopted PostHog: a declined improve line seeds no job 3; an unanswered one waits for the user", async () => {
    const candidates = [candidate("posthog_improve", "proxy"), candidate("posthog_improve", "history_change"), candidate("identify_reset", "auth")]
    const answer = { approved: ["consent_mode"], declined: ["improve_additive:posthog:proxy"], edits: { consent_mode: "not_required" } }
    const h = await setup({ files: { "index.html": ADOPTED_POSTHOG_HTML.replace(", defaults: '2025-05-24'", "") }, answers: [answer], candidates })
    expect((await planStep.run(h.ctx, h.deps)).kind).toBe("ok")
    const jobs = h.ctx.stateValue().jobs
    expect(jobs.map((item) => item.id)).not.toContain("posthog_improve:proxy")
    expect(jobs.find((item) => item.id === "posthog_improve:history_change")).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    expect(jobs.find((item) => item.id === "identify_reset:auth")?.state).toBe("pending")
  })
})

describe("step install", () => {
  it("records the consent answer through the site-source verb with the production hosts, then installs and receipts", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, answers: [] })
    h.ctx.asks.length = 0
    // plan first (answers come from the payload: approve everything, consent required)
    const ctx = h.ctx
    const realAsk = ctx.ask
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx, "required")
    }) as typeof realAsk
    expect((await planStep.run(ctx, h.deps)).kind).toBe("ok")
    const outcome = await installStep.run(ctx, h.deps)
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringMatching(/files? written · build passes/) })
    expect(h.siteSourceCalls).toEqual([{ protocolVersion: 1, requestId: "x", productionHosts: ["acme-store.com"], consentMode: "required" }])
    const html = read(ctx.root, "index.html")
    expect(html).toContain(IDS.ga4)
    expect(readInstallManifest(ctx.root)!.ids?.infinite).toEqual({ siteSourceKey: IDS.siteSource })
    expect(ctx.events.some((event) => event.type === "step.sub" && (event.fields as { text: string }).text === "✓ Build passes")).toBe(true)
  })

  it("never lists a preview-shaped host in the site source unless Infinite already does", async () => {
    const before = fakeBefore({
      keys: fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: [] } }),
      hosting: fakeHosting({ productionDomains: ["acme-store.com"], productionAliases: ["acme-store.vercel.app"] }),
      observedProductionHost: "acme-store.vercel.app"
    })
    const h = await setup({ files: { "index.html": STATIC_HTML }, before, consentFlag: "not_required", answers: [] })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    await installStep.run(ctx, h.deps)
    expect(h.siteSourceCalls[0]?.productionHosts).toEqual(["acme-store.com"])
  })

  it("a page the installer cannot edit becomes an open job 2, never 'installed'", async () => {
    const h = await setup({
      files: { "package.json": `{"dependencies":{"react":"18.0.0","vite":"5.0.0"}}\n`, "index.html": "<html><body><div id=root></div></body></html>\n", "vercel.json": "{}\n" },
      consentFlag: "not_required",
      answers: []
    })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    const outcome = await installStep.run(ctx, h.deps)
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringContaining("not live yet") })
    expect(ctx.stateValue().jobs.find((item) => item.id === "unusual_layout:index.html")).toMatchObject({ jobId: "unusual_layout", n: 2, state: "pending", allow: { files: ["index.html"] } })
  })

  it("NEGATIVE (engine invariant §3a.9.4): no site-source call while an agent child is alive", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [] })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    h.agentAlive.value = true
    await expect(installStep.run(ctx, h.deps)).rejects.toThrow(/agent is still running/)
    expect(h.siteSourceCalls).toEqual([])
    expect(read(ctx.root, "index.html")).toBe(STATIC_HTML)
  })

  it("an unsubscribed workspace blocks with INF_WIZ_SUBSCRIPTION_REQUIRED and writes nothing", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [], siteSourceError: { code: "subscription_required" } })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    expect(await installStep.run(ctx, h.deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
    expect(read(ctx.root, "index.html")).toBe(STATIC_HTML)
  })

  it("NEGATIVE: a site source that belongs to another site never lends this site its key", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [], siteSourceError: { code: "foreign_site_hosts" } })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    expect((await installStep.run(ctx, h.deps)).kind).toBe("ok")
    expect(read(ctx.root, "index.html")).not.toContain(IDS.siteSource)
    expect(readInstallManifest(ctx.root)!.ids?.infinite).toBeNull()
  })
})
