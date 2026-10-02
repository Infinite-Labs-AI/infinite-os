import { describe, expect, it } from "vitest"

import { candidate, fakeBefore, fakeHosting, fakeKeys, fakeProductionDeniedConflict, IDS, notConnectedKeys } from "../../test/wizard/o7-fakes.js"
import type { ImproveLine } from "../types.js"
import { YES_POLICY, yesApproves } from "../wizard/contracts/asks.js"
import type { BaselineResponseFields } from "../wizard/contracts/report.js"
import type { TestResult } from "../wizard/contracts/test-engine.js"

import {
  buildPlanModel,
  DECISION_LINE_IDS,
  duplicateFindings,
  EDITABLE_LINE_IDS,
  gateSeededItems,
  planAskPayload,
  previewShare,
  resolvePlanAnswers,
  SERVER_LANE_PROBE_DISCLOSURE,
  withGuardHosts,
  type PlanModelInput,
  type PlanScanFacts
} from "./plan-model.js"

type WizardBeforeFactsCensus = ReturnType<typeof fakeBefore>["census"]

function scanFacts(overrides: Partial<PlanScanFacts> = {}): PlanScanFacts {
  return {
    framework: "next-app-router",
    managedProviders: [],
    adopted: [],
    improve: [],
    serverLane: { targetLabel: "Next.js middleware", installPackages: [] },
    npm: null,
    sensitivePaths: [],
    ...overrides
  }
}

function input(overrides: Partial<PlanModelInput> = {}): PlanModelInput {
  return {
    scan: scanFacts(),
    keys: fakeKeys(),
    before: fakeBefore(),
    candidates: [],
    agent: { worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } },
    consentFlag: null,
    productionDeniedConflict: fakeProductionDeniedConflict,
    ...overrides
  }
}

const adoptedMetaLines: ImproveLine[] = [
  { id: "preview_guard_adopted:meta:init", kind: "preview_guard_adopted", provider: "meta", target: "init", text: "Meta: keep preview sites silent.", owner: "agent", evidence: { file: "index.html", line: 6 } },
  { id: "autoconfig_off_adopted:meta:autoconfig", kind: "autoconfig_off_adopted", provider: "meta", target: "autoconfig", text: "Meta: turn off automatic events.", owner: "code", evidence: { file: "index.html", line: 6 } }
]
const adoptedPosthogLines: ImproveLine[] = [
  { id: "improve_additive:posthog:proxy", kind: "improve_additive", provider: "posthog", target: "proxy", text: "PostHog: send events through /ingest.", owner: "code", evidence: { file: "index.html", line: 5 } },
  { id: "improve_additive:posthog:history_change", kind: "improve_additive", provider: "posthog", target: "history_change", text: "PostHog: history_change.", owner: "agent", evidence: { file: "index.html", line: 5 } },
  { id: "posthog_defaults_bump_adopted:posthog:defaults", kind: "posthog_defaults_bump_adopted", provider: "posthog", target: "defaults", text: "PostHog: defaults bump.", owner: "agent", evidence: { file: "index.html", line: 5 } }
]

describe("the plan model asks ONLY the four decisions", () => {
  it("consent, conversion names, privacy text and the npm line are the only editable lines; everything else is a line", () => {
    const plan = buildPlanModel(
      input({
        scan: scanFacts({ serverLane: { targetLabel: "Vercel root middleware", installPackages: ["@vercel/functions"] }, npm: { commandLine: "pnpm add @vercel/functions" } }),
        candidates: [candidate("server_conversions", "start_trial"), candidate("privacy_paragraph", "page")]
      })
    )
    const editable = plan.lines.filter((line) => line.editable).map((line) => line.id)
    expect(editable.sort()).toEqual([...EDITABLE_LINE_IDS].sort())
    expect(plan.decisions).toEqual({
      consentMode: null,
      conversionNames: ["start_trial"],
      privacyText: expect.stringContaining("We use Infinite (Ultima Inc.)"),
      npmInstall: "pnpm add @vercel/functions"
    })
    expect(planAskPayload(plan).lines.every((line) => Object.keys(line).every((key) => ["id", "kind", "text", "requires", "editable", "measured", "jobIds", "ownership"].includes(key)))).toBe(true)
  })

  it("NEGATIVE: no other kind is ever editable (an extra question would be a second ask)", () => {
    const plan = buildPlanModel(input({ scan: scanFacts({ improve: adoptedPosthogLines, adopted: [{ provider: "posthog", via: "snippet", file: "index.html", line: 5, key: IDS.posthog }] }) }))
    for (const line of plan.lines) {
      if (!EDITABLE_LINE_IDS.includes(line.id)) expect(line.editable).toBe(false)
    }
  })

  it("installs only connected tools, each with its connection's id in the line; missing ones are 'connect it' lines", () => {
    const plan = buildPlanModel(input({ keys: notConnectedKeys() }))
    const ids = plan.lines.map((line) => line.id)
    expect(ids).toContain("install_provider:infinite")
    expect(ids.filter((id) => id.startsWith("install_provider:"))).toEqual(["install_provider:infinite"])
    expect(ids).toEqual(expect.arrayContaining(["user_action:connect_ga4", "user_action:connect_posthog", "user_action:connect_meta"]))
    const full = buildPlanModel(input())
    expect(full.lines.map((line) => line.id)).toEqual(expect.arrayContaining([`install_provider:ga4:${IDS.ga4}`, `install_provider:posthog:${IDS.posthog}`, `install_provider:meta:${IDS.meta}`]))
  })

  it("the server-lane line carries the probe disclosure (§3h.6: TWO bot-flagged rows on the real visit)", () => {
    const plan = buildPlanModel(input())
    expect(plan.lines.find((line) => line.id === "server_lane")?.text).toContain(SERVER_LANE_PROBE_DISCLOSURE)
    expect(SERVER_LANE_PROBE_DISCLOSURE).toMatch(/TWO bot-flagged/)
  })

  it("the agent budget line says who pays; no agent → an info line, never an approval", () => {
    const withAgent = buildPlanModel(input({ candidates: [candidate("identify_reset", "auth")] }))
    expect(withAgent.lines.find((line) => line.id === "agent_budget")).toMatchObject({ requires: "approval", text: "Claude Code: 1 job · Opus 4.8 at xhigh effort · up to 30 turns or 10 min · your Claude plan pays" })
    const none = buildPlanModel(input({ candidates: [candidate("identify_reset", "auth")], agent: null }))
    expect(none.lines.find((line) => line.id === "agent_budget")).toMatchObject({ requires: "info" })
  })

  it("D16: SaaS conversions recommend StartTrial, ecom Purchase", () => {
    const saas = buildPlanModel(input({ candidates: [candidate("server_conversions", "start_trial")] }))
    expect(saas.lines.find((line) => line.id === "meta_goal")?.text).toMatch(/^Meta goal: StartTrial/)
    const shop = buildPlanModel(input({ candidates: [candidate("server_conversions", "purchase")] }))
    expect(shop.lines.find((line) => line.id === "meta_goal")?.text).toMatch(/^Meta goal: Purchase/)
  })
})

describe("adopted providers: every agent job that touches one waits on an approved line (R2-10, R2-11)", () => {
  const posthogAdopted = scanFacts({ improve: adoptedPosthogLines, adopted: [{ provider: "posthog", via: "snippet", file: "index.html", line: 5, key: IDS.posthog }] })

  it("adopted PostHog: improve lines, never 'install'; job 3 candidates link to the improve line", () => {
    const plan = buildPlanModel(input({ scan: posthogAdopted, candidates: [candidate("posthog_improve", "proxy")] }))
    expect(plan.lines.map((line) => line.id)).not.toContain(`install_provider:posthog:${IDS.posthog}`)
    const improve = plan.lines.find((line) => line.id === "improve_additive:posthog:proxy")!
    expect(improve).toMatchObject({ ownership: "adopted", requires: "approval", jobIds: ["posthog_improve:proxy"] })
    // --yes never approves an improvement to an ADOPTED provider.
    expect(yesApproves(improve)).toBe(false)
  })

  it("NEGATIVE: an adopted PostHog with no approved improve line seeds no job 3", () => {
    const candidates = [candidate("posthog_improve", "proxy"), candidate("identify_reset", "auth")]
    const plan = buildPlanModel(input({ scan: posthogAdopted, candidates }))
    const declined = resolvePlanAnswers(plan, { approved: ["consent_mode"], declined: ["improve_additive:posthog:proxy"], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    expect(gateSeededItems(plan, declined, candidates).map((item) => item.id)).toEqual(["identify_reset:auth"])
    const unanswered = resolvePlanAnswers(plan, { approved: ["consent_mode"], declined: [], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    const gated = gateSeededItems(plan, unanswered, candidates)
    expect(gated.find((item) => item.id === "posthog_improve:proxy")).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    const approved = resolvePlanAnswers(plan, { approved: ["consent_mode", "improve_additive:posthog:proxy", "agent_budget"], declined: [], edits: { consent_mode: "not_required" } }, { consentFlag: null })
    expect(gateSeededItems(plan, approved, candidates).find((item) => item.id === "posthog_improve:proxy")?.state).toBe("pending")
  })

  it("NEGATIVE: an adopted-provider job with no line at all is never seeded", () => {
    const plan = buildPlanModel(input())
    const stray = candidate("ga4_improve", "spa")
    // Build the plan WITHOUT the candidate, then gate an item no line links.
    const resolved = resolvePlanAnswers(plan, { approved: ["consent_mode"], declined: [], edits: { consent_mode: "required" } }, { consentFlag: null })
    expect(gateSeededItems(plan, resolved, [stray])).toEqual([])
  })

  it("'one init' is never part of job 3: a reduction is ONLY job 6 under remove_duplicate", () => {
    const before = fakeBefore({
      census: {
        entries: [
          { tool: "posthog", kind: "posthog_init", id: IDS.posthog, file: "index.html", line: 5, owner: "adopted" },
          { tool: "posthog", kind: "posthog_init", id: IDS.posthog, file: "about.html", line: 5, owner: "adopted" }
        ],
        envSourcedIds: [],
        identify: { identifyCalls: [], resetCalls: [] }
      }
    })
    // O8's job-6 target shape (`posthog_init:<id>`, ios:…/jobs/detectors/duplicates.ts).
    const dupTarget = `posthog_init:${IDS.posthog}`
    const plan = buildPlanModel(input({ scan: posthogAdopted, before, candidates: [candidate("posthog_improve", "proxy"), candidate("duplicates_remove", dupTarget)] }))
    const job3Lines = plan.lines.filter((line) => line.jobIds?.some((id) => id.startsWith("posthog_improve")))
    for (const line of job3Lines) expect(line.text).not.toMatch(/one init|starts \d+ times|remove/i)
    const dup = plan.lines.find((line) => line.kind === "remove_duplicate")!
    expect(dup).toMatchObject({ id: `remove_duplicate:posthog:${dupTarget}`, jobIds: [`duplicates_remove:${dupTarget}`], text: expect.stringContaining("starts 2 times") })
    expect(YES_POLICY.remove_duplicate).toBe("never")
  })

  it("an adopted Meta pixel without a guard → a Meta preview_guard_adopted line with the measured preview share (raw counts below 50)", () => {
    const baseline = {
      window: { days: 28, from: "2026-09-04", to: "2026-10-02" },
      ga4: { status: "ok", pageViews: { production: 30, preview: 7, other: 2 }, localhostExcluded: true, topOffenders: [], keyEvents: [], syncedAt: null },
      posthog: { status: "not_connected", pageViews: null, proxied: null, conversions: null },
      conversions: { infinite: [] },
      serverLane: { laneState: "no_secret", documentRequests7d: null, outcomes7d: null },
      stripe: { status: "not_connected", lastLiveEventAt: null }
    } as unknown as BaselineResponseFields
    const plan = buildPlanModel(
      input({
        scan: scanFacts({ improve: adoptedMetaLines, adopted: [{ provider: "meta", via: "snippet", file: "index.html", line: 6, key: IDS.meta }] }),
        before: { ...fakeBefore(), baseline }
      })
    )
    const line = plan.lines.find((entry) => entry.id === "preview_guard_adopted:meta:init")!
    expect(line.kind).toBe("preview_guard_adopted")
    expect(line.text).toMatch(/^Meta/)
    expect(line.measured).toEqual({ value: "7 of 39 page views were previews", window: "28 days" })
    expect(yesApproves(line)).toBe(false)
  })

  it("NEGATIVE: with no baseline the preview share is '—', never 0", () => {
    expect(previewShare(null)).toBeNull()
    const plan = buildPlanModel(input({ scan: scanFacts({ improve: adoptedMetaLines, adopted: [{ provider: "meta", via: "snippet", file: "index.html", line: 6, key: IDS.meta }] }) }))
    const line = plan.lines.find((entry) => entry.id === "preview_guard_adopted:meta:init")!
    expect(line.text).toContain("Preview share: —")
    expect(line.measured).toBeUndefined()
  })

  it("D10: the autoConfig line carries the measured automatic events per visit from the no-send load", () => {
    const dryLive = {
      loads: [{ label: "home" }, { label: "pricing" }],
      meta: { tr: [{ ev: "PageView" }, { ev: "SubscribedButtonClick" }, { ev: "Microdata" }, { ev: "PageView" }, { ev: "Microdata" }] },
      ga4: { events: [] }
    } as unknown as TestResult
    const plan = buildPlanModel(
      input({
        scan: scanFacts({ improve: adoptedMetaLines, adopted: [{ provider: "meta", via: "snippet", file: "index.html", line: 6, key: IDS.meta }] }),
        before: fakeBefore({ dryLive })
      })
    )
    expect(plan.lines.find((line) => line.kind === "autoconfig_off_adopted")?.measured).toEqual({ value: "1.5 automatic events per visit, no clicks", window: "the no-send test load" })
  })
})

describe("duplicates and conflicts (GA4), from `before` only", () => {
  const gtm = { tool: "ga4" as const, kind: "gtm" as const, id: "GTM-ABC1234", file: "index.html", line: 3, owner: "adopted" as const }
  const gtag = (id: string) => ({ tool: "ga4" as const, kind: "gtag_config" as const, id, file: "index.html", line: 9, owner: "adopted" as const })
  const dry = (tids: string[]) =>
    ({ loads: [{ label: "home" }], ga4: { events: tids.map((tid) => ({ tid, en: "page_view", loadLabel: "home" })) }, meta: { tr: [] } }) as unknown as TestResult

  it("GTM + a hand-written gtag sending the SAME id (2 page views per visit) → one duplicate line", () => {
    const before = fakeBefore({ census: { entries: [gtm, gtag(IDS.ga4)], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }, dryLive: dry([IDS.ga4, IDS.ga4]) })
    expect(duplicateFindings(before)).toEqual([expect.objectContaining({ kind: "duplicate", id: `remove_duplicate:ga4:${IDS.ga4}` })])
  })

  it("two different ids → a conflict line the user resolves (never a removal)", () => {
    const before = fakeBefore({ census: { entries: [gtm, gtag(IDS.ga4)], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }, dryLive: dry([IDS.ga4, IDS.ga4Other]) })
    const findings = duplicateFindings(before)
    expect(findings.map((finding) => finding.kind)).toEqual(["conflict"])
    const plan = buildPlanModel(input({ before }))
    expect(plan.lines.find((line) => line.id === "conflict:ga4")).toMatchObject({ kind: "user_action", requires: "user_action" })
  })

  it("NEGATIVE: GTM + gtag with ONE page view per visit is not a duplicate", () => {
    const before = fakeBefore({ census: { entries: [gtm, gtag(IDS.ga4)], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }, dryLive: dry([IDS.ga4]) })
    expect(duplicateFindings(before)).toEqual([])
  })
})

describe("the preview guard's exempt list (§3h.9, R2-21)", () => {
  it("emits the guard with exempt = site-source hosts ∪ hosting domains + aliases ∪ the observed host", () => {
    const plan = buildPlanModel(
      input({ before: fakeBefore({ hosting: fakeHosting({ productionDomains: ["acme-store.com", "www.acme-store.com"], productionAliases: ["acme-store.vercel.app"] }), observedProductionHost: "www.acme-store.com" }) })
    )
    expect(plan.guard).toMatchObject({ emit: true, exempt: ["acme-store.com", "www.acme-store.com", "acme-store.vercel.app"] })
    expect(plan.lines.find((line) => line.id === "preview_guard_managed")).toBeDefined()
  })

  it("NEGATIVE: an observed production host acme.vercel.app that Infinite does not list → no guard, and the blocking line", () => {
    const keys = fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: [] } })
    const plan = buildPlanModel(input({ keys, before: fakeBefore({ hosting: fakeHosting({ productionDomains: [], productionAliases: [] }), observedProductionHost: "acme.vercel.app" }) }))
    expect(plan.guard).toEqual({ emit: false, reason: "production_denied", hosts: ["acme.vercel.app"] })
    expect(plan.lines.find((line) => line.id === "preview_guard_managed")).toBeUndefined()
    expect(plan.lines.find((line) => line.id === "preview_guard_blocked")?.text).toBe(
      "Your live site is served on acme.vercel.app, which the preview guard would silence; add it in Infinite first. No preview guard is added until then."
    )
  })

  it("once Infinite lists that host, the guard is emitted with it exempt (production fires)", () => {
    const keys = fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: ["acme.vercel.app"] } })
    const plan = buildPlanModel(input({ keys, before: fakeBefore({ hosting: fakeHosting({ productionDomains: [], productionAliases: [] }), observedProductionHost: "acme.vercel.app" }) }))
    expect(plan.guard).toMatchObject({ emit: true, exempt: ["acme.vercel.app"] })
  })

  it("NEGATIVE: no production host anywhere → no guard (an empty exempt list would silence production)", () => {
    const keys = fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: [] } })
    const plan = buildPlanModel(input({ keys, before: fakeBefore({ hosting: { provider: "none", vercel: null }, observedProductionHost: null }) }))
    expect(plan.guard).toEqual({ emit: false, reason: "no_production_host" })
  })
})

describe("resolvePlanAnswers", () => {
  const plan = buildPlanModel(input({ candidates: [candidate("server_conversions", "start_trial")] }))

  it("--consent-mode answers the consent line (the only way --yes gets one)", () => {
    expect(resolvePlanAnswers(plan, null, { consentFlag: "required" }).consentMode).toBe("required")
  })

  it("NEGATIVE: an unanswered consent stays null (the run parks)", () => {
    expect(resolvePlanAnswers(plan, { approved: [], declined: [], edits: {} }, { consentFlag: null }).consentMode).toBeNull()
  })

  it("edits count only on editable lines and only with valid values", () => {
    const resolved = resolvePlanAnswers(
      plan,
      {
        approved: [DECISION_LINE_IDS.conversionNames],
        declined: [],
        edits: { consent_mode: "not-required", conversion_names: "start_trial, sign_up", [`install_provider:ga4:${IDS.ga4}`]: "G-HIJACK" }
      },
      { consentFlag: null }
    )
    expect(resolved.consentMode).toBe("not_required")
    expect(resolved.conversions).toEqual(["start_trial", "sign_up"])
    expect(resolved.approvals.edits).not.toHaveProperty(`install_provider:ga4:${IDS.ga4}`)
    const bad = resolvePlanAnswers(plan, { approved: [], declined: [], edits: { consent_mode: "maybe", conversion_names: "Sign Up!" } }, { consentFlag: null })
    expect(bad.consentMode).toBeNull()
    expect(bad.conversions).toEqual([])
  })

  it("declined beats approved; unknown line ids are ignored", () => {
    const resolved = resolvePlanAnswers(plan, { approved: ["server_lane", "no_such_line"], declined: ["server_lane"], edits: {} }, { consentFlag: null })
    expect(resolved.lines.find((line) => line.id === "server_lane")?.approved).toBe(false)
    expect(resolved.approvals.approved).not.toContain("no_such_line")
  })
})

describe("review fixes (O7 fix round)", () => {
  const consent = { consent_mode: "not_required" }
  const census = (entries: Array<Record<string, unknown>>) =>
    ({ entries, envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }) as unknown as WizardBeforeFactsCensus

  it("P0-1: two duplicates, decline ONE → only the approved one's job 6 is seeded (no 'first line of the kind' fallback)", () => {
    const before = fakeBefore({
      census: census([
        { tool: "ga4", kind: "gtag_config", id: "G-AAAA1111", file: "index.html", line: 3, owner: "adopted" },
        { tool: "ga4", kind: "gtag_config", id: "G-AAAA1111", file: "index.html", line: 9, owner: "adopted" },
        { tool: "ga4", kind: "gtag_config", id: "G-BBBB2222", file: "index.html", line: 12, owner: "adopted" },
        { tool: "ga4", kind: "gtag_config", id: "G-BBBB2222", file: "index.html", line: 14, owner: "adopted" }
      ])
    })
    const candidates = [candidate("duplicates_remove", "ga4_config:G-AAAA1111"), candidate("duplicates_remove", "ga4_config:G-BBBB2222")]
    const plan = buildPlanModel(input({ before, candidates }))
    const dupLines = plan.lines.filter((line) => line.kind === "remove_duplicate")
    expect(dupLines.map((line) => line.jobIds)).toEqual([["duplicates_remove:ga4_config:G-AAAA1111"], ["duplicates_remove:ga4_config:G-BBBB2222"]])
    const [lineA, lineB] = dupLines
    const answers = resolvePlanAnswers(plan, { approved: ["consent_mode", lineA!.id, "agent_budget"], declined: [lineB!.id], edits: consent }, { consentFlag: null })
    const seeded = gateSeededItems(plan, answers, candidates)
    expect(seeded.map((item) => item.id)).toEqual(["duplicates_remove:ga4_config:G-AAAA1111"])
    expect(seeded[0]!.state).toBe("pending")
  })

  it("P0-1: an unmatched candidate gets its OWN line; it never rides another line of the same kind", () => {
    const ga4Id: ImproveLine = { id: "improve_additive:ga4:id", kind: "improve_additive", provider: "ga4", target: "id", text: "GA4: change the id.", owner: "agent", evidence: { file: "index.html", line: 3 } }
    const plan = buildPlanModel(input({ scan: scanFacts({ improve: [ga4Id], adopted: [{ provider: "ga4", via: "snippet", file: "index.html", line: 3, key: IDS.ga4Other }] }), candidates: [candidate("ga4_improve", "spa_page_view")] }))
    expect(plan.lines.find((line) => line.id === "improve_additive:ga4:id")?.jobIds).not.toContain("ga4_improve:spa_page_view")
    expect(plan.lines.find((line) => line.id === "improve_additive:ga4:spa_page_view")?.jobIds).toEqual(["ga4_improve:spa_page_view"])
  })

  it("P2-14: an agent improve line no detector seeds gets its own item behind the same gate; declined → none", () => {
    const plan = buildPlanModel(input({ scan: scanFacts({ improve: adoptedPosthogLines, adopted: [{ provider: "posthog", via: "snippet", file: "index.html", line: 5, key: IDS.posthog }] }) }))
    expect(plan.seeds.map((item) => item.id).sort()).toEqual(["posthog_improve:defaults", "posthog_improve:history_change", "posthog_improve:proxy"])
    const defaults = plan.lines.find((line) => line.id === "posthog_defaults_bump_adopted:posthog:defaults")!
    expect(defaults.jobIds).toEqual(["posthog_improve:defaults"])
    const approve = resolvePlanAnswers(plan, { approved: ["consent_mode", defaults.id, "agent_budget"], declined: [], edits: consent }, { consentFlag: null })
    expect(gateSeededItems(plan, approve, plan.seeds).find((item) => item.id === "posthog_improve:defaults")?.state).toBe("pending")
    const decline = resolvePlanAnswers(plan, { approved: ["consent_mode", "agent_budget"], declined: [defaults.id], edits: consent }, { consentFlag: null })
    expect(gateSeededItems(plan, decline, plan.seeds).map((item) => item.id)).not.toContain("posthog_improve:defaults")
  })

  it("P2-10: metaGoal is data; with no recommendation the line is info and the answer is null (never StartTrial from copy)", () => {
    const meta = scanFacts({ adopted: [{ provider: "meta", via: "snippet", file: "index.html", line: 6, key: IDS.meta }] })
    const none = buildPlanModel(input({ scan: meta }))
    expect(none.metaGoal).toBeNull()
    expect(none.lines.find((line) => line.id === "meta_goal")?.requires).toBe("info")
    expect(resolvePlanAnswers(none, { approved: ["consent_mode", "meta_goal"], declined: [], edits: consent }, { consentFlag: null }).metaGoal).toBeNull()
    const shop = buildPlanModel(input({ scan: meta, candidates: [candidate("server_conversions", "purchase")] }))
    expect(resolvePlanAnswers(shop, { approved: ["consent_mode", "meta_goal"], declined: [], edits: consent }, { consentFlag: null }).metaGoal).toBe("Purchase")
  })

  it("P2-16: an SPA's after-navigation page view is not a GTM + gtag duplicate", () => {
    const gtm = { tool: "ga4", kind: "gtm", id: "GTM-ABC1234", file: "index.html", line: 3, owner: "adopted" }
    const gtag = { tool: "ga4", kind: "gtag_config", id: IDS.ga4, file: "index.html", line: 9, owner: "adopted" }
    const dryLive = {
      loads: [{ label: "home" }],
      ga4: { events: [{ tid: IDS.ga4, en: "page_view", loadLabel: "home", afterNav: false }, { tid: IDS.ga4, en: "page_view", loadLabel: "home", afterNav: true }] },
      meta: { tr: [] }
    } as unknown as TestResult
    expect(duplicateFindings(fakeBefore({ census: census([gtm, gtag]), dryLive }))).toEqual([])
  })

  it("P2-17: the D10 count is autoConfig's own events only, and '—' when the pixel did not fire or was blocked", () => {
    const meta = scanFacts({ improve: adoptedMetaLines, adopted: [{ provider: "meta", via: "snippet", file: "index.html", line: 6, key: IDS.meta }] })
    const dry = (tr: Array<{ ev: string }>, console: string[] = []) =>
      ({ loads: [{ label: "home" }], environment: { blockedBySiteBotRules: false }, meta: { tr: tr.map((event) => ({ ...event, pixelId: IDS.meta })), console }, ga4: { events: [] } }) as unknown as TestResult
    const measured = (dryLive: TestResult) => buildPlanModel(input({ scan: meta, before: fakeBefore({ dryLive }) })).lines.find((line) => line.kind === "autoconfig_off_adopted")
    // The site's own ViewContent / Lead are not automatic events.
    expect(measured(dry([{ ev: "PageView" }, { ev: "ViewContent" }, { ev: "Lead" }]))?.measured?.value).toBe("0 automatic events per visit, no clicks")
    expect(measured(dry([{ ev: "PageView" }, { ev: "Microdata" }]))?.measured?.value).toBe("1 automatic events per visit, no clicks")
    // NEGATIVE: a pixel held by consent (no PageView at all) or blocked by Traffic Permissions is unmeasured, never 0.
    expect(measured(dry([]))?.measured).toBeUndefined()
    expect(measured(dry([]))?.text).toContain("Measured: —")
    expect(measured(dry([{ ev: "PageView" }], ["traffic_permissions_blocked"]))?.measured).toBeUndefined()
  })

  it("P2-18: unless the agent-budget (cost) line is approved, every agent job waits for the user", () => {
    const candidates = [candidate("identify_reset", "auth")]
    const plan = buildPlanModel(input({ candidates }))
    const declined = resolvePlanAnswers(plan, { approved: ["consent_mode"], declined: ["agent_budget"], edits: consent }, { consentFlag: null })
    expect(gateSeededItems(plan, declined, candidates)[0]).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    const approved = resolvePlanAnswers(plan, { approved: ["consent_mode", "agent_budget"], declined: [], edits: consent }, { consentFlag: null })
    expect(gateSeededItems(plan, approved, candidates)[0]?.state).toBe("pending")
  })

  it("P2-19: job 7 carries the plan's exact exempt hosts and deny list", () => {
    const plan = buildPlanModel(input({ scan: scanFacts({ improve: adoptedMetaLines, adopted: [{ provider: "meta", via: "snippet", file: "index.html", line: 6, key: IDS.meta }] }), candidates: [candidate("preview_guard", "meta")] }))
    expect(plan.lines.find((line) => line.id === "preview_guard_adopted:meta:init")?.jobIds).toEqual(["preview_guard:meta"])
    const [item] = withGuardHosts([candidate("preview_guard", "meta")], plan.guard)
    expect(item!.trigger.finding).toContain("ALWAYS fire (exempt first): acme-store.com")
    expect(item!.trigger.finding).toContain(".vercel.app")
    // NEGATIVE: with no guard, nothing is added.
    expect(withGuardHosts([candidate("preview_guard", "meta")], { emit: false, reason: "no_production_host" })[0]!.trigger.finding).not.toContain("ALWAYS fire")
  })

  it("P3-24: the privacy draft follows the approved lines — no server-lane sentence when the lane is declined", () => {
    const plan = buildPlanModel(input())
    expect(plan.decisions.privacyText).toContain("Our server also tells Infinite")
    const approvedLines = plan.lines.filter((line) => line.requires === "approval").map((line) => line.id)
    const withLane = resolvePlanAnswers(plan, { approved: approvedLines, declined: [], edits: consent }, { consentFlag: null })
    expect(withLane.privacyText).toContain("Our server also tells Infinite")
    const noLane = resolvePlanAnswers(plan, { approved: approvedLines.filter((id) => id !== "server_lane"), declined: ["server_lane"], edits: consent }, { consentFlag: null })
    expect(noLane.privacyText).not.toContain("Our server also tells Infinite")
    expect(noLane.privacyText).toContain("We use Infinite")
  })

  it("P1-6: Infinite that cannot be installed (a static site off Vercel) is a user-action line, never an install line", () => {
    const plan = buildPlanModel(input({ scan: scanFacts({ framework: "static-html", infiniteBlocked: "your site is not served through Vercel" }) }))
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:infinite"))).toBe(false)
    expect(plan.lines.find((line) => line.id === "user_action:infinite_blocked")).toMatchObject({ requires: "user_action" })
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:ga4"))).toBe(true)
  })
})
