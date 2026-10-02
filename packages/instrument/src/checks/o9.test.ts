// Lane O9's registration on the `CheckRunner.register` seam, against a fake runner (lane O6's real
// runner is a sibling branch; I1 wires the two).
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

  it("setup_checks and the job-level static checks run over the app", async () => {
    const root = app({
      "app/layout.tsx": "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest', defaults: '2026-01-30' })",
      "app/signup/page.tsx": "<button onClick={() => fbq('track', 'Lead')}>Go</button>\nfbq('track', 'CompleteRegistration', {}, { eventID: 'x' + id })"
    })
    const fns = o9CheckFunctions({ version: "t", root })
    const onClick = (await fns.no_fbq_standard_on_click!({ appRoot: "." }, ctx)) as Array<{ checkId: string; state: string }>
    expect(onClick.map((result) => [result.checkId, result.state])).toEqual([["no_fbq_standard_on_click", "problem"]])
    const eventIds = (await fns.meta_event_id_from_helper!({ appRoot: root }, ctx)) as Array<{ state: string }>
    expect(eventIds.map((result) => result.state)).toEqual(["problem"])
    const rerun = (await fns.setup_rerun_clean!({ appRoot: root }, ctx)) as Array<{ state: string; reason?: string }>
    expect(rerun[0]!.state).toBe("problem")
    const guarded = (await fns.adopted_init_guarded!({ appRoot: root }, ctx)) as Array<{ state: string }>
    expect(guarded.map((result) => result.state)).toEqual(["problem"])
  })

  it("posthog_config reports privacy drift against the before read", async () => {
    const root = app({ "src/ph.ts": "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest', defaults: '2026-01-30', autocapture: false })" })
    const before = [{ file: "src/ph.ts", line: 1, managed: false, readable: true, options: { api_host: "/ingest", defaults: "2026-01-30" } }]
    const fns = o9CheckFunctions({ version: "t", root })
    const drift = (await fns.posthog_config!({ appRoot: root, before }, ctx)) as Array<{ reason?: string; state: string }>
    expect(drift.map((result) => result.state)).toEqual(["problem"])
    expect(drift[0]!.reason).toContain("INF_SETUP_POSTHOG_PRIVACY_CHANGED")
    const clean = (await fns.posthog_config!({ appRoot: root }, ctx)) as Array<{ state: string }>
    expect(clean.map((result) => result.state)).toEqual(["pass"])
  })

  it("turn_gate reads the file after the turn under the repo root, never outside it", async () => {
    const root = app({ "src/contact.tsx": "<button onClick={() => {\n  open()\n  fbq('track', 'Lead')\n}}>x</button>" })
    const fns = o9CheckFunctions({ version: "t", root })
    const diff = { files: [{ path: "src/contact.tsx", added: [{ line: 3, text: "  fbq('track', 'Lead')" }], removed: [] }] }
    const results = (await fns.turn_gate!({ diff, connectionIds: [] }, ctx)) as Array<{ reason?: string }>
    expect(results.map((result) => result.reason)).toEqual(["standard_on_click: the edit fires a standard Meta conversion from a click handler"])
    const escape = { files: [{ path: "../outside.ts", added: [{ line: 1, text: "ok()" }], removed: [] }] }
    expect(((await fns.turn_gate!({ diff: escape, connectionIds: [] }, ctx)) as Array<{ state: string }>)[0]!.state).toBe("pass")
  })

  it("env_targets and live checks run through the registered functions", async () => {
    const fns = o9CheckFunctions({ version: "t", fetch: fixtureFetch({}).fetch, attempts: 1 })
    const env = (await fns.env_targets!({ envSourcedIds: [], hosting: { provider: "none", vercel: null } }, ctx)) as Array<{ state: string }>
    expect(env.map((result) => result.state)).toEqual(["info"])
    const csp = (await fns.csp_header!({ url: "https://acme.test/", expect: {} }, ctx)) as Array<{ state: string }>
    expect(csp.map((result) => result.state)).toEqual(["undetermined"])
  })
})
