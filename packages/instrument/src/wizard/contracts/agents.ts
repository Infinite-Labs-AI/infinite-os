// §3f of the wizard build plan (the agent runner) as code: agent kinds, who pays, the AgentRunner
// interface lane O3 implements, the run limits, the env rules, the Codex feature disable list, and
// the two JSON Schemas the agents answer in (`review.schema.json`, `claims.schema.json`, published
// byte-identically under `contracts/tag-wizard-v1/`).
//
// NORMATIVE. The agent can only CLAIM; the wizard's checks decide. Nothing here spends a prompt.
import { posix } from "node:path"

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

/** Why an agent cannot be used in this run. (Codex no longer has a confinement gate: §3f.7, L7 passed.) */
export type AgentUnavailableReason = "not_installed" | "logged_out"

export interface AgentDetectResult {
  worker: AgentInfo | null
  reviewer: AgentInfo | null
  /** The wizard was launched by an agent (§3d.7): the marker env var that said so. */
  nested: { marker: string } | null
  /** Agents that cannot be used in this run, with why. */
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

// ---------------------------------------------------------------------------------------------
// §3f.7 (NORMATIVE amendment, live checks 2026-10-02; supersedes §3f.3 where they differ)
// ---------------------------------------------------------------------------------------------

export type CodexRole = "worker" | "reviewer"

/**
 * The Codex read confinement live check L7 proved (codex-cli 0.159.2): a `-c` permissions PROFILE,
 * never `-s`. `-s` silently overrides the profile and falls back to the legacy workspace-write policy
 * (header `workspace-write [workdir, /tmp, $TMPDIR]`), so the confinement IS the sandbox selection.
 * The profile's paths are realpaths resolved at spawn time, so the argv comes from
 * `codexPermissionArgs` (a pure builder), never from a static string.
 */
export const CODEX_READ_CONFINEMENT = {
  provenBy: "live check L7, 2026-10-02, codex-cli 0.159.2",
  profiles: { worker: "infinite_tag", reviewer: "infinite_tag_ro" },
  projectRootsAccess: { worker: "write", reviewer: "read" }
} as const satisfies {
  provenBy: string
  profiles: Record<CodexRole, string>
  projectRootsAccess: Record<CodexRole, "write" | "read">
}

export interface CodexPermissionInput {
  role: CodexRole
  /** realpath($HOME). Denied (`"none"`): this is what keeps `~/.growth-os*`, `~/.codex/auth.json`, … unreadable. */
  homeRealpath: string
  /**
   * Every resolved SENSITIVE path (§3f.3: GROWTH_OS_HOME, `~/.growth-os*`, the Infinite userData dirs, `~/.codex`, …,
   * the wizard's snapshot cache). One under `$HOME` is already covered by the HOME deny and is omitted; every other
   * one gets its own `"none"` entry.
   */
  sensitiveRealpaths: readonly string[]
  /** realpath(dirname of the codex binary that is exec'd, after wrappers). Re-allowed READ, or Codex cannot start. */
  codexBinDir: string
  /** realpath of the codex install root (e.g. `~/.codex/packages/standalone/releases/<v>`). Re-allowed READ. */
  codexInstallRoot: string
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`)
}

function assertProfilePath(label: string, path: string): void {
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error(`${label}: control character in path`)
  if (!path.startsWith("/")) throw new Error(`${label}: not an absolute path: ${path}`)
  if (posix.normalize(path) !== path || (path !== "/" && path.endsWith("/"))) {
    throw new Error(`${label}: not a normalised realpath: ${path}`)
  }
}

/** A TOML basic-string key (the `-c` value is parsed as TOML by Codex). */
function tomlKey(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * §3f.7: the two `-c` flags that select the confinement profile for a Codex role. Pure; throws on a path
 * that is not an absolute normalised realpath, on `$HOME` = `/`, and on a binary re-allow that would
 * re-open `$HOME` or a sensitive path (a re-allow equal to, or an ancestor of, either).
 *
 * Worker:   `-c default_permissions="infinite_tag"` `-c permissions.infinite_tag.filesystem={":root"="read",
 *           "<home>"="none", "<sensitive not under home>"="none", "<codex bin dir>"="read", "<install root>"="read",
 *           ":project_roots"="write"}`. Reviewer: profile `infinite_tag_ro`, `":project_roots"="read"`.
 * Never contains `-s`, `--sandbox` or `sandbox_mode`.
 */
export function codexPermissionArgs(input: CodexPermissionInput): string[] {
  const profile = CODEX_READ_CONFINEMENT.profiles[input.role]
  const home = input.homeRealpath
  assertProfilePath("homeRealpath", home)
  if (home === "/") throw new Error("homeRealpath: $HOME is /; refusing a profile that denies the whole disk")
  input.sensitiveRealpaths.forEach((path, index) => assertProfilePath(`sensitiveRealpaths[${index}]`, path))
  const reAllows = [
    ["codexBinDir", input.codexBinDir],
    ["codexInstallRoot", input.codexInstallRoot]
  ] as const
  for (const [label, path] of reAllows) {
    assertProfilePath(label, path)
    for (const denied of [home, ...input.sensitiveRealpaths]) {
      if (isUnder(denied, path)) throw new Error(`${label}: re-allowing ${path} would re-open ${denied}`)
    }
  }
  const entries: Array<[string, "read" | "write" | "none"]> = [[":root", "read"], [home, "none"]]
  const seen = new Set<string>([":root", home])
  for (const path of input.sensitiveRealpaths) {
    if (isUnder(path, home) || seen.has(path)) continue
    seen.add(path)
    entries.push([path, "none"])
  }
  for (const [, path] of reAllows) {
    if (seen.has(path)) continue
    seen.add(path)
    entries.push([path, "read"])
  }
  entries.push([":project_roots", CODEX_READ_CONFINEMENT.projectRootsAccess[input.role]])
  const table = entries.map(([key, access]) => `${tomlKey(key)}="${access}"`).join(", ")
  return ["-c", `default_permissions="${profile}"`, "-c", `permissions.${profile}.filesystem={${table}}`]
}

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

/**
 * Codex 0.159.2 feature names disabled for EVERY role, worker and reviewer (`-c features.<name>=false`).
 * §3f.3's list + `shell_snapshot` / `skill_search` (the reviewer lacked them) + §3f.7's `view_image`, `goals`
 * and `multi_agent` (still exposed after the old list, L8). A renamed feature fails `--strict-config` loudly.
 */
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
  "memories",
  "shell_snapshot",
  "skill_search",
  "view_image",
  "goals",
  "multi_agent"
] as const

/**
 * Non-feature `-c` settings every Codex role carries (§3f.3 + §3f.7). `skills.include_instructions=false`:
 * user skills in `~/.codex/skills` load even under `--ignore-user-config` (L2 caveat).
 */
export const CODEX_REQUIRED_CONFIG = [
  'approval_policy="never"',
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  "skills.include_instructions=false"
] as const

/** Flags on every Codex argv, the resume line included. */
export const CODEX_REQUIRED_FLAGS = ["--ignore-user-config", "--strict-config"] as const

/** Never on any agent argv (§3f.3). Prefix `--dangerously` covers every `--dangerously*` flag. */
export const FORBIDDEN_AGENT_FLAGS = ["--bare", "--safe-mode", "--approve-for-me", "--dangerously"] as const

/** §3f.7: never on a Codex argv. `-s` / `--sandbox` silently drop the confinement profile. */
export const FORBIDDEN_CODEX_FLAGS = ["-s", "--sandbox"] as const
/** §3f.7: never as a Codex `-c` key (the resume line uses the profile flags instead). */
export const FORBIDDEN_CODEX_CONFIG_KEYS = ["sandbox_mode"] as const

/**
 * §3f.7: required on BOTH Claude roles (L4b): it confines file tools to the working directories (symlink escapes
 * included), loads no user hooks or plugins, and keeps plan billing (`system/init.apiKeySource === "none"`).
 * It replaces `--setting-sources user`. SENSITIVE_DENIES stay as defence in depth.
 */
export const CLAUDE_REQUIRED_FLAGS = ["--restricted"] as const

/**
 * The §3f.3 + §3f.7 argv rules as a pure check, for O3's argv builders (at spawn time and in tests). Returns every
 * violation; an empty array means the argv is allowed. It checks the safety flags only, not the whole invocation.
 */
export function agentArgvViolations(kind: AgentKind, argv: readonly string[]): string[] {
  const out: string[] = []
  for (const arg of argv) {
    for (const flag of FORBIDDEN_AGENT_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`) || (flag === "--dangerously" && arg.startsWith(flag))) out.push(`forbidden flag ${arg}`)
    }
  }
  if (kind === "claude_code") {
    for (const flag of CLAUDE_REQUIRED_FLAGS) if (!argv.includes(flag)) out.push(`missing ${flag}`)
    if (argv.includes("--setting-sources")) out.push("--setting-sources is replaced by --restricted (§3f.7)")
    return out
  }
  const configValues: string[] = []
  argv.forEach((arg, index) => {
    if (arg === "-c" || arg === "--config") configValues.push(argv[index + 1] ?? "")
    else if (arg.startsWith("--config=")) configValues.push(arg.slice("--config=".length))
    else if (arg.startsWith("-c") && arg.length > 2) configValues.push(arg.slice(2))
  })
  for (const arg of argv) {
    for (const flag of FORBIDDEN_CODEX_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`) || (flag === "-s" && /^-s[a-z-]/.test(arg))) out.push(`forbidden codex flag ${arg}`)
    }
  }
  for (const value of configValues) {
    const key = value.split("=")[0]!.trim()
    if ((FORBIDDEN_CODEX_CONFIG_KEYS as readonly string[]).includes(key)) out.push(`forbidden codex config ${key}`)
  }
  for (const flag of CODEX_REQUIRED_FLAGS) if (!argv.includes(flag)) out.push(`missing ${flag}`)
  if (!configValues.some((value) => /^default_permissions="infinite_tag(_ro)?"$/.test(value))) out.push("missing default_permissions profile")
  if (!configValues.some((value) => /^permissions\.infinite_tag(_ro)?\.filesystem=\{/.test(value))) out.push("missing permissions filesystem table")
  for (const feature of CODEX_DISABLED_FEATURES) {
    if (!configValues.includes(`features.${feature}=false`)) out.push(`missing features.${feature}=false`)
  }
  for (const setting of CODEX_REQUIRED_CONFIG) if (!configValues.includes(setting)) out.push(`missing ${setting}`)
  return out
}

/**
 * §3f.7 scratch rule: under the Codex profile `/tmp`, `/private/tmp` and `$TMPDIR` stay READABLE, so token-bearing
 * wizard scratch (`tag.mcp.json`, MCP tokens, snapshots) lives under `$HOME` (which the profile denies), 0700:
 * `<home>/Library/Caches/infinite-tag/<runId>/`. Never under a temp dir.
 */
export const WIZARD_TOKEN_SCRATCH_HOME_RELATIVE = "Library/Caches/infinite-tag" as const

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
