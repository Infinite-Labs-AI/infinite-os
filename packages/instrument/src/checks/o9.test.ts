// Lane O9's registration on the `CheckRunner.register` seam, against a fake runner (lane O6's real
// runner is a sibling branch; I1 wires the two).
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch } from "../../test/wizard/fixture-fetch.js"
import type { CheckFn, CheckId } from "../wizard/contracts/jobs.js"

import { O9_CHECK_IDS, O9_RUNNER_METHODS, o9CheckFunctions, registerO9Checks } from "./o9.js"

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "o9-checks-"))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  return root
}

/** A git repo whose HEAD holds `base`, with `working` written over it (uncommitted, as during a job). */
function repo(base: Record<string, string>, working: Record<string, string>): string {
  const root = app(base)
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" })
  git("init", "-q")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  for (const [file, contents] of Object.entries(working)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  return root
}

/** The fake runner: the seam's contract is "registering an id twice throws". */
function fakeRunner() {
  const fns = new Map<CheckId, CheckFn>()
  return {
    fns,
    register(checkId: CheckId, fn: CheckFn) {
      if (fns.has(checkId)) throw new Error(`check ${checkId} is already registered`)
      fns.set(checkId, fn)
    }
  }
}

const ctx = { runId: "run-9", now: FIXED_NOW }

describe("O9 registration", () => {
  it("registers every id once, and every runner method routes to a registered id", () => {
    const runner = fakeRunner()
    registerO9Checks(runner, { version: "t", fetch: fixtureFetch({}).fetch })
    expect([...runner.fns.keys()].sort()).toEqual(Object.values(O9_CHECK_IDS).sort())
    for (const method of Object.values(O9_RUNNER_METHODS)) expect(runner.fns.has(method.checkId)).toBe(true)
    // The seam refuses a second registration (negative).
    expect(() => registerO9Checks(runner, { version: "t" })).toThrow(/already registered/)
  })

  it("a crashing check is undetermined (test error), never a pass", async () => {
    const fns = o9CheckFunctions({ version: "t" })
    const results = await fns.setup_checks!({ appRoot: "relative/without/root" }, ctx)
    expect(results).toMatchObject([{ checkId: "setup_checks", state: "undetermined" }])
    expect((Array.isArray(results) ? results[0] : results)!.reason).toMatch(/^test error/)
    expect(await fns.live_bytes!(null, ctx)).toMatchObject([{ state: "undetermined" }])
  })

  it("rejects turning collection on even with sensitive-page approval", async () => {
    const file = "app/providers.tsx"
    const base = "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest', defaults: '2026-01-30', autocapture: false, disable_session_recording: true })"
    const root = repo({ [file]: base }, { [file]: base.replace("autocapture: false", "autocapture: true") })
    const fns = o9CheckFunctions({ version: "t", root })
    const results = await fns.posthog_config({ appRoot: root, sensitivePagesApproved: true }, ctx) as Array<{ state: string }>
    expect(results.some(result => result.state === "problem")).toBe(true)
  })

  it("the post-turn gate fails CLOSED: a crash is a problem, never undetermined (review P2-1)", async () => {
    const fns = o9CheckFunctions({ version: "t" })
    const malformed = (await fns.turn_gate!({ diff: { files: [{ path: "a.ts", added: 7, removed: [] }] }, connectionIds: [] }, ctx)) as Array<{ state: string; reason?: string }>
    expect(malformed.map((result) => result.state)).toEqual(["problem"])
    expect(malformed[0]!.reason).toMatch(/^gate_error/)
    expect(((await fns.turn_gate!(null, ctx)) as Array<{ state: string }>)[0]!.state).toBe("problem")
  })

  it("turn_gate reads the file after the turn under the repo root, never outside it", async () => {
    const root = app({ "src/contact.tsx": "<button onClick={() => {\n  open()\n  fbq('track', 'Lead')\n}}>x</button>" })
    const fns = o9CheckFunctions({ version: "t", root })
    const diff = { files: [{ path: "src/contact.tsx", added: [{ line: 3, text: "  fbq('track', 'Lead')" }], removed: [] }] }
    const results = (await fns.turn_gate!({ diff, connectionIds: [] }, ctx)) as Array<{ reason?: string }>
    expect(results.map((result) => result.reason)).toEqual([
      "standard_on_click: the edit fires a standard Meta conversion from a click handler",
      "conversion_without_event_id: the edit fires a Meta conversion from the page without the server's metaEventId"
    ])
    const escape = { files: [{ path: "../outside.ts", added: [{ line: 1, text: "ok()" }], removed: [] }] }
    expect(((await fns.turn_gate!({ diff: escape, connectionIds: [] }, ctx)) as Array<{ state: string }>)[0]!.state).toBe("pass")
  })
})
