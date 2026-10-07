import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, item, makeFenceFixture, tempDir, write } from "../../test/wizard/repo.js"
import { Fence } from "./fence.js"
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))
const file = "src/tracking.ts"
const module = [
  "const GRANTED_MODE = { analytics_storage: 'granted', ad_storage: 'granted' };",
  "function readTrackingConsent() { return localStorage.getItem('tracking_choice'); }",
  "export function startGoogle() {",
  "  if (readTrackingConsent() === 'granted') {",
  "    window[\"gtag\"](\"consent\", \"update\", GRANTED_MODE);",
  "  }",
  "}",
  "export function startMeta() {",
  "  fbq('init', '123');",
  "  fbq('consent', 'grant');",
  "  x.fbq?.(\"consent\", \"revoke\");",
  "}",
  "function startPosthog() {",
  "  posthog.opt_in_capturing();",
  "  posthog?.opt_out_capturing();",
  "}",
  "function unrelated() { return 1; }", ""
].join("\n")
async function turn(before: string, after: string) {
  const { root } = makeFenceFixture(); const home = tempDir("frozen-unit-")
  dirs.push(root, home); write(root, file, before)
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "freeze-fixture", turn: 1, items: [item("meta_improve:fixture", [file])] })
  write(root, file, after); fence.recordEditActivity("meta_improve:fixture", file)
  const warning = await fence.claimConsentProblems("meta_improve:fixture")
  const result = await fence.end()
  return { text: readFileSync(join(root, file), "utf8"), result, warning }
}
const plain = "  fbq('consent', 'grant');"
const option = '  x.fbq?.("consent", "revoke");'
const wrap = (header: string, footer: string) => module.replace(plain, `${header}\n${plain}\n${footer}`)

describe("top-level consent units: real fence table", () => {
  it.each([
    ["byte-identical if wrap", wrap("  if (enabled) {", "  }")],
    ["byte-identical timeout wrap", wrap("  setTimeout(() => {", "  }, 60000);")],
    ["byte-identical load callback", wrap("  addEventListener('load', () => {", "  });")],
    ["byte-identical while wrap", wrap("  while (false) {", "  }")],
    ["return before call", module.replace(plain, `  return;\n${plain}`)],
    ["throw before call", module.replace(plain, `  throw Error('stop');\n${plain}`)],
    ["guard between init and grant", module.replace(plain, `  if (!productionHost) return;\n${plain}`)],
    ["shadowing const", `const fbq = () => {};\n${module}`],
    ["shadowing import", `import { gtag } from './noop';\n${module}`],
    ["shadowing parameter", module.replace("startMeta()", "startMeta(fbq)")],
    ["optional revoke change", module.replace(option, option.replace("revoke", "grant"))],
    ["optional revoke remove", module.replace(`${option}\n`, "")],
    ["optional revoke indentation", module.replace(option, `  ${option}`)],
    ["optional opt-out change", module.replace("posthog?.opt_out_capturing()", "posthog?.opt_in_capturing()")],
    ["new optional call", `${module}window.fbq?.('consent','grant');\n`],
    ["computed gtag change", module.replace('"update", GRANTED_MODE', '"update", {}')],
    ["remove the site's own gate", module.replace("  if (readTrackingConsent() === 'granted') {\n", "").replace("  }\n}\nexport function startMeta", "}\nexport function startMeta")],
    ["change the site's gate reader", module.replace("localStorage.getItem('tracking_choice')", "'granted'")],
  ])("restores %s", async (_name, after) => {
    const result = await turn(module, after!)
    expect(result.text).toBe(module)
    expect(result.warning.length).toBeGreaterThan(0)
  })

  it("restores only the frozen unit, retaining a same-file neighbor and a new top-level capture", async () => {
    const capture = "function captureClickId() { return new URL(location.href).searchParams.get('fbclid'); }\n"
    const after = wrap("  while (false) {", "  }").replace("return 1", "return 2") + capture
    const result = await turn(module, after)
    expect(result.text).toBe(module.replace("return 1", "return 2") + capture)
  })

  it("freezes a top-level const map and declarations that reference it", async () => {
    const before = "const GRANTED_MODE = { analytics_storage: 'granted' };\nfunction readTrackingMode() { return GRANTED_MODE; }\nfunction unrelated() { return 1; }\n"
    const result = await turn(before, before.replace("return GRANTED_MODE", "return {}").replace("return 1", "return 2"))
    expect(result.text).toBe(before.replace("return 1", "return 2"))
  })

  it("an uncertain split freezes the whole consent-bearing file", async () => {
    const before = "<unknown-syntax>\nfbq?.('consent','revoke');\nexport const other = 1;\n"
    expect((await turn(before, before.replace("other = 1", "other = 2"))).text).toBe(before)
  })
})

it("derives every binding in a multi-declarator Consent Mode map unit", async () => {
  const before = "const unrelated = 0, DENIED = { analytics_storage: 'denied' };\nfunction readTracking() { return DENIED; }\n"
  expect((await turn(before, before.replace("return DENIED", "return {}"))).text).toBe(before)
})

it("refuses worker-added API definitions even when no existing API was referenced", async () => {
  const before = "export const title = 'Example';\n"
  const after = before + "function gtag() { dataLayer.push(arguments); }\n"
  expect((await turn(before, after)).text).toBe(before)
})

it.each([
  ["ambient declaration becomes executable", "declare const fbq: (...args: unknown[]) => void;", "const fbq = (...args: unknown[]) => {};"],
  ["type-only import becomes executable", "import type { fbq } from './types';", "import { fbq } from './noop';"],
  ["type-only named import becomes executable", "import { type fbq } from './types';", "import { fbq } from './noop';"],
  ["existing API initializer replaced", "const fbq = window.fbq;", "const fbq = (...args: unknown[]) => {};"],
  ["existing API import replaced", "import { fbq } from './pixel';", "import { fbq } from './noop';"],
])("restores a changed API binding used by owner consent: %s", async (_name, declaration, replacement) => {
  const before = `${declaration}\nfunction boot(){ fbq('consent','revoke'); }\nfunction other(){ return 1; }\n`
  const after = before.replace(declaration!, replacement!).replace("return 1", "return 2")
  const result = await turn(before, after)
  expect(result.text).toBe(before.replace("return 1", "return 2"))
  expect(result.warning.length).toBeGreaterThan(0)
})

it.each([
  ["JSX glob text", "export default function Page(){ return <p>Use src/* here</p>; }\n"],
  ["JSX double-star text", "export default function Page(){ return <code>pages/**</code>; }\n"],
  ["HTML style glob", "<style>.x { background:url(img/*.png) }</style>\n"],
])("raw consent after %s remains frozen despite tokenizer early exit", async (_name, prefix) => {
  const before = prefix + "fbq('consent','revoke');\n"
  expect((await turn(before, before.replace("revoke", "grant"))).text).toBe(before)
})

it.each([
  "window.fbq = () => {};",
  "function helper(){ (window as any).gtag = () => {}; }",
  "Object.defineProperty(window, 'gtag', { value: () => {} });",
  "declare const fbq: (...args: unknown[]) => void;",
  "delete window.fbq;",
  "const f = window.fbq;",
])("restores an added API write or alias anywhere: %s", async addition => {
  const before = "function boot(){ fbq('consent','revoke'); }\nfunction other(){ return 1; }\n"
  const result = await turn(before, before.replace("return 1", "return 2") + addition + "\n")
  expect(result.text).toBe(before.replace("return 1", "return 2"))
  expect(result.warning.length).toBeGreaterThan(0)
})

it.each(["const f = window.fbq;\nf('consent','revoke');\n", "fbq.apply(null, ['consent','revoke']);\n"])("freezes aliased consent arguments: %s", async before => {
  expect((await turn(before, before.replace("revoke", "grant"))).text).toBe(before)
})

it("keeps the API alias binding frozen beside an aliased consent call", async () => {
  const before = "const f = window.fbq;\nf('consent','revoke');\nfunction other(){ return 1; }\n"
  expect((await turn(before, before.replace("window.fbq", "() => {}").replace("return 1", "return 2"))).text).toBe(before.replace("return 1", "return 2"))
})

it("restores a deleted first frozen unit without duplicating a byte-order mark", async () => {
  const before = "\ufefffbq('consent','revoke');\nfunction other(){ return 1; }\n"
  expect((await turn(before, "\ufefffunction other(){ return 2; }\n")).text).toBe(before.replace("return 1", "return 2"))
})
