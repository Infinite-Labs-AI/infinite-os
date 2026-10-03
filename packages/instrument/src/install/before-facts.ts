// What `before` measured, read for the `plan` and `install` steps, and what the `keys` step chose.
//
// ONE module per hand-off file (§3z.12 §3d.6, B1): `.infinite/wizard/before.json` is read through
// `wizard/handoff/before-facts.ts` (lane O8 writes it there; baseline + baselineBuild are inside `facts`),
// and `.infinite/wizard/keys.json` through lane O2's `wizard/handoff/keys-result.ts` (`readKeysResult` +
// `applyKeysChoices`). Both reads are run-scoped. When a file is absent, unreadable, another run's or another
// schema, the plan says so: measured values show "—", the guard uses only the hosts Infinite lists, and
// several streams/pixels are never guessed.
import type { TagKeys } from "../wizard/contracts/bridge.js"
import type { WizardFs } from "../wizard/contracts/deps.js"
import { readBeforeFactsFile } from "../wizard/handoff/before-facts.js"
import { applyKeysChoices, readKeysResult, type KeysStepResult } from "../wizard/handoff/keys-result.js"

import type { WizardBeforeFacts } from "./plan-model.js"

/** The facts of THIS run (baseline and baselineBuild inside), or null (absent, unreadable, another run's, another schema). */
export async function readBeforeFacts(fs: WizardFs, root: string, runId: string | null): Promise<WizardBeforeFacts | null> {
  const file = await readBeforeFactsFile(fs, root, runId)
  return file ? file.facts : null
}

/** The `keys` step's saved result for THIS run (its choices among the connection's own ids), or null. */
export async function readKeysChoices(fs: WizardFs, root: string, runId: string | null): Promise<KeysStepResult | null> {
  return readKeysResult(fs, root, runId)
}

/** The connection's keys narrowed to the `keys` step's choices (O2's rule; a stale choice narrows nothing). */
export function narrowKeysToChoices(keys: TagKeys, result: KeysStepResult | null): TagKeys {
  return applyKeysChoices(keys, result)
}
