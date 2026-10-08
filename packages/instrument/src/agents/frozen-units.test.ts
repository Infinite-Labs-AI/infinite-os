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
    ["return before call", module.replace(plain, `  return;\n${plain}`)],
    ["shadowing parameter", module.replace("startMeta()", "startMeta(fbq)")],
    ["optional revoke change", module.replace(option, option.replace("revoke", "grant"))],
    ["remove the site's own gate", module.replace("  if (readTrackingConsent() === 'granted') {\n", "").replace("  }\n}\nexport function startMeta", "}\nexport function startMeta")],
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

  it("freezes a recognized map while keeping separate readers editable", async () => {
    const before = "const GRANTED_MODE = { analytics_storage: 'granted' };\nfunction readTrackingMode() { return GRANTED_MODE; }\nfunction unrelated() { return 1; }\n"
    const result = await turn(before, before.replace("analytics_storage: 'granted'", "analytics_storage: 'denied'").replace("return GRANTED_MODE", "return {}").replace("return 1", "return 2"))
    expect(result.text).toBe(before.replace("return GRANTED_MODE", "return {}").replace("return 1", "return 2"))
  })

  it("an uncertain split freezes the whole consent-bearing file", async () => {
    const before = "<unknown-syntax>\nfbq?.('consent','revoke');\nexport const other = 1;\n"
    expect((await turn(before, before.replace("other = 1", "other = 2"))).text).toBe(before)
  })
})

it.each([
  "window.fbq = () => {};",
])("allows an API write or alias outside the recognized-call unit: %s", async addition => {
  const before = "function boot(){ fbq('consent','revoke'); }\nfunction other(){ return 1; }\n"
  const after = before.replace("return 1", "return 2") + addition + "\n"
  const result = await turn(before, after)
  expect(result.text).toBe(after)
  expect(result.warning).toEqual([])
})

it.each(["const f = window.fbq;\nf('consent','revoke');\n",])("freezes aliased consent arguments: %s", async before => {
  expect((await turn(before, before.replace("revoke", "grant"))).text).toBe(before)
})

