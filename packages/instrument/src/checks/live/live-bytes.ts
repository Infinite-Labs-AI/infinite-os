// T1 `live-bytes`: what the LIVE pages serve, read with no browser, per tool, against the ids from the
// user's Infinite connections (wizard) or from flags / `.infinite/install.json` `ids` (doctor).
//
// Ported from infinite-site @ 9f65b47 `scripts/verify-live-analytics.mjs` L108-157 (`checkPage`) and
// L193-283 (the Meta bootstrap and autoConfig checks), generalised for customer sites:
//   • every expected id is a REQUIRED parameter — no default ids (the verifier there shipped hard-coded
//     `phc_…` / `G-…` defaults, scout S5 fact 20; the 9fcbefa preview leak came from a default `phc_`);
//   • an expected Meta pixel that is ABSENT is a problem, never a SKIP (its `EXPECTED_META_PIXEL_ID` was
//     unarmed, so a vanished pixel printed SKIP and exited 0);
//   • the Next managed bootstrap is decoded out of the bundles before matching (fact 21);
//   • every probe sends `Purpose: prefetch` (probe.ts);
//   • results are the three states plus `info`; a page that could not be read is undetermined.
//
// What it does NOT do: grade beacons (that is the desktop test engine's facts + O6's grader) or claim
// anything was received ("verified" needs a receipt from this run).
import { readPosthogOption } from "../../inspect.js"
import { checkMetaAutoConfigOptOut } from "../../providers/meta-browser/autoconfig.js"
import { META_CLICK_ID_ACCESSOR } from "../../providers/meta-browser/click-id.js"
import type { CheckContext, CheckResult } from "../../wizard/contracts/jobs.js"
import type { TestExpect } from "../../wizard/contracts/test-engine.js"
import { compareApiHost } from "../posthog-hosts.js"
import { checkResult, maskIdentifier } from "../result.js"

import { readPageBytes, unitsFor, type PageBytes, type PageUnit } from "./page-bytes.js"
import type { LiveProbeDeps } from "./probe.js"
import { checkPosthogProxy } from "./proxy.js"

export const LIVE_BYTES_CHECK_IDS = {
  ga4: "ga4_loader_id",
  posthog: "posthog_live_init",
  meta: "meta_live_init",
  metaAutoConfig: "meta_autoconfig_live",
  metaUnknownPixel: "meta_unknown_pixel",
  metaClickIdCapture: "fbc_capture_live",
  infinite: "infinite_runtime_once",
  census: "byte_census"
} as const

export interface LiveBytesInput {
  urls: readonly string[]
  expect: TestExpect
  /**
   * What a tool with no expected id gets. `wizard` (default): `undetermined` with reason `not_connected`
   * (§3h.2: its id checks read undetermined). `doctor`: nothing, or `info` when the page carries it —
   * doctor only grades the tools it was asked about.
   */
  mode?: "wizard" | "doctor"
}

type Ctx = Pick<CheckContext, "runId" | "now">

const GA4_LOADER = /googletagmanager\.com\/gtag\/js\?id=([^"'&\s\\<>]+)/g
const GA4_CONFIG = /gtag\(\s*["']config["']\s*,\s*["']([^"']+)["']/g
const GA4_ANY = /googletagmanager\.com\/gtag\/js\?id=|gtag\(\s*["']config["']/
const GA4_FORBIDDEN = /\/gtm\/gtag\/js|transport_url\s*:/
const GTM_CONTAINER = /googletagmanager\.com\/gtm\.js\?id=GTM-|['"]GTM-[A-Z0-9]{4,}['"]/
const POSTHOG_INIT = /posthog\.init\s*\(\s*(["'])([^"']+)\1/g
const META_INIT = /fbq\(\s*["']init["']\s*,\s*["'](\d{6,24})["']/g
const HTML_RUNTIME = /<script\b[^>]*\bdata-infinite-runtime\s*=\s*["']managed["'][^>]*>/gi
const BUNDLE_RUNTIME = /__infiniteAnalyticsRuntime\s*=\s*(?:true|!0)/g
const MANAGED_CAPTURE = new RegExp(String.raw`window\.${META_CLICK_ID_ACCESSOR}\s*=\s*function`)

export async function checkLiveBytes(input: LiveBytesInput, deps: LiveProbeDeps, ctx: Ctx): Promise<CheckResult[]> {
  const mode = input.mode ?? "wizard"
  const results: CheckResult[] = []
  const proxied = new Map<string, string>()
  for (const url of input.urls) {
    let pageResults: CheckResult[]
    try {
      const read = await readPageBytes(url, deps)
      if (!read.ok) {
        pageResults = unreadablePage(url, read.detail, input.expect, mode, ctx)
      } else {
        pageResults = checkPage(read.page, input.expect, mode, ctx)
        // The proxy is probed once per origin, at the path the page really uses (else the expected one).
        // A direct PostHog host still gets its `posthog_proxy` line (info: not proxied, no request), so
        // the "survives ad blockers" cell always has an input.
        const apiHost = observedPosthogApiHost(read.page) ?? input.expect.posthog?.apiHost
        if (apiHost) proxied.set(new URL(read.page.finalUrl).origin, apiHost)
      }
    } catch (error) {
      pageResults = unreadablePage(url, `test error: ${error instanceof Error ? error.message : String(error)}`, input.expect, mode, ctx)
    }
    results.push(...pageResults)
  }
  for (const [origin, apiHost] of proxied) results.push(...(await checkPosthogProxy({ origin, apiHost }, deps, ctx)))
  return results
}

function unreadablePage(url: string, detail: string, expect: TestExpect, mode: "wizard" | "doctor", ctx: Ctx): CheckResult[] {
  const tools: Array<[keyof TestExpect, string]> = [
    ["ga4", LIVE_BYTES_CHECK_IDS.ga4],
    ["posthog", LIVE_BYTES_CHECK_IDS.posthog],
    ["meta", LIVE_BYTES_CHECK_IDS.meta],
    ["infinite", LIVE_BYTES_CHECK_IDS.infinite]
  ]
  const reason = `the live page could not be read (${detail}), so nothing on it was checked`
  return tools
    .filter(([tool]) => mode === "wizard" || expect[tool] !== undefined)
    .map(([, checkId]) => checkResult(checkId, "undetermined", "T1", ctx, { reason, evidence: [{ url }] }))
}

/** Every check for ONE page. Exported for tests that hand it bytes directly. */
export function checkPage(page: PageBytes, expect: TestExpect, mode: "wizard" | "doctor", ctx: Ctx): CheckResult[] {
  return [
    ...checkGa4(page, expect, mode, ctx),
    ...checkPosthog(page, expect, mode, ctx),
    ...checkMeta(page, expect, mode, ctx),
    ...checkInfinite(page, expect, mode, ctx),
    censusResult(page, expect, ctx)
  ]
}

/**
 * Why "not on the page" cannot be said: same-origin scripts that were not read (a failed fetch, past
 * the cap) may hold the init. Undefined when every script was read.
 */
function unreadScripts(page: PageBytes): string | undefined {
  return page.bundlesSkipped > 0
    ? `${page.bundlesSkipped} same-origin script(s) could not be read, so it may sit in one of them`
    : undefined
}

function at(page: PageBytes): { evidence: Array<{ url: string }> } {
  return { evidence: [{ url: page.url }] }
}

function rawBytes(page: PageBytes): string {
  return `${page.html}\n${page.bundleText}`
}

function notExpected(checkId: string, label: string, seen: boolean, mode: "wizard" | "doctor", page: PageBytes, ctx: Ctx): CheckResult[] {
  if (mode === "wizard") {
    return [checkResult(checkId, "undetermined", "T1", ctx, { reason: `not_connected: no ${label} connection, so its id was not checked`, ...at(page) })]
  }
  if (!seen) return []
  return [checkResult(checkId, "info", "T1", ctx, { reason: `${label} is on the page; no expected id was given, so its id was not checked`, ...at(page) })]
}

function matchAll(units: readonly PageUnit[], pattern: RegExp): string[] {
  return units.flatMap((unit) => [...unit.text.matchAll(pattern)].map((match) => match[match.length - 1] as string))
}

// ---- GA4 ------------------------------------------------------------------------------------

function checkGa4(page: PageBytes, expect: TestExpect, mode: "wizard" | "doctor", ctx: Ctx): CheckResult[] {
  const id = LIVE_BYTES_CHECK_IDS.ga4
  const units = unitsFor(page, GA4_ANY)
  const loaderIds = [...new Set(matchAll(units, GA4_LOADER).map(safeDecode))]
  const configIds = [...new Set(matchAll(units, GA4_CONFIG))]
  const seen = loaderIds.length > 0 || configIds.length > 0
  if (!expect.ga4 || expect.ga4.length === 0) return notExpected(id, "GA4", seen, mode, page, ctx)
  const expected = expect.ga4
  const result = (state: CheckResult["state"], reason: string) => [checkResult(id, state, "T1", ctx, { reason, ...at(page) })]

  if (units.some((unit) => GA4_FORBIDDEN.test(unit.text))) {
    return result("problem", "GA4 uses a /gtm/gtag/js loader or transport_url — a proxied GA4 that Google may drop; load gtag.js directly")
  }
  if (!seen) {
    if (expected.some((value) => rawBytes(page).includes(value))) {
      return result("undetermined", `the page's scripts mention ${expected.map(maskIdentifier).join(" / ")} but no gtag loader or config call could be read`)
    }
    if (GTM_CONTAINER.test(page.html)) {
      return result("undetermined", "via_tag_manager: GA4 may be served by the Tag Manager container, which is not read here")
    }
    const unread = unreadScripts(page)
    if (unread) return result("undetermined", `no GA4 loader or gtag('config') was read; ${unread}`)
    return result("problem", `no GA4 loader or gtag('config') on the page; expected ${expected.map(maskIdentifier).join(" or ")}`)
  }
  const matchedLoader = loaderIds.filter((value) => expected.includes(value))
  const matchedConfig = configIds.filter((value) => expected.includes(value))
  if (matchedLoader.length === 0 && matchedConfig.length === 0) {
    return result(
      "problem",
      `GA4 id on the page is ${[...new Set([...loaderIds, ...configIds])].map(maskIdentifier).join(", ")}, expected ${expected.map(maskIdentifier).join(" or ")}`
    )
  }
  if (matchedConfig.length === 0) return result("problem", `the gtag loader for ${maskIdentifier(matchedLoader[0] as string)} is there but no gtag('config') call is`)
  if (loaderIds.length === 0) return result("problem", `gtag('config', ${maskIdentifier(matchedConfig[0] as string)}) is there but the gtag.js loader is not`)
  const others = configIds.filter((value) => !expected.includes(value))
  return result(
    "pass",
    `GA4 loads with ${maskIdentifier(matchedConfig[0] as string)}${others.length > 0 ? `; the page also configures ${others.map(maskIdentifier).join(", ")}, which is not a connected stream` : ""}`
  )
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// ---- PostHog --------------------------------------------------------------------------------

/** The first PostHog init's `api_host` as served, or undefined. */
export function observedPosthogApiHost(page: PageBytes): string | undefined {
  for (const unit of unitsFor(page, POSTHOG_INIT)) {
    const match = new RegExp(POSTHOG_INIT.source).exec(unit.text)
    if (match) return readPosthogOption(unit.text.slice(match.index), "api_host")
  }
  return undefined
}

function checkPosthog(page: PageBytes, expect: TestExpect, mode: "wizard" | "doctor", ctx: Ctx): CheckResult[] {
  const id = LIVE_BYTES_CHECK_IDS.posthog
  const units = unitsFor(page, POSTHOG_INIT)
  const tokens = matchAll(units, POSTHOG_INIT)
  if (!expect.posthog) return notExpected(id, "PostHog", tokens.length > 0, mode, page, ctx)
  const expected = expect.posthog
  const result = (state: CheckResult["state"], reason: string) => [checkResult(id, state, "T1", ctx, { reason, ...at(page) })]

  if (tokens.length === 0) {
    if (rawBytes(page).includes(expected.projectKey)) {
      return result("undetermined", `the page's scripts carry ${maskIdentifier(expected.projectKey)} but no posthog.init could be read`)
    }
    const unread = unreadScripts(page)
    if (unread) return result("undetermined", `no posthog.init was read; ${unread}`)
    return result("problem", `no posthog.init on the page; expected ${maskIdentifier(expected.projectKey)}`)
  }
  const wrong = tokens.filter((token) => token !== expected.projectKey)
  if (wrong.length === tokens.length) {
    const prefix = wrong.some((token) => !token.startsWith("phc_")) ? " (not a phc_ project key)" : ""
    return result("problem", `PostHog project key is ${wrong.map(maskIdentifier).join(", ")}${prefix}, expected ${maskIdentifier(expected.projectKey)}`)
  }
  const apiHost = observedPosthogApiHost(page) ?? "https://us.i.posthog.com"
  const verdict = compareApiHost(apiHost, expected.apiHost)
  if (verdict !== null) return result("problem", verdict)
  return result("pass", `PostHog initialises with ${maskIdentifier(expected.projectKey)} via ${apiHost}`)
}

export { compareApiHost, isRelativePath, posthogRegion } from "../posthog-hosts.js"

// ---- Meta -----------------------------------------------------------------------------------

function checkMeta(page: PageBytes, expect: TestExpect, mode: "wizard" | "doctor", ctx: Ctx): CheckResult[] {
  const id = LIVE_BYTES_CHECK_IDS.meta
  const units = unitsFor(page, META_INIT)
  const seenIds = [...new Set(matchAll(units, META_INIT))]
  if (!expect.meta || expect.meta.length === 0) return notExpected(id, "Meta pixel", seenIds.length > 0, mode, page, ctx)
  const expected = expect.meta
  const out: CheckResult[] = []
  const present = expected.filter((pixelId) => seenIds.includes(pixelId))

  if (present.length === 0) {
    let state: CheckResult["state"] = "problem"
    let reason = `expected pixel ${expected.map(maskIdentifier).join(" or ")} is not initialised on this page (found: ${seenIds.map(maskIdentifier).join(", ") || "none"})`
    if (expected.some((pixelId) => rawBytes(page).includes(pixelId)) && seenIds.length === 0) {
      state = "undetermined"
      reason = `the page's scripts carry ${expected.map(maskIdentifier).join(" / ")} but no fbq('init') could be read`
    } else if (seenIds.length === 0 && GTM_CONTAINER.test(page.html)) {
      state = "undetermined"
      reason = "via_tag_manager: the pixel may be served by the Tag Manager container, which is not read here"
    } else if (unreadScripts(page)) {
      state = "undetermined"
      reason = `expected pixel ${expected.map(maskIdentifier).join(" or ")} was not read on this page; ${unreadScripts(page)}`
    }
    out.push(checkResult(id, state, "T1", ctx, { reason, ...at(page) }))
  } else {
    out.push(checkResult(id, "pass", "T1", ctx, { reason: `pixel ${present.map(maskIdentifier).join(", ")} initialises on this page`, ...at(page) }))
    for (const pixelId of present) {
      const unit = units.find((candidate) => new RegExp(String.raw`fbq\(\s*["']init["']\s*,\s*["']${pixelId}["']`).test(candidate.text))
      if (!unit) continue
      const verdict = checkMetaAutoConfigOptOut(unit.text, pixelId, unit.managed ? "managed" : "adopted")
      out.push(
        checkResult(LIVE_BYTES_CHECK_IDS.metaAutoConfig, verdict.state === "ok" ? "pass" : verdict.state, "T1", ctx, {
          reason: autoConfigReason(verdict.reason, unit.managed, pixelId),
          ...at(page)
        })
      )
      const capture = units.some((candidate) => MANAGED_CAPTURE.test(candidate.text))
      out.push(
        checkResult(
          LIVE_BYTES_CHECK_IDS.metaClickIdCapture,
          capture ? "pass" : unit.managed ? "problem" : "info",
          "T1",
          ctx,
          {
            reason: capture
              ? "the managed _fbc landing capture is on the page"
              : unit.managed
                ? "infinite-tag's pixel is live without its _fbc landing capture — re-run the install"
                : "the site's own pixel has no infinite-tag _fbc landing capture beside it (a plan line can add one)",
            ...at(page)
          }
        )
      )
    }
  }
  for (const unknown of seenIds.filter((pixelId) => !expected.includes(pixelId))) {
    out.push(
      checkResult(LIVE_BYTES_CHECK_IDS.metaUnknownPixel, "info", "T1", ctx, {
        reason: `an unknown pixel ${maskIdentifier(unknown)} also initialises on this page; it is not the connection's pixel`,
        ...at(page)
      })
    )
  }
  return out
}

function autoConfigReason(reason: string, managed: boolean, pixelId: string): string {
  const who = managed ? "infinite-tag's pixel" : "the site's own pixel"
  switch (reason) {
    case "opted_out_before_init":
      return `${who} ${maskIdentifier(pixelId)} switches Meta's automatic events off before init`
    case "opted_in":
      return `${who} ${maskIdentifier(pixelId)} opts IN to Automatic Configuration — Meta collects visitor DOM and button text`
    case "opt_out_missing":
      return `${who} ${maskIdentifier(pixelId)} has no autoConfig opt-out before init, so Meta's automatic events are on`
    case "opt_out_after_init":
      return `${who} ${maskIdentifier(pixelId)} sets autoConfig AFTER init, which Meta ignores`
    default:
      return `could not tell whether automatic events are off for ${maskIdentifier(pixelId)} (${reason})`
  }
}

// ---- Infinite -------------------------------------------------------------------------------

function infiniteRuntimeCount(page: PageBytes): number {
  const html = page.html.match(HTML_RUNTIME)?.length ?? 0
  const bundle = page.units
    .filter((unit) => unit.source === "bundle")
    .reduce((sum, unit) => sum + (unit.text.match(BUNDLE_RUNTIME)?.length ?? 0), 0)
  return html + bundle
}

function readableBytes(page: PageBytes): string {
  return [page.html, ...page.units.filter((unit) => unit.source !== "html").map((unit) => unit.text)].join("\n")
}

function checkInfinite(page: PageBytes, expect: TestExpect, mode: "wizard" | "doctor", ctx: Ctx): CheckResult[] {
  const id = LIVE_BYTES_CHECK_IDS.infinite
  const count = infiniteRuntimeCount(page)
  if (!expect.infinite) return notExpected(id, "Infinite", count > 0, mode, page, ctx)
  const expected = expect.infinite
  const result = (state: CheckResult["state"], reason: string) => [checkResult(id, state, "T1", ctx, { reason, ...at(page) })]
  if (count === 0) {
    if (rawBytes(page).includes(expected.siteSourceKey)) {
      return result("undetermined", `the page's scripts carry ${maskIdentifier(expected.siteSourceKey)} but no Infinite runtime could be read`)
    }
    const unread = unreadScripts(page)
    if (unread) return result("undetermined", `no Infinite managed runtime was read; ${unread}`)
    return result("problem", "no Infinite managed runtime on the page")
  }
  const bytes = readableBytes(page)
  const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  if (!bytes.includes(`"siteSourceKey":"${escaped(expected.siteSourceKey)}"`)) {
    return result("problem", `the Infinite runtime does not carry the expected site key ${maskIdentifier(expected.siteSourceKey)}`)
  }
  // An empty collectPath means "not compared" (doctor reads only the site key from install.json).
  if (expected.collectPath !== "" && !bytes.includes(`"collectPath":"${escaped(expected.collectPath)}"`)) {
    return result("problem", `the Infinite runtime does not collect to ${expected.collectPath}`)
  }
  return result(
    "pass",
    `the Infinite runtime carries ${maskIdentifier(expected.siteSourceKey)}${expected.collectPath ? ` and collects to ${expected.collectPath}` : ""}`
  )
}

// ---- Census (job 2's T1 `byte_census`) --------------------------------------------------------

function censusResult(page: PageBytes, expect: TestExpect, ctx: Ctx): CheckResult {
  const tally = (pattern: RegExp): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const value of matchAll(unitsFor(page, pattern), pattern)) counts.set(value, (counts.get(value) ?? 0) + 1)
    return counts
  }
  const ga4 = tally(GA4_CONFIG)
  const posthog = matchAll(unitsFor(page, POSTHOG_INIT), POSTHOG_INIT).length
  const meta = new Map<string, number>()
  for (const unit of unitsFor(page, META_INIT)) {
    for (const pixelId of new Set([...unit.text.matchAll(META_INIT)].map((match) => match[1] as string))) {
      const bootstrap = new RegExp(String.raw`fbq\(\s*["']init["']\s*,\s*["']${pixelId}["']\s*\)`, "g")
      meta.set(pixelId, (meta.get(pixelId) ?? 0) + (unit.text.match(bootstrap)?.length ?? 0))
    }
  }
  const runtimes = infiniteRuntimeCount(page)
  const duplicates = [
    ...[...ga4].filter(([, n]) => n > 1).map(([value, n]) => `gtag('config', ${maskIdentifier(value)}) ${n} times`),
    ...(posthog > 1 ? [`${posthog} PostHog initializations`] : []),
    ...[...meta].filter(([, n]) => n > 1).map(([value, n]) => `fbq('init', ${maskIdentifier(value)}) ${n} times`),
    ...(runtimes > 1 ? [`${runtimes} Infinite managed runtimes`] : [])
  ]
  const counts = `GA4 configs ${[...ga4.values()].reduce((a, b) => a + b, 0)}, PostHog inits ${posthog}, Meta inits ${[...meta.values()].reduce((a, b) => a + b, 0)}, Infinite runtimes ${runtimes}`
  const skipped = page.bundlesSkipped > 0 ? `; ${page.bundlesSkipped} script(s) not read` : ""
  if (duplicates.length > 0) {
    return checkResult(LIVE_BYTES_CHECK_IDS.census, "problem", "T1", ctx, {
      reason: `duplicate tags on one page: ${duplicates.join("; ")} — each one double-counts every page view${skipped}`,
      ...at(page)
    })
  }
  // "At most one of each" computed from nothing is not a pass: a tool whose id is in the bytes but whose
  // init could not be read (a compiled `o.Ay.init("phc_…")`), or a script that was not read, may hold a
  // second init.
  const raw = rawBytes(page)
  const unreadable = [
    ...(expect.ga4?.some((value) => raw.includes(value)) && ga4.size === 0 ? ["GA4"] : []),
    ...(expect.posthog && raw.includes(expect.posthog.projectKey) && posthog === 0 ? ["PostHog"] : []),
    ...(expect.meta?.some((value) => raw.includes(value)) && [...meta.values()].reduce((a, b) => a + b, 0) === 0 ? ["Meta"] : []),
    ...(expect.infinite && raw.includes(expect.infinite.siteSourceKey) && runtimes === 0 ? ["Infinite"] : [])
  ]
  if (unreadable.length > 0 || page.bundlesSkipped > 0) {
    const why = [
      ...(unreadable.length > 0 ? [`${unreadable.join(", ")} ${unreadable.length === 1 ? "is" : "are"} in the page's bytes but no init call could be read`] : []),
      ...(page.bundlesSkipped > 0 ? [`${page.bundlesSkipped} same-origin script(s) were not read`] : [])
    ]
    return checkResult(LIVE_BYTES_CHECK_IDS.census, "undetermined", "T1", ctx, {
      reason: `could not count every tag: ${why.join("; ")} (${counts})`,
      ...at(page)
    })
  }
  return checkResult(LIVE_BYTES_CHECK_IDS.census, "pass", "T1", ctx, {
    reason: `one of each tag at most (${counts})`,
    ...at(page)
  })
}
