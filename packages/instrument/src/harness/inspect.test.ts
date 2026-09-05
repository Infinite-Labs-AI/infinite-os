import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { detectUnmanagedProviders, inspectWorkspace } from "../inspect.js"
import { renderInfiniteBrowserTag } from "../runtime/infinite-browser.js"
import {
  buildHarnessPlan,
  classifyProviders,
  detectProvidersWithEvidence,
  normalizeDetected,
  readEnvKeys,
  resolveHarnessKeys
} from "./inspect.js"

const tempRoots: string[] = []
const here = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(here, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `harness-inspect-${name}-`))
  tempRoots.push(targetRoot)
  const target = join(targetRoot, name)
  cpSync(source, target, { recursive: true })
  return target
}

function write(root: string, relativePath: string, contents: string): void {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true })
  writeFileSync(join(root, relativePath), contents)
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

const GTAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','G-ABC123');</script>`

describe("detectProvidersWithEvidence", () => {
  it.each([
    `import { PostHogProvider } from '@posthog/nextjs'; export const noop=()=>null`,
    `import { usePostHog } from 'posthog-js/react'; const ph=usePostHog(); ph?.capture('click')`,
    `import { PostHogProvider } from 'posthog-js/react'; export const helper=()=>null`,
    `import ReactGA from 'react-ga4'; ReactGA.event('download')`,
    `<html><body>gtag('config','G-FAKE123'); fbq('init','123456')</body></html>`,
    `if (window.gtag) window.gtag('event', 'download'); fbq('track', 'Lead'); twq('event', 'abc'); posthog.capture('click')`,
    `const docs = "gtag('config', 'G-FAKE123'); fbq('init', '123456'); twq('config','abc')";`,
    `const docs = '<script src="https://www.googletagmanager.com/gtag/js?id=G-FAKE123"></script>'; const host = 'https://connect.facebook.net/en_US/fbevents.js'; const lib = 'react-ga4';`,
    `<!-- <script>gtag('config', 'G-FAKE123'); posthog.init('phc_fake'); fbq('init','123456'); twq('config','abc')</script> -->`
  ])("ignores event-only calls and documentation in both detectors: %s", (source) => {
    const root = copyFixture("static-html-basic")
    write(root, "example.html", source)
    expect(detectUnmanagedProviders(root)).toEqual([])
    expect(detectProvidersWithEvidence(root)).toEqual([])
  })

  it("ignores conventional test runners including mjs/cjs in both detectors", () => {
    const root = copyFixture("static-html-basic")
    for (const file of ["scripts/test-events.mjs", "scripts/test-pixels.cjs", "pixel.test.mjs", "pixel.spec.cjs"]) {
      write(root, file, `gtag('config','G-TEST123'); fbq('init','123456'); twq('config','abc')`)
    }
    expect(detectUnmanagedProviders(root)).toEqual([])
    expect(detectProvidersWithEvidence(root)).toEqual([])
  })

  it("recognizes a freshly rendered Infinite runtime with its public source key, but excludes installer-owned blocks", () => {
    const root = copyFixture("static-html-basic")
    const runtime = renderInfiniteBrowserTag({siteSourceKey: "site_customer123", collectPath: "/ledger", productionHosts: ["example.com"], respectDnt: true, consent: {mode: "not_required"}})
    write(root, "index.html", `<html><head>\n${runtime}\n</head></html>`)
    expect(detectUnmanagedProviders(root)).toEqual([{provider: "infinite", via: "snippet", file: "index.html"}])
    expect(detectProvidersWithEvidence(root)).toEqual([{provider: "infinite", via: "snippet", file: "index.html", line: 2, key: "site_customer123"}])
    write(root, "index.html", `<!-- infinite:start -->${runtime}<!-- infinite:end -->`)
    expect(detectUnmanagedProviders(root)).toEqual([])
    expect(detectProvidersWithEvidence(root)).toEqual([])
  })

  it.each([
    ["posthog", `import {\n PostHogProvider as PH\n} from 'posthog-js/react'; export const P=()=> <PH apiKey="phc_real"/>`],
    ["ga4", `import {\n GoogleAnalytics as GA\n} from '@next/third-parties/google'; export const P=()=> <GA gaId="G-REAL123"/>`],
  ])("recognizes multiline mounted %s imports", (provider, source) => {
    const root=copyFixture("next-app-router-basic")
    write(root,"app/providers.tsx",source)
    expect(detectProvidersWithEvidence(root).map(row=>row.provider)).toEqual([provider])
    expect(detectUnmanagedProviders(root).map(row=>row.provider)).toEqual([provider])
  })

  it("recognizes mounted aliased provider components", () => {
    const root=copyFixture("next-app-router-basic")
    write(root,"app/providers.tsx",`import { PostHogProvider as PH } from 'posthog-js/react'; export const P=()=> <PH apiKey="phc_real"/>`)
    expect(detectProvidersWithEvidence(root)).toEqual([expect.objectContaining({provider:"posthog",key:"phc_real"})])
  })

  it("recognizes spaced initialization calls consistently", () => {
    const root = copyFixture("static-html-basic")
    write(root, "pixels.js", `window.gtag ('config', 'G-REAL123'); posthog.init ('phc_real'); window.fbq ('init', '123456'); twq ('config', 'abc')`)
    expect(detectUnmanagedProviders(root).map(x => x.provider)).toEqual(["ga4", "posthog", "x", "meta"])
    expect(detectProvidersWithEvidence(root).map(x => x.provider)).toEqual(["ga4", "posthog", "x", "meta"])
  })

  it("finds a gtag snippet anywhere in the app with file, line and the measurement id", () => {
    const root = copyFixture("vite-react-basic")
    // A real gtag call in CODE (not a comment — a commented snippet is not an install, see below).
    write(root, "src/components/Analytics.tsx", `export function A(){\n  gtag('config', 'G-ABC123')\n}`)
    const detected = detectProvidersWithEvidence(root)
    expect(detected).toEqual([
      { provider: "ga4", via: "snippet", file: "src/components/Analytics.tsx", line: 2, key: "G-ABC123" }
    ])
  })

  it("does NOT detect a gtag/posthog snippet that lives only in a comment", () => {
    const root = copyFixture("vite-react-basic")
    write(
      root,
      "src/components/Analytics.tsx",
      `export function A(){\n  // gtag('config', 'G-ABC123')\n  // posthog.init('phc_x')\n  return null\n}`
    )
    expect(detectProvidersWithEvidence(root)).toEqual([])
  })

  it("recognises a Tag Manager container as gtm, with its container id, and not as a gtag snippet", () => {
    const root = copyFixture("static-html-basic")
    write(
      root,
      "index.html",
      `<html><head><script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABCD12');</script>\n<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script></head><body></body></html>`
    )
    const detected = detectProvidersWithEvidence(root)
    expect(detected).toEqual([
      { provider: "ga4", via: "gtm", file: "index.html", line: 2, key: "GTM-ABCD12" }
    ])
  })

  it("reads PostHog and Meta ids from existing snippets and ignores node_modules", () => {
    const root = copyFixture("next-app-router-basic")
    write(root, "app/providers.tsx", `posthog.init('phc_abc123DEF', { api_host: 'https://us.i.posthog.com' })`)
    write(root, "app/pixel.tsx", `fbq('init', '1234567890123');\nfbq('track', 'PageView');`)
    write(root, "node_modules/foo/gtag.js", GTAG)
    const detected = detectProvidersWithEvidence(root)
    expect(detected.map((entry) => [entry.provider, entry.key])).toEqual([
      ["posthog", "phc_abc123DEF"],
      ["meta", "1234567890123"]
    ])
  })

  it("reports a conflict-worthy second id for the same provider", () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<html><head>${GTAG}</head><body></body></html>`)
    write(root, "about.html", `<html><head>${GTAG.replace(/G-ABC123/g, "G-ZZZ999")}</head><body></body></html>`)
    const detected = detectProvidersWithEvidence(root)
    expect(detected.map((entry) => entry.key).sort()).toEqual(["G-ABC123", "G-ZZZ999"])
  })
})

describe("detectProvidersWithEvidence uses the tag's own signatures and skip lists", () => {
  it("ignores vendor bundles, declarations, tests and uppercase GTM-looking tokens", () => {
    const root = copyFixture("vite-react-basic")
    write(root, "public/vendor.min.js", `function gtag(){};gtag('config','G-VENDOR01')`)
    write(root, "src/types/gtag.d.ts", `declare function gtag(...args: unknown[]): void`)
    write(root, "src/analytics.test.ts", `posthog.init('phc_test')`)
    write(root, "src/__mocks__/posthog.ts", `posthog.init('phc_mock')`)
    write(root, "src/config.ts", `export const GTM_MODE = 'GTM-CONTAINERLESS'\nwindow.dataLayer.push({ event: 'x' })`)
    expect(detectProvidersWithEvidence(root)).toEqual([])
  })

  it("adopts GA4 installed through @next/third-parties and react-ga4, and PostHog through its React provider", () => {
    const root = copyFixture("next-app-router-basic")
    write(root, "app/ga.tsx", `import { GoogleAnalytics } from "@next/third-parties/google"\nexport const GA = () => <GoogleAnalytics gaId="G-THIRD001" />`)
    write(root, "app/legacy.tsx", `import ReactGA from "react-ga4"\nReactGA.initialize("G-LEGACY01")`)
    write(root, "app/ph.tsx", `import { PostHogProvider } from "posthog-js/react"\nexport const P = () => <PostHogProvider apiKey="phc_provider01" />`)
    const detected = detectProvidersWithEvidence(root)
    expect(detected.map((entry) => [entry.provider, entry.via, entry.file, entry.key])).toEqual([
      ["ga4", "snippet", "app/ga.tsx", "G-THIRD001"],
      ["ga4", "snippet", "app/legacy.tsx", "G-LEGACY01"],
      ["posthog", "snippet", "app/ph.tsx", "phc_provider01"]
    ])
  })

  it("needs real Tag Manager evidence for a container: the gtm.js loader or a gtmId prop", () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-REAL001"></script></head><body></body></html>`)
    expect(detectProvidersWithEvidence(root)).toEqual([{ provider: "ga4", via: "gtm", file: "index.html", line: 1, key: "GTM-REAL001" }])
  })
})

describe("normalizeDetected", () => {
  it("accepts main's string[] and the sibling's object shape", () => {
    expect(normalizeDetected(["ga4", "posthog"])).toEqual([
      { provider: "ga4", via: "snippet", file: "?" },
      { provider: "posthog", via: "snippet", file: "?" }
    ])
    expect(normalizeDetected([{ provider: "ga4", via: "gtm", file: "index.html" }])).toEqual([
      { provider: "ga4", via: "gtm", file: "index.html" }
    ])
  })
})

describe("readEnvKeys", () => {
  it("reads .env and .env.local but never a template", () => {
    const root = copyFixture("next-app-router-basic")
    write(root, ".env.example", "NEXT_PUBLIC_POSTHOG_KEY=phc_TEMPLATE\nNEXT_PUBLIC_GA_MEASUREMENT_ID=G-TEMPLATE\n")
    write(root, ".env", "NEXT_PUBLIC_GA_MEASUREMENT_ID=G-FROMENV\n# comment\nNEXT_PUBLIC_META_PIXEL_ID=\"111222333444\"\n")
    write(root, ".env.local", "NEXT_PUBLIC_POSTHOG_KEY='phc_local'\nNEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com\n")
    const env = readEnvKeys(root, ".")
    expect(env).toEqual({
      ga4MeasurementId: { value: "G-FROMENV", file: ".env" },
      posthogProjectKey: { value: "phc_local", file: ".env.local" },
      posthogApiHost: { value: "https://eu.i.posthog.com", file: ".env.local" },
      metaPixelId: { value: "111222333444", file: ".env" }
    })
  })
})

describe("resolveHarnessKeys", () => {
  it("prefers flags, then discovered artifacts, then .env; existing snippets only fill evidence", () => {
    const resolved = resolveHarnessKeys({
      flags: { ga4: { measurementId: "G-FLAG" } },
      explicitFlags: true,
      discovered: { ga4: { measurementId: "G-DISC" }, posthog: { projectKey: "phc_disc", apiHost: "https://us.i.posthog.com" } },
      env: { metaPixelId: { value: "999888777", file: ".env" }, ga4MeasurementId: { value: "G-ENV", file: ".env" } },
      detected: [{ provider: "x", via: "snippet", file: "index.html", line: 3, key: "o1234" }]
    })
    expect(resolved.artifacts.ga4).toEqual({ measurementId: "G-FLAG" })
    expect(resolved.artifacts.posthog?.projectKey).toBe("phc_disc")
    expect(resolved.artifacts.meta).toEqual({ pixelId: "999888777" })
    expect(resolved.artifacts.x).toBeUndefined()
    expect(resolved.sources).toEqual({ ga4: "flag", posthog: "discovered-artifacts", meta: "env" })
  })
})

describe("classifyProviders", () => {
  const keys = {
    artifacts: {
      ga4: { measurementId: "G-KEY" },
      posthog: { projectKey: "phc_key", apiHost: "https://us.i.posthog.com" },
      infinite: { siteSourceKey: "site_1", collectPath: "/infinite/ledger", productionHosts: ["example.com"] }
    },
    sources: { ga4: "flag" as const, posthog: "flag" as const, infinite: "flag" as const }
  }

  it("absent + key → install; absent + no key → skip; server lane follows the flag", () => {
    const classes = classifyProviders({ manifest: null, detected: [], keys, adoptExisting: true, serverLane: false })
    const byId = Object.fromEntries(classes.map((entry) => [entry.provider, entry]))
    expect(classes.map((entry) => entry.provider)).toEqual(["ga4", "gtm", "posthog", "meta", "x", "infinite", "server_lane"])
    expect(byId.ga4.action).toBe("install")
    expect(byId.posthog.action).toBe("install")
    expect(byId.infinite.action).toBe("install")
    expect(byId.meta).toMatchObject({ action: "skip", reason: expect.stringContaining("no key") })
    expect(byId.x.action).toBe("skip")
    expect(byId.gtm).toMatchObject({ action: "skip", reason: expect.stringContaining("no Tag Manager") })
    expect(byId.server_lane).toMatchObject({ action: "skip" })
  })

  it("unmanaged snippet → adopt with the file as evidence; --no-adopt-existing → report", () => {
    const detected = [{ provider: "ga4" as const, via: "snippet" as const, file: "index.html", line: 4, key: "G-OLD" }]
    const adopt = classifyProviders({ manifest: null, detected, keys, adoptExisting: true, serverLane: false })
    expect(adopt.find((entry) => entry.provider === "ga4")).toMatchObject({
      action: "adopt",
      file: "index.html",
      key: "G-OLD",
      reason: expect.stringContaining("left byte-for-byte alone")
    })
    const refuse = classifyProviders({ manifest: null, detected, keys, adoptExisting: false, serverLane: false })
    expect(refuse.find((entry) => entry.provider === "ga4")).toMatchObject({ action: "report" })
  })

  it("a Tag Manager container makes gtm manual and ga4 adopted through it", () => {
    const detected = [{ provider: "ga4" as const, via: "gtm" as const, file: "index.html", line: 1, key: "GTM-ABCD12" }]
    const classes = classifyProviders({ manifest: null, detected, keys, adoptExisting: true, serverLane: false })
    expect(classes.find((entry) => entry.provider === "gtm")).toMatchObject({ action: "manual", key: "GTM-ABCD12", file: "index.html" })
    expect(classes.find((entry) => entry.provider === "ga4")).toMatchObject({ action: "adopt", reason: expect.stringContaining("Tag Manager") })
  })

  it("two different ids for one provider → report (conflict); a managed provider → upgrade", () => {
    const detected = [
      { provider: "ga4" as const, via: "snippet" as const, file: "index.html", line: 4, key: "G-ONE" },
      { provider: "ga4" as const, via: "snippet" as const, file: "about.html", line: 4, key: "G-TWO" }
    ]
    const classes = classifyProviders({ manifest: null, detected, keys, adoptExisting: true, serverLane: false })
    expect(classes.find((entry) => entry.provider === "ga4")).toMatchObject({ action: "report", reason: expect.stringContaining("G-ONE") })

    const manifest = { providers: ["ga4", "meta"], serverLane: undefined } as never
    const managed = classifyProviders({ manifest, detected: [], keys, adoptExisting: true, serverLane: true })
    expect(managed.find((entry) => entry.provider === "ga4")?.action).toBe("upgrade")
    // Managed but no key this run: not re-planned, and not "absent" either — it is installed.
    expect(managed.find((entry) => entry.provider === "meta")).toMatchObject({ action: "skip", file: ".infinite/install.json", reason: expect.stringContaining("already installed") })
    expect(managed.find((entry) => entry.provider === "server_lane")?.action).toBe("install")
  })
})

describe("buildHarnessPlan", () => {
  it("plans only install/upgrade providers, drops adopted ones, and is deterministic", () => {
    const root = copyFixture("next-app-router-basic")
    write(root, "app/providers.tsx", `posthog.init('phc_existing', { api_host: 'https://us.i.posthog.com' })`)
    const inspect = inspectWorkspace(root)
    const detected = detectProvidersWithEvidence(root)
    const keys = {
      artifacts: {
        ga4: { measurementId: "G-KEY123" },
        posthog: { projectKey: "phc_key", apiHost: "https://us.i.posthog.com" }
      },
      sources: { ga4: "flag" as const, posthog: "flag" as const }
    }
    const classes = classifyProviders({ manifest: null, detected, keys, adoptExisting: true, serverLane: false })
    const first = buildHarnessPlan({ root, inspect, classifications: classes, keys, workspaceId: "ws_1", serverLane: false })
    const second = buildHarnessPlan({ root, inspect, classifications: classes, keys, workspaceId: "ws_1", serverLane: false })
    expect(first.failure).toBeUndefined()
    expect(first.plan.providers).toEqual(["ga4"])
    expect(first.plan.blockers).toEqual([])
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan))
  })

  it("names an unmanaged target with INF_PLAN_UNMANAGED_TARGET", () => {
    const root = copyFixture("next-app-router-basic")
    write(root, "lib/infinite-analytics.ts", "export const mine = true\n")
    const inspect = inspectWorkspace(root)
    const keys = { artifacts: { ga4: { measurementId: "G-KEY123" } }, sources: { ga4: "flag" as const } }
    const classes = classifyProviders({ manifest: null, detected: [], keys, adoptExisting: true, serverLane: false })
    const result = buildHarnessPlan({ root, inspect, classifications: classes, keys, workspaceId: "ws_1", serverLane: false })
    expect(result.failure).toMatchObject({ code: "INF_PLAN_UNMANAGED_TARGET", message: expect.stringContaining("lib/infinite-analytics.ts") })
  })
})
