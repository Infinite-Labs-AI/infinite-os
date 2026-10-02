// What `before` measured, kept for the `plan` and `install` steps. The steps contract (§3d.8) gives a
// step no channel to the facts an earlier step measured, and a resume runs in a fresh process, so the
// facts live beside the run state: `.infinite/wizard/before-facts.json` (gitignored, 0600, written
// atomically through WizardFs). Public ids and counts only (the same facts the TestResult carries).
//
// When the file is absent (an old run, or `before` was not re-run) the plan says so: the measured
// values show "—" and the guard uses only the hosts Infinite lists. Nothing is guessed.
import { join } from "node:path"

import type { WizardFs } from "../wizard/contracts/deps.js"
import { WIZARD_PATHS, WIZARD_STATE_FILE_MODE } from "../wizard/contracts/state.js"

import type { WizardBeforeFacts } from "./plan-model.js"

export const BEFORE_FACTS_RELATIVE_PATH = `${WIZARD_PATHS.dir}/before-facts.json`
export const BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1" as const

interface BeforeFactsFile {
  schema: typeof BEFORE_FACTS_SCHEMA
  runId: string | null
  facts: WizardBeforeFacts
}

export async function writeBeforeFacts(fs: WizardFs, root: string, runId: string | null, facts: WizardBeforeFacts): Promise<void> {
  await fs.mkdirp(join(root, WIZARD_PATHS.dir), 0o700)
  const file: BeforeFactsFile = { schema: BEFORE_FACTS_SCHEMA, runId, facts }
  await fs.writeTextAtomic(join(root, BEFORE_FACTS_RELATIVE_PATH), `${JSON.stringify(file, null, 2)}\n`, WIZARD_STATE_FILE_MODE)
}

/** The facts of THIS run, or null (absent, unreadable, another run's, or another schema). */
export async function readBeforeFacts(fs: WizardFs, root: string, runId: string | null): Promise<WizardBeforeFacts | null> {
  const text = await fs.readText(join(root, BEFORE_FACTS_RELATIVE_PATH))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as Partial<BeforeFactsFile>
    if (parsed.schema !== BEFORE_FACTS_SCHEMA || !parsed.facts) return null
    if (runId !== null && parsed.runId !== null && parsed.runId !== runId) return null
    return parsed.facts
  } catch {
    return null
  }
}
