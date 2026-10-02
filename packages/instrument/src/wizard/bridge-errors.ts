// Reading a bridge error without importing lane O2's `BridgeError` class (wave 1 tests against fakes
// only): every error the client throws for a §3a.2 error response carries the response's `code` (and
// `state` for `claimed_by_other` / `link_invalid`). This reads those two fields structurally.
import { BRIDGE_ERROR_STATUS, type BridgeErrorCode } from "./contracts/bridge.js"

export function bridgeErrorCode(error: unknown): BridgeErrorCode | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && code in BRIDGE_ERROR_STATUS ? (code as BridgeErrorCode) : null
}

export function bridgeErrorState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const state = (error as { state?: unknown }).state
  return typeof state === "string" ? state : null
}
