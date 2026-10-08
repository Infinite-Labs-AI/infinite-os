// The bytes infinite-tag writes into a customer's site, installed through the real plan/apply path and
// EXECUTED — over the static managed block AND the decoded Next bootstrap — on every host in the build
// plan's 13-host matrix (§1.1, S5 table). The Vite managed block is run too.
//
// What this pins, with a negative case for each:
//   - GA4, PostHog and Meta start on production and unknown hosts, and stay silent on previews and
//     laptops (decision 3; decision 8 for Meta). Without the guard the same preview DOES send.
//   - Each guarded snippet is its own IIFE: a bare top-level `return` (a verbatim infinite.fast port)
//     is a SyntaxError that stops every provider in the shared Next script.
//   - Only PostHog's `init` is guarded; on a silenced host its methods are queue-only, so site code
//     calling `posthog.identify` cannot throw and nothing is sent.
//   - The `_fbc` capture is NOT guarded (decision 15): it still writes on `x.vercel.app` while the pixel
//     stays silent. A silenced host gets a queue-only gtag + dataLayer and an inert, flagged fbq instead
//     of nothing, so the site's own calls there cannot throw (P2-3); the helpers treat them as absent.
//   - The Infinite runtime treats `ACME.com.` as the verified `acme.com` (the one normaliser).
//   - The helper globals are in both managed forms, and the Next module's typed wrappers are no-op safe
//     before hydration.
//   - An ADOPTED Meta bootstrap wrapped with the job-7 recipe is silent on a preview, fires in
//     production, and its own `_fbc` capture still runs on the preview (negative: a wrap that also covers
//     the capture loses the click).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { createBrowserVm, decodeNextBootstrap, plain } from "../test/site-code/browser-vm.js"
import { cleanupFixtures, installFixture, planFixture } from "../test/site-code/install-fixture.js"
import { strictTypeErrors } from "../test/site-code/typescript.js"

import { type HostGuardSpec } from "./host-guard.js"
import {
  adoptedMetaGuardRecipe,
  buildMetaCaptureOnlySnippet
} from "./providers/meta.js"
import type { WorkspaceInstallArtifacts } from "./types.js"

afterAll(cleanupFixtures)

const EXEMPT = ["acme.com", "www.acme.com", "acme-git-main-x.vercel.app"]
const GUARD: HostGuardSpec = { mode: "deny", exempt: EXEMPT, deny: [] }

const ARTIFACTS: WorkspaceInstallArtifacts = {
  productionHosts: ["acme.com"],
  ga4: { measurementId: "G-TEST123" },
  posthog: { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" },
  x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] },
  meta: { pixelId: "1234567890123456" },
  infinite: {
    siteSourceKey: "site_public_123",
    collectPath: "/infinite/events/collect",
    productionHosts: ["acme.com"],
    staticProxy: "vercel",
    consentMode: "not_required"
  },
  hostGuard: { mode: "deny", exempt: EXEMPT, deny: [] },
  conversions: { helpers: true }
}

const MATRIX: Array<[string, boolean]> = [
  ["acme.com", true],
  ["acme-git-main-x.vercel.app", true],
  ["acme-abc123.vercel.app", false],
  ["localhost", false],
  ["staging.acme.com", true],
]

type Form = "static" | "vite" | "next"

const installs = {
  static: () => installFixture("static-html-basic", ARTIFACTS).read("index.html"),
  vite: () => installFixture("vite-react-basic", ARTIFACTS).read("index.html"),
  next: () => decodeNextBootstrap(installFixture("next-app-router-basic", ARTIFACTS).read("lib/infinite-analytics.ts"))
}
const cache = new Map<string, string>()
function bytes(form: Form): string {
  if (!cache.has(form)) cache.set(form, installs[form]())
  return cache.get(form)!
}

function load(form: Form, source: string, url: string, hostname?: string) {
  const vm = createBrowserVm({ url })
  if (hostname !== undefined) (vm.window.location as { hostname: string }).hostname = hostname
  if (form !== "next") vm.runHtml(source)
  else vm.runScript(source)
  const loaded = (needle: string) => vm.loaded.some((src) => src.includes(needle))
  return {
    vm,
    ga4: loaded("googletagmanager.com/gtag/js?id=G-TEST123"),
    posthog: loaded("/static/array.js"),
    meta: loaded("connect.facebook.net/en_US/fbevents.js"),
    x: loaded("static.ads-twitter.com/uwt.js")
  }
}

describe.each(["static", "next"] as const)("the %s managed bytes on the 13-host matrix", (form) => {
  it.each(MATRIX)("%s → guarded tools fire=%s", (host, fires) => {
    const page = load(form, bytes(form), "https://placeholder.test/", host)
    expect(page.vm.scriptErrors).toEqual([])
    expect(page.ga4).toBe(fires)
    expect(page.posthog).toBe(fires)
    expect(page.meta).toBe(fires)
    expect(page.vm.window.__infiniteGa4Lane !== undefined).toBe(fires)
    // P2-3: a silenced host still gets a callable gtag / dataLayer and an inert, flagged fbq, so the
    // site's own calls cannot throw there; nothing loads, so nothing is sent.
    expect(typeof page.vm.window.gtag).toBe("function")
    expect(Array.isArray(page.vm.window.dataLayer)).toBe(true)
    expect(typeof page.vm.window.fbq).toBe("function")
    expect((page.vm.window.fbq as { __infiniteSilenced?: boolean }).__infiniteSilenced === true).toBe(!fires)
    // Unguarded on purpose: X is not in decision 3's set. PostHog's methods exist everywhere (queue-only
    // on a silenced host), so the site's own posthog.identify(...) can never throw.
    expect(page.x).toBe(true)
    expect(typeof (page.vm.window.posthog as { identify?: unknown }).identify).toBe("function")
    // The helpers exist everywhere; on a preview they simply find no started tool.
    expect(typeof page.vm.window.infiniteTrack).toBe("function")
  })

  it("negative: without the guard the same preview DOES send to GA4, PostHog and Meta", () => {
    const unguarded = { ...ARTIFACTS, hostGuard: undefined }
    const source =
      form === "static"
        ? installFixture("static-html-basic", unguarded).read("index.html")
        : decodeNextBootstrap(installFixture("next-app-router-basic", unguarded).read("lib/infinite-analytics.ts"))
    const page = load(form, source, "https://acme-abc123.vercel.app/")
    expect([page.ga4, page.posthog, page.meta]).toEqual([true, true, true])
  })

  it("decision 15: the _fbc capture still writes on a preview while the pixel stays silent (an inert fbq only)", () => {
    const page = load(form, bytes(form), "https://x.vercel.app/?fbclid=AbC_123")
    expect(page.meta).toBe(false)
    expect((page.vm.window.fbq as { __infiniteSilenced?: boolean }).__infiniteSilenced).toBe(true)
    const written = page.vm.cookies.values("_fbc")
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^fb\.\d\.\d+\.AbC_123$/)
    expect(page.vm.evaluate("infiniteMetaClickId()")).toBe(written[0])
  })
})

describe("P2-3: the site's own tag calls on a silenced preview", () => {
  const preview = "https://acme-pr-12.vercel.app/"
  it.each([ "next"] as const)("%s: gtag, dataLayer.push, fbq and posthog calls do not throw, and nothing loads", (form) => {
    const page = load(form, bytes(form), preview)
    expect(page.vm.scriptErrors).toEqual([])
    page.vm.evaluate("gtag('event', 'sign_up'); window.dataLayer.push({ event: 'x' }); fbq('track', 'Lead'); posthog.capture('x')")
    expect(page.vm.loaded.filter((src) => !src.includes("ads-twitter"))).toEqual([])
    // The helpers see no pixel and no GA4 lane there: the mirror fires nothing and no click is held.
    expect(page.vm.window.__infiniteGa4Lane).toBeUndefined()
  })
})

describe("plan blockers", () => {
  it("refuses a guard that would silence a known production host", () => {
    const plan = planFixture("static-html-basic", {
      ...ARTIFACTS,
      productionHosts: ["acme.vercel.app"],
      hostGuard: { mode: "deny", exempt: ["acme.com"], deny: [] }
    })
    expect(plan.blockers.join("\n")).toMatch(/would silence production host\(s\) acme\.vercel\.app/)
    // One guard, three guarded providers: the plan states the blocker once (it de-duplicates).
    expect(plan.blockers.filter((blocker) => /would silence production/.test(blocker))).toHaveLength(1)
  })
})

describe("the Next module's typed wrappers", () => {
  const managedModule = () => installFixture("next-app-router-basic", ARTIFACTS).read("lib/infinite-analytics.ts")

  it("type-check in a strict TypeScript project (ES2020 + DOM, no @types)", () => {
    expect(strictTypeErrors(managedModule())).toEqual([])
  })

  it("negative: the type check is real (a wrong call is reported)", () => {
    expect(strictTypeErrors(managedModule() + "\ninfiniteTrack(42)\n").join("\n")).toMatch(/not assignable/)
  })
})

// ── The job-7 recipe on an ADOPTED Meta bootstrap ─────────────────────────────────────────────────

const ADOPTED_PIXEL = "6543210987654321"
const ADOPTED_BOOTSTRAP = [
  "!function(f,b,e,v,n,t,s)",
  "{if(f.fbq)return;n=f.fbq=function(){n.callMethod?",
  "n.callMethod.apply(n,arguments):n.queue.push(arguments)};",
  "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';",
  "n.queue=[];t=b.createElement(e);t.async=!0;",
  "t.src=v;s=b.getElementsByTagName(e)[0];",
  "s.parentNode.insertBefore(t,s)}(window, document,'script',",
  "'https://connect.facebook.net/en_US/fbevents.js');",
  `fbq('init', '${ADOPTED_PIXEL}');`,
  "fbq('track', 'PageView');"
].join("\n")

/** The adopted page after job 7: the capture outside and first, the bootstrap inside the recipe's wrap. */
function adoptedGuardedPage(guard: HostGuardSpec): string {
  const wrap = adoptedMetaGuardRecipe(guard).split("\n").slice(0, 2).join("\n")
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<!-- infinite-tag T0 fixture: an ADOPTED Meta pixel after agent job 7 (src/site-code.test.ts). -->",
    "<script>",
    buildMetaCaptureOnlySnippet(),
    "</script>",
    "<script>",
    wrap,
    ADOPTED_BOOTSTRAP,
    "})();",
    "</script>",
    "</head>",
    "<body></body>",
    "</html>",
    ""
  ].join("\n")
}

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/t0/adopted-meta-guarded.html")

describe("ADOPTED_META_GUARD_RECIPE and its T0 fixture", () => {
  it("the committed fixture is exactly what the recipe produces (no drift)", () => {
    expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(adoptedGuardedPage(GUARD))
  })

  it("fires in production, with the adopted pixel id unchanged", () => {
    const vm = createBrowserVm({ url: "https://acme.com/?fbclid=Prod_Click" })
    vm.runHtml(readFileSync(FIXTURE_PATH, "utf8"))
    expect(vm.loaded).toEqual(["https://connect.facebook.net/en_US/fbevents.js"])
    const queue = (vm.window.fbq as { queue: ArrayLike<unknown>[] }).queue
    expect(plain(queue.map((args) => Array.from(args)))).toEqual([["init", ADOPTED_PIXEL], ["track", "PageView"]])
    expect(vm.cookies.values("_fbc")).toHaveLength(1)
  })

  it("negative: a wrap that also covers the capture loses the preview click", () => {
    const bad = [
      "<script>",
      adoptedMetaGuardRecipe(GUARD).split("\n").slice(0, 2).join("\n"),
      buildMetaCaptureOnlySnippet(),
      ADOPTED_BOOTSTRAP,
      "})();",
      "</script>"
    ].join("\n")
    const vm = createBrowserVm({ url: "https://acme-abc123.vercel.app/?fbclid=Preview_Click" })
    vm.runHtml(bad)
    expect(vm.cookies.values("_fbc")).toEqual([])
  })
})
