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
  })
})

describe("human-readable output (default, no --json)", () => {
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
    expect(out).toContain("infinite setup")
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
