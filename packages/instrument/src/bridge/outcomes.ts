// How bridge failures become step outcomes (§3d.1, §3d.5). Shared by the steps that talk to the desktop bridge.
//
// - discovery refusals → `blocked` NO_APP / NOT_MAC / SIGNED_OUT, or `failed` (halt) BRIDGE_PROTOCOL;
// - a capability the step needs is missing → `failed` (halt) BRIDGE_PROTOCOL (the step never calls the verb);
// - 402 `subscription_required` → `blocked` SUBSCRIPTION_REQUIRED (decision 7: free tag, paid app);
// - 409 `signed_out` → `blocked` SIGNED_OUT;
// - the link went away mid-run (`link_revoked`, `link_not_found`, `link_invalid`) → `failed` (halt)
//   LINK_DECLINED: the run needs a fresh link (exit 4, "needs the Infinite app");
// - anything else is not an outcome: the step rethrows and the engine reports it.
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
    default:
      return null
  }
}
