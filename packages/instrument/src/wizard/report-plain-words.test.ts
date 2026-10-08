// Live run 3 (the founder's rule: screens say what the pull request DOES, or the action left for the owner). The report,
// the PR text, the merge card and the terminal lead with what the PR adds, list the review agent's asks in plain
// sentences, say each owner action once, keep the owner's setup steps, and send findings on Infinite's own files to
// Infinite: no review ids, no check ids, no internal codes, no "— / pending" footnotes, no disclaimer about what the run
// did not touch.
import { describe, expect, it } from "vitest"

import { candidate } from "../../test/wizard/o7-fakes.js"
import { emptyLedger, openFindings, recordDecisions } from "../review/ledger.js"
import { howToReviewSection, reviewerBrief } from "../review/brief.js"
import { managedFileDesigns, managedFilesBrief } from "../review/managed-design.js"
import { triage, type TriageItem } from "../review/triage.js"
import { OWNER_BOUNDARY } from "../jobs/owner-boundary.js"
import { withDistinctTitles } from "../jobs/registry.js"
import type { Cell, OwnerSetupSteps, VerdictOpenFinding } from "./contracts/report.js"
import type { ChecklistItem } from "./contracts/jobs.js"
import { findingSentence, prDoesSentence } from "./pr-summary.js"
import { buildReport, renderMarkdown, renderTerminal } from "./report.js"
import { computeVerdict, incompleteParts, ownerBlockers } from "./verdict.js"

const RUN = "11111111-1111-4111-8111-111111111111"
const AT = "2026-10-08T23:00:00.000Z"

/** The store's finished jobs, as live run 3 left them. */
function storeJobs(): ChecklistItem[] {
  const site = { file: "pages/products/[slug].tsx", line: 20, via: "helper:viewItem" }
  return [
    candidate("meta_improve", "commerce_events", { title: "Add Meta ViewContent and AddToCart in the browser", state: "done_in_code", inventory: [{ event: "view_item", sites: [site], tools: {}, missing: ["meta_browser"] }, { event: "add_to_cart", sites: [site], tools: {}, missing: ["meta_browser"] }] }),
    candidate("server_conversions", "begin_checkout", { title: "Report checkout starts from the server", state: "waiting_real_event" }),
    candidate("server_conversions", "purchase", { title: "Report purchases from a new payment webhook", state: "waiting_real_event" }),
    candidate("preview_guard", "ga4", { state: "left_for_you", checks: [], note: "For you: add the preview guard to GA4's start-up at src/analytics/tracking.ts:150; until then preview and local visits count in GA4.", ownerBoundary: { kind: "frozen_unit", file: "src/analytics/tracking.ts", line: 150, unitHash: "h1", guard: "--- a/src/analytics/tracking.ts\n+++ b/src/analytics/tracking.ts\n@@ -1,1 +1,1 @@\n-gtag('config', GA_ID)\n+if (allowed) gtag('config', GA_ID)" } }),
    candidate("preview_guard", "meta", { state: "left_for_you", checks: [], note: "For you: add the preview guard to Meta pixel's start-up at src/analytics/tracking.ts:190; until then preview and local visits count in Meta pixel.", ownerBoundary: { kind: "frozen_unit", file: "src/analytics/tracking.ts", line: 190, unitHash: "h2" } })
  ]
}

/** Live run 3's open findings: two on the owner's code, one blocker on Infinite's own outcome helper. */
const FINDINGS: VerdictOpenFinding[] = [
  { findingId: "F4", item: "R10", severity: "blocker", path: "lib/infinite-outcome.ts", line: 963, label: "the wizard's own change", summary: "Checkout and lead reporting stop waiting after 800 ms and never retry." },
  { findingId: "F1", item: "R8", severity: "blocker", path: "pages/cart.tsx", line: 71, label: null, summary: "The hidden tracking signal reads getConsent() only during rendering." },
  { findingId: "F3", item: "R2", severity: "should", path: "pages/api/mailing-list.ts", line: 35, label: null, summary: "signupId is a fresh UUID on every request." }
]

const STEPS: OwnerSetupSteps = {
  file: "docs/infinite-server-events.md",
  purchase: true,
  steps: ["In **Site Analytics → Settings → Conversions → Server events**, click **Generate secret**.", "In your hosting's **production** environment variables, add `INFINITE_SERVER_EVENT_SECRET`.", "In **Stripe → Developers → Webhooks**, add the endpoint `https://shop.example/api/stripe-webhook`."]
}

const BOUNDARY = { state: "checked" as const, scope: "commit" as const, baseSha: "c".repeat(40), headSha: "d".repeat(40), measuredCommitCount: 1, wizardCommits: ["a".repeat(40)], issues: [], files: ["lib/infinite-outcome.ts", "pages/api/stripe-webhook.ts", "pages/cart.tsx"], filesAvailable: true }

function storeReport(jobs = storeJobs(), findings = FINDINGS) {
  const pass: Cell = { state: "pass", value: "pass", display: "previews silent", provenance: { source: "wizard_check", at: AT, runId: RUN } }
  const does = prDoesSentence(jobs, { metaInUse: true })
  return buildReport({
    runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/shop", productionHost: "shop.example" },
    columns: { live_today: null, in_pr: { meta: { measuredAt: AT, sha: "b".repeat(40) }, cells: {}, finishLine: { previews_silent: pass } }, proven_live: null },
    provenLivePending: "deploy", runStartedAt: null, day7: null, notes: [],
    verdictFacts: { jobs, openFindings: findings, does, ownerSteps: STEPS, ownerBoundary: BOUNDARY, tools: null, installedUnknown: null }
  })
}

/** Words no owner-facing surface may carry. */
const JARGON = [/\bR\d{1,2}\b/, /\bF\d{1,2}\b/, /\bINF_[A-Z_]+/, /NOT DONE/, /left for the owner/, /— \/ pending/, /Checks passing/, /\+\d+ more/, /The wizard did not apply/, /Full text in the pull request/, /Review finding on/, /each tool once|ids match connections|previews silent|spa page views/]

describe("what the pull request does, in plain words", () => {
  it("one sentence from the jobs that are done and the events each carries (the founder's example)", () => {
    expect(prDoesSentence(storeJobs(), { metaInUse: true })).toBe(
      "Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons; sends checkout starts and purchases (value, currency, products, customer match data) from your server and a new payment webhook to Meta and Infinite."
    )
    // A job not in the code (left for the owner, failed, claimed) is never said as done.
    expect(prDoesSentence(storeJobs().map((job) => ({ ...job, state: "failed" as const })))).toBeNull()
    // Meta not in use: no Meta, no match data.
    expect(prDoesSentence(storeJobs().filter((job) => job.jobId === "server_conversions"), { metaInUse: false })).toBe("Sends checkout starts and purchases (value, currency, products) from your server and a new payment webhook to Infinite.")
  })

  it("two jobs of one kind are told apart by what they do, never by their internal target key", () => {
    const titles = withDistinctTitles([candidate("posthog_improve", "history_change"), candidate("posthog_improve", "sensitive_pages")]).map((job) => job.title)
    expect(titles).toEqual(["Improve the existing PostHog: page-change counting", "Improve the existing PostHog: sensitive pages"])
  })

  it("a finding in the reviewer's own words: its first two sentences (a dot inside a host or path never ends one)", () => {
    expect(findingSentence("The only rewrite is /infinite/ledger. No PostHog /ingest rewrite exists, so it still uses us.i.posthog.com. Third sentence.")).toBe("The only rewrite is /infinite/ledger. No PostHog /ingest rewrite exists, so it still uses us.i.posthog.com.")
  })
})

describe("the verdict: a finding on Infinite's own files never blocks the owner's pull request", () => {
  it("only owner blockers count; the headline leads with what the PR does and names no ids", () => {
    expect(ownerBlockers(FINDINGS).map((finding) => finding.path)).toEqual(["pages/cart.tsx"])
    const report = storeReport()
    const verdict = report.verdict!
    expect(verdict.headline.startsWith("Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons;")).toBe(true)
    const blockers = verdict.reasons.find((reason) => reason.kind === "review_blocker_open")!
    expect(blockers).toEqual({ kind: "review_blocker_open", count: 1, names: ["pages/cart.tsx:71"] })
    // The merge card says it the same way.
    expect(incompleteParts(verdict, storeJobs())).toBe("the review agent asks you to look at one thing (pages/cart.tsx:71)")
    // With only the Infinite finding open, nothing blocks.
    const onlyInfinite = computeVerdict({ site: "shop.example", finishLine: report.finishLine, provenLive: report.columns.proven_live, jobs: storeJobs(), openFindings: [FINDINGS[0]!], tools: null, installedUnknown: null })
    expect(onlyInfinite.reasons.some((reason) => reason.kind === "review_blocker_open")).toBe(false)
    for (const words of JARGON) expect(verdict.headline).not.toMatch(words)
  })

  it("triage sends a blocker on Infinite's own file to Infinite, and the open findings keep it out of the owner's blockers", () => {
    const item: TriageItem = { source: "reviewer", threadId: null, findingId: "F4", item: "R10", category: "security", severity: "blocker", path: "lib/infinite-outcome.ts", line: 963, body: "No retry after 800 ms.", suggestedFix: null }
    const [decision] = triage([item], { allowlist: ["lib/infinite-outcome.ts"], declinedKeys: new Set(), passingChecks: new Set(), answerFor: () => null, ownership: (path) => (path === "lib/infinite-outcome.ts" ? "the wizard's own change" : null) })
    expect(decision).toMatchObject({ action: "INFINITE" })
    const ledger = emptyLedger(RUN)
    recordDecisions(ledger, [decision!], 1)
    const open = openFindings(ledger, [])
    expect(open).toHaveLength(1)
    expect(ownerBlockers(open)).toEqual([])
  })
})

describe("report.md, the PR text and the terminal", () => {
  it("markdown: headline, the review agent's asks, For you once, the owner's steps, files changed, For Infinite", () => {
    const report = storeReport()
    const text = renderMarkdown(report, BOUNDARY, storeJobs(), [], { ownerSteps: STEPS, findings: FINDINGS })
    const first = text.split("\n")[0]!
    expect(first).toMatch(/^\*\*Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons; sends checkout starts and purchases/)
    expect(text).toContain("**The review agent asks you to look at one thing:**\n\n- pages/cart.tsx:71: The hidden tracking signal reads getConsent() only during rendering.")
    expect(text).toContain("<details><summary>The review agent also has one smaller suggestion</summary>\n\n- pages/api/mailing-list.ts:35: signupId is a fresh UUID on every request.")
    // Each owner action once, in the For you list, its exact change folded under it.
    expect(text).toContain("### For you")
    expect(text.split("preview and local visits count in GA4")).toHaveLength(2)
    expect(text).toContain("- Add the preview guard to GA4's start-up at src/analytics/tracking.ts:150")
    expect(text).toContain("  <details><summary>The change at src/analytics/tracking.ts:150 (keep your consent checks, grants and revocations outside it)</summary>")
    // The owner's setup steps are kept, with the exact steps, before the table.
    expect(text).toContain("### Before purchases reach Meta, do these steps\n\nUntil they are done, the server code in this pull request sends nothing. They are also in `docs/infinite-server-events.md`.\n\n1. In **Site Analytics")
    expect(text).toContain("3. In **Stripe → Developers → Webhooks**")
    expect(text.indexOf("### Before purchases reach Meta")).toBeLessThan(text.indexOf("### Before and after"))
    // A short list of the files changed; no disclaimer about what was left as it was.
    expect(text).toContain("Files changed:\n- lib/infinite-outcome.ts\n- pages/api/stripe-webhook.ts\n- pages/cart.tsx")
    expect(text).not.toContain(OWNER_BOUNDARY)
    // Findings on Infinite's own files go to Infinite, never onto the owner's list.
    expect(text).toContain("### For Infinite")
    expect(text).toContain("- lib/infinite-outcome.ts:963: Checkout and lead reporting stop waiting after 800 ms and never retry.")
    expect(text.indexOf("lib/infinite-outcome.ts:963")).toBeGreaterThan(text.indexOf("### For Infinite"))
    // Checks by their plain names; one plain line for the dashes.
    expect(text).toContain("| Previews and local visits are not counted |")
    expect(text).toMatch(/Why some cells show —: [^\n]*waiting for the deploy/)
    for (const words of JARGON) expect(text).not.toMatch(words)
  })

  it("terminal: the same order and words, with the steps in full", () => {
    const report = storeReport()
    const text = renderTerminal(report, 120, { ownerJobs: storeJobs(), ownerBoundary: BOUNDARY, ownerSteps: STEPS })
    expect(text.split("\n")[0]).toMatch(/^◆ Adds Meta ViewContent on product pages/)
    expect(text).toContain("The review agent asks you to look at one thing:\n- pages/cart.tsx:71: The hidden tracking signal")
    expect(text).toContain("Before purchases reach Meta, do these steps\n1. In Site Analytics → Settings → Conversions → Server events, click Generate secret.")
    expect(text).toContain("Files changed:\n- lib/infinite-outcome.ts\n- pages/api/stripe-webhook.ts")
    expect(text).toContain("For Infinite")
    for (const words of JARGON) expect(text).not.toMatch(words)
  })

  it("the cloud's notes carry the asks and Infinite's findings as plain lines, never ids", () => {
    const notes = storeReport().notes
    expect(notes).toContain("The review agent asks you to look at pages/cart.tsx:71: The hidden tracking signal reads getConsent() only during rendering.")
    expect(notes).toContain("For Infinite: lib/infinite-outcome.ts:963: Checkout and lead reporting stop waiting after 800 ms and never retry.")
    expect(notes).toContain("Before purchases reach Meta, do these steps: the 3 steps in docs/infinite-server-events.md.")
    for (const note of notes) for (const words of JARGON) expect(note).not.toMatch(words)
  })
})

describe("the reviewer is told which files are Infinite's, and what is deliberate in them", () => {
  it("managed files are found by their banner; the outcome helper's bounded wait is documented as deliberate", () => {
    const files = managedFileDesigns([
      { path: "lib/infinite-outcome.ts", text: "// Managed by Infinite. Public install artifacts only.\nexport {}\n" },
      { path: "next.config.mjs", text: "export default {}\n" },
      { path: "lib/infinite-analytics.ts", text: "// Managed by Infinite. Public install artifacts only.\n" }
    ])
    expect(files.map((file) => file.path)).toEqual(["lib/infinite-outcome.ts", "lib/infinite-analytics.ts"])
    const paragraph = managedFilesBrief(files)!
    expect(paragraph).toContain("Infinite's managed files in this change: lib/infinite-outcome.ts, lib/infinite-analytics.ts.")
    expect(paragraph).toContain("waits at most 800 ms")
    expect(paragraph).toContain("so the payment provider retries")
    expect(paragraph).toContain("never report one as a finding")
    expect(paragraph).toContain("it never blocks this pull request")
    const brief = reviewerBrief({ reviewer: "codex", prNumber: 2, repoLabel: "example/shop", tagVersion: "0.0.0", runId: RUN, inputs: { diff: "d", plan: "p", checks: "c" }, managedFiles: files })
    expect(brief).toContain(paragraph)
    expect(managedFilesBrief([])).toBeNull()
  })

  it("the PR body's review list is words only; the reviewer agent keeps the item ids its answer names", () => {
    const section = howToReviewSection()
    expect(section).toContain("- Coverage, lanes and money: every event the plan promised")
    expect(section).not.toMatch(/\bR\d{1,2}\b/)
    expect(reviewerBrief({ reviewer: "codex", prNumber: 2, repoLabel: "example/shop", tagVersion: "0.0.0", runId: RUN, inputs: { diff: "d", plan: "p", checks: "c" } })).toContain("- **R10** Coverage, lanes and money")
  })
})
