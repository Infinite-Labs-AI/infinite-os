import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { planInstallation } from "./plan.js"
import {
  allowAutomationTargetError,
  applyInfiniteAllowAutomation,
  applyInfiniteApiOrigin,
  applyInfiniteAutocapture,
  applyPosthogProxy,
  INFINITE_ALLOW_AUTOMATION_NO_SOURCE_ERROR,
  isNonProductionAutomationHost,
  DEFAULT_INFINITE_COLLECT_PATH,
  DEFAULT_POSTHOG_PROXY_PATH,
  discoverWorkspaceArtifacts,
  INFINITE_API_ORIGIN,
  infiniteCollectDestination,
  infiniteProxySpec,
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

  it("flags override values from the artifact file", () => {
    const root = makeTempDir("flags-override")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({
        ga4: { measurementId: "G-FILE" },
        posthog: { projectKey: "phc_file", apiHost: "https://file.example" }
      })
    )

    const result = resolveWorkspaceArtifacts(root, {
      artifactFile,
      ga4MeasurementId: "G-FLAG",
      posthogProjectKey: "phc_flag"
    })

    expect(result.ga4?.measurementId).toBe("G-FLAG")
    expect(result.posthog?.projectKey).toBe("phc_flag")
    expect(result.posthog?.apiHost).toBe("https://file.example")
  })

  it("throws when the artifact file is missing", () => {
    const root = makeTempDir("missing-file")
    expect(() =>
      resolveWorkspaceArtifacts(root, { artifactFile: "nope.json" })
    ).toThrow(/Artifact file not found/)
  })

  it("resolves both relative and absolute artifactFile paths", () => {
    const root = makeTempDir("rel-vs-abs")
    const fileName = "artifacts.json"
    const absolutePath = join(root, fileName)
    writeFileSync(
      absolutePath,
      JSON.stringify({ ga4: { measurementId: "G-ABS" } })
    )

    const fromRelative = resolveWorkspaceArtifacts(root, { artifactFile: fileName })
    const fromAbsolute = resolveWorkspaceArtifacts(root, { artifactFile: absolutePath })

    expect(fromRelative).toEqual({ ga4: { measurementId: "G-ABS" } })
    expect(fromAbsolute).toEqual({ ga4: { measurementId: "G-ABS" } })
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

  it("reads a Meta pixel id from a flag and from an artifact file", () => {
    const fromFlag = resolveWorkspaceArtifacts(".", { metaPixelId: "1234567890123456" })
    expect(fromFlag.meta).toEqual({ pixelId: "1234567890123456" })

    const root = makeTempDir("meta-file")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(artifactFile, JSON.stringify({ meta: { pixelId: "9876543210" } }))
    const fromFile = resolveWorkspaceArtifacts(root, { artifactFile })
    expect(fromFile.meta).toEqual({ pixelId: "9876543210" })
  })

  it("partial x artifacts (only eventTagIds) surface a pixelId blocker and refuse to apply", () => {
    const artifacts = resolveWorkspaceArtifacts(".", {
      xEventTagIds: ["tw-event-1"]
    })

    expect(artifacts.x?.pixelId).toBe("")

    const root = copyFixture("static-html-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts
    })

    expect(plan.blockers).toContain(
      "X requires a public pixelId before planning can continue."
    )
    expect(() =>
      applyInstallation({ root, workspaceId: "ws_test", plan })
    ).toThrow(/Refusing to apply/)
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

  it("returns null when the artifacts directory does not exist", () => {
    process.env.INFINITE_ARTIFACTS_DIR = join(makeTempDir("missing-dir"), "absent")
    expect(discoverWorkspaceArtifacts({})).toBeNull()
  })

  it("refuses path-hostile workspace ids instead of reading outside the artifacts dir", () => {
    const dir = makeTempDir("hostile")
    process.env.INFINITE_ARTIFACTS_DIR = dir
    writeFileSync(join(dir, "ws_ok.json"), JSON.stringify({ ga4: { measurementId: "G-OK1" } }))

    for (const hostile of ["../ws_ok", "a/b", "a\\b", "..", ""]) {
      expect(discoverWorkspaceArtifacts({ workspaceId: hostile })).toBeNull()
    }
  })

  it("adopts the workspace id from the file content, falling back to the file name", () => {
    const dir = makeTempDir("adopt")
    process.env.INFINITE_ARTIFACTS_DIR = dir
    writeFileSync(join(dir, "ws_file.json"), JSON.stringify({ ga4: { measurementId: "G-OK1" } }))

    const discovered = discoverWorkspaceArtifacts({})

    expect(discovered?.workspaceId).toBe("ws_file")
    expect(discovered?.providers).toEqual(["ga4"])
    expect(discovered?.artifacts).toEqual({ ga4: { measurementId: "G-OK1" } })
  })

  it("prefers the workspace id recorded inside the file over the file name", () => {
    const dir = makeTempDir("adopt-content")
    process.env.INFINITE_ARTIFACTS_DIR = dir
    writeFileSync(
      join(dir, "renamed.json"),
      JSON.stringify({ workspaceId: "ws_content", ga4: { measurementId: "G-OK1" } })
    )

    expect(discoverWorkspaceArtifacts({})?.workspaceId).toBe("ws_content")
  })

  it("ignores a saved file with no usable artifacts and warns", () => {
    const dir = makeTempDir("empty-artifacts")
    process.env.INFINITE_ARTIFACTS_DIR = dir
    writeFileSync(join(dir, "ws_empty.json"), JSON.stringify({ workspaceId: "ws_empty" }))
    const warnings: string[] = []

    expect(discoverWorkspaceArtifacts({ warn: (message) => warnings.push(message) })).toBeNull()
    expect(warnings.join("\n")).toContain("no usable public artifacts")
  })

  it("treats a Meta-only saved file as usable", () => {
    const dir = makeTempDir("meta-only")
    process.env.INFINITE_ARTIFACTS_DIR = dir
    writeFileSync(
      join(dir, "ws_meta.json"),
      JSON.stringify({ workspaceId: "ws_meta", meta: { pixelId: "1234567890" } })
    )

    const discovered = discoverWorkspaceArtifacts({})
    expect(discovered?.providers).toEqual(["meta"])
    expect(discovered?.artifacts.meta).toEqual({ pixelId: "1234567890" })
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

  it("builds the same shape from explicit public flags", () => {
    expect(
      resolveWorkspaceArtifacts(".", {
        infiniteSiteSourceKey: "site_public_123",
        infiniteCollectPath: "/infinite/events/collect",
        infiniteProductionHosts: ["Example.com", "www.example.com"],
        infiniteStaticProxy: "vercel",
        infiniteConsentMode: "not_required",
        infiniteDownloadDestinationPath: "/checkout"
      }).infinite
    ).toEqual({
      siteSourceKey: "site_public_123",
      collectPath: "/infinite/events/collect",
      productionHosts: ["Example.com", "www.example.com"],
      staticProxy: "vercel",
      consentMode: "not_required",
      downloadDestinationPath: "/checkout"
    })
  })

  it("does not fabricate an Infinite credential from a workspace id", () => {
    const artifacts = resolveWorkspaceArtifacts(".", { ga4MeasurementId: "G-ACME123" })
    expect(artifacts.infinite).toBeUndefined()
  })

  it("keeps explicit top-level production hosts without fabricating an Infinite source", () => {
    const artifacts = resolveWorkspaceArtifacts(".", {
      ga4MeasurementId: "G-ACME123",
      infiniteProductionHosts: ["example.com"]
    })

    expect(artifacts.infinite).toBeUndefined()
    expect(artifacts.productionHosts).toEqual(["example.com"])
  })

  it("reads top-level production hosts from the public handoff file", () => {
    const root = makeTempDir("top-level-host-file")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({
        productionHosts: ["example.com"],
        ga4: { measurementId: "G-ACME123" }
      })
    )

    expect(resolveWorkspaceArtifacts(root, { artifactFile })).toEqual({
      productionHosts: ["example.com"],
      ga4: { measurementId: "G-ACME123" }
    })
  })
})

describe("applyPosthogProxy", () => {
  it("layers the /ingest proxy onto a posthog artifact, deriving US hosts by default", () => {
    const result = applyPosthogProxy(
      { posthog: { projectKey: "phc_x", apiHost: "https://us.i.posthog.com" } },
      { proxy: true }
    )
    expect(result.posthog).toEqual({
      projectKey: "phc_x",
      apiHost: DEFAULT_POSTHOG_PROXY_PATH,
      uiHost: "https://us.posthog.com",
      proxy: {
        path: DEFAULT_POSTHOG_PROXY_PATH,
        assetsHost: "https://us-assets.i.posthog.com",
        ingestHost: "https://us.i.posthog.com"
      }
    })
  })

  it("derives EU hosts from an eu apiHost and honours an explicit --posthog-ui-host override", () => {
    const result = applyPosthogProxy(
      { posthog: { projectKey: "phc_x", apiHost: "https://eu.i.posthog.com" } },
      { proxy: true, uiHost: "https://my.posthog.example" }
    )
    expect(result.posthog?.uiHost).toBe("https://my.posthog.example")
    expect(result.posthog?.proxy).toEqual({
      path: DEFAULT_POSTHOG_PROXY_PATH,
      assetsHost: "https://eu-assets.i.posthog.com",
      ingestHost: "https://eu.i.posthog.com"
    })
  })

  it("is a no-op without the proxy flag", () => {
    const withKey = { posthog: { projectKey: "phc_x", apiHost: "https://us.i.posthog.com" } }
    expect(applyPosthogProxy(withKey, { proxy: false })).toEqual(withKey)
  })

  it("never fabricates a posthog artifact when there is none (no project key)", () => {
    const onlyGa4 = { ga4: { measurementId: "G-X" } }
    const result = applyPosthogProxy(onlyGa4, { proxy: true })
    expect(result).toEqual(onlyGa4)
    expect(result.posthog).toBeUndefined()
  })
})

describe("Infinite API origin + default collect path", () => {
  it("defaults the same-origin collect path to /infinite/ledger", () => {
    expect(DEFAULT_INFINITE_COLLECT_PATH).toBe("/infinite/ledger")
  })

  it("resolves the default origin when neither flag nor env is set", () => {
    expect(resolveInfiniteApiOrigin({})).toBe("https://api.ultima.inc")
    expect(resolveInfiniteApiOrigin({ env: {} })).toBe(INFINITE_API_ORIGIN)
  })

  it("reads INFINITE_API_ORIGIN from the env", () => {
    expect(
      resolveInfiniteApiOrigin({ env: { INFINITE_API_ORIGIN: "https://api.infinite.fast" } })
    ).toBe("https://api.infinite.fast")
  })

  it("lets the flag beat the env", () => {
    expect(
      resolveInfiniteApiOrigin({
        flag: "https://flag.example",
        env: { INFINITE_API_ORIGIN: "https://env.example" }
      })
    ).toBe("https://flag.example")
  })

  it("strips a trailing slash and ignores a blank env value", () => {
    expect(resolveInfiniteApiOrigin({ flag: "https://api.infinite.fast/" })).toBe(
      "https://api.infinite.fast"
    )
    expect(resolveInfiniteApiOrigin({ env: { INFINITE_API_ORIGIN: "   " } })).toBe(INFINITE_API_ORIGIN)
  })

  it.each([
    ["a path", "https://x.test/path"],
    ["a query", "https://x.test/?a=1"],
    ["http", "http://x.test"],
    ["credentials", "https://user:pw@x.test"],
    ["garbage", "not a url"]
  ])("rejects %s with the documented error", (_label, flag) => {
    expect(() => resolveInfiniteApiOrigin({ flag })).toThrow(
      "--infinite-api-origin must be an https origin with no path"
    )
  })

  it("derives the collect destination from the origin", () => {
    expect(infiniteCollectDestination("https://api.infinite.fast")).toBe(
      "https://api.infinite.fast/api/analytics/events/collect"
    )
  })

  it("threads --infinite-api-origin into the Infinite artifact as apiOrigin", () => {
    const artifacts = resolveWorkspaceArtifacts(".", {
      infiniteSiteSourceKey: "site_public_123",
      infiniteProductionHosts: ["example.com"],
      infiniteConsentMode: "not_required",
      infiniteApiOrigin: "https://api.infinite.fast"
    })
    expect(artifacts.infinite).toEqual({
      siteSourceKey: "site_public_123",
      collectPath: "/infinite/ledger",
      productionHosts: ["example.com"],
      consentMode: "not_required",
      apiOrigin: "https://api.infinite.fast"
    })
    expect(infiniteProxySpec(artifacts.infinite)).toEqual({
      path: "/infinite/ledger",
      destination: "https://api.infinite.fast/api/analytics/events/collect"
    })
  })

  it("keeps the recorded collect path of an existing artifact file (no silent migration)", () => {
    const root = makeTempDir("legacy-collect-path")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/events/collect",
          productionHosts: ["example.com"],
          consentMode: "not_required"
        }
      })
    )
    const artifacts = resolveWorkspaceArtifacts(root, { artifactFile })
    expect(artifacts.infinite?.collectPath).toBe("/infinite/events/collect")
    expect(artifacts.infinite?.apiOrigin).toBeUndefined()
    expect(infiniteProxySpec(artifacts.infinite)).toEqual({
      path: "/infinite/events/collect",
      destination: "https://api.ultima.inc/api/analytics/events/collect"
    })
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

describe("Infinite autocapture flag", () => {
  it("threads infiniteAutocapture:false into the artifact and keeps the key absent otherwise", () => {
    const off = resolveWorkspaceArtifacts(".", {
      infiniteSiteSourceKey: "site_public_123",
      infiniteProductionHosts: ["example.com"],
      infiniteConsentMode: "not_required",
      infiniteAutocapture: false
    })
    expect(off.infinite?.autocapture).toBe(false)

    const unspecified = resolveWorkspaceArtifacts(".", {
      infiniteSiteSourceKey: "site_public_123",
      infiniteProductionHosts: ["example.com"],
      infiniteConsentMode: "not_required"
    })
    expect(unspecified.infinite).not.toHaveProperty("autocapture")
  })

  it("reads a boolean autocapture from an artifact file and ignores non-booleans", () => {
    const root = makeTempDir("autocapture-file")
    const artifactFile = join(root, "artifacts.json")
    writeFileSync(
      artifactFile,
      JSON.stringify({
        infinite: {
          siteSourceKey: "site_public_123",
          productionHosts: ["example.com"],
          consentMode: "not_required",
          autocapture: false
        }
      })
    )
    expect(resolveWorkspaceArtifacts(root, { artifactFile }).infinite?.autocapture).toBe(false)

    writeFileSync(
      artifactFile,
      JSON.stringify({
        infinite: { siteSourceKey: "site_public_123", productionHosts: ["example.com"], autocapture: "off" }
      })
    )
    expect(resolveWorkspaceArtifacts(root, { artifactFile }).infinite).not.toHaveProperty("autocapture")
  })

  it("applyInfiniteAutocapture is a modifier: layers onto an Infinite artifact, never fabricates one", () => {
    const layered = applyInfiniteAutocapture(
      {
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/ledger",
          productionHosts: ["example.com"],
          consentMode: "not_required"
        }
      },
      { autocapture: false }
    )
    expect(layered.infinite?.autocapture).toBe(false)
    expect(applyInfiniteAutocapture({ ga4: { measurementId: "G-1" } }, { autocapture: false }).infinite).toBeUndefined()
    const untouched = { infinite: layered.infinite! }
    expect(applyInfiniteAutocapture(untouched, {})).toBe(untouched)
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

  it("classifies loopback / sandbox / local hosts as non-production, real hosts as production", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "my.local", "app.test", "1bu-1-dev2-sandbox.vercel.app"]) {
      expect(isNonProductionAutomationHost(host), host).toBe(true)
    }
    for (const host of ["example.com", "grandlumber.com", "www.acme.io"]) {
      expect(isNonProductionAutomationHost(host), host).toBe(false)
    }
  })

  it("allowAutomationTargetError refuses a production host and passes a sandbox host", () => {
    expect(allowAutomationTargetError(["example.com"])).toContain("PRODUCTION host")
    expect(allowAutomationTargetError(["localhost"])).toBeNull()
    expect(allowAutomationTargetError([])).toContain("at least one configured production host")
  })

  it("sets allowAutomation:true on a sandbox source and is a no-op when off", () => {
    expect(applyInfiniteAllowAutomation(sandbox, { allowAutomation: true }).infinite?.allowAutomation).toBe(true)
    expect(applyInfiniteAllowAutomation(sandbox, { allowAutomation: false })).toEqual(sandbox)
    expect(applyInfiniteAllowAutomation(sandbox, {})).toEqual(sandbox)
  })

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
