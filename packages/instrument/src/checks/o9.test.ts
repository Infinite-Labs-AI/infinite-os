// Lane O9's registration on the `CheckRunner.register` seam, against a fake runner (lane O6's real
// runner is a sibling branch; I1 wires the two).
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch } from "../../test/wizard/fixture-fetch.js"
import type { CheckFn, CheckId } from "../wizard/contracts/jobs.js"
import { buildHostGuardExpression } from "../host-guard.js"
import { buildMetaClickIdCaptureTypescript } from "../providers/meta-browser/click-id.js"

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
    const clean = (await fns.posthog_config!({ appRoot: root, before: [] }, ctx)) as Array<{ state: string }>
    expect(clean.map((result) => result.state)).toEqual(["pass"])
  })

  it("posthog_config reads the BEFORE config at the base commit with O3's input shape (review P1-7)", async () => {
    const base = "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest', defaults: '2026-01-30' })"
    const edited = "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest', defaults: '2026-01-30', autocapture: false, disable_session_recording: true })"
    const root = repo({ "src/ph.ts": base }, { "src/ph.ts": edited })
    const item = { id: "posthog_improve:proxy", allow: { files: ["src/ph.ts"], create: [] }, trigger: { finding: "posthog_not_proxied", evidence: [] } }
    const fns = o9CheckFunctions({ version: "t", root })
    const drift = (await fns.posthog_config!({ item, root, appRoot: root, runId: "run-9" }, ctx)) as Array<{ state: string; reason?: string }>
    expect(drift.map((result) => result.state)).toEqual(["problem", "problem"])
    expect(drift[0]!.reason).toContain("INF_SETUP_POSTHOG_PRIVACY_CHANGED")
    // Negative: nothing changed since the base commit.
    const same = repo({ "src/ph.ts": base }, {})
    const unchanged = (await o9CheckFunctions({ version: "t", root: same }).posthog_config!({ item, root: same, appRoot: same, runId: "run-9" }, ctx)) as Array<{ state: string }>
    expect(unchanged.map((result) => result.state)).toEqual(["pass"])
    // No base commit → the drift verdict is undetermined, never a pass.
    const noGit = app({ "src/ph.ts": edited })
    const unknown = (await o9CheckFunctions({ version: "t", root: noGit }).posthog_config!({ item, root: noGit, appRoot: noGit, runId: "run-9" }, ctx)) as Array<{ state: string }>
    expect(unknown.map((result) => result.state)).toContain("undetermined")
    expect(unknown.map((result) => result.state)).not.toContain("pass")
  })

  it("adopted_init_guarded takes the production hosts from the run (review P1-7)", async () => {
    const guard = "(function () {\n  var host = location.hostname\n  if (host === 'localhost' || host.endsWith('.vercel.app')) return\n  posthog.init('phc_abcdefghijklmnop', {})\n})()"
    const root = app({ "src/ph.ts": guard })
    const item = { id: "preview_guard:posthog", allow: { files: ["src/ph.ts"], create: [] }, trigger: { finding: "INF_SETUP_HOST_GUARD_MISSING", evidence: [{ file: "src/ph.ts", line: 4 }] } }
    const input = { item, root, appRoot: root, runId: "run-9" }
    const silenced = (await o9CheckFunctions({ version: "t", root, run: () => ({ productionHosts: ["acme.vercel.app"] }) }).adopted_init_guarded!(input, ctx)) as Array<{ state: string; reason?: string }>
    expect(silenced.map((result) => result.state)).toEqual(["problem"])
    expect(silenced[0]!.reason).toContain("INF_SETUP_HOST_GUARD_SILENCES_PRODUCTION")
    const fine = (await o9CheckFunctions({ version: "t", root, run: () => ({ productionHosts: ["acme.com"] }) }).adopted_init_guarded!(input, ctx)) as Array<{ state: string }>
    expect(fine.map((result) => result.state)).toEqual(["pass"])
    // Unknown production hosts: a found guard is undetermined, never a pass.
    const unknown = (await o9CheckFunctions({ version: "t", root }).adopted_init_guarded!(input, ctx)) as Array<{ state: string }>
    expect(unknown.map((result) => result.state)).toEqual(["undetermined"])
  })

  it("checks an annotated job guard against the run's approved emitted bytes", async () => {
    const expectedEmittedGuard = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
    const annotated = expectedEmittedGuard.replaceAll("(function (h) {", "(function (h: string) {").replace("})(h), i;", "})(h), i: number;")
    const root = app({ "src/ph.ts": `function start() { if (!(${annotated})) return; posthog.init('phc_abcdefghijklmnop', {}); }` })
    const item = { id: "preview_guard:posthog", allow: { files: ["src/ph.ts"], create: [] }, trigger: { finding: "INF_SETUP_HOST_GUARD_MISSING", evidence: [{ file: "src/ph.ts", line: 1 }] } }
    const input = { item, root, appRoot: root, runId: "run-9" }
    const check = o9CheckFunctions({ version: "t", root, run: () => ({ productionHosts: ["acme.example"], expectedEmittedGuard }) }).adopted_init_guarded!
    expect((await check(input, ctx) as Array<{ state: string }>).map((result) => result.state)).toEqual(["pass"])
    writeFileSync(join(root, "src/ph.ts"), `function start() { if (!(${annotated.replace('"acme.example"', '"other.example"')})) return; posthog.init('phc_abcdefghijklmnop', {}); }`)
    expect((await check(input, ctx) as Array<{ state: string }>).map((result) => result.state)).toEqual(["problem"])
  })

  it("returns a problem for a missing plain-module capture and passes the executable indented paste", async () => {
    const pixel = "export function boot() { fbq('init', '111222333444555'); }"
    const root = app({
      "pages/_app.tsx": "import Consent from '../components/Consent'; export default function App() { return <Consent /> }",
      "components/Consent.tsx": "import { boot } from '../src/common/tracking'; export default function Consent() { boot(); return null }",
      "src/common/tracking.ts": pixel
    })
    const item = { id: "meta_improve:capture", allow: { files: ["src/common/tracking.ts"], create: [] }, trigger: { finding: "capture", evidence: [{ file: "src/common/tracking.ts", line: 1 }] } }
    const input = { item, root, appRoot: root, runId: "run-9" }
    const check = o9CheckFunctions({ version: "t", root }).click_id_capture!
    const missing = await check(input, ctx) as Array<{ state: string; reason?: string }>
    expect(missing.map((result) => result.state)).toEqual(["problem"])
    expect(missing[0]?.reason).toContain("not executable at module load")
    const pasted = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "not_required" } }).split("\n").map((line) => `  ${line}`).join("\r\n")
    writeFileSync(join(root, "src/common/tracking.ts"), `${pasted}\r\n${pixel}`)
    const installed = await check(input, ctx) as Array<{ state: string; reason?: string }>
    expect(installed.map((result) => result.state)).toEqual(["pass"])
    expect(installed[0]?.reason).toContain("managed click-id capture")
  })

  it("job-level checks grade only the item's files and tool (review P2-3)", async () => {
    const root = app({
      "app/contact.tsx": "<button onClick={() => fbq('track', 'Lead')}>Talk</button>",
      "app/pricing.tsx": "<button onClick={() => { infiniteTrack('upgrade') }}>Upgrade</button>",
      "src/ga.ts": "if (infiniteHostAllowed(['acme.com'])) {\n  gtag('config', 'G-ABC123')\n}",
      "src/ph.ts": "posthog.init('phc_abcdefghijklmnop', {})"
    })
    const fns = o9CheckFunctions({ version: "t", root, run: () => ({ productionHosts: ["acme.com"] }) })
    const item = (id: string, file: string) => ({ id, allow: { files: [file], create: [] }, trigger: { finding: "x", evidence: [] } })
    // The item is pricing; the adopted onClick fbq on contact is not this item's.
    const onClick = (await fns.no_fbq_standard_on_click!({ item: item("conversions_to_tools:upgrade", "app/pricing.tsx"), root, appRoot: root }, ctx)) as Array<{ state: string }>
    expect(onClick.map((result) => result.state)).toEqual(["pass"])
    const onClickContact = (await fns.no_fbq_standard_on_click!({ item: item("conversions_to_tools:lead", "app/contact.tsx"), root, appRoot: root }, ctx)) as Array<{ state: string }>
    expect(onClickContact.map((result) => result.state)).toEqual(["problem"])
    // preview_guard:ga4 is not failed by the PostHog init the user declined to guard.
    const ga4 = (await fns.adopted_init_guarded!({ item: item("preview_guard:ga4", "src/ga.ts"), root, appRoot: root }, ctx)) as Array<{ state: string }>
    expect(ga4.map((result) => result.state)).toEqual(["pass"])
    // setup_rerun_clean on a site with no Meta pixel: the site-wide click-id "undetermined" is not the item's.
    const rerun = (await fns.setup_rerun_clean!({ item: item("setup_check_fixes:pricing", "app/pricing.tsx"), root, appRoot: root }, ctx)) as Array<{ state: string }>
    expect(rerun.map((result) => result.state)).toEqual(["pass"])
  })

  it("the post-turn gate fails CLOSED: a crash is a problem, never undetermined (review P2-1)", async () => {
    const fns = o9CheckFunctions({ version: "t" })
    const malformed = (await fns.turn_gate!({ diff: { files: [{ path: "a.ts", added: 7, removed: [] }] }, connectionIds: [] }, ctx)) as Array<{ state: string; reason?: string }>
    expect(malformed.map((result) => result.state)).toEqual(["problem"])
    expect(malformed[0]!.reason).toMatch(/^gate_error/)
    expect(((await fns.turn_gate!(null, ctx)) as Array<{ state: string }>)[0]!.state).toBe("problem")
  })

  it("O6's csp(url) seam: id 'csp' with {url}, the expectation from the run (review P1-8)", async () => {
    const { fetch } = fixtureFetch({ "https://acme.test/": { headers: { "content-security-policy": "default-src 'self'" }, body: "<html></html>" } })
    const withRun = o9CheckFunctions({ version: "t", fetch, attempts: 1, run: () => ({ expect: { meta: ["111222333444555"] } }) })
    const blocked = (await withRun.csp!({ url: "https://acme.test/" }, ctx)) as Array<{ checkId: string; state: string }>
    expect(blocked.map((result) => [result.checkId, result.state])).toEqual([["csp", "problem"]])
    // No expectation anywhere → undetermined (never a vacuous pass).
    const without = (await o9CheckFunctions({ version: "t", fetch, attempts: 1 }).csp!({ url: "https://acme.test/" }, ctx)) as Array<{ state: string }>
    expect(without.map((result) => result.state)).toEqual(["undetermined"])
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

  it("env_targets and live checks run through the registered functions", async () => {
    const fns = o9CheckFunctions({ version: "t", fetch: fixtureFetch({}).fetch, attempts: 1 })
    const env = (await fns.env_targets!({ envSourcedIds: [], hosting: { provider: "none", vercel: null } }, ctx)) as Array<{ state: string }>
    expect(env.map((result) => result.state)).toEqual(["info"])
    const csp = (await fns.csp_header!({ url: "https://acme.test/", expect: {} }, ctx)) as Array<{ state: string }>
    expect(csp.map((result) => result.state)).toEqual(["undetermined"])
  })
})
