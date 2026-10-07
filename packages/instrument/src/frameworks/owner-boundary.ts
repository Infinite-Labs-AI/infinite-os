/** The deterministic adapters obey the same owner boundary as workers, before writing source. */
import { restoreFrozenUnits } from "../jobs/consent-units.js"
import { isPolicyPath } from "../jobs/owner-boundary.js"
import type { ManualRequirement } from "../types.js"

export function policyWiringRequirement(path: string, snippet: string, appRoot = "."): ManualRequirement | null {
  return isPolicyPath(path, appRoot) ? { path, snippet,
    reason: `Not changed by us: ${path} is a privacy/terms policy page, which belongs to you. Analytics wiring here is left for you.`,
    ownerBoundary: { kind: "policy_page", file: path, line: 1 } } : null
}

export function ownerWiringRequirement(path: string, before: string | null, after: string, snippet: string, appRoot = "."): ManualRequirement | null {
  if (before === after) return null
  const policy = policyWiringRequirement(path, snippet, appRoot)
  if (policy) return policy
  const changed = restoreFrozenUnits(before ?? "", after).changes[0]
  if (!changed) return null
  const unit = changed.before ?? changed.after!
  return { path, snippet,
    reason: `Not changed by us: analytics wiring at ${path}:${unit.startLine} reaches code that handles consent, which is yours. Add the wiring yourself; the wizard left this code unchanged.`,
    ownerBoundary: { kind: "frozen_unit", file: path, line: unit.startLine, unitHash: unit.hash, lineOffset: 0, unitOrdinal: unit.ordinal } }
}
