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
it("shares token-normalized call patterns, including comments and computed optional members", () => {
  for (const call of ["fbq /* spaced */ ?. /* spaced */ ('consent','revoke');", "window['gtag'] /* spaced */ ('consent','default',{analytics_storage:'denied'});", "posthog?.['opt_out_capturing']?.();"]) {
    expect(restoreFrozenUnits("", call).changes.length).toBeGreaterThan(0)
  }
})
it.each([
  ["if/else with an unbraced first arm", "if (enabled) start(); else fbq('consent','revoke');\n", "if (changed) start(); else fbq('consent','revoke');\n"],
  ["do/while across a newline", "do { fbq('consent','revoke'); }\nwhile (enabled);\n", "do { fbq('consent','revoke'); }\nwhile (changed);\n"],
])("keeps a complete top-level statement frozen: %s", (_name, before, after) => {
  expect(restoreFrozenUnits(before!, after!).text).toBe(before)
})
it("freezes an ambiguous newline tagged template as one whole file", () => {
  const before = "const action = tag\n`gtag('consent','default',{})`;\n"
  expect(sourceUnits(before).confident).toBe(false)
  expect(restoreFrozenUnits(before, before.replace("= tag", "= otherTag")).text).toBe(before)
})
it("declares ambiguous anonymous-unit correspondence frozen as a whole before any job can edit a neighbor", () => {
  const before = "(function(){ ga4(); })();\n(function(){ fbq('consent','revoke'); })();\n"
  const after = "(function(){ fbq('consent','revoke'); })();\n(function(){ ga4Improved(); })();\n"
  expect(sourceUnits(before).confident).toBe(false)
  expect(sourceUnits(before).units).toHaveLength(1)
  expect(sourceUnits(before).units[0]?.frozen).toBe(true)
  expect(restoreFrozenUnits(before, after).text).toBe(before)
})
it("does not infer consent from storage names or readers of an ordinary value map", () => {
  const before = "const DENIED = { analytics_storage: 'denied' };\nsend(safe);\nsend(DENIED);\n"
  const after = "const DENIED = { analytics_storage: 'denied' };\nsend(DENIED);\nsend(improved);\n"
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(false)
  expect(restoreFrozenUnits(before, after).text).toBe(after)
})

it("never loses raw consent behind awkward inserted syntax before the call", () => {
  const fragments = ["/*", "*/", "//", "`", "${", "</script>", "'", "/x/"]
  const calls = ["fbq('consent','revoke');", "gtag('consent','update',{analytics_storage:'denied'});", "posthog?.opt_out_capturing();",
    "f( /* owner choice */ 'consent' /* owner action */, 'revoke');", "f.call(null, // owner choice\n 'consent', 'revoke');",
    "posthog.opt_out_capturing /* owner choice */ ();"]
  const prefix = "export const label = 'fixture';\n"
  let frozen = 0, comments = 0
  for (const call of calls) for (const fragment of fragments) for (let at = 0; at <= prefix.length; at++) {
    const source = prefix.slice(0, at) + fragment + prefix.slice(at) + call + "\n"
    // These insertions comment out the whole call, rather than hide a live call behind awkward syntax.
    const lineComment = fragment === "//" && at === prefix.length && !call.includes("\n")
    const closedBlock = fragment === "/*" && call === calls[5] && (at <= prefix.indexOf("'") || at > prefix.lastIndexOf("'"))
    const commentOnly = lineComment || closedBlock
    expect(sourceUnits(source).units.some(unit => unit.frozen), `${fragment} at ${at}: ${call}`).toBe(!commentOnly)
    if (commentOnly) comments++; else frozen++
  }
  expect({ frozen, comments }).toEqual({ frozen: 1554, comments: 30 })
})

it("freezes raw consent arguments after a JSX glob even when comments separate the argument", () => {
  const before = "export default function Page(){ return <p>Use src/* here</p>; }\nf( /* owner choice */ 'consent', 'revoke');\n"
  expect(sourceUnits(before).confident).toBe(false)
  expect(sourceUnits(before).units).toHaveLength(1)
  expect(sourceUnits(before).units[0]?.text).toBe(before)
  expect(restoreFrozenUnits(before, before.replace("revoke", "grant")).text).toBe(before)
})

it.each([
  'export default function Layout() { return <html><script>{`const a="<!--";fbq("consent","revoke");const b="-->";`}</script></html> }',
  'const a="<!--";fbq("consent","revoke");const b="-->";',
])("does not mistake HTML comment delimiters in strings for comments hiding live consent", before => {
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace("revoke", "grant")).text).toBe(before)
})

it.each([
  'export default function X() { return <div>{/* gtag("consent", "default", {}); */}</div> }',
  'export default function X() { return <div>{ /* fbq("consent", "revoke"); */ }</div> }',
  '<html><!-- gtag("consent", "default", {}); --><body>Hello</body></html>',
  'export default function X() { /* fbq("consent", "revoke"); */ return <div />; }',
])("does not freeze calls contained in proven complete markup comments", source => {
  expect(sourceUnits(source).units.some(unit => unit.frozen)).toBe(false)
  expect(restoreFrozenUnits(source, source.replace("revoke", "grant").replace("default", "update")).changes).toEqual([])
})

it.each([
  '<html><script><!-- legacy line comment\nfbq("consent", "revoke");\n// --></script></html>',
  'export default function X() { return <div>{/* docs */}<script>{`fbq("consent", "revoke");`}</script></div> }',
  '<html><!-- docs --><script>fbq("consent", "revoke");</script></html>',
  'export default function X() { return <div>{/* unclosed\nfbq("consent", "revoke");',
])("retains live or uncertain calls after comment markers", before => {
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace("revoke", "grant")).text).toBe(before)
})


it.each([
  "window.fbq /* owner API */ = () => {};",
  "function* fbq() {}",
  "Object.defineProperty(window, `gtag`, {value: () => {}});",
  "const f = window?.fbq;",
  "const f = window /* owner API */ .fbq;",
  "function helper(fbq) { return 1; }",
  "const lib = { fbq() {} };",
  "let harmless = 1, fbq;",
  "function outer(){ function helper(fbq) {} }",
  "function outer(){ let harmless = 1, fbq; }",
  "Object['defineProperty'](window, 'gtag', {value: () => {}});",
  "delete\n window.fbq;",
  "const f = (window.fbq);",
  "const lib = {fbq};",
])("allows API syntax without a recognized consent call: %s", addition => {
  const before = "export const title = 'Example';\n"
  const after = before + addition + "\n"
  expect(restoreFrozenUnits(before, after)).toMatchObject({ text: after, changes: [] })
})

it.each([
  "window.fbq =\n  realPixel;\n",
  "Object.defineProperty(window, 'fbq', {\n  value: realPixel,\n});\n",
])("allows changed API continuation lines without a consent call: %s", before => {
  const after = before.replace("realPixel", "fakePixel")
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
  "import fbq from './owner';",
  "import { fbq as send } from './owner';",
  "import { send as fbq } from './owner';",
  "import type { fbq } from './owner';",
  "import * as posthog from './owner';",
  "import {\n fbq as send,\n} from './owner';",
  "export { fbq as send };",
  "export { send as fbq } from './owner';",
  "export type { fbq } from './owner';",
  "export {\n send as fbq,\n} from './owner';",
  "export * as posthog from './owner';",
])("allows API import/export clauses without a consent call: %s", addition => {
  const result = restoreFrozenUnits("", addition + "\n")
  expect(result.text).toBe(addition + "\n")
  expect(result.changes).toEqual([])
})

it.each([
  "<html><head>\n<script>window.fbq = function () { return 1; };</script>\n</head></html>\n",
  ADOPTED_META_HTML,
])("allows an independent HTML loader beside an unchanged owner bootstrap", before => {
  const after = before.replace("<head>", '<head>\n<script src="/infinite-meta-capture.js"></script>')
  expect(sourceUnits(before).confident).toBe(false)
  const result = restoreFrozenUnits(before, after)
  expect(result.text).toBe(after)
  expect(result.changes).toEqual([])
})

it.each([
  "window.fbq =\n  realPixel;\n",
  "Object.defineProperty(window, 'fbq', {\n  value: realPixel,\n});\n",
])("allows API continuation changes in HTML without consent calls: %s", body => {
  const before = `<html><head>\n<script>\n${body}</script>\n</head></html>\n`
  const after = before.replace("realPixel", "fakePixel")
  expect(restoreFrozenUnits(before, after)).toMatchObject({ text: after, changes: [] })
})

it("does not infer consent from a copied API script or changed script attributes", () => {
  const script = '<script type="module">window.fbq = () => {};</script>\n'
  const before = `<html><head>\n${script}</head></html>\n`
  for (const after of [before.replace("</head>", script + "</head>"), before.replace('type="module"', 'type="text/javascript"')]) {
    const result = restoreFrozenUnits(before, after)
    expect(result.text).toBe(after)
    expect(result.changes).toEqual([])
  }
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

it("allows a JSX sibling mount beside an unchanged static API import", () => {
  const before = "import posthog from 'posthog-js'\nexport default function App() { return <main />; }\n"
  const after = before.replace("<main />", "<><main /><Analytics /></>")
  const result = restoreFrozenUnits(before, after)
  expect(result.text).toBe(after)
  expect(result.changes).toEqual([])
})

it("allows API assignments and parameters beside an ordinary TSX import", () => {
  const before = "import posthog from 'posthog-js'\nexport default function App() { return <main />; }\n"
  for (const addition of ["window.fbq = () => {};", "const helper = (posthog) => {};", "const helper = fbq => {};"]) {
    const after = before + addition + "\n"
    expect(restoreFrozenUnits(before, after)).toMatchObject({ text: after, changes: [] })
  }
})
