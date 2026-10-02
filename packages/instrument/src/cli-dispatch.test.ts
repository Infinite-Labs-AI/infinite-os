import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The wizard, doctor, MCP-proxy and harness entry points are mocked so this file proves ROUTING:
// which entry point an argv reaches, with which argv. The real stubs are exercised at the bottom
// through vi.importActual.
vi.mock("./wizard/command.js", () => ({
  runWizardCommand: vi.fn(async () => 42),
  runWizardUninstall: vi.fn(async () => 43)
}))
vi.mock("./agents/mcp/proxy.js", () => ({ runMcpProxy: vi.fn(async () => 44) }))
vi.mock("./doctor/command.js", () => ({ runDoctorCommand: vi.fn(async () => 45) }))
vi.mock("./harness/command.js", () => ({ runHarnessCommand: vi.fn(async () => 46) }))

import { routeCliArgv, runCli } from "./cli.js"
import { runMcpProxy } from "./agents/mcp/proxy.js"
import { runDoctorCommand } from "./doctor/command.js"
import { runHarnessCommand } from "./harness/command.js"
import { runWizardCommand, runWizardUninstall } from "./wizard/command.js"

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
const tempRoots: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

const stdout = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n")
const stderr = () => errorSpy.mock.calls.map((c) => String(c[0])).join("\n")

function expectNoWizardEntry(): void {
  expect(runWizardCommand).not.toHaveBeenCalled()
  expect(runWizardUninstall).not.toHaveBeenCalled()
  expect(runMcpProxy).not.toHaveBeenCalled()
  expect(runDoctorCommand).not.toHaveBeenCalled()
}

describe("runCli → the wizard", () => {
  const wizardArgvs: Array<{ argv: string[]; expected: string[] }> = [
    { argv: [], expected: [] },
    { argv: ["wizard"], expected: [] },
    { argv: ["wizard", "--json", "--resume"], expected: ["--json", "--resume"] },
    { argv: ["--json"], expected: ["--json"] },
    { argv: ["--resume", "--json"], expected: ["--resume", "--json"] },
    { argv: ["--answers", "f", "--json"], expected: ["--answers", "f", "--json"] },
    { argv: ["--yes", "--consent-mode", "required"], expected: ["--yes", "--consent-mode", "required"] }
  ]

  for (const { argv, expected } of wizardArgvs) {
    it(`${JSON.stringify(argv)} → runWizardCommand(${JSON.stringify(expected)})`, async () => {
      expect(await runCli(argv)).toBe(42)
      expect(runWizardCommand).toHaveBeenCalledTimes(1)
      expect(runWizardCommand).toHaveBeenCalledWith(expected)
      expect(runHarnessCommand).not.toHaveBeenCalled()
      // Never printed help, never reached the installer's parser ("Unknown command" / "Unknown argument").
      expect(stdout()).not.toContain("Usage: infinite-tag")
      expect(stderr()).not.toMatch(/Unknown (command|argument)/)
    })
  }

  it("uninstall --pr → runWizardUninstall with the rest of the argv", async () => {
    expect(await runCli(["uninstall", "--pr", "--json"])).toBe(43)
    expect(runWizardUninstall).toHaveBeenCalledWith(["--pr", "--json"])
    expect(runWizardCommand).not.toHaveBeenCalled()
  })

  it("mcp-proxy → runMcpProxy; doctor → runDoctorCommand with the rest of the argv", async () => {
    expect(await runCli(["mcp-proxy"])).toBe(44)
    expect(runMcpProxy).toHaveBeenCalledTimes(1)
    expect(await runCli(["doctor", "--json", "--url", "https://acme-store.com"])).toBe(45)
    expect(runDoctorCommand).toHaveBeenCalledWith(["--json", "--url", "https://acme-store.com"])
    expect(runWizardCommand).not.toHaveBeenCalled()
  })
})

describe("runCli → the classic commands, unchanged", () => {
  it("harness keeps its own dispatch", async () => {
    expect(await runCli(["harness", "--check", "--json"])).toBe(46)
    expect(runHarnessCommand).toHaveBeenCalledWith(["--check", "--json"])
    expectNoWizardEntry()
  })

  for (const argv of [["help"], ["--help"], ["-h"]]) {
    it(`${JSON.stringify(argv)} prints help and never opens the wizard`, async () => {
      expect(await runCli(argv)).toBe(0)
      expect(stdout()).toContain("Usage: infinite-tag")
      expectNoWizardEntry()
    })
  }

  it("help names the wizard and doctor, and hides mcp-proxy", async () => {
    await runCli(["help"])
    const help = stdout()
    expect(help).toContain("npx infinite-tag")
    expect(help).toMatch(/^\s+doctor\s/m)
    expect(help).not.toContain("mcp-proxy")
  })

  it("--version still reaches the installer's parser (today: an unknown command, exit 1), never the wizard", async () => {
    expect(await runCli(["--version"])).toBe(1)
    expect(stderr()).toContain("Unknown command: --version")
    expectNoWizardEntry()
  })

  it('["install","--json", …] still reaches the old parser', async () => {
    // An argument only the installer's parser rejects proves the argv got there.
    expect(await runCli(["install", "--json", "--not-a-real-flag"])).toBe(1)
    expect(stderr()).toContain("Unknown argument: --not-a-real-flag")
    expectNoWizardEntry()
  })

  it("uninstall WITHOUT --pr stays the installer's dry-run uninstall", async () => {
    const root = mkdtempSync(join(tmpdir(), "infinite-tag-dispatch-"))
    tempRoots.push(root)
    expect(await runCli(["uninstall", "--root", root])).toBe(0)
    expect(stderr()).toContain("Dry run only")
    expectNoWizardEntry()
  })
})

describe("routeCliArgv", () => {
  it("routes exactly as §F0 lists", () => {
    expect(routeCliArgv([])).toEqual({ kind: "wizard", argv: [] })
    expect(routeCliArgv(["wizard", "--yes"])).toEqual({ kind: "wizard", argv: ["--yes"] })
    expect(routeCliArgv(["--no-agent"])).toEqual({ kind: "wizard", argv: ["--no-agent"] })
    expect(routeCliArgv(["mcp-proxy"])).toEqual({ kind: "mcp-proxy" })
    expect(routeCliArgv(["doctor"])).toEqual({ kind: "doctor", argv: [] })
    expect(routeCliArgv(["uninstall", "--yes", "--pr"])).toEqual({ kind: "wizard-uninstall", argv: ["--yes", "--pr"] })
    expect(routeCliArgv(["harness", "--json"])).toEqual({ kind: "harness", argv: ["--json"] })
  })

  it("negatives: help flags, --version and every classic command stay with the installer", () => {
    for (const argv of [["--help"], ["-h"], ["--version"], ["help"], ["install", "--json"], ["uninstall", "--yes"], ["plan"], ["verify"], ["server-lane", "--brief"]]) {
      expect(routeCliArgv(argv)).toEqual({ kind: "installer", argv })
    }
  })
})

describe("the foundation stubs (until lanes O1, O3 and O9 fill them)", () => {
  it("runWizardCommand / runWizardUninstall say the wizard is not built and exit 2", async () => {
    const actual = await vi.importActual<typeof import("./wizard/command.js")>("./wizard/command.js")
    expect(await actual.runWizardCommand(["--json"])).toBe(2)
    expect(await actual.runWizardUninstall(["--pr"])).toBe(2)
    expect(stderr()).toContain("not built yet")
  })

  it("runMcpProxy and runDoctorCommand exit 2 (never a silent 0)", async () => {
    const proxy = await vi.importActual<typeof import("./agents/mcp/proxy.js")>("./agents/mcp/proxy.js")
    const doctor = await vi.importActual<typeof import("./doctor/command.js")>("./doctor/command.js")
    expect(await proxy.runMcpProxy()).toBe(2)
    expect(await doctor.runDoctorCommand(["--json"])).toBe(2)
  })
})
