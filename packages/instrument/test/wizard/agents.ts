// Test helper (never published): wires the REAL AgentRunnerImpl to the fake `claude` / `codex` binaries in
// ./bin and the BUILT cli.js (the fakes spawn its real `mcp-proxy`). PATH holds only the fake bin dir and
// system dirs, so a real agent on the developer's machine can never be reached.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { AgentRunnerImpl, type AgentRunnerOptions } from "../../src/agents/runner.js"
import type { CheckResult, TurnDiff } from "../../src/wizard/contracts/jobs.js"
import { tempDir } from "./repo.js"

const here = dirname(fileURLToPath(import.meta.url))
export const FAKE_BIN_DIR = resolve(here, "bin")
export const BUILT_CLI = resolve(here, "../../dist/src/cli.js")
export const RUN_ID = "7f3c2a10-0000-4000-8000-0000000000aa"

export function assertBuilt(): void {
  if (!existsSync(BUILT_CLI)) throw new Error(`Build the package first (pnpm --filter infinite-tag build): missing ${BUILT_CLI}`)
}

export interface FakeSetup {
  home: string
  scenarioPath: string
  recordPath: string
  env: Record<string, string>
}

/** A temp home (with a GROWTH_OS_HOME, an Infinite userData dir and a ~/.codex) and the fakes' env. */
export function fakeAgents(scenario: unknown, extraEnv: Record<string, string> = {}): FakeSetup {
  const home = tempDir("infinite-tag-agent-home-")
  const scenarioPath = join(home, "scenario.json")
  const recordPath = join(home, "record.jsonl")
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const path = [FAKE_BIN_DIR, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
  return {
    home,
    scenarioPath,
    recordPath,
    env: {
      PATH: path,
      HOME: home,
      FAKE_AGENT_SCENARIO: scenarioPath,
      FAKE_AGENT_RECORD: recordPath,
      ...extraEnv
    }
  }
}

export function setScenario(setup: FakeSetup, scenario: unknown): void {
  writeFileSync(setup.scenarioPath, JSON.stringify(scenario))
}

export interface FakeRecord {
  kind: "run" | "probe" | "mcp" | "toolless" | "grandchild" | "hanging"
  agent: "claude" | "codex"
  role?: "worker" | "reviewer"
  argv?: string[]
  cwd?: string
  env?: Record<string, unknown> & { INFINITE_TAG_KEYS: string[] }
  stdin?: string
  tool?: string
  reply?: { result?: { structuredContent?: unknown; isError?: boolean }; error?: unknown }
  pid?: number
  cwdEntries?: string[]
}

export function records(setup: FakeSetup): FakeRecord[] {
  if (!existsSync(setup.recordPath)) return []
  return readFileSync(setup.recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeRecord)
}

export function runs(setup: FakeSetup, agent?: "claude" | "codex"): FakeRecord[] {
  return records(setup).filter((entry) => entry.kind === "run" && (agent === undefined || entry.agent === agent))
}

export interface GateSpy {
  calls: TurnDiff[]
  turnGate(diff: TurnDiff, ctx: { connectionIds: readonly string[] }): Promise<CheckResult[]>
}

/** A post-turn gate fake: flags `child_process` in an added line (the §3f.9 shape), records every call. */
export function gateSpy(): GateSpy {
  const spy: GateSpy = {
    calls: [],
    async turnGate(diff) {
      spy.calls.push(diff)
      return diff.files.flatMap((file) =>
        file.added
          .filter((line) => /child_process/.test(line.text))
          .map((line) => ({
            checkId: "turn_gate_exec",
            state: "problem" as const,
            reason: "child_process added to a build-time file",
            evidence: [{ file: file.path, line: line.line }],
            tier: "S" as const,
            at: new Date().toISOString(),
            runId: RUN_ID
          }))
      )
    }
  }
  return spy
}

export function makeRunner(setup: FakeSetup, root: string, overrides: Partial<AgentRunnerOptions> = {}): AgentRunnerImpl {
  assertBuilt()
  return new AgentRunnerImpl({
    root,
    home: setup.home,
    env: setup.env,
    isTTY: true,
    tagVersion: "0.0.0-test",
    runId: () => RUN_ID,
    checks: gateSpy(),
    cliPath: BUILT_CLI,
    narrationThrottleMs: 0,
    codexStartupTimeoutMs: 15_000,
    ...overrides
  })
}
