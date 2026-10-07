// Steps `plan` and `install` (lane O7), run against fakes (bridge, registry, agents) and a real
// fixture site on disk. No network, no agent, no cloud.
import { existsSync } from "node:fs"
import { join } from "node:path"

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
  writeBeforeFacts,
  writeKeysChoices,
  type FakeContext
} from "../../../test/wizard/o7-fakes.js"
import { loadPlanInputs } from "../../install/step-inputs.js"
import { WizardInstaller } from "../../install/installer.js"
import type { WizardBeforeFacts } from "../../install/plan-model.js"
import { readInstallManifest } from "../../manifest.js"
import type { AskPayloads } from "../contracts/asks.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import type { ClaimPublic, RunPatch, SiteClaimBody, SiteClaimResponse, SiteSourceBody } from "../contracts/bridge.js"
import type { WizardDeps } from "../contracts/deps.js"

import { GITIGNORE_FENCE_BLOCK } from "../../harness/outputs.js"
import { reverseEditRecord, sha256Tagged } from "../../install/edits.js"
import { GITIGNORE_FENCE_LINE_ID, siteSourceHosts, step as installStep } from "./install.js"
import { step as planStep } from "./plan.js"

afterEach(cleanupSites)

interface Harness {
  ctx: FakeContext
  deps: WizardDeps
  patches: RunPatch[]
  siteSourceCalls: SiteSourceBody[]
  claimCalls: SiteClaimBody[]
  agentAlive: { value: boolean }
}

async function setup(input: {
  files: Record<string, string>
  answers?: unknown[]
  candidates?: ChecklistItem[]
  consentFlag?: "required" | "not_required" | null
  before?: WizardBeforeFacts
  siteSourceError?: { code: string; state?: string; retryable?: boolean }
  /** §3y.2: the app offers `tag.site-claim.v1` and answers `site-claim` with this (absent = an older app). */
  claim?: SiteClaimResponse
  /** Review P1-5: the workspace's newest claim (`site-claim-read`); absent = none. */
  heldClaim?: ClaimPublic | null
  /** §3y.1: this run's answered production host. */
  answeredHost?: string
}): Promise<Harness> {
  const root = makeSite(input.files)
  const ctx = fakeContext({ root, answers: input.answers, options: { consentMode: input.consentFlag ?? null } })
  ctx.state.update((state) => {
    state.jobs = input.candidates ?? []
    if (input.answeredHost) state.site = { productionHost: input.answeredHost, source: "answer", decidedAt: "2026-10-03T05:00:00.000Z" }
  })
  const claimCalls: SiteClaimBody[] = []
  const patches: RunPatch[] = []
  const siteSourceCalls: SiteSourceBody[] = []
  const agentAlive = { value: false }
  const installer = new WizardInstaller({
    repoFingerprint: IDS.fingerprint,
    runId: () => IDS.run,
    agent: () => ({ worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } }),
    consentFlag: () => input.consentFlag ?? null,
    productionDeniedConflict: fakeProductionDeniedConflict,
    build: async () => ({ ok: true, failureSignature: [], durationMs: 1 }),
    runFacts: () => ({ site: ctx.stateValue().site ?? null, siteClaim: input.claim !== undefined })
  })
  const deps = fakeDeps({
    installer,
    registry: fakeRegistry(),
    agents: { isAgentAlive: () => agentAlive.value } as WizardDeps["agents"],
    bridge: {
      has: (capability: string) => capability !== "tag.site-claim.v1" || input.claim !== undefined,
      siteClaim: async (body: Omit<SiteClaimBody, "protocolVersion" | "requestId">) => {
        claimCalls.push({ protocolVersion: 1, requestId: "x", ...body })
        if (input.siteSourceError) throw Object.assign(new Error(input.siteSourceError.code), input.siteSourceError)
        return input.claim!
      },
      readSiteClaim: async () => ({ protocolVersion: 1, requestId: "x", claim: input.heldClaim ?? null }),
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
  return { ctx, deps, patches, siteSourceCalls, claimCalls, agentAlive }
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
    expect(payload.lines.filter((line) => line.editable).map((line) => line.id).sort()).toEqual(["consent_mode", "conversion_names"])
    expect(Object.keys(payload.decisions).sort()).toEqual(["consentMode", "conversionNames", "npmInstall", "privacyText"])
    const plan = h.ctx.stateValue().plan!
    expect(plan.answers).toMatchObject({ consentMode: "required", conversions: ["start_trial"] })
    expect(plan.lines.find((line) => line.id === ga4Line)?.approved).toBe(true)
    // Lines the user did not answer stay unanswered (null), never approved by default.
    expect(plan.lines.find((line) => line.id === `install_provider:meta:${IDS.meta}`)?.approved).toBe(true)
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

  it("adopted PostHog repository improvements run on continue without per-line approvals", async () => {
    const candidates = [candidate("posthog_improve", "proxy"), candidate("posthog_improve", "history_change"), candidate("identify_reset", "auth")]
    const answer = { approved: ["consent_mode", "agent_budget"], declined: ["improve_additive:posthog:proxy"], edits: { consent_mode: "not_required" } }
    const h = await setup({ files: { "index.html": ADOPTED_POSTHOG_HTML.replace(", defaults: '2025-05-24'", "") }, answers: [answer], candidates })
    expect((await planStep.run(h.ctx, h.deps)).kind).toBe("ok")
    const jobs = h.ctx.stateValue().jobs
    expect(jobs.map((item) => item.id)).toContain("posthog_improve:proxy")
    expect(jobs.find((item) => item.id === "posthog_improve:history_change")).toMatchObject({ state: "pending" })
    expect(jobs.find((item) => item.id === "identify_reset:auth")?.state).toBe("pending")
  })

  it("terminal QA #13: the live line counts the agent jobs the plan's own agent line counts (the plan's seeds included)", async () => {
    // No detector candidate for the PostHog improvements: the plan seeds those jobs itself.
    const answer = { approved: ["consent_mode", "agent_budget"], declined: [], edits: { consent_mode: "not_required" } }
    const h = await setup({ files: { "index.html": ADOPTED_POSTHOG_HTML.replace(", defaults: '2025-05-24'", "") }, answers: [answer], candidates: [candidate("identify_reset", "auth")] })
    const outcome = await planStep.run(h.ctx, h.deps)
    const payload = h.ctx.asks[0]!.payload as AskPayloads["plan"]
    const budget = payload.lines.find((line) => line.kind === "agent_budget")!
    const inPlan = Number(/(\d+) (?:agent )?jobs?/.exec(budget.text)![1])
    expect(inPlan).toBeGreaterThan(1)
    const subs = h.ctx.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    const live = subs.find((text) => /agent jobs? · \d+ decisions? needs? you/.test(text))!
    expect(Number(/^Up to (\d+) agent jobs?/.exec(live)![1])).toBe(inPlan)
    // The closing status counts the jobs that RUN for these answers (§3y.5): never more than the plan's "up to".
    const status = (outcome as { status: string }).status
    expect(status).toMatch(/^Plan shown and continued · \d+ actions? · \d+ agent jobs?/)
    expect(Number(/· (\d+) agent jobs?/.exec(status)![1])).toBeLessThanOrEqual(inPlan)
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

  it("§3z.7 (A28): the site source lists keys ∪ the link's host hint ∪ the observed host, never a preview-shaped host", async () => {
    const before = fakeBefore({
      keys: fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: [] } }),
      hosting: fakeHosting({ productionDomains: ["acme-store.com"], productionAliases: ["acme-store.vercel.app"] }),
      observedProductionHost: "acme-store.vercel.app"
    })
    // The link's productionHostHint comes from the repo (a CNAME file), as the link step computed it.
    const h = await setup({ files: { "index.html": STATIC_HTML, CNAME: "acme-store.com\n" }, before, consentFlag: "not_required", answers: [] })
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

describe("§3y.2 the site-file claim at install (IO-3)", () => {
  const RESERVED = "site_fa4e000000000000000000000000c1a1"
  const BODY = "infinite-site-verification: isv_FAKEacmeProofToken0000\n"
  const freshKeys = () => ({ ...fakeKeys(), infinite: { status: "not_provisioned" as const, siteSourceKey: null, productionHosts: [], consentMode: null, consentStorageKey: null, collectPath: null } })
  const pendingClaim = (hosts: string[]): ClaimPublic => ({
    hosts,
    siteSourceKey: RESERVED,
    consentMode: "not_required",
    collectPath: "/infinite/ledger",
    consentStorageKey: "infinite_analytics_consent",
    proofPath: "/.well-known/infinite-site-verification.txt",
    proofBody: BODY,
    state: "pending_proof",
    provenHosts: [],
    lastCheck: null,
    expiresAt: "2026-11-01T09:20:00.000Z"
  })
  /** A fresh workspace: no site source, no Vercel connection in Infinite (the repo's own vercel.json says Vercel serves it). */
  const freshBefore = () => fakeBefore({ keys: freshKeys(), hosting: { provider: "none", vercel: null }, observedProductionHost: null })
  const runPlanAndInstall = async (h: Harness) => {
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    return installStep.run(ctx, h.deps)
  }

  it("pending_proof: the managed tag carries the RESERVED key and the proof file is written where the site serves it, recorded as the wizard's", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML, "vercel.json": "{}\n" }, consentFlag: "not_required", answers: [], before: freshBefore(), answeredHost: "fresh-acme.com", claim: { protocolVersion: 1, requestId: "x", state: "pending_proof", siteSource: null, claim: pendingClaim(["fresh-acme.com"]) } })
    const outcome = await runPlanAndInstall(h)
    expect(outcome.kind).toBe("ok")
    expect(h.siteSourceCalls).toEqual([])
    expect(h.claimCalls).toEqual([{ protocolVersion: 1, requestId: "x", runId: IDS.run, productionHosts: ["fresh-acme.com"], consentMode: "not_required" }])
    // The plan said how the domain is confirmed, right under the Infinite line.
    const lines = (h.ctx.asks[0]!.payload as AskPayloads["plan"]).lines
    expect(lines.find((line) => line.id === "info:infinite_site_file")?.text).toContain("/.well-known/infinite-site-verification.txt")
    expect(read(h.ctx.root, "index.html")).toContain(RESERVED)
    expect(read(h.ctx.root, ".well-known/infinite-site-verification.txt")).toBe(BODY)
    const receipt = readInstallManifest(h.ctx.root)!
    expect(receipt.ids?.infinite).toEqual({ siteSourceKey: RESERVED })
    expect(receipt.edits!.find((edit) => edit.file === ".well-known/infinite-site-verification.txt")).toMatchObject({ by: "wizard", planLineId: "install_provider:infinite", jobId: null })
    expect(h.ctx.stateValue().site?.claim).toMatchObject({ siteSourceKey: RESERVED, state: "pending_proof", hosts: ["fresh-acme.com"] })
  })

  it("ready: the claim verb answers the source (hosts verified) and the install is exactly the site-source path; no proof file", async () => {
    const h = await setup({
      files: { "index.html": STATIC_HTML },
      consentFlag: "not_required",
      answers: [],
      claim: { protocolVersion: 1, requestId: "x", state: "ready", siteSource: { siteSourceKey: IDS.siteSource, productionHosts: ["acme-store.com"], consentMode: "not_required", created: false }, claim: null }
    })
    expect((await runPlanAndInstall(h)).kind).toBe("ok")
    expect(h.claimCalls).toHaveLength(1)
    expect(read(h.ctx.root, "index.html")).toContain(IDS.siteSource)
    expect(existsSync(join(h.ctx.root, ".well-known/infinite-site-verification.txt"))).toBe(false)
    expect(h.ctx.stateValue().site?.claim).toBeUndefined()
  })

  it("review P1-5: ready with the workspace's PROVEN claim on these hosts → the proof file stays in the repo, so previews serve it", async () => {
    const proven: ClaimPublic = { ...pendingClaim(["acme-store.com"]), state: "proven", provenHosts: ["acme-store.com"], siteSourceKey: IDS.siteSource }
    const h = await setup({
      files: { "index.html": STATIC_HTML },
      consentFlag: "not_required",
      answers: [],
      claim: { protocolVersion: 1, requestId: "x", state: "ready", siteSource: { siteSourceKey: IDS.siteSource, productionHosts: ["acme-store.com"], consentMode: "not_required", created: false }, claim: null },
      heldClaim: proven
    })
    expect((await runPlanAndInstall(h)).kind).toBe("ok")
    expect(read(h.ctx.root, ".well-known/infinite-site-verification.txt")).toBe(BODY)
    expect(readInstallManifest(h.ctx.root)!.edits!.find((edit) => edit.file === ".well-known/infinite-site-verification.txt")).toMatchObject({ by: "wizard", planLineId: "install_provider:infinite", jobId: null })
    // The run's own claim state is untouched: the source is ready, nothing is pending.
    expect(h.ctx.stateValue().site?.claim).toBeUndefined()
  })

  it("review P1-5 NEGATIVE: a proven claim on OTHER hosts, or an expired one, writes no proof file", async () => {
    for (const held of [
      { ...pendingClaim(["other-site.com"]), state: "proven" as const, provenHosts: ["other-site.com"] },
      { ...pendingClaim(["acme-store.com"]), state: "expired" as const }
    ]) {
      const h = await setup({
        files: { "index.html": STATIC_HTML },
        consentFlag: "not_required",
        answers: [],
        claim: { protocolVersion: 1, requestId: "x", state: "ready", siteSource: { siteSourceKey: IDS.siteSource, productionHosts: ["acme-store.com"], consentMode: "not_required", created: false }, claim: null },
        heldClaim: held
      })
      expect((await runPlanAndInstall(h)).kind).toBe("ok")
      expect(existsSync(join(h.ctx.root, ".well-known/infinite-site-verification.txt"))).toBe(false)
    }
  })

  it("NEGATIVE: a static site whose vercel.json builds into another directory → the Infinite line is a user_action naming it; nothing is claimed", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML, "vercel.json": JSON.stringify({ outputDirectory: "dist" }) }, consentFlag: "not_required", answers: [], before: freshBefore(), answeredHost: "fresh-acme.com", claim: { protocolVersion: 1, requestId: "x", state: "pending_proof", siteSource: null, claim: pendingClaim(["fresh-acme.com"]) } })
    await runPlanAndInstall(h)
    const lines = (h.ctx.asks[0]!.payload as AskPayloads["plan"]).lines
    expect(lines.some((line) => line.id === "install_provider:infinite")).toBe(false)
    expect(lines.find((line) => line.id === "user_action:infinite_blocked")?.text).toBe("Infinite: your site builds into dist; put .well-known/infinite-site-verification.txt there, then run again.")
    expect(h.claimCalls).toEqual([])
    expect(read(h.ctx.root, "index.html")).not.toContain(RESERVED)
  })

  it("NEGATIVE: an older app (no tag.site-claim.v1) and no Vercel connection serving the host → no Infinite line to approve, no tag", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML, "vercel.json": "{}\n" }, consentFlag: "not_required", answers: [], before: freshBefore(), answeredHost: "fresh-acme.com" })
    await runPlanAndInstall(h)
    const lines = (h.ctx.asks[0]!.payload as AskPayloads["plan"]).lines
    expect(lines.some((line) => line.id === "install_provider:infinite")).toBe(false)
    expect(lines.find((line) => line.id === "user_action:infinite")?.text).toBe(
      "Infinite: update the Infinite app (or connect your website in Infinite › Connections › GitHub · Website) so it can confirm fresh-acme.com; then run again."
    )
    expect(h.siteSourceCalls).toEqual([])
    expect(readInstallManifest(h.ctx.root)?.ids?.infinite ?? null).toBeNull()
  })
})

describe("siteSourceHosts: only the site's own domain (founder ruling 2026-10-03)", () => {
  const noHosts = () => fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: [] } })

  it("NEGATIVE: no Vercel or platform address joins the claim, as the run's host or the observed one", () => {
    for (const host of ["acme-store.vercel.app", "acme-store-git-main-acme.vercel.app", "acme-store-a1b2c3d4e-acme.vercel.app", "vercel.app", "github.io", "acme.github.io", "acme.netlify.app"]) {
      expect(siteSourceHosts(noHosts(), host, host), host).toEqual([])
      expect(siteSourceHosts(noHosts(), "acme-store.com", host), host).toEqual(["acme-store.com"])
    }
  })

  it("a custom domain (and its observed www twin) joins", () => {
    expect(siteSourceHosts(noHosts(), "acme-store.com", "www.acme-store.com")).toEqual(["acme-store.com", "www.acme-store.com"])
  })
})

describe("§3z.7 / §3z.4 site-source refusals (I1)", () => {
  const run = async (siteSourceError: { code: string; state?: string }) => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [], siteSourceError })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    return { h, ctx, outcome: await installStep.run(ctx, h.deps) }
  }

  it("unverified_host: no Infinite pixel, one 'prove the domain' line, the other tools go on", async () => {
    const { ctx, outcome } = await run({ code: "invalid_request", state: "unverified_host" })
    expect(outcome.kind).toBe("ok")
    expect(read(ctx.root, "index.html")).not.toContain(IDS.siteSource)
    expect(readInstallManifest(ctx.root)!.ids?.infinite).toBeNull()
    expect(readInstallManifest(ctx.root)!.ids?.ga4).toEqual([IDS.ga4])
  })

  it("a 423 lock on site-source parks INF_WIZ_SITE_LOCKED and writes nothing", async () => {
    const { ctx, outcome } = await run({ code: "site_setup_locked", state: "live_site_lock" })
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_SITE_LOCKED" })
    expect(read(ctx.root, "index.html")).toBe(STATIC_HTML)
  })

  it("negative: an invalid_request with no known state is not swallowed", async () => {
    await expect(run({ code: "invalid_request" })).rejects.toThrow(/invalid_request/)
  })

  it("§3x.8: Infinite's own workspace (409 infinite_workspace) halts INFINITE_WORKSPACE and installs nothing", async () => {
    const { ctx, outcome } = await run({ code: "foreign_site_hosts", state: "infinite_workspace" })
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_INFINITE_WORKSPACE", next: "halt" })
    expect((outcome as { message: string }).message).toBe("This workspace is Infinite's own and cannot take a customer site. Run npx infinite-tag --relink and pick another workspace.")
    // Not a "collects for another site" line with GA4 / PostHog installed anyway.
    expect(read(ctx.root, "index.html")).toBe(STATIC_HTML)
  })

  it("negative: another site's hosts (409 foreign_site_hosts, no state) stays a line and the other tools go on", async () => {
    const { ctx, outcome } = await run({ code: "foreign_site_hosts" })
    expect(outcome.kind).toBe("ok")
    expect(readInstallManifest(ctx.root)!.ids?.infinite).toBeNull()
  })
})

describe("B24: the wizard's .gitignore fence is a receipted edit", () => {
  const FENCED = `node_modules/\n\n${GITIGNORE_FENCE_BLOCK}\n`
  const run = async (headText: string | null) => {
    const h = await setup({ files: { "index.html": STATIC_HTML, ".gitignore": FENCED }, consentFlag: "not_required", answers: [] })
    const shown: string[] = []
    h.deps.git = {
      statusEntries: async () => [],
      showFile: async (rev: string, path: string) => {
        shown.push(`${rev}:${path}`)
        return headText
      },
      unstage: async () => undefined,
      stagedDiff: async () => ""
    } as unknown as WizardDeps["git"]
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    await planStep.run(ctx, h.deps)
    expect((await installStep.run(ctx, h.deps)).kind).toBe("ok")
    return { ctx, shown }
  }

  it("records the fence against the committed .gitignore (by: wizard, planLineId gitignore_fence), and its reversal restores HEAD's text", async () => {
    const { ctx, shown } = await run("node_modules/\n")
    expect(shown).toEqual(["HEAD:.gitignore"])
    const fence = (readInstallManifest(ctx.root)!.edits ?? []).filter((edit) => edit.file === ".gitignore")
    expect(fence).toHaveLength(1)
    expect(fence[0]).toMatchObject({ by: "wizard", planLineId: GITIGNORE_FENCE_LINE_ID, jobId: null, runId: IDS.run, beforeHash: sha256Tagged("node_modules/\n") })
    expect(reverseEditRecord(FENCED, fence[0]!)).toEqual({ ok: true, content: "node_modules/\n" })
  })

  it("NEGATIVE: a fence already committed at HEAD (a resumed run) records nothing", async () => {
    const { ctx } = await run(FENCED)
    expect((readInstallManifest(ctx.root)!.edits ?? []).filter((edit) => edit.file === ".gitignore")).toEqual([])
  })
})

describe("review fixes (O7 fix round)", () => {
  function autoApprove(ctx: FakeContext, filter: (id: string) => boolean = () => true) {
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      const all = approveAllFrom(ctx)
      return { ...all, approved: all.approved.filter(filter), declined: all.approved.filter((id) => !filter(id)) }
    }) as typeof ctx.ask
  }

  it("P1-9: the plan reads lane O8's before.json (facts + baseline + baseline build) and lane O2's GA4 stream choice", async () => {
    const twoStreams = fakeKeys({
      ga4: {
        status: "connected",
        propertyLabel: "Acme",
        streams: [
          { measurementId: IDS.ga4, defaultUri: "https://other.example", streamName: "Other" },
          { measurementId: IDS.ga4Other, defaultUri: "https://another.example", streamName: "Web" }
        ]
      }
    })
    const baselineBuild = { ok: false, failureSignature: ["old failure"], durationMs: 1 }
    const h = await setup({ files: { "index.html": STATIC_HTML }, before: { ...fakeBefore({ keys: twoStreams }), baselineBuild }, consentFlag: "not_required", answers: [] })
    const inputs = await loadPlanInputs(h.ctx, h.deps)
    expect("before" in inputs && inputs.before.baselineBuild).toEqual(baselineBuild)
    // NEGATIVE: with two streams and no choice, GA4 is never guessed.
    autoApprove(h.ctx)
    await planStep.run(h.ctx, h.deps)
    let payload = h.ctx.asks.at(-1)!.payload as AskPayloads["plan"]
    expect(payload.lines.some((line) => line.id.startsWith("install_provider:ga4"))).toBe(false)
    // The keys step picked a stream: exactly that one is offered.
    await writeKeysChoices(h.deps.fs, h.ctx.root, { ga4MeasurementId: IDS.ga4Other, metaPixel: null })
    h.ctx.state.update((state) => {
      state.plan = null
    })
    await planStep.run(h.ctx, h.deps)
    payload = h.ctx.asks.at(-1)!.payload as AskPayloads["plan"]
    expect(payload.lines.map((line) => line.id)).toContain(`install_provider:ga4:${IDS.ga4Other}`)
    expect(payload.lines.map((line) => line.id)).not.toContain(`install_provider:ga4:${IDS.ga4}`)
  })

  it("P1-9 NEGATIVE: a before.json of another schema (another lane's hand-off) is never read as before's facts", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [] })
    await h.deps.fs.writeTextAtomic(`${h.ctx.root}/.infinite/wizard/before.json`, JSON.stringify({ schema: "infinite-tag.wizard-before-facts.v1", facts: fakeBefore() }))
    let bridgeKeysRead = 0
    ;(h.deps.bridge as unknown as { keys: () => Promise<unknown> }).keys = async () => {
      bridgeKeysRead += 1
      return { protocolVersion: 1, requestId: "x", ...fakeKeys() }
    }
    ;(h.deps.bridge as unknown as { hosting: () => Promise<unknown> }).hosting = async () => ({ protocolVersion: 1, requestId: "x", ...fakeHosting() })
    ;(h.deps as unknown as { checks: unknown }).checks = { census: async () => fakeBefore().census }
    const inputs = await loadPlanInputs(h.ctx, h.deps)
    expect(bridgeKeysRead).toBe(1)
    expect("liveFacts" in inputs && inputs.liveFacts).toBe(false)
  })

  it("P2-15: a plan that changed before install parks AND forgets the old plan, so the resume asks again", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [] })
    autoApprove(h.ctx)
    h.ctx.state.update((state) => {
      state.steps.plan = { outcome: "ok", inputHash: `sha256:${"1".repeat(64)}`, at: "2026-10-02T10:02:00.000Z" }
    })
    await planStep.run(h.ctx, h.deps)
    // The connections changed between plan and install (GA4 disconnected).
    await writeBeforeFacts(h.deps.fs, h.ctx.root, IDS.run, fakeBefore({ keys: fakeKeys({ ga4: { status: "not_connected", propertyLabel: null, streams: [] } }) }))
    expect(await installStep.run(h.ctx, h.deps)).toMatchObject({ kind: "parked", reason: expect.stringMatching(/re-confirm/) })
    expect(h.ctx.stateValue().steps.plan).toBeUndefined()
    expect(h.ctx.stateValue().plan).toBeNull()
    expect(h.siteSourceCalls).toEqual([])
    expect(read(h.ctx.root, "index.html")).toBe(STATIC_HTML)
  })

  it("continuing a plan authorizes installation even with a legacy per-line decline", async () => {
    const h = await setup({ files: { "index.html": STATIC_HTML }, consentFlag: "not_required", answers: [] })
    autoApprove(h.ctx, (id) => !id.startsWith("install_provider:infinite"))
    await planStep.run(h.ctx, h.deps)
    expect((await installStep.run(h.ctx, h.deps)).kind).toBe("ok")
    expect(h.siteSourceCalls).toHaveLength(1)
    expect(read(h.ctx.root, "index.html")).toContain(IDS.ga4)
  })

  it("P2-19: the approved plan persists the guard, and job 7 carries its exempt hosts", async () => {
    const meta = STATIC_HTML.replace("</head>", `<script>fbq('init', '${IDS.meta}');</script>\n  </head>`)
    const h = await setup({ files: { "index.html": meta }, consentFlag: "not_required", answers: [], candidates: [candidate("preview_guard", "meta")] })
    autoApprove(h.ctx)
    await planStep.run(h.ctx, h.deps)
    const job7 = h.ctx.stateValue().jobs.find((item) => item.id === "preview_guard:meta")
    expect(job7?.trigger.finding).toContain("ALWAYS fire (exempt first): acme-store.com")
    const saved = JSON.parse(read(h.ctx.root, ".infinite/wizard/plan-approvals.json")) as { guard: { emit: boolean; exempt: string[] } }
    expect(saved.guard).toMatchObject({ emit: true, exempt: ["acme-store.com"] })
  })
})

describe("a Next site with its OWN next.config (review I1 P1-2)", () => {
  const NEXT_FILES = {
    "package.json": `{"dependencies":{"next":"15.0.0","react":"19.0.0"}}\n`,
    "app/layout.tsx": "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  )\n}\n",
    "app/page.tsx": "export default function Page() {\n  return <main>Acme</main>\n}\n",
    "next.config.mjs": "/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true }\n\nexport default nextConfig\n"
  }

  async function runBoth(files: Record<string, string>) {
    const h = await setup({ files, consentFlag: "not_required", answers: [] })
    const ctx = h.ctx
    ctx.ask = (async (kind: never, payload: never) => {
      ctx.asks.push({ kind, payload })
      return approveAllFrom(ctx)
    }) as typeof ctx.ask
    const plan = await planStep.run(ctx, h.deps)
    const install = await installStep.run(ctx, h.deps)
    return { h, ctx, plan, install }
  }

  it("installs everything else, never edits the user's config, says so on the plan, and seeds a checked rewrite job", async () => {
    const { h, ctx, plan, install } = await runBoth(NEXT_FILES)
    expect(plan.kind).toBe("ok")
    const lines = (ctx.asks[0]!.payload as AskPayloads["plan"]).lines
    expect(lines.find((line) => line.id === "user_action:next_config_rewrites")?.text).toContain("next.config.mjs")
    expect(lines.some((line) => line.id === "user_action:install_blocked")).toBe(false)
    // PostHog installs straight to its region: no /ingest promise without a rewrite behind it.
    expect(lines.find((line) => line.id.startsWith("install_provider:posthog"))?.text).not.toContain("/ingest")
    expect(install.kind).toBe("ok")
    expect(read(h.ctx.root, "next.config.mjs")).toBe(NEXT_FILES["next.config.mjs"])
    expect(read(h.ctx.root, "app/layout.tsx")).toContain("InfiniteAnalyticsClient")
    const job = ctx.stateValue().jobs.find((item) => item.id === "unusual_layout:next_config_rewrites")!
    expect(job).toMatchObject({ owner: "agent", state: "pending", allow: { files: ["next.config.mjs"], create: [] } })
    expect(job.checks.map((check) => `${check.tier}:${check.id}`)).toEqual(["S:next_rewrites_exact", "B:build"])
    expect(job.trigger.finding).toContain("/infinite/ledger")
    expect(h.siteSourceCalls).toHaveLength(1)
  })

  it("negative: a config that already has the exact rewrites gets no job and no plan line", async () => {
    const withRewrites = {
      ...NEXT_FILES,
      "next.config.mjs": `export default {\n  async rewrites() {\n    return [\n      { source: "/infinite/ledger", destination: "https://api.ultima.inc/api/analytics/events/collect" }\n    ]\n  }\n}\n`
    }
    const { ctx, install } = await runBoth(withRewrites)
    expect(install.kind).toBe("ok")
    expect((ctx.asks[0]!.payload as AskPayloads["plan"]).lines.some((line) => line.id === "user_action:next_config_rewrites")).toBe(false)
    expect(ctx.stateValue().jobs.some((item) => item.id === "unusual_layout:next_config_rewrites")).toBe(false)
  })

  it("an install the harness would refuse stops BEFORE the site source is written, and the plan said so", async () => {
    const { h, ctx, install } = await runBoth({ ...NEXT_FILES, "next.config.js": "module.exports = {}\n" })
    expect((ctx.asks[0]!.payload as AskPayloads["plan"]).lines.find((line) => line.id === "user_action:install_blocked")?.text).toMatch(/multiple Next configs/)
    expect(install).toMatchObject({ kind: "failed", code: "INF_WIZ_APPLY_ROLLED_BACK" })
    expect((install as { message: string }).message).toContain("Nothing was written")
    expect(h.siteSourceCalls).toHaveLength(0)
  })
})

it("stops at the plan with exact owner wiring when an inline-consent entry leaves no work", async () => {
  const h = await setup({ files: { "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }), "app/layout.tsx": "export default function Layout({children}) { gtag('consent', 'default', {}); return <html><body>{children}</body></html> }\n" }, consentFlag: "not_required" })
  const outcome = await planStep.run(h.ctx, h.deps)
  expect(outcome).toMatchObject({ kind: "parked", reason: expect.stringContaining("Add these lines yourself") })
  expect(JSON.stringify(outcome)).toContain("InfiniteAnalyticsClient")
  expect(h.ctx.asks).toHaveLength(0)
  expect(existsSync(join(h.ctx.root, ".infinite/install.json"))).toBe(false)
})
