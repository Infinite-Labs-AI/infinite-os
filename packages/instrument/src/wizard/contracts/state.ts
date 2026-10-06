// §3d.6 of the wizard build plan (the run state `.infinite/wizard/state.json`, schema
// `infinite-tag.wizard-state.v1`, and the run lock) as code, plus the renderer-agnostic store
// snapshot lane O1 publishes and lane O2's TUI reads.
//
// NORMATIVE. state.json is gitignored, mode 0600, written atomically (temp + rename). A corrupt file
// asks "start fresh?" (never a silent reset). Approvals are authoritative OUTSIDE the repo (the cloud
// run + the in-memory plan hash); a mismatch on resume → "the saved plan changed; re-confirm".
import type { AgentReviewerKind, AgentWorkerKind, WhoPays } from "./agents.js"
import type { AskKind } from "./asks.js"
import type { RuntimeVariant } from "./bridge.js"
import type { WizardCode } from "./codes.js"
import type { ChecklistItem } from "./jobs.js"
import { CHECKLIST_ITEM_SHAPE } from "./jobs.js"
import type { ReportColumnSnapshot, VerdictToolFact } from "./report.js"
import { REPORT_COLUMN_SNAPSHOT_SHAPE } from "./report.js"
import { arrayOf, nullable, oneOf, recordOf, shapeOf } from "./shape.js"
import type { LearnId, StepOutcomeKind, WizardStepId } from "./steps.js"

export const WIZARD_STATE_SCHEMA = "infinite-tag.wizard-state.v1" as const

/** Repo-relative paths the wizard owns (all under the gitignore fence except install.json, which is committed). */
export const WIZARD_PATHS = {
  dir: ".infinite/wizard",
  state: ".infinite/wizard/state.json",
  lock: ".infinite/wizard/run.lock",
  /** `infinite-tag.before-facts.v1`, written by `before` (baseline + baselineBuild inside `facts`); run-scoped. */
  beforeFacts: ".infinite/wizard/before.json",
  /** `infinite-tag.wizard-keys.v1` (carries `runId`); run-scoped. */
  keys: ".infinite/wizard/keys.json",
  planApprovals: ".infinite/wizard/plan-approvals.json",
  editBases: ".infinite/wizard/edit-bases.json",
  reviewLedger: ".infinite/wizard/review-ledger.json",
  proveVisit: ".infinite/wizard/prove-visit.json",
  uninstall: ".infinite/wizard/uninstall.json",
  /** The jobs brief (the agent's, or the parent agent's in nested mode). */
  agentBrief: ".infinite/wizard/agent-brief.md",
  reviewBrief: ".infinite/wizard/review-brief.md",
  prBody: ".infinite/wizard/pr-body.md",
  commitMessage: ".infinite/wizard/commit-message.txt",
  reportJson: ".infinite/wizard/report.json",
  reportMarkdown: ".infinite/wizard/report.md",
  /** The review on hosts with no review API (GitLab, Bitbucket, other). */
  review: ".infinite/wizard/REVIEW.md",
  /** Committed (the edit receipt). */
  installManifest: ".infinite/install.json"
} as const

export const WIZARD_STATE_FILE_MODE = 0o600

/** Branch prefix: `infinite/tag/<YYYY-MM-DD>-<runId first 6 hex>`. */
export const WIZARD_BRANCH_PREFIX = "infinite/tag/" as const

/** `.infinite/wizard/run.lock`. Stale when the pid is dead. */
export interface RunLock {
  pid: number
  startedAt: string
  hostname: string
}

export interface StepRecord {
  outcome: StepOutcomeKind
  /** sha256 of the step's declared inputs; an `ok` step with an unchanged hash is skipped on resume. */
  inputHash: string
  at: string
  code?: WizardCode
}

export type BaseSource = "vercel" | "default_branch" | "origin_head"
export type GitHostKind = "github" | "gitlab" | "bitbucket" | "other"

/** Run markers per moment (the ids a real visit or a rehearsal produced). */
export interface RunMarkers {
  infiniteEventIds?: string[]
  posthogDistinctId?: string | null
  probePath?: string | null
  metaEventIds?: string[]
}

/** One agent role's model as it actually ran (B22). */
export interface AgentModelRecord {
  model: string | null
  effort: string
  /** True when the pinned model was refused and the user's default model ran instead (§3f.7). */
  fallback: boolean
}

/** §3y.1 / §3y.2: the site-file claim this run holds (the cloud's answer; never a repo value). */
export interface SiteClaimState {
  hosts: string[]
  siteSourceKey: string
  collectPath: string
  consentStorageKey: string
  proofPath: "/.well-known/infinite-site-verification.txt"
  state: "pending_proof" | "proven"
  provenAt?: string
}

/**
 * §3y.1: the production host this run uses and where it came from (Infinite, `--production-host`, or the user's
 * answer to the one `before` ask). A null host = "it isn't live yet": the run never asks again.
 */
export interface SiteState {
  productionHost: string | null
  source: "infinite" | "flag" | "answer"
  decidedAt: string
  /** §3y.4: the repo shows a Vercel signal (Infinite hosting, `.vercel/*`, or a `vercel[bot]` deployment); read once per run. */
  vercelSignal?: boolean
  claim?: SiteClaimState
}

export interface WizardRunState {
  schema: typeof WIZARD_STATE_SCHEMA
  /** The cloud run id; null until the `agent` step creates it. */
  runId: string | null
  /**
   * The run's server-clock start (`runs.start` / `runs.get` `startedAt`): a receipt before it is never this
   * run's proof (§3z.8 rule 3). Absent in state files written before it existed.
   */
  runStartedAt?: string | null
  displayId: string
  createdAt: string
  tagVersion: string
  root: string
  appRoot: string
  link: { linkId: string; workspaceName: string; approvedAt: string; runtimeVariant: RuntimeVariant } | null
  steps: Partial<Record<WizardStepId, StepRecord>>
  agent: {
    worker: Exclude<AgentWorkerKind, "none"> | null
    reviewer: Exclude<AgentReviewerKind, "none"> | null
    workerSession: { kind: "claude"; sessionId: string } | { kind: "codex"; threadId: string } | null
    whoPays: { worker: WhoPays | null; reviewer: WhoPays | null }
    /**
     * §3z.12 §3d.6 (B22): the model, effort and any model fallback each role ran with (the run record; also
     * in the plan's cost line and the report notes). `model` is null when the user's default model ran.
     */
    models?: { worker: AgentModelRecord | null; reviewer: AgentModelRecord | null }
    /** Live run 5 (P3): the user's explicit `--reviewer` choice, kept so a plain re-run reviews the same way. */
    reviewerChoice?: "claude" | "codex" | "brief" | "none"
    /**
     * Live run 5 (review P2-3): the reviewer the cloud run row last acknowledged (its start, or a reviewer patch that
     * succeeded). Absent = not known. A reviewer that differs from it is sent again on the next run, so a failed patch,
     * or an app without `tag.runs.reviewer.v1` that is updated later, never leaves the row on an old reviewer.
     */
    cloudReviewer?: AgentReviewerKind
  } | null
  git: { base: string; baseSource: BaseSource; branch: string; baseSha: string; headSha: string | null } | null
  pr: {
    host: GitHostKind
    number: number | null
    url: string | null
    nodeId: string | null
    isDraft: boolean
    round: number
    reviewedSha: string | null
    handledThreadIds: string[]
    mergeSha: string | null
  } | null
  plan: {
    hash: string
    answers: {
      consentMode: "not_required" | "required" | null
      conversions: string[]
      privacyApproved: boolean | null
      npmInstall: boolean | null
      metaGoal: string | null
    }
    lines: Array<{ id: string; approved: boolean | null }>
  } | null
  jobs: ChecklistItem[]
  markers: { before: RunMarkers; rehearsal: RunMarkers; prove: RunMarkers }
  report: { live_today: ReportColumnSnapshot | null; in_pr: ReportColumnSnapshot | null; proven_live: ReportColumnSnapshot | null }
  /** `~/Library/Caches/infinite-tag/snapshots/<runId>/<turn>` (outside the repo and $TMPDIR). */
  snapshot: { dir: string } | null
  /** §3y.1 (optional, additive; schema stays v1): the production host and the site-file claim. */
  site?: SiteState
  /**
   * §3x.6 (optional, additive): what this run's real visit measured of every tool under test, and what the customer
   * filters the one normal page view by. Written by `prove`; THE verdict reads it (`done`, a resumed `prove`).
   */
  proof?: RunProofState
  /**
   * R4-5 (optional, additive): the rehearsal's own RH check results on the commit it rehearsed (the page-change counts,
   * one page view per load…), whether or not a job carries the check. The review's triage reads them: run 4's wrong
   * "Meta lacks SPA page views" went to the agent although the rehearsal had seen Meta's page-change PageView.
   */
  rehearsalChecks?: Array<{ checkId: string; state: "pass" | "problem" | "undetermined"; sha: string }>
}

/** §3x.6 The real visit's per-tool facts and the ids to filter it by (§3x.5 disclosure). */
export interface RunProofState {
  at: string
  tools: VerdictToolFact[]
  /** The server lane was probed (installed): its two document rows are this run's too. */
  laneProbed: boolean
  /** Infinite page views seen leaving on the visit (the rows it landed in the customer's ledger). */
  infinitePageViews: number
  filter: { ga4ClientId: string | null; posthogDistinctId: string | null; metaPageViewAt: string | null }
  /** Review P1-6: null = the merge tree's installed set was read; else why it could not be (the census error). */
  installedUnknown: string | null
}

// ---- the store snapshot (lane O1 publishes it; lane O2's TTY and JSON UIs read it) ----

export interface StoreStepRow {
  id: WizardStepId
  title: string
  state: "pending" | "running" | StepOutcomeKind
  status: string | null
  code: WizardCode | null
  startedAt?: string | null
  /** The last few sub-statuses (the TUI shows the last 5). */
  subs: Array<{ text: string; tone: "ok" | "warn" | "info" | "pending"; at: string }>
}

/** Renderer-agnostic: what a UI needs to draw one frame. `version` bumps on every change. */
export interface WizardStoreSnapshot {
  version: number
  run: { runId: string | null; displayId: string; tagVersion: string; runtimeVariant: RuntimeVariant | null }
  steps: StoreStepRow[]
  currentStep: WizardStepId | null
  learn: LearnId | null
  /**
   * What the run has learned so far, for the Learn cards (the design names the real site, workspace and agents;
   * before the run knows them the cards say what is true without them). Additive and optional: a UI that does
   * not read it loses nothing. Every value is outside text to a renderer (sanitise before drawing).
   */
  learnFacts?: { site?: string | null; workspace?: string | null; worker?: "claude_code" | "codex" | null; reviewer?: "claude_code" | "codex" | "brief" | null }
  narration: Array<{ agent: "claude_code" | "codex"; role: "worker" | "reviewer"; text: string; at: string }>
  /** Stable rows for the agent's jobs; transient claim/checking states never assert a verdict. */
  jobs?: Array<{ id: string; title: string; state: "waiting" | "agent_claim" | "checking" | "passed" | "failed" | "blocked" }>
  /** At most one pending ask (a second throws). */
  pendingAsk: { askId: string; kind: AskKind; payload: unknown } | null
  outro: string | null
  exit: { exitCode: number; prUrl: string | null; reportPath: string | null } | null
}

// ---- shapes ----

const MODEL_RECORD_SHAPE = shapeOf<AgentModelRecord>()("AgentModelRecord", ["model", "effort", "fallback"], [])
const MARKERS_SHAPE = shapeOf<RunMarkers>()("RunMarkers", [], ["infiniteEventIds", "posthogDistinctId", "probePath", "metaEventIds"])
const WHO_PAYS_SHAPE = shapeOf<WhoPays>()("WhoPays", ["payer", "label"], [])

export const RUN_LOCK_SHAPE = shapeOf<RunLock>()("RunLock", ["pid", "startedAt", "hostname"], [])

export const WIZARD_RUN_STATE_SHAPE = shapeOf<WizardRunState>()(
  "WizardRunState",
  [
    "schema",
    "runId",
    "displayId",
    "createdAt",
    "tagVersion",
    "root",
    "appRoot",
    "link",
    "steps",
    "agent",
    "git",
    "pr",
    "plan",
    "jobs",
    "markers",
    "report",
    "snapshot"
  ],
  ["runStartedAt", "site", "proof", "rehearsalChecks"],
  {
    rehearsalChecks: arrayOf(shapeOf<NonNullable<WizardRunState["rehearsalChecks"]>[number]>()("RunState.rehearsalCheck", ["checkId", "state", "sha"], [])),
    proof: shapeOf<RunProofState>()("RunState.proof", ["at", "tools", "laneProbed", "infinitePageViews", "filter", "installedUnknown"], [], {
      tools: arrayOf(
        shapeOf<VerdictToolFact>()("RunState.proof.tool", ["tool", "ids", "connected", "installed", "fired", "ungraded", "receipt", "receiptReason"], [])
      ),
      filter: shapeOf<RunProofState["filter"]>()("RunState.proof.filter", ["ga4ClientId", "posthogDistinctId", "metaPageViewAt"], [])
    }),
    site: shapeOf<SiteState>()("RunState.site", ["productionHost", "source", "decidedAt"], ["vercelSignal", "claim"], {
      claim: shapeOf<SiteClaimState>()("RunState.site.claim", ["hosts", "siteSourceKey", "collectPath", "consentStorageKey", "proofPath", "state"], ["provenAt"])
    }),
    link: nullable(shapeOf<NonNullable<WizardRunState["link"]>>()("RunState.link", ["linkId", "workspaceName", "approvedAt", "runtimeVariant"], [])),
    steps: recordOf(shapeOf<StepRecord>()("StepRecord", ["outcome", "inputHash", "at"], ["code"])),
    agent: nullable(shapeOf<NonNullable<WizardRunState["agent"]>>()("RunState.agent", ["worker", "reviewer", "workerSession", "whoPays"], ["models", "reviewerChoice", "cloudReviewer"], {
      models: shapeOf<NonNullable<NonNullable<WizardRunState["agent"]>["models"]>>()("RunState.models", ["worker", "reviewer"], [], {
        worker: nullable(MODEL_RECORD_SHAPE),
        reviewer: nullable(MODEL_RECORD_SHAPE)
      }),
      workerSession: nullable(oneOf(
        shapeOf<{ kind: "claude"; sessionId: string }>()("ClaudeSession", ["kind", "sessionId"], []),
        shapeOf<{ kind: "codex"; threadId: string }>()("CodexSession", ["kind", "threadId"], [])
      )),
      whoPays: shapeOf<NonNullable<WizardRunState["agent"]>["whoPays"]>()("RunState.whoPays", ["worker", "reviewer"], [], {
        worker: nullable(WHO_PAYS_SHAPE),
        reviewer: nullable(WHO_PAYS_SHAPE)
      })
    })),
    git: nullable(shapeOf<NonNullable<WizardRunState["git"]>>()("RunState.git", ["base", "baseSource", "branch", "baseSha", "headSha"], [])),
    pr: nullable(shapeOf<NonNullable<WizardRunState["pr"]>>()(
      "RunState.pr",
      ["host", "number", "url", "nodeId", "isDraft", "round", "reviewedSha", "handledThreadIds", "mergeSha"],
      []
    )),
    plan: nullable(shapeOf<NonNullable<WizardRunState["plan"]>>()("RunState.plan", ["hash", "answers", "lines"], [], {
      answers: shapeOf<NonNullable<WizardRunState["plan"]>["answers"]>()(
        "RunState.plan.answers",
        ["consentMode", "conversions", "privacyApproved", "npmInstall", "metaGoal"],
        []
      ),
      lines: arrayOf(shapeOf<{ id: string; approved: boolean | null }>()("RunState.plan.line", ["id", "approved"], []))
    })),
    jobs: arrayOf(CHECKLIST_ITEM_SHAPE),
    markers: shapeOf<WizardRunState["markers"]>()("RunState.markers", ["before", "rehearsal", "prove"], [], {
      before: MARKERS_SHAPE,
      rehearsal: MARKERS_SHAPE,
      prove: MARKERS_SHAPE
    }),
    report: shapeOf<WizardRunState["report"]>()("RunState.report", ["live_today", "in_pr", "proven_live"], [], {
      live_today: nullable(REPORT_COLUMN_SNAPSHOT_SHAPE),
      in_pr: nullable(REPORT_COLUMN_SNAPSHOT_SHAPE),
      proven_live: nullable(REPORT_COLUMN_SNAPSHOT_SHAPE)
    }),
    snapshot: nullable(shapeOf<NonNullable<WizardRunState["snapshot"]>>()("RunState.snapshot", ["dir"], []))
  }
)
