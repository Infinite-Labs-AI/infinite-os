import { expect, it } from "vitest"
import { isConsentText, restoreFrozenUnits, sourceUnits } from "./consent-units.js"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { measureOwnerDiff } from "./owner-diff.js"

const protectedEdits = [
  ["Consent Mode map", "const defaults = { analytics_storage: 'denied' };\n", "denied", "granted"],
  ["Optanon callback", "window.OptanonWrapper = function () { if (OnetrustActiveGroups.includes('C0004')) fbq('init', '1234567890123456'); };\n", "if (OnetrustActiveGroups.includes('C0004')) ", ""],
  ["Cookiebot gate", "function start() { if (Cookiebot.consent.marketing) fbq('init', '1234567890123456'); }\n", "if (Cookiebot.consent.marketing) ", ""],
  ["cookie category", '<script data-cookieconsent="statistics">gtag("config", "G-FIXTURE123");</script>\n', ' data-cookieconsent="statistics"', ""],
] as const

it.each(protectedEdits)("restores both directions of a recognized raw %s edit", (_name, before, from, to) => {
  const after = before.replace(from, to)
  expect(sourceUnits(before).units.some(unit => unit.frozen)).toBe(true)
  expect(restoreFrozenUnits(before, after).text).toBe(before)
  expect(restoreFrozenUnits(after, before).text).toBe(after)
})

// One raw marker per Consent Mode key family, CMP vendor and CMP loader host.
it("recognizes the raw key, CMP, or loader marker even in a comment", () => {
  for (const marker of ["ad_storage", "wait_for_update", "__tcfapi", "__gpp", "OneTrust", "Cookiebot", "DidomiOnReady", "usercentrics", "klaro", "cdn.cookielaw.org"]) {
    const before = `// ${marker}\nexport const version = 1;\n`
    expect(isConsentText(before), marker).toBe(true)
    expect(sourceUnits(before).units.some(unit => unit.frozen), marker).toBe(true)
    expect(restoreFrozenUnits(before, before.replace(marker, "ordinary")).text, marker).toBe(before)
  }
})

it("recognizes a consent action on ordinary, optional, call and apply callees", () => {
  for (const action of ["default", "update", "grant", "revoke"]) {
    for (const source of [
      `send('consent', '${action}');`,
      `send?.('consent', '${action}');`,
      `send.call(null, 'consent', '${action}');`,
      `send.apply(null, ['consent', '${action}']);`,
      `send('consent' /* label */, /* action */ '${action}');`,
    ]) expect(isConsentText(source), source).toBe(true)
  }
})

it("leaves an ordinary non-consent argument or analytics call editable", () => {
  for (const before of ["t('consent');", "register.apply(null, ['consent']);", "register('consent', 'view');", "gtag('config', 'G-FIXTURE123');", "posthog.init('phc_fixture', { api_host: '/ingest' });"]) {
    expect(isConsentText(before), before).toBe(false)
    expect(restoreFrozenUnits(before, before + "\nexport const version = 2;\n").changes, before).toEqual([])
  }
})

it("never loses raw consent after template, regex or raw-text delimiter confusion", () => {
  for (const before of [
    'const label = `${`{/*`}`;\nfbq("consent", "revoke");\nconst closing = "*/}";\n',
    'if (true) /a//2; fbq("consent", "revoke");\n',
    '<html><textarea><!--</textarea><script>fbq("consent", "revoke");</script>--></html>',
  ]) {
    expect(sourceUnits(before).units.some(unit => unit.frozen), before).toBe(true)
    expect(restoreFrozenUnits(before, before.replace("revoke", "grant")).text, before).toBe(before)
  }
})

it("measures a separate Consent Mode map flip as changed", async () => {
  const path = "src/preferences.ts"
  const fixture = createGitFixture({ files: { [path]: "const mode = { analytics_storage: 'denied' };\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write(path, "const mode = { analytics_storage: 'granted' };\n")
    expect(await measureOwnerDiff({ root: fixture.root, baseSha })).toMatchObject({ state: "changed", issues: [expect.objectContaining({ file: path })] })
  } finally { fixture.cleanup() }
})
