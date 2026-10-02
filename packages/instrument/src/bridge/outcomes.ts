// How bridge failures become step outcomes (§3d.1, §3d.5). Shared by the steps that talk to the desktop bridge.
//
// - discovery refusals → `blocked` NO_APP / NOT_MAC / SIGNED_OUT, or `failed` (halt) BRIDGE_PROTOCOL;
// - a capability the step needs is missing → `failed` (halt) BRIDGE_PROTOCOL (the step never calls the verb);
// - 402 `subscription_required` → `blocked` SUBSCRIPTION_REQUIRED (decision 7: free tag, paid app);
// - 409 `signed_out` → `blocked` SIGNED_OUT;
// - the link went away mid-run (`link_revoked`, `link_not_found`, `link_invalid`) → `failed` (halt)
//   LINK_DECLINED: the run needs a fresh link (exit 4, "needs the Infinite app");
// - the app stopped answering mid-run (a refused or broken connection, a call timeout) → `blocked` NO_APP
//   ("open Infinite, then run npx infinite-tag again"; a resume continues the run);
// - the cloud behind the app failed for now (`cloud_error`, `upstream_timeout`, `busy`, `rate_limited`) →
//   `blocked` NO_APP with "try again in a minute"; `cloud_auth_failed` → `blocked` SIGNED_OUT;
// - a CANCELLED call (the run's own signal, e.g. Ctrl+C) is not an outcome: the engine handles the interrupt;
// - anything else is not an outcome: the step rethrows and the engine reports it (a bug).
import type { TagBridgeClient, TagCapability } from "../wizard/contracts/bridge.js"
import type { StepOutcome } from "../wizard/contracts/deps.js"
import { BridgeDiscoveryError, BridgeError, isBridgeDiscoveryError, isBridgeError } from "./errors.js"

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

/** The outcome for a bridge failure a step cannot carry on from, or null when the step should rethrow it. */
export function bridgeFailureOutcome(error: unknown): StepOutcome | null {
  if (isBridgeDiscoveryError(error)) return discoveryOutcome(error)
  if (!isBridgeError(error)) return null
  return bridgeErrorOutcome(error)
}

export function bridgeErrorOutcome(error: BridgeError): StepOutcome | null {
  switch (error.code) {
    case "subscription_required":
      return { kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED", reason: SUBSCRIPTION_MESSAGE }
    case "signed_out":
      return { kind: "blocked", code: "INF_WIZ_SIGNED_OUT", reason: "The Infinite app is signed out. Sign in, then run npx infinite-tag again." }
    case "capability_missing":
    case "capability_unavailable":
      return {
        kind: "failed",
        code: "INF_WIZ_BRIDGE_PROTOCOL",
        message: `${error.message} Update the Infinite app, then run npx infinite-tag again.`,
        next: "halt"
      }
    case "link_revoked":
    case "link_not_found":
    case "link_invalid":
      return {
        kind: "failed",
        code: "INF_WIZ_LINK_DECLINED",
        message:
          error.code === "link_invalid"
            ? "The workspace this site is linked to is no longer available on this Mac (open it in Infinite once, or link again). Run npx infinite-tag again."
            : "This site's link to Infinite was removed (Settings › Linked sites). Run npx infinite-tag again to link it.",
        next: "halt"
      }
    case "network_error":
      // Not retryable = the call was cancelled by the run's own signal: the engine's interrupt, not an outcome.
      if (!error.retryable) return null
      return { kind: "blocked", code: "INF_WIZ_NO_APP", reason: APP_GONE_MESSAGE }
    case "timeout":
      return { kind: "blocked", code: "INF_WIZ_NO_APP", reason: APP_GONE_MESSAGE }
    case "cloud_auth_failed":
      return {
        kind: "blocked",
        code: "INF_WIZ_SIGNED_OUT",
        reason: "The Infinite app could not sign in to Infinite's cloud. Sign in again in the Infinite app, then run npx infinite-tag again."
      }
    case "cloud_error":
    case "upstream_timeout":
    case "busy":
    case "rate_limited":
      return {
        kind: "blocked",
        code: "INF_WIZ_NO_APP",
        reason: `Infinite could not finish this right now (${error.code}${error.upstreamStatus !== undefined ? ` ${error.upstreamStatus}` : ""}). Try again in a minute: run npx infinite-tag again to continue.`
      }
    default:
      return null
  }
}

export const APP_GONE_MESSAGE = "The Infinite app stopped answering (it may have quit or restarted). Open Infinite, then run npx infinite-tag again to continue."
