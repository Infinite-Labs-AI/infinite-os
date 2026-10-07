import { JOB_TABLE, type ChecklistItem } from "../wizard/contracts/jobs.js"

/** The item id of the rewrite job for the user's own Next config (review I1 P1-2). */
export const CONFIG_REWRITES_TARGET = "next_config_rewrites"

/**
 * Review I1 P1-2: the managed rewrites the user's OWN next.config lacks (the installer never edits it) are a job
 * for the agent, checked by the wizard (`next_rewrites_exact`, then the build), never "installed".
 */
export function configRewriteJobs(deferred: ReadonlyArray<{ path: string; snippet: string }>, existing: readonly ChecklistItem[]): ChecklistItem[] {
  const spec = JOB_TABLE.unusual_layout
  return deferred
    .map((entry): ChecklistItem => ({
      id: `unusual_layout:${CONFIG_REWRITES_TARGET}`,
      jobId: "unusual_layout",
      n: spec.n,
      title: "Add the analytics rewrites to your Next config",
      owner: "agent",
      trigger: {
        finding: `Your own ${entry.path} lacks the same-origin rewrites the managed tag posts through; add exactly these to its async rewrites(), changing nothing else:\n${entry.snippet}`,
        evidence: [{ file: entry.path, line: 1 }]
      },
      allow: { files: [entry.path], create: [] },
      checks: [
        { id: "next_rewrites_exact", tier: "S", state: "not_run" },
        { id: "build", tier: "B", state: "not_run" }
      ],
      state: "pending"
    }))
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index && !existing.some((other) => other.id === item.id))
}

