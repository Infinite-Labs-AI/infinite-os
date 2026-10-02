// The package's public entry (`infinite-tag`): the wizard's entry points, the doctor and the site-code
// builders are importable, and no test fake leaks into it.
import { describe, expect, it } from "vitest"

import * as api from "./index.js"

describe("public exports (I1)", () => {
  it("exposes the wizard, the doctor and the site-code builders", () => {
    for (const name of [
      "runWizardCommand",
      "runWizardUninstall",
      "parseWizardArgs",
      "createDefaultWizardDeps",
      "installDefaultWizardWiring",
      "parseAnswersFile",
      "runDoctorCommand",
      "runDoctor",
      "buildHostGuardExpression",
      "productionDeniedConflict",
      "buildConversionHelpersScript",
      "buildLandingAttributionScript",
      "buildMetaMirrorScript",
      "envProxyFetch"
    ] as const) {
      expect(typeof api[name], name).toBe("function")
    }
    expect(api.WIZARD_EXIT).toMatchObject({ done: 0, failed: 1, usage: 2, parked: 3, needsApp: 4, interrupted: 130 })
    expect(api.parseAnswersFile('{"v":1,"consentMode":"required"}')).toEqual({ v: 1, consentMode: "required" })
  })

  it("NEGATIVE: no fake, smoke driver or test seam is exported, and the answers parser stays strict", () => {
    const names = Object.keys(api)
    expect(names.filter((name) => /fake|smoke|stub|mock/i.test(name))).toEqual([])
    expect(() => api.parseAnswersFile('{"v":1,"consentmode":"required"}')).toThrow(/unknown key/)
  })
})
