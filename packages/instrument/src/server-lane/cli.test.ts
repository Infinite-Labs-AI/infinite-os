import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
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

  it("a server-lane-only install does not claim a browser pixel and counts runtime files honestly", async () => {
    const root = copyFixture("next-app-router-basic")
    const code = await runCli(["install", "--root", root, "--workspace", "ws_test", "--server-lane", "--yes"])
    expect(code).toBe(0)
    const out = stdoutText()
    // Task 1: no overclaim — server lane only, pixel explicitly not installed.
    expect(out).toContain("✅ Done — server lane wired (lossless server-side counting).")
    expect(out).toContain("Browser pixel NOT installed.")
    expect(out).not.toContain("your site is now wired for analytics")
    // Task 2: runtime file count is separated from the manifest + brief artifacts.
    expect(out).toContain("managed runtime file")
    expect(out).toContain("wrote manifest + brief")
    // The pixel "Installed" step must not attribute the middleware/module/brief to a pixel.
    expect(out).not.toContain("Installed analytics →")
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
})

describe("infinite-tag verify --server-lane <url>", () => {
  it("fails fast with the missing-secret cause when INFINITE_SERVER_EVENT_SECRET is unset", async () => {
    const code = await runCli(["verify", "--server-lane", "https://example.com/", "--infinite-site-source-key", "site_x"])
    expect(code).toBe(1)
    expect(stdoutText()).toContain("INFINITE_SERVER_EVENT_SECRET is not set in this shell")
  })

  it("--json emits the machine result", async () => {
    const code = await runCli(["verify", "--server-lane", "https://example.com/", "--json"])
    expect(code).toBe(1)
    const parsed = JSON.parse(stdoutText()) as { ok: boolean; failure: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.failure).toBe("missing_secret")
  })
})
