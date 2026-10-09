import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { planInstallation } from "./plan.js"
import {
  applyInfiniteAllowAutomation,
  applyInfiniteApiOrigin,
  applyPosthogProxy,
  INFINITE_ALLOW_AUTOMATION_NO_SOURCE_ERROR,
  DEFAULT_INFINITE_COLLECT_PATH,
  discoverWorkspaceArtifacts,
  resolveInfiniteApiOrigin,
  resolveWorkspaceArtifacts
} from "./workspace-artifacts.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `instrument-artifacts-${prefix}-`))
  tempRoots.push(dir)
  return dir
}

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-artifacts-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("resolveWorkspaceArtifacts", () => {
  it("reads artifacts from a JSON file when only artifactFile is given", () => {
    const root = makeTempDir("file-only")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({
        ga4: { measurementId: "G-FILE" },
        posthog: { projectKey: "phc_file", apiHost: "https://file.example" }
      })
    )

    const result = resolveWorkspaceArtifacts(root, { artifactFile })

    expect(result).toEqual({
      ga4: { measurementId: "G-FILE" },
      posthog: { projectKey: "phc_file", apiHost: "https://file.example" }
    })
  })

  it("partial posthog artifacts (only apiHost) surface a projectKey blocker and refuse to apply", () => {
    const artifacts = resolveWorkspaceArtifacts(".", {
      posthogApiHost: "https://x.example"
    })

    expect(artifacts.posthog?.projectKey).toBe("")

    const root = copyFixture("static-html-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts
    })

    expect(plan.blockers).toContain(
      "PostHog requires a public projectKey before planning can continue."
    )
    expect(() =>
      applyInstallation({ root, workspaceId: "ws_test", plan })
    ).toThrow(/Refusing to apply/)
  })

  it("leaves Manual Advanced Matching OFF unless the customer asks, and takes only a real boolean", () => {
    // Off is the DEFAULT and it is recorded as ABSENT, not as `false`: the installed snippet then
    // has no accessor at all rather than a disabled one. This flag decides whether a customer's
    // visitors' hashed contact details go to Meta, so it is unambiguous or it is nothing.
    expect(resolveWorkspaceArtifacts(".", { metaPixelId: "1234567890123456" }).meta).toEqual({
      pixelId: "1234567890123456"
    })
    expect(
      resolveWorkspaceArtifacts(".", {
        metaPixelId: "1234567890123456",
        metaAdvancedMatching: false
      }).meta
    ).toEqual({ pixelId: "1234567890123456" })
    expect(
      resolveWorkspaceArtifacts(".", {
        metaPixelId: "1234567890123456",
        metaAdvancedMatching: true
      }).meta
    ).toEqual({ pixelId: "1234567890123456", advancedMatching: true })

    // A modifier, never a source: with no Meta pixel there is nothing to attach identity to.
    expect(resolveWorkspaceArtifacts(".", { metaAdvancedMatching: true }).meta).toBeUndefined()

    const root = makeTempDir("meta-advanced-matching-file")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({ meta: { pixelId: "9876543210987654", advancedMatching: "on" } })
    )
    expect(resolveWorkspaceArtifacts(root, { artifactFile }).meta).toEqual({ pixelId: "9876543210987654" })

    const optedIn = join(root, "opted-in.json")
    writeFileSync(optedIn, JSON.stringify({ meta: { pixelId: "9876543210987654", advancedMatching: true } }))
    expect(resolveWorkspaceArtifacts(root, { artifactFile: optedIn }).meta).toEqual({
      pixelId: "9876543210987654",
      advancedMatching: true
    })
    // An explicit `off` turns a saved opt-in back off — which is what asking to stop means.
    expect(
      resolveWorkspaceArtifacts(root, { artifactFile: optedIn, metaAdvancedMatching: false }).meta
    ).toEqual({ pixelId: "9876543210987654" })
  })
})

describe("discoverWorkspaceArtifacts", () => {
  let savedEnvDir: string | undefined

  beforeEach(() => {
    savedEnvDir = process.env.INFINITE_ARTIFACTS_DIR
  })

  afterEach(() => {
    if (savedEnvDir === undefined) {
      delete process.env.INFINITE_ARTIFACTS_DIR
    } else {
      process.env.INFINITE_ARTIFACTS_DIR = savedEnvDir
    }
  })

  it("refuses path-hostile workspace ids instead of reading outside the artifacts dir", () => {
    const dir = makeTempDir("hostile")
    process.env.INFINITE_ARTIFACTS_DIR = dir
    writeFileSync(join(dir, "ws_ok.json"), JSON.stringify({ ga4: { measurementId: "G-OK1" } }))

    for (const hostile of ["../ws_ok", "a/b", "a\\b", "..", ""]) {
      expect(discoverWorkspaceArtifacts({ workspaceId: hostile })).toBeNull()
    }
  })
})

describe("Infinite public artifacts", () => {
  it("accepts the one browser-safe shape from an artifact file", () => {
    const root = makeTempDir("infinite-file")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({
        workspaceId: "ws_x",
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/events/collect",
          productionHosts: ["www.example.com", "example.com"],
          staticProxy: "vercel",
          consentMode: "not_required",
          downloadDestinationPath: "/checkout",
          cloudSession: "must-not-survive"
        }
      })
    )

    expect(resolveWorkspaceArtifacts(root, { artifactFile }).infinite).toEqual({
      siteSourceKey: "site_public_123",
      collectPath: "/infinite/events/collect",
      productionHosts: ["www.example.com", "example.com"],
      staticProxy: "vercel",
      consentMode: "not_required",
      downloadDestinationPath: "/checkout"
    })
  })

  it("does not fabricate an Infinite credential from a workspace id", () => {
    const artifacts = resolveWorkspaceArtifacts(".", { ga4MeasurementId: "G-ACME123" })
    expect(artifacts.infinite).toBeUndefined()
  })
})

describe("applyPosthogProxy", () => {
  it("never fabricates a posthog artifact when there is none (no project key)", () => {
    const onlyGa4 = { ga4: { measurementId: "G-X" } }
    const result = applyPosthogProxy(onlyGa4, { proxy: true })
    expect(result).toEqual(onlyGa4)
    expect(result.posthog).toBeUndefined()
  })
})

describe("Infinite API origin + default collect path", () => {
  it.each([
    ["a path", "https://x.test/path"],
    ["credentials", "https://user:pw@x.test"],
  ])("rejects %s with the documented error", (_label, flag) => {
    expect(() => resolveInfiniteApiOrigin({ flag })).toThrow(
      "--infinite-api-origin must be an https origin with no path"
    )
  })

  it("applyInfiniteApiOrigin layers onto a discovered Infinite artifact and never fabricates one", () => {
    const withInfinite = applyInfiniteApiOrigin(
      {
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/ledger",
          productionHosts: ["example.com"],
          consentMode: "not_required"
        }
      },
      { origin: "https://api.infinite.fast" }
    )
    expect(withInfinite.infinite?.apiOrigin).toBe("https://api.infinite.fast")

    const without = applyInfiniteApiOrigin({ ga4: { measurementId: "G-1" } }, { origin: "https://api.infinite.fast" })
    expect(without.infinite).toBeUndefined()
  })
})

describe("applyInfiniteAllowAutomation (synthetic/test-only safety gate)", () => {
  const sandbox = {
    infinite: {
      siteSourceKey: "site_public_123",
      collectPath: DEFAULT_INFINITE_COLLECT_PATH,
      productionHosts: ["localhost"]
    }
  }

  it("throws on a production host and when there is no Infinite source", () => {
    expect(() =>
      applyInfiniteAllowAutomation(
        { infinite: { siteSourceKey: "site_x", collectPath: "/i", productionHosts: ["example.com"] } },
        { allowAutomation: true }
      )
    ).toThrow(/synthetic\/test-only flag/)
    expect(() => applyInfiniteAllowAutomation({ ga4: { measurementId: "G-1" } }, { allowAutomation: true })).toThrow(
      INFINITE_ALLOW_AUTOMATION_NO_SOURCE_ERROR
    )
  })
})
