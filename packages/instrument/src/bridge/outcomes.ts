// How bridge failures become step outcomes: the §3z.4 table (NORMATIVE, A6), in ONE place every step uses.
//
// | Failure                                                                     | Outcome                          |
// |-----------------------------------------------------------------------------|----------------------------------|
// | no descriptor / unsafe, malformed or stale descriptor / no app (refused)    | blocked NO_APP (NOT_MAC off      |
// |                                                                             | darwin; SIGNED_OUT per state)    |
// | 402 `subscription_required`                                                 | blocked SUBSCRIPTION_REQUIRED    |
// | `signed_out`, `unauthorized`, `cloud_auth_failed`                           | blocked SIGNED_OUT               |
// | `link_invalid`, `link_not_found`, `link_revoked` (after the link step)      | failed halt LINK_DECLINED        |
// | a required capability missing, or 503 `capability_unavailable` (no state)   | failed halt BRIDGE_PROTOCOL      |
// | 504 `upstream_timeout`, 502 `cloud_error`, `busy`, `rate_limited` (after one| parked INFINITE_UNAVAILABLE      |
// | wait), `internal_error` retryable                                           |                                  |
// | `internal_error` not retryable                                              | blocked NO_APP (Linked sites)    |
// | `site_setup_locked` on `site-source`                                        | parked SITE_LOCKED               |
// | `site_setup_locked` on conversions / an uninstall piece; `role_required`    | a user line; the step continues  |
// | `claimed_by_other` on proof-claim or a real_visit start                     | the lost-claim path              |
// | 409 `foreign_site_hosts` `infinite_workspace` (any verb; keys refuses the   | failed halt LINK_DECLINED        |
// | whole of Infinite's own workspace, review I2 P2-2)                          | (link the site to its own one)   |
// | 503 `capability_unavailable` `internal_workspace_unconfigured`              | parked INFINITE_UNAVAILABLE      |
// |                                                                             | (plain line; nothing changed)    |
//
// The client waits ONCE for `Retry-After` on a 429 before the error reaches this table (`client.ts`).
// Steps that already degrade honestly (`before`'s dry_live, the rehearsal tests, the baseline read) keep
// turning the TRANSIENT failures into `undetermined` (`isTransientBridgeFailure`), never a halt; every HARD
// failure still stops them (`hardStopOutcome`). A cancelled call (the run's own signal) is never an outcome.
//
// The errors are read structurally (`code`, `state`, `retryable`, `upstreamStatus`), so a test fake that
// throws a plain object with the §3a.2 envelope fields maps exactly like the real client's `BridgeError`.
import { BRIDGE_ERROR_STATUS, type TagBridgeClient, type TagCapability } from "../wizard/contracts/bridge.js"
import type { StepOutcome } from "../wizard/contracts/deps.js"
import { BridgeDiscoveryError, isBridgeDiscoveryError } from "./errors.js"

export function discoveryOutcome(error: BridgeDiscoveryError): StepOutcome {
  if (error.wizardCode === "INF_WIZ_BRIDGE_PROTOCOL") {
    return { kind: "failed", code: error.wizardCode, message: error.message, next: "halt" }
  }
  return { kind: "blocked", code: error.wizardCode, reason: error.message }
}

export function missingCapabilities(bridge: TagBridgeClient, needed: readonly TagCapability[]): TagCapability[] {
  return needed.filter((capability) => !bridge.has(capability))
}

export function protocolOutcome(missing: readonly TagCapability[]): StepOutcome {
  return {
    kind: "failed",
    code: "INF_WIZ_BRIDGE_PROTOCOL",
    message: `Your Infinite app does not offer ${missing.join(", ")} yet. Update the Infinite app, then run npx infinite-tag again.`,
    next: "halt"
  }
}

export const SUBSCRIPTION_MESSAGE =
  "This workspace needs an active Infinite subscription (the tag is free; it works with the paid Infinite app). Subscribe in the Infinite app, then run npx infinite-tag again."
export const APP_GONE_MESSAGE = "The Infinite app stopped answering (it may have quit or restarted). Open Infinite, then run npx infinite-tag again to continue."
export const INFINITE_UNAVAILABLE_MESSAGE = "Infinite did not answer; run npx infinite-tag again in a minute."
export const SITE_LOCKED_MESSAGE = "A website test is running on this site in Infinite, so its setup is locked."
/** Review I2 P2-2: Infinite's own workspace is never a wizard target (R2-01, §3z.6); the user re-links. */
export const INFINITE_WORKSPACE_MESSAGE = "This site is linked to Infinite's own workspace. Link it to its own workspace and run npx infinite-tag again."
/** §3z.6: Infinite's cloud cannot tell which workspace is its own, so it refuses every wizard read and write for now. */
export const INTERNAL_WORKSPACE_UNCONFIGURED_MESSAGE =
  "Infinite cannot set up sites right now (a setting is missing on Infinite's side). Nothing was changed."
export const LINKED_SITES_MESSAGE = "The Infinite app's list of linked sites is damaged. Open Infinite › Settings › Linked sites (Start over), then run npx infinite-tag again."

/** The §3a.2 fields a bridge failure carries (the real `BridgeError` and every test fake). */
export interface BridgeFailureLike {
  code: string
  state?: string
  retryable?: boolean
  upstreamStatus?: number
  message?: string
}

export function asBridgeFailure(error: unknown): BridgeFailureLike | null {
  if (typeof error !== "object" || error === null) return null
  const record = error as { code?: unknown; state?: unknown; retryable?: unknown; upstreamStatus?: unknown; message?: unknown }
  if (typeof record.code !== "string" || record.code.startsWith("INF_WIZ_")) return null
  return {
    code: record.code,
    ...(typeof record.state === "string" ? { state: record.state } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(typeof record.upstreamStatus === "number" ? { upstreamStatus: record.upstreamStatus } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {})
  }
}

/** The bridge code of a thrown error, or null when it is not a bridge failure. */
export function bridgeFailureCode(error: unknown): string | null {
  return asBridgeFailure(error)?.code ?? null
}

/** `error.state`, passed through verbatim (§3z.3, A5). */
export function bridgeFailureState(error: unknown): string | null {
  return asBridgeFailure(error)?.state ?? null
}

/**
 * True for the failures that mean "Infinite (or its cloud) did not answer this time" (§3z.4 row 6): a
 * degrading step turns them into `undetermined`; every other step parks INFINITE_UNAVAILABLE.
 */
export function isTransientBridgeFailure(error: unknown): boolean {
  const failure = asBridgeFailure(error)
  if (!failure) return false
  switch (failure.code) {
    case "upstream_timeout":
    case "cloud_error":
    case "busy":
    case "rate_limited":
      return true
    case "internal_error":
      return failure.retryable === true
    default:
      return false
  }
}

/**
 * The outcome for a HARD bridge failure (one no step may degrade into "unknown"), or null for anything else
 * (a transient failure, a state the step words itself, a cancelled call, a bug).
 */
export function hardStopOutcome(error: unknown): StepOutcome | null {
  if (isBridgeDiscoveryError(error)) return discoveryOutcome(error)
  const failure = asBridgeFailure(error)
  if (!failure) return null
  switch (failure.code) {
    case "subscription_required":
      return { kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED", reason: SUBSCRIPTION_MESSAGE }
    case "signed_out":
    case "unauthorized":
      return { kind: "blocked", code: "INF_WIZ_SIGNED_OUT", reason: "The Infinite app is signed out. Sign in, then run npx infinite-tag again." }
    case "cloud_auth_failed":
      return {
        kind: "blocked",
        code: "INF_WIZ_SIGNED_OUT",
        reason: "The Infinite app could not sign in to Infinite's cloud. Sign in again in the Infinite app, then run npx infinite-tag again."
      }
    case "link_revoked":
    case "link_not_found":
    case "link_invalid":
      return {
        kind: "failed",
        code: "INF_WIZ_LINK_DECLINED",
        message:
          failure.code === "link_invalid"
            ? `The workspace this site is linked to is not available on this Mac${failure.state ? ` (${failure.state})` : ""}. Open it in Infinite once, or link again: run npx infinite-tag again.`
            : "This site's link to Infinite was removed (Settings › Linked sites). Run npx infinite-tag again to link it.",
        next: "halt"
      }
    case "capability_missing":
      return { kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL", message: `${failure.message ?? "A bridge capability is missing."} Update the Infinite app, then run npx infinite-tag again.`, next: "halt" }
    case "foreign_site_hosts":
      // Review I2 P2-2: Infinite's own workspace stops the run on ANY verb (keys refuses it first); every other
      // state (another site's hosts, …) is a refusal the step words itself as a line.
      return failure.state === "infinite_workspace" ? { kind: "failed", code: "INF_WIZ_LINK_DECLINED", message: INFINITE_WORKSPACE_MESSAGE, next: "halt" } : null
    case "capability_unavailable":
      // §3z.6: the cloud fails closed for every wizard verb until Infinite's own workspace is configured.
      if (failure.state === "internal_workspace_unconfigured") {
        return { kind: "parked", code: "INF_WIZ_INFINITE_UNAVAILABLE", reason: INTERNAL_WORKSPACE_UNCONFIGURED_MESSAGE, resumeHint: "Run npx infinite-tag again later." }
      }
      // With a state it is a known refusal the step words itself (§3z.3); without one, the app lacks the verb.
      if (failure.state) return null
      return { kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL", message: "Your Infinite app cannot do this yet. Update the Infinite app, then run npx infinite-tag again.", next: "halt" }
    case "internal_error":
      return failure.retryable === true ? null : { kind: "blocked", code: "INF_WIZ_NO_APP", reason: LINKED_SITES_MESSAGE }
    case "network_error":
      // Not retryable = the call was cancelled by the run's own signal: the engine's interrupt, not an outcome.
      return failure.retryable === true ? { kind: "blocked", code: "INF_WIZ_NO_APP", reason: APP_GONE_MESSAGE } : null
    case "timeout":
      return { kind: "blocked", code: "INF_WIZ_NO_APP", reason: APP_GONE_MESSAGE }
    default:
      return null
  }
}

/** §3z.4 row 6: a transient failure parks the run (resumable), never "open/update the app". */
export function unavailableOutcome(error: unknown): StepOutcome {
  const failure = asBridgeFailure(error)
  const detail = failure ? ` (${failure.code}${failure.upstreamStatus !== undefined ? ` ${failure.upstreamStatus}` : ""})` : ""
  return { kind: "parked", code: "INF_WIZ_INFINITE_UNAVAILABLE", reason: `Infinite did not answer${detail}.`, resumeHint: "Run npx infinite-tag again in a minute." }
}

/**
 * The outcome for any bridge failure a step cannot carry on from (§3z.4), or null when the step should
 * handle the failure itself (a state it words as a user line, `claimed_by_other`, `role_required`) or
 * rethrow it (not a bridge failure, a cancelled call).
 */
export function bridgeFailureOutcome(error: unknown, context: { verb?: string } = {}): StepOutcome | null {
  const hard = hardStopOutcome(error)
  if (hard) return hard
  const failure = asBridgeFailure(error)
  if (!failure) return null
  if (isTransientBridgeFailure(error)) return unavailableOutcome(error)
  if (failure.code === "site_setup_locked") {
    // On site-source the run cannot go on without the site's setup: park. Elsewhere the step words a line.
    if (context.verb === undefined || context.verb === "site-source") {
      return { kind: "parked", code: "INF_WIZ_SITE_LOCKED", reason: SITE_LOCKED_MESSAGE, resumeHint: "Wait for the website test in Infinite to finish (or stop it), then run npx infinite-tag again." }
    }
    return null
  }
  return null
}

/** Kept for the lanes that call it by this name (the same §3z.4 table). */
export function bridgeErrorOutcome(error: unknown): StepOutcome | null {
  return bridgeFailureOutcome(error)
}

/**
 * The one user line for a failure that changes nothing and lets the step continue (§3z.4 row 9, §3z.3
 * states): `role_required`, a lock on a piece, and the named refusals. Null when there is no such line.
 */
export function bridgeFailureLine(error: unknown, piece: string): string | null {
  const failure = asBridgeFailure(error)
  if (!failure) return null
  // A hard stop is never worded as a line the step carries on from (review I2 P2-2: Infinite's own workspace).
  if (hardStopOutcome(error) !== null) return null
  switch (failure.code) {
    case "role_required":
      return `${piece}: a workspace owner or admin must do this in Infinite; it was not changed`
    case "site_setup_locked":
      return `${piece}: a website test in Infinite locks it right now (${failure.state === "goal_lock" ? "a conversion goal" : "the site's setup"}); it was not changed`
    case "invalid_request":
      if (failure.state === "would_drop_ga4_events") return "Infinite has GA4 key events set by hand; set up conversions in Infinite first"
      if (failure.state === "unverified_host") return `${piece}: prove the domain in Infinite first; Infinite's tag is not installed this run`
      return genericRefusalLine(failure, piece)
    case "foreign_site_hosts":
      if (failure.state === "no_hosting_connection") return `${piece}: connect the site's Vercel project in Infinite first; nothing was changed`
      if (failure.state === "disabled_source_other_hosts") return `${piece}: this workspace's old site source belongs to another site; nothing was changed`
      return `${piece}: this workspace collects for another site; nothing was changed`
    case "ambiguous_connection":
      return failure.state === "connection_serves_no_site_host"
        ? `${piece}: the connected Vercel project serves none of this site's domains; pick the right project in Infinite`
        : `${piece}: more than one Vercel connection matches this site; pick one in Infinite`
    case "relay_not_available":
      return `${piece}: not available (${failure.state ?? "not available"})`
    case "capability_unavailable":
      return failure.state ? `${piece}: not available (${failure.state})` : genericRefusalLine(failure, piece)
    case "not_found":
      // §3y.6 (P1-2): the server lane's two "not found" answers are user lines, never "Internal error".
      if (failure.state === "no_site_source") return `${piece}: Infinite has no site for this domain yet, so nothing was saved on Vercel`
      if (failure.state === "no_hosting_connection") return `${piece}: connect your Vercel project in Infinite (Connections › GitHub · Website) to save its settings; nothing was saved`
      return genericRefusalLine(failure, piece)
    default:
      return genericRefusalLine(failure, piece)
  }
}

/**
 * §3y.6: any other refusal (a 4xx that is neither a hard stop nor transient) is ONE line, never a crash. A
 * transient failure and a client-side error (not a §3a.2 answer) return null: the caller parks or rethrows.
 */
function genericRefusalLine(failure: BridgeFailureLike, piece: string): string | null {
  if (isTransientBridgeFailure(failure)) return null
  const status = (BRIDGE_ERROR_STATUS as Record<string, number | undefined>)[failure.code]
  if (status === undefined || status < 400 || status >= 500) return null
  return `${piece}: Infinite refused it (${failure.code}${failure.state ? ` · ${failure.state}` : ""}); nothing was changed`
}
