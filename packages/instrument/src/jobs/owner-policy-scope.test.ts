import { expect, it } from "vitest"
import { item } from "../../test/wizard/repo.js"
import { scopeOwnerJob } from "./owner-scope.js"

it.each([null, "@ui/Body", "$lib/Body", "components/Body", "@workspace/ui", "@/components/Body"])("does not infer policy ownership from component importers (%s)", sharedImport => {
  const component = "components/Body.tsx"
  const sources = new Map([
    ["app/privacy/page.tsx", 'import Body from "../../components/Body"; export default Body'],
    [component, "export default function Body() { return <p>Content</p> }"]
  ])
  if (sharedImport) sources.set("app/page.tsx", `import Body from '${sharedImport}'; export default Body`)
  const job = item("build_fix:repo", [component])
  expect(scopeOwnerJob(job, sources).state).not.toBe("left_for_you")
})

it.each([".", "frontend/site"])("still leaves actual policy page files out of worker jobs under %s", appRoot => {
  const prefix = appRoot === "." ? "" : `${appRoot}/`
  const page = `${prefix}app/privacy/page.tsx`
  const sources = new Map([[page, "export default function Privacy() { return <p>Policy text</p> }"]])
  expect(scopeOwnerJob(item("build_fix:repo", [page]), sources, appRoot)).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "policy_page", file: page } })
})
