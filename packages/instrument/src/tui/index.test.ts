import { describe, expect, it } from "vitest"

import { makeTestSanitizer } from "../../test/wizard/fake-store.js"
import { JsonUi, TtyUi, createWizardUi } from "./index.js"

describe("createWizardUi", () => {
  it("accepts the real process streams (compile-time) and picks the UI by mode", () => {
    const sanitize = makeTestSanitizer()
    const streams = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
    expect(createWizardUi("tty", { ...streams, env: {}, sanitize })).toBeInstanceOf(TtyUi)
    expect(createWizardUi("json", { ...streams, sanitize })).toBeInstanceOf(JsonUi)
  })
})
