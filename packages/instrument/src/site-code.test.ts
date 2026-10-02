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
//   - The `_fbc` capture is NOT guarded (decision 15): it still writes on `x.vercel.app` while `fbq` stays
//     undefined.
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
import { strictTypeErrors, transpileToCommonJs } from "../test/site-code/typescript.js"

import { buildHostGuardExpression, type HostGuardSpec } from "./host-guard.js"
import { buildGa4BootstrapSnippet } from "./providers/ga4.js"
import {
  adoptedMetaGuardRecipe,
  ADOPTED_META_GUARD_RECIPE,
  buildMetaCaptureOnlySnippet,
  GUARD_EXPRESSION_PLACEHOLDER
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
  ["ACME.com.", true],
  ["www.acme.com", true],
  ["acme-git-main-x.vercel.app", true],
  ["acme-abc123.vercel.app", false],
  ["localhost", false],
  ["127.0.0.1", false],
  ["0.0.0.0", false],
  ["foo.local", false],
  ["x.netlify.app", false],
  ["x.pages.dev", false],
  ["staging.acme.com", true], // leaks: deny-list (unknown hosts fail open)
  ["other.example", true]
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

describe.each(["static", "vite", "next"] as const)("the %s managed bytes on the 13-host matrix", (form) => {
  it.each(MATRIX)("%s → guarded tools fire=%s", (host, fires) => {
    const page = load(form, bytes(form), "https://placeholder.test/", host)
    expect(page.vm.scriptErrors).toEqual([])
    expect(page.ga4).toBe(fires)
    expect(page.posthog).toBe(fires)
    expect(page.meta).toBe(fires)
    expect(page.vm.window.__infiniteGa4Lane !== undefined).toBe(fires)
    expect(typeof page.vm.window.fbq === "function").toBe(fires)
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
        : form === "vite"
          ? installFixture("vite-react-basic", unguarded).read("index.html")
          : decodeNextBootstrap(installFixture("next-app-router-basic", unguarded).read("lib/infinite-analytics.ts"))
    const page = load(form, source, "https://acme-abc123.vercel.app/")
    expect([page.ga4, page.posthog, page.meta]).toEqual([true, true, true])
  })

  it("decision 15: the _fbc capture still writes on a preview while fbq stays undefined", () => {
    const page = load(form, bytes(form), "https://x.vercel.app/?fbclid=AbC_123")
    expect(page.vm.window.fbq).toBeUndefined()
    const written = page.vm.cookies.values("_fbc")
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^fb\.\d\.\d+\.AbC_123$/)
    expect(page.vm.evaluate("infiniteMetaClickId()")).toBe(written[0])
  })

  it("the Infinite runtime counts ACME.com. as the verified acme.com, and nothing on staging", () => {
    const production = load(form, bytes(form), "https://acme.com/", "ACME.com.")
    expect(production.vm.window.__infiniteAnalyticsRuntime).toBe(true)
    expect(production.vm.beacons.length).toBeGreaterThan(0)
    expect(typeof production.vm.window.__infiniteConsentAllowed).toBe("function")
    const staging = load(form, bytes(form), "https://staging.acme.com/")
    expect(staging.vm.beacons).toEqual([])
    expect(staging.vm.window.__infiniteConsentAllowed).toBeUndefined()
  })

  it("on production the helpers hold a click for the managed GA4 lane", () => {
    const page = load(form, bytes(form), "https://acme.com/")
    const event = { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    page.vm.window.__event = event
    page.vm.evaluate("infiniteTrackThenNavigate(window.__event, '/signup', 'signup_clicked')")
    expect(event.defaultPrevented).toBe(true)
    expect(plain(page.vm.window.__infiniteGa4Lane)).toEqual({ id: "G-TEST123" })
  })
})

describe("the guard's IIFE in the shared Next script", () => {
  it("negative: the GA4 guard as a bare top-level return is a SyntaxError that stops every provider", () => {
    const decoded = bytes("next")
    const wrapped = buildGa4BootstrapSnippet("G-TEST123", GUARD)
    expect(decoded).toContain(wrapped)
    const bare = [`if (!(${buildHostGuardExpression(GUARD)})) return;`, buildGa4BootstrapSnippet("G-TEST123")].join("\n")
    const page = load("next", decoded.replace(wrapped, () => bare), "https://acme.com/")
    expect(page.vm.scriptErrors).toHaveLength(1)
    expect(page.vm.scriptErrors[0]!.name).toBe("SyntaxError")
    expect([page.ga4, page.posthog, page.meta, page.x]).toEqual([false, false, false, false])
    expect(page.vm.window.__infiniteAnalyticsRuntime).toBeUndefined()
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
  })

  it("refuses a malformed exempt host and a malformed sensitive path", () => {
    expect(
      planFixture("static-html-basic", { ...ARTIFACTS, hostGuard: { mode: "deny", exempt: ["acme.com/x"], deny: [] } }).blockers.join("\n")
    ).toMatch(/not a hostname/)
    expect(
      planFixture("static-html-basic", {
        ...ARTIFACTS,
        posthog: { ...ARTIFACTS.posthog!, sensitivePaths: ["login?x=1"] }
      }).blockers.join("\n")
    ).toMatch(/root-relative path/)
  })
})

describe("the plan says how conversions reach the providers", () => {
  const line = /Conversions reach GA4 and PostHog only when your own code calls the managed helpers/
  it("with the helpers: the runtime forwards nothing, the site's code calls the helpers", () => {
    expect(planFixture("static-html-basic", ARTIFACTS).assumptions.join("\n")).toMatch(line)
  })
  it("negative: without them the line is absent", () => {
    expect(planFixture("static-html-basic", { ...ARTIFACTS, conversions: undefined }).assumptions.join("\n")).not.toMatch(line)
  })
})

describe("the plain installer is unchanged when the wizard options are absent", () => {
  it("no helpers, no guard, no marker IIFE", () => {
    const html = installFixture("static-html-basic", {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" }
    }).read("index.html")
    expect(html).not.toContain("infiniteTrack")
    expect(html).not.toContain("infiniteCampaign")
    expect(html).not.toContain("if (!((function (h)")
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

  it("are no-op safe before hydration, then delegate to the globals", async () => {
    const vm = createBrowserVm({ url: "https://acme.com/" })
    vm.window.exports = {}
    // A bundler gives the module its own scope; a bare script would turn its functions into globals.
    vm.runScript(`(function (exports) {\n${transpileToCommonJs(managedModule())}\n})(window.exports);`)
    expect(vm.scriptErrors).toEqual([])
    const api = vm.window.exports as Record<string, (...args: unknown[]) => unknown>
    // Before hydration: no globals.
    expect(vm.window.infiniteTrack).toBeUndefined()
    expect(api.infiniteTrack!("x")).toBe(false)
    expect(api.infiniteIdentify!("u1")).toBe(false)
    expect(api.infiniteReset!()).toBe(false)
    await expect(api.infiniteMetaMirror!("Lead", "id-1")).resolves.toBeUndefined()
    expect(plain(api.infiniteCampaign!())).toEqual({ campaignProvenance: "none", browserContext: "unknown" })
    const event = { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    api.infiniteTrackThenNavigate!(event, "/signup", "signup_clicked")
    expect(event.defaultPrevented).toBe(false) // the browser's own navigation
    expect(vm.assigned).toEqual([])
    api.infiniteTrackThenNavigate!(null, "/signup", "signup_clicked")
    expect(vm.assigned).toEqual(["/signup"])
    // Hydrated: the useEffect installs the bootstrap, and the wrappers reach the real helpers.
    api.installInfiniteInstrumentation!()
    expect(typeof vm.window.infiniteTrack).toBe("function")
    expect(api.infiniteTrack!("signup_clicked")).toBe(true)
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

  it("names the placeholder and keeps the capture outside", () => {
    expect(ADOPTED_META_GUARD_RECIPE).toContain(GUARD_EXPRESSION_PLACEHOLDER)
    expect(ADOPTED_META_GUARD_RECIPE).toMatch(/OUTSIDE/)
    expect(adoptedMetaGuardRecipe(GUARD)).toContain(buildHostGuardExpression(GUARD))
  })

  it("silent on a preview, but the adopted page's own _fbc capture still runs there", () => {
    const vm = createBrowserVm({ url: "https://acme-abc123.vercel.app/?fbclid=Preview_Click" })
    vm.runHtml(readFileSync(FIXTURE_PATH, "utf8"))
    expect(vm.scriptErrors).toEqual([])
    expect(vm.loaded).toEqual([])
    expect(vm.window.fbq).toBeUndefined()
    expect(vm.cookies.values("_fbc")).toHaveLength(1)
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
