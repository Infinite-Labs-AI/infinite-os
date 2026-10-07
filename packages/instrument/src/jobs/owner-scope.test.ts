import { expect, it } from "vitest"
import { item } from "../../test/wizard/repo.js"
import { scopeOwnerJob } from "./owner-scope.js"

it("preserves the plan's copyable owner text when jobs rescope the same frozen unit", () => {
  const file = "src/analytics.ts"
  const sources = new Map([[file, "function boot() {\n posthog.init('phc_fixture', {});\n posthog.opt_out_capturing();\n}\n"]])
  const first = scopeOwnerJob({ ...item("preview_guard:posthog", [file]), trigger: { finding: "Guard", evidence: [{ file, line: 2 }] } }, sources)
  const planned = { ...first, note: `${first.note} Preview visits keep counting until you apply this.`, ownerBoundary: { ...first.ownerBoundary!, guard: "@@ -2 +2 @@\n- posthog.init('phc_fixture', {});\n+ if (isProduction) posthog.init('phc_fixture', {});", wiring: "manualWiring();" } }
  const rescoped = scopeOwnerJob(planned, sources)
  expect(rescoped.ownerBoundary).toEqual(planned.ownerBoundary)
  expect(rescoped.note).toBe(planned.note)
  expect(scopeOwnerJob(rescoped, sources)).toEqual(rescoped)
})
