/** The deterministic adapters obey the same owner boundary as workers, before writing source. */
import { restoreFrozenUnits } from "../jobs/consent-units.js"
import { isPolicyPath } from "../jobs/owner-boundary.js"
import type { ManualRequirement } from "../types.js"

export function policyWiringRequirement(path: string, snippet: string, appRoot = ".", sources?: ReadonlyMap<string, string>): ManualRequirement | null {
  return isPolicyPath(path, appRoot, sources) ? { path, snippet,
    reason: isPolicyPath(path, appRoot) ? `Not changed by us: ${path} is a policy page, which is yours. This page does not get the tag from this run.` : `Not changed by us: ${path} is policy content, which is yours. This run leaves its analytics wiring unchanged.`,
    ownerBoundary: { kind: "policy_page", file: path, line: 1 } } : null
}

export function ownerWiringRequirement(path: string, before: string | null, after: string, snippet: string, appRoot = ".", sources?: ReadonlyMap<string, string>): ManualRequirement | null {
  if (before === after) return null
  const policy = policyWiringRequirement(path, snippet, appRoot, sources)
  if (policy) return policy
  const changed = restoreFrozenUnits(before ?? "", after).changes[0]
  if (!changed) return null
  const unit = changed.before ?? changed.after!
  return { path, snippet,
    reason: `Not changed by us: analytics wiring at ${path}:${unit.startLine} reaches code that handles consent, which is yours. Add the wiring yourself; the wizard left this code unchanged.`,
    ownerBoundary: { kind: "frozen_unit", file: path, line: unit.startLine, unitHash: unit.hash, lineOffset: 0, unitOrdinal: unit.ordinal } }
}

/** An old manifest is not permission to edit a policy page during uninstall. */
export function policyUninstallWarning(path: string, appRoot = "."): string | null {
  return isPolicyPath(path, appRoot) ? `Not removed automatically: ${path} is a policy page, which is yours. Remove the leftover analytics wiring yourself.` : null
}
