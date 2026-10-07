// D17 sensitive-pages detector (lane O9): a plan line from a detector, never an automatic edit.
import { describe, expect, it } from "vitest"

import { checkSensitivePages, detectSensitivePages, routeOf } from "./sensitive-pages.js"

const files = (record: Record<string, string>) => new Map(Object.entries(record))
const PAGE = "<html><head></head><body>x</body></html>"
const POSTHOG = "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })"

describe("sensitive pages", () => {
  it("maps files to routes (app router groups dropped, pages router, static html)", () => {
    expect(routeOf("src/app/(auth)/login/page.tsx", "")).toBe("/login")
    expect(routeOf("app/page.tsx", "")).toBe("/")
    expect(routeOf("pages/checkout/success.tsx", "")).toBe("/checkout/success")
    expect(routeOf("pages/_app.tsx", "")).toBeNull()
    expect(routeOf("pages/api/login.ts", "")).toBeNull()
    expect(routeOf("account/reset-password.html", PAGE)).toBe("/account/reset-password")
    expect(routeOf("components/login-form.tsx", "")).toBeNull()
  })

  it("lists only sensitive routes", () => {
    const routes = detectSensitivePages(
      files({ "app/login/page.tsx": "", "app/pricing/page.tsx": "", "app/checkout/success/page.tsx": "", "app/forgot-password/page.tsx": "" })
    )
    expect(routes.map((route) => route.route)).toEqual(["/checkout/success", "/forgot-password", "/login"])
  })

  it("is information when PostHog records sensitive pages", () => {
    const result = checkSensitivePages({ files: files({ "app/providers.tsx": POSTHOG, "app/login/page.tsx": "" }) })
    expect(result.findings.map((finding) => [finding.code, finding.state])).toEqual([["INF_SETUP_SENSITIVE_PAGES_RECORDED", "info"]])
    expect(result.findings[0]!.message).toContain("/login")
  })

  it("says nothing without PostHog, or without sensitive pages (negatives)", () => {
    expect(checkSensitivePages({ files: files({ "app/login/page.tsx": "" }) }).findings).toEqual([])
    expect(checkSensitivePages({ files: files({ "app/providers.tsx": POSTHOG, "app/pricing/page.tsx": "" }) }).findings).toEqual([])
  })

  it("is ok when the init already turns recording off on sensitive paths", () => {
    const handled = "var SENSITIVE_PATHS = ['/login'];\nposthog.init('phc_abcdefghijklmnop', { disable_session_recording: SENSITIVE_PATHS.indexOf(location.pathname) !== -1 })"
    const result = checkSensitivePages({ files: files({ "app/providers.tsx": handled, "app/login/page.tsx": "" }) })
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_SENSITIVE_PAGES_HANDLED"])
  })
})


it("reports globally disabled replay and click capture without claiming they are on", () => {
  const source = `posthog.init(projectKey, {
    api_host: apiHost,
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    person_profiles: 'identified_only'
  });`
  const result = checkSensitivePages({ files: files({ "src/tracking.ts": source, "app/account/page.tsx": "" }) })
  expect(result.state).toBe("ok")
  expect(result.findings[0]?.code).toBe("INF_SETUP_SENSITIVE_PAGES_HANDLED")
  expect(result.findings[0]?.message).toContain("replay and click capture off")
  expect(result.findings[0]?.message).not.toContain("are on")
})

it.each([
  "posthog.init(key, unknownOptions)",
  "posthog.init(key, { autocapture: false, disable_session_recording: false })",
  "posthog.init(key, { autocapture: true, disable_session_recording: true })"
])("does not claim both recording modes are on when their settings differ or are unknown: %s", source => {
  const result = checkSensitivePages({ files: files({ "src/tracking.ts": source, "app/account/page.tsx": "" }) })
  expect(result.state).toBe("info")
  expect(result.findings[0]?.message).not.toContain("replay and click capture are on")
})
