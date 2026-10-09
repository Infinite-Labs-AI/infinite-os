// The prove step's shop-event proof (review r3 "static checks / prove"): after the deploy, what the plan promised Meta
// and Infinite for a store, measured where the desktop test engine can measure it, and said plainly where it cannot.
//
// What the engine can do (`contracts/test-engine.ts`, the desktop's `analytics-tag/test-engine`):
//   - drive a real browser window, load up to 5 pages, and click elements by CSS selector — but ONLY in the no-send
//     modes (`rehearsal`, `dry_live` off production). The one real visit (`real_visit`) loads one page and never clicks;
//   - capture Meta's `/tr` requests per page load and per click, as the event NAME (`ev`) and its event id — never the
//     request's parameters: by contract no query string or body comes back, so `value`, `currency` and `content_ids`
//     are never observable;
//   - a `rehearsal` serves a Vercel deployment UNDER the production hostname, so the site's own trackers and the tag
//     run as on production while nothing is sent (every request is cancelled after it is recorded).
// So after the deploy this file:
//   1. loads the merge's own production deployment (its `*.vercel.app` address, from GitHub) as a rehearsal: a product
//      page, checking Meta got ViewContent there, and a click on the Buy button marked
//      `data-infinite-conversion="add_to_cart"`, checking Meta got AddToCart from it. When that address answers with
//      Vercel's login, production itself is loaded instead (no-send, no clicks), so ViewContent is still checked;
//   2. says plainly that value and currency are not measured by a browser test (the static checks read them in code);
//   3. reads Infinite's own record (the baseline read, since the merge) for the server events the plan promised
//      (purchase, begin_checkout, lead, …): a real one counts; none yet is "waiting for the first real one", never a fail.
// Nothing here claims a proof that did not run: every line is `seen`, `missing` (it ran and the event was absent), or
// `not_measured` with the reason.
import type { BaselineResponseFields } from "../contracts/report.js"
import type { TestExpect, TestResult } from "../contracts/test-engine.js"
import { TEST_LIMITS, testRequestModeErrors } from "../contracts/test-engine.js"
import type { WizardContext, WizardDeps } from "../contracts/deps.js"
import { HOST_DENY_V1, normalizeHost } from "../contracts/host-deny.js"
import type { DeploymentReader } from "../../hosts/github.js"
import { META_BROWSER_EVENTS, promisesOf, type EventInventory, type InventoryEvent } from "../../checks/commerce-inventory.js"
import { canonicalEvent, META_EVENT_NAMES } from "../../checks/commerce-static.js"
import { routePathOf } from "../../jobs/detectors/shared.js"
import { conversionSelector, PREVIEW_REFUSED, previewNeedsLogin, productionMatcher, rehearsalDeadlineMs, runDesktopTest } from "../../review/rehearse.js"
import { isTransientBridgeFailure } from "../../bridge/outcomes.js"
import { bridgeErrorCode } from "../bridge-errors.js"

export interface CommerceProofLine {
  /** What was asked: `meta:view_item`, `meta:add_to_cart`, `meta:value_currency`, `infinite:purchase`, … */
  id: string
  state: "seen" | "missing" | "not_measured"
  words: string
}

export interface CommerceProofPlan {
  /** Meta browser events the plan promised (ViewContent on product pages, AddToCart on Buy buttons). */
  browser: Array<"view_item" | "add_to_cart">
  /** Events the plan promised to reach Meta or Infinite from the site's server. */
  server: InventoryEvent[]
  /** A product page to load (a production path), or null when the code names none. */
  productPath: string | null
}

const PRODUCT_LABEL = "product_page"
const HOME_LABEL = "home"

/** A literal same-site path in code (`"/products/oak-one"`), for resolving a dynamic product route. */
const PATH_LITERAL = /(["'`])(\/[A-Za-z0-9][A-Za-z0-9/_-]*)\1/g

/**
 * The product page to load: a page route file where the site's view_item happens (from the inventory). A dynamic
 * route (`pages/products/[slug].tsx`) is resolved to the first literal link to it in the code; none → null.
 */
export function productPagePath(inventory: EventInventory, files: ReadonlyMap<string, string>, appRoot: string): string | null {
  const row = inventory.rows.find((entry) => entry.event === "view_item")
  if (!row) return null
  const candidates = [...(row.sites ?? []), ...Object.values(row.tools).flatMap((cell) => cell?.evidence ?? [])].map((entry) => entry.file)
  for (const file of new Set(candidates)) {
    const route = routePathOf(file, appRoot)
    if (route === null || route === "/") continue
    if (!route.includes("[")) return route
    const pattern = new RegExp(
      `^${route
        .split("/")
        .map((segment) => (/^\[\[?\.\.\./.test(segment) ? ".+" : /^\[.+\]$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/")}$`
    )
    for (const [, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      for (const match of text.matchAll(PATH_LITERAL)) if (pattern.test(match[2]!)) return match[2]!
    }
  }
  return null
}

/** What to prove, from the plan's promises: Meta's browser events, and the server events Meta or Infinite get. */
export function commerceProofPlan(inventory: EventInventory, files: ReadonlyMap<string, string>, appRoot: string): CommerceProofPlan {
  const promises = promisesOf(inventory)
  const browser = [...new Set(promises.filter((promise) => promise.tool === "meta" && promise.lane === "browser" && META_BROWSER_EVENTS.has(promise.event)).map((promise) => promise.event))] as Array<"view_item" | "add_to_cart">
  const server = [...new Set(promises.filter((promise) => promise.lane === "server" && (promise.tool === "meta" || promise.tool === "infinite")).map((promise) => promise.event))]
  return { browser, server, productPath: browser.includes("view_item") ? productPagePath(inventory, files, appRoot) : null }
}

/** Meta loaded on a page load at all (any `/tr` or config request recorded for it). */
function metaLoaded(result: TestResult, label: string | null): boolean {
  return result.meta.tr.some((tr) => label === null || tr.loadLabel === label) || (label === null && result.meta.configRequests.length > 0)
}

const NOT_LOADED = "Meta's pixel did not run in the test browser there (a site that waits for its cookie banner never starts it in a test), so this could not be measured"

/**
 * Grades the rehearsal of the deployed code for Meta's browser events. `result` null = the load did not run (`why`).
 * `noClick`: why the load clicked nothing on purpose (P0-2: production itself is loaded, where the test never clicks).
 */
export function gradeCommerceBrowser(plan: CommerceProofPlan, result: TestResult | null, why: string | null, noClick: string | null = null): CommerceProofLine[] {
  const lines: CommerceProofLine[] = []
  for (const event of plan.browser) {
    const id = `meta:${event}`
    const name = META_EVENT_NAMES[event]
    if (result === null) {
      lines.push({ id, state: "not_measured", words: `Meta ${name}: not measured (${why ?? "the test browser did not run"}).` })
      continue
    }
    if (event === "view_item") {
      if (plan.productPath === null) {
        lines.push({ id, state: "not_measured", words: `Meta ${name}: not measured (no product page address was found in the code to load).` })
      } else if (result.meta.tr.some((tr) => tr.ev === name && tr.loadLabel === PRODUCT_LABEL)) {
        lines.push({ id, state: "seen", words: `Meta ${name}: sent on ${plan.productPath} (test browser, nothing sent for real).` })
      } else if (metaLoaded(result, PRODUCT_LABEL)) {
        lines.push({ id, state: "missing", words: `Meta ${name}: NOT sent on ${plan.productPath}; Meta's pixel ran there but got no ${name}.` })
      } else {
        lines.push({ id, state: "not_measured", words: `Meta ${name}: not measured on ${plan.productPath}. ${NOT_LOADED}.` })
      }
      continue
    }
    if (noClick !== null) {
      lines.push({ id, state: "not_measured", words: `Meta ${name}: not measured (${noClick}).` })
      continue
    }
    const click = result.clicks.find((entry) => entry.label === event)
    if (!click || !click.found) {
      const reason =
        click?.refused === "consent_banner"
          ? "the Buy button sits behind the cookie banner"
          : click?.refused === "submit_control"
            ? "the Buy button submits a form, which the test browser never clicks"
            : 'no Buy button marked data-infinite-conversion="add_to_cart" was on the pages loaded'
      lines.push({ id, state: "not_measured", words: `Meta ${name}: not measured (${reason}).` })
    } else if (click.events.meta.includes(name)) {
      lines.push({ id, state: "seen", words: `Meta ${name}: sent when the Buy button was clicked (test browser, nothing sent for real).` })
    } else if (metaLoaded(result, null)) {
      lines.push({ id, state: "missing", words: `Meta ${name}: NOT sent when the Buy button was clicked${click.events.meta.length > 0 ? ` (Meta got ${click.events.meta.join(", ")} instead)` : ""}.` })
    } else {
      lines.push({ id, state: "not_measured", words: `Meta ${name}: not measured. ${NOT_LOADED}.` })
    }
  }
  if (plan.browser.length > 0) {
    lines.push({
      id: "meta:value_currency",
      state: "not_measured",
      words: "Product, value and currency on Meta's browser events: not measured live (the test browser records which events reach Meta, never their contents); the code checks read them."
    })
  }
  return lines
}

/** Grades the server events from Infinite's own record since the merge. `baseline` null = it could not be read. */
export function gradeCommerceServer(plan: CommerceProofPlan, baseline: Pick<BaselineResponseFields, "conversions"> | null, why: string | null): CommerceProofLine[] {
  return plan.server.map((event) => {
    const id = `infinite:${event}`
    const counts = baseline?.conversions.infinite ?? null
    if (counts === null) return { id, state: "not_measured" as const, words: `${event} from your server: not measured (${why ?? "Infinite's record could not be read"}).` }
    const count = counts.filter((entry) => canonicalEvent(entry.name) === event).reduce((sum, entry) => sum + entry.count, 0)
    return count > 0
      ? { id, state: "seen" as const, words: `${event} from your server: Infinite has received ${count} since the merge.` }
      : { id, state: "not_measured" as const, words: `${event} from your server: none has reached Infinite since the merge yet; it shows after the first real one.` }
  })
}

/** A host the preview guard silences (`HOST_DENY_V1`): the merge's own `*.vercel.app` address. */
function isPreviewHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return HOST_DENY_V1.deny.exact.includes(normalized) || HOST_DENY_V1.deny.suffix.some((suffix) => normalized.length > suffix.length && normalized.endsWith(suffix))
}

/**
 * Runs the shop-event proof after the deploy. Never throws for a site or bridge problem: each becomes a
 * `not_measured` line with its reason. Returns no lines when the plan promised none of these events.
 */
export async function proveCommerce(
  ctx: WizardContext,
  deps: WizardDeps,
  input: {
    runId: string
    mergeSha: string
    productionHost: string
    expect: TestExpect
    reader: DeploymentReader | null
    inventory: EventInventory | null
    files: ReadonlyMap<string, string> | null
    /** The earliest moment a real event can come from the merged code (the merge), or null. */
    since: string | null
    /** Infinite's record since the merge, read once per prove run (shared with the passive checks); absent = read here. */
    readBaseline?: () => Promise<BaselineResponseFields>
  }
): Promise<CommerceProofLine[]> {
  if (!input.inventory) return []
  const plan = commerceProofPlan(input.inventory, input.files ?? new Map(), ctx.appRoot)
  const lines: CommerceProofLine[] = []

  if (plan.browser.length > 0) {
    let result: TestResult | null = null
    let why: string | null = null
    let deploymentUrl: string | null = null
    if (!input.reader?.productionDeploymentUrl) why = "the merge's own deployment address is only known through GitHub on Vercel"
    else {
      try {
        deploymentUrl = await input.reader.productionDeploymentUrl(input.mergeSha)
        if (deploymentUrl === null) why = "GitHub shows no deployment address for the merge"
      } catch {
        why = "the merge's own deployment address could not be read from GitHub"
      }
    }
    if (deploymentUrl !== null && !isPreviewHost(new URL(deploymentUrl).hostname)) {
      why = "the merge's deployment address is not a Vercel deployment address the test browser can load under your domain"
      deploymentUrl = null
    }
    const targets = [
      ...(plan.productPath ? [{ url: `https://${input.productionHost}${plan.productPath}`, label: PRODUCT_LABEL }] : []),
      { url: `https://${input.productionHost}/`, label: HOME_LABEL }
    ]
    let noClick: string | null = null
    // P0-2: Vercel's login answers the desktop's read of the deployment address with a 302 to vercel.com, so the
    // desktop would refuse it. Asked first, without credentials; behind a login, production itself is loaded instead.
    let needsLogin = deploymentUrl !== null && (await previewNeedsLogin(deps.fetch, deploymentUrl))
    if (deploymentUrl !== null && !needsLogin) {
      const origin = new URL(deploymentUrl).origin
      const clicks = plan.browser.includes("add_to_cart") ? [{ selector: conversionSelector("add_to_cart"), label: "add_to_cart" }] : []
      const request = {
        mode: "rehearsal" as const,
        runId: input.runId,
        productionHost: input.productionHost,
        targets,
        rehearsal: { previewOrigin: origin, headSha: input.mergeSha },
        expect: input.expect,
        clicks,
        deadlineMs: rehearsalDeadlineMs(clicks.length, false, deps.bridge.has("tag.test.ga4-batch.v1"))
      }
      const errors = testRequestModeErrors({ protocolVersion: 1, requestId: "check", ...request }, productionMatcher(input.productionHost))
      if (errors.length > 0) why = `the test could not be asked for (${errors[0]})`
      else {
        ctx.emit.emit("step.sub", { step: "prove", text: `Checking Meta's shop events on the deployed code (${plan.browser.map((event) => META_EVENT_NAMES[event]).join(", ")}; nothing sent)…`, tone: "pending" })
        const loaded = await runDesktopTest(ctx, deps, "prove", request)
        result = loaded.result
        if (!result) why = loaded.error === PREVIEW_REFUSED ? "the Infinite app could not tie the deployment address to this site" : `the test browser did not finish (${loaded.error ?? "no result"})`
        else if (result.environment.previewProtected) {
          result = null
          needsLogin = true
        }
      }
    }
    if (needsLogin) {
      ctx.emit.emit("step.sub", { step: "prove", text: `The merge's own deployment address needs a Vercel login, so Meta's shop events are checked on ${input.productionHost} itself (nothing sent)…`, tone: "pending" })
      const request = { mode: "dry_live" as const, runId: input.runId, productionHost: input.productionHost, targets, expect: input.expect, deadlineMs: TEST_LIMITS.deadlineMs.dry_live }
      const errors = testRequestModeErrors({ protocolVersion: 1, requestId: "check", ...request }, productionMatcher(input.productionHost))
      if (errors.length > 0) why = `the test could not be asked for (${errors[0]})`
      else {
        const loaded = await runDesktopTest(ctx, deps, "prove", request)
        result = loaded.result
        why = result ? null : `the test browser did not finish on ${input.productionHost} (${loaded.error ?? "no result"})`
        noClick = "the deployment address needs a Vercel login, and the test browser never clicks on your live site"
      }
    }
    lines.push(...gradeCommerceBrowser(plan, result, why, result ? noClick : null))
  }

  if (plan.server.length > 0) {
    let baseline: BaselineResponseFields | null = null
    let why: string | null = null
    if (input.since === null) why = "the merge time is not known"
    else if (!deps.bridge.has("tag.baseline.v1")) why = "this Infinite app cannot read it yet"
    else {
      try {
        baseline = input.readBaseline ? await input.readBaseline() : await deps.bridge.baseline(input.runId, { since: input.since, signal: ctx.signal })
      } catch (error) {
        if (!isTransientBridgeFailure(error) && bridgeErrorCode(error) === null) throw error
        why = "Infinite's record could not be read right now"
      }
    }
    lines.push(...gradeCommerceServer(plan, baseline, why))
  }
  return lines
}
