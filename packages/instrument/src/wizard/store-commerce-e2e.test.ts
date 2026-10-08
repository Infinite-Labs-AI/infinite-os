// The store end-to-end (review r3: brief item 5 was never built). An invented hardware store shaped like the first
// real customer (`test/wizard/fixtures/store/site`): Next pages router, Buy buttons that add to a cart and change page,
// a Stripe Checkout API route that redirects, a success page that fires GA4 / PostHog `purchase` once per session, a
// mailing-list form and API, GA4 + PostHog + a Meta pixel that sends PageView only and is kept off /cart, /success and
// /mailing-list, and all of the trackers behind a cookie banner whose code lives in the trackers file.
//
// It runs the wizard's REAL scan, event inventory, job seeding, plan and briefs on it, then plays the agent: the
// scripted edits are the CORRECT ones (`fixtures/store/correct`, the reference store's hand-built fix ported onto
// this store), and the bad variants of them.
//
// Who catches what (founder ruling 2026-10-08: "take a lot of the silly regex out"):
//   - the HARD rules stay static and blocking: a purchase without its value or currency, a page-made Meta event id, a
//     phone or a raw personal detail in an outcome (and the fence, the build, the consent boundary);
//   - every judgement of meaning (each event once per action, the tracking signal carried with the right polarity, the
//     report after the success point, match data on the report, a send that survives the page leaving, the site's own
//     sends kept) is a REVIEW question (`review/questions.ts`), answered right after the agent's turns
//     (`wizard/steps/jobs-review.ts`). Here a scripted fake reviewer gives the answers a competent reviewer would, so
//     the tests prove the plumbing: the question carries the facts, a "fail" goes back for one fix round, a fail that
//     stays "needs your look" with the edits KEPT, and a pass proves the job.
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { fixtureHosting, fixtureKeys } from "../../test/wizard/o8/fixtures.js"
import { runCensus } from "../checks/census.js"
import type { EventInventory, InventoryEvent, InventoryTool } from "../checks/commerce-inventory.js"
import { readEventInventory } from "../checks/commerce-inventory.js"
import { commerceFindings } from "../checks/commerce-static.js"
import { createScanner } from "../review/scan.js"
import type { JobReviewResult, ReviewRunInput } from "./contracts/agents.js"
import type { WizardContext, WizardDeps } from "./contracts/deps.js"
import { JOBS_REVIEW_INPUTS, jobsReviewKeepsDraft, reviewJobsBeforeSettling, type JobsReviewHost, type JobsReviewOutcome } from "./steps/jobs-review.js"
import { createWizardInstaller } from "../install/installer.js"
import { seedItemsAfterApprovals, type WizardPlanModel } from "../install/plan-model.js"
import { createJobRegistry, toJobScan } from "../jobs/registry.js"
import type { BriefFacts } from "../jobs/briefs.js"
import { briefConnectionsFrom, briefPlanFrom } from "../jobs/plan-data.js"
import type { BeforeFacts, ChecklistItem, ScanResult } from "./contracts/jobs.js"
import { commerceProofPlan } from "./steps/prove-commerce.js"

const here = dirname(fileURLToPath(import.meta.url))
const STORE = resolve(here, "../../test/wizard/fixtures/store")
const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const EVENTS: readonly InventoryEvent[] = ["view_item", "add_to_cart", "begin_checkout", "purchase", "lead"]
const META_NAMES: Readonly<Record<string, string>> = { view_item: "ViewContent", add_to_cart: "AddToCart", begin_checkout: "InitiateCheckout", purchase: "Purchase", lead: "Lead" }

/** Every file under `dir`, repo-relative → text. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.set(relative(dir, path).split("\\").join("/"), readFileSync(path, "utf8"))
    }
  }
  walk(dir)
  return out
}

const SITE = tree(join(STORE, "site"))
const CORRECT_EDITS = tree(join(STORE, "correct"))

/** The site with the scripted agent's edits on top. */
function edited(edits: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...SITE, ...edits])
}

/** Before the run: the site's own files, and null for every file the edits create. */
function baseFor(now: ReadonlyMap<string, string>): Map<string, string | null> {
  const base = new Map<string, string | null>(SITE)
  for (const file of now.keys()) if (!base.has(file)) base.set(file, null)
  return base
}

/**
 * The plan's event × tool table for this store, by hand: GA4 and PostHog already get every step from the site's own
 * wrappers (under the site's PostHog names); Meta gets PageView only, so it is promised ViewContent and AddToCart from
 * the page and InitiateCheckout, Purchase and Lead from the server (its pixel is off on the checkout and signup
 * pages); Infinite gets them all.
 */
const EXPECTED: EventInventory = {
  rows: [
    { event: "view_item", sites: [{ file: "pages/products/[slug].tsx", line: 20 }], tools: { ga4: { state: "already_sent" }, posthog: { state: "already_sent", siteEventName: "product_viewed" }, meta: { state: "will_add", lane: "browser" }, infinite: { state: "will_add", lane: "browser" } } },
    { event: "add_to_cart", sites: [{ file: "pages/index.tsx", line: 15 }, { file: "pages/products/[slug].tsx", line: 27 }], tools: { ga4: { state: "already_sent" }, posthog: { state: "already_sent", siteEventName: "product_added" }, meta: { state: "will_add", lane: "browser" }, infinite: { state: "will_add", lane: "browser" } } },
    { event: "begin_checkout", sites: [{ file: "pages/cart.tsx", line: 76 }, { file: "pages/api/checkout.ts", line: 70 }], tools: { ga4: { state: "already_sent" }, posthog: { state: "already_sent", siteEventName: "checkout_started" }, meta: { state: "will_add", lane: "server" }, infinite: { state: "will_add", lane: "server" } } },
    { event: "purchase", sites: [{ file: "pages/success.tsx", line: 27 }], tools: { ga4: { state: "already_sent" }, posthog: { state: "already_sent", siteEventName: "purchase_completed" }, meta: { state: "will_add", lane: "server" }, infinite: { state: "will_add", lane: "server" } } },
    { event: "lead", sites: [{ file: "pages/mailing-list.tsx", line: 36 }, { file: "pages/api/mailing-list.ts", line: 30 }], tools: { ga4: { state: "already_sent", siteEventName: "generate_lead" }, posthog: { state: "already_sent", siteEventName: "mailing_list_joined" }, meta: { state: "will_add", lane: "server" }, infinite: { state: "will_add", lane: "server" } } }
  ]
}

// ---------------------------------------------------------------------------------------------
// The hard rules: static, mechanical, still blocking
// ---------------------------------------------------------------------------------------------

/** The correct webhook with its recipe replaced by a hand-rolled report carrying `props` (and `extra` keys). */
function handRolledWebhook(props: string, extra = ""): string {
  const webhook = CORRECT_EDITS.get("pages/api/stripe-webhook.ts")!
  const recipe = '  return res.status(await reportStripeCheckoutPurchase(event, { path: "/success" })).json({ received: true })\n'
  expect(webhook).toContain(recipe)
  return webhook.replace("import { reportStripeCheckoutPurchase } from", "import { adMatchFromRequest, reportInfiniteOutcome } from").replace(recipe, [
    "  const session = event.data.object as Stripe.Checkout.Session",
    "  const status = await reportInfiniteOutcome({",
    '    type: "purchase",',
    "    eventId: session.id,",
    '    path: "/success",',
    `    properties: ${props},${extra}`,
    "  })",
    "  return res.status(status === null || status >= 500 ? 500 : 200).json({ received: true })",
    ""
  ].join("\n"))
}

const MONEY = '{ value: (session.amount_total ?? 0) / 100, currency: (session.currency ?? "usd").toUpperCase() }'

describe("store: the hard rules still block their cases", () => {
  it("the correct edits break no hard rule: money on the purchase, no page-made Meta event id, no personal data, no phone", () => {
    const now = edited(CORRECT_EDITS)
    expect(commerceFindings({ files: now, base: baseFor(now), inventory: EXPECTED, metaInUse: true })).toEqual([])
  })

  it("a purchase without its currency, a phone in the match data, and a page-made Meta event id each block", () => {
    const rules = (edits: ReadonlyMap<string, string>) => {
      const now = edited(new Map([...CORRECT_EDITS, ...edits]))
      return commerceFindings({ files: now, base: baseFor(now), inventory: EXPECTED, metaInUse: true }).filter((finding) => finding.state === "problem").map((finding) => finding.rule)
    }
    expect(rules(new Map([["pages/api/stripe-webhook.ts", handRolledWebhook("{ value: (session.amount_total ?? 0) / 100 }")]]))).toEqual(["purchase_without_value"])
    expect(rules(new Map([["pages/api/stripe-webhook.ts", handRolledWebhook(MONEY, "\n    adMatch: await adMatchFromRequest(req, { trackingAllowed: true, phone: session.customer_details?.phone }),")]]))).toEqual(["pii_in_outcome"])
    const events = CORRECT_EDITS.get("src/analytics/events.ts")!
    const pageMade = events.replace('infiniteTrack("add_to_cart", productProps(product, qty), { destinations: ["meta", "infinite"] });', 'infiniteTrack("add_to_cart", productProps(product, qty), { destinations: ["infinite"] });\n  fbq("track", "AddToCart", productProps(product, qty), { eventID: `atc-${Date.now()}` });')
    expect(pageMade).toContain("eventID")
    expect(rules(new Map([["src/analytics/events.ts", pageMade]]))).toEqual(["page_built_meta_event_id"])
  })

  it("NEGATIVE: the judgement variants are NOT hard-rule problems (the review owns them): a double count, a purchase without match data, a lead without its fallback id", () => {
    const success = SITE.get("pages/success.tsx")!
      .replace('import Link from "next/link";\n', 'import Link from "next/link";\nimport { infiniteTrack } from "../lib/infinite-analytics";\n')
      .replace("    purchase(sessionId, lines);\n", '    purchase(sessionId, lines);\n    infiniteTrack("purchase", { transaction_id: sessionId });\n')
    for (const edits of [
      new Map([["pages/success.tsx", success]]),
      new Map([["pages/api/stripe-webhook.ts", handRolledWebhook(MONEY)]]),
      new Map([["pages/api/mailing-list.ts", CORRECT_EDITS.get("pages/api/mailing-list.ts")!.replace(/^    fallbackId: .*\n/m, "")]])
    ]) {
      const now = edited(new Map([...CORRECT_EDITS, ...edits]))
      expect(commerceFindings({ files: now, base: baseFor(now), inventory: EXPECTED, metaInUse: true }).filter((finding) => finding.state === "problem")).toEqual([])
    }
  })

  it("the correct edits never touch the trackers file that holds the cookie banner's consent code, nor the privacy page", () => {
    expect(CORRECT_EDITS.has("src/analytics/tracking.ts")).toBe(false)
    expect(CORRECT_EDITS.has("components/CookieBanner.tsx")).toBe(false)
    expect(CORRECT_EDITS.has("pages/privacy.tsx")).toBe(false)
  })

  it("the prove step finds a product page to load and a Buy button to click on the corrected store", () => {
    const now = edited(CORRECT_EDITS)
    expect(commerceProofPlan(EXPECTED, now, ".")).toEqual({ browser: ["view_item", "add_to_cart"], server: ["begin_checkout", "purchase", "lead"], productPath: "/products/halden-studio-reservation" })
    expect([...now.values()].filter((text) => text.includes('data-infinite-conversion="add_to_cart"'))).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------
// The real pipeline: scan → inventory → seeding → plan → briefs (builders A, B, C)
// ---------------------------------------------------------------------------------------------

/** A git repo of the store (the scan reads a real tree), removed after the suite. */
let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tag-store-e2e-"))
  cpSync(join(STORE, "site"), root, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=store@example.com", "-c", "user.name=Store", "commit", "-qm", "store")
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The scan's inventory (builder A): `src/scan/event-inventory.ts` → `buildEventInventory(snapshot: RepoSnapshot)`. */
async function scanInventory(scan: ScanResult): Promise<EventInventory> {
  const path = "../scan/event-inventory.js"
  const module = (await import(/* @vite-ignore */ path)) as { buildEventInventory: (snapshot: ReturnType<typeof toJobScan>["snapshot"]) => unknown }
  const inventory = readEventInventory(module.buildEventInventory(toJobScan(scan).snapshot))
  if (!inventory) throw new Error("buildEventInventory returned no rows")
  return inventory
}

async function pipeline(at: string = root) {
  const keys = fixtureKeys()
  const installer = createWizardInstaller({
    root: at,
    repoFingerprint: `sha256:${"a".repeat(64)}`,
    runId: () => RUN_ID,
    agent: () => ({ worker: "claude_code", whoPays: null }),
    consentFlag: () => null,
    productionDeniedConflict: () => []
  })
  const scan = await installer.scan({ root: at, hosting: fixtureHosting() })
  const before: BeforeFacts = { hosting: fixtureHosting(), keys, census: runCensus({ root: at, appRoot: "." }), dryLive: null, checks: [], observedProductionHost: "www.halden-audio.example" }
  let facts: BriefFacts | null = null
  const registry = createJobRegistry({ briefFacts: () => facts })
  const candidates = registry.seedCandidates(scan, before)
  const plan = installer.buildPlan(scan, keys, before, candidates) as WizardPlanModel
  const approvals = { approved: plan.lines.filter((line) => line.requires === "approval").map((line) => line.id), declined: [], edits: {} }
  const items: ChecklistItem[] = seedItemsAfterApprovals(candidates, plan.seeds ?? [], plan, approvals)
  facts = {
    runId: RUN_ID,
    framework: scan.framework,
    packageManager: scan.packageManager,
    router: "pages",
    appRoot: ".",
    plan: briefPlanFrom(plan, approvals),
    connections: briefConnectionsFrom(keys),
    previewGuard: null,
    helpers: { module: "lib/infinite-analytics.ts" },
    // What the install writes for a Next site with the server lane (its receipt), and the before step's inventory.
    managedFiles: ["lib/infinite-analytics.ts", "lib/infinite-server-lane.ts", "lib/infinite-outcome.ts"],
    inventory: toJobScan(scan).detections.eventInventory
  }
  return { scan, plan, items, registry, brief: registry.brief(items.filter((item) => item.owner === "agent")) }
}

// ---------------------------------------------------------------------------------------------
// The review agent, scripted: the jobs' review right after the agent's turns (`wizard/steps/jobs-review.ts`)
// ---------------------------------------------------------------------------------------------

const COMMERCE_JOBS = ["meta_improve:commerce_events", "server_conversions:begin_checkout", "server_conversions:lead", "server_conversions:purchase"] as const
const NAMES = ["purchase", "begin_checkout", "lead", "add_to_cart", "view_item"]

/** One scripted answer: the job, a phrase of the question it answers, and what a competent reviewer says there. */
interface Answer {
  job: string
  about: string
  answer: "fail" | "cant_tell"
  note: string
  evidence?: Array<{ path: string; line: number | null }>
}

/** What the scripted reviewer read: the questions (with their facts) and the change, per run. */
interface Seen {
  questions: Array<{ job: string; question: string; earlier: unknown }>
  diff: string
}

/**
 * A fake review agent that reads the inputs the wizard wrote into its worktree (like the real one) and answers every
 * question: the first scripted answer whose job and phrase match, else "pass". It quotes the read-check.
 */
function scriptedReviewer(script: readonly Answer[], seen: Seen[]) {
  return async (input: ReviewRunInput): Promise<JobReviewResult> => {
    expect(input.schema).toBe("jobs")
    const file = JSON.parse(readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.questions), "utf8")) as { jobs: Array<{ job: string; questions: Array<{ question_id: string; question: string; earlierAnswer?: unknown }> }> }
    const nonce = readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.readCheck), "utf8").trim()
    seen.push({ questions: file.jobs.flatMap((job) => job.questions.map((question) => ({ job: job.job, question: question.question, earlier: question.earlierAnswer ?? null }))), diff: readFileSync(join(input.worktreeDir, JOBS_REVIEW_INPUTS.diff), "utf8") })
    const answers = file.jobs.flatMap((job) =>
      job.questions.map((question) => {
        const scripted = script.find((entry) => entry.job === job.job && question.question.includes(entry.about))
        return { question_id: question.question_id, answer: scripted?.answer ?? ("pass" as const), evidence: scripted?.evidence ?? [], note: scripted?.note ?? "Read the code: it does what the question asks." }
      })
    )
    return { summary: `read-check: ${nonce} Answered every question.`, answers }
  }
}

/** The jobs step's view, lent to the review: the four commerce jobs as the agent claimed them, on `at` with `edits`. */
async function storeReview(at: string, edits: ReadonlyMap<string, string>, script: readonly Answer[], options: { fixRound?: boolean; reviewer?: "codex" | null } = {}) {
  const { items, scan, registry } = await pipeline(at)
  const inventory = await scanInventory(scan)
  for (const [file, text] of edits) {
    mkdirSync(dirname(join(at, file)), { recursive: true })
    writeFileSync(join(at, file), text)
  }
  const claimed = (item: ChecklistItem): ChecklistItem => ({ ...item, state: "claimed", claim: { status: "done", note: "Done as the brief says.", at: "2026-10-08T10:00:00.000Z" } })
  let state = {
    runId: RUN_ID,
    agent: options.reviewer === null ? null : { worker: "claude_code", reviewer: options.reviewer ?? "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    jobs: items.filter((item) => item.owner === "agent").map((item) => (COMMERCE_JOBS.includes(item.id as never) ? claimed(item) : item))
  }
  const seen: Seen[] = []
  const lines: string[] = []
  const gitIn = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } })
  const ctx = {
    root: at,
    appRoot: ".",
    state: { get: () => state, update: (mutate: (draft: typeof state) => void) => { const next = structuredClone(state); mutate(next); state = next }, save: async () => undefined },
    emit: { emit: () => undefined }
  } as unknown as WizardContext
  const deps = {
    git: {
      head: async () => gitIn(at, "rev-parse", "HEAD").trim(),
      async worktreeAddDetached(sha: string) {
        const dir = join(mkdtempSync(join(tmpdir(), "tag-store-review-")), "tree")
        gitIn(at, "worktree", "add", "--detach", dir, sha)
        return { dir }
      },
      async worktreeRemove(dir: string) {
        gitIn(at, "worktree", "remove", "--force", dir)
      }
    },
    fs: {
      mkdirp: async (path: string) => void mkdirSync(path, { recursive: true }),
      writeTextAtomic: async (path: string, text: string) => writeFileSync(path, text)
    },
    registry,
    clock: { now: () => new Date("2026-10-08T10:05:00.000Z") },
    agents: { reviewJobs: scriptedReviewer(script, seen), detect: async () => ({ worker: null, reviewer: null, nested: null }) }
  } as unknown as WizardDeps
  const host: JobsReviewHost = {
    ctx,
    deps,
    noteScanner: createScanner({ literals: [], allowedIds: [] }),
    items: () => state.jobs,
    item: (id) => state.jobs.find((item) => item.id === id),
    put: (transition) => { state = { ...state, jobs: state.jobs.map((item) => (item.id === transition.item.id ? transition.item : item)) } },
    runId: () => RUN_ID,
    sub: (text) => void lines.push(text),
    editedFiles: () => [...edits.keys()],
    questionFacts: () => ({ inventory, metaInUse: true, conversionNames: NAMES, productionHosts: ["www.halden-audio.example"] })
  }
  const reset = () => {
    gitIn(at, "checkout", "--", ".")
    gitIn(at, "clean", "-fdq")
  }
  try {
    const outcome: JobsReviewOutcome = await reviewJobsBeforeSettling(host, { fixRound: options.fixRound ?? false })
    return {
      outcome,
      seen,
      lines,
      host,
      job: (id: string) => state.jobs.find((item) => item.id === id)!,
      jobs: () => state.jobs,
      /** The re-review after the agent's fix round: `fixed` replaces the files, the sent-back jobs are claimed again. */
      async reReview(fixed: ReadonlyMap<string, string>, again: readonly Answer[] = []) {
        for (const [file, text] of fixed) writeFileSync(join(at, file), text)
        if (outcome.kind !== "fix") throw new Error("no fix round to re-review")
        for (const id of outcome.itemIds) state = { ...state, jobs: state.jobs.map((item) => (item.id === id ? { ...item, state: "claimed" as const } : item)) }
        deps.agents.reviewJobs = scriptedReviewer(again, seen)
        return reviewJobsBeforeSettling(host, { fixRound: false, reReview: outcome.itemIds })
      },
      reset
    }
  } catch (error) {
    reset()
    throw error
  }
}

/** The questions the reviewer was asked about one job, in its last review. */
const asked = (seen: readonly Seen[], job: string) => seen[seen.length - 1]!.questions.filter((entry) => entry.job === job).map((entry) => entry.question)

describe("store: the wizard's own scan, plan and briefs", () => {
  it("the scan sees a Next pages-router store", async () => {
    const { scan } = await pipeline()
    expect(scan.framework).toBe("next-pages-router")
  })

  it("(a) [A] the scan's inventory names all five events, what GA4 and PostHog already get, and what Meta and Infinite are missing", async () => {
    const { scan } = await pipeline()
    const inventory = await scanInventory(scan)
    for (const row of EXPECTED.rows) {
      const got = inventory.rows.find((entry) => entry.event === row.event)
      expect(got, row.event).toBeDefined()
      for (const [tool, cell] of Object.entries(row.tools) as Array<[InventoryTool, { state: string; lane?: string }]>) {
        // Infinite records the conversions from the server; the page events reach it through the tag itself.
        if (tool === "infinite" && cell.lane === "browser") continue
        expect(got!.tools[tool]?.state, `${row.event} × ${tool}`).toBe(cell.state)
        if (tool === "meta") expect(got!.tools.meta?.lane ?? (["view_item", "add_to_cart"].includes(row.event) ? "browser" : "server"), `${row.event} × meta lane`).toBe(cell.lane)
      }
    }
  })

  it("(a) [A] the plan names all five events and, per tool, what it gets and what it is missing", async () => {
    const { plan } = await pipeline()
    const text = plan.lines.map((line) => line.text).join("\n")
    for (const name of Object.values(META_NAMES)) expect(text, name).toContain(name)
    for (const tool of ["Meta", "GA4", "PostHog", "Infinite"]) expect(text, tool).toContain(tool)
    expect(plan.decisions.conversionNames).toEqual(expect.arrayContaining(["purchase", "begin_checkout", "lead"]))
  })

  it("(b) [A, B, C] the jobs and briefs tell the agent to add Meta AddToCart and ViewContent, and to report purchase, begin_checkout and lead from the server with match data", async () => {
    const { items, brief } = await pipeline()
    const ids = items.map((item) => item.id)
    for (const event of ["purchase", "begin_checkout", "lead"]) expect(ids, event).toContain(`server_conversions:${event}`)
    // The Meta browser job: one item for the commerce steps Meta misses, carrying both from the scan's inventory.
    const metaCommerce = items.find((item) => item.id === "meta_improve:commerce_events")
    expect(metaCommerce?.inventory?.map((entry) => entry.event).sort()).toEqual(["add_to_cart", "view_item"])
    // GA4 and PostHog already get every step and the purchase: no job adds a second one, and no browser purchase job.
    expect(ids).not.toContain("conversions_to_tools:purchase")
    expect(ids.filter((id) => id.startsWith("ga4_improve:") || id.startsWith("posthog_improve:commerce"))).toEqual([])
    const block = (id: string) => brief.slice(brief.indexOf(`### Job "${id}"`), brief.indexOf("### Job", brief.indexOf(`### Job "${id}"`) + 1) >>> 0 || undefined)
    const meta = block("meta_improve:commerce_events")
    expect(meta).toContain("Adding Meta AddToCart and ViewContent with product and price")
    expect(meta).toContain('{ destinations: ["meta", "infinite"] }')
    expect(meta).toContain('Add the attribute data-infinite-conversion="add_to_cart" to the button element itself')
    // Plain sentences: the helper, its existing sends, each caller and how it leaves (live run 6).
    expect(meta).toContain('It fires through your helper `addToCart()` at src/analytics/events.ts:27. In the helper, beside its existing sends: `infiniteTrack("add_to_cart", <product>, { destinations: ["meta", "infinite"] })`.')
    expect(meta).toMatch(/Its callers: pages\/index\.tsx:\d+, pages\/products\/\[slug\]\.tsx:\d+, each routes on the client \(router\.push\("\/cart"\)\): leave it as it is\./)
    expect(meta).not.toMatch(/firesThrough|inTheHelper|alreadySentTo|Plan data/)
    // Every caller stays on the page or routes on the client: no leave-the-page table to decode.
    expect(meta).not.toContain("| How the click leaves |")
    // The server events, each through the outcome helper's own reporter, with the payer's / visitor's match data.
    const purchase = block("server_conversions:purchase")
    expect(purchase).toContain('The repo has no Stripe webhook route: create "pages/api/stripe-webhook.ts"')
    expect(purchase).toContain('the scan points at "pages/api/checkout.ts" line 67')
    // The begin_checkout job makes the checkout edit; the purchase job points at it instead of repeating it.
    expect(purchase).toContain("the begin_checkout job's edit there does that; make it once, for both jobs")
    expect(purchase).toContain("reportStripeCheckoutPurchase")
    expect(purchase).toContain("PAYER's hashed match data")
    expect(purchase).not.toContain("req.query")
    const checkout = block("server_conversions:begin_checkout")
    expect(checkout).toContain('"pages/api/checkout.ts" line 67')
    expect(checkout).toContain("reportStripeCheckoutStarted")
    expect(checkout).toContain("buyerContext")
    // P1-B: the store's own consent reader is the signal (read only), never the tag's same-tab memory.
    expect(checkout).toContain('`getConsent` is the site\'s own consent reader, exported by "src/analytics/tracking.ts" line 53: import it relative to the page and call it, never edit that file.')
    expect(checkout).not.toContain("infiniteAdMatchAllowed()")
    // Finding 1: the cart is a native form POST, so ONE wording: a hidden ad_match field, read from the parsed body.
    expect(checkout).toContain('const trackingAllowed = req.body?.ad_match === "1"')
    expect(checkout).toContain('On the page that sends this request ("pages/cart.tsx" line 68, a form that posts), add only the visitor\'s tracking signal: one hidden field inside the form: `<input type="hidden" name="ad_match" value={getConsent() === "granted" ? "1" : "0"} />`, which the route reads as `req.body?.ad_match === "1"` (as the code above does).')
    expect(checkout).not.toContain("req.query")
    const lead = block("server_conversions:lead")
    expect(lead).toContain('"pages/api/mailing-list.ts"')
    expect(lead).toContain("reportInfiniteLead")
    expect(lead).toContain("trackingAllowed: body.adMatch === true")
    expect(lead).toContain('"pages/mailing-list.tsx"')
    expect(lead).toContain('("pages/mailing-list.tsx" line 27, a JSON fetch)')
    expect(lead).toContain('`adMatch: getConsent() === "granted"` in the JSON body it sends, which the route reads as `body.adMatch === true` (as the code above does).')
    expect(lead).toContain("`body` the parsed request body (`req.body`)")
    expect(lead).toContain("fallbackId: signupId")
    // The form's own page (live run 6: the code said "/" while the text said the form's page).
    expect(lead).toContain('fallbackPath: "/mailing-list"')
    // The page fires no browser Meta Lead: no mirror recipe to weigh.
    expect(lead).not.toContain("reportInfiniteOutcomeForMirror")
    for (const text of [purchase, checkout, lead]) expect(text).toContain('from "../../lib/infinite-outcome"')
    // The shared server rules and the consent paragraph, once each, in the preamble.
    const preamble = brief.slice(0, brief.indexOf("## Jobs"))
    expect(preamble).toContain('Server jobs: import from Infinite\'s outcome helper "lib/infinite-outcome.ts"')
    expect(brief.match(/Match data rides ONLY/g)).toHaveLength(1)
    expect(brief.match(/belong to the site owner/g)).toHaveLength(1)
    // The page that sends each request may carry the visitor's tracking signal: it is in the job's files.
    const allowed = (id: string) => items.find((item) => item.id === id)?.allow.files ?? []
    expect(allowed("server_conversions:begin_checkout")).toEqual(expect.arrayContaining(["pages/api/checkout.ts", "pages/cart.tsx"]))
    expect(allowed("server_conversions:lead")).toEqual(expect.arrayContaining(["pages/api/mailing-list.ts", "pages/mailing-list.tsx"]))
    expect(items.find((item) => item.id === "server_conversions:purchase")?.allow.create).toEqual(["pages/api/stripe-webhook.ts"])
    // The correct edits stay inside the jobs' files (never the trackers file holding the consent code).
    const editable = new Set(items.flatMap((item) => [...item.allow.files, ...item.allow.create]))
    expect([...CORRECT_EDITS.keys()].filter((file) => !editable.has(file))).toEqual([])
    // Never a second GA4 / PostHog purchase: the site already sends them.
    expect(brief).not.toMatch(/infiniteTrack\("purchase"\)/)
  })

  it("(c) every seeded commerce job's own HARD checks pass on the correct edits, and none of them is a judgement", async () => {
    const { items } = await pipeline()
    const { jobStaticCheckFunctions } = await import("../checks/job-static.js")
    const inventory = await scanInventory((await pipeline()).scan)
    for (const [file, text] of CORRECT_EDITS) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text, { flag: "w" })
    }
    try {
      const functions = jobStaticCheckFunctions({ root, run: () => ({ eventInventory: inventory, metaInUse: true, conversionNames: NAMES }), readBaseFile: (_root, file) => SITE.get(file) ?? null })
      const commerceJobs = items.filter((item) => item.jobId === "server_conversions" || item.jobId === "conversions_to_tools" || item.id.endsWith(":commerce_events"))
      expect(commerceJobs.map((item) => item.id).sort()).toEqual([...COMMERCE_JOBS])
      const graded: string[] = []
      for (const item of commerceJobs) {
        for (const check of item.checks.filter((entry) => entry.tier === "S")) {
          const fn = functions[check.id as keyof typeof functions]
          if (!fn) continue
          const raw = await fn({ item, root, appRoot: ".", runId: RUN_ID }, { runId: RUN_ID, now: () => new Date("2026-10-08T10:00:00.000Z") })
          for (const result of Array.isArray(raw) ? raw : [raw]) expect(result.state, `${item.id} ${check.id}: ${result.reason ?? ""}`).toBe("pass")
          graded.push(`${item.id}:${check.id}`)
        }
      }
      expect(graded.sort()).toEqual([
        "server_conversions:begin_checkout:no_pii_in_outcome",
        "server_conversions:begin_checkout:outcome_declared",
        "server_conversions:begin_checkout:outcome_value_currency",
        "server_conversions:lead:no_pii_in_outcome",
        "server_conversions:lead:outcome_declared",
        "server_conversions:lead:outcome_value_currency",
        "server_conversions:purchase:no_pii_in_outcome",
        "server_conversions:purchase:outcome_declared",
        "server_conversions:purchase:outcome_value_currency"
      ])
      // The Meta commerce job keeps only the page-made event id rule; its promises, once-per-click and timing are review questions.
      expect(items.find((item) => item.id === "meta_improve:commerce_events")!.checks.map((check) => `${check.tier}:${check.id}`)).toEqual(["S:meta_event_id_from_helper", "PV:meta_seen_leaving"])
    } finally {
      execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "ignore" })
      execFileSync("git", ["clean", "-fdq"], { cwd: root, stdio: "ignore" })
    }
  })
})

describe("store: the review agent owns the judgements", { timeout: 60_000 }, () => {
  it("the correct edits: every question passes, each commerce job is proven by the review, and the questions carry the facts", async () => {
    const run = await storeReview(root, CORRECT_EDITS, [])
    try {
      expect(run.outcome).toEqual({ kind: "done" })
      for (const id of COMMERCE_JOBS) {
        const job = run.job(id)
        expect(job.review, id).toMatchObject({ state: "pass", reviewer: "codex", runId: RUN_ID })
        expect(job.note, id).toBe("Checked by the review agent.")
        expect(["done_in_code", "waiting_deploy", "waiting_real_event"], id).toContain(job.state)
      }
      expect(jobsReviewKeepsDraft(run.jobs(), RUN_ID)).toEqual({ keepDraft: false, reason: null })
      // The reviewer read the agent's change, not the whole repo.
      expect(run.seen[0]!.diff).toContain("pages/api/stripe-webhook.ts")
      expect(run.seen[0]!.diff).not.toContain("src/analytics/tracking.ts")
      // Finding 1's question names the site's own reader, the cart's form, its route and how the signal rides.
      const signal = asked(run.seen, "server_conversions:begin_checkout").find((text) => text.includes("tracking-allowed signal"))!
      expect(signal).toContain('`getConsent() === "granted"`')
      expect(signal).toContain("src/analytics/tracking.ts:53")
      expect(signal).toContain("pages/cart.tsx:68 (a form that posts) → pages/api/checkout.ts, carried as a hidden field in the form it posts")
      expect(signal).toContain("with the right polarity")
      // The purchase: the signed webhook, once per session; what GA4 and PostHog already get from the site.
      const purchase = asked(run.seen, "server_conversions:purchase")
      expect(purchase.find((text) => text.includes("only from the Stripe webhook route"))).toMatch(/after the webhook's signature check passes, and once per checkout session/)
      expect(purchase.find((text) => text.includes("exactly once per user action"))).toMatch(/the site already sends it to GA4 \(src\/analytics\/events\.ts:\d+\); PostHog \(src\/analytics\/events\.ts:\d+\)/)
      // The lead: a stable id and the visitor's match data.
      expect(asked(run.seen, "server_conversions:lead").join("\n")).toMatch(/fallbackId/)
      // Meta: what it is promised, from where, with what, and its timing.
      const meta = asked(run.seen, "meta_improve:commerce_events")
      expect(meta[0]).toMatch(/^Does the code now send Meta (ViewContent and AddToCart|AddToCart and ViewContent) from where the site's own events happen \(.*pages\/products\/\[slug\]\.tsx.*\), each with the product id, value and currency\?$/)
      expect(meta.some((text) => text.includes("sent after the site's own pixel can take it"))).toBe(true)
    } finally {
      run.reset()
    }
  })

  it("(d) Meta left with PageView only: the review answers no, the job goes back for ONE fix round with the reviewer's words; still no after it, it NEEDS YOUR LOOK and nothing is reverted", async () => {
    const script: Answer[] = [{ job: "meta_improve:commerce_events", about: "Does the code now send Meta", answer: "fail", note: "No code sends Meta ViewContent or AddToCart; the Buy buttons still call addToCart() only.", evidence: [{ path: "src/analytics/events.ts", line: 27 }] }]
    // The agent did every server job but left the browser Meta events out.
    const edits = new Map([...CORRECT_EDITS].filter(([file]) => file !== "src/analytics/events.ts"))
    const run = await storeReview(root, edits, script, { fixRound: true })
    try {
      expect(run.outcome.kind).toBe("fix")
      const fix = run.outcome as Extract<JobsReviewOutcome, { kind: "fix" }>
      expect(fix.itemIds).toEqual(["meta_improve:commerce_events"])
      expect(fix.feedback.join("\n")).toContain("the review agent answered no to \"Does the code now send Meta")
      expect(fix.feedback.join("\n")).toContain("No code sends Meta ViewContent or AddToCart; the Buy buttons still call addToCart() only. (src/analytics/events.ts:27)")
      expect(run.job("meta_improve:commerce_events")).toMatchObject({ state: "pending", review: { state: "fail", fixRound: true } })
      // The server jobs passed: proven by the review.
      for (const id of COMMERCE_JOBS.filter((entry) => entry !== "meta_improve:commerce_events")) expect(run.job(id).review?.state, id).toBe("pass")
      // The agent's fix round changed nothing: the re-review asks ONLY the failed question, and it still fails.
      const again = await run.reReview(new Map(), script)
      expect(again).toEqual({ kind: "done" })
      expect(run.seen[1]!.questions.map((entry) => entry.job)).toEqual(["meta_improve:commerce_events"])
      expect(run.seen[1]!.questions[0]!.question).toMatch(/^Does the code now send Meta/)
      expect(run.seen[1]!.questions[0]!.earlier).toMatchObject({ answer: "fail" })
      const job = run.job("meta_improve:commerce_events")
      expect(job.review).toMatchObject({ state: "fail", fixRound: true })
      expect(job.note).toBe("Needs your look: No code sends Meta ViewContent or AddToCart; the Buy buttons still call addToCart() only. (src/analytics/events.ts:27)")
      // Never reverted: the job is done in code with its finding, and the server edits are still in the tree.
      expect(["done_in_code", "waiting_deploy", "waiting_real_event"]).toContain(job.state)
      expect(readFileSync(join(root, "pages/api/stripe-webhook.ts"), "utf8")).toBe(CORRECT_EDITS.get("pages/api/stripe-webhook.ts"))
    } finally {
      run.reset()
    }
  })

  it("(d) a GA4 double count beside the site's own purchase: the review answers no; the agent's fix makes the re-review pass, and the job is proven by the review", async () => {
    const success = SITE.get("pages/success.tsx")!
      .replace('import Link from "next/link";\n', 'import Link from "next/link";\nimport { infiniteTrack } from "../lib/infinite-analytics";\n')
      .replace("    purchase(sessionId, lines);\n", '    purchase(sessionId, lines);\n    infiniteTrack("purchase", { transaction_id: sessionId });\n')
    const script: Answer[] = [{ job: "server_conversions:purchase", about: "exactly once per user action", answer: "fail", note: "pages/success.tsx sends GA4 and PostHog a second purchase beside the site's own purchase(); every sale counts twice.", evidence: [{ path: "pages/success.tsx", line: 28 }] }]
    const run = await storeReview(root, new Map([...CORRECT_EDITS, ["pages/success.tsx", success]]), script, { fixRound: true })
    try {
      expect(run.outcome.kind).toBe("fix")
      expect(run.job("server_conversions:purchase")).toMatchObject({ state: "pending", note: expect.stringMatching(/^The review agent found: pages\/success\.tsx sends GA4 and PostHog a second purchase/) })
      // The agent's fix round takes the second send out; the re-review passes.
      const again = await run.reReview(new Map([["pages/success.tsx", SITE.get("pages/success.tsx")!]]))
      expect(again).toEqual({ kind: "done" })
      expect(run.job("server_conversions:purchase")).toMatchObject({ review: { state: "pass", fixRound: true }, note: "Checked by the review agent." })
    } finally {
      run.reset()
    }
  })

  it("(d) a purchase reported without match data (no hard rule sees it): the review's match-data question catches it", async () => {
    const run = await storeReview(root, new Map([...CORRECT_EDITS, ["pages/api/stripe-webhook.ts", handRolledWebhook(MONEY)]]), [
      { job: "server_conversions:purchase", about: "carry the customer's match data", answer: "fail", note: "The purchase is reported with no adMatch, so Meta cannot tie it to an ad click.", evidence: [{ path: "pages/api/stripe-webhook.ts", line: 32 }] }
    ])
    try {
      expect(run.job("server_conversions:purchase")).toMatchObject({ review: { state: "fail" }, note: expect.stringMatching(/^Needs your look: The purchase is reported with no adMatch/) })
      expect(run.job("server_conversions:purchase").review!.questions.find((question) => question.id === "match_data")).toMatchObject({ answer: "fail", evidence: [{ file: "pages/api/stripe-webhook.ts", line: 32 }] })
    } finally {
      run.reset()
    }
  })

  it("(d) Finding 1: the cart that sends no signal, a route that reads the URL, or a constant: the review's signal question catches each", async () => {
    const variants = new Map<string, Map<string, string>>([
      ["silent cart", new Map([...CORRECT_EDITS, ["pages/cart.tsx", SITE.get("pages/cart.tsx")!]])],
      ["URL read", new Map([...CORRECT_EDITS, ["pages/api/checkout.ts", CORRECT_EDITS.get("pages/api/checkout.ts")!.replace('req.body?.ad_match === "1"', 'req.query.ad_match === "1"')]])],
      ["constant", new Map([...CORRECT_EDITS, ["pages/cart.tsx", CORRECT_EDITS.get("pages/cart.tsx")!.replace('value={getConsent() === "granted" ? "1" : "0"}', 'value="1"')]])]
    ])
    for (const [name, edits] of variants) {
      const run = await storeReview(root, edits, [{ job: "server_conversions:begin_checkout", about: "tracking-allowed signal", answer: "fail", note: `${name}: the checkout start reaches Meta without the visitor's signal as the route reads it.` }])
      try {
        expect(run.job("server_conversions:begin_checkout").review, name).toMatchObject({ state: "fail" })
        expect(run.job("server_conversions:begin_checkout").note, name).toBe(`Needs your look: ${name}: the checkout start reaches Meta without the visitor's signal as the route reads it.`)
      } finally {
        run.reset()
      }
    }
  })

  it("(d) a lead with no fallbackId, and the send inside the helper AND in the Buy handler: each caught by its own question", async () => {
    const lead = CORRECT_EDITS.get("pages/api/mailing-list.ts")!.replace(/^    fallbackId: .*\n/m, "")
    const index = CORRECT_EDITS.get("pages/index.tsx")!
      .replace('import { useCart } from "../src/cart/CartContext";\n', 'import { useCart } from "../src/cart/CartContext";\nimport { infiniteTrack } from "../lib/infinite-analytics";\n')
      .replace("    addToCart(product);\n", '    addToCart(product);\n    infiniteTrack("add_to_cart", { item_id: product.slug, price: product.priceCents / 100, quantity: 1, currency: "USD" }, { destinations: ["meta", "infinite"] });\n')
    expect(index).toContain('infiniteTrack("add_to_cart"')
    const run = await storeReview(root, new Map([...CORRECT_EDITS, ["pages/api/mailing-list.ts", lead], ["pages/index.tsx", index]]), [
      { job: "server_conversions:lead", about: "stays the same when the same lead is reported again", answer: "fail", note: "reportInfiniteLead has no fallbackId: until LEAD_ID_SECRET is set the lead has no stable id and sends nothing." },
      { job: "meta_improve:commerce_events", about: "exactly once per user action", answer: "fail", note: "One Buy click sends Meta AddToCart twice: inside addToCart() and again in the handler." }
    ])
    try {
      expect(run.job("server_conversions:lead").note).toMatch(/^Needs your look: reportInfiniteLead has no fallbackId/)
      expect(run.job("meta_improve:commerce_events").note).toBe("Needs your look: One Buy click sends Meta AddToCart twice: inside addToCart() and again in the handler.")
      // The other two jobs passed every question.
      expect(run.job("server_conversions:purchase").review?.state).toBe("pass")
      expect(run.job("server_conversions:begin_checkout").review?.state).toBe("pass")
    } finally {
      run.reset()
    }
  })

  it("no review agent for the run: every edit is KEPT, each job says no review checked it, and the pull request must stay a draft", async () => {
    const run = await storeReview(root, CORRECT_EDITS, [], { reviewer: null })
    try {
      for (const id of COMMERCE_JOBS) {
        expect(run.job(id).review, id).toMatchObject({ state: "not_run", reviewer: null })
        expect(run.job(id).note, id).toBe("Not checked by a review agent: no review agent was chosen for this run")
        expect(run.job(id).state, id).not.toMatch(/pending|failed|left_for_you/)
      }
      expect(jobsReviewKeepsDraft(run.jobs(), RUN_ID)).toEqual({ keepDraft: true, reason: "No review agent checked the jobs' work: no review agent was chosen for this run" })
    } finally {
      run.reset()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// P1-A: the same store where the Buy buttons leave with a FULL page load (`fixtures/store/full-load`)
// ---------------------------------------------------------------------------------------------

describe("P1-A store variant: Buy leaves with a full page load", () => {
  const FULL_SITE = tree(join(STORE, "full-load", "site"))
  const FULL_CORRECT = tree(join(STORE, "full-load", "correct"))
  /** The full-load site's own files. */
  const site = new Map([...SITE, ...FULL_SITE])
  /** The full set of correct edits on it: the store's, with the helper and the Buy handlers in their full-load shape. */
  const correct = new Map([...CORRECT_EDITS, ...FULL_CORRECT])
  let fullRoot = ""
  beforeAll(() => {
    fullRoot = mkdtempSync(join(tmpdir(), "tag-store-full-"))
    cpSync(join(STORE, "site"), fullRoot, { recursive: true })
    cpSync(join(STORE, "full-load", "site"), fullRoot, { recursive: true })
    const git = (...args: string[]) => execFileSync("git", args, { cwd: fullRoot, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: fullRoot, GIT_CONFIG_NOSYSTEM: "1" } })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.email=store@example.com", "-c", "user.name=Store", "commit", "-qm", "store")
  })
  afterAll(() => {
    if (fullRoot) rmSync(fullRoot, { recursive: true, force: true })
  })

  /** The Meta commerce job's review on the full-load store (`storeReview`), scripted with `script`. */
  const metaReview = (edits: ReadonlyMap<string, string>, script: readonly Answer[]) => storeReview(fullRoot, edits, script)

  it("the scan sees both Buy handlers leave with a full page load, and the brief asks for the returned wait and the wrapped handler", async () => {
    const { items, brief, scan } = await pipeline(fullRoot)
    const entry = toJobScan(scan).detections.eventInventory.events.find((candidate) => candidate.event === "add_to_cart")!
    expect(entry.sites.map((site) => [site.file, site.navigation, site.navigationVia])).toEqual([
      ["pages/index.tsx", "full_load", "location.assign"],
      ["pages/products/[slug].tsx", "full_load", "location.assign"]
    ])
    // Waiting before the page leaves is a review question that names both full-load callers; no static check judges it.
    expect(items.find((item) => item.id === "meta_improve:commerce_events")!.checks.map((check) => check.id)).toEqual(["meta_event_id_from_helper", "meta_seen_leaving"])
    const meta = brief.slice(brief.indexOf('### Job "meta_improve:commerce_events"'), brief.indexOf("### Job", brief.indexOf('### Job "meta_improve:commerce_events"') + 1))
    expect(meta).toContain('In the helper, as its FIRST new line: `const wait = infiniteTrackBeforeLeaving("add_to_cart", <product>, { destinations: ["meta", "infinite"] })`')
    expect(meta).toContain("then every send the helper already has, exactly as it is; then as its LAST line: `return wait`")
    expect(meta).toContain("wrap this click handler: `infiniteLeaveAfter(() => { <everything the handler did before it left>; return addToCart(…) }, () => <the handler's own navigation, exactly as written>)`")
    expect(meta).toContain('src/analytics/events.ts: `import { infiniteTrack, infiniteTrackBeforeLeaving } from "../../lib/infinite-analytics"`')
    expect(meta).toContain('pages/index.tsx: `import { infiniteLeaveAfter } from "../lib/infinite-analytics"`')
    // The decision table, with the full-page-load row these callers need.
    expect(meta).toContain("| Through your helper; the click then does a full page load |")
  })

  it("the correct full-load edits: the hard rules pass, and the timing question names both full-load callers", async () => {
    expect(commerceFindings({ files: new Map([...site, ...correct]), base: new Map<string, string | null>([...site, ...[...correct.keys()].filter((file) => !site.has(file)).map((file) => [file, null] as const)]), inventory: await scanInventory((await pipeline(fullRoot)).scan), metaInUse: true })).toEqual([])
    const run = await metaReview(correct, [])
    try {
      expect(run.job("meta_improve:commerce_events")).toMatchObject({ review: { state: "pass" }, note: "Checked by the review agent." })
      const timing = asked(run.seen, "meta_improve:commerce_events").find((text) => text.includes("really reach Meta"))!
      expect(timing).toMatch(/where the click leaves with a full page load \(pages\/index\.tsx:\d+, pages\/products\/\[slug\]\.tsx:\d+\), awaited before the page leaves/)
    } finally {
      run.reset()
    }
  })

  it("Finding 3: the wait returned as the helper's FIRST line drops the site's own GA4 and PostHog sends: the review's kept-sends question catches it", async () => {
    const events = FULL_CORRECT.get("src/analytics/events.ts")!
      .replace('  const wait = infiniteTrackBeforeLeaving("add_to_cart",', '  return infiniteTrackBeforeLeaving("add_to_cart",')
      .replace("  return wait;\n", "")
    expect(events).toMatch(/Promise<void> \{\n  return infiniteTrackBeforeLeaving[^\n]*\n  sendGa\("add_to_cart"/)
    const run = await metaReview(new Map([...correct, ["src/analytics/events.ts", events]]), [
      { job: "meta_improve:commerce_events", about: "still run all of its own lines", answer: "fail", note: "addToCart() returns before sendGa and capturePosthog, so the site's own sends never run." }
    ])
    try {
      expect(run.job("meta_improve:commerce_events").note).toBe("Needs your look: addToCart() returns before sendGa and capturePosthog, so the site's own sends never run.")
    } finally {
      run.reset()
    }
  })

  it("the client-routing shape here (no wait): the review's timing question catches that Meta's AddToCart can be cut off by the page load", async () => {
    const edits = new Map([...CORRECT_EDITS, ...[...FULL_SITE].map(([file, text]) => [file, text.replace(/<button type="button" className="btn btn-primary btn-(block|large)"/, '<button type="button" className="btn btn-primary btn-$1" data-infinite-conversion="add_to_cart"')] as const)])
    const run = await metaReview(edits, [{ job: "meta_improve:commerce_events", about: "really reach Meta", answer: "fail", note: "Buy sends AddToCart through addToCart() and then leaves with location.assign without waiting." }])
    try {
      expect(run.job("meta_improve:commerce_events").review).toMatchObject({ state: "fail" })
      expect(run.job("meta_improve:commerce_events").note).toContain("leaves with location.assign without waiting")
    } finally {
      run.reset()
    }
  })

  it("the helper's send AND infiniteTrackThenNavigate in the Buy handler: the review's once-per-click question catches the double count", async () => {
    const index = FULL_CORRECT.get("pages/index.tsx")!
      .replace('import { infiniteLeaveAfter } from "../lib/infinite-analytics";', 'import { infiniteTrackThenNavigate } from "../lib/infinite-analytics";')
      .replace(/  const buy = \(product: Product\) =>\n    infiniteLeaveAfter\([\s\S]*?\n    \);\n/, '  const buy = (product: Product) => {\n    cart.add(product.slug);\n    void addToCart(product);\n    infiniteTrackThenNavigate(null, "/cart", "add_to_cart", { item_id: product.slug, price: product.priceCents / 100, quantity: 1, currency: "USD" }, { destinations: ["meta", "infinite"] });\n  };\n')
    expect(index).toContain("infiniteTrackThenNavigate(null")
    const run = await metaReview(new Map([...correct, ["pages/index.tsx", index]]), [{ job: "meta_improve:commerce_events", about: "exactly once per user action", answer: "fail", note: "One Buy click sends Meta AddToCart twice: in addToCart() and in infiniteTrackThenNavigate." }])
    try {
      expect(run.job("meta_improve:commerce_events").note).toMatch(/^Needs your look: One Buy click sends Meta AddToCart twice/)
    } finally {
      run.reset()
    }
  })
})
