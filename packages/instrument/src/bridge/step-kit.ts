// Small helpers the bridge steps (`link`, `keys`, `settings`) share: sub-status lines and stable input hashes.
import { createHash, randomUUID } from "node:crypto"

import type { WizardContext } from "../wizard/contracts/deps.js"
import type { WizardStepId } from "../wizard/contracts/steps.js"

export type SubTone = "ok" | "warn" | "info" | "pending"

/** One live sub-status line under the step ("a little magical, not real-time everything": the store throttles). */
export function sub(ctx: WizardContext, step: WizardStepId, text: string, tone: SubTone): void {
  ctx.emit.emit("step.sub", { step, text, tone })
}

export function hashInputs(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

/**
 * A value that differs in every wizard process. The `link` step folds it into its input hash so it is never
 * skipped on resume: each process must re-check the runtime variant and re-attach the link id to its client.
 */
export const PROCESS_NONCE = randomUUID()
