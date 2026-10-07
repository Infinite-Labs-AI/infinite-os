import { afterEach, expect, it } from "vitest"
import { cleanupSites, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import { uninstallInstallation } from "../uninstall.js"
import { isConsentText, restoreFrozenUnits } from "./consent-units.js"

afterEach(cleanupSites)

it.each([
  '<script type="text/plain" src="/analytics.js"></script>',
  "<script src='/analytics.js' type='text/plain'></script>",
  '<SCRIPT async TYPE = "text/plain" src="/analytics.js"></SCRIPT>',
  '<script data-note="a > b" src="/analytics.js" type="text/plain"></script>',
  "<script\n defer\n type=text/plain\n src=/analytics.js></script>",
])("protects the plain-text script attribute: %s", before => {
  expect(isConsentText(before)).toBe(true)
  expect(restoreFrozenUnits(before, before.replace(/text\/plain/g, "text/javascript")).text).toBe(before)
})

it.each([
  '<link type="text/plain" rel="author" href="/humans.txt">',
  "<a href='/humans.txt' type='text/plain'>Authors</a>",
  '<script data-type="text/plain" src="/analytics.js"></script>',
  '<script data-note=" type=\'text/plain\'" src="/analytics.js"></script>',
  '<script-template type="text/plain"></script-template>',
  '<script src="/analytics.js"></script><link type="text/plain" href="/humans.txt">',
])("leaves plain-text metadata editable outside a script type attribute: %s", source => {
  expect(isConsentText(source)).toBe(false)
  expect(restoreFrozenUnits(source, source + "\n<p>New content</p>").changes).toEqual([])
})

it("installs and reverses all static pages with author metadata", () => {
  const source = '<!doctype html>\n<html><head><link type="text/plain" rel="author" href="/humans.txt"></head><body>Example</body></html>\n'
  const pages = ["index.html", "about.html", "contact.html"]
  const root = makeSite(Object.fromEntries(pages.map(page => [page, source])))
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE123" } } })
  const installed = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(installed.requiresManual ?? []).toEqual([])
  for (const page of pages) {
    expect(installed.changedFiles).toContain(page)
    expect(read(root, page)).not.toBe(source)
  }
  const reversed = uninstallInstallation({ root, allowDirty: true })
  for (const page of pages) {
    expect(reversed.restoredFiles).toContain(page)
    expect(read(root, page)).toBe(source)
  }
})
