// Writes `before`'s hand-off file EXACTLY as lane O8's `before` step does (`steps/before.ts`: path
// `.infinite/wizard/before.json`, schema `infinite-tag.before-facts.v1`, the `BeforeFactsFile` envelope), so the
// `keys` step's tests read the real format, not one of O2's own making. The literals are pinned here on purpose:
// if O8 renames the path, the schema or the envelope, the reader's constants and this writer must change
// together (see the O2 fix-round note).
import { join } from "node:path"

import type { WizardFs } from "../../src/wizard/contracts/deps.js"
import type { BeforeFacts } from "../../src/wizard/contracts/jobs.js"

export const O8_BEFORE_FACTS_PATH = ".infinite/wizard/before.json"
export const O8_BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1"

export async function writeO8BeforeFile(
  fs: WizardFs,
  root: string,
  runId: string | null,
  facts: BeforeFacts,
  measuredAt = "2026-10-02T09:05:00.000Z"
): Promise<void> {
  // O8's BeforeFactsFile: everything `before` measured; `keys` reads `schema`, `runId`, `measuredAt`, `facts`.
  const file = {
    schema: O8_BEFORE_FACTS_SCHEMA,
    runId,
    measuredAt,
    productionHost: facts.observedProductionHost,
    scan: { framework: "next-app-router", packageManager: "pnpm", appRoot: ".", fileCount: 12, truncated: false },
    facts,
    grades: null,
    setupChecks: [],
    envTargetChecks: [],
    liveChecks: [],
    baselineBuild: { state: "skipped" },
    baseline: null,
    cmpDetected: null
  }
  await fs.mkdirp(join(root, ".infinite/wizard"), 0o700)
  await fs.writeTextAtomic(join(root, O8_BEFORE_FACTS_PATH), `${JSON.stringify(file, null, 2)}\n`, 0o600)
}
