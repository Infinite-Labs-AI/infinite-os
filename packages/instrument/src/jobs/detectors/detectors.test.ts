// Every job detector against a positive and a negative in-memory fixture (lane O8). Detectors are pure
// functions of a RepoSnapshot, so these tests run the real detector code on real-looking source text.
import { describe, expect, it } from "vitest"

import type { CensusEntry, CensusResult } from "../../wizard/contracts/jobs.js"
import type { TestResult } from "../../wizard/contracts/test-engine.js"
import { detectCmp } from "../cmp.js"
import { snapshotFromFiles } from "../repo-files.js"
import { detectAdoptedPosthogConfig, detectMetaBrowserStandardEvents, detectUnguardedAdoptedInits } from "./adopted-tags.js"
import { detectAuth } from "./auth.js"
import { detectCspOwners } from "./csp-owner.js"
import { detectDuplicates, maxPageViewsPerLoad } from "./duplicates.js"
import { detectFbcWriters } from "./fbc-writers.js"
import { detectPages, detectStatic } from "./index.js"
import { detectLayout } from "./layout.js"
import { detectConversionElements, detectOutcomes } from "./outcomes.js"
import { detectPrivacyPages } from "./privacy-page.js"
import { detectRedirects, middlewareMatchers, pathPatternToRegExp } from "./redirects.js"
import { draftPrivacyParagraph } from "../../install/plan-model.js"
import { detectServerMount } from "./server-mount.js"
import { codeMatches, isNonProductPath, routePathOf } from "./shared.js"

const snap = (files: Record<string, string>, appRoot = ".") => snapshotFromFiles(files, { appRoot })

it("recognises the approved Infinite privacy paragraph without treating infinite scroll as disclosure", () => {
  const paragraph = draftPrivacyParagraph(["infinite"], false)!
  expect(detectPrivacyPages(snap({ "pages/privacy.tsx": `export default function Privacy() { return <p>${paragraph}</p> }` }))[0]?.names.infinite).toBe(true)
  expect(detectPrivacyPages(snap({ "pages/privacy.tsx": "export default function Privacy() { return <p>infinite scroll</p> }" }))[0]?.names.infinite).toBe(false)
})

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

  it("maps file routes to paths (route groups and src/ dropped, pages index trimmed)", () => {
    expect(routePathOf("app/(marketing)/pricing/page.tsx", ".")).toBe("/pricing")
    expect(routePathOf("src/app/api/signup/route.ts", ".")).toBe("/api/signup")
    expect(routePathOf("pages/index.tsx", ".")).toBe("/")
    expect(routePathOf("apps/web/app/page.tsx", "apps/web")).toBe("/")
    // Negatives: not a route.
    expect(routePathOf("components/header.tsx", ".")).toBeNull()
    expect(routePathOf("pages/_app.tsx", ".")).toBeNull()
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

  it("ignores a middleware that already carries the server-lane fence, and an express() in a test", () => {
    const found = detectServerMount(
      snap({
        "middleware.ts": "// infinite-tag:server-lane:start\nimport { withInfiniteServerLane } from './lib/infinite-server-lane'\n// infinite-tag:server-lane:end\nexport default withInfiniteServerLane(() => {})\n",
        "tests/server.test.js": "const app = express()\napp.listen(0)\n",
        "lib/proxy.ts": "export function proxy() {}\n"
      })
    )
    expect(found).toEqual([])
  })
})

describe("layout (job 2)", () => {
  it("finds a custom builder on an unsupported framework, and an ambiguous monorepo", () => {
    expect(detectLayout(snap({ "astro.config.mjs": "export default {}\n", "src/pages/index.astro": "<html></html>" }), "unknown").map((finding) => finding.kind)).toEqual([
      "custom_builder"
    ])
    const monorepo = snap({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
      "apps/docs/package.json": JSON.stringify({ dependencies: { vite: "5.0.0", "react-dom": "18.0.0" } })
    })
    expect(detectLayout(monorepo, "next-app-router").map((finding) => [finding.kind, finding.file])).toEqual([
      ["ambiguous_monorepo", "apps/docs/package.json"],
      ["ambiguous_monorepo", "apps/web/package.json"]
    ])
  })

  it("reports nothing for a supported framework, or a monorepo whose app root is chosen", () => {
    expect(detectLayout(snap({ "app/layout.tsx": "export default function L() {}", "webpack.config.js": "" }), "next-app-router")).toEqual([])
    const chosen = snapshotFromFiles(
      {
        "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
        "apps/web/package.json": JSON.stringify({ dependencies: { next: "15" } }),
        "apps/docs/package.json": JSON.stringify({ dependencies: { next: "15" } })
      },
      { appRoot: "apps/web" }
    )
    expect(detectLayout(chosen, "next-app-router")).toEqual([])
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

  it("finds conversion links and forms, but not unrelated links", () => {
    const found = detectConversionElements(
      snap({
        "app/page.tsx": '<a href="/signup">Start</a>\n<Link href="/pricing">Pricing</Link>\n<a href="https://cal.com/acme/demo">Book</a>\n',
        "app/contact/page.tsx": "<form onSubmit={send}>\n</form>\n"
      })
    )
    expect(found.map((finding) => [finding.file, finding.conversionType])).toEqual([
      ["app/contact/page.tsx", "lead"],
      ["app/page.tsx", "signup"],
      ["app/page.tsx", "booking"]
    ])
    expect(detectConversionElements(snap({ "app/page.tsx": '<a href="/blog">Blog</a>\n<a href="/about">About</a>\n' }))).toEqual([])
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

  it("does not treat a ?code= promo route as an OAuth return, nor a signOut in a test file", () => {
    const auth = detectAuth(
      snap({
        "app/promo/route.ts": "export async function GET(request) {\n  const code = new URL(request.url).searchParams.get('code')\n  return applyDiscount(code)\n}\n",
        "tests/logout.test.ts": "await signOut()\n",
        "e2e/auth.spec.ts": "await page.click('text=Sign out'); await signOut()\n"
      })
    )
    expect(auth).toEqual({ login: [], logout: [], clientHooks: [] })
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

  it("ignores report-only policies and repos without a CSP", () => {
    expect(detectCspOwners(snap({ "next.config.mjs": "headers: [{ key: 'Content-Security-Policy-Report-Only', value: 'x' }]\n" }))).toEqual([])
    expect(detectCspOwners(snap({ "app/layout.tsx": "export default function L() {}" }))).toEqual([])
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

  it("flags a middleware redirect that never copies the query, and not one that does", () => {
    const drops = detectRedirects(snap({ "middleware.ts": "return NextResponse.redirect(new URL('/home', request.url))\n" }), [])
    expect(drops.map((finding) => [finding.owner, finding.mayDropQuery])).toEqual([["middleware", true]])
    const keeps = detectRedirects(snap({ "middleware.ts": "const url = new URL('/home', request.url)\nurl.search = request.nextUrl.search\nreturn NextResponse.redirect(url)\n" }), [])
    expect(keeps[0]!.mayDropQuery).toBe(false)
    expect(pathPatternToRegExp("/blog/:slug*").test("/blog/a/b")).toBe(true)
    expect(pathPatternToRegExp("/blog/:slug").test("/blog/a/b")).toBe(false)
  })
})

describe("privacy-page (job 14)", () => {
  it("does not count tool names that exist only in JSX comments", () => {
    const [comment] = detectPrivacyPages(snap({ "pages/privacy.tsx": "export default function Privacy() { return <main>{/* We use Infinite (Ultima Inc.) to measure visits. */}</main> }" }))
    expect(comment?.names.infinite).toBe(false)
  })
  it("finds the privacy page and which tools it already names", () => {
    const found = detectPrivacyPages(snap({ "app/privacy/page.tsx": "<p>We use Google Analytics to count visits.</p>", "content/privacy-policy.mdx": "# Privacy\nPostHog." }))
    expect(found.map((finding) => [finding.file, finding.route, finding.names.ga4, finding.names.posthog])).toEqual([
      ["app/privacy/page.tsx", "/privacy", true, false],
      ["content/privacy-policy.mdx", null, false, true]
    ])
  })

  it("counts only tool-specific phrases as naming a tool (review P3-4)", () => {
    const [vague] = detectPrivacyPages(snap({ "app/privacy/page.tsx": "<p>Our feed uses infinite scroll. Follow us on Facebook.</p>" }))
    expect([vague!.names.infinite, vague!.names.meta]).toEqual([false, false])
    const [named] = detectPrivacyPages(snap({ "app/privacy/page.tsx": "<p>We use Infinite analytics and the Meta Pixel.</p>" }))
    expect([named!.names.infinite, named!.names.meta]).toEqual([true, true])
  })

  it("ignores a privacy-named component that is not a page", () => {
    expect(detectPrivacyPages(snap({ "components/privacy-toggle.tsx": "export function T() {}", "app/terms/page.tsx": "terms" }))).toEqual([])
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

  it("returns null with no CMP, and ignores a CMP name in a comment", () => {
    expect(detectCmp(snap({ "app/layout.tsx": "// TODO: OneTrust later\nexport default function L() {}\n" })).cmp).toBeNull()
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

  it("does not flag one snippet per HTML page, nor GTM + gtag without two page views in the dry load", () => {
    const multiPage = census([
      { tool: "ga4", kind: "gtag_config", id: "G-1", file: "index.html", line: 5 },
      { tool: "ga4", kind: "gtag_config", id: "G-1", file: "about.html", line: 5 }
    ])
    expect(detectDuplicates(multiPage, null)).toEqual([])
    const gtm = census([
      { tool: "ga4", kind: "gtm", id: "GTM-ABC", file: "app/layout.tsx", line: 11 },
      { tool: "ga4", kind: "gtag_config", id: "G-ABC123", file: "app/layout.tsx", line: 14 }
    ])
    expect(detectDuplicates(gtm, dry([{ tid: "G-ABC123", en: "page_view", loadLabel: "home" }]))).toEqual([])
    // Not decided without the before dry load (never from rehearsal data that does not exist yet).
    expect(detectDuplicates(gtm, null)).toEqual([])
    expect(maxPageViewsPerLoad(null, "G-ABC123")).toBe(0)
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

  it("a localhost-only host check is not a preview guard; a preview-suffix or production-host check is (review P2-9)", () => {
    const ga = (guard: string) =>
      detectUnguardedAdoptedInits(snap({ "app/ga.tsx": `export function GA() {\n  ${guard}\n  gtag('config', 'G-1')\n}\n` }), census([{ tool: "ga4", kind: "gtag_config", id: "G-1", file: "app/ga.tsx", line: 3 }])).length
    expect(ga("if (window.location.hostname === 'localhost') return null")).toBe(1)
    expect(ga("if (location.host === '127.0.0.1:3000') return")).toBe(1)
    expect(ga("if (location.hostname.endsWith('.vercel.app')) return null")).toBe(0)
    expect(ga("if (window.location.hostname !== 'www.acme-store.com') return null")).toBe(0)
    expect(ga("if (process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production') return null")).toBe(0)
  })

  it("does not report an init whose file it cannot read, nor a managed init", () => {
    const managed = census([{ tool: "ga4", kind: "gtag_config", id: "G-1", file: "app/layout.tsx", line: 2, owner: "managed" }])
    expect(detectUnguardedAdoptedInits(snap(files), managed)).toEqual([])
    expect(detectUnguardedAdoptedInits(snap({}), result)).toEqual([])
  })

  it("reads the adopted PostHog routing options", () => {
    const [config] = detectAdoptedPosthogConfig(snap(files), result)
    expect(config).toMatchObject({ apiHost: "https://us.i.posthog.com", sendsDirect: true, capturePageview: "true" })
    const proxied = detectAdoptedPosthogConfig(snap({ "app/providers.tsx": "posthog.init('phc_1', { api_host: '/ingest', capture_pageview: 'history_change' })\n" }), result)
    expect(proxied[0]).toMatchObject({ sendsDirect: false, capturePageview: "history_change" })
  })

  it("NEGATIVE (final round P1): an api_host from an env var is neither direct nor proxied (unknown), and seeds no proxy job on its own", () => {
    for (const options of ["api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST", "api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST"]) {
      const [config] = detectAdoptedPosthogConfig(snap({ "src/main.tsx": `posthog.init('phc_1', { ${options} })\n` }), census([{ tool: "posthog", kind: "posthog_init", id: "phc_1", file: "src/main.tsx", line: 1 }]))
      expect(config, options).toMatchObject({ sendsDirect: "unknown" })
      expect(config!.detail).toContain("cannot read where it sends")
    }
  })

  it("finds browser fbq standard conversions, not PageView or custom events", () => {
    expect(detectMetaBrowserStandardEvents(snap({ "components/cta.tsx": "onClick={() => fbq('track', 'Lead')}\n" })).map((finding) => finding.detail)).toEqual(["fbq track Lead"])
    expect(detectMetaBrowserStandardEvents(snap({ "app/layout.tsx": "fbq('track', 'PageView')\nfbq('trackCustom', 'Lead')\n" }))).toEqual([])
  })
})

describe("static detection pass", () => {
  it("is deterministic for the same snapshot", () => {
    const files = { "app/pricing/page.tsx": "<a href='/signup'>Go</a>", "app/page.tsx": "", "app/api/signup/route.ts": "await supabase.auth.signUp({})", "app/blog/[slug]/page.tsx": "" }
    expect(detectStatic(snap(files), "next-app-router")).toEqual(detectStatic(snap({ ...files }), "next-app-router"))
    expect(detectPages(snap(files))).toEqual(["/pricing", "/"])
  })

  it("never dry-loads a route handler or an HTML file the app does not serve (review P3-5)", () => {
    const files = { "app/page.tsx": "", "app/feed/route.tsx": "export function GET() {}", "app/og/route.jsx": "export function GET() {}", "emails/welcome.html": "<html></html>", "public/landing.html": "<html></html>" }
    expect(detectPages(snap(files), "next-app-router")).toEqual(["/", "/landing"])
    // A static-HTML site serves its HTML files as pages.
    expect(detectPages(snap({ "index.html": "", "about/index.html": "" }), "static-html")).toEqual(["/about", "/"])
  })
})
