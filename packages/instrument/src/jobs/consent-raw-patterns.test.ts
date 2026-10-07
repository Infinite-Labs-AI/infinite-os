import { expect, it } from "vitest"
import { isConsentText, restoreFrozenUnits, sourceUnits } from "./consent-units.js"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { measureOwnerDiff } from "./owner-diff.js"

const protectedEdits = [
  ["Consent Mode map", "const defaults = { analytics_storage: 'denied' };\n", "denied", "granted"],
  ["dataLayer object", "dataLayer.push({ event: 'consent_update', ad_storage: 'denied' });\n", "denied", "granted"],
  ["Optanon callback", "window.OptanonWrapper = function () { if (OnetrustActiveGroups.includes('C0004')) fbq('init', '1234567890123456'); };\n", "if (OnetrustActiveGroups.includes('C0004')) ", ""],
  ["active CMP groups", "function start() { if (OnetrustActiveGroups.includes('C0004')) fbq('init', '1234567890123456'); }\n", "if (OnetrustActiveGroups.includes('C0004')) ", ""],
  ["Cookiebot gate", "function start() { if (Cookiebot.consent.marketing) fbq('init', '1234567890123456'); }\n", "if (Cookiebot.consent.marketing) ", ""],
  ["cookie category", '<script data-cookieconsent="statistics">gtag("config", "G-FIXTURE123");</script>\n', ' data-cookieconsent="statistics"', ""],
  ["plain-text script", '<script type="text/plain">gtag("config", "G-FIXTURE123");</script>\n', ' type="text/plain"', ""],
  ["both gated attributes", '<script type="text/plain" data-cookieconsent="statistics">gtag("config", "G-FIXTURE123");</script>\n', ' type="text/plain" data-cookieconsent="statistics"', ""],
] as const

it.each(protectedEdits)("restores both directions of a recognized raw %s edit", (_name, before, from, to) => {
  const after = before.replace(from, to)
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, after).text).toBe(before)
  expect(restoreFrozenUnits(after, before).text).toBe(after)
})

it.each([
  "ad_storage", "analytics_storage", "ad_user_data", "ad_personalization", "functionality_storage", "personalization_storage", "security_storage", "wait_for_update",
  "__tcfapi", "__uspapi", "__gpp", "__cmp", "OneTrust", "OptanonWrapper", "Cookiebot", "CookieConsent", "DidomiOnReady", "UC_UI", "usercentrics", "klaro", "OnetrustActiveGroups",
  "cdn.cookielaw.org", "otSDKStub.js", "consent.cookiebot.com", "usercentrics.eu",
])("recognizes the raw key, CMP, or loader marker even in a comment: %s", marker => {
  const before = `// ${marker}\nexport const version = 1;\n`
  expect(isConsentText(before)).toBe(true)
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace(marker, "ordinary")).text).toBe(before)
})

it.each(["default", "update", "grant", "revoke"])("recognizes %s after consent on ordinary, optional, call and apply callees", action => {
  for (const source of [
    `send('consent', '${action}');`,
    `send?.('consent', '${action}');`,
    `send.call(null, 'consent', '${action}');`,
    `send.apply(null, ['consent', '${action}']);`,
    `send('consent' /* label */, /* action */ '${action}');`,
  ]) expect(isConsentText(source), source).toBe(true)
})

it.each([
  "t('consent');", 't("consent");', "register('consent');", "register?.('consent');", "register.call(null, 'consent');", "register.apply(null, ['consent']);",
  "t('consent', { context: 'menu' });", "register('consent', 'view');", "const text = 'consent';", "gtag('config', 'G-FIXTURE123');", "posthog.init('phc_fixture', { api_host: '/ingest' });",
])("leaves an ordinary non-consent argument or analytics call editable: %s", before => {
  expect(isConsentText(before)).toBe(false)
  expect(restoreFrozenUnits(before, before + "\nexport const version = 2;\n").changes).toEqual([])
})

it.each([
  'const label = `${`{/*`}`;\nfbq("consent", "revoke");\nconst closing = "*/}";\n',
  'if (true) /a//2; fbq("consent", "revoke");\n',
  ...["style", "textarea", "title"].map(tag => `<html><${tag}><!--</${tag}><script>fbq("consent", "revoke");</script>--></html>`),
])("never loses raw consent after template, regex or raw-text delimiter confusion", before => {
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace("revoke", "grant")).text).toBe(before)
})

it("the regex/division probe contains a live call in JavaScript", () => {
  const calls: unknown[][] = []
  new Function("fbq", 'if (true) /a//2; fbq("consent", "revoke");')((...args: unknown[]) => calls.push(args))
  expect(calls).toEqual([["consent", "revoke"]])
})

it.each([["denied", "granted"], ["granted", "denied"]])("measures a separate Consent Mode map flip from %s to %s as changed", async (from, to) => {
  const path = "src/preferences.ts"
  const fixture = createGitFixture({ files: { [path]: `const mode = { analytics_storage: '${from}' };\n` } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write(path, `const mode = { analytics_storage: '${to}' };\n`)
    expect(await measureOwnerDiff({ root: fixture.root, baseSha })).toMatchObject({ state: "changed", issues: [expect.objectContaining({ file: path })] })
  } finally { fixture.cleanup() }
})
