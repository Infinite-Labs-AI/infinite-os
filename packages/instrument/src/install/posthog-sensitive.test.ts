import { expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { sensitivePosthogOptions } from "./posthog-sensitive.js"

it.each([
  "autocapture: false, disable_session_recording: true",
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

it.each([
  "const unrelated = { autocapture: false, disable_session_recording: true }; posthog.init('phc_fixture', { autocapture: true, disable_session_recording: false });",
  "posthog.init('phc_fixture', { autocapture: false, disable_session_recording: true, ...override });",
])("keeps restrictive advice when selected init is active or ambiguous: %s", source => {
  const advice = sensitivePosthogOptions(source, ["/account"])
  expect(advice).toContain("autocapture: false")
  expect(advice).toContain("disable_session_recording: true")
})

