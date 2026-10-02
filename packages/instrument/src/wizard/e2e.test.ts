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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { envProxyFetch } from "../checks/live/env-proxy-fetch.js"
import type { FakeBridgeCall } from "../../test/wizard/fake-bridge.js"
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
  GA4_AGAIN,
  GTAG_LOADER,
  agentScenario,
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

const worlds: E2eWorld[] = []
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.close()
})

beforeAll(() => {
  if (!existsSync(BUILT_CLI)) throw new Error(`Build the package first (pnpm --filter infinite-tag build): missing ${BUILT_CLI}`)
})

/** A world with the §4.3 defaults: the fixture's hosting, the per-request test results, required checks green. */
async function world(input: { scenario?: unknown; bridge?: Record<string, unknown>; gh?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<E2eWorld> {
  const made = await makeWorld({
    scenario: input.scenario ?? agentScenario(),
    bridge: { hosting: fixtureHosting(), testResultFor, ...(input.bridge ?? {}) },
    // A required check that already passed on every head (the fix round's `pr_checks_pass` reads it).
    gh: { checks: { "42": [{ name: "build", bucket: "pass", state: "SUCCESS" }] }, ...(input.gh ?? {}) },
    ...(input.env ? { env: input.env } : {})
  })
  // Every ref update on the remote is logged, so "never force-pushed" is checked on the real history.
  bareGit(made.site.bare, "config", "core.logAllRefUpdates", "always")
  worlds.push(made)
  return made
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

function finalJobs(w: E2eWorld): Array<{ id: string; state: string; blockedReason?: string; edits?: Array<{ file: string }> }> {
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
    const w = await world()
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
    const w = await world()
    await expect(envProxyFetch(w.env)("https://acme-store.com/")).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(w.tripwire.connections).toEqual(["CONNECT acme-store.com:443 HTTP/1.1"])
  })

  it("NEGATIVE: a PATH dir holding a real-looking claude ahead of the fakes is caught by both guards", async () => {
    const w = await world()
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
  it("runs all 13 steps to run.end with exit 0 and holds every main outcome", { timeout: RUN_TIMEOUT + 30_000 }, async () => {
    const w = await world()
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
      // install: the site source with the consent answer.
      "site-source",
      // jobs: the keys once (the connection ids the check-reason secret scan allows; review I1 P2-6).
      "keys",
      // jobs: no clickTestedConversions PATCH (a Next site's click tests are the rehearsal's, not T0).
      // settings: the cloud run (approved ∩ click-tested), conversions, the server lane (redeploy "skip");
      // no GA4 key event yet (nothing is click-tested before the rehearsal).
      "runs.get",
      "conversions",
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
      // review: the fix round re-rehearses the new head (rehearsal → the preview's own URL).
      "keys",
      "hosting",
      "test.start(rehearsal:home)",
      "test.poll",
      "test.start(dry_live:preview_self)",
      "test.poll",
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
      // prove: the passive P checks of the jobs now waiting for a real event (8 and 9 are checked since I1's fix round).
      "baseline",
      "runs.patch(proofState)",
      // done (§3z.12): checkinOptIn FIRST, the report once per measured phase, then the phase.
      "runs.patch(checkinOptIn)",
      "keys",
      "report(live_today)",
      "report(in_pr)",
      "report(proven_live)",
      "runs.patch(phase)",
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
    expect(job(ITEMS.conversionsToTools)).toMatchObject({ state: "blocked", blockedReason: "consent_touched" })
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
    expect(jobStates(run, ITEMS.duplicates)).toEqual(["claimed/agent_claim", "waiting_deploy/wizard"])

    // ---- 7. the post-turn gate: child_process in next.config.mjs never built ----
    expect(job(ITEMS.posthogProxy)).toMatchObject({ state: "blocked", blockedReason: "outside_allowlist" })
    expect(run.ofType("job.state").some((event) => event.itemId === ITEMS.posthogProxy && String(event.note).includes("turn_gate"))).toBe(true)
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

describe("the negative variants (§4.3 a–h)", () => {
  it("(a) Claude hits its usage limit mid-jobs → exit 3, the tree back to the post-install bytes, and a re-run resumes from `jobs`", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await world({ scenario: agentScenario({ prefixTurns: [usageLimitTurn()] }) })
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
    const w = await world({ bridge: { errors: { keys: { code: "subscription_required" } } } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(4)
    expect(stepOutcomes(run)).toEqual(["link:blocked:INF_WIZ_SUBSCRIPTION_REQUIRED"])
    expect(w.bridge.calls.map(label)).toEqual(["status", "link.request", "link.poll", "keys"])
    expect(remoteBranches(w)).toEqual(["main"])
    expect(agentRuns(w, "claude")).toEqual([])
  })

  it("(c) no agents (the resolver injected EMPTY) → deterministic lanes only, agent jobs need you, still reaches done", { timeout: RUN_TIMEOUT }, async () => {
    const w = await world({ env: { E2E_NO_AGENTS: "1" } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(0)
    expect(stepOutcomes(run).at(-1)).toBe("done:ok")
    // The fakes are still on PATH; nothing spawned them.
    expect(agentRuns(w, "claude")).toEqual([])
    expect(agentRuns(w, "codex")).toEqual([])
    expect(w.bridge.callsFor("runs.start")[0]!.body).toMatchObject({ worker: "none", reviewer: "brief" })
    const agentJobs = finalJobs(w).filter((job) => !job.id.startsWith("review_comments"))
    expect(agentJobs.length).toBeGreaterThan(0)
    for (const job of agentJobs) expect(job, job.id).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    expect(existsSync(join(w.site.repo, ".infinite/wizard/review-brief.md"))).toBe(true)
    // The deterministic install shipped anyway.
    const head = headOfBranch(w)!
    expect(bareShow(w.site.bare, head.head, "lib/infinite-analytics.ts")).toContain("Managed by Infinite")
  })

  it("(d) --yes without --consent-mode parks at `plan` (NEEDS_ANSWERS, exit 3) and never calls site-source", { timeout: RUN_TIMEOUT }, async () => {
    const w = await world()
    // Only the GA4 stream (a key choice --yes never makes): everything else is --yes's.
    const answers = writeAnswers(w, { v: 1, asks: [{ kind: "single", match: "GA4", answer: "G-FAKE00001" }] })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--yes", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(3)
    expect(stepOutcomes(run).at(-1)).toBe("plan:parked:INF_WIZ_NEEDS_ANSWERS")
    expect(w.bridge.callsFor("site-source")).toEqual([])
    expect(agentRuns(w, "claude")).toEqual([])
  })

  it("(e) nested: job.seeded briefs (exit 3) → the parent agent edits → --resume --json fences it; an answers file never answers consent", { timeout: 3 * RUN_TIMEOUT }, async () => {
    const w = await world({ env: { CLAUDECODE: "1" } })
    const answers = writeAnswers(w)
    // 1. The answers file carries consentMode, and nested mode ignores it: the run parks for the user's own terminal.
    const ignored = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(ignored.code, trace(ignored)).toBe(3)
    expect(stepOutcomes(ignored).at(-1)).toBe("plan:parked:INF_WIZ_NEEDS_ANSWERS")
    expect(w.bridge.callsFor("site-source")).toEqual([])

    // 2. The user answers the wizard's own /dev/tty prompt; the jobs go to the parent agent as job.seeded.
    const tty = join(w.site.base, "tty.json")
    writeFileSync(tty, JSON.stringify({ default: true, lines: { consent_mode: { approved: true, edit: "not_required" }, conversion_names: { approved: true, edit: CONVERSION }, meta_relay: { approved: false }, privacy_text: { approved: false } } }))
    const env = { ...w.env, E2E_TTY_ANSWERS: tty }
    const seeded = await runWizard({ cwd: w.site.repo, env, args: ["--json", "--answers", answers], timeoutMs: RUN_TIMEOUT })
    expect(seeded.code, trace(seeded)).toBe(3)
    expect(stepOutcomes(seeded).at(-1)).toBe("jobs:parked:INF_WIZ_NEEDS_ANSWERS")
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
    const w = await world()
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
    expect(w.bridge.calls.slice(callsBefore).filter((call) => call.verb === "test.start").map(label)).toEqual(["test.start(real_visit:home)"])
  })

  it("(g) the proof claim is lost → no real visit, receipts read, done (Codex works, Claude reviews)", { timeout: RUN_TIMEOUT }, async () => {
    const w = await world({ scenario: codexWorkerScenario(), bridge: { proofClaim: "lost" } })
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
    expect(jobStates(run, ITEMS.duplicates)).toEqual(["claimed/agent_claim", "waiting_deploy/wizard"])
    // Claude reviewed, read-only and restricted, with the pinned model.
    const reviewer = agentRuns(w, "claude", "reviewer")[0]!.argv
    expect(reviewer).toEqual(expect.arrayContaining(["--restricted", "--model", "claude-opus-4-8", "--effort", "xhigh"]))
  })

  it("(h) uninstall --pr: its own branch first, every recorded edit reversed (agent edits too), cloud pieces after the merge", { timeout: 2 * RUN_TIMEOUT }, async () => {
    const w = await world()
    const installed = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], respond: mergeThenOpen(w), timeoutMs: RUN_TIMEOUT })
    expect(installed.code, trace(installed)).toBe(0)
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
      const expected = file === ".gitignore" ? fixtureFile("_gitignore") : fixtureFile(file)
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
  it("(i) a 423 lock on site-source parks SITE_LOCKED at install (exit 3): no agent, nothing pushed", { timeout: RUN_TIMEOUT }, async () => {
    const w = await world({ bridge: { errors: { "site-source": { code: "site_setup_locked", state: "live_site_lock" } } } })
    const run = await runWizard({ cwd: w.site.repo, env: w.env, args: ["--json", "--answers", writeAnswers(w)], timeoutMs: RUN_TIMEOUT })
    expect(run.code, trace(run)).toBe(3)
    expect(stepOutcomes(run).at(-1)).toBe("install:parked:INF_WIZ_SITE_LOCKED")
    expect(agentRuns(w, "claude")).toEqual([])
    expect(remoteBranches(w)).toEqual(["main"])
  })

  it("(j) an approved Meta relay binds while not rolled out ('ready, waiting for Infinite to switch on')", { timeout: RUN_TIMEOUT }, async () => {
    const w = await world({ bridge: { metaRelay: { available: false, reason: "not_rolled_out", enabled: false, bound: null } } })
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
    const w = await world({ bridge: { hangUpAfter: ["receipts"] } })
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
    const w = await world()
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
    const w = await world()
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
    const w = await world()
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
    const w = await world()
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

  it("review I1 P2-5: Ctrl+C mid-turn undoes the agent's edit and removes the snapshot before exit 130", { timeout: RUN_TIMEOUT }, async () => {
    const w = await world({ scenario: agentScenario({ round1: [{ tool: "job_list" }, ...duplicateRemovalSteps(), { hang: true }] }) })
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
