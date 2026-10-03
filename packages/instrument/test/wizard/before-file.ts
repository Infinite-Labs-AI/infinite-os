// Writes `before`'s hand-off file through the ONE module lane O8's `before` step writes it with
// (`wizard/handoff/before-facts.ts`, B1), so the `keys` step's tests read the real format. The path and schema
// literals are pinned here too: if the module renames either, these and the module must change together.
import type { WizardFs } from "../../src/wizard/contracts/deps.js"
import type { BeforeFacts } from "../../src/wizard/contracts/jobs.js"
import { BEFORE_FACTS_SCHEMA, writeBeforeFactsFile, type BeforeFactsFile } from "../../src/wizard/handoff/before-facts.js"

export const O8_BEFORE_FACTS_PATH = ".infinite/wizard/before.json"
export const O8_BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1"

export async function writeO8BeforeFile(
  fs: WizardFs,
  root: string,
  runId: string | null,
  facts: BeforeFacts,
  measuredAt = "2026-10-02T09:05:00.000Z"
): Promise<void> {
  const file: BeforeFactsFile = {
    schema: BEFORE_FACTS_SCHEMA,
    // A null run id is written as-is (a reader must refuse it); the type allows only strings.
    runId: runId as string,
    writtenAt: measuredAt,
    measuredAt,
    productionHost: facts.observedProductionHost,
    scan: { framework: "next-app-router", packageManager: "pnpm", appRoot: ".", fileCount: 12, truncated: false },
    facts: { ...facts, baseline: null, baselineBuild: null },
    grades: null,
    setupChecks: [],
    envTargetChecks: [],
    liveChecks: [],
    cmpDetected: null,
    loginFound: false
  }
  await writeBeforeFactsFile(fs, root, file)
}
