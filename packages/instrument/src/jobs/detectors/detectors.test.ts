// Every job detector against a positive and a negative in-memory fixture (lane O8). Detectors are pure
// functions of a RepoSnapshot, so these tests run the real detector code on real-looking source text.
import { describe, expect, it } from "vitest"

import type { CensusEntry, CensusResult } from "../../wizard/contracts/jobs.js"
import type { TestResult } from "../../wizard/contracts/test-engine.js"
import { detectCmp } from "../cmp.js"
import { snapshotFromFiles } from "../repo-files.js"
import { detectMetaBrowserStandardEvents, detectUnguardedAdoptedInits } from "./adopted-tags.js"
import { detectAuth } from "./auth.js"
import { detectCspOwners } from "./csp-owner.js"
import { detectDuplicates } from "./duplicates.js"
import { detectFbcWriters } from "./fbc-writers.js"
import { detectPages, detectStatic } from "./index.js"
import { detectOutcomes } from "./outcomes.js"
import { detectRedirects, middlewareMatchers } from "./redirects.js"
import { detectServerMount } from "./server-mount.js"
import { codeMatches, isNonProductPath } from "./shared.js"

const snap = (files: Record<string, string>, appRoot = ".") => snapshotFromFiles(files, { appRoot })

function census(entries: Array<Partial<CensusEntry> & Pick<CensusEntry, "tool" | "kind" | "file" | "line">>): CensusResult {
  return {
    entries: entries.map((entry) => ({ id: null, owner: "adopted", ...entry })),
    envSourcedIds: [],
    identify: { identifyCalls: [], resetCalls: [] }
  }
}

describe("shared helpers", () => {
  it("never treats tests, stories, mocks, fixtures or e2e suites as evidence", () => {
    expect(isNonProductPath("app/login/page.test.tsx")).toBe(true)
    expect(isNonProductPath("tests/auth.ts")).toBe(true)
    expect(isNonProductPath("e2e/logout.spec.ts")).toBe(true)
    expect(isNonProductPath("src/__mocks__/auth.ts")).toBe(true)
    expect(isNonProductPath("components/Button.stories.tsx")).toBe(true)
    // Negative: product code is evidence.
    expect(isNonProductPath("app/login/page.tsx")).toBe(false)
    expect(isNonProductPath("lib/testimonials.ts")).toBe(false)
  })

  it("matches calls in code, never in comments or string literals", () => {
    const text = ['// signOut() is called below', 'const doc = "call signOut() to leave"', "await signOut()"].join("\n")
    const matches = codeMatches(text, /\bsignOut\s*\(/g)
    expect(matches.map((match) => match.line)).toEqual([3])
  })
})

describe("server-mount (job 1)", () => {
  const PLAIN_MIDDLEWARE = "import { NextResponse } from 'next/server'\nexport function middleware(req) {\n  return NextResponse.next()\n}\n"
  const NARROW_MIDDLEWARE = "import { NextResponse } from 'next/server'\nexport function middleware(req) {\n  return NextResponse.next()\n}\nexport const config = { matcher: ['/dashboard/:path*'] }\n"

  it("finds an Express entry and a middleware the installer's patcher refuses (narrow matcher)", () => {
    const found = detectServerMount(snap({ "server.js": "import express from 'express'\nconst app = express()\napp.get('/', h)\napp.listen(3000)\n", "middleware.ts": NARROW_MIDDLEWARE }))
    expect(found.map((finding) => [finding.file, finding.kind, finding.runtime])).toEqual([
      ["middleware.ts", "existing_middleware", "next_middleware"],
      ["server.js", "node_server_entry", "express"]
    ])
    expect(found.find((finding) => finding.file === "server.js")?.line).toBe(2)
    expect(found.find((finding) => finding.file === "middleware.ts")?.unpatchableReason).toMatch(/matcher/)
  })

  it("never sends the agent into a middleware the installer patches itself (negative: a plain patchable middleware)", () => {
    expect(detectServerMount(snap({ "middleware.ts": PLAIN_MIDDLEWARE }))).toEqual([])
    // It is still a middleware file (job 13 may move counted paths into it).
    expect(detectStatic(snap({ "middleware.ts": PLAIN_MIDDLEWARE }), "next-app-router").middleware).toEqual(["middleware.ts"])
  })
})

describe("outcomes (job 8) and conversion elements (job 10)", () => {
  it("finds signup, lead, download, payment and booking handlers in server files", () => {
    const found = detectOutcomes(
      snap({
        "app/api/signup/route.ts": "export async function POST(req) {\n  const { data } = await supabase.auth.signUp({ email, password })\n  return Response.json(data)\n}\n",
        "app/actions/contact.ts": "'use server'\nexport async function join(form) {\n  await supabase.from('waitlist').insert({ email })\n}\n",
        "app/api/download/route.ts": "export async function GET() {\n  return new Response(file)\n}\n",
        "pages/api/stripe-webhook.ts": "export default async function handler(req, res) {\n  const event = stripe.webhooks.constructEvent(body, sig, secret)\n}\n",
        "app/api/lemon/route.ts": "// lemonsqueezy\nif (payload.meta.event_name === 'order_created') { grant() }\n",
        "app/api/cal/route.ts": "if (body.triggerEvent === 'BOOKING_CREATED') {}\n"
      })
    )
    expect(found.map((finding) => [finding.file, finding.kind, finding.conversionType])).toEqual([
      ["app/actions/contact.ts", "lead", "lead"],
      ["app/api/cal/route.ts", "booking", "booking"],
      ["app/api/download/route.ts", "download", "download"],
      ["app/api/lemon/route.ts", "payment_webhook", "purchase"],
      ["app/api/signup/route.ts", "signup", "signup"],
      ["pages/api/stripe-webhook.ts", "payment_webhook", "purchase"]
    ])
    expect(found.find((finding) => finding.kind === "signup")?.line).toBe(2)
  })

  it("recognizes Stripe async checkout success as a purchase webhook outcome", () => {
    const found = detectOutcomes(snap({
      "app/api/stripe/route.ts": "export async function POST() {\n  if (event.type === 'checkout.session.async_payment_succeeded') { fulfill() }\n}\n"
    }))
    expect(found).toEqual([expect.objectContaining({ kind: "payment_webhook", conversionType: "purchase" })])
  })

  it("does not count a browser-side signUp, a lead table named in a comment, or a handler in a test", () => {
    const found = detectOutcomes(
      snap({
        "components/signup-form.tsx": "'use client'\nawait supabase.auth.signUp({ email })\n",
        "app/api/notes/route.ts": "// later: supabase.from('leads').insert(row)\nexport async function POST() {}\n",
        "app/api/signup/route.test.ts": "await supabase.auth.signUp({ email })\n",
        "app/api/orders/route.ts": "const label = 'order_created' // no payment provider here\n"
      })
    )
    expect(found).toEqual([])
  })
})

describe("auth (job 9)", () => {
  it("finds the login success path and every logout", () => {
    const auth = detectAuth(
      snap({
        "app/login/actions.ts": "'use server'\nexport async function login(form) {\n  await supabase.auth.signInWithPassword({ email, password })\n}\n",
        "app/auth/callback/route.ts": "export async function GET(request) {\n  const code = new URL(request.url).searchParams.get('code')\n  await supabase.auth.exchangeCodeForSession(code)\n}\n",
        "components/user-menu.tsx": "onClick={() => supabase.auth.signOut()}\n",
        "app/logout/route.ts": "export async function POST() { await destroySession() }\n",
        "components/providers.tsx": "supabase.auth.onAuthStateChange((event, session) => {})\n"
      })
    )
    expect(auth.login.map((finding) => [finding.file, finding.detail])).toEqual([
      ["app/auth/callback/route.ts", "OAuth code exchange"],
      ["app/login/actions.ts", "password sign-in"]
    ])
    expect(auth.logout.map((finding) => finding.file)).toEqual(["app/logout/route.ts", "components/user-menu.tsx"])
    expect(auth.clientHooks.map((finding) => finding.file)).toEqual(["components/providers.tsx"])
  })
})

describe("csp-owner (job 12)", () => {
  it("names the owner and the style (hosts vs nonce vs strict-dynamic)", () => {
    const found = detectCspOwners(
      snap({
        "next.config.mjs": "headers: [{ key: 'Content-Security-Policy', value: \"script-src 'self' https://www.googletagmanager.com\" }]\n",
        "middleware.ts": "const csp = `script-src 'nonce-${nonce}' 'strict-dynamic'`\nres.headers.set('Content-Security-Policy', csp)\n",
        "vercel.json": JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: "default-src 'self'" }] }] })
      })
    )
    expect(found.map((finding) => [finding.file, finding.owner, finding.style])).toEqual([
      ["middleware.ts", "middleware", "strict_dynamic"],
      ["next.config.mjs", "next_config", "hosts"],
      ["vercel.json", "vercel_json", "hosts"]
    ])
  })
})

describe("redirects (job 13)", () => {
  it("parses vercel.json redirects and flags one in front of a counted path", () => {
    const snapshot = snap({
      "vercel.json": JSON.stringify({ redirects: [{ source: "/join", destination: "/signup" }, { source: "/old-blog/:slug", destination: "/blog/:slug" }] }, null, 2),
      "middleware.ts": "export const config = { matcher: ['/join', '/pricing'] }\nexport function middleware() {}\n"
    })
    expect(middlewareMatchers(snapshot)).toEqual(["/join", "/pricing"])
    const found = detectRedirects(snapshot, [])
    expect(found.map((finding) => [finding.source, finding.coversCountedPath])).toEqual([
      ["/join", true],
      ["/old-blog/:slug", false]
    ])
    expect(found[0]!.line).toBe(4)
    // A conversion route covered by a pattern source.
    expect(detectRedirects(snap({ "vercel.json": JSON.stringify({ redirects: [{ source: "/api/:path*", destination: "/v2/api/:path*" }] }) }), ["/api/signup"])[0]!.coversCountedPath).toBe(true)
  })
})

describe("fbc-writers (port row 7)", () => {
  it("finds an adopted host-only _fbc writer", () => {
    const found = detectFbcWriters(snap({ "lib/fbc.ts": "const id = new URLSearchParams(location.search).get('fbclid')\ndocument.cookie = '_fbc=fb.1.' + Date.now() + '.' + id + '; path=/'\n" }))
    expect(found.map((finding) => [finding.file, finding.line, finding.hostOnly])).toEqual([["lib/fbc.ts", 2, true]])
  })

  it("does not flag a Domain-scoped writer as host-only, nor the wizard's managed capture, nor a test", () => {
    const domainScoped = detectFbcWriters(snap({ "lib/fbc.ts": "document.cookie = `_fbc=${value}; domain=.acme.com; path=/`\n" }))
    expect(domainScoped.map((finding) => finding.hostOnly)).toEqual([false])
    expect(
      detectFbcWriters(
        snap({
          "lib/infinite-analytics.ts": "// Managed by Infinite. Public install artifacts only.\ndocument.cookie = '_fbc=' + v\n",
          "index.html": "<!-- infinite:start -->\n<script>document.cookie = '_fbc=' + v</script>\n<!-- infinite:end -->\n",
          "tests/fbc.test.ts": "document.cookie = '_fbc=x'\n"
        })
      )
    ).toEqual([])
  })
})

describe("cmp (the static banner / CMP detector)", () => {
  it("names the vendor for the grader and denies dedicated CMP files only", () => {
    const detection = detectCmp(
      snap({
        "app/layout.tsx": '<Script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js" />\n<GoogleAnalytics gaId="G-1" />\n',
        "components/cookie-banner.tsx": "export function CookieBanner() {}\n",
        "lib/onetrust.ts": "window.OneTrust.OnConsentChanged(fn)\n"
      })
    )
    expect(detection.cmp).toBe("onetrust")
    // The layout also holds GA4: only its consent lines are protected, never the whole file.
    expect(detection.files).toEqual(["components/cookie-banner.tsx", "lib/onetrust.ts"])
  })
})

describe("duplicates (job 6)", () => {
  const dry = (events: Array<{ tid: string; en: string; loadLabel: string; afterNav?: boolean }>): TestResult =>
    ({
      loads: [{ label: "home", url: "https://acme.com/", finalUrl: "https://acme.com/", status: 200, rendered: true, managedMarkerSeen: false, redirects: [] }],
      ga4: { events: events.map((event) => ({ dlHost: "acme.com", transport: "get", status: "cancelled", afterNav: false, ...event })) }
    }) as unknown as TestResult

  it("finds a repeated init, managed + adopted, and GTM + gtag firing the same id (from dry_live)", () => {
    const result = census([
      { tool: "posthog", kind: "posthog_init", id: "phc_1", file: "app/providers.tsx", line: 4 },
      { tool: "posthog", kind: "posthog_init", id: "phc_1", file: "app/analytics.tsx", line: 9 },
      { tool: "meta", kind: "fbq_init", id: "1234567890123456", file: "app/layout.tsx", line: 20, owner: "managed" },
      { tool: "meta", kind: "fbq_init", id: "1234567890123456", file: "components/pixel.tsx", line: 3 },
      { tool: "ga4", kind: "gtm", id: "GTM-ABC", file: "app/layout.tsx", line: 11 },
      { tool: "ga4", kind: "gtag_config", id: "G-ABC123", file: "app/layout.tsx", line: 14 }
    ])
    const found = detectDuplicates(result, dry([{ tid: "G-ABC123", en: "page_view", loadLabel: "home" }, { tid: "G-ABC123", en: "page_view", loadLabel: "home" }]))
    expect(found.map((finding) => [finding.kind, finding.target])).toEqual([
      ["repeated_init", "posthog_init:phc_1"],
      ["repeated_init", "meta_init:1234567890123456"],
      ["managed_and_adopted", "meta_managed_adopted"],
      ["gtm_and_gtag", "ga4_gtag"]
    ])
  })
})

describe("adopted tags (jobs 3, 5, 7)", () => {
  const files = {
    "app/layout.tsx": "export default function L() {\n  return <Script id='ga'>{`gtag('config', 'G-1')`}</Script>\n}\n",
    "app/providers.tsx": "posthog.init('phc_1', { api_host: 'https://us.i.posthog.com', capture_pageview: true })\n",
    "components/pixel.tsx": "if (window.location.hostname === 'acme.com') {\n  fbq('init', '1234567890123456')\n}\n"
  }
  const result = census([
    { tool: "ga4", kind: "gtag_config", id: "G-1", file: "app/layout.tsx", line: 2 },
    { tool: "posthog", kind: "posthog_init", id: "phc_1", file: "app/providers.tsx", line: 1 },
    { tool: "meta", kind: "fbq_init", id: "1234567890123456", file: "components/pixel.tsx", line: 2 }
  ])

  it("finds adopted inits with no host guard (and not a guarded one)", () => {
    expect(detectUnguardedAdoptedInits(snap(files), result).map((finding) => [finding.tool, finding.file])).toEqual([
      ["ga4", "app/layout.tsx"],
      ["posthog", "app/providers.tsx"]
    ])
  })

  it("a localhost-only host check is not a preview guard; a preview-suffix or production-host check is", () => {
    const ga = (guard: string) =>
      detectUnguardedAdoptedInits(snap({ "app/ga.tsx": `export function GA() {\n  ${guard}\n  gtag('config', 'G-1')\n}\n` }), census([{ tool: "ga4", kind: "gtag_config", id: "G-1", file: "app/ga.tsx", line: 3 }])).length
    expect(ga("if (window.location.hostname === 'localhost') return null")).toBe(1)
    expect(ga("if (location.host === '127.0.0.1:3000') return")).toBe(1)
    expect(ga("if (location.hostname.endsWith('.vercel.app')) return null")).toBe(0)
    expect(ga("if (window.location.hostname !== 'www.acme-store.com') return null")).toBe(0)
    expect(ga("if (process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production') return null")).toBe(0)
  })

  it("finds browser fbq standard conversions, not PageView or custom events", () => {
    expect(detectMetaBrowserStandardEvents(snap({ "components/cta.tsx": "onClick={() => fbq('track', 'Lead')}\n" })).map((finding) => finding.detail)).toEqual(["fbq track Lead"])
    expect(detectMetaBrowserStandardEvents(snap({ "app/layout.tsx": "fbq('track', 'PageView')\nfbq('trackCustom', 'Lead')\n" }))).toEqual([])
  })
})

describe("static detection pass", () => {
  it("never dry-loads a route handler or an HTML file the app does not serve", () => {
    const files = { "app/page.tsx": "", "app/feed/route.tsx": "export function GET() {}", "app/og/route.jsx": "export function GET() {}", "emails/welcome.html": "<html></html>", "public/landing.html": "<html></html>" }
    expect(detectPages(snap(files), "next-app-router")).toEqual(["/", "/landing"])
    // A static-HTML site serves its HTML files as pages.
    expect(detectPages(snap({ "index.html": "", "about/index.html": "" }), "static-html")).toEqual(["/about", "/"])
  })
})
