import { afterEach, expect, it } from "vitest"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupSites, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { buildPostHogBootstrapSnippet } from "../providers/posthog.js"
import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import { uninstallInstallation } from "../uninstall.js"
import { sourceUnits, restoreFrozenUnits } from "./consent-units.js"

afterEach(cleanupSites)
const ga4 = "window.dataLayer = window.dataLayer || [];\nfunction gtag(){ dataLayer.push(arguments); }\ngtag('js', new Date());\ngtag('config', 'G-FIXTURE123');"
const meta = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1234567890123456');
fbq('track', 'PageView');`
const posthog = buildPostHogBootstrapSnippet("phc_fixture00000000000000000", "https://us.i.posthog.com")
const template = `<!doctype html>\n<html><head>\n<script>\n${ga4}\n</script>\n<script>\n${meta}\n</script>\n<script>\n${posthog}\n</script>\n</head><body>{% block content %}{% endblock %}</body></html>\n`
const guard = "location.hostname === 'example.test'"
const edits = [
  ["GA4 config guard", (source: string) => source.replace("gtag('config',", `if (${guard}) gtag('config',`)],
  ["Meta init guard", (source: string) => source.replace("fbq('init',", `if (${guard}) fbq('init',`)],
  ["PostHog init guard", (source: string) => source.replace("posthog.init(", `if (${guard}) posthog.init(`)],
  ["bootstrap wrapper", (source: string) => source.replace(meta, `if (${guard}) {\n${meta}\n}`)],
  ["GA4 improve", (source: string) => source.replace("'G-FIXTURE123');", "'G-FIXTURE123', { send_page_view: false });")],
  ["Meta improve", (source: string) => source.replace("fbq('init',", "fbq('set', 'autoConfig', false, '1234567890123456');\nfbq('init',")],
  ["PostHog improve", (source: string) => source.replace('api_host:', 'mask_all_text: true, api_host:')],
] as const
it.each(edits)("keeps %s in a template with stock bootstraps and no consent calls", (_name, edit) => {
  const after = edit(template)
  expect(after).not.toBe(template)
  expect(sourceUnits(template).units.some(unit => unit.frozen)).toBe(false)
  expect(restoreFrozenUnits(template, after)).toMatchObject({ text: after, changes: [] })
})

const layouts = [
  ["PostHog provider", "import posthog from 'posthog-js';\nimport { PostHogProvider } from 'posthog-js/react';\nexport default function Layout({children}) { return <html><body><PostHogProvider client={posthog}>{children}</PostHogProvider></body></html>; }\n"],
  ["GA4 inline bootstrap", `export default function Layout({children}) { return <html><body><script dangerouslySetInnerHTML={{ __html: \`${ga4}\` }} />{children}</body></html>; }\n`],
  ["Window typing", "declare global { interface Window { gtag: (...args: unknown[]) => void } }\nexport default function Layout({children}) { return <html><body>{children}</body></html>; }\n"],
  ["PostHog hook", "import { usePostHog } from 'posthog-js/react';\nexport default function Layout({children}) { const posthog = usePostHog(); return <html><body>{children}</body></html>; }\n"],
] as const

it("keeps a guard in a plain TS function containing the stock gtag bootstrap", () => {
  const before = `export function boot() {\n${ga4}\n}\n`
  const after = before.replace("gtag('config',", `if (${guard}) gtag('config',`)
  expect(restoreFrozenUnits(before, after)).toMatchObject({ text: after, changes: [] })
})

it.each(["preview guard", "collection option"])("keeps a PostHog %s in its provider component", kind => {
  const before = layouts[0][1].replace("export default", "posthog.init('phc_fixture', { api_host: '/ingest' });\nexport default")
  const after = kind === "preview guard" ? before.replace("posthog.init(", `if (${guard}) posthog.init(`) : before.replace("api_host: '/ingest'", "api_host: '/ingest', mask_all_text: true")
  expect(restoreFrozenUnits(before, after)).toMatchObject({ text: after, changes: [] })
})

it.each(layouts)("wires and uninstalls analytics in a consent-free %s layout", (name, source) => {
  const root = makeSite({ "package.json": '{"dependencies":{"next":"16.0.0","react":"19.0.0"}}', "app/layout.tsx": source })
  const artifacts = name === "GA4 inline bootstrap" ? { posthog: { projectKey: "phc_fixture00000000000000000", apiHost: "https://us.i.posthog.com" } } : { ga4: { measurementId: "G-FIXTURE456" } }
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts })
  const result = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(result.requiresManual ?? []).toEqual([])
  expect(result.changedFiles).toContain("app/layout.tsx")
  expect(read(root, "app/layout.tsx")).toContain("<InfiniteAnalyticsClient />")
  const undone = uninstallInstallation({ root, allowDirty: true })
  expect(undone.restoredFiles).toContain("app/layout.tsx")
  expect(read(root, "app/layout.tsx")).toBe(source)
})

it("uninstalls older wiring after the owner adds ordinary PostHog provider code", () => {
  const source = "export default function Layout({children}) { return <html><body>{children}</body></html>; }\n"
  const root = makeSite({ "package.json": '{"dependencies":{"next":"16.0.0","react":"19.0.0"}}', "app/layout.tsx": source })
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE456" } } })
  applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  const installed = read(root, "app/layout.tsx")
  const ownerEdit = (text: string) => "import posthog from 'posthog-js';\n" + text.replace("{children}</body>", "<PostHogProvider client={posthog}>{children}</PostHogProvider></body>")
  writeFileSync(join(root, "app/layout.tsx"), ownerEdit(installed))
  expect(restoreFrozenUnits(ownerEdit(installed), ownerEdit(source)).changes).toEqual([])
  const result = uninstallInstallation({ root, allowDirty: true })
  expect(result.restoredFiles).toContain("app/layout.tsx")
  expect(read(root, "app/layout.tsx")).toBe(ownerEdit(source))
})

it.each([
  "// Cookiebot reads ad_storage.\nexport const title = 'Example';\n",
  "/* Cookiebot reads ad_storage. */\nexport const title = 'Example';\n",
  "<html><body><p>Cookiebot uses ad_storage.</p></body></html>\n",
  "const title = 'Cookiebot uses ad_storage';\n",
  "// fbq('consent', 'revoke');\nexport const title = 'Example';\n",
  "/* gtag('consent', 'default', {}); */\nexport const title = 'Example';\n",
  "const DENIED = { analytics_storage: 'denied', ad_storage: 'denied' };\n",
])("conservatively freezes raw recognized markers in comments or prose: %s", source => {
  expect(sourceUnits(source).units.some(unit => unit.frozen)).toBe(true)
})

it.each(["__tcfapi('getTCData', 2, callback);", "Cookiebot.renew();", "Cookiebot?.renew();", "OneTrust?.AllowAll();", "posthog?.opt_out_capturing();", "send('consent', 'revoke');", "send.apply(null, ['consent', 'revoke']);"])("freezes recognized consent calls: %s", call => {
  const before = `function owner() { ${call} }\n`
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace(call, "")).text).toBe(before)
})


it("does not infer a consent pattern from a site-specific helper name alone", () => {
  const source = "function readTrackingConsent() { return localStorage.getItem('choice'); }\n"
  expect(sourceUnits(source).units.some(unit => unit.frozen)).toBe(false)
})
