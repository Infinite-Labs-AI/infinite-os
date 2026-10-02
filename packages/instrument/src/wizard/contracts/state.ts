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
import type { ReportColumnSnapshot } from "./report.js"
import { REPORT_COLUMN_SNAPSHOT_SHAPE } from "./report.js"
import { arrayOf, nullable, oneOf, recordOf, shapeOf } from "./shape.js"
import type { LearnId, StepOutcomeKind, WizardStepId } from "./steps.js"

export const WIZARD_STATE_SCHEMA = "infinite-tag.wizard-state.v1" as const

/** Repo-relative paths the wizard owns (all under the gitignore fence except install.json, which is committed). */
export const WIZARD_PATHS = {
  dir: ".infinite/wizard",
  state: ".infinite/wizard/state.json",
  lock: ".infinite/wizard/run.lock",
  prBody: ".infinite/wizard/pr-body.md",
  reviewBrief: ".infinite/wizard/review-brief.md",
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

export interface WizardRunState {
  schema: typeof WIZARD_STATE_SCHEMA
  /** The cloud run id; null until the `agent` step creates it. */
  runId: string | null
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
}

// ---- the store snapshot (lane O1 publishes it; lane O2's TTY and JSON UIs read it) ----

export interface StoreStepRow {
  id: WizardStepId
  title: string
  state: "pending" | "running" | StepOutcomeKind
  status: string | null
  code: WizardCode | null
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
  narration: Array<{ agent: "claude_code" | "codex"; role: "worker" | "reviewer"; text: string; at: string }>
  /** At most one pending ask (a second throws). */
  pendingAsk: { askId: string; kind: AskKind; payload: unknown } | null
  outro: string | null
  exit: { exitCode: number; prUrl: string | null; reportPath: string | null } | null
}

// ---- shapes ----

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
  [],
  {
    link: nullable(shapeOf<NonNullable<WizardRunState["link"]>>()("RunState.link", ["linkId", "workspaceName", "approvedAt", "runtimeVariant"], [])),
    steps: recordOf(shapeOf<StepRecord>()("StepRecord", ["outcome", "inputHash", "at"], ["code"])),
    agent: nullable(shapeOf<NonNullable<WizardRunState["agent"]>>()("RunState.agent", ["worker", "reviewer", "workerSession", "whoPays"], [], {
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
