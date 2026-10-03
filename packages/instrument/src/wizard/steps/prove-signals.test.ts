// §3y.4 / IO-6: `prove` waits on EVERY available signal when Infinite has no Vercel connection (GitHub Deployments,
// a pending site-file claim), stops at once on a failed deploy, asks once when no signal exists, and never spends
// the run's one real visit before a pending claim is proven. Fakes only (no gh, no network).
import { describe, expect, it } from "vitest"

import { MERGE_SHA, RUN_ID, SERVING_SHA, fakeContext, fakeDeps, keysFixture, type FakeDepsBundle } from "../../../test/wizard/runtime-fakes.js"
import type { FakeHostDeployments } from "../../../test/wizard/runtime-fakes.js"
import type { SiteProveResponse } from "../contracts/bridge.js"
import type { WizardRunState } from "../contracts/state.js"
import { createRunState } from "../run-state.js"
import { PROVE_LIMITS, step } from "./prove.js"

const RESERVED = "site_fa4e000000000000000000000000c1a1"
const HOST = "fresh-acme.com"

function mergedState(site?: WizardRunState["site"]): WizardRunState {
  const state = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "r-7f3c" })
  state.runId = RUN_ID
  state.git = { base: "main", baseSource: "default_branch", branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "a".repeat(40), headSha: "b".repeat(40) }
  state.pr = { host: "github", number: 2, url: "https://github.com/acme/site/pull/2", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: MERGE_SHA }
  if (site) state.site = site
  return state
}

const answeredSite = (claim: boolean): WizardRunState["site"] => ({
  productionHost: HOST,
  source: "answer",
  decidedAt: "2026-10-02T09:01:00.000Z",
  vercelSignal: true,
  ...(claim ? { claim: { hosts: [HOST], siteSourceKey: RESERVED, collectPath: "/infinite/ledger", consentStorageKey: "infinite_analytics_consent", proofPath: "/.well-known/infinite-site-verification.txt" as const, state: "pending_proof" as const } } : {})
})

/** The live smoke's world: no Infinite Vercel connection, no site source yet. */
function freshKeys() {
  return keysFixture({
    infinite: { status: "not_provisioned", siteSourceKey: null, productionHosts: [], consentMode: null, consentStorageKey: null, collectPath: null },
    ga4: { status: "not_connected", propertyLabel: null, streams: [] },
    posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null },
    meta: { status: "not_connected", pixels: [] }
  })
}

const provenKeys = () =>
  keysFixture({
    ...freshKeys(),
    infinite: { status: "ready", siteSourceKey: RESERVED, productionHosts: [HOST], consentMode: "not_required", consentStorageKey: "infinite_analytics_consent", collectPath: "/infinite/ledger" }
  })

const NO_HOSTING = { protocolVersion: 1 as const, requestId: "req", provider: "none" as const, vercel: null }
const pending = (outcome: "not_served" | "wrong_token" = "not_served"): Omit<SiteProveResponse, "protocolVersion" | "requestId"> => ({ state: "pending", hosts: [{ host: HOST, outcome }], siteSource: null })
const proven: Omit<SiteProveResponse, "protocolVersion" | "requestId"> = { state: "proven", hosts: [{ host: HOST, outcome: "proven" }], siteSource: { siteSourceKey: RESERVED, productionHosts: [HOST], consentMode: "not_required", created: true } }

function world(input: { deployments?: FakeHostDeployments; siteProve?: Array<Omit<SiteProveResponse, "protocolVersion" | "requestId">>; keysAfterProof?: boolean }): FakeDepsBundle {
  const bundle = fakeDeps({
    bridge: { hosting: NO_HOSTING, keys: freshKeys(), ...(input.siteProve ? { siteProve: input.siteProve } : {}) },
    git: { ancestors: [[MERGE_SHA, SERVING_SHA]] },
    ...(input.deployments ? { host: { deployments: input.deployments } } : {})
  })
  if (input.keysAfterProof) {
    // The cloud creates the source with the reserved key on the proof: the keys verb answers it from then on.
    let proofSeen = false
    const original = bundle.deps.bridge.proveSite.bind(bundle.deps.bridge)
    bundle.deps.bridge.proveSite = async (options) => {
      const answer = await original(options)
      if (answer.state === "proven") proofSeen = true
      return answer
    }
    const keys = bundle.deps.bridge.keys.bind(bundle.deps.bridge)
    bundle.deps.bridge.keys = async (options) => {
      const answer = await keys(options)
      return proofSeen ? provenKeys() : answer
    }
  }
  return bundle
}

async function run(bundle: FakeDepsBundle, state: WizardRunState, options: Parameters<typeof fakeContext>[1] = {}, ask?: (kind: string, payload: unknown) => unknown) {
  const ctx = fakeContext(state, options, bundle.clock)
  const asked: Array<{ kind: string; payload: unknown }> = []
  if (ask) ctx.ask = (async (kind: string, payload: unknown) => (asked.push({ kind, payload }), ask(kind, payload))) as never
  const outcome = await step.run(ctx, bundle.deps)
  const subs = ctx.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
  return { ctx, outcome, subs, asked }
}

describe("prove: GitHub Deployments as the deploy signal (no Infinite Vercel connection)", () => {
  it("the merge's production deployment ready → '✓ Deployed <sha> (GitHub deployment)', then the one real visit", async () => {
    const bundle = world({ deployments: { forSha: ["building", "ready"] } })
    const { outcome, subs } = await run(bundle, mergedState(answeredSite(false)))
    expect(outcome.kind).not.toBe("parked")
    expect(subs).toContain(`✓ Deployed ${MERGE_SHA.slice(0, 7)} (GitHub deployment)`)
    expect(subs).toContain(`GitHub: Vercel is building ${MERGE_SHA.slice(0, 7)}…`)
    // Infinite has no Vercel connection here: its deploy status is never asked (it can only answer null).
    expect(bundle.log.names("bridge")).not.toContain("bridge.deployStatus")
    expect(bundle.log.names("bridge").filter((name) => name === "bridge.startTest")).toHaveLength(1)
  })

  it("a failed merge deployment with nothing later containing it → parked DEPLOY_FAILED at once (no 20-minute wait, no visit)", async () => {
    const bundle = world({ deployments: { forSha: ["failed"], latest: [null] } })
    const { outcome } = await run(bundle, mergedState(answeredSite(false)))
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_DEPLOY_FAILED", resumeHint: "Fix it and run npx infinite-tag again." })
    expect((outcome as { reason: string }).reason).toBe(`The deploy of ${MERGE_SHA.slice(0, 7)} failed (GitHub shows the Vercel production deployment failed).`)
    expect(bundle.log.names("host").filter((name) => name === "host.productionDeployment")).toHaveLength(1)
    expect(bundle.log.names("bridge")).not.toContain("bridge.claimProof")
    expect(bundle.log.names("bridge")).not.toContain("bridge.startTest")
  })

  it("a failed merge build but a LATER successful production deployment that descends → deployed (serving_descends)", async () => {
    const bundle = world({ deployments: { forSha: ["failed"], latest: [{ sha: SERVING_SHA, createdAt: "2026-10-02T09:40:00.000Z" }] } })
    const { outcome, subs } = await run(bundle, mergedState(answeredSite(false)))
    expect(outcome.kind).not.toBe("parked")
    expect(subs.join(" ")).toContain(`a later commit, ${SERVING_SHA.slice(0, 7)}, includes it`)
  })
})

describe("prove: no signal at all → ONE question instead of a wait", () => {
  const noSignal = () => world({})

  it("yes → the visit runs", async () => {
    const bundle = noSignal()
    const { outcome, asked } = await run(bundle, mergedState(answeredSite(false)), { json: false }, () => true)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: "confirm", payload: { defaultYes: false } })
    expect((asked[0]!.payload as { question: string }).question).toBe(`Infinite can't see when ${HOST} deploys (no Vercel connection, no GitHub deployments). Is pull request #2 live on ${HOST} now?`)
    expect(outcome.kind).not.toBe("parked")
    expect(bundle.log.names("bridge")).toContain("bridge.startTest")
  })

  it("no → parked DEPLOY_TIMEOUT with 'run again once it's live'; --yes parks at once without asking", async () => {
    const no = await run(noSignal(), mergedState(answeredSite(false)), { json: false }, () => false)
    expect(no.outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_DEPLOY_TIMEOUT", resumeHint: "Run npx infinite-tag again once it's live." })
    const bundle = noSignal()
    const yes = await run(bundle, mergedState(answeredSite(false)), { yes: true }, () => {
      throw new Error("--yes must not ask")
    })
    expect(yes.outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_DEPLOY_TIMEOUT" })
    expect(bundle.clock.now().toISOString()).toBe("2026-10-02T09:36:00.000Z")
  })
})

describe("prove: the site-file claim (§3y.4)", () => {
  it("the claim proven during the wait → deployed (site_file), the keys re-read, ONE real visit expecting the reserved key", async () => {
    const bundle = world({ siteProve: [pending(), proven], keysAfterProof: true })
    const { outcome, subs, ctx } = await run(bundle, mergedState(answeredSite(true)))
    expect(outcome.kind, JSON.stringify(outcome)).not.toBe("parked")
    expect(subs.some((text) => text.startsWith(`✓ Deployed ${MERGE_SHA.slice(0, 7)} (Infinite read its proof file`)), subs.join("\n")).toBe(true)
    expect(subs).toContain(`✓ ${HOST} confirmed (Infinite read the proof file)`)
    const names = bundle.log.names("bridge")
    expect(names.filter((name) => name === "bridge.proveSite")).toHaveLength(2)
    // site-prove comes before the proof claim, and the keys are read again after the proof.
    expect(names.lastIndexOf("bridge.proveSite")).toBeLessThan(names.indexOf("bridge.claimProof"))
    expect(names.slice(names.lastIndexOf("bridge.proveSite")).includes("bridge.keys")).toBe(true)
    const visit = bundle.log.calls.find((call) => call.what === "startTest")!.args[0] as { expect: { infinite?: { siteSourceKey: string } } }
    expect(visit.expect.infinite?.siteSourceKey).toBe(RESERVED)
    expect(ctx.current().site?.claim?.state).toBe("proven")
    // The claim was polled at most once a minute while it waited.
    expect(PROVE_LIMITS.claimPollMs).toBe(60_000)
  })

  it("deployed on GitHub but the claim still pending → 3 more minutes of proofs, then parked HOST_UNCONFIRMED with NO real visit and NO proof claim", async () => {
    const bundle = world({ deployments: { forSha: ["ready"] }, siteProve: [pending("wrong_token")] })
    const { outcome } = await run(bundle, mergedState(answeredSite(true)))
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_HOST_UNCONFIRMED" })
    expect((outcome as { reason: string }).reason).toBe(`${HOST} isn't confirmed yet: the file holds another workspace's token (Infinite looks for /.well-known/infinite-site-verification.txt).`)
    expect((outcome as { resumeHint: string }).resumeHint).toBe("The Infinite app finishes the proof once it is served; or run npx infinite-tag again.")
    const names = bundle.log.names("bridge")
    expect(names).not.toContain("bridge.claimProof")
    expect(names).not.toContain("bridge.startTest")
    const proofs = names.filter((name) => name === "bridge.proveSite").length
    expect(proofs).toBeGreaterThanOrEqual(PROVE_LIMITS.claimGraceMs / PROVE_LIMITS.claimGracePollMs - 1)
    expect(proofs).toBeLessThanOrEqual(PROVE_LIMITS.claimGraceMs / PROVE_LIMITS.claimGracePollMs + 2)
  })
})
