// Errors the desktop tag bridge client raises (§3a.1 discovery, §3a.2 envelope and codes).
//
// Two families:
// - `BridgeDiscoveryError`: finding the bridge failed BEFORE any HTTP call (no app, not a Mac, signed out,
//   an unsafe or incompatible descriptor). Each carries the WizardCode the link step reports.
// - `BridgeError`: an HTTP call failed. `code` is a §3a.2 code when the desktop sent a well-formed error
//   envelope with a known code; anything else is `generic` (an unknown code, a malformed body) or one of
//   the client's own codes (`bad_response`, `network_error`, `timeout`, `capability_missing`).
import { BRIDGE_ERROR_STATUS, type BridgeErrorCode, type TagCapability } from "../wizard/contracts/bridge.js"
import type { WizardCode } from "../wizard/contracts/codes.js"

/** Codes the client produces itself (never sent by the desktop). */
export type BridgeClientErrorCode = "generic" | "bad_response" | "network_error" | "timeout" | "capability_missing"

export type BridgeErrorKind = BridgeErrorCode | BridgeClientErrorCode

export interface BridgeErrorInit {
  status: number
  code: BridgeErrorKind
  message: string
  retryable: boolean
  field?: string
  state?: string
  upstreamStatus?: number
  /** Seconds, from `Retry-After` (429). */
  retryAfterSeconds?: number
  requestId?: string
  verb?: string
}

export class BridgeError extends Error {
  readonly status: number
  readonly code: BridgeErrorKind
  readonly retryable: boolean
  readonly field?: string
  readonly state?: string
  readonly upstreamStatus?: number
  readonly retryAfterSeconds?: number
  readonly requestId?: string
  readonly verb?: string

  constructor(init: BridgeErrorInit) {
    super(init.message)
    this.name = "BridgeError"
    this.status = init.status
    this.code = init.code
    this.retryable = init.retryable
    if (init.field !== undefined) this.field = init.field
    if (init.state !== undefined) this.state = init.state
    if (init.upstreamStatus !== undefined) this.upstreamStatus = init.upstreamStatus
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds
    if (init.requestId !== undefined) this.requestId = init.requestId
    if (init.verb !== undefined) this.verb = init.verb
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError
}

/** True when `code` is one of the §3a.2 codes the desktop may send. */
export function isKnownBridgeErrorCode(code: unknown): code is BridgeErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(BRIDGE_ERROR_STATUS, code)
}

/** Why discovery refused. Each maps to exactly one WizardCode (see DISCOVERY_WIZARD_CODE). */
export type BridgeDiscoveryReason =
  /** darwin, no descriptor: the app is not running (or still booting). */
  | "no_app"
  /** not darwin and no descriptor: v1 is Mac-only. */
  | "not_mac"
  /** no descriptor and `state.json` says `signed_out`. */
  | "signed_out"
  /** the descriptor's pid is not running (a stale file left by a crash). */
  | "stale_descriptor"
  /** wrong owner, wrong mode, a symlink, not a regular file, too large. */
  | "descriptor_unsafe"
  /** unparseable JSON, a missing or mistyped field, a url that is not 127.0.0.1. */
  | "descriptor_invalid"
  /** the service is not `infinite-desktop-tag`. */
  | "wrong_service"
  /** the protocol range does not include 1. */
  | "protocol_mismatch"

export const DISCOVERY_WIZARD_CODE: { readonly [R in BridgeDiscoveryReason]: WizardCode } = {
  no_app: "INF_WIZ_NO_APP",
  not_mac: "INF_WIZ_NOT_MAC",
  signed_out: "INF_WIZ_SIGNED_OUT",
  // A dead pid is an app that is not running any more.
  stale_descriptor: "INF_WIZ_NO_APP",
  // An unsafe or malformed file is never trusted; restarting the app rewrites it.
  descriptor_unsafe: "INF_WIZ_NO_APP",
  descriptor_invalid: "INF_WIZ_NO_APP",
  wrong_service: "INF_WIZ_BRIDGE_PROTOCOL",
  protocol_mismatch: "INF_WIZ_BRIDGE_PROTOCOL"
}

/** The one-line explanation shown to the user for each refusal. */
export const DISCOVERY_MESSAGE: { readonly [R in BridgeDiscoveryReason]: string } = {
  no_app: "Open the Infinite app (and sign in), then run npx infinite-tag again.",
  not_mac: "infinite-tag works with the Infinite desktop app, which is Mac-only in v1. Run it on the Mac where Infinite is installed.",
  signed_out: "The Infinite app is signed out. Sign in, then run npx infinite-tag again.",
  stale_descriptor: "The Infinite app is not running (it left an old bridge file). Open Infinite, then run npx infinite-tag again.",
  descriptor_unsafe: "The Infinite app's bridge file failed its safety checks, so it was not used. Quit and reopen Infinite, then run npx infinite-tag again.",
  descriptor_invalid: "The Infinite app's bridge file could not be read. Quit and reopen Infinite, then run npx infinite-tag again.",
  wrong_service: "The bridge file does not belong to the Infinite app's tag bridge. Update the Infinite app, then run npx infinite-tag again.",
  protocol_mismatch: "This infinite-tag and your Infinite app do not speak the same bridge version. Update both, then run npx infinite-tag again."
}

export class BridgeDiscoveryError extends Error {
  readonly reason: BridgeDiscoveryReason
  readonly wizardCode: WizardCode

  constructor(reason: BridgeDiscoveryReason, detail?: string) {
    super(detail ? `${DISCOVERY_MESSAGE[reason]} (${detail})` : DISCOVERY_MESSAGE[reason])
    this.name = "BridgeDiscoveryError"
    this.reason = reason
    this.wizardCode = DISCOVERY_WIZARD_CODE[reason]
  }
}

export function isBridgeDiscoveryError(value: unknown): value is BridgeDiscoveryError {
  return value instanceof BridgeDiscoveryError
}

/** A step asked the client for a verb the descriptor does not advertise (→ INF_WIZ_BRIDGE_PROTOCOL). */
export function capabilityMissingError(capability: TagCapability, verb: string): BridgeError {
  return new BridgeError({
    status: 0,
    code: "capability_missing",
    message: `The Infinite app does not offer ${capability} (needed for ${verb}). Update the Infinite app.`,
    retryable: false,
    verb
  })
}
