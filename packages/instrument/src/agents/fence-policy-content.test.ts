import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { cleanup, item, makeFenceFixture, tempDir, write } from "../../test/wizard/repo.js"
import { Fence } from "./fence.js"
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))
const component = "components/PolicyContent.tsx"
const original = "export default function PolicyContent() { return <p>Owner policy</p> }\n"
const policy = "app/privacy/page.tsx"
const policySource = 'import Policy from "../../components/PolicyContent"; export default Policy\n'

it("restores a changed policy page without treating its imported component as a policy page", async () => {
  const { root } = makeFenceFixture()
  const home = tempDir("policy-content-")
  dirs.push(root, home)
  write(root, policy, policySource)
  write(root, component, original)
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "policy", turn: 1, items: [item("build_fix:repo", [component, policy])] })
  write(root, policy, "export default function Privacy() { return null }\n")
  write(root, component, original.replace("Owner policy", "Changed policy"))
  expect(await fence.claimCheckSafe()).toBe(false)
  const result = await fence.end()
  expect(result.reverted).not.toContain(component)
  expect(readFileSync(join(root, component), "utf8")).toContain("Changed policy")
  expect(readFileSync(join(root, policy), "utf8")).toBe(policySource)
})

it("allows a shared component and ordinary cookie utility to change", async () => {
  const { root } = makeFenceFixture()
  const home = tempDir("policy-shared-")
  dirs.push(root, home)
  write(root, policy, policySource)
  write(root, "app/page.tsx", 'import Policy from "../components/PolicyContent"; export default Policy\n')
  write(root, component, original)
  write(root, "lib/cookies.ts", "export const duration = 10\n")
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "policy", turn: 1, items: [item("build_fix:repo", [component, "lib/cookies.ts"])] })
  write(root, component, original.replace("Owner policy", "Shared content"))
  write(root, "lib/cookies.ts", "export const duration = 20\n")
  expect((await fence.end()).reverted).not.toContain(component)
  expect(readFileSync(join(root, component), "utf8")).toContain("Shared content")
  expect(readFileSync(join(root, "lib/cookies.ts"), "utf8")).toContain("20")
})

it("does not infer policy scope when a component loses its ordinary-page importer", async () => {
  const { root } = makeFenceFixture()
  const home = tempDir("policy-new-scope-")
  dirs.push(root, home)
  write(root, policy, policySource)
  write(root, "app/page.tsx", 'import Policy from "../components/PolicyContent"; export default Policy\n')
  write(root, component, original)
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "policy", turn: 1, items: [item("build_fix:repo", [component, "app/page.tsx"])] })
  write(root, "app/page.tsx", "export default function Home() { return null }\n")
  write(root, component, original.replace("Owner policy", "Changed policy"))
  expect((await fence.end()).reverted).not.toContain(component)
  expect(readFileSync(join(root, component), "utf8")).toContain("Changed policy")
})

it("protects only the policy page file beneath a custom application root", async () => {
  const { root } = makeFenceFixture()
  const home = tempDir("policy-app-root-")
  dirs.push(root, home)
  const appRoot = "frontend/site"
  write(root, `${appRoot}/${policy}`, policySource)
  write(root, `${appRoot}/${component}`, original)
  const fence = await Fence.begin({ root, appRoot, snapshotDir: join(home, "fence"), runId: "policy", turn: 1, items: [item("build_fix:repo", [`${appRoot}/${component}`, `${appRoot}/${policy}`])] })
  write(root, `${appRoot}/${component}`, original.replace("Owner policy", "Changed policy"))
  write(root, `${appRoot}/${policy}`, "export default function Privacy() { return null }\n")
  const result = await fence.end()
  expect(result.reverted).toContain(`${appRoot}/${policy}`)
  expect(result.reverted).not.toContain(`${appRoot}/${component}`)
  expect(readFileSync(join(root, appRoot, policy), "utf8")).toBe(policySource)
  expect(readFileSync(join(root, appRoot, component), "utf8")).toContain("Changed policy")
})
