// Live run 4's report polish: the headline never cuts a word ("adds the analytics re…"), the problems not re-checked
// after the deploy are said once, and the owner's steps list LEAD_ID_SECRET only where the server code reads it.
import { describe, expect, it } from "vitest"

import { renderServerEventsHandoff, type ServerEventsHandoffFacts } from "../server-lane/handoff.js"
import type { Cell, ReportV2 } from "./contracts/report.js"
import { VERDICT_LIMITS } from "./contracts/report.js"
import { verdictReasonLines } from "./report.js"
import { computeVerdict, doesWithin, UNCHECKED_WORDS, wordsWithin, type VerdictInput } from "./verdict.js"

const RUN = "11111111-1111-4111-8111-111111111111"
const AT = "2026-10-09T09:00:00.000Z"

const DOES =
  "Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons; sends checkout starts and purchases (value, currency, products, customer match data) from your server and a new payment webhook to Meta and Infinite; saves Meta ad click ids when a visitor lands; adds the analytics rewrites to your Next config."
const COMMERCE = "Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons"

const cell = (state: Cell["state"], display: string): Cell =>
  state === "not_measured"
    ? { state, value: null, display: "—", reason: "not_exercised", provenance: { source: "wizard_check", at: AT, runId: RUN } }
    : { state, value: state, display, provenance: { source: "wizard_check", at: AT, runId: RUN } }

/** A deployed site measured once (csp passes) with two problems from before the merge that were not measured again. */
function input(does: string | null): VerdictInput {
  const dash = cell("not_measured", "—")
  const line = (id: string, liveToday: Cell, provenLive: Cell) => ({ id, cells: { live_today: liveToday, in_pr: dash, proven_live: provenLive } })
  return {
    site: "fresh-acme.com",
    finishLine: [
      line("ids_match_connections", cell("problem", "problem"), dash),
      line("survives_ad_blockers", cell("problem", "problem"), dash),
      line("csp_allows", cell("pass", "pass"), cell("pass", "no CSP violation"))
    ],
    provenLive: { measuredAt: AT, sha: "a".repeat(40), pending: null },
    jobs: [],
    openFindings: [],
    tools: null,
    installedUnknown: null,
    does
  } as unknown as VerdictInput
}

describe("the headline never cuts a word", () => {
  it("drops whole clauses from the end, keeping the shop-events clause first", () => {
    const short = doesWithin(DOES, 240)
    expect(short).toBe(
      "Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons; sends checkout starts and purchases (value, currency, products, customer match data) from your server and a new payment webhook to Meta and Infinite."
    )
    expect(doesWithin(DOES, 120)).toBe(`${COMMERCE}.`)
    expect(doesWithin(DOES, 1000)).toBe(DOES)
  })

  it("a first clause wider than the room ends at a whole word with '…', never mid-word", () => {
    const cut = doesWithin(DOES, 50)
    expect(cut.length).toBeLessThanOrEqual(50)
    expect(cut).toBe("Adds Meta ViewContent on product pages and…")
    expect(wordsWithin("one two three", 9)).toBe("one two…")
  })

  it("the verdict's headline keeps every word of the clauses it shows (live run 4: 'adds the analytics re…')", () => {
    const long = `${DOES.replace(/\.$/, "")}; ${"adds a very long clause about the analytics rewrites ".repeat(6).trim()}.`
    const verdict = computeVerdict(input(long))
    expect(verdict.headline.length).toBeLessThanOrEqual(VERDICT_LIMITS.headlineMaxChars)
    expect(verdict.headline.startsWith(`${COMMERCE};`)).toBe(true)
    // What the PR does ends at a whole clause (the long last one is dropped), then the state follows in full.
    expect(verdict.headline).toMatch(/to your Next config\. fresh-acme\.com: /)
    expect(verdict.headline).not.toContain("a very long clause")
    expect(verdict.headline).toMatch(/ad blockers\)$/)
    expect(verdict.headline).not.toMatch(/\w…/)
  })
})

describe("problems not re-checked after the deploy are said once", () => {
  it("the headline names them, so the report adds no second line for them", () => {
    const verdict = computeVerdict(input(null))
    expect(verdict.headline).toContain(`2 earlier problems ${UNCHECKED_WORDS} (`)
    expect(verdict.reasons.some((reason) => reason.kind === "earlier_problem_unchecked")).toBe(true)
    const lines = verdictReasonLines({ verdict } as ReportV2)
    expect(lines.filter((line) => line.includes("not re-checked after the deploy"))).toEqual([])
  })

  it("P0-2: a previews problem whose after-deploy check was not tried (deployment address behind a login) counts as not re-checked", () => {
    const base = input(null)
    const notTried: Cell = { state: "info", value: "info", display: "not tried (the deployment address needs a Vercel login)", reason: "preview_protected", provenance: { source: "desktop_test", at: AT, runId: RUN } }
    const verdict = computeVerdict({ ...base, finishLine: [...base.finishLine, { id: "previews_silent", cells: { live_today: cell("problem", "problem"), in_pr: base.finishLine[0]!.cells.in_pr, proven_live: notTried } }] } as VerdictInput)
    expect(verdict.reasons.find((reason) => reason.kind === "earlier_problem_unchecked")!.count).toBe(3)
  })

  it("NEGATIVE: a headline that does not name them keeps the line", () => {
    const verdict = { state: "problems" as const, headline: "fresh-acme.com does not collect properly yet: 1 problem on the live site (the IDs)", reasons: [{ kind: "earlier_problem_unchecked" as const, count: 1, names: ["events get past ad blockers"] }], installed: [] }
    expect(verdictReasonLines({ verdict } as unknown as ReportV2)).toEqual(["Problems found before the merge and not re-checked after the deploy: events get past ad blockers"])
  })
})

describe("the owner's steps list LEAD_ID_SECRET only where the server code reads it", () => {
  const facts = (conversions: string[], usesStripe: boolean): ServerEventsHandoffFacts => ({
    conversions,
    productionHost: "fresh-acme.com",
    siteSourceKey: "site_public_test",
    envSetByInfinite: false,
    metaConnected: true,
    usesStripe,
    usesPosthog: false,
    webhookUrlPath: "/api/stripe-webhook"
  })
  const envStep = (text: string) => text.split("\n").find((line) => line.includes("environment variables, add:"))!

  it("NEGATIVE: checkout starts alone (no sign-up, no customer email) never list it, and the sentence still reads whole", () => {
    expect(envStep(renderServerEventsHandoff(facts(["begin_checkout"], true)))).toBe(
      "4. In your hosting's **production** environment variables, add: `INFINITE_SITE_SOURCE_KEY` = `site_public_test`, `INFINITE_SERVER_EVENT_SECRET` = the secret from the step above and `STRIPE_WEBHOOK_SECRET` (from the Stripe step below). Then redeploy: a running deployment does not pick up new variables."
    )
    expect(envStep(renderServerEventsHandoff(facts(["begin_checkout"], false)))).toBe(
      "4. In your hosting's **production** environment variables, add: `INFINITE_SITE_SOURCE_KEY` = `site_public_test` and `INFINITE_SERVER_EVENT_SECRET` = the secret from the step above. Then redeploy: a running deployment does not pick up new variables."
    )
  })

  it("a sign-up job lists it (its event id is keyed by it)", () => {
    const step = envStep(renderServerEventsHandoff(facts(["lead"], false)))
    expect(step).toContain("`LEAD_ID_SECRET` = a long random value you make once and never change")
    expect(step).toMatch(/`INFINITE_SERVER_EVENT_SECRET` = the secret from the step above and `LEAD_ID_SECRET`/)
  })

  it("a purchase from the payment webhook lists it, saying what it is for (the buyer's match id comes from it)", () => {
    const step = envStep(renderServerEventsHandoff(facts(["begin_checkout", "purchase"], true)))
    expect(step).toContain("it turns each customer's email into one private id Meta matches them by")
    expect(step).toMatch(/`LEAD_ID_SECRET` = .* and `STRIPE_WEBHOOK_SECRET` \(from the Stripe step below\)\./)
  })
})
