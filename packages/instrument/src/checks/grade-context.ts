// The grader's context from what the wizard knows (§3z.12 §3e.7, B11): every grader call passes
// `consentMode`, `installedTools` and `metaPixelOwnership`, built here from the census (and, after install,
// the tools the install recorded), so the three callers (`before`, the rehearsal, `prove`) cannot drift.
// Unknown stays null (the grader then answers `undetermined (test_error)` for a silent tool, never a guess).
import type { CensusResult, GradeTestRunContext } from "../wizard/contracts/jobs.js"
import type { TestResult, TestTool } from "../wizard/contracts/test-engine.js"

export interface GradeContextInput {
  census: CensusResult
  /** The site's consent mode (the plan answer, else keys `infinite.consentMode`); null = unknown. */
  consentMode: "required" | "not_required" | null
  /** Tools the install wrote (they are on the branch even when the census reads them as managed). */
  installed?: readonly TestTool[]
  cmpDetected: TestResult["environment"]["cmpDetected"]
  /** §3x.3 (F6): the request carried `spaNavigation`. */
  spaNavigation?: boolean
}

export function gradeContextFrom(input: GradeContextInput): GradeTestRunContext {
  const fromCensus = input.census.entries.map((entry) => entry.tool).filter((tool): tool is TestTool => tool !== "x")
  const installedTools = [...new Set([...fromCensus, ...(input.installed ?? [])])]
  const meta = input.census.entries.filter((entry) => entry.tool === "meta")
  const metaPixelOwnership = meta.some((entry) => entry.owner === "adopted")
    ? "adopted"
    : meta.some((entry) => entry.owner === "managed") || (input.installed ?? []).includes("meta")
      ? "managed"
      : null
  return {
    cmpDetected: input.cmpDetected,
    envSourcedIds: input.census.envSourcedIds,
    consentMode: input.consentMode,
    installedTools,
    metaPixelOwnership,
    ...(input.spaNavigation ? { spaNavigation: true } : {})
  }
}
