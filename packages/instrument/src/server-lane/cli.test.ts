import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runCli } from "../cli.js"

import { SERVER_LANE_BRIEF_FILE, SERVER_LANE_POSITIONING } from "./copy.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-cli-server-lane-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
const originalEnv = { ...process.env }

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  delete process.env.INFINITE_SERVER_EVENT_SECRET
  delete process.env.INFINITE_SITE_SOURCE_KEY
  // Keep discovery of ~/.infinite/artifacts out of these tests.
  process.env.INFINITE_ARTIFACTS_DIR = join(tmpdir(), `instrument-no-artifacts-${Date.now()}`)
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  process.env = { ...originalEnv }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function stdoutText(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("infinite-tag server-lane --brief", () => {
  it("prints the agent brief for the detected stack without writing anything", async () => {
    const root = copyFixture("vite-react-basic")
    const code = await runCli(["server-lane", "--brief", "--root", root])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain(SERVER_LANE_POSITIONING)
    expect(out).toContain("## The contract (implement exactly)")
    expect(out).toContain('This project was detected as "Vite + React"')
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(false)
  })

  it("on a Next.js repo prints the manual-wiring status; --json wraps it", async () => {
    const root = copyFixture("next-app-router-basic")
    const code = await runCli(["server-lane", "--json", "--root", root])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutText()) as { framework: string; brief: string }
    expect(parsed.framework).toBe("next-app-router")
    expect(parsed.brief).toContain("This is a Next.js project.")
    expect(parsed.brief).toContain("### Exactly what to add to your middleware")
  })

  it("help mentions the server lane", async () => {
    await runCli(["help"])
    expect(stdoutText()).toContain("--server-lane")
    expect(stdoutText()).toContain("verify --server-lane <url>")
  })
})

describe("infinite-tag install --server-lane", () => {
  it("--json --yes on Next.js installs the lane and reports it in the machine contract", async () => {
    const root = copyFixture("next-app-router-basic")
    const code = await runCli([
      "install",
      "--root",
      root,
      "--workspace",
      "ws_test",
      "--server-lane",
      "--infinite-site-source-key",
      "site_public_test",
      "--infinite-production-host",
      "example.com",
      "--infinite-consent-mode",
      "not-required",
      "--json",
      "--yes"
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutText()) as {
      plan: { serverLane?: { mode: string; middleware?: { action: string } } }
      apply: { changedFiles: string[]; serverLane?: { briefWritten: boolean } }
      verify: { buildOk: boolean }
    }
    expect(parsed.plan.serverLane?.mode).toBe("next-middleware")
    expect(parsed.plan.serverLane?.middleware?.action).toBe("create")
    expect(parsed.apply.changedFiles).toEqual(expect.arrayContaining(["middleware.ts", "lib/infinite-server-lane.ts", SERVER_LANE_BRIEF_FILE]))
    expect(parsed.apply.serverLane?.briefWritten).toBe(true)
    expect(parsed.verify.buildOk).toBe(true)
    expect(existsSync(join(root, "middleware.ts"))).toBe(true)
  })

  it("human mode on Next.js narrates the lane and the env vars, and does not print the brief", async () => {
    const root = copyFixture("next-app-router-basic")
    const code = await runCli(["install", "--root", root, "--workspace", "ws_test", "--server-lane", "--yes"])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain("Server lane (lossless analytics):")
    expect(out).toContain("+ middleware.ts")
    expect(out).toContain("+ lib/infinite-server-lane.ts")
    expect(out).toContain(`+ ${SERVER_LANE_BRIEF_FILE}`)
    expect(out).toContain("INFINITE_SERVER_EVENT_SECRET=")
    expect(out).toContain("npx infinite-tag verify --server-lane https://")
    expect(out).not.toContain("## The contract (implement exactly)")
  })

  it("human mode on Vite writes the brief AND prints it (the brief is the install)", async () => {
    const root = copyFixture("vite-react-basic")
    const code = await runCli(["install", "--root", root, "--workspace", "ws_test", "--server-lane", "--yes"])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain("The full agent brief follows (also written into the project):")
    expect(out).toContain("## The contract (implement exactly)")
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(true)
  })

  it("prints the brief when the existing middleware could not be patched", async () => {
    const root = copyFixture("next-app-router-basic")
    writeFileSync(
      join(root, "middleware.ts"),
      `export function middleware(request) {\n  return undefined\n}\nexport const config = { matcher: ["/dashboard/:path*"] }\n`
    )
    const code = await runCli(["install", "--root", root, "--workspace", "ws_test", "--server-lane", "--yes"])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain("! middleware.ts  left untouched")
    expect(out).toContain("### Exactly what to add to your middleware")
    expect(readFileSync(join(root, "middleware.ts"), "utf8")).toContain('matcher: ["/dashboard/:path*"]')
  })

  it("on an unsupported stack, prints the unsupported notice AND the brief without writing files", async () => {
    const root = copyFixture("unsupported-basic")
    const code = await runCli(["install", "--root", root, "--workspace", "ws_test", "--server-lane", "--yes"])
    expect(code).toBe(1)
    const out = stdoutText()
    expect(out).toContain("I couldn't recognize this project's framework")
    expect(out).toContain("Save it with:  npx infinite-tag server-lane --brief > INSTALL-SERVER-LANE.md")
    expect(out).toContain("## The contract (implement exactly)")
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(false)
  })

  it("plan --server-lane previews the lane files", async () => {
    const root = copyFixture("next-app-router-basic")
    const code = await runCli(["plan", "--root", root, "--server-lane"])
    expect(code).toBe(0)
    const out = stdoutText()
    expect(out).toContain("+ middleware.ts")
    expect(out).toContain("+ lib/infinite-server-lane.ts")
    expect(out).toContain("This was a preview — nothing changed.")
    expect(existsSync(join(root, "middleware.ts"))).toBe(false)
  })
})

describe("infinite-tag verify --server-lane <url>", () => {
  it("fails fast with the missing-secret cause when INFINITE_SERVER_EVENT_SECRET is unset", async () => {
    const code = await runCli(["verify", "--server-lane", "https://example.com/", "--infinite-site-source-key", "site_x"])
    expect(code).toBe(1)
    expect(stdoutText()).toContain("INFINITE_SERVER_EVENT_SECRET is not set in this shell")
  })

  it("requires a URL value", async () => {
    const code = await runCli(["verify", "--server-lane"])
    expect(code).toBe(1)
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Missing value for --server-lane")
  })

  it("--json emits the machine result", async () => {
    const code = await runCli(["verify", "--server-lane", "https://example.com/", "--json"])
    expect(code).toBe(1)
    const parsed = JSON.parse(stdoutText()) as { ok: boolean; failure: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.failure).toBe("missing_secret")
  })
})
