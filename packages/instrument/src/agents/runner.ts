// `AgentRunner` (§3f.1): runs the user's OWN Claude Code or Codex as the worker (one fenced turn per
// `runJobs` call; the jobs step drives the resume rounds) and as the read-only reviewer (`review`), and
// answers `isAgentAlive()` / `killAll()` for the engine invariant and SIGINT.
//
// One `runJobs` turn:
//   1. a fresh claim channel (loopback MCP bridge + per-run token) seeded with THIS turn's items;
//   2. `Fence.begin` (snapshot outside the repo and $TMPDIR);
//   3. the agent, in its own process group, bounded by max turns (Claude) and the wall clock;
//      Claude must show `infinite_tag` connected + `job_claim` in `system/init` and an `apiKeySource` that
//      matches the plan line, else the run is killed (toolless / billing changed); Codex must reach the
//      bridge (`initialize`) within its startup window, else toolless;
//   4. out of usage, timeout, toolless or an error → `fence.abort()` (every uncommitted agent edit is
//      undone, the session id is kept); otherwise `fence.end()` with the post-turn gate (O9's `turnGate`,
//      §3f.9), BEFORE any build or T0 (a heavy-dir write throws `FenceTamperError`);
//   5. claims = the MCP claims, plus the structured-output fallback for jobs the agent did not claim over
//      MCP. A claim is never a result: the wizard's checks decide.
// The pinned models live in ONE constant (`AGENT_MODELS`, River 10-02); if the user's plan or CLI rejects
// one, the turn is retried ONCE with the user's default model at the same effort, and the user is told.
// Never a provider switch, never Infinite-paid inference, never a real prompt in tests (fakes only).
import { OWNER_BOUNDARY_INSTRUCTION } from "../jobs/owner-boundary.js"
import { createScanner } from "../review/scan.js"
import { redactDisplayText } from "../review/display.js"
import { randomUUID } from "node:crypto"
import { access, chmod, open, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  AGENT_LIMITS,
  CLAIMS_SCHEMA,
  codexPermissionArgs,
  REVIEW_SCHEMA,
  schemaFileText,
  type AgentDetectResult,
  type AgentInfo,
  type AgentKind,
  type AgentRunner,
  type AgentRunOutcome,
  type AgentRunResult,
  type ReviewFailure,
  type ReviewResult,
  type ReviewRunInput,
  type RunJobsInput,
  type SessionRef
} from "../wizard/contracts/agents.js"
import { AGENT_MODELS } from "../wizard/contracts/agents.js"
import type { GitOps } from "../wizard/contracts/git-host.js"
import type { AgentQuestion, CheckRunner, ChecklistItem, Claim } from "../wizard/contracts/jobs.js"
import {
  buildClaudeReviewerArgv,
  reviewerDenyCoveringCwd,
  reviewerWasBlind,
  buildClaudeWorkerArgv,
  claudeMcpConfig,
  claudeModelRejected,
  INCIDENT_PATH,
  parseClaudeLine,
  type ModelChoice
} from "./claude.js"
import { buildCodexReviewerArgv, buildCodexWorkerArgv, codexModelRejected, codexRequestRejected, codexUnrecognizedConfig, parseCodexLine } from "./codex.js"
import { detectAgents, apiKeySourceMatches, resolveCodexRuntime, type DetectedAgents } from "./detect.js"
import { buildAgentEnv } from "./env.js"
import { Fence, recoverCrashedTurns, type FenceBlock, type FenceEditAttribution, type FenceGateHit, type FenceStray, type TreeSeal } from "./fence.js"
import { assertReviewWorktree } from "./worktree-guard.js"
import { AGENT_LABEL, claudeToolBeat, codexItemBeat, displayPath, Narrator, ThinkingTicker, type NarrationBeat } from "./narration.js"
import { AgentProcessRegistry } from "./process.js"
import { ensurePrivateDir, repoSecretPaths, resolveRealpath, resolveSensitivePaths, runScratchDir, snapshotDir, wizardCacheRoot } from "./paths.js"
import { sanitizeUntrusted } from "./sanitize.js"
import { parseReview, parseStructuredClaims, type StructuredClaims } from "./schema-check.js"
import { ClaimChannel, isPlanDecidedTopic } from "./mcp/tools.js"
import type { McpServerHandler } from "./mcp/jsonrpc.js"
import { startMcpBridge } from "./mcp/bridge.js"
import { claudeUsageSignals, codexUsageLimit } from "./usage-limit.js"

/**
 * The models customers' runs use (River, 10-02, final): Opus 4.8 xhigh and Sol 6.1 xhigh, both roles. ONE
 * constant, in the contract (`AGENT_MODELS`), so a retirement is a one-line change there.
 */
export { AGENT_MODELS }

/** Prompts on stdin (the job brief is the system prompt for Claude and the prompt for Codex). */
export const WORKER_KICKOFF =
  "Do the jobs in your instructions. Start with job_list. Edit files only; never run git, a build, the tests, an install or a dev server (the wizard builds and tests after your turn). Finish and claim one job at a time. Read job_claim's staticChecks result and fix any problem before moving to the next job; the wizard runs the remaining checks after your turn. Finish with the JSON your output schema asks for."
export const WORKER_RESUME_KICKOFF =
  "Continue. The wizard ran its own checks; its notes and any answers from the user are at the end of your instructions. Fix what failed, then claim again with job_claim and finish with the JSON your output schema asks for."
/**
 * The first line of every Claude system prompt: the value after `--append-system-prompt` never starts with "-". Live run
 * 6: it no longer repeats the owner boundary paragraph, which the brief itself opens with (`jobs/briefs.ts`
 * `operatorRules`, the same text Codex gets with no header), so the agent reads it once.
 */
export const SYSTEM_PROMPT_HEADER = "Infinite tag wizard: your instructions for this run."
export const REVIEWER_KICKOFF =
  "Review the pull request checked out in this folder against your supplied checklist. Consent, privacy policies and terms are outside the review: do not evaluate or comment on them. Read only. Answer only with the JSON your output schema asks for."

/** How long Codex has to reach the claim channel before the run is called toolless. */
export const CODEX_STARTUP_TIMEOUT_MS = 45_000

/** What a `runJobs` result carries beyond §3f.1 (proposed as optional fields in the O3 note). */
export interface AgentRunExtras {
  /** Items the fence blocked this turn (outside the allowlist, consent touched). */
  blocked: FenceBlock[]
  /** Review P2-3: paths the fence undid that no job owns (only reverted; said and fed back, never a job's failure). */
  strays: FenceStray[]
  /** §3x.2 The post-turn gate's refusals (each hunk reverted; the jobs step fails the attributed items' S check). */
  gateHits: FenceGateHit[]
  /** §3x.2 Per kept edit, the items each of its text edits belongs to. */
  attribution: FenceEditAttribution[]
  /** Denied reads of secrets (`.env`, `~/.growth-os`, …): each is an incident, not just a count. */
  incidents: string[]
  /** Claude's `num_turns`; null when the agent does not report it (Codex). */
  turnsUsed: number | null
  /** True when the pinned model was refused and the user's default model ran instead. */
  modelFallback: boolean
  /** The settled tree (`verifySeal` before the build/T0); null when the turn was aborted. */
  seal: TreeSeal | null
}

export type AgentRunResultWithExtras = AgentRunResult & AgentRunExtras

/**
 * Reads the extras off a `runJobs` result. A runner that returns only the §3f.1 shape cannot say WHICH
 * job the fence blocked (review O3 F14), so when it reverted anything and gave no `blocked` list, every
 * item of the turn is blocked (fail closed) instead of none.
 */
export function runExtras(result: Omit<AgentRunResult, "session">, items: readonly { id: string }[] = []): AgentRunExtras {
  const extras = result as Partial<AgentRunExtras>
  let blocked: FenceBlock[]
  if (Array.isArray(extras.blocked)) blocked = extras.blocked
  else if (result.reverted.length > 0) {
    blocked = items.map((item) => ({
      itemId: item.id,
      reason: "outside_allowlist" as const,
      paths: [...result.reverted],
      note: "The fence undid part of this turn and the runner did not say which job; every job of the turn is blocked."
    }))
  } else blocked = []
  return {
    blocked,
    strays: Array.isArray(extras.strays) ? extras.strays : [],
    gateHits: Array.isArray(extras.gateHits) ? extras.gateHits : [],
    attribution: Array.isArray(extras.attribution) ? extras.attribution : [],
    incidents: Array.isArray(extras.incidents) ? extras.incidents : [],
    turnsUsed: typeof extras.turnsUsed === "number" ? extras.turnsUsed : null,
    modelFallback: extras.modelFallback === true,
    seal: extras.seal ?? null
  }
}

export interface AgentRunnerOptions {
  /** Repo-relative application directory used for policy page routing. */
  appRoot?: string
  /** The repo root (absolute). */
  root: string
  /** The user's home (absolute): scratch, snapshots and the sensitive-path list come from it. */
  home: string
  env: Readonly<Record<string, string | undefined>>
  isTTY: boolean
  tagVersion: string
  /** The cloud run id (scratch and snapshot dirs, edit records). */
  runId(): string | null
  /** O9's post-turn gate (registered on O6's CheckRunner). REQUIRED: no turn is kept without it. */
  checks: Pick<CheckRunner, "turnGate">
  /**
   * REQUIRED: the connection's public provider IDs (the gate flags any other ID literal; with none, every
   * ID edit of jobs 4, 5 and 7 would be undone). `connectionIdsFromKeys` builds it from `bridge.keys()`.
   */
  connectionIds(): readonly string[] | Promise<readonly string[]>
  /** Literals no change or claim may contain (e.g. the desktop bridge token). The MCP token is added per turn. */
  secretLiterals?(): readonly string[]
  /** `--worker` / `--no-agent`. */
  preferWorker?: "claude" | "codex" | "none" | null
  /** The run's chosen worker (state.agent.worker), when it is already known. */
  worker?(): AgentKind | null
  nodePath?: string
  /** The built `cli.js` the agent spawns as `mcp-proxy` (default: next to this module in dist). */
  cliPath?: string
  models?: Record<AgentKind, { model: string; effort: string; label: string }>
  now?(): Date
  codexStartupTimeoutMs?: number
  narrationThrottleMs?: number
  probeTimeoutMs?: number
}

interface AttemptResult {
  outcome: AgentRunOutcome
  session: SessionRef
  resetsAt?: string
  permissionDenials: number
  incidents: string[]
  structured: StructuredClaims | null
  turnsUsed: number | null
  modelRejected: boolean
  errorText: string | null
}

export class AgentRunnerImpl implements AgentRunner {
  // Set ONLY by the runner's dispatch record. A multi-item child has no trustworthy current-job
  // identity; agent report_progress / claim order must never turn that uncertainty into blame.
  private activeJob: string | null = null
  private readonly pendingEdits = new Map<string, { path: string; owner: string | null }>()
  private readonly codexEditOwners = new Map<string, string | null>()
  private flushEditActivities(ids?: readonly string[]): void {
    for (const id of ids ?? this.pendingEdits.keys()) {
      const edit = this.pendingEdits.get(id)
      if (!edit) continue
      this.activeFence?.recordEditActivity(edit.owner, edit.path)
      this.pendingEdits.delete(id)
    }
  }
  private readonly registry = new AgentProcessRegistry()
  private detected: DetectedAgents | null = null
  private activeFence: Fence | null = null
  private turn = 0
  private reviews = 0
  private interrupted = false
  private recovered = false
  private readonly fallback: Record<AgentKind, boolean> = { claude_code: false, codex: false }

  /** The MCP bridge tokens of this run's turns (B5: O4's secret scanner must never let one into a commit). */
  private readonly mcpTokens = new Set<string>()

  constructor(private readonly options: AgentRunnerOptions) {}

  /**
   * §3z.12 §3f.1 (B5): every secret literal this run handed to a process (the MCP tokens of its turns and
   * the caller's own, e.g. the desktop bridge token), for the PR loop's secret scan. Never logged.
   */
  secretLiterals(): string[] {
    return [...this.mcpTokens, ...(this.options.secretLiterals?.() ?? [])].filter((literal) => literal.length >= 8)
  }

  async detect(): Promise<AgentDetectResult & DetectedAgents> {
    if (!this.detected) {
      this.detected = await detectAgents({
        env: this.options.env,
        cwd: this.options.root,
        isTTY: this.options.isTTY,
        preferWorker: this.options.preferWorker ?? null,
        probeTimeoutMs: this.options.probeTimeoutMs
      })
    }
    return this.detected
  }

  isAgentAlive(): boolean {
    return this.registry.isAlive()
  }

  /**
   * SIGINT / abort: kill every agent process group, then restore the open turn's snapshot, and RETURN ONLY
   * ONCE IT IS RESTORED. `fence.abort()` is idempotent: when `runJobs` has already started its own abort (the
   * killed agent ended the turn first), it hands back that in-flight restore, which is awaited here too. Before
   * (review I1 P2-5) a started abort was skipped, so the lock was released and the process exited mid-restore,
   * leaving the agent's edits in the tree and the snapshot on disk.
   */
  async killAll(): Promise<void> {
    this.interrupted = true
    await this.registry.killAll()
    const fence = this.activeFence
    if (fence) await fence.abort()
  }

  async runJobs(input: RunJobsInput): Promise<AgentRunResultWithExtras> {
    this.interrupted = false
    const kind: AgentKind | null =
      input.resume?.kind === "claude" ? "claude_code" : input.resume?.kind === "codex" ? "codex" : (this.options.worker?.() ?? (await this.detect()).worker?.kind ?? null)
    if (!kind) throw new Error("runJobs needs a worker agent; the jobs step must not call it with none")
    const info = await this.infoFor(kind)
    const emptySession: SessionRef = kind === "claude_code" ? { kind: "claude", sessionId: input.resume?.kind === "claude" ? input.resume.sessionId : "" } : { kind: "codex", threadId: input.resume?.kind === "codex" ? input.resume.threadId : "" }
    if (!info) {
      return { outcome: "error", session: emptySession, claims: [], questions: [], permissionDenials: 0, reverted: [], edits: [], blocked: [], strays: [], gateHits: [], attribution: [], incidents: [], turnsUsed: null, modelFallback: false, seal: null }
    }
    // A turn a killed wizard left open (its snapshot still on disk) is undone first, so the agent's
    // unvetted edits never become this turn's baseline (review O3 F10).
    if (!this.recovered) {
      this.recovered = true
      const recovered = await recoverCrashedTurns({ snapshotsRoot: join(wizardCacheRoot(this.options.home), "snapshots"), root: this.options.root })
      const paths = [...new Set(recovered.flatMap((entry) => entry.restored))]
      if (paths.length > 0) {
        input.onNarrate({ agent: kind, role: "worker", text: `Undid an unfinished agent turn from an earlier run: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}` })
      }
    }
    this.turn += 1
    const turn = this.turn
    const runId = this.options.runId() ?? "local-run"
    const scratch = runScratchDir(this.options.home, runId)
    await ensurePrivateDir(scratch)
    const now = this.options.now ?? (() => new Date())
    let token = ""
    const literals = () => [token, ...(this.options.secretLiterals?.() ?? [])].filter((literal) => literal.length >= 8)
    const allowedIds = await this.options.connectionIds()
    // Claims, questions and progress reach the terminal before the later report scan. Use the same
    // provider/context rules here, before limits can truncate a key. The MCP token arrives after setup.
    const redact = (text: string) => redactDisplayText(createScanner({
      literals: literals().map(value => ({ value, kind: "mcp_token" as const })),
      allowedIds
    }), text)
    const narrator = new Narrator({ agent: kind, role: "worker", emit: (beat) => input.onNarrate(beat), now: () => now().getTime(), throttleMs: this.options.narrationThrottleMs })
    // One claim channel PER ATTEMPT (review O3 F20): a model-fallback retry must not inherit the first
    // attempt's claims or its `initialized` count (that would hide a toolless retry).
    const newChannel = () =>
      new ClaimChannel({
        items: input.items,
        now,
        redact,
        onClaim: async (claim) => {
          if (this.pendingEdits.size > 0) return { state: "undetermined", problems: ["An editing tool is still running. Wait for it to finish, then claim again."] }
          if (!this.activeFence || !(await this.activeFence.claimCheckSafe())) return { state: "undetermined", problems: ["The safety fence found an out-of-scope or changing file; no static check ran. The turn will be settled before any further checks."] }
          const consentProblems = await this.activeFence.claimConsentProblems(claim.jobId)
          // The change since the previous claim is this job's (attribution by claim, `claim-attribution.ts`). Taken after
          // the consent put-back, so the snapshot holds what this job really keeps. A claim refused above (an edit still
          // running, an unsafe tree) takes none: its change then counts toward the next claim.
          await this.activeFence.markClaim(claim.jobId)
          if (consentProblems.length > 0) return { state: "problem", problems: consentProblems }
          const feedback = await input.onClaim(claim)
          return feedback && typeof feedback === "object" ? feedback : undefined
        },
        onAsk: (question) => input.onAsk(question),
        onProgress: (progress) => {
          input.onProgress(progress)
          narrator.beat(progress.text)
        }
      })
    let channel = newChannel()
    const handler: McpServerHandler = {
      tools: () => channel.tools(),
      call: (name, args) => channel.call(name, args),
      onInitialize: () => channel.onInitialize(),
      onToolsList: () => channel.onToolsList()
    }
    const bridge = await startMcpBridge({ handler, version: this.options.tagVersion })
    token = bridge.token
    this.mcpTokens.add(token)
    // The snapshot dir is unique per process and turn, so a later run never overwrites a crashed turn's copies.
    const turnDir = (suffix = "") => snapshotDir(this.options.home, runId, `${turn}${suffix}-${process.pid}-${Date.now().toString(36)}`)
    this.activeJob = input.items.length === 1 ? input.items[0]!.id : null
    this.pendingEdits.clear()
    this.codexEditOwners.clear()
    let fence = await Fence.begin({ root: this.options.root, appRoot: this.options.appRoot, snapshotDir: turnDir(), runId, turn, items: input.items })
    this.activeFence = fence
    let modelFallback = false
    try {
      let attempt = await this.workerAttempt(kind, info, input, { bridge, scratch, narrator, channel, turn, model: this.modelFor(kind) })
      if (attempt.modelRejected && !this.fallback[kind] && !this.interrupted) {
        this.fallback[kind] = true
        modelFallback = true
        input.onNarrate({ agent: kind, role: "worker", text: `${this.models()[kind].label} isn't on your plan: using your default model` })
        if (!fence.isSettled) await fence.abort()
        fence = await Fence.begin({ root: this.options.root, appRoot: this.options.appRoot, snapshotDir: turnDir("-retry"), runId, turn: `${turn}-retry`, items: input.items })
        this.activeFence = fence
        this.pendingEdits.clear()
        this.codexEditOwners.clear()
        this.activeJob = input.items.length === 1 ? input.items[0]!.id : null
        channel = newChannel()
        attempt = await this.workerAttempt(kind, info, input, { bridge, scratch, narrator, channel, turn, model: this.modelFor(kind) })
      }
      if (this.interrupted && attempt.outcome === "completed") attempt.outcome = "error"
      this.flushEditActivities()
      const claims = mergeClaims(channel.claims, attempt.structured, input.items, now, redact)
      const questions = mergeQuestions(channel.questions, attempt.structured, input.items, redact)
      const base = {
        session: attempt.session,
        claims,
        questions,
        permissionDenials: attempt.permissionDenials,
        incidents: attempt.incidents,
        turnsUsed: attempt.turnsUsed,
        modelFallback,
        ...(attempt.resetsAt ? { resetsAt: attempt.resetsAt } : {})
      }
      if (attempt.outcome !== "completed" && attempt.outcome !== "max_turns") {
        const restored = await fence.abort()
        return { ...base, outcome: attempt.outcome, reverted: restored.restored, edits: [], blocked: [], strays: [], gateHits: [], attribution: [], seal: null }
      }
      // §3f.9: the gate runs on the kept diff after EVERY turn, before any build or T0. A heavy-dir write
      // throws FenceTamperError here (the fence has already restored what it could).
      const connectionIds = [...(await this.options.connectionIds())]
      const settled = await fence.end({
        claims,
        secretLiterals: literals(),
        turnGate: (diff) => this.options.checks.turnGate(diff, { connectionIds })
      })
      return {
        ...base,
        outcome: attempt.outcome,
        reverted: settled.reverted,
        edits: settled.edits,
        blocked: settled.blocked,
        strays: settled.strays,
        gateHits: settled.gateHits,
        attribution: settled.attribution,
        seal: settled.seal
      }
    } finally {
      if (!fence.isSettled && !this.interrupted) await fence.abort().catch(() => undefined)
      this.activeFence = null
      await bridge.close()
      await rm(join(scratch, `tag.mcp.${turn}.json`), { force: true })
    }
  }

  /** §3x.3 Where review number `n`'s event stream is kept (0600): `<cache>/<runId>/review-<n>-<agent>.jsonl`. */
  reviewLogPath(n: number, reviewer: AgentKind): string {
    const runId = (this.options.runId() ?? "local-run").replace(/[^A-Za-z0-9-]/g, "_")
    return join(wizardCacheRoot(this.options.home), runId, `review-${n}-${reviewer === "claude_code" ? "claude" : "codex"}.jsonl`)
  }

  /**
   * Every outcome that is not a parsed review is a failure that says WHY (live runs: a refused request, a missing
   * binary and a crash were all reported as "unparseable", so the review step asked again with "your answer did not
   * match the schema" and then said exactly that, when no answer had ever come back). Only `unparseable` is an answer.
   */
  async review(input: ReviewRunInput): Promise<ReviewResult | ReviewFailure> {
    await assertReviewWorktree(input.worktreeDir, this.options.root)
    const info = await this.infoFor(input.reviewer)
    if (!info) {
      const reason = (await this.detect()).unavailable?.find((entry) => entry.kind === input.reviewer)?.reason
      return { error: "unavailable", message: reason === "logged_out" ? "is not signed in" : reason === "not_installed" ? "is not installed" : "was not found on this computer" }
    }
    this.reviews += 1
    const runId = this.options.runId() ?? "local-run"
    const scratch = join(runScratchDir(this.options.home, runId), `review-${this.reviews}`)
    await ensurePrivateDir(scratch)
    let result = await this.reviewAttempt(info, input, scratch, this.modelFor(input.reviewer))
    if (result.modelRejected && !this.fallback[input.reviewer]) {
      this.fallback[input.reviewer] = true
      result = await this.reviewAttempt(info, input, scratch, this.modelFor(input.reviewer))
    }
    await rm(scratch, { recursive: true, force: true })
    const message = result.errorText ? { message: result.errorText } : {}
    if (result.outcome === "out_of_usage") return { error: "out_of_usage" }
    if (result.outcome === "timeout") return { error: "timeout" }
    if (result.requestRejected) return { error: "rejected", ...message }
    // A non-zero exit, a failed turn or a kill; also a run that "finished" on an error result with no answer.
    if (result.outcome === "error" || (result.review === null && result.errorText !== null)) return { error: "error", ...message }
    return result.review ?? { error: "unparseable" }
  }

  // ---- internals ----

  private models() {
    return this.options.models ?? AGENT_MODELS
  }

  private modelFor(kind: AgentKind): ModelChoice {
    const spec = this.models()[kind]
    return { model: this.fallback[kind] ? null : spec.model, effort: spec.effort }
  }

  private async infoFor(kind: AgentKind): Promise<AgentInfo | null> {
    const detected = await this.detect()
    return detected.available.find((info) => info.kind === kind) ?? null
  }

  private cliPath(): string {
    return this.options.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url))
  }

  private async workerAttempt(
    kind: AgentKind,
    info: AgentInfo,
    input: RunJobsInput,
    ctx: { bridge: { url: string; token: string }; scratch: string; narrator: Narrator; channel: ClaimChannel; turn: number; model: ModelChoice }
  ): Promise<AttemptResult> {
    const items = input.items
    const allowed = new Set(items.flatMap((item) => [...item.allow.files, ...item.allow.create]))
    const jobNumber = (id: string) => items.find((item) => item.id === id)?.n ?? null
    const beatCtx = { root: this.options.root, isAllowed: (path: string) => allowed.has(path), agent: kind, jobNumber }
    const sensitive = await resolveSensitivePaths({ home: this.options.home, env: this.options.env })
    const node = this.options.nodePath ?? process.execPath
    const notices = new Set<string>()
    const notice = (text: string) => {
      if (notices.has(text)) return
      notices.add(text)
      input.onNarrate({ agent: kind, role: "worker", text })
    }
    // §3x.3 (D1): silence after a tool result is the model thinking, said as `Thinking · N s` (never the last tool's beat).
    const ticker = new ThinkingTicker(ctx.narrator, () => (this.options.now ?? (() => new Date()))().getTime(), (seconds) => input.onActivity?.({ kind: "thinking", seconds }))
    const tickTimer = setInterval(() => ticker.tick(), 1_000)
    tickTimer.unref()
    const state = {
      outcome: null as AgentRunOutcome | null,
      resetsAt: undefined as string | undefined,
      permissionDenials: 0,
      incidents: [] as string[],
      structured: null as StructuredClaims | null,
      turnsUsed: null as number | null,
      modelRejected: false,
      errorText: null as string | null,
      sawResult: false,
      maxTurns: false,
      sessionId: "",
      threadId: ""
    }
    const stop = (outcome: AgentRunOutcome) => {
      if (state.outcome === null) state.outcome = outcome
      void child.kill()
    }

    let child: ReturnType<AgentProcessRegistry["spawn"]>
    if (kind === "claude_code") {
      const resume = input.resume?.kind === "claude" && input.resume.sessionId !== "" ? input.resume.sessionId : null
      state.sessionId = resume ?? randomUUID()
      const mcpConfigPath = join(ctx.scratch, `tag.mcp.${ctx.turn}.json`)
      await writeFile(mcpConfigPath, claudeMcpConfig({ node, cliPath: this.cliPath(), url: ctx.bridge.url, token: ctx.bridge.token }), { mode: 0o600 })
      const argv = buildClaudeWorkerArgv({
        sensitive,
        mcpConfigPath,
        systemPrompt: `${SYSTEM_PROMPT_HEADER}\n\n${input.brief}`,
        claimsSchema: JSON.stringify(CLAIMS_SCHEMA),
        maxTurns: input.budget.maxTurns,
        session: resume ? { mode: "resume", sessionId: resume } : { mode: "new", sessionId: state.sessionId },
        model: ctx.model
      })
      child = this.registry.spawn({
        command: info.binPath,
        args: argv,
        cwd: this.options.root,
        env: buildAgentEnv(this.options.env, { kind: "claude_code" }),
        stdin: resume ? WORKER_RESUME_KICKOFF : WORKER_KICKOFF,
        wallMs: input.budget.wallMs,
        onStdoutLine: (line) => {
          const event = parseClaudeLine(line)
          if (!event) return
          if (claudeModelRejected(event, ctx.model.model)) {
            state.modelRejected = true
            return stop("error")
          }
          switch (event.kind) {
            case "init":
              if (event.sessionId) state.sessionId = event.sessionId
              if (!event.mcpConnected || !event.hasClaimTool) return stop("toolless")
              if (!apiKeySourceMatches(info.whoPays, event.apiKeySource)) {
                state.errorText = "Claude Code would bill a different account under the wizard's safety settings than the plan showed"
                return stop("error")
              }
              return
            case "tool_use": {
              ticker.acted()
              for (const use of [event, ...event.additional ?? []]) {
                const beat = claudeToolBeat(use.name, use.input, beatCtx)
                const toolInput = typeof use.input === "object" && use.input !== null ? use.input as Record<string, unknown> : {}
                const path = displayPath(toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path, this.options.root)
                if (use.name === "Read") input.onActivity?.({ kind: "read", path })
                if (use.name === "Edit" || use.name === "Write" || use.name === "MultiEdit") {
                  const overlapping = [...this.pendingEdits.values()].filter(edit => edit.path === path)
                  // Concurrent writes to one file have no reliable byte attribution; never guess a claimant.
                  overlapping.forEach(edit => { edit.owner = null })
                  this.pendingEdits.set(use.id ?? `unidentified-${this.pendingEdits.size}`, { path, owner: overlapping.length ? null : this.activeJob })
                  input.onActivity?.({ kind: "edit", path })
                }
                if (beat) ctx.narrator.beat(beat)
              }
              return
            }
            case "tool_result":
              this.flushEditActivities(event.ids)
              ticker.toolReturned()
              return
            case "assistant_error":
              if (event.error === "rate_limit" || event.error === "billing_error") return stop("out_of_usage")
              return
            case "rate_limit":
              for (const signal of claudeUsageSignals(event.event)) {
                if (signal.kind === "rejected") {
                  state.resetsAt = signal.resetsAt ?? state.resetsAt
                  stop("out_of_usage")
                } else if (signal.kind === "warning") notice(`${AGENT_LABEL[kind]}: you are close to your ${signal.rateLimitType?.replace(/_/g, " ") ?? "usage"} limit`)
                else notice(`${AGENT_LABEL[kind]}: using your extra-usage credits`)
              }
              return
            case "result":
              state.sawResult = true
              if (event.sessionId) state.sessionId = event.sessionId
              state.turnsUsed = event.numTurns
              state.permissionDenials = event.permissionDenials.length
              for (const denial of event.permissionDenials) {
                if (denial.path && INCIDENT_PATH.test(denial.path)) {
                  state.incidents.push(`${AGENT_LABEL[kind]} tried to ${denial.toolName === "Read" ? "read" : "touch"} ${incidentPath(denial.path, this.options.root)} (denied)`)
                }
              }
              state.structured = parseStructuredClaims(event.structuredOutput)
              if (event.apiErrorStatus === 429) return stop("out_of_usage")
              if (event.subtype === "error_max_turns") state.maxTurns = true
              else if (event.isError && state.outcome === null) state.errorText = sanitizeUntrusted(event.text, 200) || "Claude Code stopped with an error"
              return
            default:
              return
          }
        }
      })
    } else {
      const resume = input.resume?.kind === "codex" && input.resume.threadId !== "" ? input.resume.threadId : null
      state.threadId = resume ?? ""
      const runtime = await resolveCodexRuntime(info.binPath, this.options.env.PATH)
      const permissionArgs = codexPermissionArgs({
        role: "worker",
        homeRealpath: await resolveRealpath(this.options.home),
        sensitiveRealpaths: sensitive.map((entry) => entry.path),
        codexBinDir: runtime.codexBinDir,
        codexInstallRoot: runtime.codexInstallRoot,
        // B20: the repo's own secrets ("none") and, for the worker, .git read-only. §3y.10 (P3-10): the wizard's
        // own `.infinite/` is "none" for the worker too (the brief carries what it needs).
        repoDenies: await withWizardDirDenied(await repoSecretPaths(this.options.root), this.options.root)
      })
      const schemaPath = join(ctx.scratch, "claims.schema.json")
      await writeFile(schemaPath, schemaFileText(CLAIMS_SCHEMA), { mode: 0o600 })
      const outputPath = join(ctx.scratch, `last.${ctx.turn}.json`)
      await rm(outputPath, { force: true })
      const argv = buildCodexWorkerArgv({
        repo: this.options.root,
        permissionArgs,
        model: ctx.model,
        node,
        cliPath: this.cliPath(),
        outputPath,
        schemaPath,
        ...(resume ? { resumeThreadId: resume } : {})
      })
      child = this.registry.spawn({
        command: info.binPath,
        args: argv,
        cwd: this.options.root,
        env: buildAgentEnv(this.options.env, { kind: "codex", mcp: ctx.bridge }),
        stdin: `${input.brief}\n\n${resume ? WORKER_RESUME_KICKOFF : WORKER_KICKOFF}\n`,
        wallMs: input.budget.wallMs,
        onStdoutLine: (line) => {
          const event = parseCodexLine(line)
          if (!event) return
          if (event.kind === "thread") state.threadId = event.threadId
          else if (event.kind === "item") {
            // A finished item hands the result back to the model; a started one is it acting.
            if (event.phase === "completed") ticker.toolReturned()
            else ticker.acted()
            const beat = codexItemBeat(event.item, beatCtx)
            if (typeof event.item === "object" && event.item !== null && (event.item as { type?: string }).type === "file_change") {
              const id = (event.item as { id?: string }).id
              if (id && event.phase !== "completed") this.codexEditOwners.set(id, this.activeJob)
              const owner = id && this.codexEditOwners.has(id) ? this.codexEditOwners.get(id)! : this.activeJob
              for (const change of (event.item as { changes?: Array<{ path?: string }> }).changes ?? []) {
                if (change.path) {
                  const path = displayPath(change.path, this.options.root)
                  if (event.phase === "completed") this.activeFence?.recordEditActivity(owner, path)
                  input.onActivity?.({ kind: "edit", path })
                }
              }
              if (id && event.phase === "completed") this.codexEditOwners.delete(id)
            }
            if (beat) ctx.narrator.beat(beat)
          } else if (event.kind === "error") {
            const message = event.message
            const usage = codexUsageLimit(message)
            if (usage) {
              state.resetsAt = usage.resetsAt ?? state.resetsAt
              return stop("out_of_usage")
            }
            if (codexModelRejected(message, ctx.model.model)) {
              state.modelRejected = true
              return stop("error")
            }
            if (codexUnrecognizedConfig(message) || event.fatal) {
              state.errorText = sanitizeUntrusted(message, 200)
              return stop("error")
            }
          } else if (event.kind === "turn_completed") {
            state.sawResult = true
          }
        }
      })
      const startup = setTimeout(() => {
        if (ctx.channel.initialized === 0 && child.alive) stop("toolless")
      }, this.options.codexStartupTimeoutMs ?? CODEX_STARTUP_TIMEOUT_MS)
      startup.unref()
      void child.done.then(() => clearTimeout(startup))
      const exit = await child.done
      clearInterval(tickTimer)
      try {
        state.structured = parseStructuredClaims(await readFile(outputPath, "utf8"))
      } catch {
        state.structured = null
      }
      await rm(outputPath, { force: true })
      // Codex never reached the claim channel (a required server that failed, or no MCP vars): toolless,
      // whatever error it printed about it. A usage limit or a refused model still wins.
      if (ctx.channel.initialized === 0 && !state.modelRejected && state.outcome !== "out_of_usage") state.outcome = "toolless"
      return finish(exit)
    }
    const exit = await child.done
    clearInterval(tickTimer)
    return finish(exit)

    function finish(exit: { code: number | null; timedOut: boolean; spawnError: Error | null }): AttemptResult {
      let outcome: AgentRunOutcome
      if (state.modelRejected) outcome = "error"
      else if (state.outcome !== null) outcome = state.outcome
      else if (exit.timedOut) outcome = "timeout"
      else if (exit.spawnError) outcome = "error"
      else if (state.maxTurns) outcome = "max_turns"
      else if (exit.code === 0 && state.sawResult && state.errorText === null) outcome = "completed"
      else outcome = "error"
      const session: SessionRef = kind === "claude_code" ? { kind: "claude", sessionId: state.sessionId } : { kind: "codex", threadId: state.threadId }
      return {
        outcome,
        session,
        ...(state.resetsAt ? { resetsAt: state.resetsAt } : {}),
        permissionDenials: state.permissionDenials,
        incidents: state.incidents,
        structured: state.structured,
        turnsUsed: state.turnsUsed,
        modelRejected: state.modelRejected,
        errorText: state.errorText
      }
    }
  }

  private async reviewAttempt(
    info: AgentInfo,
    input: ReviewRunInput,
    scratch: string,
    model: ModelChoice
  ): Promise<{ outcome: "completed" | "out_of_usage" | "timeout" | "error"; review: ReviewResult | null; modelRejected: boolean; requestRejected?: boolean; errorText: string | null }> {
    const sensitive = await resolveSensitivePaths({ home: this.options.home, env: this.options.env })
    // §3x.3 (D3) The reviewer's event stream is kept (0600), so the next slow review can be measured, and its tool
    // beats are narrated like the worker's (run 3's Codex review left no trace of its 8.5 minutes).
    const logPath = this.reviewLogPath(this.reviews, input.reviewer)
    await ensurePrivateDir(dirname(logPath))
    const log = await open(logPath, "a", 0o600)
    await chmod(logPath, 0o600)
    const keep = (line: string) => {
      void log.appendFile(`${line}\n`).catch(() => undefined)
    }
    const narrator = new Narrator({ agent: input.reviewer, role: "reviewer", emit: (beat) => input.onNarrate?.({ agent: beat.agent, role: "reviewer", text: beat.text }), now: () => (this.options.now ?? (() => new Date()))().getTime(), throttleMs: this.options.narrationThrottleMs })
    const ticker = new ThinkingTicker(narrator, () => (this.options.now ?? (() => new Date()))().getTime(), (seconds) => input.onActivity?.({ kind: "thinking", seconds }))
    const tickTimer = setInterval(() => ticker.tick(), 1_000)
    tickTimer.unref()
    const beatCtx = { root: input.worktreeDir, isAllowed: () => true, agent: input.reviewer, jobNumber: () => null }
    let outcome: "completed" | "out_of_usage" | "timeout" | "error" | null = null
    let modelRejected = false
    let requestRejected = false
    let structured: unknown = null
    // The reviewer's last error, in its own words (sanitized, ≤ 200 chars), so a failed review says why.
    let errorText: string | null = null
    const stop = (value: "out_of_usage" | "error", text?: string | null) => {
      if (outcome === null) outcome = value
      if (text && errorText === null) errorText = text
      void child.kill()
    }
    let child: ReturnType<AgentProcessRegistry["spawn"]>
    let outputPath: string | null = null
    if (input.reviewer === "claude_code") {
      // Review I1 P1-4: a reviewer whose own worktree is under one of its Read denies would review nothing.
      const cwd = await resolveRealpath(input.worktreeDir)
      if (reviewerDenyCoveringCwd(sensitive, cwd) !== null) {
        clearInterval(tickTimer)
        await log.close().catch(() => undefined)
        return { outcome: "error", review: null, modelRejected: false, errorText: "its safety settings would have kept it from reading the pull request's files" }
      }
      const argv = buildClaudeReviewerArgv({
        sensitive,
        systemPrompt: `${SYSTEM_PROMPT_HEADER}\n\n${input.brief}`,
        reviewSchema: JSON.stringify(REVIEW_SCHEMA),
        maxTurns: AGENT_LIMITS.reviewer.claudeMaxTurns,
        model
      })
      child = this.registry.spawn({
        command: info.binPath,
        args: argv,
        cwd: input.worktreeDir,
        env: buildAgentEnv(this.options.env, { kind: "claude_code" }),
        stdin: REVIEWER_KICKOFF,
        wallMs: AGENT_LIMITS.reviewer.wallMs,
        onStdoutLine: (line) => {
          keep(line)
          const event = parseClaudeLine(line)
          if (!event) return
          if (event.kind === "tool_use") {
            ticker.acted()
            const toolInput = typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : {}
            const path = displayPath(toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path, input.worktreeDir)
            if (event.name === "Read") input.onActivity?.({ kind: "read", path })
            if (event.name === "Edit" || event.name === "Write" || event.name === "MultiEdit") input.onActivity?.({ kind: "edit", path })
            const beat = claudeToolBeat(event.name, event.input, beatCtx)
            if (beat) narrator.beat(beat)
          }
          if (event.kind === "tool_result") ticker.toolReturned()
          if (claudeModelRejected(event, model.model)) {
            modelRejected = true
            return stop("error")
          }
          if (event.kind === "init" && !apiKeySourceMatches(info.whoPays, event.apiKeySource)) return stop("error", "it would have billed a different account than the plan showed")
          if (event.kind === "assistant_error" && (event.error === "rate_limit" || event.error === "billing_error")) return stop("out_of_usage")
          if (event.kind === "rate_limit" && claudeUsageSignals(event.event).some((signal) => signal.kind === "rejected")) return stop("out_of_usage")
          if (event.kind === "result") {
            if (event.apiErrorStatus === 429) return stop("out_of_usage")
            // A review made while denied the PR's own files is not a review: never posted (review I1 P1-4).
            if (reviewerWasBlind(event.permissionDenials, cwd)) return stop("error", "it was denied the pull request's own files")
            if (event.isError && errorText === null) errorText = sanitizeUntrusted(event.text, 200) || null
            structured = event.structuredOutput
          }
        }
      })
    } else {
      const runtime = await resolveCodexRuntime(info.binPath, this.options.env.PATH)
      const permissionArgs = codexPermissionArgs({
        role: "reviewer",
        homeRealpath: await resolveRealpath(this.options.home),
        sensitiveRealpaths: sensitive.map((entry) => entry.path),
        codexBinDir: runtime.codexBinDir,
        codexInstallRoot: runtime.codexInstallRoot,
        // B20: the repo's own secrets ("none") and, for the worker, .git read-only.
        repoDenies: await repoSecretPaths(input.worktreeDir),
        // §3y.7: the review worktree is readable even under the $HOME deny (it lives in ~/Library/Caches/…).
        readRoots: [await resolveRealpath(input.worktreeDir)]
      })
      const schemaPath = join(scratch, "review.schema.json")
      await writeFile(schemaPath, schemaFileText(REVIEW_SCHEMA), { mode: 0o600 })
      outputPath = join(scratch, "review.json")
      await rm(outputPath, { force: true })
      const argv = buildCodexReviewerArgv({ worktree: input.worktreeDir, permissionArgs, model, outputPath, schemaPath })
      child = this.registry.spawn({
        command: info.binPath,
        args: argv,
        cwd: input.worktreeDir,
        env: buildAgentEnv(this.options.env, { kind: "codex" }),
        stdin: `${input.brief}\n\n${REVIEWER_KICKOFF}\n`,
        wallMs: AGENT_LIMITS.reviewer.wallMs,
        onStdoutLine: (line) => {
          keep(line)
          const event = parseCodexLine(line)
          if (event?.kind === "item") {
            if (event.phase === "completed") ticker.toolReturned()
            else ticker.acted()
            const beat = codexItemBeat(event.item, beatCtx)
            if (typeof event.item === "object" && event.item !== null && (event.item as { type?: string }).type === "file_change") {
              for (const change of (event.item as { changes?: Array<{ path?: string }> }).changes ?? []) if (change.path) input.onActivity?.({ kind: "edit", path: displayPath(change.path, input.worktreeDir) })
            }
            if (beat) narrator.beat(beat)
          }
          if (!event || event.kind !== "error") return
          if (codexUsageLimit(event.message)) return stop("out_of_usage")
          if (codexModelRejected(event.message, model.model)) {
            modelRejected = true
            return stop("error")
          }
          if (codexUnrecognizedConfig(event.message)) return stop("error", reviewerErrorText(event.message))
          if (codexRequestRejected(event.message)) {
            requestRejected = true
            return stop("error", reviewerErrorText(event.message))
          }
          // A top-level error can be transient ("Reconnecting… 1/5"): kept as the last word, never a stop by itself.
          // A failed turn is the reason itself, so it replaces an earlier transient line.
          if (event.fatal || errorText === null) errorText = reviewerErrorText(event.message)
        }
      })
    }
    const exit = await child.done
    clearInterval(tickTimer)
    await log.close().catch(() => undefined)
    if (outputPath) {
      try {
        structured = await readFile(outputPath, "utf8")
      } catch {
        structured = null
      }
    }
    const final: "completed" | "out_of_usage" | "timeout" | "error" = outcome ?? (exit.timedOut ? "timeout" : exit.code === 0 ? "completed" : "error")
    const review = final === "completed" ? parseReview(structured) : null
    // A completed run that answered keeps no stale transient error (a "Reconnecting…" before a good answer).
    return { outcome: final, review, modelRejected, requestRejected, errorText: review ? null : errorText }
  }
}

/** A reviewer's error line in plain words: a JSON service body is reduced to its `error.message`; sanitized, ≤ 200. */
export function reviewerErrorText(raw: string): string | null {
  let text = raw
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | unknown; message?: unknown }
    const inner = typeof parsed === "object" && parsed !== null && typeof parsed.error === "object" && parsed.error !== null ? (parsed.error as { message?: unknown }).message : parsed?.message
    if (typeof inner === "string" && inner.trim() !== "") text = inner
  } catch {
    // Not JSON: the line itself is the message.
  }
  return sanitizeUntrusted(text, 200) || null
}

/** §3y.10: the worker's Codex profile also denies `<root>/.infinite` (its realpath, when it exists). */
export async function withWizardDirDenied(denies: { none: string[]; readOnly: string[] }, root: string): Promise<{ none: string[]; readOnly: string[] }> {
  const dir = join(root, ".infinite")
  try {
    await access(dir)
  } catch {
    return denies
  }
  const real = await resolveRealpath(dir)
  return denies.none.includes(real) ? denies : { ...denies, none: [...denies.none, real].sort() }
}

/** Runs the reviewer in a throwaway detached worktree of the head SHA (only committed files: no `.env*`). */
export async function reviewInDetachedWorktree(
  runner: Pick<AgentRunner, "review">,
  git: Pick<GitOps, "worktreeAddDetached" | "worktreeRemove">,
  input: { headSha: string; reviewer: AgentKind; brief: string }
): Promise<ReviewResult | ReviewFailure> {
  const { dir } = await git.worktreeAddDetached(input.headSha)
  try {
    return await runner.review({ worktreeDir: dir, reviewer: input.reviewer, brief: input.brief })
  } finally {
    await git.worktreeRemove(dir)
  }
}

function mergeClaims(
  live: readonly Claim[],
  structured: StructuredClaims | null,
  items: readonly ChecklistItem[],
  now: () => Date,
  redact: (text: string) => string
): Claim[] {
  const latest = new Map<string, Claim>()
  for (const claim of live) latest.set(claim.jobId, claim)
  const known = new Set(items.map((item) => item.id))
  for (const claim of structured?.claims ?? []) {
    if (!known.has(claim.job_id) || latest.has(claim.job_id)) continue
    latest.set(claim.job_id, { jobId: claim.job_id, status: claim.status, note: sanitizeUntrusted(redact(claim.note), 500), at: now().toISOString() })
  }
  return [...latest.values()]
}

function mergeQuestions(
  live: readonly AgentQuestion[],
  structured: StructuredClaims | null,
  items: readonly ChecklistItem[],
  redact: (text: string) => string
): AgentQuestion[] {
  const out = [...live]
  const known = new Set(items.map((item) => item.id))
  const seen = new Set(out.map((question) => `${question.jobId}\u0000${question.question}`))
  for (const raw of structured?.questions ?? []) {
    if (!known.has(raw.job_id)) continue
    const question = sanitizeUntrusted(redact(raw.question), 300)
    const why = sanitizeUntrusted(redact(raw.why), 300)
    if (isPlanDecidedTopic(`${question} ${why}`)) continue
    const key = `${raw.job_id}\u0000${question}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      jobId: raw.job_id,
      question,
      options: raw.options ? raw.options.map((option) => ({ label: sanitizeUntrusted(redact(option.label), 120), value: sanitizeUntrusted(redact(option.value), 120) })) : null,
      why
    })
  }
  return out
}

/** Repo-relative inside the repo; outside it, only the file name (never the user's full path). */
function incidentPath(path: string, root: string): string {
  const shown = displayPath(path, root)
  if (shown !== "a file outside the repo") return shown
  return `${sanitizeUntrusted(basename(path), 80)} outside the repo`
}

export type { NarrationBeat }
