import type { ChecklistItem, CheckResult } from "../wizard/contracts/jobs.js"
import type { TestTool } from "../wizard/contracts/test-engine.js"

export const PREVIEW_TOOLS: readonly TestTool[] = ["ga4", "posthog", "meta"]
export function withheldPreviewTools(jobs: readonly ChecklistItem[] = []): TestTool[] {
  return PREVIEW_TOOLS.filter(tool => jobs.some(job => job.id === `preview_guard:${tool}` && job.state === "left_for_you" && (job.ownerBoundary?.kind === "frozen_unit" || job.ownerBoundary?.kind === "restored_unit")))
}
export function previewScope(grades: Partial<Record<TestTool, CheckResult>>, left: readonly TestTool[], expected?: readonly TestTool[]): { state: "pass" | "problem" | "undetermined" | "info"; note: string } {
  const active = PREVIEW_TOOLS.filter(tool => !left.includes(tool) && (expected?.includes(tool) || (grades[tool] && grades[tool]?.state !== "info")))
  const states = active.map(tool => grades[tool])
  const state = states.some(grade => grade?.state === "problem" && grade.reason?.startsWith("previews_send_data")) ? "problem"
    : states.some(grade => !grade || grade.state !== "pass") ? "undetermined"
    : active.length > 0 ? "pass" : "info"
  const labels = left.map(tool => ({ ga4: "GA4", posthog: "PostHog", meta: "Meta", infinite: "Infinite" }[tool])).join(", ")
  return { state, note: `NOT DONE for ${labels}: guard left for the owner; preview and local visits keep counting` }
}
