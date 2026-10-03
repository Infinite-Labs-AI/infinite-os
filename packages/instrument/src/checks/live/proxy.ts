// T1 `posthog_proxy`: is the site's first-party PostHog path really serving PostHog?
//
// Ported from infinite-site @ 9f65b47 `scripts/verify-live-analytics.mjs` L320-330 (`checkPosthogProxy`):
// `<api_host>/static/array.js` must answer 200 AND be the PostHog library. A rewrite that 404s, or that
// serves the site's own HTML (a catch-all route swallowing `/ingest/*`), sends every event nowhere while
// the page looks perfectly instrumented.
//
// Incident guarded (PORT-PLAN §4): the month-long silent outage — stale deploy, injector gap, PostHog
// region flip — where nothing failed loudly; this probe is independent of the static contracts.
import type { CheckContext, CheckResult } from "../../wizard/contracts/jobs.js"
import { checkResult } from "../result.js"

import { probeFetch, type LiveProbeDeps } from "./probe.js"

export const POSTHOG_PROXY_CHECK_ID = "posthog_proxy" as const

export interface PosthogProxyInput {
  /** The site's origin, e.g. `https://acme-store.com`. */
  origin: string
  /** The `api_host` the page uses (or the connection expects). Only a root-relative path is a proxy. */
  apiHost: string
}

export async function checkPosthogProxy(
  input: PosthogProxyInput,
  deps: LiveProbeDeps,
  ctx: Pick<CheckContext, "runId" | "now">
): Promise<CheckResult[]> {
  const result = (state: CheckResult["state"], reason: string, url?: string) =>
    checkResult(POSTHOG_PROXY_CHECK_ID, state, "T1", ctx, { reason, ...(url ? { evidence: [{ url }] } : {}) })

  if (!input.apiHost.startsWith("/") || input.apiHost.startsWith("//")) {
    // A direct PostHog host is a choice, not a defect: ad blockers drop it, which the report shows as
    // "survives ad blockers: no". `info` never changes a score.
    return [result("info", `not proxied: PostHog is sent straight to ${input.apiHost}, which ad blockers drop`)]
  }
  const path = `${input.apiHost.replace(/\/+$/, "")}/static/array.js`
  let url: string
  try {
    url = new URL(path, input.origin).href
  } catch {
    return [result("undetermined", `could not build the proxy URL from ${input.origin} and ${input.apiHost}`)]
  }
  const response = await probeFetch(url, deps)
  if (!response.ok) {
    if (response.status === 0) return [result("undetermined", `the proxy could not be reached (${response.detail})`, url)]
    return [result("problem", `${path} answered ${response.detail}, so PostHog's library never loads through the proxy`, url)]
  }
  // A catch-all route answers 200 with the site's own page — which, on an instrumented site, carries the
  // PostHog snippet and so the word "posthog". An HTML answer is never the library.
  const contentType = response.headers.get("content-type") ?? ""
  if (/text\/html|application\/xhtml/i.test(contentType) || /^\s*</.test(response.text) || /<html[\s>]|<!doctype\s+html/i.test(response.text.slice(0, 2048))) {
    return [
      result(
        "problem",
        `${path} answered ${response.status} with an HTML page, not the PostHog library — a catch-all route serves it, so the proxy sends every event nowhere`,
        url
      )
    ]
  }
  if (!/posthog/i.test(response.text)) {
    return [
      result(
        "problem",
        `${path} answered ${response.status} but is not the PostHog library (${response.text.length} bytes) — the rewrite is missing or a catch-all route serves it`,
        url
      )
    ]
  }
  return [result("pass", `${path} serves the PostHog library through the site's own domain`, url)]
}
