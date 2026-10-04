// §3d.3 (ask kinds and answers) and §3d.4 (plan line kinds and the `--yes` policy) of the wizard
// build plan, as code. `YES_POLICY` is the table lane O1 enforces.
//
// NORMATIVE. `--yes` answers NO ask except a `plan` line whose kind is marked yes below. A missing
// consent mode ALWAYS parks the run at `plan` (INF_WIZ_NEEDS_ANSWERS, exit 3); every other unapproved
// "never" line leaves its jobs `blocked:needs_you` and the run continues. `--yes` never approves
// conversion marking.

export const ASK_KINDS = [
  "link-code",
  "confirm",
  "single",
  "multi",
  "text",
  "plan",
  "agent-questions",
  "teammate-comments",
  "merge-ready",
  "tty-handover"
] as const
export type AskKind = (typeof ASK_KINDS)[number]

/** The two non-answers an ask can close with. */
export const ASK_CANCELLED = "__cancelled__" as const
export const ASK_TIMEOUT = "__timeout__" as const
export type AskNonAnswer = typeof ASK_CANCELLED | typeof ASK_TIMEOUT

export interface AskOption {
  label: string
  value: string
}

// ---- §3d.4 plan lines ----

export const PLAN_LINE_KINDS = [
  "install_provider",
  "server_lane",
  "npm_install",
  "preview_guard_managed",
  "agent_budget",
  "improve_additive",
  "consent_mode",
  "conversion_names",
  "privacy_text",
  "remove_duplicate",
  "preview_guard_adopted",
  "autoconfig_off_adopted",
  "sensitive_pages",
  "posthog_defaults_bump_adopted",
  "capture_beside_adopted_pixel",
  "retire_fbc_writer",
  "meta_relay",
  "meta_goal",
  /** §3x.3 (F6): an adopted Meta pixel that counts only the first page of a visit; the user approves the fix. */
  "meta_spa_page_views",
  /** R4-8: an adopted GA4 that sends no page_view on a client-side page change; the user approves the fix. */
  "ga4_spa_page_views",
  "user_action",
  // B28: the 7-day check-in that follows the deploy (shown only; `checkinOptIn` stays the accepted default).
  "checkin"
] as const
export type PlanLineKind = (typeof PLAN_LINE_KINDS)[number]

/**
 * §3d.3 `PlanLine`. `ownership` is an ADDITIVE field (F0 deviation, see the F0 note): `improve_additive`
 * is auto-approvable under `--yes` only on a MANAGED provider (the wizard's own code) and never on an
 * ADOPTED one, so the line must say which. Absent = treated as adopted (fail-safe: never auto-approved).
 */
export interface PlanLine {
  id: string
  kind: PlanLineKind
  text: string
  requires: "approval" | "info" | "user_action"
  editable: boolean
  measured?: { value: string | number; window: string }
  jobIds?: string[]
  ownership?: "managed" | "adopted"
}

export interface PlanDecisionsPayload {
  consentMode: "not_required" | "required" | null
  conversionNames: string[]
  privacyText: string | null
  npmInstall: string | null
}

/** `yes` = `--yes` approves it; `never` = only the user; `n/a` = shown only (user_action lines). */
export type YesPolicyValue = "yes" | "never" | "n/a"

/** §3d.4 `YES_POLICY`. `improve_additive` depends on the provider's ownership (R2-10). */
export const YES_POLICY: { readonly [K in PlanLineKind]: YesPolicyValue | { managed: "yes"; adopted: "never" } } = {
  install_provider: "yes",
  server_lane: "yes",
  npm_install: "yes",
  preview_guard_managed: "yes",
  agent_budget: "yes",
  // It rewrites the customer's api_host / capture_pageview on an adopted provider.
  improve_additive: { managed: "yes", adopted: "never" },
  // Needs --consent-mode; a missing consent mode parks the run at `plan`.
  consent_mode: "never",
  conversion_names: "never",
  privacy_text: "never",
  // Each changes an existing tag or sends data.
  remove_duplicate: "never",
  preview_guard_adopted: "never",
  autoconfig_off_adopted: "never",
  sensitive_pages: "never",
  posthog_defaults_bump_adopted: "never",
  capture_beside_adopted_pixel: "never",
  retire_fbc_writer: "never",
  meta_relay: "never",
  // §3x.3 (F6): a change to the customer's own Meta tag.
  meta_spa_page_views: "never",
  // R4-8: a change to the customer's own GA4 tag.
  ga4_spa_page_views: "never",
  // The D16 recommendation: an informational default the user can change.
  meta_goal: "yes",
  // GTM edit, Traffic Permissions, connect a tool, the GA4 page-change setting: shown only.
  user_action: "n/a",
  // B28: an information line; nothing to approve.
  checkin: "n/a"
}

/** Whether `--yes` approves this line. */
export function yesApproves(line: Pick<PlanLine, "kind" | "ownership">): boolean {
  const policy = YES_POLICY[line.kind]
  if (typeof policy === "object") return (line.ownership ?? "adopted") === "managed" && policy.managed === "yes"
  return policy === "yes"
}

/**
 * The plan line kinds that MAY stay HUMAN in nested-agent mode (§3d.7, R2-14): every `never` kind (consent,
 * conversion names, privacy text, meta_relay, every line that changes an existing tag) plus `improve_additive`,
 * which is user-only ONLY when it improves an ADOPTED provider. A kind-level list cannot say that, so this is the
 * conservative superset; decide a concrete line with `isNestedUserOnly(line)`.
 */
export const NESTED_USER_ONLY_LINE_KINDS: readonly PlanLineKind[] = PLAN_LINE_KINDS.filter((kind) => {
  const policy = YES_POLICY[kind]
  return policy === "never" || typeof policy === "object"
})

/**
 * Whether a concrete plan line stays HUMAN in nested mode (§3d.7): an `--answers` file never satisfies it; the
 * wizard asks it only through a prompt it opens on /dev/tty itself. A managed `improve_additive` is NOT user-only
 * (it is a `--yes` line); an adopted or unspecified one is (fail-safe, as in `yesApproves`).
 */
export function isNestedUserOnly(line: Pick<PlanLine, "kind" | "ownership">): boolean {
  const policy = YES_POLICY[line.kind]
  if (typeof policy === "object") return (line.ownership ?? "adopted") !== "managed" || policy.managed !== "yes"
  return policy === "never"
}

/** §3d.4 "Asks under --yes" (R2-15): `--yes` answers none of these. */
export const YES_ASK_POLICY: { readonly [K in AskKind]: "plan_yes_lines_only" | "never" | "n/a" } = {
  "link-code": "n/a",
  confirm: "never",
  single: "never",
  multi: "never",
  text: "never",
  plan: "plan_yes_lines_only",
  "agent-questions": "never",
  "teammate-comments": "never",
  "merge-ready": "n/a",
  "tty-handover": "n/a"
}

// ---- §3d.3 payloads and answers ----

export interface AskPayloads {
  "link-code": { code: string; site: { repoLabel: string; appRoot: string; folderLabel: string } }
  confirm: { question: string; defaultYes: boolean }
  single: { question: string; options: AskOption[]; default?: string }
  multi: { question: string; options: AskOption[]; default?: string[] }
  text: { question: string; maxLength: number }
  plan: { lines: PlanLine[]; decisions: PlanDecisionsPayload }
  "agent-questions": { questions: Array<{ itemId: string; question: string; options?: AskOption[]; why: string }> }
  "teammate-comments": { comments: Array<{ threadId: string; author: string; path: string; line: number | null; excerpt: string }> }
  /** §3x.6 (R3-6) `incomplete`: what the PR lacks that the plan approved (the in-PR verdict's words); absent = nothing. */
  "merge-ready": { prUrl: string; number: number; summary: string; incomplete?: string }
  "tty-handover": { reason: "gpg" | "ssh" | "hook"; command: string }
}

export interface AskAnswers {
  /** Display only; ESC → `__cancelled__`. */
  "link-code": never
  confirm: boolean
  single: string
  multi: string[]
  text: string
  plan: { approved: string[]; declined: string[]; edits: Record<string, string> }
  "agent-questions": { answers: Record<string, string> }
  "teammate-comments": { actOn: string[] }
  "merge-ready": "open" | "later"
  /** Resolves when the child exits. */
  "tty-handover": { exitCode: number | null }
}

export type AskAnswer<K extends AskKind> = AskAnswers[K] | AskNonAnswer
