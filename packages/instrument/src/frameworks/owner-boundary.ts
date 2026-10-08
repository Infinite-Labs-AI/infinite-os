/** The deterministic adapters obey the same owner boundary as workers, before writing source. */
import { restoreFrozenUnits } from "../jobs/consent-units.js"
import { isPolicyPath } from "../jobs/owner-boundary.js"
import type { ManualRequirement } from "../types.js"

export function policyWiringRequirement(path: string, snippet: string, appRoot = "."): ManualRequirement | null {
  return isPolicyPath(path, appRoot) ? { path, snippet,
    reason: `Kept ${path} as it is: it is a policy page, so it does not get the tag.`,
    ownerBoundary: { kind: "policy_page", file: path, line: 1 } } : null
}

export function ownerWiringRequirement(path: string, before: string | null, after: string, snippet: string, appRoot = "."): ManualRequirement | null {
  if (before === after) return null
  const policy = policyWiringRequirement(path, snippet, appRoot)
  if (policy) return policy
  const changed = restoreFrozenUnits(before ?? "", after, path).changes[0]
  if (!changed) return null
  const unit = changed.before ?? changed.after!
  return { path, snippet,
    reason: `For you: add the analytics wiring at ${path}:${unit.startLine}. It sits inside your consent code, so this run left it to you.`,
    ownerBoundary: { kind: "frozen_unit", file: path, line: unit.startLine, unitHash: unit.hash, lineOffset: 0, unitOrdinal: unit.ordinal } }
}

/** An old manifest is not permission to edit a policy page during uninstall. */
export function policyUninstallWarning(path: string, appRoot = "."): string | null {
  return isPolicyPath(path, appRoot) ? `For you: remove the leftover analytics wiring from ${path} (a policy page).` : null
}
