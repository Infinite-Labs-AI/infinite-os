// §3f of the wizard build plan (the agent runner) as code: agent kinds, who pays, the AgentRunner
// interface lane O3 implements, the run limits, the env rules, the Codex feature disable list, and
// the two JSON Schemas the agents answer in (`review.schema.json`, `claims.schema.json`, published
// byte-identically under `contracts/tag-wizard-v1/`).
//
// NORMATIVE. The agent can only CLAIM; the wizard's checks decide. Nothing here spends a prompt.
import type { ChecklistItem, Claim, AgentQuestion, WizardEditRecord } from "./jobs.js"

/** Who does the work (`runs.worker`). `none` = deterministic lanes only. */
export type AgentWorkerKind = "claude_code" | "codex" | "none"
/** Who reviews (`runs.reviewer`). `brief` = the printed one-agent review brief. */
export type AgentReviewerKind = "claude_code" | "codex" | "brief" | "none"
export type AgentKind = "claude_code" | "codex"
export const AGENT_KINDS = ["claude_code", "codex"] as const satisfies readonly AgentKind[]

export type AgentPayer = "plan" | "api_key" | "third_party" | "unknown"

/** §3f.2, from `claude auth status --json` / `codex login status` (no prompt spent; never logs email/org). */
export interface WhoPays {
  payer: AgentPayer
  /** e.g. "your Claude plan (max) pays", "billed to your <provider> account". */
  label: string
}

export interface AgentInfo {
  kind: AgentKind
  binPath: string
  version: string
  whoPays: WhoPays
}

/** Why an installed agent cannot be used in this run. */
export type AgentUnavailableReason = "not_installed" | "logged_out" | "read_confinement_unproven"

export interface AgentDetectResult {
  worker: AgentInfo | null
  reviewer: AgentInfo | null
  /** The wizard was launched by an agent (§3d.7): the marker env var that said so. */
  nested: { marker: string } | null
  /** Agents found but not usable, with why (e.g. Codex until live check L7 proves a read confinement). */
  unavailable?: Array<{ kind: AgentKind; reason: AgentUnavailableReason }>
}

/** A resumable agent session. */
export type SessionRef = { kind: "claude"; sessionId: string } | { kind: "codex"; threadId: string }

export type AgentRunOutcome = "completed" | "out_of_usage" | "timeout" | "max_turns" | "toolless" | "error"

export interface AgentRunResult {
  outcome: AgentRunOutcome
  session: SessionRef
  claims: Claim[]
  questions: AgentQuestion[]
  /** Verbatim reset time from the provider, when out of usage. */
  resetsAt?: string
  permissionDenials: number
  /** Paths the fence reverted this run. */
  reverted: string[]
  edits: WizardEditRecord[]
}

export interface RunJobsInput {
  items: ChecklistItem[]
  brief: string
  budget: { maxTurns: number; wallMs: number }
  resume?: SessionRef
  onClaim(claim: Claim): void
  onAsk(question: AgentQuestion): void
  onProgress(progress: { jobId: string; text: string }): void
  onNarrate(beat: { agent: AgentKind; role: "worker" | "reviewer"; text: string }): void
}

export type ReviewChecklistItemId = (typeof REVIEW_ITEMS)[number]

/** The parsed `review.schema.json` output. */
export interface ReviewResult {
  verdict: "looks_good" | "changes_suggested"
  summary: string
  checklist: Array<{ item: ReviewChecklistItemId; status: "pass" | "fail" | "cant_tell"; note: string }>
  findings: Array<{
    id: string
    item: ReviewChecklistItemId
    severity: "blocker" | "should" | "nit" | "question"
    path: string
    line: number | null
    body: string
    suggested_fix: string | null
  }>
}

export type ReviewFailure = { error: "unparseable" | "timeout" | "out_of_usage" }

/** §3f.1. Lane O3 implements it; every other lane gets it through WizardDeps. */
export interface AgentRunner {
  detect(): Promise<AgentDetectResult>
  runJobs(input: RunJobsInput): Promise<AgentRunResult>
  review(input: { worktreeDir: string; reviewer: AgentKind; brief: string }): Promise<ReviewResult | ReviewFailure>
  /** True while any agent child of this run is running (the engine invariant, §3a.9.4). */
  isAgentAlive(): boolean
  killAll(): Promise<void>
}

/** §3f.4 limits. */
export const AGENT_LIMITS = {
  jobs: { maxTurns: 30, wallMs: 10 * 60_000, maxResumeRounds: 3 },
  reviewFix: { maxRounds: 2, maxTurnsPerRound: 15, wallMsPerRound: 5 * 60_000 },
  reviewer: { claudeMaxTurns: 25, wallMs: 10 * 60_000 },
  /** SIGTERM to the process group, then SIGKILL after this. */
  killGraceMs: 1_000,
  /** Narration: at most one beat per this many ms; text cap. */
  narrationThrottleMs: 3_000,
  narrationMaxChars: 120
} as const

/**
 * The Codex read confinement live check L7 proved (`-c` / `-P` setting), or null until it passes.
 * While null, NO Codex argv is built in any role: `detect()` reports Codex `read_confinement_unproven`
 * and the wizard prints the review brief instead (§3a.9.2, §6 item 5(f)).
 */
export const CODEX_READ_CONFINEMENT: readonly string[] | null = null

/** Env vars that mark a nested agent session (§3d.7); stripped from every agent child (§3f.3). */
export const NESTING_ENV_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX"
] as const

/** Every inherited var with this prefix is stripped; then the run's own two MCP vars go on the Codex child ONLY. */
export const INFINITE_TAG_ENV_PREFIX = "INFINITE_TAG_" as const
export const MCP_ENV = { url: "INFINITE_TAG_MCP_URL", token: "INFINITE_TAG_MCP_TOKEN" } as const

/** Codex 0.159.2 feature names disabled for every role (`-c features.<name>=false`); L8 confirms none is exposed. */
export const CODEX_DISABLED_FEATURES = [
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "code_mode_host",
  "apps",
  "plugins",
  "hooks",
  "memories"
] as const

/** Never on any agent argv (§3f.3). `--restricted` only if live check L4b passes. */
export const FORBIDDEN_AGENT_FLAGS = ["--bare", "--safe-mode", "--approve-for-me", "--dangerously"] as const

/** Claude tools: the worker's set and the reviewer's set. Never Bash or Web tools. */
export const CLAUDE_WORKER_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"] as const
export const CLAUDE_REVIEWER_TOOLS = ["Read", "Glob", "Grep"] as const

/** The review checklist items (wf4-pr-review-loop §2; R6 = no banner/consent edits, consent mode only recorded). */
export const REVIEW_ITEMS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15", "R16"] as const

/** §3f.8, published as `contracts/tag-wizard-v1/review.schema.json` (byte-identical; a test asserts it). */
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "checklist", "findings"],
  properties: {
    verdict: { enum: ["looks_good", "changes_suggested"] },
    summary: { type: "string", maxLength: 2000 },
    checklist: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "status", "note"],
        properties: {
          item: { enum: [...REVIEW_ITEMS] },
          status: { enum: ["pass", "fail", "cant_tell"] },
          note: { type: "string", maxLength: 500 }
        }
      }
    },
    findings: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "item", "severity", "path", "line", "body", "suggested_fix"],
        properties: {
          id: { type: "string", pattern: "^F[0-9]{1,2}$" },
          item: { enum: [...REVIEW_ITEMS] },
          severity: { enum: ["blocker", "should", "nit", "question"] },
          path: { type: "string", maxLength: 300 },
          line: { type: ["integer", "null"] },
          body: { type: "string", maxLength: 1500 },
          suggested_fix: { type: ["string", "null"], maxLength: 1500 }
        }
      }
    }
  }
} as const

/** §3e.3 fallback, published as `contracts/tag-wizard-v1/claims.schema.json` (byte-identical; a test asserts it). */
export const CLAIMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims", "questions"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["job_id", "status", "note"],
        properties: {
          job_id: { type: "string" },
          status: { enum: ["done", "blocked", "not_needed"] },
          note: { type: "string", maxLength: 500 }
        }
      }
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["job_id", "question", "options", "why"],
        properties: {
          job_id: { type: "string" },
          question: { type: "string", maxLength: 300 },
          options: {
            type: ["array", "null"],
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "value"],
              properties: { label: { type: "string" }, value: { type: "string" } }
            }
          },
          why: { type: "string", maxLength: 300 }
        }
      }
    }
  }
} as const

/** The bytes of a published schema file: two-space JSON plus a trailing newline. */
export function schemaFileText(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`
}
