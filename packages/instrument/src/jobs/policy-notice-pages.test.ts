import { afterEach, expect, it } from "vitest"
import { cleanupSites, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import { isPolicyPath } from "./policy-pages.js"

afterEach(cleanupSites)

// Representative case / separator variants of the notice and terms names.
const names = ["privacy", "privacy_policy", "PRIVACY-NOTICE", "CookiePolicy", "cookies-notice", "terms_conditions", "TermsOfService", "terms-of_use"]
it("protects the policy name variants in explicit page paths", () => {
  for (const name of names) {
    for (const path of [`${name}.html`, `pages/${name}.tsx`, `app/${name}/page.tsx`, `public/${name}/index.html`]) expect(isPolicyPath(path), path).toBe(true)
  }
})

it("protects the explicitly named owner policy or preference page, but not a component of that name", () => {
  for (const name of ["refund-policy", "acceptable-use", "acceptable-use-policy", "subprocessors", "cookie-settings"]) {
    for (const path of [`${name}.html`, `pages/${name}.tsx`, `app/${name}/page.tsx`, `content/${name}.md`]) expect(isPolicyPath(path), path).toBe(true)
    expect(isPolicyPath(`components/${name}.tsx`), name).toBe(false)
  }
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
