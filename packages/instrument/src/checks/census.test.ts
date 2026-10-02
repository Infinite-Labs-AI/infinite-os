// The provider census (lane O6) over real fixture repos written to a temp dir. Incidents named here
// (wf5-PORT-PLAN §4): "Sandbox held the production pixel (09-21/22)" → envSourcedIds; "Merge nearly
// stripped the Meta helpers (849ccf1)" → one fbq('init') per pixel per page; duplicates of every kind.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildAnalyticsModuleSource } from "../frameworks/managed-files.js"
import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"
import { getProviderAdapter } from "../providers/index.js"
import type { InstallPlan } from "../types.js"
import { censusChecks, censusInstalledTools, censusPages, runCensus } from "./census.js"

const NOW = () => new Date("2026-10-02T10:00:00.000Z")
const ctx = { runId: "7f3c2a91-b0de-4c03-9a00-000000000001", now: NOW }

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "census-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function check(results: ReturnType<typeof censusChecks>, id: string) {
  return results.find((result) => result.checkId === id)!
}

const LAYOUT_WITH_ENV_PIXEL = `import Script from "next/script"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <Script id="fb">{\`
          !function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
          fbq('init', '\${process.env.NEXT_PUBLIC_META_PIXEL_ID}');
          fbq('track', 'PageView');
        \`}</Script>
      </body>
    </html>
  )
}
`

describe("envSourcedIds (R1-28)", () => {
  it("names NEXT_PUBLIC_META_PIXEL_ID at its file:line, repo-root relative in a monorepo", () => {
    const root = repo({ "apps/web/package.json": "{}", "apps/web/app/layout.tsx": LAYOUT_WITH_ENV_PIXEL })
    const census = runCensus({ root, appRoot: "apps/web" })
    expect(census.envSourcedIds).toEqual([{ tool: "meta", envName: "NEXT_PUBLIC_META_PIXEL_ID", file: "apps/web/app/layout.tsx", line: 10 }])
    expect(census.entries).toEqual([{ tool: "meta", kind: "fbq_init", id: null, file: "apps/web/app/layout.tsx", line: 10, owner: "adopted" }])
  })

  it("follows one local constant and reads import.meta.env, GoogleAnalytics and PostHogProvider props", () => {
    const root = repo({
      "src/analytics.ts": `const GA = import.meta.env.VITE_GA4_ID\nexport function start() {\n  gtag('config', GA)\n}\n`,
      "app/providers.tsx": `export function P({ children }) {\n  return <PostHogProvider apiKey={process.env.NEXT_PUBLIC_POSTHOG_KEY!} options={{ api_host: "/ingest" }}>{children}</PostHogProvider>\n}\n`,
      "app/layout.tsx": `export default function L() {\n  return <GoogleAnalytics gaId={process.env["NEXT_PUBLIC_GA_ID"]} />\n}\n`
    })
    const names = runCensus({ root, appRoot: "." }).envSourcedIds.map((entry) => `${entry.tool}:${entry.envName}@${entry.file}:${entry.line}`)
    expect(names.sort()).toEqual([
      "ga4:NEXT_PUBLIC_GA_ID@app/layout.tsx:2",
      "ga4:VITE_GA4_ID@src/analytics.ts:3",
      "posthog:NEXT_PUBLIC_POSTHOG_KEY@app/providers.tsx:2"
    ])
  })

  it("negative: a literal id is not env-sourced; a call in a comment or a plain string is no install", () => {
    const root = repo({
      "app/layout.tsx": `// fbq('init', process.env.NEXT_PUBLIC_OLD_PIXEL)\nconst example = "fbq('init', process.env.NEXT_PUBLIC_DOC_PIXEL)"\nfbq('init', '1234567890123456')\n`
    })
    const census = runCensus({ root, appRoot: "." })
    expect(census.envSourcedIds).toEqual([])
    expect(census.entries).toEqual([{ tool: "meta", kind: "fbq_init", id: "1234567890123456", file: "app/layout.tsx", line: 3, owner: "adopted" }])
  })
})

describe("managed blocks count once per tool and id", () => {
  const artifacts = {
    productionHosts: ["acme.com"],
    ga4: { measurementId: "G-FAKE00001" },
    meta: { pixelId: "1234567890123456", advancedMatching: true },
    infinite: { siteSourceKey: "site_FAKEacme", consentMode: "not_required" as const, collectPath: "/infinite/ledger", productionHosts: ["acme.com"] }
  }
  const snippets = (framework: "static-html" | "next-app-router") =>
    (["ga4", "meta", "infinite"] as const).flatMap((provider) => getProviderAdapter(provider).plan(framework, artifacts[provider] as never, { artifacts } as never).instructions)

  it("static HTML: the managed block is managed (the AM accessor's re-init is not a second start)", () => {
    const block = buildManagedHtmlBlock(snippets("static-html").map((instruction) => instruction.snippet))
    const root = repo({ "index.html": `<!doctype html><html><head>${block}</head><body></body></html>` })
    const census = runCensus({ root, appRoot: "." })
    expect(census.entries.map((entry) => `${entry.owner}:${entry.kind}:${entry.tool}:${entry.id}`).sort()).toEqual([
      "managed:managed_block:ga4:G-FAKE00001",
      "managed:managed_block:infinite:site_FAKEacme",
      "managed:managed_block:meta:1234567890123456"
    ])
    expect(check(censusChecks(census, ctx), "census_one_per_tool").state).toBe("pass")
  })

  it("Next: the managed module's decoded bootstrapSource is managed, at the literal's line", () => {
    const module = buildAnalyticsModuleSource({ instructions: snippets("next-app-router") } as unknown as InstallPlan)
    const root = repo({ "lib/infinite-analytics.ts": module, "app/layout.tsx": "export default function L({ children }) { return children }\n" })
    const census = runCensus({ root, appRoot: "." })
    expect(census.entries.every((entry) => entry.owner === "managed" && entry.file === "lib/infinite-analytics.ts" && entry.line === 3)).toBe(true)
    expect(censusInstalledTools(census)).toEqual(["infinite", "ga4", "meta"])
  })

  it("negative: managed + an adopted gtag for the same id on one page is a duplicate", () => {
    const block = buildManagedHtmlBlock(snippets("static-html").map((instruction) => instruction.snippet))
    const root = repo({ "index.html": `<html><head>${block}<script>gtag('config', 'G-FAKE00001');</script></head></html>` })
    const results = censusChecks(runCensus({ root, appRoot: "." }), ctx)
    expect(check(results, "census_ga4_config_once").state).toBe("problem")
    expect(check(results, "census_ga4_config_once").reason).toContain("starts 2 times")
    expect(check(results, "census_one_per_tool").state).toBe("problem")
    expect(check(results, "census_meta_init_once").state).toBe("pass")
  })
})

describe("duplicates, per page", () => {
  it("two posthog.init in the shell (layout + provider) are a duplicate on every page", () => {
    const root = repo({
      "app/layout.tsx": "posthog.init('phc_FAKEkey000', { api_host: '/ingest' })\n",
      "app/providers.tsx": "posthog.init('phc_FAKEkey000', { api_host: '/ingest' })\n",
      "app/page.tsx": "export default function Page() { return null }\n"
    })
    const result = check(censusChecks(runCensus({ root, appRoot: "." }), ctx), "census_posthog_init_once")
    expect(result.state).toBe("problem")
    expect(result.evidence).toEqual([
      { file: "app/layout.tsx", line: 1 },
      { file: "app/providers.tsx", line: 1 }
    ])
  })

  it("negative: one gtag config on each of two static pages is one per page, not a duplicate", () => {
    const root = repo({
      "index.html": "<html><head><script>gtag('config', 'G-FAKE00001');</script></head></html>",
      "about.html": "<html><head><script>gtag('config', 'G-FAKE00001');</script></head></html>"
    })
    const census = runCensus({ root, appRoot: "." })
    expect(censusPages(census.entries).map((page) => page.page).sort()).toEqual(["about.html", "index.html"])
    expect(check(censusChecks(census, ctx), "census_ga4_config_once").state).toBe("pass")
  })

  it("two fbq('init') for one pixel on one page are a duplicate (the 849ccf1 near-miss)", () => {
    const root = repo({ "index.html": "<html><head><script>fbq('init', '1234567890123456');fbq('init', '1234567890123456');</script></head></html>" })
    expect(check(censusChecks(runCensus({ root, appRoot: "." }), ctx), "census_meta_init_once").state).toBe("problem")
  })

  it("GTM containers are listed but never counted as a second gtag", () => {
    const root = repo({
      "index.html": `<html><head><script>(function(w,d,s,l,i){j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-FAKE01');gtag('config','G-FAKE00001');</script></head></html>`
    })
    const census = runCensus({ root, appRoot: "." })
    expect(census.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["gtag_config:G-FAKE00001", "gtm:GTM-FAKE01"])
    expect(check(censusChecks(census, ctx), "census_ga4_config_once").state).toBe("pass")
  })
})

describe("identify / reset evidence (finish line 7)", () => {
  it("finds posthog.identify / infiniteIdentify and every reset, with file:line", () => {
    const root = repo({
      "app/auth.ts": "export async function onLogin(id: string) {\n  infiniteIdentify(id)\n}\nexport function onLogout() {\n  posthog.reset()\n}\n"
    })
    const census = runCensus({ root, appRoot: "." })
    expect(census.identify).toEqual({ identifyCalls: [{ file: "app/auth.ts", line: 2 }], resetCalls: [{ file: "app/auth.ts", line: 5 }] })
  })

  it("negative: a mention in a comment is not a call", () => {
    const root = repo({ "app/auth.ts": "// remember to posthog.identify(user.id) and posthog.reset()\n" })
    expect(runCensus({ root, appRoot: "." }).identify).toEqual({ identifyCalls: [], resetCalls: [] })
  })
})
