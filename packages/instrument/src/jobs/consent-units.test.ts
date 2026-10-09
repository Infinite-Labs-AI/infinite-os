import { expect, it } from "vitest"
import { sourceUnits, restoreFrozenUnits } from "./consent-units.js"
import { renderInfiniteBrowserTag } from "../runtime/infinite-browser.js"
import { buildGa4BootstrapSnippet } from "../providers/ga4.js"
import { buildPostHogBootstrapSnippet } from "../providers/posthog.js"
import { buildMetaClickIdCaptureTypescript } from "../providers/meta-browser/click-id.js"
import { ADOPTED_META_HTML } from "../../test/wizard/o7-fakes.js"

it("does not confuse real newly emitted analytics modules with edits to the owner's consent units", () => {
  const scripts = [
    renderInfiniteBrowserTag({ siteSourceKey: "site_fixture", collectPath: "/infinite/ledger", productionHosts: ["example.test"], respectDnt: true, consent: { mode: "required", storageKey: "infinite_analytics_consent" } }),
    buildGa4BootstrapSnippet("G-FAKE00001"),
    buildPostHogBootstrapSnippet("phc_FAKEtestProjectKeyNotReal000", "https://us.i.posthog.com"),
    buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "required" } })
  ]
  for (const script of scripts) expect(restoreFrozenUnits("", script).changes, script.slice(0, 80)).toEqual([])
})

it("allows the actual module-level capture beside a frozen bootstrap", () => {
  const before = "export function boot() {\n  fbq('init','123');\n  fbq?.('consent','revoke');\n}\n"
  const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "required" } })
  const after = `${capture}\n${before}`
  expect(sourceUnits(before).confident).toBe(true)
  expect(sourceUnits(after).confident).toBe(true)
  expect(restoreFrozenUnits(before, after).text).toBe(after)
  expect(restoreFrozenUnits(before, after).changes).toEqual([])
})

it("restores a frozen module statement moved past an existing sibling", () => {
  const consent = "gtag('consent','default',{analytics_storage:'denied'});\n"
  const config = "gtag('config','G-FAKE00001');\n"
  expect(restoreFrozenUnits(consent + config, config + consent).text).toBe(consent + config)
})
it.each([
  ["if/else with an unbraced first arm", "if (enabled) start(); else fbq('consent','revoke');\n", "if (changed) start(); else fbq('consent','revoke');\n"],
])("keeps a complete top-level statement frozen: %s", (_name, before, after) => {
  expect(restoreFrozenUnits(before!, after!).text).toBe(before)
})
it("declares ambiguous anonymous-unit correspondence frozen as a whole before any job can edit a neighbor", () => {
  const before = "(function(){ ga4(); })();\n(function(){ fbq('consent','revoke'); })();\n"
  const after = "(function(){ fbq('consent','revoke'); })();\n(function(){ ga4Improved(); })();\n"
  expect(sourceUnits(before).confident).toBe(false)
  expect(sourceUnits(before).units).toHaveLength(1)
  expect(sourceUnits(before).units[0]?.frozen).toBe(true)
  expect(restoreFrozenUnits(before, after).text).toBe(before)
})
it("freezes a recognized Consent Mode map without following its readers", () => {
  const before = "const DENIED = { analytics_storage: 'denied' };\nsend(safe);\nsend(DENIED);\n"
  const after = before.replace("'denied'", "'granted'").replace("send(safe)", "send(improved)")
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, after).text).toBe(before.replace("send(safe)", "send(improved)"))
})

it("never loses raw consent behind awkward inserted syntax before the call", () => {
  const fragments = ["/*", "*/", "//", "`", "${", "</script>", "'", "/x/"]
  const calls = ["fbq('consent','revoke');", "gtag('consent','update',{analytics_storage:'denied'});", "posthog?.opt_out_capturing();",
    "f( /* owner choice */ 'consent' /* owner action */, 'revoke');", "f.call(null, // owner choice\n 'consent', 'revoke');",
    "posthog.opt_out_capturing /* owner choice */ ();"]
  const prefix = "export const label = 'fixture';\n"
  let frozen = 0
  for (const call of calls) for (const fragment of fragments) for (let at = 0; at <= prefix.length; at++) {
    const source = prefix.slice(0, at) + fragment + prefix.slice(at) + call + "\n"
    expect(sourceUnits(source).units.some(unit => unit.frozen), `${fragment} at ${at}: ${call}`).toBe(true)
    frozen++
  }
  expect(frozen).toBe(1584)
})

it.each([
  '<html><!-- gtag("consent", "default", {}); --><body>Hello</body></html>',
])("conservatively freezes raw consent patterns inside complete markup comments", source => {
  expect(sourceUnits(source).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(source, source.replace("revoke", "grant").replace("default", "update")).text).toBe(source)
})

it.each([
  '<html><script><!-- legacy line comment\nfbq("consent", "revoke");\n// --></script></html>',
  'export default function X() { return <div>{/* unclosed\nfbq("consent", "revoke");',
])("retains live or uncertain calls after comment markers", before => {
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace("revoke", "grant")).text).toBe(before)
})

it.each([
  "window.fbq /* owner API */ = () => {};",
  "function helper(fbq) { return 1; }",
])("allows API syntax without a recognized consent call: %s", addition => {
  const before = "export const title = 'Example';\n"
  const after = before + addition + "\n"
  expect(restoreFrozenUnits(before, after)).toMatchObject({ text: after, changes: [] })
})

it("keeps ordinary exported calls editable beside consent when their options contain braces", () => {
  const before = "export function ph() { posthog.init('phc_FAKE', { api_host: '/ingest' }); }\nfunction owner() { fbq('consent', 'revoke'); }\n"
  const after = before.replace("api_host: '/ingest'", "api_host: '/ingest', mask_all_text: true")
  expect(sourceUnits(before).units.find(unit => unit.key === "function:ph")?.frozen).toBe(false)
  expect(restoreFrozenUnits(before, after).text).toBe(after)
  expect(restoreFrozenUnits(before, after).changes).toEqual([])
})

it.each([
  "import { fbq as send } from './owner';",
])("allows API import/export clauses without a consent call: %s", addition => {
  const result = restoreFrozenUnits("", addition + "\n")
  expect(result.text).toBe(addition + "\n")
  expect(result.changes).toEqual([])
})

it.each([
  ADOPTED_META_HTML,
])("allows an independent HTML loader beside an unchanged owner bootstrap", before => {
  const after = before.replace("<head>", '<head>\n<script src="/infinite-meta-capture.js"></script>')
  expect(sourceUnits(before).confident).toBe(false)
  const result = restoreFrozenUnits(before, after)
  expect(result.text).toBe(after)
  expect(result.changes).toEqual([])
})

it("still freezes HTML containing a recognized consent call", () => {
  const withConsent = ADOPTED_META_HTML.replace("fbq('init'", "fbq('consent', 'revoke');\n      fbq('init'")
  const cases = [
    [withConsent, withConsent.replace("<head>", '<head>\n<script src="/capture.js"></script>')],
  ]
  for (const [before, after] of cases) {
    const result = restoreFrozenUnits(before!, after!)
    expect(result.text).toBe(before)
    expect(result.changes.length).toBeGreaterThan(0)
  }
})

it("allows an independent init guard inside the owner script while its complete bootstrap line stays unchanged", () => {
  const after = ADOPTED_META_HTML.replace("fbq('init'", "if (location.hostname === 'example.test') fbq('init'")
  const result = restoreFrozenUnits(ADOPTED_META_HTML, after)
  expect(result.text).toBe(after)
  expect(result.changes).toEqual([])
})

