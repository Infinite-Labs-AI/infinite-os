import { afterEach, expect, it } from "vitest"
import { cleanupSites, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import { isPolicyPath } from "./policy-pages.js"

afterEach(cleanupSites)

const legacyNames = ["privacy", "terms"]
for (const separator of ["", "-", "_"]) {
  for (const prefix of ["privacy", "cookie", "cookies"]) {
    for (const suffix of ["policy", "notice"]) legacyNames.push(prefix + separator + suffix)
  }
  legacyNames.push("terms" + separator + "conditions")
  for (const middle of ["", "-", "_"]) {
    for (const suffix of ["service", "use"]) legacyNames.push("terms" + separator + "of" + middle + suffix)
  }
}
const names = [...new Set(legacyNames.flatMap(name => [name, name.toUpperCase(), name.split(/[-_]/).map(word => word[0]!.toUpperCase() + word.slice(1)).join("")]))]
it.each(names)("protects the legacy policy name in explicit page paths: %s", name => {
  for (const path of [`${name}.html`, `pages/${name}.tsx`, `app/${name}/page.tsx`, `public/${name}/index.html`]) expect(isPolicyPath(path), path).toBe(true)
})

it.each(["refund-policy", "acceptable-use", "acceptable-use-policy", "subprocessors", "cookie-settings"])("protects the explicitly named owner policy or preference page: %s", name => {
  for (const path of [`${name}.html`, `pages/${name}.tsx`, `app/${name}/page.tsx`, `content/${name}.md`]) expect(isPolicyPath(path), path).toBe(true)
  expect(isPolicyPath(`components/${name}.tsx`)).toBe(false)
})

it("does not install analytics into privacy or cookie notice pages", () => {
  const source = '<!doctype html>\n<html><head><title>Policy</title></head><body>Owner policy text.</body></html>\n'
  const policies = ["privacy-notice.html", "cookie-notice.html", "cookies-notice.html"]
  const root = makeSite({ "index.html": source, ...Object.fromEntries(policies.map(path => [path, source])) })
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE123" } } })
  const installed = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(installed.changedFiles).toContain("index.html")
  for (const policy of policies) {
    expect(installed.changedFiles).not.toContain(policy)
    expect(read(root, policy)).toBe(source)
  }
})
