// §3y.5 / DECISIONS §1.6: no approvable plan line without an executor that will run on the current facts, and ONE
// count of the agent jobs (the budget line, "Plan approved", "Job i/N"). The live smoke's fresh workspace (no
// connections, no host, no claim capability) is the main negative world. Fakes only.
import { describe, expect, it } from "vitest"

import { candidate, fakeBefore, fakeHosting, fakeKeys, fakeProductionDeniedConflict, notConnectedKeys } from "../../test/wizard/o7-fakes.js"
import { PLAN_LINE_KINDS, type PlanLineKind } from "../wizard/contracts/asks.js"
import type { TagHosting } from "../wizard/contracts/bridge.js"
import { buildHostGuardExpression, classifyHost, productionDeniedConflict } from "../host-guard.js"
import {
  agentJobsAfterApprovals,
  buildPlanModel,
  guardDecision,
  lineRunnable,
  resolvePlanAnswers,
  RUNNABILITY_TEXT,
  runnableAgentJobs,
  seedItemsAfterApprovals,
  type LineFacts,
  type PlanModelInput,
  type PlanScanFacts
} from "./plan-model.js"

const NO_HOSTING: TagHosting = { provider: "none", vercel: null }

/** A fresh workspace's keys: no site source, nothing connected (the live smoke's `GET /v1/keys`). */
function freshKeys() {
  const keys = notConnectedKeys()
  return { ...keys, infinite: { status: "not_provisioned" as const, siteSourceKey: null, productionHosts: [], consentMode: null, consentStorageKey: null, collectPath: null } }
}

function scan(overrides: Partial<PlanScanFacts> = {}): PlanScanFacts {
  return {
    framework: "next-app-router",
    managedProviders: [],
    adopted: [],
    improve: [],
    serverLane: { targetLabel: "Next.js middleware", installPackages: ["@vercel/functions"] },
    npm: { commandLine: "pnpm add @vercel/functions" },
    sensitivePaths: [],
    ...overrides
  }
}

/** The live smoke's world: a fresh workspace, nothing connected, no Vercel connection. */
function freshInput(overrides: Partial<PlanModelInput> = {}): PlanModelInput {
  const keys = freshKeys()
  return {
    scan: scan(),
    keys,
    before: fakeBefore({ keys, hosting: NO_HOSTING }),
    candidates: [candidate("server_conversions", "signup"), candidate("conversions_to_tools", "signup"), candidate("duplicates_remove", "ga4_config:G-TEST0000000")],
    agent: { worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } },
    consentFlag: null,
    productionDeniedConflict: fakeProductionDeniedConflict,
    ...overrides
  }
}

const answered = (host: string) => ({ productionHost: host, source: "answer" as const, decidedAt: "2026-10-03T05:00:00.000Z" })
const approvable = (plan: ReturnType<typeof buildPlanModel>) => plan.lines.filter((line) => line.requires === "approval")

const UNRUNNABLE: LineFacts = {
  productionHost: null,
  infiniteReady: false,
  claimPending: false,
  vercelServesHost: false,
  siteClaim: false,
  serverLaneTarget: true,
  hostingVercel: false,
  envWriteGranted: false
}

describe("lineRunnable: every PlanLineKind against facts that make it unrunnable", () => {
  /** The kinds the rule can refuse, each with its refusal; every other kind has no executor precondition. */
  const DECIDED: Partial<Record<PlanLineKind | "install_provider:infinite", string>> = {
    "install_provider:infinite": RUNNABILITY_TEXT.infiniteNoHost,
    server_lane: RUNNABILITY_TEXT.serverLaneNoConnection,
    npm_install: "",
    preview_guard_managed: "Infinite does not know your production domain yet, so no preview guard is added; tell the wizard your live domain (--production-host)."
  }

  it.each([...PLAN_LINE_KINDS, "install_provider:infinite" as const].map((kind) => [kind]))("%s", (kind) => {
    const verdict = lineRunnable(kind, UNRUNNABLE)
    const refusal = DECIDED[kind]
    if (refusal === undefined) expect(verdict).toEqual({ ok: true })
    else expect(verdict).toEqual({ ok: false, line: refusal })
  })

  it("the fresh workspace plan holds NO approvable line of a refused kind (it is a user_action line instead)", () => {
    const plan = buildPlanModel(freshInput())
    const kinds = approvable(plan).map((line) => line.id)
    expect(kinds.some((id) => id.startsWith("install_provider:infinite"))).toBe(false)
    expect(kinds).not.toContain("server_lane")
    expect(kinds).not.toContain("npm_install")
    expect(kinds).not.toContain("preview_guard_managed")
    expect(plan.lines.find((line) => line.id === "user_action:infinite")).toMatchObject({ requires: "user_action", text: RUNNABILITY_TEXT.infiniteNoHost })
    expect(plan.lines.find((line) => line.id === "user_action:server_lane")).toMatchObject({ requires: "user_action", text: RUNNABILITY_TEXT.serverLaneNoConnection })
    expect(plan.serverLaneOffered).toBe(false)
    expect(plan.installTools).toEqual([])
  })
})

describe("the Infinite line (DECISIONS §1.6 table)", () => {
  it("a host answered + the claim capability → approvable, with the site-file wording right under it; the server lane is a user_action", () => {
    const plan = buildPlanModel(freshInput({ run: { site: answered("fresh-acme.com"), siteClaim: true } }))
    const index = plan.lines.findIndex((line) => line.id === "install_provider:infinite")
    expect(plan.lines[index]).toMatchObject({ requires: "approval", kind: "install_provider" })
    expect(plan.lines[index + 1]).toMatchObject({ id: "info:infinite_site_file", requires: "info", text: RUNNABILITY_TEXT.claimWording("fresh-acme.com") })
    // The claim path never offers the server lane (it needs a VERIFIED source and Infinite's Vercel connection).
    expect(plan.lines.find((line) => line.id === "user_action:server_lane")?.text).toBe(RUNNABILITY_TEXT.serverLaneNoConnection)
    expect(plan.lines.some((line) => line.id === "npm_install")).toBe(false)
  })

  it("a host answered but an old app (no capability) and no Vercel connection → the no-proof user_action", () => {
    const plan = buildPlanModel(freshInput({ run: { site: answered("fresh-acme.com"), siteClaim: false } }))
    expect(plan.lines.some((line) => line.id === "install_provider:infinite")).toBe(false)
    expect(plan.lines.find((line) => line.id === "user_action:infinite")?.text).toBe(RUNNABILITY_TEXT.infiniteNoProof("fresh-acme.com"))
  })

  it("a Vercel connection serving the host (no source yet) → approvable, no claim wording; env writes allowed → the lane is approvable", () => {
    const keys = freshKeys()
    const plan = buildPlanModel(freshInput({ keys, before: fakeBefore({ keys, hosting: fakeHosting({ productionDomains: ["acme-store.com"], envWriteGranted: true }) }) }))
    expect(plan.lines.find((line) => line.id === "install_provider:infinite")?.requires).toBe("approval")
    expect(plan.lines.some((line) => line.id === "info:infinite_site_file")).toBe(false)
    expect(plan.lines.find((line) => line.id === "server_lane")?.requires).toBe("approval")
    expect(plan.lines.find((line) => line.id === "npm_install")?.requires).toBe("approval")
  })

  it("NEGATIVE: Vercel connected without env writes → the no-scope line, never a pre-checked lane", () => {
    const keys = freshKeys()
    const plan = buildPlanModel(freshInput({ keys, before: fakeBefore({ keys, hosting: fakeHosting({ envWriteGranted: false }) }) }))
    expect(plan.lines.some((line) => line.id === "server_lane")).toBe(false)
    expect(plan.lines.find((line) => line.id === "user_action:server_lane")?.text).toBe(RUNNABILITY_TEXT.serverLaneNoScope)
  })

  it("an existing site source is runnable as before (the connected world is unchanged)", () => {
    const plan = buildPlanModel(freshInput({ keys: fakeKeys(), before: fakeBefore() }))
    expect(plan.lines.find((line) => line.id === "install_provider:infinite")?.requires).toBe("approval")
    expect(plan.lines.find((line) => line.id === "server_lane")?.requires).toBe("approval")
  })

  it("the answered host is ALWAYS in the preview guard's exempt list (D3)", () => {
    // GA4 connected (a new guarded tool), no site source, no Vercel connection: only the answer names the host.
    const keys = { ...freshKeys(), ga4: fakeKeys().ga4 }
    const plan = buildPlanModel(freshInput({ keys, before: fakeBefore({ keys, hosting: NO_HOSTING }), run: { site: answered("fresh-acme.com"), siteClaim: true } }))
    expect(plan.guard).toMatchObject({ emit: true })
    expect(plan.lines.find((line) => line.id === "preview_guard_managed")?.requires).toBe("approval")
    // NEGATIVE: with no answered host there is no guard and the blocked line names the flag.
    const none = buildPlanModel(freshInput({ keys, before: fakeBefore({ keys, hosting: NO_HOSTING, observedProductionHost: null }) }))
    expect(none.guard).toEqual({ emit: false, reason: "no_production_host" })
    expect(none.lines.find((line) => line.id === "preview_guard_blocked")?.text).toContain("--production-host")
    expect(plan.guard.emit && plan.guard.exempt).toContain("fresh-acme.com")
  })
})

describe("job 10 is seeded only when this install emits the conversion helpers (P3-13)", () => {
  it("installs neither Infinite nor a connected tool → no job-10 item, one user_action line naming the conversions", () => {
    const plan = buildPlanModel(freshInput())
    // R2-6: job 8 reports through Infinite, which this run cannot install either, so it is withheld with job 10.
    expect(plan.withheld).toEqual(["server_conversions:signup", "conversions_to_tools:signup"])
    expect(plan.lines.find((line) => line.id === "user_action:conversions_unwired")?.text).toBe(RUNNABILITY_TEXT.conversionsUnwired(["signup"]))
    const all = resolvePlanAnswers(plan, { approved: approvable(plan).map((line) => line.id), declined: [], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    const seeded = seedItemsAfterApprovals(freshInput().candidates, plan.seeds, plan, all.approvals)
    expect(seeded.some((item) => item.jobId === "conversions_to_tools")).toBe(false)
  })

  it("NEGATIVE: Infinite installed this run → job 10 is a candidate again", () => {
    const plan = buildPlanModel(freshInput({ run: { site: answered("fresh-acme.com"), siteClaim: true } }))
    expect(plan.withheld).toEqual([])
    expect(plan.lines.some((line) => line.id === "user_action:conversions_unwired")).toBe(false)
  })
})

describe("R2-6 (live run 2): a decision that governs nothing this run is not asked or pre-checked", () => {
  it("the live run's world (no host, GA4 adopted twice, nothing installable): no consent line, no conversion line", () => {
    const plan = buildPlanModel(freshInput())
    expect(plan.lines.some((line) => line.kind === "consent_mode")).toBe(false)
    expect(plan.lines.some((line) => line.kind === "conversion_names")).toBe(false)
    // The one honest line about conversions stays, and the duplicate GA4 fix is still offered.
    expect(plan.lines.find((line) => line.id === "user_action:conversions_unwired")?.requires).toBe("user_action")
    expect(approvable(plan).some((line) => line.jobIds?.some((id) => id.startsWith("duplicates_remove")))).toBe(true)
    // Nothing to answer: approving the plan needs no consent and declares no conversion.
    const all = resolvePlanAnswers(plan, { approved: approvable(plan).map((line) => line.id), declined: [], edits: {} }, { consentFlag: null })
    expect(all.consentMode).toBeNull()
    expect(all.conversions).toEqual([])
  })

  it("NEGATIVE: Infinite can be installed (host + claim) → both decisions are asked", () => {
    const plan = buildPlanModel(freshInput({ run: { site: answered("fresh-acme.com"), siteClaim: true } }))
    expect(plan.lines.find((line) => line.kind === "consent_mode")?.requires).toBe("approval")
    expect(plan.lines.find((line) => line.kind === "conversion_names")?.requires).toBe("approval")
  })

  it("NEGATIVE: an existing Infinite source (nothing new to install) still asks consent (it is recorded on the source)", () => {
    const plan = buildPlanModel(freshInput({ keys: fakeKeys(), before: fakeBefore() }))
    expect(plan.lines.some((line) => line.kind === "consent_mode")).toBe(true)
  })
})

describe("ONE count of the agent jobs (P2-8)", () => {
  const world = () => freshInput({ run: { site: answered("fresh-acme.com"), siteClaim: true } })
  const budgetN = (plan: ReturnType<typeof buildPlanModel>) => Number(/up to (\d+) job/.exec(plan.lines.find((line) => line.id === "agent_budget")!.text)![1])

  it("the budget line's 'up to N' equals the jobs every approvable line runs, and the jobs step's i/N reads the same items", () => {
    const input = world()
    const plan = buildPlanModel(input)
    const everything = resolvePlanAnswers(plan, { approved: approvable(plan).map((line) => line.id), declined: [], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    const items = seedItemsAfterApprovals(input.candidates, plan.seeds, plan, everything.approvals, everything.lines)
    const planApproved = runnableAgentJobs(items).length
    // The jobs step counts the open agent items of `state.jobs` (exactly `items` here).
    const jobsStep = items.filter((item) => item.owner === "agent" && (item.state === "pending" || item.state === "claimed")).length
    expect(budgetN(plan)).toBe(planApproved)
    expect(jobsStep).toBe(planApproved)
    expect(agentJobsAfterApprovals(input.candidates, plan.seeds, plan, everything.approvals)).toHaveLength(planApproved)
    expect(planApproved).toBeGreaterThan(0)
  })

  it("a declined line lowers the count (its job is never seeded)", () => {
    const input = world()
    const plan = buildPlanModel(input)
    const duplicateLine = plan.lines.find((line) => line.kind === "remove_duplicate")!
    const all = approvable(plan).map((line) => line.id)
    const full = resolvePlanAnswers(plan, { approved: all, declined: [], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    const less = resolvePlanAnswers(plan, { approved: all.filter((id) => id !== duplicateLine.id), declined: [duplicateLine.id], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    const fullN = agentJobsAfterApprovals(input.candidates, plan.seeds, plan, full.approvals).length
    const lessN = agentJobsAfterApprovals(input.candidates, plan.seeds, plan, less.approvals).length
    expect(lessN).toBe(fullN - 1)
  })
})

describe("live run 2: the preview guard exempts exactly the accepted <project>.vercel.app production host", () => {
  const ALIAS = "acme-store.vercel.app"
  const decide = (runProductionHost: string | null, observed: string | null) =>
    guardDecision({
      keys: freshKeys(),
      hosting: NO_HOSTING,
      observedProductionHost: observed,
      runProductionHost,
      newGuardedTools: ["ga4"],
      adoptedGuardWanted: false,
      productionDeniedConflict
    })

  it("the alias is exempt (fires), every other *.vercel.app stays silent, exempt first", () => {
    const guard = decide(ALIAS, ALIAS)
    expect(guard).toEqual({ emit: true, exempt: [ALIAS], deny: expect.any(Array) })
    if (!guard.emit) return
    expect(classifyHost(ALIAS, guard)).toBe("exempt")
    for (const preview of ["acme-store-git-infinite-tag-acme.vercel.app", "acme-store-a1b2c3d4e-acme.vercel.app", "other.vercel.app"]) {
      expect(classifyHost(preview, guard), preview).toBe("denied")
    }
    // The emitted expression lists the alias first in its exempt array (the same order as the TS twin).
    expect(buildHostGuardExpression({ mode: "deny", exempt: guard.exempt, deny: guard.deny })).toContain(`"${ALIAS}"`)
  })

  it("NEGATIVE: the alias observed on the live site but never accepted as the run's host would be silenced → no guard", () => {
    expect(decide(null, ALIAS)).toEqual({ emit: false, reason: "production_denied", hosts: [ALIAS] })
  })
})
