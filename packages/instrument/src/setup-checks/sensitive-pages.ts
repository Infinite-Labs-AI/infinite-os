// Check 8 — sensitive pages still recorded (decision 17: a plan line from a detector, never automatic).
//
// PostHog session replay and click capture run on every page unless told otherwise. On login, password
// reset, checkout and order-confirmation pages that means recordings of what people type and see there.
// infinite.fast turns both off on its sensitive paths at init (infinite-site @ 9f65b47
// `.github/scripts/inject-analytics.cjs` L340-362); a customer site usually does not.
//
// The DETECTOR (`detectSensitivePages`) lists routes whose path segments match a privacy vocabulary —
// from Next app-router `page.*`, pages-router files and static `*.html` — for O7's plan line ("Turn off
// replay and click capture on 3 pages: /login, /verify, /checkout/success"). The CHECK reports `info`
// when PostHog runs and nothing turns those off; `ok` when the PostHog init already handles it.
// No PostHog → no finding (replay is PostHog's).
import { isHtmlPage } from "./click-id-capture.js"
import { codeView, sourceUnits } from "./code-view.js"
import { sensitivePagesHandledMessage, sensitivePagesMessage } from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

/** Path segments that mark a page as sensitive (login, account recovery, payment, confirmation). */
export const SENSITIVE_SEGMENT = new RegExp(
  "(?:^|[-_])(?:" +
    [
      "login", "log-in", "signin", "sign-in", "logout", "password", "forgot", "reset", "otp", "2fa", "mfa",
      "verify", "verification", "auth", "checkout", "billing", "payment", "payments", "account", "settings",
      "profile", "thank-you", "thankyou", "success", "order-confirmation", "confirm", "confirmation"
    ].join("|") +
    ")(?:$|[-_])",
  "i"
)

export interface SensitiveRoute {
  route: string
  file: string
}

/** The route a file serves, or null when it is not a page. */
export function routeOf(file: string, contents: string): string | null {
  const app = /(?:^|\/)app\/(.*?)\/?page\.(?:[jt]sx?|mdx)$/.exec(file) ?? (/(?:^|\/)app\/page\.(?:[jt]sx?|mdx)$/.test(file) ? ["", ""] : null)
  if (app) {
    const segments = (app[1] ?? "").split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
    return `/${segments.join("/")}`
  }
  const pages = /(?:^|\/)pages\/(.+)\.(?:[jt]sx?|mdx)$/.exec(file)
  if (pages) {
    const path = pages[1] as string
    if (/^(?:_app|_document|_error|404|500)$/.test(path) || path.startsWith("api/")) return null
    return `/${path.replace(/(?:^|\/)index$/, "")}`
  }
  if (isHtmlPage(file, contents)) {
    const path = file.replace(/(?:^|\/)index\.html?$/i, "").replace(/\.html?$/i, "")
    return `/${path.replace(/^(?:public|dist|out|site)\//, "")}`
  }
  return null
}

export function detectSensitivePages(files: ReadonlyMap<string, string>): SensitiveRoute[] {
  const routes: SensitiveRoute[] = []
  for (const [file, contents] of files) {
    const route = routeOf(file, contents)
    if (route === null) continue
    if (route.split("/").some((segment) => SENSITIVE_SEGMENT.test(segment))) routes.push({ route, file })
  }
  return routes.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
}

/** PostHog code that already turns replay / click capture off for some paths. */
const HANDLED = /\bSENSITIVE_PATHS\b|stopSessionRecording\s*\(|disable_session_recording\s*:\s*(?!false\b)[^,}\n]*(?:pathname|SENSITIVE|sensitive)/

const MAX_NAMED = 5

export function checkSensitivePages(input: { files: ReadonlyMap<string, string> }): SetupCheckResult {
  const findings: SetupFinding[] = []
  const posthogUnits = sourceUnits(input.files).filter((unit) => /\bposthog\.init\s*\(|<PostHogProvider\b/.test(codeView(unit.file, unit.text)))
  if (posthogUnits.length === 0) return { check: "sensitive_pages", state: "ok", findings }
  const routes = detectSensitivePages(input.files)
  if (routes.length === 0) return { check: "sensitive_pages", state: "ok", findings }
  const handled = posthogUnits.find((unit) => HANDLED.test(codeView(unit.file, unit.text)))
  if (handled) {
    findings.push({
      check: "sensitive_pages",
      code: "INF_SETUP_SENSITIVE_PAGES_HANDLED",
      state: "ok",
      confidence: "likely",
      file: handled.file,
      message: sensitivePagesHandledMessage({ file: handled.file })
    })
    return { check: "sensitive_pages", state: "ok", findings }
  }
  const named = [...new Set(routes.map((route) => route.route))]
  findings.push({
    check: "sensitive_pages",
    code: "INF_SETUP_SENSITIVE_PAGES_RECORDED",
    state: "info",
    confidence: "likely",
    file: routes[0]?.file,
    message: sensitivePagesMessage({ routes: named.slice(0, MAX_NAMED), remaining: Math.max(0, named.length - MAX_NAMED) })
  })
  return { check: "sensitive_pages", state: worstState(findings), findings }
}
