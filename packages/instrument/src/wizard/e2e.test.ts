import { REVIEW_ITEMS } from "./contracts/agents.js"
// The offline end-to-end test (BUILD-PLAN §4.3, lane I1b), amended by §3z where §3z supersedes §4.3.
//
// The BUILT wizard (`node dist/src/cli.js --json`) runs as a child against the fixture Next store
// (`test/wizard/fixture-site/`), a bare git remote, the fake desktop bridge, the fake `claude` / `codex`
// / `gh` / `npm` and a `vercel` spy, in a SEALED environment whose proxies point at a listener that
// refuses and counts. Nothing reaches a network, a real agent or anyone's Infinite session. Every run
// asserts what the user, GitHub and the Infinite app would see: the NDJSON events, the exit code, the
// branch and commits on the remote, the fake gh's PR / review / threads, the bridge's calls in order, the
// files on disk.
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"
import ts from "typescript"

import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { envProxyFetch } from "../checks/live/env-proxy-fetch.js"
import { parseCloudReport, type CloudReportContext } from "../../test/wizard/cloud-rules.js"
import { FAKE_PROOF_BODY, FAKE_RESERVED_SITE_KEY, FAKE_RUN_STARTED_AT, type FakeBridgeCall } from "../../test/wizard/fake-bridge.js"
import type { TagHosting, TagKeys } from "./contracts/bridge.js"
import type { ReportV2 } from "./contracts/report.js"
import { renderTerminal } from "./report.js"
import { buildHostGuardExpression } from "../host-guard.js"
import type { TestResult, TestRunRequest } from "./contracts/test-engine.js"
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
  saveGhState,
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
  GA4_AGAIN,
  GTAG_LOADER,
  agentScenario,
  agentScenarioWithoutServerOutcome,
  replaceStep,
  answersFile,
  codexWorkerScenario,
  usageLimitTurn,
  duplicateRemovalSteps,
  fixtureFile,
  fixtureHosting,
  testResultFor
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
    scenario: input.scenario ?? agentScenario(),
    bridge: { hosting: fixtureHosting(), testResultFor, ...(input.bridge ?? {}) },
    // A required check that already passed on every head (the fix round's `pr_checks_pass` reads it).
    gh: { checks: { "42": [{ name: "build", bucket: "pass", state: "SUCCESS" }] }, ...(input.gh ?? {}) },
    ...(input.env ? { env: input.env } : {})
  })
  // The default fixture keeps consent inline. This explicitly named world exercises the separate-file variant.
  if (!input.inlineConsent) {
    const path = join(made.site.repo, "app/layout.tsx")
    const inline = readFileSync(path, "utf8")
    const script = /        <Script id="consent-default"[\s\S]*?        <\/Script>/.exec(inline)![0]
    writeFileSync(path, inline.replace('import { Providers } from "./providers"', 'import { Providers } from "./providers"\nimport { ConsentDefaults } from "./consent-defaults"').replace(script, "        <ConsentDefaults />"))
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

/**
 * Runs a managed module's bootstrap (the script the module appends) in node:vm with a stub DOM at `host`
 * + `path`: the script srcs it loads and the options each PostHog init was queued with. No network.
 */
function runBootstrap(source: string, host: string, path: string): { loaded: string[]; posthogInits: Array<Record<string, unknown>> } {
  const loaded: string[] = []
  const element = (): Record<string, unknown> => ({ setAttribute() {}, parentNode: { insertBefore: (node: { src?: string }) => loaded.push(String(node.src)) } })
  const document = {
    head: { appendChild: (node: { src?: string }) => loaded.push(String(node.src)) },
    createElement: element,
    getElementsByTagName: () => [element()],
    cookie: "",
    referrer: "",
    readyState: "complete",
    visibilityState: "visible",
    addEventListener() {}
  }
  const global: Record<string, unknown> = {
    document,
    location: { hostname: host, pathname: path, href: `https://${host}${path}`, search: "", protocol: "https:" },
    navigator: { userAgent: "e2e" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    setTimeout,
    clearTimeout
  }
  global.window = global
  vm.createContext(global)
  vm.runInContext(source, global)
  const queued = ((global.posthog as { _i?: unknown[][] } | undefined)?._i ?? []) as unknown[][]
  return { loaded, posthogInits: queued.map((entry) => entry[1] as Record<string, unknown>) }
}

/** Commits the world's repo as it is now and pushes it, so the wizard starts from that production. */
function commitAndPush(w: E2eWorld, message: string): void {
  git(w.site.repo, "add", "-A")
  git(w.site.repo, "commit", "-q", "-m", message)
  git(w.site.repo, "push", "-q", "origin", "main")
}

function writeAnswers(w: E2eWorld, answers: Record<string, unknown> = answersFile()): string {
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

function finalJobs(w: E2eWorld): Array<{ id: string; owner: string; state: string; blockedReason?: string; note?: string; ownerBoundary?: { file?: string; wiring?: string }; checks: Array<{ id: string; tier: string; state: string }>; edits?: Array<{ file: string }> }> {
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

function headOfBranch(w: E2eWorld): { branch: string; head: string } | null {
  const branch = remoteBranches(w).find((name) => name.startsWith("infinite/tag/"))
  return branch ? { branch, head: bareGit(w.site.bare, "rev-parse", branch) } : null
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
  it("request 4 CI: a current once-per-tool visit proves duplicate removal end to end", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ bridge: { testResultFor: (request: TestRunRequest) => {
      const result = testResultFor(request)
      if (result && request.mode === "real_visit") {
        // Unlike the static recording used below, this measurement occurs after this subprocess's merge.
        result.startedAt = new Date().toISOString()
        result.finishedAt = result.startedAt
      }
      return result
    } } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(jobStates(run, ITEMS.duplicates), JSON.stringify(finalJobs(w).find(job => job.id === ITEMS.duplicates))).toEqual(["claimed/agent_claim", "waiting_deploy/wizard", "proven/wizard"])
    expect(finalJobs(w).find(job => job.id === ITEMS.duplicates)!.checks.find(check => check.tier === "PV")!.state).toBe("pass")
  })

  it("leaves an inline-consent layout byte-identical and hands wiring to its owner", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ inlineConsent: true, scenario: agentScenarioWithoutServerOutcome() })
    const component = fixtureFile("app/consent-defaults.tsx")
    const script = component.slice(component.indexOf('        <Script id="consent-default"'), component.indexOf('        </Script>') + '        </Script>'.length)
    const inline = fixtureFile("app/layout.tsx").replace('import { ConsentDefaults } from "./consent-defaults"\n', "").replace("        <ConsentDefaults />", script)
    writeFileSync(join(w.site.repo, "app/layout.tsx"), inline)
    w.site.initialSha = git(w.site.repo, "rev-parse", "HEAD")
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(readFileSync(join(w.site.repo, "app/layout.tsx"), "utf8")).toBe(inline)
    expect(stepOutcomes(run)).toContain("prove:skipped")
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
    // §3x.6: ONE verdict from what was measured. Approved fixes the scenario leaves undone (a consent-touching edit, a
    // claim with no work, blocked guards) make it "problems", so the run is never PATCHed proven.
    const verdict = (JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as { verdict: { state: string; headline: string; reasons: Array<{ kind: string }> } }).verdict
    expect(verdict.state).toBe("problems")
    expect(verdict.headline.startsWith("acme-store.com does not collect properly yet:")).toBe(true)
    expect(verdict.reasons.map((reason) => reason.kind)).toContain("approved_fix_missing")
    // W14 at step level (review P1-3): ONE headline, character for character, on every surface — the terminal's closing
    // line, report.md, the PR's "what happened" comment and the report Infinite stored.
    const stored = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as ReportV2
    const markdown = readFileSync(join(w.site.repo, ".infinite/wizard/report.md"), "utf8")
    const headline = verdict.headline
    expect(renderTerminal(stored, 5_000).split("\n")[0]!.startsWith(`◆ ${headline} · run `)).toBe(true)
    expect(markdown.split("\n")[0]).toBe(`**${headline}**`)
    expect(markdown).toContain("- Approved fixes the wizard has not confirmed in the code: ")
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

    // ---- 5. the reverts ----
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
    expect(job(ITEMS.posthogDefaults)).toMatchObject({ state: "blocked", blockedReason: "outside_allowlist" })

    // ---- 6. a claimed job with a failing check is never ticked; jobs 8 and 9 are now checked by the wizard ----
    expect(jobStates(run, ITEMS.guardPosthog)).toEqual(["claimed/agent_claim", "pending/wizard", "failed/wizard"])
    expect(job(ITEMS.guardPosthog).state).toBe("failed")
    expect(jobStates(run, ITEMS.guardPosthog).some((entry) => entry.startsWith("done_in_code"))).toBe(false)
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

    // ---- 7. the post-turn gate: child_process in next.config.mjs never built ----
    // §3x.2: the refused hunk is undone and the job is sent back with the gate's real words (never "outside the job's
    // files"); the fake agent never fixes it, so it ends failed with that note and an S `turn_gate` problem.
    expect(job(ITEMS.posthogProxy)).toMatchObject({ state: "failed" })
    // R4-1: the note also says where the job's change is now (its other edit, to app/providers.tsx, was undone).
    expect(job(ITEMS.posthogProxy).note).toMatch(/the wizard's safety check refused next\.config\.mjs:\d+: the edit starts a child process\. This run's agent edits for it were undone \(app\/providers\.tsx\)\.$/)
    expect(job(ITEMS.posthogProxy).checks.find((check) => check.id === "turn_gate")).toMatchObject({ tier: "S", state: "problem" })
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
    expect(worker.length).toBe(5)
    expect(worker[0]!.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--restricted", "--model", "claude-opus-4-8", "--effort", "xhigh", "--strict-mcp-config"]))
    for (const forbidden of ["--bare", "--dangerously-skip-permissions", "--safe-mode"]) expect(worker[0]!.argv).not.toContain(forbidden)
    // Jobs rounds 2–4 resume the same session with the wizard's notes; the review's fix round is its own.
    expect(worker.map((entry) => entry.argv.includes("--resume"))).toEqual([false, true, true, true, false])
    const reviewer = agentRuns(w, "codex", "reviewer")
    expect(reviewer.length).toBe(2)
    expect(reviewer[0]!.argv).toEqual(expect.arrayContaining(["exec", "--json", "-m", "gpt-6.1-sol", 'model_reasoning_effort="xhigh"', 'default_permissions="infinite_tag_ro"', "--output-schema", "-o"]))
    expect(reviewer[0]!.argv).not.toContain("-s")
    for (const entry of [...worker, ...reviewer]) {
      for (const marker of NESTING_MARKERS) expect(entry.env[marker], marker).toBeUndefined()
    }
    expect(worker[0]!.env.INFINITE_TAG_KEYS).toEqual([])
    // Claude's permission denials (the repo's .env, the app's session file) became incident lines.
    const subs = run.ofType("step.sub").filter((event) => event.step === "jobs").map((event) => String(event.text))
    expect(subs).toContain("! Claude Code tried to read .env (denied)")
    expect(subs.some((text) => text.includes("auth.json outside the repo (denied)"))).toBe(true)

    // The review fix landed: the outcome now runs after the success branch.
    expect(headFile("app/api/signup/route.ts")).toContain(LATE_REPORT.trim())
    expect(headFile("app/api/signup/route.ts")).not.toContain(EARLY_REPORT.trim())
    expect(jobStates(run, FIX_ITEM)[0]).toBe("claimed/agent_claim")
    void NEXT_CONFIG_CHILD_PROCESS_LINE
    void git
  })
})

// ---------------------------------------------------------------------------------------------
// The negative variants (§4.3 a–h)
// ---------------------------------------------------------------------------------------------

describe("a strict pages-router site with adopted tags and fork-only access", () => {
  it("runs a scripted worker through annotated guard, rewrites and capture while refusing a privacy edit", { timeout: RUN_TIMEOUT }, async () => {
    const guard = buildHostGuardExpression({ mode: "deny", exempt: [PRODUCTION_HOST, `www.${PRODUCTION_HOST}`, "acme-store.vercel.app"], deny: [] })
      .replaceAll("(function (h) {", "(function (h: string) {")
      .replace("})(h), i;", "})(h), i: number;")
    const remote = "posthog.init('phc_FAKEtestProjectKeyNotReal000', { api_host: 'https://us.i.posthog.com' });"
    const proxy = "posthog.init('phc_FAKEtestProjectKeyNotReal000', { api_host: '/ingest', ui_host: 'https://us.posthog.com', capture_pageview: 'history_change', defaults: '2026-01-30' });"
    const start = `declare const gtag: (...args: unknown[]) => void;\ndeclare const fbq: (...args: unknown[]) => void;\ndeclare const posthog: { init(key: string, options: object): void };\nexport function boot() {\n  gtag('config', 'G-FAKE00001');\n  ${remote}\n  fbq('init', '${FIXTURE_PIXEL_ID}');\n}\n`
    const init = `  fbq('init', '${FIXTURE_PIXEL_ID}');`
    const guardedInit = `  if (typeof window !== 'undefined' && ${guard}) {\n    fbq('init', '${FIXTURE_PIXEL_ID}');\n  }`
    const posthogRules = "{ source: '/ingest/static/:path(.*)', destination: 'https://us-assets.i.posthog.com/static/:path' },\n{ source: '/ingest/array/:path(.*)', destination: 'https://us-assets.i.posthog.com/array/:path' },\n{ source: '/ingest/:path(.*)', destination: 'https://us.i.posthog.com/:path' },\n{ source: '/infinite/ledger', destination: 'https://api.ultima.inc/api/analytics/events/collect' },\n"
    const claim = (job_id: string) => ({ tool: "job_claim", args: { job_id, status: "done", note: "Applied the approved change and checked its placement." } })
    const scenario = agentScenario({ round1: [
      { tool: "job_list" },
      // Capture is installer-owned. Preserve its entry wiring and the installer's existing opt-out.
      replaceStep("src/common/tracking.ts", init, guardedInit), claim("preview_guard:meta"),
      replaceStep("src/common/tracking.ts", remote, proxy),
      { replace: { path: "next.config.js", find: "return [\n", replace: `return [\n${posthogRules}` } }, claim("posthog_improve:proxy"), claim("unusual_layout:next_config_rewrites"),
      { edit: { path: "pages/privacy.tsx", content: "export default function Privacy() { return <p>We use Infinite analytics to measure visits.</p> }\n" } }, claim("privacy_paragraph:page")
    ] }) as { claude: { turns: unknown[] }; codex: { turns: unknown[] } }
    scenario.codex.turns = [{ final: { verdict: "looks_good", summary: "The four edits pass their checks.", checklist: [], findings: [] } }]
    const w = await wiredWorld({ scenario, env: { E2E_FAST_CLOCK: "1" } })
    rmSync(join(w.site.repo, "app"), { recursive: true, force: true })
    mkdirSync(join(w.site.repo, "pages"), { recursive: true })
    mkdirSync(join(w.site.repo, "src/common"), { recursive: true })
    writeFileSync(join(w.site.repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2020", lib: ["es2020", "dom"] } }))
    writeFileSync(join(w.site.repo, "pages/_app.tsx"), "import { boot } from '../src/common/tracking'\nexport default function App({ Component, pageProps }: { Component: (props: Record<string, unknown>) => unknown; pageProps: Record<string, unknown> }) { if (typeof window !== 'undefined') boot(); return <Component {...pageProps} /> }\n")
    writeFileSync(join(w.site.repo, "pages/index.tsx"), "export default function Home() { return <main>Start</main> }\n")
    writeFileSync(join(w.site.repo, "pages/privacy.tsx"), "export default function Privacy() { return <p>We measure visits.</p> }\n")
    writeFileSync(join(w.site.repo, "src/common/tracking.ts"), start)
    writeFileSync(join(w.site.repo, "next.config.js"), "module.exports = { async rewrites() { const docs = 'https://docs.acme.example'; return [\n{ source: '/v:version\\x28.*)', destination: '/api/version' },\n{ source: '/docs/:path*', destination: `${docs}/:path*` }\n] } }\n")
    commitAndPush(w, "Strict pages-router worker site")
    const approvals = answersFile()
    const plan = approvals.plan as { approved: string[]; declined: string[] }
    approvals.privacyText = true
    plan.approved.push("capture_beside_adopted_pixel:meta:capture", "improve_additive:posthog:proxy", "preview_guard_adopted:meta:init", "privacy_text")
    ;(plan as { edits?: Record<string, string> }).edits = { privacy_text: "We use Infinite analytics to measure visits." }
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w, approvals)], respond: (ask) => ask.kind === "merge-ready" ? "later" : undefined, timeoutMs: RUN_TIMEOUT })
    const jobs = finalJobs(w)
    for (const id of ["meta_improve:capture", "preview_guard:meta", "posthog_improve:proxy", "unusual_layout:next_config_rewrites"]) {
      const job = jobs.find((entry) => entry.id === id)
      expect(job, `${id}: ${trace(run)}`).toBeDefined()
      expect(job!.checks.some((check) => check.tier === "S" && check.state === "pass"), `${id}: ${JSON.stringify(job)}`).toBe(true)
      expect(job!.checks.some((check) => check.state === "problem"), `${id}: ${JSON.stringify(job)}`).toBe(false)
    }
    expect(agentRuns(w, "claude", "worker").length).toBeGreaterThan(0)
    expect(jobs.find((entry) => entry.id === "meta_improve:capture")!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fbc_capture", tier: "T0", state: "pass" })]))
    expect(readFileSync(join(w.site.repo, "src/common/tracking.ts"), "utf8")).toContain("function (h: string)")
    expect(readFileSync(join(w.site.repo, "next.config.js"), "utf8")).toContain("\\x28")
    expect(readFileSync(join(w.site.repo, "pages/privacy.tsx"), "utf8")).toContain("We measure visits.")
    expect(jobs.some(entry => entry.id.startsWith("privacy_paragraph:"))).toBe(false)
    expect(readGhState(w.ghState).prs).toHaveLength(1)
    const program = ts.createProgram([join(w.site.repo, "src/common/tracking.ts")], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], skipLibCheck: true })
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  })

  it("opens the PR from the viewer fork and leaves absent preview checks unmeasured", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({
      gh: { repo: { nameWithOwner: "acme/acme-store", isPrivate: true, defaultBranch: "main", viewerPermission: "TRIAGE", allowForking: true }, deployments: [] },
      env: { E2E_NO_AGENTS: "1", E2E_FAST_CLOCK: "1" }
    })
    rmSync(join(w.site.repo, "app"), { recursive: true, force: true })
    mkdirSync(join(w.site.repo, "pages/api"), { recursive: true })
    mkdirSync(join(w.site.repo, "src/common"), { recursive: true })
    writeFileSync(join(w.site.repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, jsx: "preserve", target: "es2020", module: "esnext" } }))
    writeFileSync(join(w.site.repo, "pages/_app.tsx"), "import { boot } from '../src/common/tracking'\nexport default function App({ Component, pageProps }: { Component: (props: Record<string, unknown>) => unknown; pageProps: Record<string, unknown> }) { if (typeof window !== 'undefined') boot(); return <Component {...pageProps} /> }\n")
    writeFileSync(join(w.site.repo, "pages/index.tsx"), "export default function Home() { return <main><a href='/signup'>Start</a></main> }\n")
    writeFileSync(join(w.site.repo, "pages/privacy.tsx"), "export default function Privacy() { return <p>We measure visits.</p> }\n")
    writeFileSync(join(w.site.repo, "pages/api/mailing-list.ts"), "export default async function handler(req: unknown, res: { status(n: number): { json(value: unknown): void } }) { res.status(200).json({ subscribed: true }) }\n")
    writeFileSync(join(w.site.repo, "src/common/tracking.ts"), "declare const gtag: (...args: unknown[]) => void; declare const fbq: (...args: unknown[]) => void; declare const posthog: { init(key: string, options: object): void }; export function boot() { gtag('config', 'G-FAKE00001'); posthog.init('phc_FAKEtestProjectKeyNotReal000', { api_host: '/ingest' }); fbq('init', '1234567890123456'); }\n")
    writeFileSync(join(w.site.repo, "next.config.js"), `module.exports = { async rewrites() { const docs = 'https://docs.acme.example'; return [\n{ source: '/v:version(\\\\d+)', destination: '/api/version' },\n{ source: '/docs/:path*', destination: \`\${docs}/:path*\` },\n{ source: '/ingest/static/:path(.*)', destination: 'https://us-assets.i.posthog.com/static/:path' },\n{ source: '/ingest/array/:path(.*)', destination: 'https://us-assets.i.posthog.com/array/:path' },\n{ source: '/ingest/:path(.*)', destination: 'https://us.i.posthog.com/:path' }\n] } }\n`)
    commitAndPush(w, "Strict pages-router site with adopted analytics")
    const fork = join(w.site.base, "viewer-fork.git")
    execFileSync("git", ["clone", "--bare", w.site.bare, fork])
    git(w.site.repo, "config", `url.file://${fork}.insteadOf`, "https://github.com/acme-dev/acme-store.git")
    const gh = readGhState(w.ghState)
    gh.forkRemote = fork
    saveGhState(w.ghState, gh)
    const run = await runWizard({
      cwd: w.site.repo,
      env: w.env,
      args: ["--json", "--answers", writeAnswers(w)],
      respond: (ask) => ask.kind === "confirm" ? true : ask.kind === "merge-ready" ? "later" : undefined,
      timeoutMs: RUN_TIMEOUT
    })
    expect(run.steps(), trace(run)).toEqual(expect.arrayContaining([expect.objectContaining({ step: "rehearsal", outcome: "ok" })]))
    expect(readGhState(w.ghState).prs[0]).toMatchObject({ state: "OPEN", headRefName: expect.stringMatching(/^infinite\/tag\//) })
    expect(bareGit(w.site.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n")).toEqual(["main"])
    expect(bareGit(fork, "for-each-ref", "--format=%(refname:short)", "refs/heads/")).toContain(readGhState(w.ghState).prs[0]!.headRefName)
    expect(run.ofType("step.sub").map((event) => String(event.text)).join(" ")).toMatch(/undetermined|not exercised|no preview/i)
  })
})

describe("the negative variants (§4.3 a–h)", () => {
  it("(a) Claude hits its usage limit mid-jobs → exit 3, the tree back to the post-install bytes, and a re-run resumes from `jobs`", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ scenario: agentScenario({ prefixTurns: [usageLimitTurn()] }) })
    const answers = writeAnswers(w)
    const first = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(first.code, trace(first)).toBe(3)
    expect(stepOutcomes(first).slice(-1), trace(first)).toEqual(["jobs:parked:INF_WIZ_AGENT_OUT_OF_USAGE"])
    // The agent's edit (it removed the duplicate) is undone; the install's own edits stay.
    const layout = readFileSync(join(w.site.repo, "app/layout.tsx"), "utf8")
    expect(layout.split(GTAG_LOADER.trim()).length - 1).toBe(2)
    expect(layout).toContain("<InfiniteAnalyticsClient />")
    expect(headOfBranch(w), "nothing was pushed").toBeNull()
    const session = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/state.json"), "utf8")).agent.workerSession
    expect(session).toMatchObject({ kind: "claude" })

    const second = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(second.code, trace(second)).toBe(0)
    expect(second.ofType("run.start")[0]).toMatchObject({ resumedFrom: "jobs" })
    const outcomes = stepOutcomes(second)
    for (const step of ["before", "plan", "install"]) expect(outcomes).toContain(`${step}:skipped`)
    expect(outcomes).toContain("jobs:ok")
    // The same session is resumed (never another provider, never a fresh one).
    const resumed = agentRuns(w, "claude", "worker")[1]!.argv
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(session.sessionId)
  })

  it("(b) the app answers 402 on keys → exit 4, nothing started", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ bridge: { errors: { keys: { code: "subscription_required" } } } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(4)
    expect(stepOutcomes(run)).toEqual(["link:blocked:INF_WIZ_SUBSCRIPTION_REQUIRED"])
    expect(w.bridge.calls.map(label)).toEqual(["status", "link.request", "link.poll", "keys"])
    expect(remoteBranches(w)).toEqual(["main"])
    expect(agentRuns(w, "claude")).toEqual([])
  })

  it("(c) no agents (the resolver injected EMPTY) → deterministic lanes only, agent jobs need you, still reaches done", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ env: { E2E_NO_AGENTS: "1" } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(stepOutcomes(run).at(-1)).toBe("done:ok")
    // The fakes are still on PATH; nothing spawned them.
    expect(agentRuns(w, "claude")).toEqual([])
    expect(agentRuns(w, "codex")).toEqual([])
    expect(w.bridge.callsFor("runs.start")[0]!.body).toMatchObject({ worker: "none", reviewer: "brief" })
    const agentJobs = finalJobs(w).filter((job) => job.owner === "agent" && !job.id.startsWith("review_comments"))
    expect(agentJobs.length).toBeGreaterThan(0)
    for (const job of agentJobs) expect(job, job.id).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    expect(existsSync(join(w.site.repo, ".infinite/wizard/review-brief.md"))).toBe(true)
    // The deterministic install shipped anyway.
    const head = headOfBranch(w)!
    expect(bareShow(w.site.bare, head.head, "lib/infinite-analytics.ts")).toContain("Managed by Infinite")
  })

  it.each(["not_required", "required"] as const)("(d) --yes accepts the shown %s consent default without a flag", { timeout: RUN_TIMEOUT }, async consentMode => {
    const w = await wiredWorld()
    if (consentMode === "not_required") {
      writeFileSync(join(w.site.repo, "app/consent-defaults.tsx"), "export function ConsentDefaults() { return null }\n")
      git(w.site.repo, "add", "app/consent-defaults.tsx")
      git(w.site.repo, "commit", "-q", "-m", "fixture without consent signs")
      git(w.site.repo, "push", "-q", "origin", "main")
      w.site.initialSha = git(w.site.repo, "rev-parse", "HEAD")
    }
    // Only the GA4 stream (a key choice --yes never makes): everything else is --yes's.
    const answers = writeAnswers(w, { v: 1, asks: [{ kind: "single", match: "GA4", answer: "G-FAKE00001" }, { kind: "merge-ready", answer: "later" }] })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--yes", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(run), trace(run)).toContain("plan:ok")
    expect(stepOutcomes(run)).not.toContain("plan:parked:INF_WIZ_NEEDS_ANSWERS")
    const saved = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/state.json"), "utf8"))
    expect(saved.plan.answers.consentMode).toBe(consentMode)
    const registrations = [...w.bridge.callsFor("site-source"), ...w.bridge.callsFor("site-claim")]
    expect(registrations.some(call => (call.body as { consentMode?: string }).consentMode === consentMode), trace(run)).toBe(true)
  })

  it("(e) nested: job.seeded briefs (exit 3) → the parent agent edits → --resume --json fences it; an answers file never answers consent", { timeout: 3 * RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ env: { CLAUDECODE: "1" } })
    const answers = writeAnswers(w)
    // 1. The answers file carries consentMode, and nested mode ignores it: the run parks for the user's own terminal.
    const ignored = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(ignored.code, trace(ignored)).toBe(3)
    expect(stepOutcomes(ignored).at(-1)).toBe("plan:parked:INF_WIZ_NEEDS_ANSWERS")
    expect(w.bridge.callsFor("site-source")).toEqual([])
    expect(w.bridge.callsFor("site-claim")).toEqual([])

    // 2. The user answers the wizard's own /dev/tty prompt; the jobs go to the parent agent as job.seeded.
    const tty = join(w.site.base, "tty.json")
    writeFileSync(tty, JSON.stringify({ default: true, lines: { consent_mode: { approved: true, edit: "not_required" }, conversion_names: { approved: true, edit: CONVERSION }, meta_relay: { approved: false }, privacy_text: { approved: false } } }))
    const env = { ...w.env, E2E_TTY_ANSWERS: tty }
    const seeded = await runWizard({ cwd: w.site.repo, env, args: ["--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(seeded.code, trace(seeded)).toBe(3)
    expect(stepOutcomes(seeded).at(-1)).toBe("jobs:parked:INF_WIZ_NEEDS_ANSWERS")
    const shownPlans = readJsonl(w.env.E2E_LIVE_RECORD!).filter(event => event.kind === "tty-plan")
    expect(shownPlans).toHaveLength(1)
    expect(JSON.stringify(shownPlans[0])).toContain("install_provider:infinite")
    const items = seeded.ofType("job.seeded").map((event) => (event.item as { id: string }).id)
    expect(items).toContain(ITEMS.duplicates)
    expect(readFileSync(join(w.site.repo, ".infinite/wizard/agent-brief.md"), "utf8")).toContain(ITEMS.duplicates)
    expect(agentRuns(w, "claude")).toEqual([])
    expect(agentRuns(w, "codex")).toEqual([])

    // 3. The parent agent does job 6 (allowlisted) and also edits README.md (outside every allowlist).
    const layoutPath = join(w.site.repo, "app/layout.tsx")
    const layout = readFileSync(layoutPath, "utf8")
    const second = layout.lastIndexOf(GTAG_LOADER)
    writeFileSync(layoutPath, (layout.slice(0, second) + layout.slice(second + GTAG_LOADER.length)).replace(GA4_AGAIN, ""))
    writeFileSync(join(w.site.repo, "README.md"), OUTSIDE_EDITS.readme)

    // 4. `--resume --json`: the README edit is put back (kept aside, reported); the job-6 edit is checked and ships.
    const resumed = await runWizard({ cwd: w.site.repo, env, args: ["--resume", "--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(resumed), trace(resumed)).toContain("jobs:ok")
    expect(readFileSync(join(w.site.repo, "README.md"), "utf8")).toBe(fixtureFile("README.md"))
    expect(resumed.ofType("step.sub").some((event) => event.step === "jobs" && String(event.text).includes("README.md"))).toBe(true)
    // The parent agent's bytes are kept aside, outside the repo (§3z.12 §3d.7).
    const kept = execFileSync("/usr/bin/find", [w.site.home, "-path", "*rejected/README.md"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    expect(kept).toHaveLength(1)
    expect(readFileSync(kept[0]!, "utf8")).toBe(OUTSIDE_EDITS.readme)
    expect(jobStates(resumed, ITEMS.duplicates).at(-1)).toBe("waiting_deploy/wizard")
    const head = headOfBranch(w)!
    expect(bareShow(w.site.bare, head.head, "README.md")).toBe(fixtureFile("README.md"))
    expect(bareShow(w.site.bare, head.head, "app/layout.tsx").split(GTAG_LOADER.trim()).length - 1).toBe(1)
    // Still no agent spawned: the review is a brief for the parent agent.
    expect(agentRuns(w, "claude")).toEqual([])
    expect(agentRuns(w, "codex")).toEqual([])
  })

  it("(f) merge park, then resume: ESC at merge-ready → exit 3; merged on GitHub → prove → done, exit 0", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await wiredWorld()
    const answers = writeAnswers(w)
    const parked = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: (ask) => (ask.kind === "merge-ready" ? "later" : undefined), timeoutMs: RUN_TIMEOUT })
    expect(parked.code, trace(parked)).toBe(3)
    expect(stepOutcomes(parked).at(-1)).toBe("merge:parked:INF_WIZ_MERGE_PARKED")
    const mergeSha = mergePullRequest(w.site, w.ghState, 42)
    w.bridge.script.deploy = [{ mergeDeployment: { state: "ready", readyAt: "2026-10-02T10:02:00.000Z" }, serving: { sha: mergeSha, readyAt: "2026-10-02T10:02:00.000Z", createdAt: "2026-10-02T10:01:00.000Z", ref: "main" } }]
    const callsBefore = w.bridge.calls.length

    const resumed = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(resumed.code, trace(resumed)).toBe(0)
    expect(stepOutcomes(resumed).slice(-3)).toEqual(["merge:ok", "prove:ok", "done:ok"])
    for (const step of ["rehearsal", "review"]) expect(stepOutcomes(resumed)).toContain(`${step}:skipped`)
    // No second pull request, no second review; the merge commit (never the head) is proved.
    expect(readGhState(w.ghState).prs).toHaveLength(1)
    const merged = w.bridge.calls.slice(callsBefore).find((call) => call.verb === "runs.patch" && "mergeSha" in ((call.body as { patch: object }).patch))
    expect((merged!.body as { patch: { mergeSha: string } }).patch.mergeSha).toBe(mergeSha)
    // ONE real visit, then §3x.6's post-deploy production load with `before`'s client-side navigation (nothing sent).
    expect(w.bridge.calls.slice(callsBefore).filter((call) => call.verb === "test.start").map(label)).toEqual(["test.start(real_visit:home)", "test.start(dry_live:home)"])
  })

  it("(g) the proof claim is lost → no real visit, receipts read, done (Codex works, Claude reviews)", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ scenario: codexWorkerScenario(), bridge: { proofClaim: "lost" } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--worker", "codex", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(stepOutcomes(run).slice(-2)).toEqual(["prove:ok", "done:ok"])
    expect(w.bridge.callsFor("runs.proof-claim").map((call) => call.status)).toEqual([409])
    expect(w.bridge.callsFor("test.start").filter((call) => (call.body as { mode: string }).mode === "real_visit")).toEqual([])
    expect(w.bridge.callsFor("receipts").length).toBeGreaterThan(0)
    // Codex worked under the confinement profile (§3f.7): never `-s`, the pinned model, a tool_search before job_claim.
    const worker = agentRuns(w, "codex", "worker")[0]!.argv
    expect(worker).not.toContain("-s")
    expect(worker).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol", 'model_reasoning_effort="xhigh"', 'default_permissions="infinite_tag"']))
    // The app owns proof but has supplied no visit facts; duplicate counting awaits its results.
    expect(jobStates(run, ITEMS.duplicates)).toEqual(["claimed/agent_claim", "waiting_deploy/wizard", "done_in_code/wizard"])
    expect(finalJobs(w).find(job => job.id === ITEMS.duplicates)!.note).toBe("Waiting for the Infinite app's results: Each tag once per page")
    // Claude reviewed, read-only and restricted, with the pinned model.
    const reviewer = agentRuns(w, "claude", "reviewer")[0]!.argv
    expect(reviewer).toEqual(expect.arrayContaining(["--restricted", "--model", "claude-opus-4-8", "--effort", "xhigh"]))
  })

  it("(h) uninstall --pr: its own branch first, every recorded edit reversed (agent edits too), cloud pieces after the merge", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await wiredWorld()
    const installed = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(installed.code, trace(installed)).toBe(0)
    const guideStatus = git(w.site.repo, "status", "--porcelain", "--", "docs/infinite-server-lane.md")
    const guideDiff = git(w.site.repo, "diff", "--", "docs/infinite-server-lane.md")
    expect(guideStatus, guideDiff || guideStatus).toBe("")
    expect(git(w.site.repo, "ls-files", "--", "docs/infinite-server-lane.md")).toBe("docs/infinite-server-lane.md")
    git(w.site.repo, "switch", "-q", "main")
    git(w.site.repo, "pull", "-q", "--ff-only", "origin", "main")
    const mainBefore = bareGit(w.site.bare, "rev-parse", "main")
    const receipt = JSON.parse(readFileSync(join(w.site.repo, ".infinite/install.json"), "utf8")) as { edits: Array<{ file: string; by: string }> }
    expect(receipt.edits.some((edit) => edit.by === "agent")).toBe(true)
    const callsBefore = w.bridge.calls.length

    const run = await runWizard({
      cwd: w.site.repo,
      env: w.env,
      args: ["uninstall", "--pr", "--json"],
      respond: (ask) => (ask.kind === "single" ? (ask.payload as { default: string }).default : undefined),
      timeoutMs: RUN_TIMEOUT
    })
    expect(run.code, `${trace(run)}`).toBe(0)
    // The user's branch and the remote's main are untouched; the uninstall lives on its own branch, from main.
    expect(git(w.site.repo, "status", "--porcelain", "--untracked-files=no")).toBe("")
    expect(bareGit(w.site.bare, "rev-parse", "main")).toBe(mainBefore)
    const branch = remoteBranches(w).find((name) => name.startsWith("infinite/tag/uninstall-"))!
    expect(branch).toBeDefined()
    expect(bareGit(w.site.bare, "rev-parse", `${branch}~1`)).toBe(mainBefore)
    const head = bareGit(w.site.bare, "rev-parse", branch)
    // Every recorded edit reversed: the agent's and the installer's.
    for (const file of ["app/layout.tsx", "app/api/auth/login/route.ts", "app/api/auth/logout/route.ts", "app/api/signup/route.ts", ".gitignore"]) {
      const expected = bareShow(w.site.bare, w.site.initialSha, file)
      expect(bareShow(w.site.bare, head, file), file).toBe(expected)
    }
    expect(() => bareShow(w.site.bare, head, "lib/infinite-analytics.ts")).toThrow()
    // One more PR (the uninstall), draft; no cloud piece touched yet.
    const gh = readGhState(w.ghState)
    expect(gh.prs).toHaveLength(2)
    expect(gh.prs[1]!.headRefName).toBe(branch)
    const after = w.bridge.calls.slice(callsBefore).map((call) => call.verb)
    expect(after).not.toContain("uninstall.remove-env")
    expect(after).not.toContain("uninstall.disable-site-source")
    expect(after).not.toContain("link.revoke")
  })
})

describe("the §3z.12 variants (i)–(l) and the review I1 variants", () => {
  it("(i) a 423 lock on site-source (here through §3y.2's site-claim) parks SITE_LOCKED at install (exit 3): no agent, nothing pushed", { timeout: RUN_TIMEOUT }, async () => {
    const lock = { code: "site_setup_locked" as const, state: "live_site_lock" }
    const w = await wiredWorld({ bridge: { errors: { "site-source": lock, "site-claim": lock } } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(3)
    expect(stepOutcomes(run).at(-1)).toBe("install:parked:INF_WIZ_SITE_LOCKED")
    expect(agentRuns(w, "claude")).toEqual([])
    expect(remoteBranches(w)).toEqual(["main"])
  })

  it("(j) an approved Meta relay binds while not rolled out ('ready, waiting for Infinite to switch on')", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ bridge: { metaRelay: { available: false, reason: "not_rolled_out", enabled: false, bound: null } } })
    const answers = answersFile()
    const plan = answers.plan as { approved: string[]; declined: string[] }
    const run = await runWizard({
      cwd: w.site.repo,
      env: w.env,
      args: ["--json", "--answers", writeAnswers(w, { ...answers, plan: { approved: [...plan.approved, "meta_relay"], declined: [] } })],
      respond: mergeThenOpen(w),
      timeoutMs: RUN_TIMEOUT
    })
    expect(stepOutcomes(run), trace(run)).toContain("settings:ok")
    expect(w.bridge.callsFor("meta-relay.enable")).toHaveLength(1)
    // Bound to the chosen pixel while not rolled out (§3z.7 A23): at switch-on the site already works, no re-run.
    expect(w.bridge.callsFor("meta-relay.enable")[0]!.body).toMatchObject({ enable: true })
    expect(w.bridge.script.metaRelay).toMatchObject({ available: false, reason: "not_rolled_out", enabled: true, bound: { pixelId: FIXTURE_PIXEL_ID } })
  })

  it("(k) the claim holder stopped after its visit: the resume PATCHes proofState with NO second visit", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ bridge: { hangUpAfter: ["receipts"] } })
    const answers = writeAnswers(w)
    const first = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(first).at(-1), trace(first)).toMatch(/^prove:(parked|failed|blocked)/)
    expect(w.bridge.callsFor("runs.patch").filter((call) => "proofState" in ((call.body as { patch: object }).patch))).toEqual([])
    const second = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(second.code, trace(second)).toBe(0)
    expect(w.bridge.callsFor("test.start").filter((call) => (call.body as { mode: string }).mode === "real_visit")).toHaveLength(1)
    expect(w.bridge.callsFor("runs.patch").filter((call) => "proofState" in ((call.body as { patch: object }).patch))).toHaveLength(1)
  })

  it("(l) a dev server writing build output parks DEV_SERVER_RUNNING before any agent turn (exit 3)", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld()
    mkdirSync(join(w.site.repo, ".next"), { recursive: true })
    const writer = spawn(process.execPath, ["-e", "const fs=require('fs');setInterval(()=>fs.writeFileSync('.next/dev-server.txt',String(Date.now())),100)"], { cwd: w.site.repo, stdio: "ignore" })
    try {
      const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], timeoutMs: RUN_TIMEOUT })
      expect(run.code, trace(run)).toBe(3)
      expect(stepOutcomes(run).at(-1)).toBe("jobs:parked:INF_WIZ_DEV_SERVER_RUNNING")
      expect(agentRuns(w, "claude")).toEqual([])
    } finally {
      writer.kill("SIGKILL")
    }
  })

  it("review I1 P1-1: a home page that redirects (apex → www) is proved and reported, exit 0", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld()
    const sitePath = join(w.site.base, "live-site.json")
    const routes = JSON.parse(readFileSync(sitePath, "utf8")) as Record<string, unknown>
    routes[`https://${PRODUCTION_HOST}/`] = { status: 301, headers: { location: `https://www.${PRODUCTION_HOST}/` }, body: "" }
    writeFileSync(sitePath, JSON.stringify(routes))
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(stepOutcomes(run).slice(-2)).toEqual(["prove:ok", "done:ok"])
    expect(w.bridge.callsFor("runs.patch").filter((call) => "proofState" in ((call.body as { patch: object }).patch))).toHaveLength(1)
    expect(w.bridge.callsFor("report").map((call) => (call.body as { phase: string }).phase)).toContain("proven_live")
  })

  it("review I1 P1-2: a Next site with its own next.config.mjs installs (exit 0), its config untouched, the rewrite left as a job", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld()
    const own = "/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true }\n\nexport default nextConfig\n"
    writeFileSync(join(w.site.repo, "next.config.mjs"), own)
    git(w.site.repo, "add", "next.config.mjs")
    git(w.site.repo, "commit", "-q", "-m", "next config")
    git(w.site.repo, "push", "-q", "origin", "main")
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(run), trace(run)).toContain("install:ok")
    expect(run.code, trace(run)).toBe(0)
    const head = headOfBranch(w)!
    expect(bareShow(w.site.bare, head.head, "next.config.mjs")).toBe(own)
    expect(finalJobs(w).some((job) => job.id === "unusual_layout:next_config_rewrites")).toBe(true)
  })

  it("review I1 P3-1: a parked, unmerged run re-run as is re-sends no cloud write and re-tests no preview", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await wiredWorld()
    const answers = writeAnswers(w)
    const parked = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: (ask) => (ask.kind === "merge-ready" ? "later" : undefined), timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(parked).at(-1), trace(parked)).toBe("merge:parked:INF_WIZ_MERGE_PARKED")
    const callsBefore = w.bridge.calls.length
    const again = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond: (ask) => (ask.kind === "merge-ready" ? "later" : undefined), timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(again).at(-1), trace(again)).toBe("merge:parked:INF_WIZ_MERGE_PARKED")
    for (const step of ["settings", "rehearsal"]) expect(stepOutcomes(again), trace(again)).toContain(`${step}:skipped`)
    const verbs = w.bridge.calls.slice(callsBefore).map(label)
    for (const verb of ["conversions", "server-lane.provision-env(skip)", "ga4-key-events", "runs.patch(clickTestedConversions)"]) expect(verbs.filter((entry) => entry.startsWith(verb))).toEqual([])
    expect(verbs.filter((entry) => entry.startsWith("test.start"))).toEqual([])
    // The review resumes from its saved round (no second review is posted).
    expect(readGhState(w.ghState).prs).toHaveLength(1)
  })

  it("review I2 P1-2: a server-side env name (POSTHOG_KEY) is never sent to hosting; its env check is unknown and the run goes on", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ env: { E2E_NO_AGENTS: "1" } })
    const providers = join(w.site.repo, "app/providers.tsx")
    writeFileSync(providers, readFileSync(providers, "utf8").replace('posthog.init("phc_FAKEtestProjectKeyNotReal000",', "posthog.init(process.env.POSTHOG_KEY!,"))
    commitAndPush(w, "PostHog key from the server env")
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(stepOutcomes(run), trace(run)).toContain("before:ok")
    expect(run.code, trace(run)).toBe(0)
    // The fake desktop refuses a non-public name (as the real one does since I2); the tag never asked.
    const hosting = w.bridge.calls.filter((call) => call.verb === "hosting")
    expect(hosting.length).toBeGreaterThan(0)
    for (const call of hosting) {
      expect(call.path).not.toContain("envNames")
      expect(call.status).toBe(200)
    }
    const envTargets = run.ofType("check.result").filter((event) => event.checkId === "env_targets")
    expect(envTargets.map((event) => event.state)).toEqual(["undetermined"])
    expect(String(envTargets[0]!.reason)).toContain("POSTHOG_KEY is not a public build-time name")
  })

  it("§3x.8 (R3-7): keys refuses Infinite's own workspace (409 infinite_workspace) → a clean stop at link, exit 2, the --relink line", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ bridge: { errors: { keys: { code: "foreign_site_hosts", state: "infinite_workspace" } } } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(2)
    expect(stepOutcomes(run)).toEqual(["link:failed:INF_WIZ_INFINITE_WORKSPACE"])
    expect(JSON.stringify(run.events)).toContain("This workspace is Infinite's own and cannot take a customer site. Run npx infinite-tag --relink and pick another workspace.")
    expect(w.bridge.calls.map(label)).toEqual(["status", "link.request", "link.poll", "keys"])
    expect(remoteBranches(w)).toEqual(["main"])
    expect(agentRuns(w, "claude")).toEqual([])
    expect(agentRuns(w, "codex")).toEqual([])
  })

  it("§3z.12 item 4: newly managed GA4 and PostHog ship with the preview guard and the sensitive-path options in the emitted bytes", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ env: { E2E_NO_AGENTS: "1" } })
    // The site has no GA4 and no PostHog yet (the Meta pixel stays adopted): both become NEW managed installs.
    writeFileSync(join(w.site.repo, "app/layout.tsx"), readFileSync(join(w.site.repo, "app/layout.tsx"), "utf8").replace(/ {8}<ConsentDefaults \/>[\s\S]*?<Script id="meta-pixel"/, '        <Script id="meta-pixel"'))
    writeFileSync(join(w.site.repo, "app/providers.tsx"), 'export function Providers({ children }: { children: React.ReactNode }) {\n  return <>{children}</>\n}\n')
    commitAndPush(w, "no GA4, no PostHog yet")
    expect(readFileSync(join(w.site.repo, "app/layout.tsx"), "utf8")).not.toContain("googletagmanager")
    const answers = answersFile()
    const plan = answers.plan as { approved: string[]; declined: string[] }
    const NEW_MANAGED_LINES = ["install_provider:ga4:G-FAKE00001", "install_provider:posthog:phc_FAKEtestProjectKeyNotReal000", "preview_guard_managed", "sensitive_pages:posthog:managed"]
    const approved = [...plan.approved.filter((id) => !id.includes(":ga4:") && !id.includes(":posthog:")), ...NEW_MANAGED_LINES]
    const run = await runWizard({
      cwd: w.site.repo,
      env: w.env,
      args: ["--json", "--answers", writeAnswers(w, { ...answers, plan: { approved, declined: plan.declined } })],
      respond: mergeThenOpen(w),
      timeoutMs: RUN_TIMEOUT
    })
    expect(stepOutcomes(run), trace(run)).toContain("install:ok")
    expect(run.code, trace(run)).toBe(0)
    const lines = (run.ofType("ask.open").find((event) => event.kind === "plan")?.payload as { lines?: Array<{ id: string }> } | undefined)?.lines?.map((line) => line.id) ?? []
    for (const id of NEW_MANAGED_LINES) expect(lines, id).toContain(id)
    // The PR's emitted bytes, EXECUTED (node:vm, a stub DOM): the managed module's bootstrap starts GA4 and
    // PostHog on production only (the deny-list guard silences a Vercel preview and localhost), and PostHog
    // turns session replay and autocapture off on the detector's sensitive path (/login) only.
    const head = headOfBranch(w)!
    const managed = bareShow(w.site.bare, head.head, "lib/infinite-analytics.ts")
    const literal = /^const bootstrapSource = (".*")$/m.exec(managed)
    expect(literal, "the managed module carries its bootstrap").not.toBeNull()
    const bootstrap = JSON.parse(literal![1]!) as string
    const production = runBootstrap(bootstrap, PRODUCTION_HOST, "/")
    expect(production.loaded).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-FAKE00001", "/ingest/static/array.js"])
    expect(production.posthogInits).toEqual([expect.objectContaining({ api_host: "/ingest" })])
    expect(production.posthogInits[0]).not.toHaveProperty("disable_session_recording")
    const login = runBootstrap(bootstrap, `www.${PRODUCTION_HOST}`, "/login")
    expect(login.posthogInits).toEqual([expect.objectContaining({ disable_session_recording: true, autocapture: false })])
    for (const host of ["acme-store-git-infinite-tag-acme.vercel.app", "localhost"]) {
      const silenced = runBootstrap(bootstrap, host, "/")
      expect(silenced.loaded, host).toEqual([])
      expect(silenced.posthogInits, host).toEqual([])
    }
  })

  it("review I1 P2-5: Ctrl+C mid-turn undoes the agent's edit and removes the snapshot before exit 130", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ scenario: agentScenario({ round1: [{ tool: "job_list" }, ...duplicateRemovalSteps(), { hang: true }] }) })
    const layoutPath = join(w.site.repo, "app/layout.tsx")
    const loaders = () => readFileSync(layoutPath, "utf8").split(GTAG_LOADER.trim()).length - 1
    const records = join(w.site.base, "agents.jsonl")
    const run = await runWizard({
      cwd: w.site.repo,
      env: w.env,
      args: ["--json", "--answers", writeAnswers(w)],
      timeoutMs: RUN_TIMEOUT,
      // SIGINT once the fake agent has edited and is hanging mid-turn.
      interrupt: { when: () => existsSync(records) && readFileSync(records, "utf8").includes('"hanging"'), signal: "SIGINT" }
    })
    expect(run.code, trace(run)).toBe(130)
    expect(loaders(), "the agent's removal of the duplicate loader is undone").toBe(2)
    const snapshots = join(w.site.home, "Library/Caches/infinite-tag/snapshots")
    const left = existsSync(snapshots) ? execFileSync("/usr/bin/find", [snapshots, "-name", "manifest.json"], { encoding: "utf8" }).trim() : ""
    expect(left).toBe("")
  })
})

// ---------------------------------------------------------------------------------------------
// §3y (the live-fix round): a FRESH workspace, and a second reviewer that cannot (fully) read
// ---------------------------------------------------------------------------------------------

/** The live smoke's fresh workspace: `GET /v1/keys` with no site source and nothing connected. */
function freshKeys(): TagKeys {
  return {
    infinite: { status: "not_provisioned", siteSourceKey: null, productionHosts: [], consentMode: null, consentStorageKey: null, collectPath: null },
    ga4: { status: "not_connected", propertyLabel: null, streams: [] },
    posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null },
    meta: { status: "not_connected", pixels: [] },
    serverLane: { laneState: "no_secret", envWriteGranted: false }
  }
}

/**
 * What the desktop "sees" on the fresh site: production today has no Infinite tag; the PR's preview (rehearsal) and
 * the live site after the merge carry Infinite's managed tag with the claim's RESERVED key.
 */
function freshTestResultFor(request: TestRunRequest): TestResult | undefined {
  const base = testResultFor(request)
  if (!base) return base
  const result = structuredClone(base)
  if (request.mode === "dry_live" && request.targets[0]?.label !== "preview_self") {
    result.infinite.events = []
    result.markers = { ...result.markers, infiniteEventIds: [] }
    return result
  }
  result.infinite.events = result.infinite.events.map((event) => ({ ...event, siteSourceKey: FAKE_RESERVED_SITE_KEY }))
  return result
}

/** A GitHub Deployments row as Vercel writes it (the live smoke's shape: environment "Production", production_environment false). */
function productionDeployment(id: number, sha: string, state: "success" | "failure" | "in_progress") {
  return {
    id,
    sha,
    environment: "Production",
    production_environment: false,
    creator: "vercel[bot]",
    created_at: "2026-10-02T10:01:00Z",
    statuses: [{ state, environment_url: state === "success" ? "https://acme-store-prod.vercel.app" : null }]
  }
}

describe("§3y the fresh workspace (no Infinite connections, a Vercel-hosted site) reaches a PROOF", () => {
  it("one host ask pre-filled from the repo, a site-file claim, the GitHub preview (accepted by its proof file, as the desktop does), the GitHub deploy, the proof, ONE real visit, an Infinite receipt", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    const w = await wiredWorld({ scenario: agentScenarioWithoutServerOutcome(), bridge: { keys: freshKeys(), hosting: { provider: "none", vercel: null }, testResultFor: freshTestResultFor } })
    // The repo's only hint at its live address (a CNAME file); Infinite knows none.
    mkdirSync(join(w.site.repo, "public"), { recursive: true })
    writeFileSync(join(w.site.repo, "public/CNAME"), `${PRODUCTION_HOST}\n`)
    commitAndPush(w, "cname")
    const asked: Array<{ kind: string; payload: unknown }> = []
    const respond = (ask: { kind: string; payload: unknown }) => {
      asked.push(ask)
      const payload = ask.payload as { question?: string; default?: string; number?: number }
      if (ask.kind === "single" && payload.question?.startsWith("Which address is your live site?")) return payload.default
      if (ask.kind !== "merge-ready") return undefined
      const sha = mergePullRequest(w.site, w.ghState, payload.number!)
      // Vercel deploys the merge (GitHub Deployments shows it), and the deploy serves the PR's proof file.
      const gh = readGhState(w.ghState) as unknown as { deployments: unknown[] }
      gh.deployments.push(productionDeployment(7101, sha, "success"))
      saveGhState(w.ghState, gh)
      w.bridge.script.siteFileServed = true
      return "open"
    }
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond, timeoutMs: RUN_TIMEOUT })
    const why = trace(run)

    // ---- every step ran; exit 0; nothing reached a network ----
    expect(run.code, why).toBe(0)
    expect(stepOutcomes(run), why).toEqual(["link:ok", "agent:ok", "before:ok", "keys:ok", "plan:ok", "install:ok", "jobs:ok", "settings:ok", "rehearsal:ok", "review:ok", "merge:ok", "prove:ok", "done:ok"])
    expect(w.tripwire.connections).toEqual([])

    // ---- 1. ONE host ask, pre-filled from the repo's CNAME; "Live site: <host> (you said)" ----
    const hostAsks = asked.filter((ask) => (ask.payload as { question?: string }).question?.startsWith("Which address is your live site?"))
    expect(hostAsks).toHaveLength(1)
    expect((hostAsks[0]!.payload as { options: Array<{ label: string; value: string }> }).options[0]).toEqual({ label: `${PRODUCTION_HOST}  (from public/CNAME)`, value: PRODUCTION_HOST })
    const subs = run.ofType("step.sub").map((event) => String(event.text))
    expect(subs).toContain(`✓ Live site: ${PRODUCTION_HOST} (you said)`)

    // ---- 2. the plan: no pre-checked line that does nothing; the lane is a user_action; Infinite approvable with the claim wording ----
    const planAsk = run.ofType("ask.open").find((event) => event.kind === "plan")!.payload as { lines: Array<{ id: string; kind: string; requires: string; text: string }> }
    expect(planAsk.lines.find((line) => line.id === "install_provider:infinite")?.requires).toBe("info")
    expect(planAsk.lines.find((line) => line.id === "info:infinite_site_file")?.text).toContain("/.well-known/infinite-site-verification.txt")
    expect(planAsk.lines.some((line) => line.id === "server_lane")).toBe(false)
    expect(planAsk.lines.find((line) => line.id === "user_action:server_lane")?.requires).toBe("user_action")
    const budget = planAsk.lines.find((line) => line.id === "agent_budget")!
    const upTo = Number(/up to (\d+) job/.exec(budget.text)![1])
    const approvedStatus = run.ofType("step.done").find((event) => event.step === "plan")
    expect(approvedStatus).toBeDefined()
    expect(upTo).toBeGreaterThan(0)

    // ---- 3. the PR carries the managed tag with the RESERVED key, the proof file and the receipt ----
    const head = headOfBranch(w)!
    const proof = bareShow(w.site.bare, head.head, "public/.well-known/infinite-site-verification.txt")
    expect(proof).toBe(FAKE_PROOF_BODY)
    const receipt = JSON.parse(bareShow(w.site.bare, head.head, ".infinite/install.json")) as { ids: { infinite: { siteSourceKey: string } | null }; edits: Array<{ file: string; by: string; planLineId: string | null }> }
    expect(receipt.ids.infinite).toEqual({ siteSourceKey: FAKE_RESERVED_SITE_KEY })
    expect(receipt.edits.find((edit) => edit.file === "public/.well-known/infinite-site-verification.txt")).toMatchObject({ by: "wizard", planLineId: "install_provider:infinite" })
    const tagged = execFileSync("git", ["--git-dir", w.site.bare, "grep", "-l", FAKE_RESERVED_SITE_KEY, head.head], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: w.site.home } })
    expect(tagged).toMatch(/\.(tsx?|jsx?|mjs)/)

    // ---- 4. the rehearsal ran from the GitHub preview (never "not on Vercel"). Review P1-2: with no Vercel connection
    // the desktop accepts the preview only because it serves the pending claim's proof file (1bu-1 9c7d0680bc); the
    // fake applies that same rule, so a preview the real app refuses cannot pass here. ----
    expect(subs.some((text) => text.includes("no Vercel preview found") || text.includes("not on Vercel") || text.startsWith("Rehearsal: undetermined"))).toBe(false)
    const rehearsalStart = w.bridge.callsFor("test.start").find((call) => (call.body as { mode: string }).mode === "rehearsal")!
    expect((rehearsalStart.body as { rehearsal: { previewOrigin: string } }).rehearsal.previewOrigin).toBe("https://acme-store-git-infinite-tag-acme.vercel.app")
    expect(rehearsalStart.status).toBe(202)
    expect(w.bridge.callsFor("test.start").find((call) => (call.body as { targets: Array<{ label: string }> }).targets[0]?.label === "preview_self")?.status).toBe(202)

    // ---- 7. prove: deployed via GitHub, the host confirmed, ONE real visit, a verified Infinite receipt, proofState proven ----
    expect(subs.some((text) => text.startsWith("✓ Deployed") && text.includes("(GitHub deployment)"))).toBe(true)
    expect(subs.some((text) => text.includes(`${PRODUCTION_HOST} confirmed`))).toBe(true)
    const labels = w.bridge.calls.map(label)
    // The whole bridge story, in order (§3y.2 E2E order for the fresh-workspace variant): the host decided before the
    // dry load; site-claim (not site-source) at install; NO server-lane provision; NO hosting.deploy (no Vercel
    // connection: GitHub is the deploy signal); site-prove between the mergeSha PATCH and the proof claim, then the
    // keys again (the source now exists with the reserved key); ONE real visit; receipts; proofState.
    expect(labels).toEqual([
      "status", "link.request", "link.poll", "keys",
      "runs.start",
      "hosting", "keys", "test.start(dry_live:home)", "test.poll", "baseline",
      "keys",
      "runs.patch(approvedConversions)",
      "site-claim",
      "keys",
      "runs.get", "conversions",
      "keys", "hosting", "runs.patch(phase,prHeadSha,prNumber,prUrl)", "test.start(rehearsal:home)", "test.poll", "test.start(dry_live:preview_self)", "test.poll", "runs.patch(clickTestedConversions)",
      // review: no server outcome was seeded, so there is no R8 fix round or second rehearsal.
      "keys", "hosting",
      // merge (§3x.7): the in-PR report before the merge card, then the merge commit.
      "keys", "report(in_pr)",
      "runs.patch(mergeSha,mergedAt,phase)",
      "hosting", "keys", "site-prove", "keys", "runs.proof-claim", "test.start(real_visit:home)", "test.poll", "receipts",
      // §3x.6 the post-deploy loads: the merge's own GitHub deployment address (the desktop refuses it: the claim is no
      // longer pending, so nothing ties that origin to this site; open question for the app), then production with
      // `before`'s client-side navigation.
      "test.start(dry_live:preview_self)", "test.start(dry_live:home)", "test.poll",
      "baseline", "runs.patch(proofState)",
      "runs.patch(checkinOptIn)", "keys", "report(live_today)", "report(in_pr)", "report(proven_live)", "keys", "hosting"
    ])
    expect(labels).not.toContain("site-source")
    expect(labels).not.toContain("hosting.deploy")
    expect(labels.some((entry) => entry.startsWith("server-lane.provision-env"))).toBe(false)
    const at = (entry: string) => labels.indexOf(entry)
    // §3y.2 E2E order: site-claim at install; site-prove between the mergeSha PATCH and the proof claim.
    expect(at("site-claim")).toBeGreaterThan(at("runs.patch(approvedConversions)"))
    expect(at("site-prove")).toBeGreaterThan(at("runs.patch(mergeSha,mergedAt,phase)"))
    expect(at("runs.proof-claim")).toBeGreaterThan(at("site-prove"))
    expect(labels.filter((entry) => entry === "test.start(real_visit:home)")).toHaveLength(1)
    expect(at("test.start(real_visit:home)")).toBeGreaterThan(at("runs.proof-claim"))
    const visit = w.bridge.callsFor("test.start").find((call) => (call.body as { mode: string }).mode === "real_visit")!.body as { expect: { infinite?: { siteSourceKey: string } } }
    expect(visit.expect.infinite?.siteSourceKey).toBe(FAKE_RESERVED_SITE_KEY)
    const receipts = run.ofType("receipt").filter((event) => event.lane === "infinite")
    expect(receipts.at(-1)).toMatchObject({ state: "verified" })
    expect(Date.parse(String(receipts.at(-1)!.receiptAt))).toBeGreaterThan(Date.parse(FAKE_RUN_STARTED_AT))
    const proofPatch = w.bridge.callsFor("runs.patch").map((call) => (call.body as { patch: { proofState?: string } }).patch.proofState).filter(Boolean)
    // §3x.6: the run's proofState is THE verdict's. The site claim is proven and Infinite's receipt is verified, but
    // GA4, PostHog and Meta are not connected and approved fixes are not in the code, so the verdict is "problems":
    // the run is PATCHed `problem` and never moved to phase proven.
    expect(proofPatch).toEqual(["problem"])
    // The cloud: the claim proven, the source created WITH the reserved key.
    expect(w.bridge.script.claim?.state).toBe("proven")
    expect(w.bridge.script.keys.infinite.siteSourceKey).toBe(FAKE_RESERVED_SITE_KEY)
    expect(w.bridge.script.run.proofState).toBe("problem")
    expect(w.bridge.script.run.phase).not.toBe("proven")
    const report = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as {
      columns: { proven_live: { pending: string | null; measuredAt: string | null } }
      verdict: { state: string; reasons: Array<{ kind: string; names: string[] }> }
    }
    expect(report.verdict.state).toBe("problems")
    expect(report.verdict.reasons.find((reason) => reason.kind === "tool_not_connected")?.names).toEqual(["GA4 G-FAKE...0001", "PostHog phc_FA...l000", "Meta 123456...3456"])
    expect(report.columns.proven_live.pending).toBeNull()
    expect(report.columns.proven_live.measuredAt).not.toBeNull()
  })

  it("NEGATIVE: deployed, but the proof file is not served → parked HOST_UNCONFIRMED (exit 3), NO real visit, NO proof claim", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    // The 3-minute proof grace runs on the preload's virtual clock (E2E_FAST_CLOCK): the same deadlines, in seconds.
    // The proof file is served nowhere (a CDN rule), so the PR's preview does not serve it either: the desktop
    // refuses the preview (review P1-2), and the terminal says so (P2-1), never "the test window did not finish".
    const w = await wiredWorld({ scenario: agentScenarioWithoutServerOutcome(), bridge: { keys: freshKeys(), hosting: { provider: "none", vercel: null }, testResultFor: freshTestResultFor, previewServesClaimProof: false }, env: { E2E_FAST_CLOCK: "1" } })
    const respond = (ask: { kind: string; payload: unknown }) => {
      const payload = ask.payload as { question?: string; options?: Array<{ value: string }>; number?: number }
      if (ask.kind === "single" && payload.question?.startsWith("Which address is your live site?")) return "__type__"
      if (ask.kind === "text") return PRODUCTION_HOST
      if (ask.kind !== "merge-ready") return undefined
      const sha = mergePullRequest(w.site, w.ghState, payload.number!)
      const gh = readGhState(w.ghState) as unknown as { deployments: unknown[] }
      gh.deployments.push(productionDeployment(7102, sha, "success"))
      saveGhState(w.ghState, gh)
      // The deploy is live, but the proof file is NOT served (e.g. a CDN rule), so the cloud cannot confirm the host.
      w.bridge.script.siteFileOutcome = "not_served"
      return "open"
    }
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond, timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(3)
    expect(stepOutcomes(run).at(-1)).toBe("prove:parked:INF_WIZ_HOST_UNCONFIRMED")
    const labels = w.bridge.calls.map(label)
    expect(labels).not.toContain("runs.proof-claim")
    expect(labels.some((entry) => entry.startsWith("test.start(real_visit"))).toBe(false)
    expect(labels.filter((entry) => entry === "site-prove").length).toBeGreaterThanOrEqual(2)
    // No unavailable server outcome means no fix round, so only the initial rehearsal was refused.
    expect(w.bridge.callsFor("test.start").filter((call) => (call.body as { mode: string }).mode === "rehearsal").map((call) => call.status)).toEqual([400])
    expect(labels).not.toContain("test.start(dry_live:preview_self)")
    const subs = run.ofType("step.sub").map((event) => String(event.text))
    expect(subs.filter((text) => text.startsWith("Rehearsal:"))).toEqual(["Rehearsal: undetermined (the preview did not serve this pull request's proof file, e.g. it is protected)"])
    expect(subs.some((text) => text.includes("the test window did not finish"))).toBe(false)
  })
})

/** The smoke site's Vercel addresses: none is ever the production host (founder ruling 2026-10-03, only custom domains). */
const VERCEL_ALIAS = "acme-store.vercel.app"
const VERCEL_BRANCH_ALIAS = "acme-store-git-main-acme.vercel.app"
const VERCEL_HASH_URL = "acme-store-a1b2c3d4e-acme.vercel.app"
const vercelRefusal = (host: string) => `Infinite needs your site's own domain. ${host} is a Vercel address — add a custom domain in Vercel, then run npx infinite-tag again.`

describe("live run 2 + the 2026-10-03 founder ruling: a *.vercel.app site is refused, and a run with no real visit", () => {
  it("a fresh workspace whose only address is <project>.vercel.app: no vercel.app is offered, the alias and a branch alias are refused, and the run goes on with no host (no claim, no Infinite, no visit)", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    // No agents: this world is about the host ask and what follows it, not the jobs.
    const w = await wiredWorld({ bridge: { keys: freshKeys(), hosting: { provider: "none", vercel: null }, testResultFor: freshTestResultFor }, env: { E2E_NO_AGENTS: "1" } })
    // Every place round 3 took the alias from: the repo names it (CNAME) and GitHub shows Vercel's production deployment.
    mkdirSync(join(w.site.repo, "public"), { recursive: true })
    writeFileSync(join(w.site.repo, "public/CNAME"), `${VERCEL_ALIAS}\n`)
    commitAndPush(w, "cname on the vercel alias")
    const mainSha = bareGit(w.site.bare, "rev-parse", "main")
    const gh = readGhState(w.ghState) as unknown as { deployments: unknown[] }
    gh.deployments.push({ id: 7050, sha: mainSha, environment: "Production", production_environment: false, creator: "vercel[bot]", created_at: "2026-10-02T08:00:00Z", statuses: [{ state: "success", environment_url: `https://${VERCEL_HASH_URL}` }] })
    saveGhState(w.ghState, gh)
    const asked: Array<{ kind: string; payload: unknown }> = []
    const typed = [`https://${VERCEL_ALIAS}/`, VERCEL_BRANCH_ALIAS]
    const respond = (ask: { kind: string; payload: unknown }) => {
      asked.push(ask)
      const payload = ask.payload as { question?: string; number?: number }
      if (ask.kind === "single" && payload.question?.startsWith("Which address is your live site?")) return "__type__"
      if (ask.kind === "text" && payload.question?.includes("Your live site's address")) return typed.shift()
      if (ask.kind !== "merge-ready") return undefined
      const sha = mergePullRequest(w.site, w.ghState, payload.number!)
      const state = readGhState(w.ghState) as unknown as { deployments: unknown[] }
      state.deployments.push(productionDeployment(7151, sha, "success"))
      saveGhState(w.ghState, state)
      return "open"
    }
    // With no host, Infinite is not installed; the consent decision is still asked because it governs the Meta
    // click-id capture beside the site's own pixel (§3x.6: the pixel inside the <Script> template literal is now
    // seen as adopted, as it was in live run 3), so the answers carry it.
    const answers = writeAnswers(w)
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond, timeoutMs: RUN_TIMEOUT })
    const why = trace(run)
    const outcomes = stepOutcomes(run)
    expect(outcomes.slice(0, 5), why).toEqual(["link:ok", "agent:ok", "before:ok", "keys:ok", "plan:ok"])
    expect(outcomes.at(-1), why).toBe("done:ok")
    expect(w.tripwire.connections).toEqual([])

    // The host ask offered no vercel.app (the CNAME's alias dropped, nothing derived from the deployment URL).
    const hostAsk = asked.find((ask) => (ask.payload as { question?: string }).question?.startsWith("Which address is your live site?"))!
    expect((hostAsk.payload as { options: Array<{ value: string }> }).options.map((option) => option.value)).toEqual(["__type__", "__none__"])
    expect(JSON.stringify(hostAsk.payload)).not.toContain("vercel.app")

    // The production alias, then a branch alias: each refused with the founder's line, in full (never cut at 120).
    const texts = asked.filter((ask) => ask.kind === "text").map((ask) => String((ask.payload as { question: string }).question))
    expect(texts).toHaveLength(2)
    expect(texts[1]!.startsWith(`${vercelRefusal(VERCEL_ALIAS)} Or type your own domain now (ESC if it has none yet).`)).toBe(true)
    const subs = run.ofType("step.sub").map((event) => String(event.text))
    expect(subs).toContain(`! ${vercelRefusal(VERCEL_ALIAS)} Or type your own domain now (ESC if it has none yet).`)
    expect(subs).toContain(`! ${vercelRefusal(VERCEL_BRANCH_ALIAS)}`)
    expect(subs).toContain("No live site yet: the live test, Infinite's tag and the proof wait for a domain.")
    expect(subs.some((text) => text.startsWith("✓ Live site:"))).toBe(false)

    // Nothing was claimed, installed or visited on any Vercel address; Infinite's line is the "tell us your domain" one.
    const labels = w.bridge.calls.map(label)
    for (const verb of ["site-claim", "site-source", "site-prove", "runs.proof-claim", "runs.patch(proofState)"]) expect(labels, verb).not.toContain(verb)
    expect(labels.some((entry) => entry.startsWith("test.start(real_visit") || entry.startsWith("test.start(dry_live:home)"))).toBe(false)
    expect(JSON.stringify(w.bridge.calls.map((call) => call.body))).not.toMatch(/"productionHosts?":\s*\[?"[^"]*vercel\.app/)
    const planAsk = run.ofType("ask.open").find((event) => event.kind === "plan")!.payload as { lines: Array<{ id: string; requires: string }> }
    expect(planAsk.lines.some((line) => line.id === "install_provider:infinite" && line.requires === "approval")).toBe(false)
    expect(planAsk.lines.find((line) => line.id === "user_action:infinite")).toMatchObject({ requires: "user_action" })
    expect(w.bridge.script.claim ?? null).toBeNull()
    const head = headOfBranch(w)
    if (head) expect(() => bareShow(w.site.bare, head.head, "public/.well-known/infinite-site-verification.txt")).toThrow()

    // The report: no live address, so Proven live waits for a re-run with the domain.
    const report = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as { site: { productionHost: string | null }; columns: { proven_live: { pending: string | null; measuredAt: string | null } }; notes: string[] }
    expect(report.site.productionHost).toBeNull()
    expect(report.columns.proven_live).toMatchObject({ pending: "rerun_tag", measuredAt: null })
    expect(report.notes.some((note) => note.includes("--production-host"))).toBe(true)
  })

  it("--production-host on any Vercel address (the production alias, a branch alias, a hash URL, bare vercel.app) is a usage error (exit 2) before any bridge call", { timeout: RUN_TIMEOUT }, async () => {
    const w = await wiredWorld({ bridge: { keys: freshKeys(), hosting: { provider: "none", vercel: null }, testResultFor: freshTestResultFor } })
    for (const host of [VERCEL_ALIAS, VERCEL_BRANCH_ALIAS, VERCEL_HASH_URL, "vercel.app"]) {
      const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--production-host", `https://${host}`], respond: () => undefined, timeoutMs: RUN_TIMEOUT })
      expect(run.code, `${host}\n${trace(run)}`).toBe(2)
      expect(run.stderr, host).toContain(`--production-host: ${vercelRefusal(host)}`)
    }
    expect(w.bridge.calls).toEqual([])
    expect(w.tripwire.connections).toEqual([])
  })

  it("no live address (the user says it isn't live yet): no conversion question, consent only for the Meta click-id capture, and Proven live holds no pass and no problem", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    // No agents: this world is about the plan and the report, not the jobs (they would need conversions it withholds).
    const w = await wiredWorld({ bridge: { keys: freshKeys(), hosting: { provider: "none", vercel: null }, testResultFor: freshTestResultFor }, env: { E2E_NO_AGENTS: "1" } })
    const asked: Array<{ kind: string; payload: unknown }> = []
    const respond = (ask: { kind: string; payload: unknown }) => {
      asked.push(ask)
      const payload = ask.payload as { question?: string; number?: number }
      if (ask.kind === "single" && payload.question?.startsWith("Which address is your live site?")) return "__none__"
      if (ask.kind !== "merge-ready") return undefined
      const sha = mergePullRequest(w.site, w.ghState, payload.number!)
      const state = readGhState(w.ghState) as unknown as { deployments: unknown[] }
      state.deployments.push(productionDeployment(7161, sha, "success"))
      saveGhState(w.ghState, state)
      return "open"
    }
    // The consent decision is asked ONLY for what it governs here: the Meta click-id capture beside the site's own
    // pixel (§3x.6 one detector: the pixel inside the <Script> template literal is adopted). The answers carry it.
    const answers = writeAnswers(w)
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], respond, timeoutMs: RUN_TIMEOUT })
    const why = trace(run)
    const outcomes = stepOutcomes(run)
    expect(outcomes.slice(0, 5), why).toEqual(["link:ok", "agent:ok", "before:ok", "keys:ok", "plan:ok"])
    expect(outcomes.at(-1), why).toBe("done:ok")

    // R2-6: nothing consent or the conversion names govern can be installed, so neither is asked or pre-checked.
    const planAsk = run.ofType("ask.open").find((event) => event.kind === "plan")!.payload as { lines: Array<{ id: string; kind: string; requires: string }> }
    expect(planAsk.lines.some((line) => line.kind === "consent_mode")).toBe(true)
    expect(planAsk.lines.some((line) => line.kind === "capture_beside_adopted_pixel")).toBe(true)
    expect(planAsk.lines.some((line) => line.kind === "conversion_names")).toBe(false)
    expect(w.bridge.calls.map(label)).not.toContain("runs.patch(approvedConversions)")
    expect(w.bridge.calls.map(label)).not.toContain("conversions")
    expect(w.bridge.calls.map(label)).not.toContain("site-claim")
    // Review-2 P3-3: no host → the proof is never claimed and never PATCHed (the run stays unclaimed, honestly).
    expect(w.bridge.calls.map(label)).not.toContain("runs.proof-claim")
    expect(w.bridge.calls.map(label)).not.toContain("runs.patch(proofState)")
    expect(w.bridge.script.run.proofClaimedBy).toBeNull()

    // R2-2: no visit, no receipt → the Proven live column counts no pass and no problem; the headline says why.
    expect(w.bridge.calls.map(label).some((entry) => entry.startsWith("test.start(real_visit"))).toBe(false)
    const report = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/report.json"), "utf8")) as {
      columns: { proven_live: { pending: string | null } }
      rows: Array<{ id: string; cells: Record<string, { state: string; display: string }> }>
      finishLine: Array<{ id: string; cells: Record<string, { state: string }> }>
      notes: string[]
    }
    for (const line of report.finishLine) expect(["pass", "problem"], line.id).not.toContain(line.cells.proven_live!.state)
    for (const row of report.rows) expect(["pass", "problem"], row.id).not.toContain(row.cells.proven_live!.state)
    // R2-4: nothing in Infinite can finish it (no host to visit), so never "open Infinite".
    expect(report.columns.proven_live.pending).toBe("rerun_tag")
    expect(report.notes.some((note) => note.includes("--production-host"))).toBe(true)
    const markdown = readFileSync(join(w.site.repo, ".infinite/wizard/report.md"), "utf8")
    expect(markdown).not.toContain("open Infinite")
    const everything = [...run.ofType("run.end"), ...run.ofType("step.sub"), ...run.ofType("step.done")].map((event) => JSON.stringify(event)).join("\n")
    expect(everything).not.toMatch(/problems? left on the live site/)

    // R2-5: the PR's "what happened" comment was edited to carry this final report (one report everywhere).
    const pr = (readGhState(w.ghState) as unknown as { prs: Array<{ comments: Array<{ body: string; edited?: boolean }> }> }).prs[0]!
    const final = pr.comments.find((comment) => comment.body.includes("**infinite-tag: what happened**"))!
    expect(final.edited).toBe(true)
    expect(final.body).toContain("Updated after the live check")
    expect(pr.comments.filter((comment) => comment.body.includes("### Before and after"))).toHaveLength(1)
  })
})

describe("the second reviewer: incomplete opinions stay visible, never 'nothing to change'", () => {
  /** The live run's Codex: no file read, every item cant_tell, changes_suggested, no finding. */
  const blindReview = () => ({
    verdict: "changes_suggested",
    summary: "Review blocked: file-access tooling is unavailable, and your instructions prohibit commands. No repository contents were inspected.",
    checklist: REVIEW_ITEMS.filter(item => item !== "R6").map((item) => ({ item, status: "cant_tell", note: "Could not inspect files." })),
    findings: []
  })
  const scenarioWith = (codexTurns: unknown[]) => {
    const base = agentScenario() as { claude: unknown; codex: unknown }
    return { ...base, codex: { turns: codexTurns } }
  }

  it("a missing read-check after retry keeps the review and its finding visible as incomplete", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    const finding = "The owner decides whether to update the banner wording."
    const unverified = { ...blindReview(), findings: [{ id: "F1", item: "R16", category: "owner_consent_privacy", severity: "should", path: "app/layout.tsx", line: 2, body: finding, suggested_fix: null }] }
    const w = await wiredWorld({ scenario: scenarioWith([{ blind: true, final: unverified }, { blind: true, final: unverified }]) })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(agentRuns(w, "codex", "reviewer")).toHaveLength(2)
    const gh = readGhState(w.ghState)
    expect(gh.prs[0]!.reviews).toHaveLength(1)
    const posted = gh.prs[0]!.reviews[0]!.body
    expect(posted).toContain("**Second review by Codex (round 1): incomplete")
    expect(posted).toContain("read-check missing or incorrect")
    expect(posted).toContain("About your consent or privacy pages (yours to decide)")
    expect(posted).toContain(finding)
    expect(posted).not.toContain(": looks good.")
    // The missing-read-check explanation may name the field; the private nonce itself stays private.
    expect(posted).not.toMatch(/read-check:\s+[a-f0-9]{16}\b/)
    const ledger = JSON.parse(readFileSync(join(w.site.repo, ".infinite/wizard/review-ledger.json"), "utf8"))
    expect(ledger.completeness.state).toBe("incomplete")
    expect(ledger.rounds[0].review.findings[0].body).toBe(finding)
    expect(JSON.stringify(ledger.rounds[0].review)).not.toMatch(/(?<![a-f0-9])[a-f0-9]{16}(?![a-f0-9])/)
    const comments = ((gh.prs[0] as unknown as { comments?: Array<{ body: string }> }).comments ?? []).map(comment => comment.body).join("\n")
    expect(comments).toContain("Reviewed by Codex (incomplete")
    expect(comments).toContain(finding)
    const text = run.ofType("step.sub").map(event => String(event.text)).join("\n")
    expect(text).toContain("Codex's review is incomplete")
    expect(text).not.toContain("nothing to change")
    const mergeAsk = run.ofType("ask.open").find(event => event.kind === "merge-ready")!.payload as { summary: string }
    expect(mergeAsk.summary).toContain("Review incomplete")
    expect(existsSync(join(w.site.repo, ".infinite/wizard/review-brief.md"))).toBe(false)
  })

  it("a Codex that could not check two items → 'review incomplete' in the terminal, the posted review, the merge card and the final comment", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    const partial = {
      verdict: "looks_good",
      summary: "Checked what I could read.",
      checklist: REVIEW_ITEMS.filter(item => item !== "R6").map((item) => ({ item, status: item === "R10" || item === "R12" ? "cant_tell" : "pass", note: "ok" })),
      findings: []
    }
    const w = await wiredWorld({ scenario: scenarioWith([{ final: partial }]) })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    const text = run.ofType("step.sub").map((event) => String(event.text)).join("\n")
    expect(text).toContain(`! Codex's review is incomplete: it could not check R10, R12 (${REVIEW_ITEMS.filter(item => item !== "R6").length - 2} of ${REVIEW_ITEMS.filter(item => item !== "R6").length} checked)`)
    expect(text).not.toContain("nothing to change")
    const gh = readGhState(w.ghState)
    expect(agentRuns(w, "codex", "reviewer")).toHaveLength(1)
    expect(gh.prs[0]!.reviews).toHaveLength(1)
    expect(gh.prs[0]!.reviews[0]!.body).toContain("**Second review by Codex (round 1): incomplete — it could not check R10, R12.**")
    expect(gh.prs[0]!.reviews[0]!.body).not.toContain("read-check")
    expect(gh.prs[0]!.reviews[0]!.body).not.toContain(": looks good.")
    expect(gh.prs[0]!.reviews[0]!.body).not.toMatch(/(?<![a-f0-9])[a-f0-9]{16}(?![a-f0-9])/)
    const mergeAsk = run.ofType("ask.open").find((event) => event.kind === "merge-ready")!.payload as { summary: string }
    expect(mergeAsk.summary).toContain("Review incomplete (Codex could not check 2 items)")
    const comments = ((gh.prs[0] as unknown as { comments?: Array<{ body: string }> }).comments ?? []).map((comment) => comment.body).join("\n")
    expect(comments).toContain("Reviewed by Codex (incomplete: R10, R12 not checked).")
  })
})
