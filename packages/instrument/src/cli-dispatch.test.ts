import { rmSync } from "node:fs"
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
    { argv: ["wizard", "--json", "--resume"], expected: ["--json", "--resume"] },
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
  it('["install","--json", …] still reaches the old parser', async () => {
    // An argument only the installer's parser rejects proves the argv got there.
    expect(await runCli(["install", "--json", "--not-a-real-flag"])).toBe(1)
    expect(stderr()).toContain("Unknown argument: --not-a-real-flag")
    expectNoWizardEntry()
  })
})

describe("routeCliArgv", () => {
  it("negatives: help flags, --version and every classic command stay with the installer", () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["install", "--json"], ["uninstall", "--yes"], ["plan"], ["verify"], ["server-lane", "--brief"]]) {
      expect(routeCliArgv(argv)).toEqual({ kind: "installer", argv })
    }
    expect(routeCliArgv(["--version"])).toEqual({ kind: "version" })
  })
})

