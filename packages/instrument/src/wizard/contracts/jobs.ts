// §3e of the wizard build plan (the checklist job registry and the claim channel) as code: jobs 1–16
// with their checks, the item model and states, the allowlist's global deny, the claim channel's MCP
// tools, the edit receipt, and the Installer / JobRegistry / CheckRunner interfaces (method names
// fixed here; lanes O7, O8, O6 implement them and O9 registers through `CheckRunner.register`).
//
// NORMATIVE. Item states are COMPUTED by the wizard, never written by the agent: a claim moves an item
// no further than `claimed`, and `proven` needs a check whose evidence carries THIS run's id.
import type { ManagedTextEdit, WorkspaceInstallArtifacts } from "../../types.js"
import type { AskAnswers, PlanLine, PlanLineKind } from "./asks.js"
import type { TagHosting, TagKeys } from "./bridge.js"
import { arrayOf, oneOf, shapeOf } from "./shape.js"
import type { TestExpect, TestMode, TestResult, TestTool } from "./test-engine.js"

// ---------------------------------------------------------------------------------------------
// §3e.1 Jobs 1–16
// ---------------------------------------------------------------------------------------------

/** S static, B build, T0 offline, T1 live read-only, RH rehearsal, PV prove (the real visit), P passive. */
export const CHECK_TIERS = ["S", "B", "T0", "T1", "RH", "PV", "P"] as const
export type CheckTier = (typeof CHECK_TIERS)[number]

/** A check id (`posthog_config`, `click_test`, `server_lane_probe_receipt`, …). Open set: lanes register more. */
export type CheckId = string

export interface JobCheckSpec {
  tier: CheckTier
  checkId: CheckId
  /**
   * LF4 close round 2 (P1-1): a pass of this check PROVES the job's change is in the code (it fails when the change is
   * missing). Only such a check may tick a job; a check that also passes on code with nothing of the job in it (no
   * click-fired standard event, the mirror's event ids, the PostHog privacy drift, the build) may only fail it.
   */
  provesChange?: true
}

export const JOB_IDS = [
  "server_lane_mount",
  "unusual_layout",
  "posthog_improve",
  "ga4_improve",
  "meta_improve",
  "duplicates_remove",
  "preview_guard",
  "server_conversions",
  "identify_reset",
  "conversions_to_tools",
  "setup_check_fixes",
  "csp",
  "redirect_utms",
  "privacy_paragraph",
  "build_fix",
  "review_comments"
] as const
export type JobId = (typeof JOB_IDS)[number]

export interface JobSpec {
  jobId: JobId
  n: number
  title: string
  /** The plan line kinds that must be approved before an item of this job is seeded (adopted-provider jobs). */
  requiresApprovedLine: readonly PlanLineKind[]
  checks: readonly JobCheckSpec[]
  /** The states an item walks through after a claim (§3e.1 "Done path"). */
  donePath: readonly JobItemState[]
}

const c = (tier: CheckTier, checkId: CheckId): JobCheckSpec => ({ tier, checkId })
/** A check whose pass proves the job's change is in the code (`JobCheckSpec.provesChange`). */
const p = (tier: CheckTier, checkId: CheckId): JobCheckSpec => ({ tier, checkId, provesChange: true })

/** §3e.1, one row per job. `checks` lists every check the table names (alternatives included). */
export const JOB_TABLE: { readonly [J in JobId]: JobSpec & { jobId: J } } = {
  server_lane_mount: {
    jobId: "server_lane_mount",
    n: 1,
    title: "Mount the server lane",
    requiresApprovedLine: [],
    checks: [p("S", "server_lane_mount_order"), c("B", "build"), c("PV", "server_lane_probe_receipt")],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  unusual_layout: {
    jobId: "unusual_layout",
    n: 2,
    title: "Put the tag in the real app shell",
    requiresApprovedLine: [],
    checks: [p("S", "rescan_app_found"), c("B", "build"), c("T0", "one_runtime_per_page"), c("T1", "byte_census")],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  posthog_improve: {
    jobId: "posthog_improve",
    n: 3,
    title: "Improve the existing PostHog",
    requiresApprovedLine: ["improve_additive"],
    checks: [
      // Passes on an untouched config too (its privacy settings unchanged): it may only fail the job.
      c("S", "posthog_config"),
      p("S", "next_rewrites_exact"),
      // LF4 close round 2 (P1-1): the target's own setting is in the adopted init (api_host through the proxy,
      // capture_pageview 'history_change', the current defaults date).
      p("S", "posthog_improve_applied"),
      c("RH", "posthog_via_proxy_once"),
      c("PV", "posthog_distinct_id_receipt")
    ],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  ga4_improve: {
    jobId: "ga4_improve",
    n: 4,
    title: "Improve the existing GA4",
    requiresApprovedLine: ["improve_additive"],
    // R4-8: one GA4 page_view per client-side page change, measured by the rehearsal's page change.
    checks: [c("T1", "ga4_loader_id"), c("RH", "ga4_one_page_view"), c("RH", "ga4_spa_page_view"), c("PV", "ga4_seen_leaving")],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  meta_improve: {
    jobId: "meta_improve",
    n: 5,
    title: "Improve the existing Meta pixel",
    requiresApprovedLine: ["improve_additive", "capture_beside_adopted_pixel"],
    checks: [
      c("S", "click_id_capture"),
      // Passes on a page with no Meta event at all: it may only fail the job.
      c("S", "meta_event_id_from_helper"),
      // LF4 close round 2 (P1-1): the mirror item's own check (the browser standard events go through infiniteMetaMirror).
      p("S", "meta_mirror_wired"),
      // LF4-P1-2: the autoConfig item's own check (automatic events off before the adopted pixel's init).
      p("S", "meta_autoconfig_off"),
      c("T1", "meta_traffic_permissions"),
      c("RH", "meta_pixel_once"),
      // §3x.3 (F6): one PageView per client-side navigation, measured by the rehearsal's page change.
      c("RH", "meta_spa_page_view"),
      p("T0", "fbc_capture"),
      c("PV", "meta_seen_leaving")
    ],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  duplicates_remove: {
    jobId: "duplicates_remove",
    n: 6,
    title: "Remove duplicate tags",
    requiresApprovedLine: ["remove_duplicate"],
    checks: [
      // A duplicate item is seeded only when the census found two starts: "at most once" is the removal itself.
      p("S", "census_one_per_tool"),
      p("S", "census_posthog_init_once"),
      p("S", "census_ga4_config_once"),
      p("S", "census_meta_init_once"),
      c("RH", "one_beacon_per_tool"),
      c("PV", "one_beacon_per_tool")
    ],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  preview_guard: {
    jobId: "preview_guard",
    n: 7,
    title: "Keep previews silent (existing tags)",
    requiresApprovedLine: ["preview_guard_adopted"],
    checks: [p("S", "adopted_init_guarded"), c("T0", "host_matrix"), c("RH", "preview_self_silent"), c("T1", "meta_host_matrix")],
    donePath: ["done_in_code", "proven"]
  },
  server_conversions: {
    jobId: "server_conversions",
    n: 8,
    title: "Report conversions from the server",
    requiresApprovedLine: ["conversion_names"],
    checks: [
      // Each fails when there is no reportInfiniteOutcome call in the job's files.
      p("S", "outcome_after_success"),
      p("S", "outcome_declared"),
      p("S", "event_id_stable"),
      p("S", "no_pii_in_outcome"),
      c("B", "build"),
      c("P", "first_real_outcome")
    ],
    donePath: ["done_in_code", "waiting_real_event", "proven"]
  },
  identify_reset: {
    jobId: "identify_reset",
    n: 9,
    title: "Join visits to accounts",
    requiresApprovedLine: [],
    checks: [p("S", "identify_on_auth_success"), c("S", "reset_on_every_signout"), c("B", "build"), c("P", "first_identify")],
    donePath: ["done_in_code", "waiting_real_event", "proven"]
  },
  conversions_to_tools: {
    jobId: "conversions_to_tools",
    n: 10,
    // R4-5 (live run 4): the helpers send to GA4 and PostHog only; Infinite counts conversions from the server lane. "to
    // every tool" promised more, and the reviewer flagged the missing Infinite event as a bug.
    title: "Send conversions to GA4 and PostHog",
    requiresApprovedLine: ["conversion_names"],
    // T0 click_test for static HTML / Vite, RH click_test for every other framework.
    // §3z.12 §3e.1 (B15): `first_real_conversion` (P) reads baseline(runId, since = the deploy time) on a re-run.
    // §3x.3: an outcome conversion (signup, lead, booking, purchase, trial) carries `track_after_success` instead of
    // the click test (its success branch cannot run in a no-send load); a click conversion keeps the click test.
    // LF4 close round 2 (P1-1): `no_fbq_standard_on_click` passes with nothing of the job in the code, so a click
    // conversion also carries `conversion_tracked` (its infiniteTrack call is in the job's files).
    checks: [
      p("T0", "click_test"),
      c("RH", "click_test"),
      c("S", "no_fbq_standard_on_click"),
      p("S", "conversion_tracked"),
      p("S", "track_after_success"),
      c("P", "first_real_conversion")
    ],
    donePath: ["done_in_code", "waiting_real_event", "proven"]
  },
  setup_check_fixes: {
    jobId: "setup_check_fixes",
    n: 11,
    title: "Fix the setup-check findings",
    requiresApprovedLine: [],
    checks: [p("S", "setup_rerun_clean"), p("T0", "click_test"), c("RH", "click_test")],
    donePath: ["done_in_code", "proven"]
  },
  csp: {
    jobId: "csp",
    n: 12,
    title: "Let the content security policy allow the tags",
    requiresApprovedLine: [],
    checks: [p("S", "csp_hosts"), c("T1", "csp_header"), c("RH", "no_csp_violation")],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  redirect_utms: {
    jobId: "redirect_utms",
    n: 13,
    title: "Keep UTMs through redirects",
    requiresApprovedLine: [],
    checks: [c("T1", "redirect_walk")],
    donePath: ["done_in_code", "waiting_deploy", "proven"]
  },
  privacy_paragraph: {
    jobId: "privacy_paragraph",
    n: 14,
    title: "Add the privacy paragraph",
    requiresApprovedLine: ["privacy_text"],
    checks: [p("S", "privacy_names_installed_tools")],
    donePath: ["done_in_code", "proven"]
  },
  build_fix: {
    jobId: "build_fix",
    n: 15,
    title: "Fix new build failures",
    requiresApprovedLine: [],
    checks: [p("B", "build_green_or_baseline")],
    donePath: ["done_in_code"]
  },
  review_comments: {
    jobId: "review_comments",
    n: 16,
    title: "Fix review comments",
    requiresApprovedLine: [],
    checks: [c("S", "pr_checks_pass")],
    donePath: ["done_in_code", "proven"]
  }
}

/**
 * LF4 close round 2 (P1-1): this job's `tier:checkId` PROVES its change is in the code when it passes
 * (`JobCheckSpec.provesChange`). Every other check may only fail the job.
 */
export function checkProvesChange(jobId: string, tier: CheckTier, checkId: CheckId): boolean {
  const spec = (JOB_TABLE as Record<string, JobSpec | undefined>)[jobId]
  return spec?.checks.some((check) => check.tier === tier && check.checkId === checkId && check.provesChange === true) ?? false
}

/** The plan-decided topics `ask_user` refuses (`{parked:false, reason:"decided by the plan"}`). */
export const PLAN_DECIDED_TOPICS = ["consent", "conversion_names", "privacy", "banner", "npm"] as const

/** Never the agent's job, and never in any brief: each goes to the user as one line. */
export const NEVER_AGENT_JOBS = [
  "cookie_banner",
  "consent_calls",
  "conversion_names",
  "gtm_container_edits",
  "meta_domain_settings",
  "replace_live_secret",
  "merge",
  "deploy"
] as const

/** Code jobs (owner `code`): the npm install (C1), commit + PR (C2), GA4 key events (C3, gated on job 10). */
export const CODE_JOB_IDS = ["npm_install", "commit_pr", "ga4_key_events"] as const

// ---------------------------------------------------------------------------------------------
// §3e.2 Allowlist: the global deny overrides any job
// ---------------------------------------------------------------------------------------------

export const GLOBAL_DENY_GLOBS = [
  ".env*",
  "**/.env*",
  "package-lock.json",
  "**/package-lock.json",
  "pnpm-lock.yaml",
  "**/pnpm-lock.yaml",
  "yarn.lock",
  "**/yarn.lock",
  "bun.lockb",
  "**/bun.lockb",
  "bun.lock",
  "**/bun.lock",
  "npm-shrinkwrap.json",
  "**/npm-shrinkwrap.json",
  "package.json",
  "**/package.json",
  // Anchored anywhere, not only at the repo root: the installer writes `.infinite/` under its root, which is the
  // APP root in a monorepo (`apps/web/.infinite/install.json`).
  ".git/**",
  "**/.git/**",
  ".infinite/**",
  "**/.infinite/**",
  ".claude/**",
  "**/.claude/**",
  ".codex/**",
  "**/.codex/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/node_modules/**"
] as const

// ---------------------------------------------------------------------------------------------
// §3e.5 Items and states
// ---------------------------------------------------------------------------------------------

export const JOB_ITEM_STATES = [
  "pending",
  "claimed",
  "done_in_code",
  "waiting_deploy",
  "waiting_real_event",
  "proven",
  "not_needed",
  "blocked",
  "failed"
] as const
export type JobItemState = (typeof JOB_ITEM_STATES)[number]

export const BLOCKED_REASONS = ["needs_you", "agent_blocked", "out_of_usage", "consent_touched", "outside_allowlist", "toolless"] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

/** A check's state on an item. `not_run` exists only here; check results are pass/problem/undetermined/info. */
export type ItemCheckState = "pass" | "problem" | "undetermined" | "info" | "not_run"

export type Evidence = { file: string; line: number } | { url: string }

export type ClaimStatus = "done" | "blocked" | "not_needed"

/** A reference to an edit record in `.infinite/install.json` `edits`. */
export interface EditRef {
  editId: string
  file: string
}

export interface ChecklistItemCheck {
  id: CheckId
  tier: CheckTier
  state: ItemCheckState
  reason?: string
  at?: string
  runId?: string
}

/** §3e.5 `ChecklistItem`. Item id = `<jobId>:<target>`, e.g. `posthog_improve:proxy`. */
export interface ChecklistItem {
  id: string
  jobId: JobId | (typeof CODE_JOB_IDS)[number]
  n: number
  title: string
  owner: "code" | "agent"
  trigger: { finding: string; evidence: Evidence[] }
  allow: { files: string[]; create: string[] }
  checks: ChecklistItemCheck[]
  claim?: { status: ClaimStatus; note: string; at: string }
  state: JobItemState
  /** Set when state is `blocked`. */
  blockedReason?: BlockedReason
  edits?: EditRef[]
  /**
   * §3x.2 The wizard's last note on this item (a failed check, a safety-check refusal, a block reason), ≤300 chars,
   * sanitized like claim notes. Shown in the "Not done" line, the PR checklist and the report's job list.
   */
  note?: string
}

/** §3x.2 The most a `ChecklistItem.note` keeps. */
export const ITEM_NOTE_MAX_CHARS = 300

// ---------------------------------------------------------------------------------------------
// §3e.3 The claim channel (MCP stdio server `infinite_tag`)
// ---------------------------------------------------------------------------------------------

export const MCP_SERVER_NAME = "infinite_tag" as const
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const
/** The header the wizard's loopback MCP bridge requires (32-byte token). */
export const MCP_TOKEN_HEADER = "x-infinite-tag-token" as const
export const CLAIM_TOOL_NAMES = ["job_list", "job_claim", "report_progress", "ask_user"] as const
export type ClaimToolName = (typeof CLAIM_TOOL_NAMES)[number]
/** Claude's tool ids: `mcp__infinite_tag__<tool>`. */
export const claudeToolId = (tool: ClaimToolName): string => `mcp__${MCP_SERVER_NAME}__${tool}`

export const CLAIM_LIMITS = { noteMaxChars: 500, progressMaxChars: 120, questionMaxChars: 300, whyMaxChars: 300 } as const

export interface Claim {
  jobId: string
  status: ClaimStatus
  note: string
  files?: string[]
  at: string
}

export interface AgentQuestion {
  jobId: string
  question: string
  options: Array<{ label: string; value: string }> | null
  why: string
}

export interface JobListResult {
  jobs: Array<{ id: string; title: string; allow: { files: string[]; create: string[] }; rules: string[] }>
}

export interface JobClaimInput {
  job_id: string
  status: ClaimStatus
  note: string
  files?: string[]
}

/** Never says "verified". */
export interface JobClaimResult {
  recorded: true
  next: "the wizard will run its own checks" | "fix the static check failures and claim this job again"
  staticChecks?: { state: "pass" | "problem" | "undetermined" | "not_run"; problems: string[] }
}

export interface ReportProgressInput {
  job_id: string
  text: string
}

export interface AskUserInput {
  job_id: string
  question: string
  options?: Array<{ label: string; value: string }>
  why: string
}

export type AskUserResult =
  | { parked: true; note: "continue other jobs; the wizard will ask and resume you" }
  | { parked: false; reason: "decided by the plan" }

// ---------------------------------------------------------------------------------------------
// §3e.6 The edit receipt (`.infinite/install.json`, committed; lane O7)
// ---------------------------------------------------------------------------------------------

/** One recorded edit. `beforeHash: null` = the file was created. `textEdits` is REQUIRED (agent edits too). */
export interface WizardEditRecord {
  id: string
  file: string
  jobId: string | null
  planLineId: string | null
  by: "wizard" | "agent"
  beforeHash: string | null
  afterHash: string
  textEdits: ManagedTextEdit[]
  runId: string
}

/** The public IDs this install emitted (they are in the committed code anyway); `doctor` reads them. */
export interface InstallManifestIds {
  ga4: string[]
  posthog: { projectKey: string; apiHost: string } | null
  meta: string[]
  infinite: { siteSourceKey: string } | null
}

/** A wizard install's manifest `workspaceId`: `"wizard:" + <first 16 hex of repoFingerprint>`; never a cloud id. */
export function wizardManifestWorkspaceId(repoFingerprint: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(repoFingerprint)
  if (!match) throw new Error("repoFingerprint must be sha256:<64 hex>")
  return `wizard:${match[1]!.slice(0, 16)}`
}

// ---------------------------------------------------------------------------------------------
// §3e.7 Installer, JobRegistry, CheckRunner (method names fixed here)
// ---------------------------------------------------------------------------------------------

/** One check's result. Undetermined never counts as pass; `info` never changes a score. */
export interface CheckResult {
  checkId: CheckId
  state: "pass" | "problem" | "undetermined" | "info"
  reason?: string
  /**
   * LF4 close round 2 (P2-2): on a problem, the check found the job's change MISSING from the code (no call, no setting,
   * no mount), as opposed to a change that is there but wrong. Never set on another state; never stored on the item.
   */
  absent?: true
  evidence?: Evidence[]
  tier: CheckTier
  at: string
  /** The run whose facts produced it (proof only counts with THIS run's id). */
  runId: string | null
}

/** A provider ID read from an env var instead of a literal (R1-28). */
export interface EnvSourcedId {
  tool: TestTool
  envName: string
  file: string
  line: number
}

export interface CensusEntry {
  tool: TestTool | "x"
  /** What declared it: `gtag('config')`, `posthog.init`, `fbq('init')`, a managed block, GTM, `<GoogleAnalytics>`, `ReactGA.initialize`. */
  kind: "gtag_config" | "posthog_init" | "fbq_init" | "managed_block" | "gtm" | "next_google_analytics" | "react_ga"
  /** The literal id, or null when it is env-sourced or computed. */
  id: string | null
  file: string
  line: number
  owner: "managed" | "adopted"
}

/** Lane O6's census output (per page and provider, no dedupe). */
export interface CensusResult {
  entries: CensusEntry[]
  envSourcedIds: EnvSourcedId[]
  identify: { identifyCalls: Evidence[]; resetCalls: Evidence[] }
}

export interface BuildResult {
  ok: boolean
  /** A stable signature of the failures, so new failures can be told from the baseline's. */
  failureSignature: string[]
  durationMs: number
}

/** One offline (T0) scenario. Lanes O6 names the ids; the params are scenario-specific. */
export interface T0Scenario {
  id: string
  checkId: CheckId
  params: Readonly<Record<string, unknown>>
}

export interface CheckContext {
  runId: string | null
  signal?: AbortSignal
  now(): Date
}

export type CheckFn = (input: unknown, ctx: CheckContext) => Promise<CheckResult | CheckResult[]>

/** A unified diff of one agent turn, by file, with the added lines and their line numbers. */
export interface TurnDiff {
  files: Array<{ path: string; added: Array<{ line: number; text: string }>; removed: Array<{ line: number; text: string }> }>
}

/** What every grader call carries besides the facts (§3z.12 §3e.7, B11). */
export interface GradeTestRunContext {
  /** Timestamp of the observed facts, rather than the later grading time (saved visits). */
  now?: () => Date
  cmpDetected: TestResult["environment"]["cmpDetected"]
  envSourcedIds: readonly EnvSourcedId[]
  /** The site's consent mode (keys `infinite.consentMode` / the plan answer); null = unknown. */
  consentMode: "required" | "not_required" | null
  /** The tools installed on the site (census + install); null = unknown. */
  installedTools: readonly TestTool[] | null
  /** Whose Meta pixel the site runs; null = no Meta pixel (or unknown). */
  metaPixelOwnership: "managed" | "adopted" | null
  /**
   * §3x.3 (F6): the load ran a client-side navigation (the request carried `spaNavigation`). Only then is a Meta pixel
   * with no PageView after it graded `meta_spa_page_view_missing`. Absent = not requested.
   */
  spaNavigation?: boolean
}

export interface CheckRunner {
  run(checkId: CheckId, input: unknown): Promise<CheckResult | CheckResult[]>
  buildBaseline(): Promise<BuildResult>
  build(): Promise<BuildResult>
  /** User-approved, sandboxed frozen-lockfile install; only called from `before`. */
  installDependencies?(onOutput: (line: string) => void): Promise<{ ok: boolean; reason: string | null }>
  t0(scenarios: readonly T0Scenario[], artifacts: WorkspaceInstallArtifacts): Promise<CheckResult[]>
  liveBytes(urls: readonly string[], expect: TestExpect): Promise<CheckResult[]>
  redirectWalk(urls: readonly string[]): Promise<CheckResult[]>
  /**
   * T1 `csp_header` (lane O9). `expect` (lane O6 fix round, additive, review O6-R4): O9's check needs the
   * connected ids to know which hosts the policy must allow; without it the check is undetermined.
   */
  csp(url: string, expect?: TestExpect): Promise<CheckResult[]>
  metaDomains(domains: readonly string[], pixelIds: readonly string[]): Promise<CheckResult[]>
  census(root: string, appRoot: string): Promise<CensusResult>
  setupChecks(appRoot: string): Promise<CheckResult[]>
  envTargets(envSourcedIds: readonly EnvSourcedId[], hosting: TagHosting): Promise<CheckResult[]>
  /** §3f.9, after EVERY agent turn, before any build or T0. A `problem` reverts the hunk and blocks the job. */
  turnGate(diff: TurnDiff, ctx: { connectionIds: readonly string[] }): Promise<CheckResult[]>
  /**
   * §3h.8: THE grader of desktop test facts (the only one). §3z.12 §3e.7 (B11): `consentMode`,
   * `installedTools` and `metaPixelOwnership` are REQUIRED on every call (null = honestly unknown: a silent
   * tool then reads `undetermined (test_error)`, never a guessed verdict). A call with another run's facts
   * throws.
   */
  gradeTestRun(result: TestResult, expect: TestExpect, mode: TestMode, ctx: GradeTestRunContext): Promise<Record<TestTool, CheckResult>>
  /** §3z.12 §3e.7: the per-check results (RH / PV / T1 ids the jobs name) for the report's per-check cells. */
  gradeTestRunChecks(result: TestResult, expect: TestExpect, mode: TestMode, ctx: GradeTestRunContext): Promise<CheckResult[]>
  /** The seam lane O9 registers its checks through. Registering an id twice throws. */
  register(checkId: CheckId, fn: CheckFn): void
}

/** The repo scan (lane O7). Lanes may add optional fields; the ones here are what other lanes read. */
export interface ScanResult {
  root: string
  appRoot: string
  framework: string
  packageManager: string | null
  /** Files scanned, and whether the scan cap cut it short. */
  fileCount: number
  truncated: boolean
}

/** What `before` measured, for `seedCandidates` and the Before column (lane O8 builds it). */
export interface BeforeFacts {
  hosting: TagHosting
  keys: TagKeys
  census: CensusResult
  dryLive: TestResult | null
  checks: CheckResult[]
  /** The final production host the dry load landed on (part of the preview guard's exempt list). */
  observedProductionHost: string | null
}

export interface PlanModel {
  /** sha256 of the lines + decisions; persisted so a resume re-confirms a changed plan. */
  hash: string
  lines: PlanLine[]
  decisions: {
    consentMode: "not_required" | "required" | null
    conversionNames: string[]
    privacyText: string | null
    npmInstall: string | null
  }
}

export type PlanApprovals = AskAnswers["plan"]

export interface InstallerApplyResult {
  ok: boolean
  rolledBack: boolean
  edits: WizardEditRecord[]
  /** Steps that still need a hand-added edit; each becomes an open job, never "installed". */
  openJobs: string[]
}

export interface UninstallReport {
  reversed: string[]
  /** Files whose current hash no longer equals the recorded afterHash: "changed since; left as is". */
  leftAsIs: string[]
}

export interface Installer {
  scan(opts: { root: string; appRoot?: string; hosting?: TagHosting }): Promise<ScanResult>
  artifactsFromKeys(keys: TagKeys, answers: PlanModel["decisions"]): WorkspaceInstallArtifacts
  buildPlan(scan: ScanResult, keys: TagKeys, before: BeforeFacts, candidates: readonly ChecklistItem[]): PlanModel
  planAsk(plan: PlanModel): { lines: PlanLine[]; decisions: PlanModel["decisions"] }
  apply(plan: PlanModel, approvals: PlanApprovals): Promise<InstallerApplyResult>
  /**
   * Review I1 P1-2 (additive, optional): why the approved install cannot be applied as planned (null = it can),
   * WITHOUT writing anything. The install step reads it before any cloud write (the site source).
   */
  preflight?(plan: PlanModel, approvals: PlanApprovals): string | null
  /** Resume-only refresh of whole generated files whose committed ownership hashes still match. */
  refreshManaged?(plan: PlanModel, approvals: PlanApprovals): Promise<{ changedFiles: string[]; blocked: string[] }>
  npmInstall(pkgs: readonly string[]): Promise<{ ok: boolean; edits: WizardEditRecord[] }>
  recordEdits(edits: readonly WizardEditRecord[]): Promise<void>
  refreshEditReceiptFromHead(): Promise<{ refreshed: boolean }>
  uninstall(opts: { root: string; dryRun: boolean }): Promise<UninstallReport>
}

export interface JobRegistry {
  /** In `before`; deterministic; each candidate names the plan line kind it needs. Nothing from agent input. */
  seedCandidates(scan: ScanResult, beforeFacts: BeforeFacts): ChecklistItem[]
  /** After `plan`: drops declined, marks unanswered `blocked:needs_you`. */
  applyApprovals(candidates: readonly ChecklistItem[], plan: PlanModel, approvals: PlanApprovals): ChecklistItem[]
  allowedFiles(item: ChecklistItem): { files: string[]; create: string[] }
  brief(items: readonly ChecklistItem[]): string
  /**
   * Live run 5: the exact bytes the job's brief prescribes, their file and where in it (`prescribedPasteOf`), or null. Read
   * only by the rehearsal (`applyRehearsalToJobs`): a rehearsal problem on a job whose bytes are in place is Infinite's.
   */
  prescribedPaste(item: ChecklistItem): PrescribedPaste | null
  checksFor(item: ChecklistItem, tier: CheckTier): JobCheckSpec[]
  apply(items: readonly ChecklistItem[], results: readonly CheckResult[], runId: string, options?: { afterDeploy?: boolean; awaitingVisit?: boolean }): ChecklistItem[]
  reverifyNotNeeded(item: ChecklistItem, scan: ScanResult): { agrees: boolean; evidence: Evidence[] }
}

/**
 * Live run 5 (P2): where a job's brief tells the agent to put its prescribed bytes. `after_ga4_config`: the next statement
 * after the adopted `gtag('config', id)`; `before_meta_init_element`: its own element right before the element that holds
 * `fbq('init')`; `before_meta_init`: its own line right before `fbq('init', id)`.
 */
export type PastePlacement =
  | { kind: "after_ga4_config"; measurementId: string }
  | { kind: "before_meta_init_element" }
  | { kind: "before_meta_init"; pixelId: string }

/** Live run 5 (P2): a job's prescribed bytes (Infinite's own code), their file, and the place the brief names. */
export interface PrescribedPaste {
  file: string
  text: string
  placement: PastePlacement
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

const EVIDENCE_SHAPE = oneOf(
  shapeOf<{ file: string; line: number }>()("FileEvidence", ["file", "line"], []),
  shapeOf<{ url: string }>()("UrlEvidence", ["url"], [])
)

export const CHECKLIST_ITEM_SHAPE = shapeOf<ChecklistItem>()(
  "ChecklistItem",
  ["id", "jobId", "n", "title", "owner", "trigger", "allow", "checks", "state"],
  ["claim", "blockedReason", "edits", "note"],
  {
    trigger: shapeOf<ChecklistItem["trigger"]>()("ChecklistItem.trigger", ["finding", "evidence"], [], { evidence: arrayOf(EVIDENCE_SHAPE) }),
    allow: shapeOf<ChecklistItem["allow"]>()("ChecklistItem.allow", ["files", "create"], []),
    checks: arrayOf(shapeOf<ChecklistItemCheck>()("ChecklistItemCheck", ["id", "tier", "state"], ["reason", "at", "runId"])),
    claim: shapeOf<NonNullable<ChecklistItem["claim"]>>()("ChecklistItem.claim", ["status", "note", "at"], []),
    edits: arrayOf(shapeOf<EditRef>()("EditRef", ["editId", "file"], []))
  }
)

export const WIZARD_EDIT_RECORD_SHAPE = shapeOf<WizardEditRecord>()(
  "WizardEditRecord",
  ["id", "file", "jobId", "planLineId", "by", "beforeHash", "afterHash", "textEdits", "runId"],
  [],
  { textEdits: arrayOf(shapeOf<ManagedTextEdit>()("ManagedTextEdit", ["offset", "removed", "inserted"], [])) }
)
