import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runCli } from "./cli.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-cli-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

/** The most recent JSON document printed to stdout (for tests that run the CLI more than once). */
function lastStdoutJson(): string {
  const parseable = logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => {
      try {
        JSON.parse(m)
        return true
      } catch {
        return false
      }
    })
  return parseable[parseable.length - 1] ?? ""
}

describe("runCli", () => {
  it("apply without --yes returns 1 with approval message", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["apply", "--root", root, "--ga4-measurement-id", "G-TEST123"])
    expect(code).toBe(1)
    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderrMessages).toContain(
      "Founder approval is required. Re-run apply with --yes to continue."
    )
  })

  it("plan --json with unsupported fixture returns 1 with blockers in stdout JSON", async () => {
    const root = copyFixture("unsupported-basic")
    const code = await runCli(["plan", "--root", root, "--ga4-measurement-id", "G-TEST123", "--json"])
    expect(code).toBe(1)
    const logMessages = logSpy.mock.calls.map((c) => String(c[0]))
    const jsonOutput = logMessages.find((m: string) => {
      try {
        JSON.parse(m)
        return true
      } catch {
        return false
      }
    })
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.blockers).toBeDefined()
    expect(Array.isArray(parsed.blockers)).toBe(true)
    const blockerMessages = parsed.blockers.map((b: { message?: string } | string) =>
      typeof b === "string" ? b : b.message ?? JSON.stringify(b)
    )
    expect(
      blockerMessages.some((m: string) => m.includes("Unsupported repository shape for instrumentation."))
    ).toBe(true)
  })

  it("install --json end-to-end returns 0 with full result and files on disk", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_cli_test",
      "--yes",
      "--ga4-measurement-id", "G-TEST123",
      "--json"
    ])
    expect(code).toBe(0)

    const logMessages = logSpy.mock.calls.map((c) => String(c[0]))
    const jsonOutput = logMessages.find((m: string) => {
      try {
        JSON.parse(m)
        return true
      } catch {
        return false
      }
    })
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed).toHaveProperty("inspect")
    expect(parsed).toHaveProperty("plan")
    expect(parsed).toHaveProperty("apply")
    expect(parsed).toHaveProperty("verify")
    expect(parsed.verify.buildOk).toBe(true)

    const manifestPath = join(root, ".infinite/install.json")
    expect(existsSync(manifestPath)).toBe(true)

    const htmlPath = join(root, "index.html")
    const html = readFileSync(htmlPath, "utf8")
    expect(html).toContain("<!-- infinite:start -->")
  })

  it("uninstall --yes returns 0 and removes manifest and instrumentation from html", async () => {
    const root = copyFixture("static-html-basic")

    // First install
    const installCode = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_cli_test",
      "--yes",
      "--ga4-measurement-id", "G-TEST123"
    ])
    expect(installCode).toBe(0)

    logSpy.mockClear()
    errorSpy.mockClear()

    // Real uninstall
    const code = await runCli(["uninstall", "--root", root, "--yes", "--allow-dirty"])
    expect(code).toBe(0)

    const manifestPath = join(root, ".infinite/install.json")
    expect(existsSync(manifestPath)).toBe(false)

    const htmlPath = join(root, "index.html")
    const html = readFileSync(htmlPath, "utf8")
    expect(html).not.toContain("infinite:start")
  })
})

describe("Infinite source handoff + meta providers", () => {
  // Point discovery at an empty dir so a bare --workspace install can't pick up a
  // real saved artifacts file from the developer's home directory.
  let emptyArtifactsDir: string

  beforeEach(() => {
    emptyArtifactsDir = mkdtempSync(join(tmpdir(), "instrument-empty-artifacts-"))
    tempRoots.push(emptyArtifactsDir)
    process.env.INFINITE_ARTIFACTS_DIR = emptyArtifactsDir
  })

  afterEach(() => {
    delete process.env.INFINITE_ARTIFACTS_DIR
  })

  function indexHtml(root: string): string {
    return readFileSync(join(root, "index.html"), "utf8")
  }

  it("adds the Meta pixel only when --meta-pixel-id is given", async () => {
    const withMeta = copyFixture("static-html-basic")
    expect(
      await runCli([
        "install",
        "--root", withMeta,
        "--workspace", "ws_test",
        "--yes",
        "--meta-pixel-id", "1234567890123456"
      ])
    ).toBe(0)
    const metaHtml = indexHtml(withMeta)
    expect(metaHtml).toContain("connect.facebook.net/en_US/fbevents.js")
    expect(metaHtml).toContain("1234567890123456")

    const withoutMeta = copyFixture("static-html-basic")
    expect(
      await runCli([
        "install",
        "--root", withoutMeta,
        "--workspace", "ws_test",
        "--yes",
        "--ga4-measurement-id", "G-TEST123"
      ])
    ).toBe(0)
    expect(indexHtml(withoutMeta)).not.toContain("fbevents.js")
  })

  it("--infinite-allow-automation is hard-refused on a production host and installs nothing", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required",
      "--infinite-allow-automation"
    ])
    expect(code).toBe(1)
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("synthetic/test-only flag")
    expect(existsSync(join(root, ".infinite", "install.json"))).toBe(false)
  })

  it("blocks a PERSISTED artifact-file allowAutomation:true on a production host (no CLI flag involved)", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "infinite-artifact.json"),
      JSON.stringify({
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/ledger",
          productionHosts: ["example.com"],
          consentMode: "not_required",
          staticProxy: "vercel",
          allowAutomation: true
        }
      })
    )
    const code = await runCli(["plan", "--root", root, "--artifact-file", "infinite-artifact.json", "--json"])
    expect(code).toBe(1)
    const jsonOutput = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m: string) => {
        try {
          return typeof JSON.parse(m) === "object"
        } catch {
          return false
        }
      })
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.blockers.some((b: string) => /synthetic\/test-only flag/.test(b))).toBe(true)
  })

  it("hard-blocks a malformed source key or production host", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "plan",
      "--root", root,
      "--workspace", "ws_test",
      "--infinite-site-source-key", "bad key",
      "--infinite-production-host", "https://evil.example/path",
      "--infinite-static-proxy", "vercel",
      "--json"
    ])
    expect(code).toBe(1)
    const logMessages = logSpy.mock.calls.map((c) => String(c[0]))
    const jsonOutput = logMessages.find((m: string) => {
      try {
        JSON.parse(m)
        return true
      } catch {
        return false
      }
    })
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.blockers.some((b: string) => b.includes("siteSourceKey"))).toBe(true)
    expect(parsed.blockers.some((b: string) => b.includes("production host"))).toBe(true)
  })
})

describe("default artifact discovery", () => {
  let artifactsDir: string

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), "instrument-artifacts-dir-"))
    tempRoots.push(artifactsDir)
    process.env.INFINITE_ARTIFACTS_DIR = artifactsDir
  })

  afterEach(() => {
    delete process.env.INFINITE_ARTIFACTS_DIR
  })

  function saveArtifactsFile(name: string, payload: unknown): string {
    const filePath = join(artifactsDir, name)
    writeFileSync(filePath, typeof payload === "string" ? payload : JSON.stringify(payload))
    return filePath
  }

  function stderrText(): string {
    return errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
  }

  function stdoutJson(): Record<string, unknown> {
    const logMessages = logSpy.mock.calls.map((c) => String(c[0]))
    const jsonOutput = logMessages.find((m: string) => {
      try {
        JSON.parse(m)
        return true
      } catch {
        return false
      }
    })
    expect(jsonOutput).toBeDefined()
    return JSON.parse(jsonOutput!)
  }

  it("multiple saved files without --workspace are listed and never guessed", async () => {
    const root = copyFixture("static-html-basic")
    saveArtifactsFile("ws_a.json", { workspaceId: "ws_a", ga4: { measurementId: "G-AAAA111" } })
    saveArtifactsFile("ws_b.json", { workspaceId: "ws_b", ga4: { measurementId: "G-BBBB222" } })

    const code = await runCli(["plan", "--root", root, "--json"])

    expect(code).toBe(1)
    expect(stderrText()).toContain("ws_a.json")
    expect(stderrText()).toContain("ws_b.json")
    expect(stderrText()).toContain("--workspace")
    expect(stdoutJson().blockers).toContain("No supported public install artifacts were provided.")
  })
})

describe("posthog reverse proxy (--posthog-proxy / --posthog-ui-host)", () => {
  // Isolate discovery so a bare --posthog-proxy run can't pick up a real saved artifacts file.
  let emptyArtifactsDir: string

  beforeEach(() => {
    emptyArtifactsDir = mkdtempSync(join(tmpdir(), "instrument-empty-proxy-"))
    tempRoots.push(emptyArtifactsDir)
    process.env.INFINITE_ARTIFACTS_DIR = emptyArtifactsDir
  })

  afterEach(() => {
    delete process.env.INFINITE_ARTIFACTS_DIR
  })

  it("serves PostHog via a first-party /ingest proxy and writes vercel.json rewrites", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_proxy",
      "--yes",
      "--posthog-project-key", "phc_abcDEF0123456789xyz",
      "--posthog-api-host", "https://us.i.posthog.com",
      "--posthog-proxy"
    ])
    expect(code).toBe(0)

    const html = readFileSync(join(root, "index.html"), "utf8")
    expect(html).toContain('api_host: "/ingest"')
    expect(html).toContain('ui_host: "https://us.posthog.com"')

    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.rewrites).toEqual([
      { source: "/ingest/static/:path(.*)", destination: "https://us-assets.i.posthog.com/static/:path" },
      { source: "/ingest/array/:path(.*)", destination: "https://us-assets.i.posthog.com/array/:path" },
      { source: "/ingest/:path(.*)", destination: "https://us.i.posthog.com/:path" }
    ])

    const manifest = JSON.parse(readFileSync(join(root, ".infinite/install.json"), "utf8"))
    expect(manifest.files).toContain("vercel.json")
  })

  it("uninstall removes the created vercel.json", async () => {
    const root = copyFixture("static-html-basic")
    await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_proxy",
      "--yes",
      "--posthog-project-key", "phc_abcDEF0123456789xyz",
      "--posthog-api-host", "https://us.i.posthog.com",
      "--posthog-proxy"
    ])
    expect(existsSync(join(root, "vercel.json"))).toBe(true)

    const code = await runCli(["uninstall", "--root", root, "--yes", "--allow-dirty"])
    expect(code).toBe(0)
    expect(existsSync(join(root, "vercel.json"))).toBe(false)
  })

  describe("manual-required install (pixel not yet live) — exit code + json", () => {
    // The ONLY path that now reaches the exit-2 / requires_manual machinery: an index.html with no
    // </head> to inject into. main.tsx is never consulted.
    function manualVite(): string {
      const root = copyFixture("vite-react-basic")
      writeFileSync(join(root, "index.html"), '<html><body><div id="root"></div></body></html>\n')
      return root
    }

    const flags = (root: string): string[] => [
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--json",
      "--allow-dirty",
      "--ga4-measurement-id", "G-TEST123"
    ]

    it("install --yes --json exits 2 (needs_action), not 0, and reports requiresManual in the json", async () => {
      const root = manualVite()
      const code = await runCli(["install", ...flags(root)])
      expect(code).toBe(2)
      const result = JSON.parse(lastStdoutJson()) as {
        requiresManual?: Array<{ path: string; reason: string; snippet: string }>
      }
      expect(result.requiresManual?.[0]?.path).toBe("index.html")
      expect(result.requiresManual?.[0]?.snippet).toContain("<!-- infinite:start -->")
    })

    it("verify CLEARS to exit 0 once the user actually adds the block to index.html (BLOCKER 1)", async () => {
      const root = manualVite()
      expect(await runCli(["install", ...flags(root)])).toBe(2)
      const installed = JSON.parse(lastStdoutJson()) as { requiresManual?: Array<{ snippet: string }> }
      const block = installed.requiresManual![0]!.snippet
      // The user pastes the exact managed <script> block into index.html by hand.
      writeFileSync(join(root, "index.html"), `<html><head>\n${block}\n</head><body></body></html>\n`)

      const code = await runCli(["verify", "--root", root, "--json"])
      expect(code).toBe(0)
      const result = JSON.parse(lastStdoutJson()) as { buildOk: boolean; requiresManual?: unknown[] }
      expect(result.buildOk).toBe(true)
      expect(result.requiresManual ?? []).toEqual([])
    })
  })
})
