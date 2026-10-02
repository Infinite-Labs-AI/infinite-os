import { describe, expect, it } from "vitest"

import type { WizardContext, WizardDeps, WizardStepRecord } from "../contracts/deps.js"
import { WIZARD_STEP_IDS, WIZARD_STEP_META } from "../contracts/steps.js"
import { WIZARD_STEPS } from "./index.js"
import { notBuiltStep } from "./not-built.js"

// This file stays valid as the lanes fill their step files: it checks the Record's structure and the
// §3d.1 metadata, never a step's behaviour.
describe("WIZARD_STEPS (§3d.1, §3d.8)", () => {
  it("covers all 13 ids, in exactly the WIZARD_STEP_IDS order", () => {
    expect(WIZARD_STEP_IDS).toHaveLength(13)
    expect(Object.keys(WIZARD_STEPS)).toEqual([...WIZARD_STEP_IDS])
  })

  it("each step carries its own id and the §3d.1 title, who, Learn card and capabilities", () => {
    for (const id of WIZARD_STEP_IDS) {
      const step = WIZARD_STEPS[id]
      const meta = WIZARD_STEP_META[id]
      expect(step.id).toBe(id)
      expect(step.title).toBe(meta.title)
      expect(step.who).toEqual(meta.who)
      expect(step.learn).toBe(meta.learn)
      expect(step.requiredCapabilities).toEqual(meta.requiredCapabilities)
      expect(step.inputHash({} as WizardContext)).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it("a Record missing a step, or holding a step under another id, does not compile", () => {
    const { done: _done, ...missing } = WIZARD_STEPS
    // @ts-expect-error `done` is missing
    const incomplete: WizardStepRecord = missing
    // @ts-expect-error the `link` slot holds the `keys` step
    const swapped: WizardStepRecord = { ...WIZARD_STEPS, link: WIZARD_STEPS.keys }
    expect(Object.keys(incomplete)).toHaveLength(12)
    expect(swapped.link.id).toBe("keys")
  })
})

describe("notBuiltStep (the foundation stub every step file starts from)", () => {
  it("halts with INF_WIZ_NOT_BUILT and names the owning lane; never reports ok", async () => {
    const outcome = await notBuiltStep("prove").run({} as WizardContext, {} as WizardDeps)
    expect(outcome).toEqual({
      kind: "failed",
      code: "INF_WIZ_NOT_BUILT",
      message: 'The "Prove it live" step is not built yet (lane O1).',
      next: "halt"
    })
  })

  it("gives each step a distinct input hash", () => {
    const hashes = WIZARD_STEP_IDS.map((id) => notBuiltStep(id).inputHash({} as WizardContext))
    expect(new Set(hashes).size).toBe(WIZARD_STEP_IDS.length)
  })
})
