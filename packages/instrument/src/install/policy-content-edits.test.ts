import { afterEach, expect, it } from "vitest"
import { cleanupSites, fakeKeys, IDS, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { applyImproveEdit } from "./improve.js"
import { makeEditRecord } from "./edits.js"
import { reverseRecordedEdits } from "../uninstall.js"
const component = "components/PolicyBody.tsx"
const page = "app/privacy/page.tsx"
const importsPolicy = 'import Body from "../../components/PolicyBody"; export default Body\n'
const original = "export default function Body() { return <p>Original policy</p> }\n"
const edited = original.replace("Original", "Edited")
afterEach(cleanupSites)

it.each([false, true])("direct improve respects exclusive policy content (shared %s)", shared => {
  const source = `export default function Body() {\n  fbq('init', '${IDS.meta}');\n  return <p>Policy</p>\n}\n`
  const root = makeSite({ [component]: source, [page]: importsPolicy, ...(shared ? { "app/page.tsx": 'import Body from "../components/PolicyBody"; export default Body\n' } : {}) })
  const result = applyImproveEdit({ root, appRoot: ".", framework: "next-app-router", keys: fakeKeys(), consentMode: "not_required", vercelServed: true, runId: IDS.run,
    line: { id: "autoconfig_off_adopted:meta:autoconfig", kind: "autoconfig_off_adopted", provider: "meta", target: "autoconfig", owner: "code", text: "Disable automatic events", evidence: { file: component, line: 2 } } })
  if (shared) {
    expect(result.ok).toBe(true)
    expect(read(root, component)).toContain("autoConfig")
  } else {
    expect(result).toMatchObject({ ok: false, ownerRequirement: { path: component, ownerBoundary: { kind: "policy_page" } } })
    expect(read(root, component)).toBe(source)
  }
})

it.each([false, true])("legacy reversal preserves a policy-only component from the historical graph (import removed %s)", removed => {
  const afterPage = removed ? "export default function Privacy() { return null }\n" : importsPolicy
  const root = makeSite({ [component]: edited, [page]: afterPage })
  const edits = [makeEditRecord({ file: component, before: original, after: edited, jobId: "build_fix", planLineId: null, by: "wizard", runId: IDS.run, seq: 0 }),
    ...(removed ? [makeEditRecord({ file: page, before: importsPolicy, after: afterPage, jobId: "privacy_paragraph", planLineId: null, by: "wizard", runId: IDS.run, seq: 1 })] : [])]
  const result = reverseRecordedEdits(root, { edits }, false)
  expect(result.leftAsIs).toContain(component)
  expect(result.reversed).not.toContain(component)
  expect(read(root, component)).toBe(edited)
  expect(read(root, page)).toBe(afterPage)
})

it("legacy reversal still restores a genuinely shared component", () => {
  const root = makeSite({ [component]: edited, [page]: importsPolicy, "app/page.tsx": 'import Body from "../components/PolicyBody"; export default Body\n' })
  const edits = [makeEditRecord({ file: component, before: original, after: edited, jobId: "csp", planLineId: null, by: "wizard", runId: IDS.run })]
  expect(reverseRecordedEdits(root, { edits }, false).reversed).toContain(component)
  expect(read(root, component)).toBe(original)
})

it("keeps explicitly recorded legacy policy content when later owner edits make the old import graph unreadable", () => {
  const root = makeSite({ [component]: edited, [page]: "export default function Privacy() { return <p>Owner revision</p> }\n" })
  const edits = [makeEditRecord({ file: component, before: original, after: edited, jobId: "privacy_paragraph", planLineId: null, by: "wizard", runId: IDS.run, seq: 0 }),
    makeEditRecord({ file: page, before: importsPolicy, after: "export default function Privacy() { return null }\n", jobId: "build_fix", planLineId: null, by: "wizard", runId: IDS.run, seq: 1 })]
  expect(reverseRecordedEdits(root, { edits }, false).leftAsIs).toContain(component)
  expect(read(root, component)).toBe(edited)
})
