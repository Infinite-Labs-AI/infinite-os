// The store end-to-end (review r3: brief item 5 was never built). An invented hardware store shaped like the first
// real customer (`test/wizard/fixtures/store/site`): Next pages router, Buy buttons that add to a cart and change page,
// a Stripe Checkout API route that redirects, a success page that fires GA4 / PostHog `purchase` once per session, a
// mailing-list form and API, GA4 + PostHog + a Meta pixel that sends PageView only and is kept off /cart, /success and
// /mailing-list, and all of the trackers behind a cookie banner whose code lives in the trackers file.
//
// It runs the wizard's REAL scan, event inventory, job seeding, plan and briefs on it, then plays the agent: the
// scripted edits are the CORRECT ones (`fixtures/store/correct`, the reference store's hand-built fix ported onto
// this store), and the static checks must pass on them and fail, with the right words, on three bad variants.
//
// WHICH ASSERTIONS NEED WHICH BUILDER (the four builders' branches merge later; each test names its own):
//   [A] the event inventory (`src/scan/event-inventory.ts` exporting `buildEventInventory(snapshot: RepoSnapshot)`), the job
//       seeding of all five events and the plan's per-tool headline;
//   [B] the server lane's outcome helper for Next (`lib/infinite-outcome` with reportInfiniteOutcome / adMatchFromRequest);
//   [C] the briefs that tell the agent what to add (Meta AddToCart / ViewContent, server events with match data);
//   [D] (this builder) the static checks and the prove plan: the tests marked [D] use this file's EXPECTED inventory
//       (the plan's event × tool table for this store, written out by hand) and pass on their own.
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { fixtureHosting, fixtureKeys } from "../../test/wizard/o8/fixtures.js"
import { runCensus } from "../checks/census.js"
import type { EventInventory, InventoryEvent, InventoryTool } from "../checks/commerce-inventory.js"
import { readEventInventory } from "../checks/commerce-inventory.js"
import { commerceFindings, type CommerceFinding } from "../checks/commerce-static.js"
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

const problems = (findings: readonly CommerceFinding[]) => findings.filter((finding) => finding.state === "problem")

// ---------------------------------------------------------------------------------------------
// [D] the static checks on the store, with the plan's table written out by hand
// ---------------------------------------------------------------------------------------------

describe("[D] store: the static checks catch a run that leaves Meta without the conversions", () => {
  it("(c) the correct edits pass every commerce check: nothing missing, nothing doubled, money and match data present, no personal data", () => {
    const now = edited(CORRECT_EDITS)
    expect(commerceFindings({ files: now, base: baseFor(now), inventory: EXPECTED, metaInUse: true })).toEqual([])
  })

  it("(d) Meta PageView only (the agent changed nothing): every promised Meta event is named as missing", () => {
    const findings = problems(commerceFindings({ files: SITE, base: baseFor(SITE), inventory: EXPECTED, metaInUse: true }))
    const meta = findings.filter((finding) => finding.rule === "promise_missing" && finding.tool === "meta")
    expect(meta.map((finding) => finding.event).sort()).toEqual([...EVENTS].sort())
    const words = meta.map((finding) => finding.message).join("\n")
    expect(words).toContain("The plan promised Meta ViewContent, but no code sends it")
    expect(words).toContain("The plan promised Meta AddToCart, but no code sends it")
    for (const event of ["begin_checkout", "purchase", "lead"]) {
      expect(words).toContain(`The plan promised Meta the ${event} from the server (Meta ${META_NAMES[event]}), but no server code reports it`)
    }
  })

  it("(d) a GA4 double count (infiniteTrack(\"purchase\") on the success page beside the site's own purchase) is caught", () => {
    const success = SITE.get("pages/success.tsx")!
      .replace('import Link from "next/link";\n', 'import Link from "next/link";\nimport { infiniteTrack } from "../lib/infinite-analytics";\n')
      .replace("    purchase(sessionId, lines);\n", '    purchase(sessionId, lines);\n    infiniteTrack("purchase", { transaction_id: sessionId });\n')
    const now = edited(new Map([...CORRECT_EDITS, ["pages/success.tsx", success]]))
    const doubled = problems(commerceFindings({ files: now, base: baseFor(now), inventory: EXPECTED, metaInUse: true }))
    expect(doubled.map((finding) => `${finding.rule}:${finding.tool}:${finding.event}`)).toEqual(["double_count:ga4:purchase", "double_count:posthog:purchase"])
    expect(doubled[0]!.message).toMatch(/^pages\/success\.tsx:\d+ sends GA4 the purchase \(infiniteTrack\), but the site already sends GA4 the purchase \(src\/analytics\/events\.ts:\d+\), so every purchase would count twice in GA4\. Turn GA4 off for this call/)
  })

  it("(d) a purchase reported without match data is caught at the webhook", () => {
    // The agent hand-rolls the report instead of the recipe's reportStripeCheckoutPurchase, and leaves the match data out.
    const webhook = CORRECT_EDITS.get("pages/api/stripe-webhook.ts")!
    const recipe = '  return res.status(await reportStripeCheckoutPurchase(event, { path: "/success" })).json({ received: true })\n'
    expect(webhook).toContain(recipe)
    const handRolled = webhook
      .replace("import { reportStripeCheckoutPurchase } from", "import { reportInfiniteOutcome } from")
      .replace(recipe, [
        "  const session = event.data.object as Stripe.Checkout.Session",
        "  const status = await reportInfiniteOutcome({",
        '    type: "purchase",',
        "    eventId: session.id,",
        '    path: "/success",',
        "    properties: { value: (session.amount_total ?? 0) / 100, currency: (session.currency ?? \"usd\").toUpperCase() },",
        "  })",
        "  return res.status(status === null || status >= 500 ? 500 : 200).json({ received: true })",
        ""
      ].join("\n"))
    const now = edited(new Map([...CORRECT_EDITS, ["pages/api/stripe-webhook.ts", handRolled]]))
    const found = problems(commerceFindings({ files: now, base: baseFor(now), inventory: EXPECTED, metaInUse: true }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ rule: "outcome_without_ad_match", event: "purchase", file: "pages/api/stripe-webhook.ts" })
    expect(found[0]!.message).toMatch(/reports the purchase to Infinite without match data \(no adMatch\), so Meta cannot tie it to an ad click/)
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

async function pipeline() {
  const keys = fixtureKeys()
  const installer = createWizardInstaller({
    root,
    repoFingerprint: `sha256:${"a".repeat(64)}`,
    runId: () => RUN_ID,
    agent: () => ({ worker: "claude_code", whoPays: null }),
    consentFlag: () => null,
    productionDeniedConflict: () => []
  })
  const scan = await installer.scan({ root, hosting: fixtureHosting() })
  const before: BeforeFacts = { hosting: fixtureHosting(), keys, census: runCensus({ root, appRoot: "." }), dryLive: null, checks: [], observedProductionHost: "www.halden-audio.example" }
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
  return { scan, plan, items, brief: registry.brief(items.filter((item) => item.owner === "agent")) }
}

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

  it("(c)+(d) [A] with the scan's OWN inventory: the correct edits pass and PageView-only fails", async () => {
    const { scan } = await pipeline()
    const inventory = await scanInventory(scan)
    const now = edited(CORRECT_EDITS)
    expect(problems(commerceFindings({ files: now, base: baseFor(now), inventory, metaInUse: true }))).toEqual([])
    const untouched = problems(commerceFindings({ files: SITE, base: baseFor(SITE), inventory, metaInUse: true }))
    expect(untouched.filter((finding) => finding.tool === "meta").map((finding) => finding.event).sort()).toEqual([...EVENTS].sort())
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
    expect(meta).toContain('add the attribute data-infinite-conversion="add_to_cart" to the button element itself')
    // The server events, each through the outcome helper's own reporter, with the payer's / visitor's match data.
    const purchase = block("server_conversions:purchase")
    expect(purchase).toContain('The repo has no Stripe webhook route: create "pages/api/stripe-webhook.ts"')
    expect(purchase).toContain('the scan points at "pages/api/checkout.ts" line 67')
    expect(purchase).toContain("reportStripeCheckoutPurchase")
    expect(purchase).toContain("PAYER's hashed match data")
    const checkout = block("server_conversions:begin_checkout")
    expect(checkout).toContain('"pages/api/checkout.ts" line 67')
    expect(checkout).toContain("reportStripeCheckoutStarted")
    expect(checkout).toContain("buyerContext")
    expect(checkout).toContain("adMatch: infiniteAdMatchAllowed()")
    const lead = block("server_conversions:lead")
    expect(lead).toContain('"pages/api/mailing-list.ts"')
    expect(lead).toContain("reportInfiniteLead")
    expect(lead).toContain("trackingAllowed: body.adMatch === true")
    expect(lead).toContain('"pages/mailing-list.tsx"')
    for (const text of [purchase, checkout, lead]) expect(text).toContain('"lib/infinite-outcome.ts"')
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

  it("(c) [A] every seeded job's own static checks pass on the correct edits", async () => {
    const { items } = await pipeline()
    const { jobStaticCheckFunctions } = await import("../checks/job-static.js")
    for (const [file, text] of CORRECT_EDITS) writeFileSync(join(root, file), text, { flag: "w" })
    try {
      const inventory = await scanInventory((await pipeline()).scan)
      const functions = jobStaticCheckFunctions({ root, run: () => ({ eventInventory: inventory, metaInUse: true, conversionNames: ["purchase", "begin_checkout", "lead", "add_to_cart", "view_item"] }), readBaseFile: (_root, file) => SITE.get(file) ?? null })
      const commerceJobs = items.filter((item) => item.jobId === "server_conversions" || item.jobId === "conversions_to_tools" || item.id.endsWith(":commerce_events"))
      expect(commerceJobs.map((item) => item.id).sort()).toEqual(["meta_improve:commerce_events", "server_conversions:begin_checkout", "server_conversions:lead", "server_conversions:purchase"])
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
      // Every job's own proving check ran (and passed above).
      expect(graded).toEqual(expect.arrayContaining(["meta_improve:commerce_events:commerce_promises_met", "server_conversions:purchase:outcome_declared", "server_conversions:begin_checkout:outcome_declared", "server_conversions:lead:outcome_declared"]))
    } finally {
      execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "ignore" })
      execFileSync("git", ["clean", "-fdq"], { cwd: root, stdio: "ignore" })
    }
  })
})
