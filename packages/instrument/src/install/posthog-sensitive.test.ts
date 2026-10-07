import { expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { sensitivePosthogOptions } from "./posthog-sensitive.js"
import { buildPlanModel } from "./plan-model.js"
import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"

it.each([
  "autocapture: false, disable_session_recording: true",
  "autocapture: !location.pathname.startsWith('/account'), disable_session_recording: location.pathname.startsWith('/account')",
  "autocapture: location.pathname === '/account' ? false : true, disable_session_recording: location.pathname === '/account' ? true : false"
])("omits sensitive-page advice when existing options already disable both: %s", options => {
  expect(sensitivePosthogOptions(`posthog.init('phc_fixture', { ${options} });`, ["/account"])).toBeNull()
})

it("never widens existing settings outside the sensitive paths", () => {
  const snippet = sensitivePosthogOptions("posthog.init('phc_fixture', customOptions);", ["/account"])!
  for (const pathname of ["/", "/account", "/account/profile", "/elsewhere"]) {
    for (const autocapture of [true, false]) for (const disable_session_recording of [true, false]) {
      const before = { autocapture, disable_session_recording }
      const after = runInNewContext(`({ ...before, ${snippet} })`, { before, location: { pathname } })
      expect(after.autocapture && !autocapture).toBe(false)
      expect(!after.disable_session_recording && disable_session_recording).toBe(false)
      if (!pathname.startsWith("/account")) expect(after).toEqual(before)
    }
  }
})

it.each([true, false])("shows sensitive-page handoff once, or omits it when already off (off=%s)", off => {
  const file = "src/tracking.ts"
  const source = `function boot() {\nposthog.init('phc_fixture', { ${off ? "autocapture: false, disable_session_recording: true" : ""} });\nposthog.opt_out_capturing();\n}`
  const plan = buildPlanModel({ keys: fakeKeys(), before: fakeBefore(), candidates: [], agent: null, consentFlag: "not_required", productionDeniedConflict: fakeProductionDeniedConflict, scan: { framework: "next-app-router", managedProviders: [], adopted: [{ provider: "posthog", via: "snippet", file, line: 2, key: "phc_fixture" }], improve: [{ id: "sensitive", kind: "sensitive_pages", owner: "agent", provider: "posthog", target: "sensitive_pages", text: "Protect sensitive pages", evidence: { file, line: 2 } }], serverLane: null, npm: null, sensitivePaths: ["/account"], sources: { [file]: source } } })
  expect(plan.lines.filter(line => line.text.includes("collection off on the listed pages"))).toHaveLength(off ? 0 : 1)
  expect(plan.seeds.filter(job => job.id === "posthog_improve:sensitive_pages")).toHaveLength(off ? 0 : 1)
})
