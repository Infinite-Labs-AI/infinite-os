// The harness's own vocabulary. It deliberately does NOT import the sibling branches' shapes
// (`adopted`, `UnmanagedProvider`, hosting targets): those are adapted at the boundary in
// inspect.ts so this module compiles against main today and against those branches tomorrow.
import type { ProviderId, WorkspaceInstallArtifacts } from "../types.js"

/** The seven rows every run prints, in this order. `gtm` is a container, not an install target. */
export const HARNESS_PROVIDER_ORDER = [
  "ga4",
  "gtm",
  "posthog",
  "meta",
  "x",
  "infinite",
  "server_lane"
] as const
export type HarnessProviderId = (typeof HARNESS_PROVIDER_ORDER)[number]

/**
 * A provider is a state machine, not a boolean. `verified` is reachable only from `installed`
 * and only with a receipt timestamp (see state.ts) — the word is never printed without one.
 */
export type ProviderStateKind =
  | "absent"
  | "adopted"
  | "installed"
  | "verified"
  | "conflict"
  | "skipped"

export type VerificationOutcome =
  | { kind: "not_run" }
  | { kind: "verified"; receiptAt: string }
  | { kind: "not_verifiable"; reason: string }
  | { kind: "no_receipt"; causes: string[] }
  | { kind: "adopted_not_ours" }

export interface ProviderState {
  provider: HarnessProviderId
  state: ProviderStateKind
  /** The PUBLIC key/id in play (measurement id, project key, pixel id, source key). Never a secret. */
  key?: string
  /** File(+line) or one-clause reason the state rests on. Local paths only; never DOM text. */
  evidence?: string
  /** One clause: why this state (e.g. "no key resolved", "left byte-for-byte alone"). */
  reason?: string
  verification: VerificationOutcome
}

/** Failure codes, exactly as the teardown names them (plus one for blockers it did not name). */
export const HARNESS_FAILURE_CODES = [
  "INF_ENV_DIRTY_TREE",
  "INF_DETECT_NO_FRAMEWORK",
  "INF_SOURCE_OUTPUT_OWNERSHIP",
  "INF_POSTHOG_NO_KEY",
  "INF_PLAN_UNMANAGED_TARGET",
  "INF_PLAN_BLOCKED",
  "INF_APPLY_ROLLED_BACK",
  "INF_MARK_STALE_ELEMENT",
  "INF_VERIFY_NO_RECEIPT",
  "INF_VERIFY_INCOMPLETE",
  "INF_ARGS_CONVERSIONS_REQUIRED"
] as const
export type HarnessFailureCode = (typeof HARNESS_FAILURE_CODES)[number]

export type FailureNext = "halt" | "continue"

export interface HarnessFailure {
  step: string
  code: HarnessFailureCode
  message: string
  next: FailureNext
}

export type StepStatus = "ok" | "failed" | "skipped" | "not_run"

export interface StepOutcome {
  id: string
  title: string
  status: StepStatus
  /** One-line note for the report (what happened, or why skipped). */
  note?: string
  failure?: HarnessFailure
}

export type HarnessMode = "check" | "plan" | "apply" | "verify-only"

export interface ConversionCounts {
  proposed: number
  marked: number
  skipped: number
  stale: number
}

export interface HarnessReport {
  version: 1
  mode: HarnessMode
  root: string
  startedAt: string
  finishedAt: string | null
  framework: string | null
  appRoot: string | null
  /** Hosting the server-lane detector saw (vercel / netlify / cloudflare / node / unknown); null before inspect. */
  hosting: string | null
  /** Always all seven, in HARNESS_PROVIDER_ORDER. */
  providers: ProviderState[]
  steps: StepOutcome[]
  conversions: ConversionCounts | null
  /** The first halting failure, or the first continuing one when nothing halted. */
  failure: HarnessFailure | null
  /** Every failure recorded this run, in order. */
  failures: HarnessFailure[]
  /** Things this run did NOT do and says so (GA4 key events, PostHog actions, …). */
  nextSteps: string[]
  /** The pasteable two-sided handoff line. */
  handoff: string
}

/** How the harness classified one provider before planning. */
export type ProviderAction = "install" | "adopt" | "upgrade" | "manual" | "report" | "skip"

export interface ProviderClassification {
  provider: HarnessProviderId
  action: ProviderAction
  reason: string
  /** App-root-relative file the existing install was found in (adopt/manual/report). */
  file?: string
  /** Public id read from flags/artifacts/.env or from the existing snippet. */
  key?: string
}

/**
 * Local mirror of the sibling branch's `detectUnmanagedProviders` return shape. Main returns
 * `string[]`; the tag-harness-wave1 branch returns `{provider, via, file}[]`. `normalizeDetected`
 * in inspect.ts accepts either.
 */
export interface DetectedProvider {
  provider: ProviderId
  via: "snippet" | "gtm"
  /** App-root-relative; "?" when the source (main's string[]) carried no file. */
  file: string
}

export interface ResolvedKeys {
  artifacts: WorkspaceInstallArtifacts
  /** Where each provider's key came from — for the report's evidence column. Never the value. */
  sources: Partial<Record<Exclude<HarnessProviderId, "gtm" | "server_lane">, KeySource>>
}

export type KeySource = "flag" | "artifact-file" | "discovered-artifacts" | "env" | "existing-snippet"
