// The offline end-to-end test (BUILD-PLAN §4.3, lane I1b), amended by §3z where §3z supersedes §4.3.
//
// The BUILT wizard (`node dist/src/cli.js --json`) runs as a child against the fixture Next store
// (`test/wizard/fixture-site/`), a bare git remote, the fake desktop bridge, the fake `claude` / `codex`
// / `gh` / `npm` and a `vercel` spy, in a SEALED environment whose proxies point at a listener that
// refuses and counts. Nothing reaches a network, a real agent or anyone's Infinite session. Every run
// asserts what the user, GitHub and the Infinite app would see: the NDJSON events, the exit code, the
// branch and commits on the remote, the fake gh's PR / review / threads, the bridge's calls in order, the
// files on disk.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { envProxyFetch } from "../checks/live/env-proxy-fetch.js"
import { parseCloudReport, type CloudReportContext } from "../../test/wizard/cloud-rules.js"
import { FAKE_RUN_STARTED_AT, type FakeBridgeCall } from "../../test/wizard/fake-bridge.js"
import type { ReportV2 } from "./contracts/report.js"
import { renderTerminal } from "./report.js"
import type { TestRunRequest } from "./contracts/test-engine.js"
import {
  BUILT_CLI,
  FAKE_BIN,
  FIXTURE_PIXEL_ID,
  NESTING_MARKERS,
  PLANTED_DOTENV_VALUE,
  PRODUCTION_HOST,
  bareGit,
  bareShow,
  extraPathDirs,
  git,
  makeWorld,
  mergePullRequest,
  readGhState,
  readJsonl,
  realAgentDirs,
  runWizard,
  trace,
  type E2eWorld,
  whichIn,
  type WizardRun
} from "../../test/wizard/e2e-harness.js"
import {
  CONSENT_LINE,
  CONVERSION,
  EARLY_REPORT,
  FIX_ITEM,
  ITEMS,
  LATE_REPORT,
  NEXT_CONFIG_CHILD_PROCESS_LINE,
  OUTSIDE_EDITS,
  completeAgentScenario,
  agentScenarioWithoutServerOutcome,
  completeAnswersFile,
  fixtureFile,
  fixtureHosting,
  testResultFor,
  correctWorkerResultFor
} from "../../test/wizard/e2e-scenario.js"

const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const RUN_TIMEOUT = 240_000

/**
 * Final verify F17: every report a run POSTed, replayed through the cloud's report parser (the port in
 * `test/wizard/cloud-rules.ts`). The fake bridge applies the same parser at the door; this replay names each
 * refused report in the test's own failure, whatever the run's exit code was.
 */
function cloudRefusedReports(calls: readonly FakeBridgeCall[]): string[] {
  const refused: string[] = []
  for (const call of calls.filter((entry) => entry.verb === "report")) {
    const body = call.body as { phase: CloudReportContext["phase"]; producer: CloudReportContext["producer"]; partial: boolean; report: unknown }
    const runId = decodeURIComponent(call.path.split("/")[3] ?? "")
    const verdict = parseCloudReport(body.report, { runId, startedAt: FAKE_RUN_STARTED_AT, phase: body.phase, producer: body.producer, partial: body.partial })
    if (!verdict.ok) refused.push(`report(${body.phase}) → HTTP ${call.status}: ${verdict.field}: ${verdict.reason}`)
  }
  return refused
}

const worlds: E2eWorld[] = []
afterEach(async () => {
  while (worlds.length > 0) {
    const w = worlds.pop()!
    const refused = cloudRefusedReports(w.bridge.calls)
    await w.close()
    expect(refused, "a report the real cloud refuses (final verify F17)").toEqual([])
  }
})

beforeAll(() => {
  if (!existsSync(BUILT_CLI)) throw new Error(`Build the package first (pnpm --filter infinite-tag build): missing ${BUILT_CLI}`)
})

/** A world with the §4.3 defaults: the fixture's hosting, the per-request test results, required checks green. */
async function wiredWorld(input: { scenario?: unknown; bridge?: Record<string, unknown>; gh?: Record<string, unknown>; env?: Record<string, string>; inlineConsent?: boolean } = {}): Promise<E2eWorld> {
  const made = await makeWorld({
    scenario: input.scenario ?? completeAgentScenario(),
    bridge: { hosting: fixtureHosting(), testResultFor: input.scenario === undefined ? correctWorkerResultFor : testResultFor, ...(input.bridge ?? {}) },
    // A required check that already passed on every head (the fix round's `pr_checks_pass` reads it).
    gh: { checks: { "42": [{ name: "build", bucket: "pass", state: "SUCCESS" }] }, ...(input.gh ?? {}) },
    ...(input.env ? { env: input.env } : {})
  })
  // The default fixture keeps consent inline. This explicitly named world exercises the separate-file variant.
  if (!input.inlineConsent) {
    const path = join(made.site.repo, "app/layout.tsx")
    const inline = readFileSync(path, "utf8")
    const script = /        <Script id="consent-default"[\s\S]*?        <\/Script>/.exec(inline)![0]
    writeFileSync(path, inline.replace('import { Providers } from "./providers"', 'import { Providers } from "./providers"\nimport { ConsentDefaults as BootstrapDefaults } from "./consent-defaults"').replace(script, "        <BootstrapDefaults />"))
    git(made.site.repo, "add", "app/layout.tsx")
    git(made.site.repo, "commit", "-q", "-m", "separate owner consent fixture")
    git(made.site.repo, "push", "-q", "origin", "main")
    made.site.initialSha = git(made.site.repo, "rev-parse", "HEAD")
  }
  // Every ref update on the remote is logged, so "never force-pushed" is checked on the real history.
  bareGit(made.site.bare, "config", "core.logAllRefUpdates", "always")
  worlds.push(made)
  return made
}

function writeAnswers(w: E2eWorld, answers: Record<string, unknown> = completeAnswersFile()): string {
  const path = join(w.site.base, "answers.json")
  writeFileSync(path, JSON.stringify(answers))
  return path
}

/** The merge-ready responder: the user merges on "GitHub", the deploy of the merge is ready, then "open". */
function mergeThenOpen(w: E2eWorld) {
  return (ask: { kind: string; payload: unknown }) => {
    if (ask.kind !== "merge-ready") return undefined
    const number = (ask.payload as { number: number }).number
    const sha = mergePullRequest(w.site, w.ghState, number)
    w.bridge.script.deploy = [
      { mergeDeployment: { state: "ready", readyAt: "2026-10-02T10:02:00.000Z" }, serving: { sha, readyAt: "2026-10-02T10:02:00.000Z", createdAt: "2026-10-02T10:01:00.000Z", ref: "main" } }
    ]
    return "open"
  }
}

/** One readable label per bridge call: the verb, plus what a PATCH sets and which test ran where. */
function label(call: FakeBridgeCall): string {
  const body = (call.body ?? {}) as Record<string, unknown>
  if (call.verb === "runs.patch") return `runs.patch(${Object.keys((body.patch ?? {}) as Record<string, unknown>).sort().join(",")})`
  if (call.verb === "test.start") {
    const targets = (body.targets ?? []) as Array<{ label: string }>
    return `test.start(${String(body.mode)}:${targets[0]?.label ?? "?"})`
  }
  if (call.verb === "report") return `report(${String(body.phase)})`
  if (call.verb === "ga4-key-events") return `ga4-key-events(${((body.names ?? []) as string[]).join(",")})`
  if (call.verb === "server-lane.provision-env") return `server-lane.provision-env(${String(body.redeploy)})`
  return call.verb ?? `${call.method} ${call.path}`
}

function stepOutcomes(run: WizardRun): string[] {
  return run.steps().map((step) => `${step.step}:${step.outcome}${step.code ? `:${step.code}` : ""}`)
}

/** An item's state changes in order (the claim is announced as it lands and again when it is applied: one). */
function jobStates(run: WizardRun, itemId: string): string[] {
  const states = run.ofType("job.state").filter((event) => event.itemId === itemId).map((event) => `${String(event.state)}/${String(event.by)}`)
  return states.filter((state, index) => index === 0 || states[index - 1] !== state)
}

function finalJobs(w: E2eWorld): Array<{ id: string; owner: string; state: string; blockedReason?: string; note?: string; ownerBoundary?: { file?: string; wiring?: string }; checks: Array<{ id: string; tier: string; state: string }>; edits?: Array<{ file: string }>; review?: { state: string; reviewer: string | null; runId: string } }> {
  return JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/state.json"), "utf8")).jobs
}

function remoteBranches(w: E2eWorld): string[] {
  return bareGit(w.site.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean)
}

function commitMessages(w: E2eWorld, range: string): Array<{ sha: string; body: string }> {
  const raw = bareGit(w.site.bare, "log", "--format=%H%x00%B%x01", range)
  return raw
    .split("\x01")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, body] = entry.split("\x00") as [string, string]
      return { sha, body }
    })
}

function isAncestor(w: E2eWorld, a: string, b: string): boolean {
  try {
    execFileSync("git", ["--git-dir", w.site.bare, "merge-base", "--is-ancestor", a, b], { env: { PATH: "/usr/bin:/bin", HOME: w.site.home } })
    return true
  } catch {
    return false
  }
}

function agentRuns(w: E2eWorld, agent: "claude" | "codex", role?: "worker" | "reviewer"): Array<{ argv: string[]; role: string; env: Record<string, unknown> & { INFINITE_TAG_KEYS: string[] } }> {
  return readJsonl<{ kind: string; agent: string; role: string; argv: string[]; env: Record<string, unknown> & { INFINITE_TAG_KEYS: string[] } }>(join(w.site.base, "agents.jsonl")).filter(
    (entry) => entry.kind === "run" && entry.agent === agent && (role === undefined || entry.role === role)
  )
}

// ---------------------------------------------------------------------------------------------
// The sealed environment (R1-10)
// ---------------------------------------------------------------------------------------------

describe("the sealed child environment", () => {
  it("resolves claude / codex / gh / npm / vercel ONLY inside test/wizard/bin, and no extra PATH dir holds an agent", async () => {
    const w = await wiredWorld()
    expect(realAgentDirs(w.env.PATH!)).toEqual([])
    for (const dir of extraPathDirs()) expect(w.env.PATH!.split(":")).toContain(dir)
    for (const tool of ["claude", "codex", "gh", "npm", "vercel"]) expect(whichIn(w.env, tool), `which ${tool}`).toBe(join(FAKE_BIN, tool))
    // No nesting marker, no CODEX_* / CLAUDE*, no real HOME / GROWTH_OS_HOME, every proxy at the tripwire.
    for (const marker of NESTING_MARKERS) expect(w.env[marker]).toBeUndefined()
    expect(Object.keys(w.env).filter((key) => key.startsWith("CODEX_") || key.startsWith("CLAUDE"))).toEqual([])
    expect(w.env.HOME?.startsWith(w.site.base)).toBe(true)
    expect(w.env.GROWTH_OS_HOME?.startsWith(w.site.base)).toBe(true)
    for (const proxy of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) expect(w.env[proxy]).toBe(w.tripwire.url)
    expect(w.env.NO_PROXY).toBe("127.0.0.1")
  })

  it("NEGATIVE: the refusing proxy really sees (and counts) a proxied request", async () => {
    const w = await wiredWorld()
    await expect(envProxyFetch(w.env)("https://acme-store.com/")).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(w.tripwire.connections).toEqual(["CONNECT acme-store.com:443 HTTP/1.1"])
  })

  it("NEGATIVE: a PATH dir holding a real-looking claude ahead of the fakes is caught by both guards", async () => {
    const w = await wiredWorld()
    const elsewhere = join(w.site.base, "elsewhere-bin")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const leaky = { ...w.env, PATH: [elsewhere, w.env.PATH].join(":") }
    expect(realAgentDirs(leaky.PATH)).toEqual([elsewhere])
    expect(whichIn(leaky, "claude")).not.toBe(join(FAKE_BIN, "claude"))
  })
})

// ---------------------------------------------------------------------------------------------
// The main run: all 13 steps, exit 0, nothing sent
// ---------------------------------------------------------------------------------------------

describe("the offline end-to-end run (§4.3)", () => {
  it("leaves an inline-consent layout byte-identical and hands wiring to its owner", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ inlineConsent: true, scenario: agentScenarioWithoutServerOutcome() })
    const component = fixtureFile("app/consent-defaults.tsx")
    const script = component.slice(component.indexOf('        <Script id="consent-default"'), component.indexOf('        </Script>') + '        </Script>'.length)
    const inline = fixtureFile("app/layout.tsx").replace('import { ConsentDefaults } from "./consent-defaults"\n', "").replace("        <ConsentDefaults />", script)
    writeFileSync(join(w.site.repo, "app/layout.tsx"), inline)
    w.site.initialSha = git(w.site.repo, "rev-parse", "HEAD")
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(stepOutcomes(run).at(-1)).toBe("done:ok")
    expect(readGhState(w.ghState).prs[0]).toMatchObject({ state: "MERGED", isDraft: false })
    expect(readFileSync(join(w.site.repo, "app/layout.tsx"), "utf8")).toBe(inline)
    expect(stepOutcomes(run), trace(run)).toEqual(expect.arrayContaining(["merge:ok", "prove:skipped"]))
    expect(run.ofType("step.done").find(event => event.step === "prove")?.reason).toContain("Add the owner wiring before testing it live")
    expect(w.bridge.callsFor("runs.proof-claim")).toEqual([])
    expect(w.bridge.callsFor("test.start").some(call => (call.body as TestRunRequest).mode === "real_visit")).toBe(false)
    expect(existsSync(join(w.site.repo, "lib/infinite-analytics.ts"))).toBe(false)
    expect(existsSync(join(w.site.repo, "app/infinite-analytics-client.tsx"))).toBe(false)
    const plan = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/plan-approvals.json"), "utf8"))
    expect(plan.ownerWiring.canWire).toBe(false)
    const ownerWiring = finalJobs(w).find(job => job.id === "unusual_layout:app/layout.tsx" && job.state === "left_for_you")
    expect(ownerWiring?.ownerBoundary?.wiring).toContain("InfiniteAnalyticsClient")
  })

  it("runs all 13 steps to run.end with exit 0 and holds every main outcome", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    const w = await wiredWorld()
    const answers = writeAnswers(w)
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    const why = trace(run)

    // ---- 1. thirteen steps, exit 0, zero connections to the refusing proxy ----
    expect(run.code, why).toBe(0)
    expect(stepOutcomes(run), why).toEqual([
      "link:ok",
      "agent:ok",
      "before:ok",
      "keys:ok",
      "plan:ok",
      "install:ok",
      "jobs:ok",
      "settings:ok",
      "rehearsal:ok",
      "review:ok",
      "merge:ok",
      "prove:ok",
      "done:ok"
    ])
    const end = run.ofType("run.end")
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ exitCode: 0, runId: RUN_ID, prUrl: "https://github.com/acme/acme-store/pull/42", reportPath: ".infinite/wizard/report.md" })
    // F17: one report per measured column, each stored (201) by the cloud's own parser, and each passes the replay.
    const reports = w.bridge.callsFor("report")
    expect(reports.map((call) => [(call.body as { phase: string }).phase, call.status]), why).toEqual([
      // §3x.7: the in-PR report before the merge card, then done's full set (in_pr again, now with the verdict).
      ["in_pr", 201],
      ["live_today", 201],
      ["in_pr", 201],
      ["proven_live", 201]
    ])
    // Every approved repair is implemented and checked. The separately excluded Meta routing repair still
    // has a measured live-site problem; a completed install is not a fabricated clean-site verdict.
    const verdict = (JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as { verdict: { state: string; headline: string; reasons: Array<{ kind: string }> } }).verdict
    expect(verdict.state, JSON.stringify(verdict)).toBe("problems")
    expect(verdict.headline).toContain("acme-store.com")
    expect(verdict.reasons.map((reason) => reason.kind)).not.toContain("approved_fix_missing")
    expect(verdict.reasons.map((reason) => reason.kind)).toContain("live_problem")
    // W14 at step level (review P1-3): ONE headline, character for character, on every surface — the terminal's closing
    // line, report.md, the PR's "what happened" comment and the report Infinite stored.
    const stored = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as ReportV2
    const markdown = readFileSync(join(w.site.repo, ".infinite/wizard/report.md"), "utf8")
    const headline = verdict.headline
    expect(renderTerminal(stored, 5_000).split("\n")[0]!.startsWith(`◆ ${headline} · run `)).toBe(true)
    expect(markdown.split("\n")[0]).toBe(`**${headline}**`)
    expect(markdown).not.toContain("- Approved fixes the wizard has not confirmed in the code: ")
    expect(markdown).not.toContain("### You said no to")
    const prComments = ((readGhState(w.ghState).prs[0] as unknown as { comments?: Array<{ body: string }> }).comments ?? []).map((comment) => comment.body)
    expect(prComments.filter((body) => body.includes(`**${headline}**`)), "the PR comment carries the verdict headline").toHaveLength(1)
    const postedLast = (reports.at(-1)!.body as { report: ReportV2 }).report
    expect(postedLast.verdict!.headline).toBe(headline)
    expect(w.bridge.calls.map(label)).not.toContain("runs.patch(phase)")
    expect(cloudRefusedReports(reports)).toEqual([])
    for (const call of reports) expect((call.body as { report: { columns: { live_today: { sha: unknown } } } }).report.columns.live_today.sha).toBeNull()
    expect(w.tripwire.connections, "something tried to reach a network through the proxy").toEqual([])
    // The live checks read the FIXTURE production site; nothing else was fetched (a third-party read was
    // refused in-process, never sent), and Node's own fetch never left loopback.
    const live = readJsonl<{ kind: string; via: string; url: string }>(join(w.site.base, "live.jsonl"))
    expect(live.filter((entry) => entry.kind === "live").length).toBeGreaterThan(0)
    for (const entry of live.filter((record) => record.kind === "live")) expect([PRODUCTION_HOST, `www.${PRODUCTION_HOST}`]).toContain(new URL(entry.url).hostname)
    expect(live.filter((entry) => entry.via === "global_fetch")).toEqual([])

    // ---- 2. the branch, its commits, the fix-round descendant, the committed receipt ----
    const branch = remoteBranches(w).find((name) => name.startsWith("infinite/tag/"))
    expect(branch, why).toMatch(/^infinite\/tag\/\d{4}-\d{2}-\d{2}-7f3c2a$/)
    const commits = commitMessages(w, `${w.site.initialSha}..${branch!}`)
    expect(commits.length, why).toBeGreaterThanOrEqual(2)
    for (const commit of commits) expect(commit.body).toContain(`Infinite-Tag-Run: ${RUN_ID}`)
    const fixCommit = commits.find((commit) => commit.body.includes("Infinite-Review-Round: 1"))
    const firstCommit = commits.at(-1)!
    expect(fixCommit, "a fix-round commit").toBeDefined()
    expect(firstCommit.body).not.toContain("Infinite-Review-Round")
    expect(isAncestor(w, firstCommit.sha, fixCommit!.sha)).toBe(true)
    // Never force-pushed: every update of the branch on the remote moved it forward.
    const updates = bareGit(w.site.bare, "reflog", "show", "--format=%H", `refs/heads/${branch!}`).split("\n").filter(Boolean).reverse()
    expect(updates.length).toBeGreaterThanOrEqual(2)
    for (let index = 1; index < updates.length; index += 1) expect(isAncestor(w, updates[index - 1]!, updates[index]!), "a non-fast-forward push").toBe(true)
    const head = bareGit(w.site.bare, "rev-parse", branch!)
    const receipt = JSON.parse(bareShow(w.site.bare, head, ".infinite/install.json")) as {
      edits: Array<{ file: string; by: string; textEdits: unknown[]; afterHash: string }>
      ids: { ga4: string[]; meta: string[]; posthog: unknown; infinite: { siteSourceKey: string } | null }
    }
    expect(receipt.edits.length).toBeGreaterThan(0)
    for (const edit of receipt.edits) expect(Array.isArray(edit.textEdits) && edit.textEdits.length > 0, `${edit.file} has textEdits`).toBe(true)
    expect(receipt.edits.some((edit) => edit.by === "agent")).toBe(true)
    expect(receipt.edits.map((edit) => edit.file)).toEqual(expect.arrayContaining(["app/layout.tsx", "app/api/auth/login/route.ts", "app/api/signup/route.ts", ".gitignore"]))
    expect(receipt.ids.infinite).toEqual({ siteSourceKey: "site_FAKEacmeStoreSourceKey" })

    // ---- 3. the fake gh: one draft PR with the marker, one COMMENT review, one reply, one resolve, ready ----
    const gh = readGhState(w.ghState)
    expect(gh.prs).toHaveLength(1)
    const pr = gh.prs[0]!
    const create = gh.calls.find((call) => call.argv[0] === "pr" && call.argv[1] === "create")!
    expect(create.argv).toContain("--draft")
    expect(pr.body).toContain(`<!-- infinite-tag:pr v1 run=${RUN_ID} -->`)
    expect(pr.body).not.toContain("- [ ]")
    // ONE review with the finding (event COMMENT; the fake gh refuses any other event). §3g.4 step 7: the fix
    // round's re-review of the new head is posted too (round 2, no new threads), so the PR holds two.
    const review = pr.reviews[0]!
    expect(review.state).toBe("COMMENTED")
    expect(review.body).toContain(`<!-- infinite-tag:review v1 run=${RUN_ID} round=1 `)
    expect(pr.reviews.slice(1).map((entry) => /round=(\d+)/.exec(entry.body)?.[1])).toEqual(["2"])
    const posted = [review.body, ...gh.threads.flatMap((thread) => thread.comments.map((comment) => comment.body))].join("\n")
    expect(posted).not.toContain(PLANTED_DOTENV_VALUE)
    expect(posted).toContain("[redacted")
    expect(posted, "the Meta pixel id is not a phone number").toContain(FIXTURE_PIXEL_ID)
    expect(gh.threads).toHaveLength(1)
    const thread = gh.threads[0]!
    expect(thread.path).toBe("app/api/signup/route.ts")
    expect(thread.comments).toHaveLength(2)
    expect(thread.comments[1]!.body).toContain("<!-- infinite-tag:reply v1 -->")
    expect(thread.isResolved).toBe(true)
    const readyAt = gh.calls.findIndex((call) => call.argv[0] === "pr" && call.argv[1] === "ready")
    expect(readyAt).toBeGreaterThan(gh.calls.findIndex((call) => call.argv[0] === "pr" && call.argv[1] === "create"))

    // ---- 4. the bridge, in EXACTLY this order (§4.3 item 4 as amended by §3z.8 / §3z.12) ----
    expect(w.bridge.calls.map(label), why).toEqual([
      // link (§3a.1/3a.3): the app answers, the code is approved, then the first link-scoped call is the
      // subscription gate (a keys read; variant b's 402 lands here).
      "status",
      "link.request",
      "link.poll",
      "keys",
      // agent: LAST, the run (worker + reviewer known only now).
      "runs.start",
      // before: hosting (the base) → keys silently (connection ids for `expect`) → dry_live of production
      // (no clicks, no fake click id) → the cloud baseline.
      "hosting",
      "keys",
      "test.start(dry_live:home)",
      "test.poll",
      "baseline",
      // keys step: the keys again (compared with what before saw live).
      "keys",
      // plan: approvedConversions.
      "runs.patch(approvedConversions)",
      // install: the site source with the consent answer — through §3y.2's site-claim (the app offers it); the
      // hosts are verified, so the cloud answers the source exactly as site-source would.
      "site-claim",
      // review P1-5: the verified path reads the workspace's claim once, to keep a proven claim's proof file in the
      // repo (every preview then serves it, so the app can tie a preview to this site without a Vercel connection).
      "site-claim-read",
      // jobs: the keys once (the connection ids the check-reason secret scan allows; review I1 P2-6).
      "keys",
      // jobs: no clickTestedConversions PATCH (a Next site's click tests are the rehearsal's, not T0).
      // settings: the cloud run (approved ∩ click-tested), conversions, the server lane (redeploy "skip");
      // no GA4 key event yet (nothing is click-tested before the rehearsal).
      "runs.get",
      "conversions",
      // §3y.6: a fresh hosting read re-checks the server lane can run before anything is written on Vercel.
      "hosting",
      "server-lane.provision-env(skip)",
      "meta-relay.status",
      "meta-relay.enable",
      // rehearsal: its context reads, the PR fields right after the PR is created (§3z.8), the rehearsal
      // under the production host, the preview's own URL, clickTestedConversions, then GA4 key events for
      // the rehearsal-tested names only.
      "keys",
      "hosting",
      "runs.patch(phase,prHeadSha,prNumber,prUrl)",
      "test.start(rehearsal:home)",
      "test.poll",
      "test.start(dry_live:preview_self)",
      "test.poll",
      "runs.patch(clickTestedConversions)",
      `ga4-key-events(${CONVERSION})`,
      // review: the fix round re-rehearses the new head; report redaction reads public ids.
      "keys",
      "hosting",
      "keys",
      "test.start(rehearsal:home)",
      "test.poll",
      "test.start(dry_live:preview_self)",
      "test.poll",
      // merge (§3x.7): the in-PR report is stored BEFORE the merge card, so the app can show it while the user decides.
      "keys",
      "report(in_pr)",
      // merge: the merge commit.
      "runs.patch(mergeSha,mergedAt,phase)",
      // prove: its reads, the deploy of the merge, the proof claim (granted), ONE real visit, receipts,
      // proofState.
      "hosting",
      "keys",
      "hosting.deploy",
      "runs.proof-claim",
      "test.start(real_visit:home)",
      "test.poll",
      "receipts",
      // prove (§3x.6 / DECISIONS §5.2): production after the deploy, with the client-side navigation `before` ran
      // (nothing sent). The merge's own address is not loaded: Vercel's deploy read names no GitHub deployment URL.
      "test.start(dry_live:home)",
      "test.poll",
      // prove: the passive P checks of the jobs now waiting for a real event (8 and 9 are checked since I1's fix round).
      "baseline",
      "runs.patch(proofState)",
      // done (§3z.12): checkinOptIn FIRST, the report once per measured phase. NO `phase: proven`: THE verdict is
      // "problems" (approved fixes are not in the code), and only "properly" moves the run to proven (§3x.6).
      "runs.patch(checkinOptIn)",
      "keys",
      "report(live_today)",
      "report(in_pr)",
      "report(proven_live)",
      "keys",
      "hosting"
    ])
    const dryLive = w.bridge.callsFor("test.start").find((call) => (call.body as { mode: string }).mode === "dry_live")!.body as Record<string, unknown>
    expect(dryLive.fakeClickId).toBeUndefined()
    expect(dryLive.clicks).toBeUndefined()
    const realVisit = w.bridge.callsFor("test.start").find((call) => (call.body as { mode: string }).mode === "real_visit")!.body as Record<string, unknown>
    expect(realVisit.targets).toHaveLength(1)
    expect(realVisit.fakeClickId).toBeUndefined()
    expect(w.bridge.callsFor("runs.proof-claim")[0]!.status).toBe(200)

    // ---- 5. source boundaries (the separate unfinished world exercises actual reversion) ----
    const headFile = (rel: string) => bareShow(w.site.bare, head, rel)
    expect(headFile("README.md")).toBe(fixtureFile("README.md"))
    expect(headFile("README.md")).not.toBe(OUTSIDE_EDITS.readme)
    expect(readFileSync(join(w.site.repo, ".env"), "utf8")).not.toContain("AGENT_WAS_HERE")
    // package.json: back to the post-install bytes (a Next server lane installs no package, so those are the
    // committed bytes), and that is what the PR carries.
    expect(headFile("package.json")).toBe(fixtureFile("package.json"))
    expect(readFileSync(join(w.site.repo, "package.json"), "utf8")).toBe(fixtureFile("package.json"))
    const state = readFileSync(join(w.site.repo, ".infinite/wizard/state.json"), "utf8")
    expect(state).not.toContain("the agent rewrote the wizard state")
    expect(JSON.parse(state)).toMatchObject({ schema: "infinite-tag.wizard-state.v1", runId: RUN_ID })
    expect(headFile("app/signup/page.tsx")).not.toContain(CONSENT_LINE.trim())
    const jobs = finalJobs(w)
    const job = (id: string) => jobs.find((entry) => entry.id === id)!
    expect(job(ITEMS.conversionsToTools).blockedReason).not.toBe("consent_touched") // Unknown multi-job ownership never becomes guessed blame.
    expect(job(ITEMS.posthogDefaults).checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "posthog_improve_applied", state: "pass" })]))
    expect(headFile("app/providers.tsx")).toContain('defaults: "2026-01-30"')
    expect(headFile("app/providers.tsx")).toContain('capture_pageview: "history_change"')
    expect(headFile("app/providers.tsx")).toContain('api_host: "/ingest"')

    // ---- 6. real guard code passes the wizard's checks; failed claims stay in the negative world ----
    // A preview guard is a judgement (does it silence previews and keep production): the review agent's answer proves
    // it, right after the agent's turns (the wizard has no check of its own to run on a Next layout's guard).
    expect(jobStates(run, ITEMS.guardPosthog).slice(0, 3)).toEqual(["claimed/agent_claim", "claimed/wizard", "done_in_code/wizard"])
    expect(job(ITEMS.guardPosthog).review).toMatchObject({ state: "pass", reviewer: "codex", runId: RUN_ID })
    expect(job(ITEMS.guardPosthog).checks.map((check) => check.id)).not.toContain("adopted_init_guarded")
    for (const id of [ITEMS.guardMeta, ITEMS.metaSpa]) {
      expect(job(id).state, JSON.stringify(job(id))).not.toMatch(/left_for_you|failed|blocked|claimed|pending/)
      expect(job(id).edits?.length, `${id} retained its checked edits`).toBeGreaterThan(0)
    }
    expect(job(ITEMS.guardMeta).review).toMatchObject({ state: "pass", reviewer: "codex" })
    expect(job(ITEMS.metaSpa).checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "spa_page_view_applied", tier: "S", state: "pass" })]))
    // Review I1 P1-5: identify/reset and the server conversion pass the wizard's own S checks (no longer stuck
    // `claimed`) and wait for a real event; each claim is announced ONCE (P3-3).
    expect(jobStates(run, ITEMS.identify)).toEqual(["claimed/agent_claim", "waiting_real_event/wizard"])
    // Job 8: checked in code, then proven by a real outcome after the deploy (the passive check, P).
    expect(jobStates(run, ITEMS.serverConversion)).toEqual(["claimed/agent_claim", "waiting_real_event/wizard", "proven/wizard"])
    // A real tick, for contrast: the duplicate GA4 init is gone and the wizard's own census says so.
    // The recorded visit fixture predates this subprocess's merge, so its PV result cannot prove this deploy.
    expect(jobStates(run, ITEMS.duplicates)).toEqual(["claimed/agent_claim", "waiting_deploy/wizard", "done_in_code/wizard"])
    expect(job(ITEMS.duplicates).note).toBe("Not checked after the deploy: Each tag once per page")
    expect(job(ITEMS.duplicates).checks.find(check => check.tier === "PV")!.state).toBe("not_run")
    const visitRequest = w.bridge.callsFor("test.start").find(call => (call.body as TestRunRequest).mode === "real_visit")!.body as TestRunRequest
    const savedState = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/state.json"), "utf8"))
    expect(Date.parse(testResultFor(visitRequest)!.startedAt)).toBeLessThan(Date.parse(savedState.steps.merge.at))

    // ---- 7. the approved proxy is really wired; build inputs contain no child process ----
    expect(job(ITEMS.posthogProxy).checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "next_rewrites_exact", state: "pass" })]))
    expect(headFile("next.config.mjs")).toContain('"https://us.i.posthog.com/:path"')
    expect(headFile("next.config.mjs")).not.toContain("child_process")
    const builds = readJsonl<{ childProcess: boolean }>(join(w.site.repo, ".next/e2e-builds.jsonl"))
    expect(builds.length).toBeGreaterThanOrEqual(2)
    expect(builds.filter((entry) => entry.childProcess)).toEqual([])

    // ---- 8. no vercel, no merge by the wizard ----
    expect(existsSync(join(w.site.base, "spy.log")) ? readFileSync(join(w.site.base, "spy.log"), "utf8") : "").not.toContain("vercel")
    expect(gh.calls.filter((call) => call.argv[0] === "pr" && call.argv[1] === "merge")).toEqual([])

    // The agents ran as §3f.7 says (the pinned models at xhigh; Claude restricted; Codex under its read-only
    // profile, never `-s`), with no nesting marker and no wizard token in their env.
    const worker = agentRuns(w, "claude", "worker")
    expect(worker.length, why).toBe(2)
    expect(worker[0]!.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--restricted", "--model", "claude-opus-4-8", "--effort", "xhigh", "--strict-mcp-config"]))
    for (const forbidden of ["--bare", "--dangerously-skip-permissions", "--safe-mode"]) expect(worker[0]!.argv).not.toContain(forbidden)
    // One complete jobs turn; the review fix is its own bounded session.
    expect(worker.map((entry) => entry.argv.includes("--resume"))).toEqual([false, false])
    const reviewer = agentRuns(w, "codex", "reviewer")
    expect(reviewer.length).toBe(2)
    expect(reviewer[0]!.argv).toEqual(expect.arrayContaining(["exec", "--json", "-m", "gpt-6.1-sol", 'model_reasoning_effort="xhigh"', 'default_permissions="infinite_tag_ro"', "--output-schema", "-o"]))
    expect(reviewer[0]!.argv).not.toContain("-s")
    for (const entry of [...worker, ...reviewer]) {
      for (const marker of NESTING_MARKERS) expect(entry.env[marker], marker).toBeUndefined()
    }
    expect(worker[0]!.env.INFINITE_TAG_KEYS).toEqual([])
    // The review fix landed: the outcome now runs after the success branch.
    expect(headFile("app/api/signup/route.ts")).toContain(LATE_REPORT.trim())
    expect(headFile("app/api/signup/route.ts")).not.toContain(EARLY_REPORT.trim())
    expect(jobStates(run, FIX_ITEM)[0]).toBe("claimed/agent_claim")
    void NEXT_CONFIG_CHILD_PROCESS_LINE
    void git
  })
})

