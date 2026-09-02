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

function stdoutText(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

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

  it("apply --yes without --workspace returns 1 with workspace message", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["apply", "--yes", "--root", root, "--ga4-measurement-id", "G-TEST123"])
    expect(code).toBe(1)
    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderrMessages).toContain("apply requires --workspace <workspace-id>.")
  })

  it("unknown argument returns 1 with usage message", async () => {
    const code = await runCli(["plan", "--bogus"])
    expect(code).toBe(1)
    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderrMessages).toContain(
      "Unknown argument: --bogus. Run infinite-tag help for usage."
    )
  })

  it("missing flag value returns 1 with missing value message", async () => {
    const code = await runCli(["plan", "--root"])
    expect(code).toBe(1)
    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderrMessages).toContain("Missing value for --root.")
  })

  it("bad package manager returns 1 with unsupported message", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["plan", "--root", root, "--package-manager", "deno"])
    expect(code).toBe(1)
    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderrMessages).toContain("Unsupported package manager override: deno")
  })

  it("missing artifact file returns 1 with clean message and does not throw", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["plan", "--root", root, "--artifact-file", "does-not-exist.json"])
    expect(code).toBe(1)
    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    const errorMessage = stderrMessages.find((m: string) => m.startsWith("Artifact file not found:"))
    expect(errorMessage).toBeDefined()
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

  it("uninstall dry run returns 0 with dry-run message and manifest still on disk", async () => {
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

    // Reset spies for the uninstall call
    logSpy.mockClear()
    errorSpy.mockClear()

    // Dry run uninstall (no --yes)
    const code = await runCli(["uninstall", "--root", root])
    expect(code).toBe(0)

    const stderrMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderrMessages).toContain(
      "Dry run only. Re-run uninstall with --yes to remove the managed install."
    )

    const manifestPath = join(root, ".infinite/install.json")
    expect(existsSync(manifestPath)).toBe(true)
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

  it("help returns 0 and usage line contains uninstall", async () => {
    const code = await runCli(["help"])
    expect(code).toBe(0)
    const logMessages = logSpy.mock.calls.map((c) => String(c[0]))
    const helpText = logMessages.join("\n")
    expect(helpText).toContain("uninstall")
    expect(helpText).toContain("Defaults to /infinite/ledger")
    expect(helpText).toContain("--infinite-api-origin <https://host>")
    expect(helpText).toContain("--infinite-download-destination-path <path>")
    expect(helpText).toContain("--infinite-autocapture <on|off>")
    expect(helpText).toContain("--infinite-consent-mode <required|not-required>")
    expect(helpText).toContain("No default")
    expect(helpText).toContain("infinite:analytics-consent-change")
  })

  it("install --yes refuses an Infinite artifact without an explicit consent mode", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_cli_test",
      "--yes",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel"
    ])

    expect(code).toBe(1)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
    expect(stdoutText()).toContain("Choose how Infinite first-party analytics handles consent")
  })

  it("plan accepts an explicit not-required Infinite consent mode", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "plan",
      "--root", root,
      "--json",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required"
    ])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutText())
    expect(parsed.artifacts.infinite.consentMode).toBe("not_required")
    const runtimeSnippet = parsed.instructions.find(
      (instruction: { provider?: string }) => instruction.provider === "infinite"
    )?.snippet
    expect(runtimeSnippet).toContain('"consent":{"mode":"not_required"}')
  })

  it("plan accepts an explicit Infinite conversion destination path", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "plan",
      "--root", root,
      "--json",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required",
      "--infinite-download-destination-path", "/checkout"
    ])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutText())
    expect(parsed.artifacts.infinite.downloadDestinationPath).toBe("/checkout")
    const runtimeSnippet = parsed.instructions.find(
      (instruction: { provider?: string }) => instruction.provider === "infinite"
    )?.snippet
    expect(runtimeSnippet).toContain('"downloadDestinationPath":"/checkout"')
  })

  it("rejects unknown Infinite consent modes", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "plan",
      "--root", root,
      "--infinite-consent-mode", "maybe"
    ])

    expect(code).toBe(1)
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).toContain(
      "--infinite-consent-mode currently supports only: required, not-required"
    )
  })
})

describe("human-readable output (default, no --json)", () => {
  it("shows the required-mode consent integration before applying", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "required"
    ])

    expect(code).toBe(0)
    expect(stdoutText()).toContain("infinite:analytics-consent-change")
    expect(stdoutText()).toContain("detail: { granted: true }")
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
  })

  it("says GA4/PostHog stay fully independent (native bootstraps, own consent) beside a not-required Infinite", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required",
      "--posthog-project-key", "phc_test123",
      "--posthog-api-host", "https://us.i.posthog.com"
    ])

    expect(code).toBe(0)
    expect(stdoutText()).toContain("GA4/PostHog stay fully independent")
    expect(stdoutText()).toContain("Infinite never forwards events into it")
    expect(stdoutText()).not.toContain("PostHog remains opted out")
    expect(stdoutText()).not.toContain("grant alone is insufficient")
  })

  it("install preview narrates what it will do and how to apply", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["install", "--root", root, "--ga4-measurement-id", "G-HUMAN1"])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain("Infinite OS · analytics installer")
    expect(out).toContain("I'll make")
    expect(out).toContain("G-HUMAN1")
    expect(out).toContain("To apply")
    expect(out).toContain("npx infinite-tag install")
    // Preview must not touch the repo.
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
  })

  it("install --yes confirms success and lists next steps", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_human",
      "--yes",
      "--ga4-measurement-id", "G-HUMAN2"
    ])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain("✅ Done")
    expect(out).toContain("Next steps")
    expect(out).toContain("git diff")
    expect(out).toContain("Google Analytics")
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
  })

  it("unsupported repo explains and offers the manual gtag snippet", async () => {
    const root = copyFixture("unsupported-basic")
    const code = await runCli(["install", "--root", root, "--ga4-measurement-id", "G-HUMAN4"])
    expect(code).toBe(1)
    const out = stdoutText()
    expect(out).toContain("couldn't recognize this project's framework")
    expect(out).toContain("googletagmanager.com/gtag/js?id=G-HUMAN4")
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

  it("installs GA4 natively with NO Infinite runtime when there is no Infinite source (0.6.0: no dormant mirror runtime)", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--ga4-measurement-id", "G-TEST123"
    ])
    expect(code).toBe(0)

    const html = indexHtml(root)
    expect(html).not.toContain("data-infinite-runtime")
    expect(html).not.toContain("site_page_view")
    expect(html).not.toContain("site_public")
    expect(html).not.toContain("app.ultima.inc")
    expect(html).not.toMatch(/\/tracking\/|\/sdk\//)
    expect(html).toContain("G-TEST123")
    expect(html).toContain("gtag('config', \"G-TEST123\")")
    expect(html).not.toContain("send_page_view")

    const manifest = JSON.parse(readFileSync(join(root, ".infinite/install.json"), "utf8"))
    expect(manifest.providers).not.toContain("infinite")
    expect(manifest.providers).toContain("ga4")
  })

  it("explicit production hosts without an Infinite source fabricate nothing — GA4 installs alone", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--ga4-measurement-id", "G-TEST123",
      "--infinite-production-host", "example.com"
    ])
    expect(code).toBe(0)

    const html = indexHtml(root)
    expect(html).not.toContain('"siteSourceKey"')
    expect(html).not.toContain("data-infinite-runtime")
    const manifest = JSON.parse(readFileSync(join(root, ".infinite/install.json"), "utf8"))
    expect(manifest.providers).toEqual(["ga4"])
  })

  it("does not fabricate Infinite from a workspace-only install", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["install", "--root", root, "--workspace", "ws_only", "--yes"])
    expect(code).toBe(1)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
    expect(stdoutText()).toContain("couldn't find any analytics to install")
  })

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

  it("installs Infinite only from the public source artifact and exact Vercel proxy", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "required"
    ])
    expect(code).toBe(0)
    const html = indexHtml(root)
    expect(html).toContain('"siteSourceKey":"site_public_123"')
    expect(html).toContain("/infinite/ledger")
    expect(html).not.toContain("/infinite/events/collect")
    expect(html).not.toContain("app.ultima.inc")
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.rewrites).toContainEqual({
      source: "/infinite/ledger",
      destination: "https://api.ultima.inc/api/analytics/events/collect"
    })
  })

  it("--infinite-api-origin points the Vercel rewrite at the override host", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "required",
      "--infinite-api-origin", "https://api.infinite.fast"
    ])
    expect(code).toBe(0)
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.rewrites).toContainEqual({
      source: "/infinite/ledger",
      destination: "https://api.infinite.fast/api/analytics/events/collect"
    })
    expect(JSON.stringify(vercel)).not.toContain("api.ultima.inc")
  })

  it("INFINITE_API_ORIGIN in the env overrides the default and the flag beats it", async () => {
    const previous = process.env.INFINITE_API_ORIGIN
    process.env.INFINITE_API_ORIGIN = "https://env.example"
    try {
      const root = copyFixture("static-html-basic")
      const code = await runCli([
        "plan",
        "--root", root,
        "--json",
        "--infinite-site-source-key", "site_public_123",
        "--infinite-production-host", "example.com",
        "--infinite-static-proxy", "vercel",
        "--infinite-consent-mode", "required"
      ])
      expect(code).toBe(0)
      expect(lastStdoutJson()).toContain("https://env.example/api/analytics/events/collect")

      const flagged = await runCli([
        "plan",
        "--root", root,
        "--json",
        "--infinite-site-source-key", "site_public_123",
        "--infinite-production-host", "example.com",
        "--infinite-static-proxy", "vercel",
        "--infinite-consent-mode", "required",
        "--infinite-api-origin", "https://flag.example"
      ])
      expect(flagged).toBe(0)
      const text = lastStdoutJson()
      expect(text).toContain("https://flag.example/api/analytics/events/collect")
      expect(text).not.toContain("env.example")
    } finally {
      if (previous === undefined) delete process.env.INFINITE_API_ORIGIN
      else process.env.INFINITE_API_ORIGIN = previous
    }
  })

  it("rejects an --infinite-api-origin that carries a path", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "plan",
      "--root", root,
      "--json",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-api-origin", "https://api.infinite.fast/api"
    ])
    expect(code).toBe(1)
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).toContain(
      "--infinite-api-origin must be an https origin with no path"
    )
  })

  it("plan --json lists adopted providers and human mode says what was left alone", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html>\n<html lang="en">\n  <head>\n    <script>gtag("config", "G-EXISTING")</script>\n  </head>\n  <body></body>\n</html>\n'
    )

    const code = await runCli([
      "plan",
      "--root", root,
      "--json",
      "--ga4-measurement-id", "G-TEST123",
      "--meta-pixel-id", "1234567890123456"
    ])
    expect(code).toBe(0)
    const plan = JSON.parse(lastStdoutJson()) as { adopted: unknown; providers: string[]; blockers: string[] }
    expect(plan.adopted).toEqual([{ provider: "ga4", via: "snippet", file: "index.html" }])
    expect(plan.providers).toEqual(["meta"])
    expect(plan.blockers).toEqual([])

    logSpy.mockClear()
    const human = await runCli([
      "plan",
      "--root", root,
      "--ga4-measurement-id", "G-TEST123",
      "--meta-pixel-id", "1234567890123456"
    ])
    expect(human).toBe(0)
    expect(stdoutText()).toContain("Already on your site (left untouched):")
    expect(stdoutText()).toContain("Google Analytics — index.html (existing snippet)")
  })

  it("install with only already-present providers changes nothing and says so", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html>\n<html lang="en">\n  <head>\n    <script>gtag("config", "G-EXISTING")</script>\n  </head>\n  <body></body>\n</html>\n'
    )
    const before = readFileSync(join(root, "index.html"), "utf8")

    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--ga4-measurement-id", "G-TEST123"
    ])
    expect(code).toBe(0)
    expect(stdoutText()).toContain("Nothing to install")
    expect(stdoutText()).toContain("Google Analytics — index.html (existing snippet)")
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(before)
    expect(existsSync(join(root, ".infinite", "install.json"))).toBe(false)
  })

  it("--infinite-autocapture off reaches the runtime; on (and absent) leave the 0.6.2 config", async () => {
    const baseArgs = (root: string) => [
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required"
    ]

    const offRoot = copyFixture("static-html-basic")
    expect(await runCli([...baseArgs(offRoot), "--infinite-autocapture", "off"])).toBe(0)
    expect(indexHtml(offRoot)).toContain('"autocapture":false')

    const onRoot = copyFixture("static-html-basic")
    expect(await runCli([...baseArgs(onRoot), "--infinite-autocapture", "on"])).toBe(0)
    expect(indexHtml(onRoot)).not.toContain('"autocapture"')

    const defaultRoot = copyFixture("static-html-basic")
    expect(await runCli(baseArgs(defaultRoot))).toBe(0)
    expect(indexHtml(defaultRoot)).not.toContain('"autocapture"')
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

  it("--infinite-allow-automation reaches the runtime on a localhost sandbox source", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_test",
      "--yes",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "localhost",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required",
      "--infinite-allow-automation"
    ])
    expect(code).toBe(0)
    expect(indexHtml(root)).toContain('"allowAutomation":true')
  })

  it("rejects an --infinite-autocapture value other than on|off", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli(["plan", "--root", root, "--infinite-site-source-key", "site_public_123", "--infinite-autocapture", "maybe"])
    expect(code).toBe(1)
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).toContain(
      "--infinite-autocapture currently supports only: on, off"
    )
  })

  it("explains the removed unsafe external-loader flags for one release", async () => {
    const root = copyFixture("static-html-basic")
    for (const flag of ["--infinite-base-url", "--infinite-page-id"]) {
      const code = await runCli(["plan", "--root", root, flag, "obsolete"])
      expect(code).toBe(1)
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "removed unsafe external-loader flag"
      )
    }
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

  it("bare install --json discovers the single saved file, adopts its workspace id, and prints the plan", async () => {
    const root = copyFixture("static-html-basic")
    const filePath = saveArtifactsFile("ws_saved.json", {
      workspaceId: "ws_saved",
      ga4: { measurementId: "G-SAVED111" }
    })

    const code = await runCli(["install", "--root", root, "--json"])

    expect(code).toBe(0)
    expect(stderrText()).toContain(`Discovered saved public artifacts: ${filePath}`)
    expect(stderrText()).toContain("ga4")
    expect(stderrText()).toContain("workspace: ws_saved")
    // Still a dry run: no --yes means plan only, nothing applied.
    expect(stderrText()).toContain("Approval required before apply.")
    const plan = stdoutJson()
    expect(plan.blockers).toEqual([])
    expect(JSON.stringify(plan)).toContain("G-SAVED111")
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
  })

  it("bare install with no saved artifacts explains how to fix (human)", async () => {
    const root = copyFixture("static-html-basic")

    const code = await runCli(["install", "--root", root])

    expect(code).toBe(1)
    const out = stdoutText()
    expect(out).toContain("couldn't find any analytics to install")
    expect(out).toContain("infinite local setup")
    expect(out).toContain("--ga4-measurement-id")
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
  })

  it("install --yes applies using the workspace id adopted from the discovered file", async () => {
    const root = copyFixture("static-html-basic")
    saveArtifactsFile("ws_saved.json", {
      workspaceId: "ws_saved",
      ga4: { measurementId: "G-SAVED111" }
    })

    const code = await runCli(["install", "--root", root, "--yes"])

    expect(code).toBe(0)
    const manifestPath = join(root, ".infinite/install.json")
    expect(existsSync(manifestPath)).toBe(true)
    expect(readFileSync(manifestPath, "utf8")).toContain("ws_saved")
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("G-SAVED111")
  })

  it("--workspace selects that workspace's saved file when several exist", async () => {
    const root = copyFixture("static-html-basic")
    saveArtifactsFile("ws_a.json", { workspaceId: "ws_a", ga4: { measurementId: "G-AAAA111" } })
    const fileB = saveArtifactsFile("ws_b.json", { workspaceId: "ws_b", ga4: { measurementId: "G-BBBB222" } })

    const code = await runCli(["plan", "--root", root, "--workspace", "ws_b", "--json"])

    expect(code).toBe(0)
    expect(stderrText()).toContain(`Discovered saved public artifacts: ${fileB}`)
    const plan = JSON.stringify(stdoutJson())
    expect(plan).toContain("G-BBBB222")
    expect(plan).not.toContain("G-AAAA111")
  })

  it("layers a conversion destination override onto a discovered Infinite artifact", async () => {
    const root = copyFixture("static-html-basic")
    const filePath = saveArtifactsFile("ws_saved.json", {
      workspaceId: "ws_saved",
      infinite: {
        siteSourceKey: "site_public_123",
        collectPath: "/infinite/events/collect",
        productionHosts: ["example.com"],
        staticProxy: "vercel",
        consentMode: "not_required"
      }
    })

    const code = await runCli([
      "plan",
      "--root", root,
      "--workspace", "ws_saved",
      "--infinite-download-destination-path", "/checkout",
      "--json"
    ])

    expect(code).toBe(0)
    expect(stderrText()).toContain(`Discovered saved public artifacts: ${filePath}`)
    const parsed = stdoutJson()
    expect(
      (parsed.artifacts as { infinite?: { downloadDestinationPath?: string } }).infinite
        ?.downloadDestinationPath
    ).toBe("/checkout")
    const runtimeSnippet = (parsed.instructions as Array<{ provider?: string; snippet?: string }>).find(
      (instruction) => instruction.provider === "infinite"
    )?.snippet
    expect(runtimeSnippet).toContain('"downloadDestinationPath":"/checkout"')
  })

  it("rejects an explicit empty Infinite conversion destination path", async () => {
    const root = copyFixture("static-html-basic")

    const code = await runCli([
      "plan",
      "--root", root,
      "--json",
      "--infinite-site-source-key", "site_public_123",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "not-required",
      "--infinite-download-destination-path", ""
    ])

    expect(code).toBe(1)
    const parsed = stdoutJson()
    expect(parsed.blockers).toContain(
      "Infinite downloadDestinationPath must be a root-relative path without query, hash, or whitespace (max 256 chars)."
    )
  })

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

  it("explicit artifact flags beat discovery", async () => {
    const root = copyFixture("static-html-basic")
    saveArtifactsFile("ws_saved.json", { workspaceId: "ws_saved", ga4: { measurementId: "G-FILE111" } })

    const code = await runCli(["plan", "--root", root, "--ga4-measurement-id", "G-FLAG222", "--json"])

    expect(code).toBe(0)
    expect(stderrText()).not.toContain("Discovered saved public artifacts")
    const plan = JSON.stringify(stdoutJson())
    expect(plan).toContain("G-FLAG222")
    expect(plan).not.toContain("G-FILE111")
  })

  it("--artifact-file beats discovery", async () => {
    const root = copyFixture("static-html-basic")
    saveArtifactsFile("ws_saved.json", { workspaceId: "ws_saved", ga4: { measurementId: "G-FILE111" } })
    const explicitFile = join(root, "explicit-artifacts.json")
    writeFileSync(explicitFile, JSON.stringify({ ga4: { measurementId: "G-EXPL333" } }))

    const code = await runCli(["plan", "--root", root, "--artifact-file", explicitFile, "--json"])

    expect(code).toBe(0)
    expect(stderrText()).not.toContain("Discovered saved public artifacts")
    const plan = JSON.stringify(stdoutJson())
    expect(plan).toContain("G-EXPL333")
    expect(plan).not.toContain("G-FILE111")
  })

  it("a malformed saved file warns and is treated as absent", async () => {
    const root = copyFixture("static-html-basic")
    saveArtifactsFile("ws_bad.json", "{not json")

    const code = await runCli(["plan", "--root", root, "--json"])

    expect(code).toBe(1)
    expect(stderrText()).toContain("Ignoring saved artifact file")
    expect(stdoutJson().blockers).toContain("No supported public install artifacts were provided.")
  })

  it("install --yes still requires a workspace id when nothing was discovered", async () => {
    const root = copyFixture("static-html-basic")

    const code = await runCli([
      "install",
      "--root", root,
      "--yes",
      "--ga4-measurement-id", "G-TEST123"
    ])

    expect(code).toBe(1)
    expect(stderrText()).toContain("install requires --workspace <workspace-id> when --yes is used.")
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

  it("honours --posthog-ui-host for the toolbar host", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_proxy",
      "--yes",
      "--posthog-project-key", "phc_abcDEF0123456789xyz",
      "--posthog-api-host", "https://us.i.posthog.com",
      "--posthog-proxy",
      "--posthog-ui-host", "https://ph.example.com"
    ])
    expect(code).toBe(0)
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain('ui_host: "https://ph.example.com"')
  })

  it("--posthog-proxy without a project key does not fabricate a PostHog install", async () => {
    const root = copyFixture("static-html-basic")
    const code = await runCli([
      "install",
      "--root", root,
      "--workspace", "ws_proxy",
      "--yes",
      "--posthog-proxy"
    ])
    expect(code).toBe(1)
    const html = readFileSync(join(root, "index.html"), "utf8")
    expect(html).not.toContain("posthog.init")
    expect(existsSync(join(root, "vercel.json"))).toBe(false)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
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
})
