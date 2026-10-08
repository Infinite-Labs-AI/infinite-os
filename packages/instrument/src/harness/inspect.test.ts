import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { detectUnmanagedProviders } from "../inspect.js"
import {
  classifyProviders,
  detectProvidersWithEvidence,
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

describe("detectProvidersWithEvidence", () => {
  it.each([
    `if (window.gtag) window.gtag('event', 'download'); fbq('track', 'Lead'); twq('event', 'abc'); posthog.capture('click')`,
  ])("ignores event-only calls and documentation in both detectors: %s", (source) => {
    const root = copyFixture("static-html-basic")
    write(root, "example.html", source)
    expect(detectUnmanagedProviders(root)).toEqual([])
    expect(detectProvidersWithEvidence(root)).toEqual([])
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
})

describe("resolveHarnessKeys", () => {
  it("never adopts a .env Meta pixel id Meta could not have issued (not 15-16 digits)", () => {
    for (const value of ["999888777", "12345678901234", "12345678901234567"]) {
      const resolved = resolveHarnessKeys({
        flags: {},
        explicitFlags: false,
        discovered: null,
        env: { metaPixelId: { value, file: ".env" } },
        detected: []
      })
      expect(resolved.artifacts.meta).toBeUndefined()
    }
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

