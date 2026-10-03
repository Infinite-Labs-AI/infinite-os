// FOUNDATION STUB helper (lane F0). Every step file starts as `notBuiltStep("<id>")`: the step's §3d.1
// metadata and a `run` that resolves `failed INF_WIZ_NOT_BUILT` (halt), so an unbuilt step can never
// look like it ran. The owning lane replaces its step file wholesale; integration (I1) deletes this
// helper once no step uses it.
import { createHash } from "node:crypto"

import type { StepOutcome, WizardStep } from "../contracts/deps.js"
import { WIZARD_STEP_META, type WizardStepId } from "../contracts/steps.js"

export function notBuiltStep<Id extends WizardStepId>(id: Id): WizardStep<Id> {
  const meta = WIZARD_STEP_META[id]
  return {
    id,
    title: meta.title,
    who: [...meta.who],
    learn: meta.learn,
    requiredCapabilities: [...meta.requiredCapabilities],
    inputHash: () => `sha256:${createHash("sha256").update(`not-built:${id}`).digest("hex")}`,
    run: async (): Promise<StepOutcome> => ({
      kind: "failed",
      code: "INF_WIZ_NOT_BUILT",
      message: `The "${meta.title}" step is not built yet (lane ${meta.owner}).`,
      next: "halt"
    })
  }
}
