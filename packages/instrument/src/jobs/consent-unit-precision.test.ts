import { expect, it } from "vitest"
import { frozenUnitAt, isConsentText, restoreFrozenUnits, sourceUnits } from "./consent-units.js"

it("attaches a leading consent comment to its unit while keeping its neighbor editable", () => {
  const before = "function ordinary() { return 1; }\n\n// gtag('consent', 'default', {});\nfunction owner() { return 1; }\n"
  const after = before.replace("ordinary() { return 1", "ordinary() { return 2").replace("'default'", "'update'").replace("owner() { return 1", "owner() { return 2")
  expect(sourceUnits(before).confident).toBe(true)
  expect(sourceUnits(before).units.map(unit => [unit.key, unit.frozen])).toEqual([["function:ordinary", false], ["function:owner", true]])
  expect(restoreFrozenUnits(before, after).text).toBe(before.replace("ordinary() { return 1", "ordinary() { return 2"))
  expect(frozenUnitAt(before, 3)?.key).toBe("function:owner")
})

it("uses the whole file fallback when only an unattached trailing comment contains consent", () => {
  const before = "function ordinary() { return 1; }\n\n// gtag('consent', 'default', {});"
  expect(sourceUnits(before)).toMatchObject({ confident: false, units: [{ key: "whole-file", frozen: true }] })
  expect(restoreFrozenUnits(before, before.replace("return 1", "return 2")).text).toBe(before)
})

it.each([
  "function hasConsent() { return true; }",
  "export function MarketingCONSENT() { return true; }",
  "const consentState = true;",
  "class ConsentController {}",
  "export const { hasConsent } = settings;",
  "export const { enabled: hasConsent } = settings;",
  "const [hasConsent] = settings;",
  "import { enabled as hasConsent } from './settings';",
])("freezes a unit with a declared consent name: %s", declaration => {
  const before = `${declaration}\nfunction ordinary() { return 1; }\n`
  expect(sourceUnits(before).units.map(unit => unit.frozen)).toEqual([true, false])
  expect(restoreFrozenUnits(before, before.replace(declaration, `${declaration} `)).text).toBe(before)
})

it.each([
  "function enabled() { return preferences; }",
  "const enabled = consentMap;",
  "function enabled(consent: boolean) { return consent; }",
  "const enabled: { consent: boolean } = settings;",
  "const { consent: enabled } = settings;",
  "import { hasConsent as enabled } from './settings';",
  "const enabled = function hasConsent() { return true; };",
])("does not follow consent references, parameters, types or property names: %s", reader => {
  const before = `const preferences = { analytics_storage: 'denied' };\n${reader}\n`
  expect(sourceUnits(before).units.map(unit => unit.frozen)).toEqual([true, false])
  const after = before.replace(reader, `${reader} `)
  expect(restoreFrozenUnits(before, after).text).toBe(after)
})

it.each([
  "export default function Page() { return <main/>; }\nfunction hasConsent() { return true; }\n",
  "const label = 1;\nfunction hasConsent() { return <main/>; }\n",
])("retains a declared consent name when markup makes the whole file inseparable", before => {
  expect(sourceUnits(before)).toMatchObject({ confident: false, units: [{ key: "whole-file", frozen: true }] })
  expect(restoreFrozenUnits(before, before.replace("main", "section")).text).toBe(before)
})

it.each(["src/consentController.ts", "components/MarketingConsent.tsx", "src/CookieBanner.ts", "src/cookie-banner.ts", "src/cookie_banner.ts", "src/cookieconsent.ts"])("freezes the whole source file by its basename: %s", path => {
  const before = "export const enabled = true;\nexport const label = 'ready';\n"
  expect(sourceUnits(before, path)).toMatchObject({ confident: false, units: [{ key: "whole-file", frozen: true, text: before }] })
  expect(restoreFrozenUnits(before, before.replace("true", "false"), path).text).toBe(before)
  expect(frozenUnitAt(before, 2, path)?.key).toBe("whole-file")
})

it("does not freeze an ordinary basename just because a directory mentions consent", () => {
  const before = "export const enabled = true;\n"
  expect(sourceUnits(before, "consent/helpers.ts").units[0]?.frozen).toBe(false)
})

it.each([
  "send( /* a */ 'consent' /* b */, /* c */ 'revoke');",
  "send( /* ** a *** */ 'consent', 'revoke');",
  "posthog.opt_out_capturing /* a */ ?. /* b */ ();",
  "send( // a\n 'consent', // b\n 'default');",
])("keeps consent recognition across bounded comments: %s", source => {
  expect(isConsentText(source)).toBe(true)
})

it("does not cross a closed comment to turn unrelated text into a consent command", () => {
  expect(isConsentText("send( /* a */ value); /* b */ 'consent', 'revoke';")).toBe(false)
})
