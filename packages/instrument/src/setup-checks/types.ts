// Setup checks: a class of finding the receipt lanes structurally cannot produce.
//
// `harness/verify.ts` asks five backends "did an event arrive?". That question can only be asked
// about an event something TRIED to send. A page that was never wired up correctly has nothing to
// be missing, so it verifies exactly as quietly as a page with no conversions at all — the silence
// is identical, and the customer reads it as health.
//
// These checks ask the other question: looking at the markup, SHOULD something have fired? They
// never touch a backend, never load a page, and never leave the machine.
//
// THE THIRD STATE IS THE POINT. `undetermined` is not a soft fail and not a soft pass — it is the
// honest answer whenever the source cannot settle the question (a dynamic attribute, a pixel that
// may live in a tag manager, a runtime contract this build could not read). Folding it into `ok`
// mints the false green the whole feature exists to kill; folding it into `problem` trains people
// to ignore the tool, which is worse than having no tool.

/** The setup checks, by the defect each one exists to catch. */
export type SetupCheckId =
  /** `data-conversion` on an element the runtime will not treat the way the author meant. */
  | "conversion_placement"
  /** A form that submits and emits nothing. */
  | "silent_form"
  /** Meta's `_fbc` click id never captured where a visitor lands. */
  | "click_id_capture"
  /** Meta's automatic events left on, and the managed Meta snippet's counts and order. */
  | "meta_pixel_config"
  /** The same provider id initialised more than once on a page (or managed + adopted together). */
  | "provider_census"
  /** An adopted PostHog's config: proxy, region, SPA page views; readable at all. */
  | "posthog_config"
  /** An adopted GA4 / PostHog / Meta init that starts on every host, previews included. */
  | "host_guard"
  /** Session replay and click capture still on for login, checkout and confirmation pages (D17). */
  | "sensitive_pages"
  /** A Meta event id built in the page, or a standard Meta conversion fired on a click. */
  | "meta_event_id"

/**
 * `info` is not a pass and not a problem: something worth a decision that infinite-tag will never
 * change on its own — today only an ADOPTED Meta pixel with automatic events on (founder decision
 * 10: a plan line with a measured count, never an automatic edit). It ranks above `ok` and below
 * `undetermined`, so it can never hide a check that did not run.
 */
export type SetupFindingState = "ok" | "info" | "problem" | "undetermined"

/**
 * How sure the finding is.
 *
 * `certain` — the defect is read directly off the structure; the fix is not a judgement call.
 * `likely`  — the structure says this is probably wrong, but only the customer knows their site.
 *             Rendered as "Worth checking:", never as an accusation. A check that cries wolf gets
 *             ignored, and an ignored check is worse than none.
 */
export type SetupFindingConfidence = "certain" | "likely"

export const SETUP_FINDING_CODES = [
  "INF_SETUP_CONVERSION_WRONG_ELEMENT",
  "INF_SETUP_CONVERSION_UNKNOWN_VALUE",
  "INF_SETUP_CONVERSION_UNREADABLE",
  "INF_SETUP_RUNTIME_CONTRACT_UNREADABLE",
  "INF_SETUP_FORM_NO_CONVERSION",
  "INF_SETUP_FORM_UNDETERMINED",
  "INF_SETUP_CLICK_ID_NOT_AT_LANDING",
  "INF_SETUP_CLICK_ID_UNDETERMINED",
  "INF_SETUP_CLICK_ID_PRESENT",
  "INF_SETUP_META_AUTOCONFIG_OFF",
  "INF_SETUP_META_AUTOCONFIG_MANAGED_ON",
  "INF_SETUP_META_AUTOCONFIG_ADOPTED_ON",
  "INF_SETUP_META_AUTOCONFIG_UNDETERMINED",
  "INF_SETUP_META_SNIPPET_CENSUS",
  "INF_SETUP_PROVIDER_DUPLICATE_INIT",
  "INF_SETUP_PROVIDER_MANAGED_AND_ADOPTED",
  "INF_SETUP_PROVIDER_GTM_AND_GTAG",
  "INF_SETUP_PROVIDER_MULTIPLE_IDS",
  "INF_SETUP_POSTHOG_CONFIG_UNREADABLE",
  "INF_SETUP_POSTHOG_NOT_PROXIED",
  "INF_SETUP_POSTHOG_SPA_PAGEVIEWS",
  "INF_SETUP_POSTHOG_REGION_MISMATCH",
  "INF_SETUP_POSTHOG_PRIVACY_CHANGED",
  "INF_SETUP_HOST_GUARD_MISSING",
  "INF_SETUP_HOST_GUARD_PRESENT",
  "INF_SETUP_HOST_GUARD_SILENCES_PRODUCTION",
  "INF_SETUP_SENSITIVE_PAGES_RECORDED",
  "INF_SETUP_SENSITIVE_PAGES_HANDLED",
  "INF_SETUP_META_EVENT_ID_PAGE_BUILT",
  "INF_SETUP_META_EVENT_ID_UNDETERMINED",
  "INF_SETUP_META_STANDARD_ON_CLICK"
] as const
export type SetupFindingCode = (typeof SETUP_FINDING_CODES)[number]

export interface SetupFinding {
  check: SetupCheckId
  code: SetupFindingCode
  state: SetupFindingState
  confidence: SetupFindingConfidence
  /** App-root-relative source path. Never DOM text, never an attribute VALUE, never a field value. */
  file?: string
  /** 1-based line of the element the finding is about. */
  line?: number
  /** The whole explanation: symptom, cause, exact fix, consequence of ignoring it. */
  message: string
}

export interface SetupCheckResult {
  check: SetupCheckId
  /** Worst finding wins: problem > undetermined > info > ok. A check with no findings is `ok`. */
  state: SetupFindingState
  findings: SetupFinding[]
}

/** Worst-first, deliberately: one broken element makes the check's answer "broken". */
export function worstState(findings: readonly SetupFinding[]): SetupFindingState {
  if (findings.some((finding) => finding.state === "problem")) return "problem"
  if (findings.some((finding) => finding.state === "undetermined")) return "undetermined"
  if (findings.some((finding) => finding.state === "info")) return "info"
  return "ok"
}
