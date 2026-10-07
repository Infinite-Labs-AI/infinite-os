import { expect, it } from "vitest"
import { item } from "../../test/wizard/repo.js"
import { scopeOwnerJob } from "./owner-scope.js"

it.each([".", "frontend/site"])("leaves one-hop policy content out of proposed worker jobs under %s", appRoot => {
  const prefix = appRoot === "." ? "" : `${appRoot}/`
  const component = `${prefix}components/Body.tsx`
  const sources = new Map([
    [`${prefix}app/privacy/page.tsx`, 'import Body from "../../components/Body"; export default Body'],
    [component, "export default function Body() { return <p>Owner policy</p> }"]
  ])
  const job = item("build_fix:repo", [component])
  expect(scopeOwnerJob(job, sources, appRoot)).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "policy_page", file: component } })
  sources.set(`${prefix}app/page.tsx`, 'import Body from "../components/Body"; export default Body')
  expect(scopeOwnerJob(job, sources, appRoot).state).not.toBe("left_for_you")
})
