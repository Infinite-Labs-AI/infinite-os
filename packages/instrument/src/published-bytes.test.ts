// The functions infinite-tag serialises into customer pages with `Function.prototype.toString()` are
// tested everywhere else as VITEST-transformed source. Customers get the bytes `tsc` emits into `dist/`.
// This compiles the two serialised modules the way the package build does (the repo's ES2022 target,
// types erased) and runs what a customer's page would actually receive: the scrubber and the landing
// attribution script, built from the compiled functions, executed in the vm browser and compared with
// the source build (P3-7).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { createBrowserVm, plain } from "../test/site-code/browser-vm.js"
import { transpileLikeBuild } from "../test/site-code/typescript.js"

import { buildLandingAttributionScript } from "./attribution/capture.js"
import * as patterns from "./attribution/patterns.js"
import { infiniteUnsafeCampaign, infiniteUnsafeText } from "./conversions/scrub.js"
import * as consent from "./providers/meta-browser/consent.js"

const here = dirname(fileURLToPath(import.meta.url))

/** One source file compiled like `tsc -p tsconfig.build.json` (ES2022, types erased), as CommonJS to load here. */
function compiled(relativePath: string, modules: Record<string, unknown>): Record<string, unknown> {
  const output = transpileLikeBuild(readFileSync(join(here, relativePath), "utf8"))
  const exports: Record<string, unknown> = {}
  const require = (specifier: string) => {
    if (!(specifier in modules)) throw new Error(`unexpected import ${specifier}`)
    return modules[specifier]
  }
  runInNewContext(output, { exports, require, module: { exports } })
  return exports
}

const scrub = compiled("conversions/scrub.ts", {})
const capture = compiled("attribution/capture.ts", {
  "../conversions/scrub.js": scrub,
  "../providers/meta-browser/consent.js": consent,
  "./patterns.js": patterns
})

const CASES = [
  "spring_sale",
  "person@example.test",
  "person%2540example.test",
  "+1 (555) 123-4567",
  "https://private.example.test",
  "x gclid=SECRET",
  "0f8fad5b-d9cb-469f-a165-70867728950e",
  "launch_2026"
]

describe("the compiled (published) serialised bytes", () => {
  it("the scrubber's tsc bytes give the same verdicts as the source", () => {
    const vm = createBrowserVm()
    vm.runScript(String(scrub.UNSAFE_TEXT_SOURCE))
    expect(vm.scriptErrors).toEqual([])
    for (const value of CASES) {
      vm.window.__value = value
      expect(vm.evaluate("infiniteUnsafeText(window.__value)")).toBe(infiniteUnsafeText(value))
    }
  })

  it("the campaign rule's tsc bytes give the same verdicts as the source (W7c)", () => {
    const vm = createBrowserVm()
    vm.runScript(String(scrub.UNSAFE_CAMPAIGN_SOURCE))
    expect(vm.scriptErrors).toEqual([])
    for (const value of [...CASES, "120211234567890123", "spring_2026_10_03", "+1 415 555 0100", "2026-10-03"]) {
      vm.window.__value = value
      expect(vm.evaluate("infiniteUnsafeCampaign(window.__value)")).toBe(infiniteUnsafeCampaign(value))
    }
  })

  it("the landing attribution script built from tsc bytes records the same campaign as the source build", () => {
    const options = { ownHosts: ["acme.com"], gate: { kind: "none" as const } }
    const fromDist = (capture.buildLandingAttributionScript as typeof buildLandingAttributionScript)(options)
    const url = "https://acme.com/pricing?utm_source=newsletter&utm_term=jane%40example.com&ad_id=123&fbclid=X"
    const run = (script: string) => {
      const vm = createBrowserVm({ url, referrer: "https://facebook.com/x" })
      vm.runScript(script)
      expect(vm.scriptErrors).toEqual([])
      return { tab: vm.sessionValues.get(patterns.CAMPAIGN_KEY), cookie: vm.cookies.values(patterns.CAMPAIGN_KEY), campaign: plain(vm.evaluate("infiniteCampaign()")) }
    }
    const published = run(fromDist)
    expect(published).toEqual(run(buildLandingAttributionScript(options)))
    expect(published.cookie).toHaveLength(1)
    expect(published.campaign).toMatchObject({ campaignProvenance: "tab", utmSource: "newsletter", metaAdId: "123" })
  })

  it("negative: the comparison is real (a different landing gives a different record)", () => {
    const options = { ownHosts: ["acme.com"], gate: { kind: "none" as const } }
    const vm = createBrowserVm({ url: "https://acme.com/?utm_source=other" })
    vm.runScript((capture.buildLandingAttributionScript as typeof buildLandingAttributionScript)(options))
    expect(plain(vm.evaluate("infiniteCampaign()"))).toMatchObject({ utmSource: "other" })
  })
})
