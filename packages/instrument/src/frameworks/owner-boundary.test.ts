import { afterEach, expect, it } from "vitest"
import { cleanupSites, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import { verifyInstallation } from "../verify.js"

afterEach(cleanupSites)
const html = "<html><head><script>gtag('consent','default',{analytics_storage:'denied'});</script></head><body>Example</body></html>\n"
const cases: Array<{ name: string; path: string; files: Record<string, string> }> = [
  { name: "Next app layout", path: "app/layout.tsx", files: { "package.json": '{"dependencies":{"next":"16.0.0","react":"19.0.0"}}', "app/layout.tsx": "export default function RootLayout({children}) { return <html><body><script>{`gtag('consent','default',{analytics_storage:'denied'});`}</script>{children}</body></html> }\n" } },
  { name: "Next pages wrapper", path: "pages/_app.tsx", files: { "package.json": '{"dependencies":{"next":"16.0.0","react":"19.0.0"}}', "pages/_app.tsx": "export default function App({Component, pageProps}) { return <><script>{`gtag('consent','default',{analytics_storage:'denied'});`}</script><Component {...pageProps} /></> }\n" } },
  { name: "Vite entrypoint", path: "index.html", files: { "package.json": '{"dependencies":{"vite":"5.0.0","react":"18.0.0"}}', "index.html": html } },
  { name: "static page", path: "index.html", files: { "index.html": html } }
]
it.each(cases)("leaves $name byte-identical and returns owner-only manual wiring", ({ files, path }) => {
  const root = makeSite(files)
  const before = read(root, path)
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { posthog: { projectKey: "phc_fixture", apiHost: "https://us.i.posthog.com" } } })
  const result = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(read(root, path)).toBe(before)
  expect(result.changedFiles).not.toContain(path)
  expect(result.requiresManual).toEqual([expect.objectContaining({ path, snippet: expect.any(String), ownerBoundary: expect.objectContaining({ kind: "frozen_unit" }) })])
  expect(verifyInstallation({ root })).toMatchObject({ buildOk: true, requiresManual: [{ path }] })
})

it("does not instrument a routed static policy page, while ordinary pages receive their tags", () => {
  const policy = "<html><head></head><body>Owner policy text.</body></html>\n"
  const root = makeSite({ "index.html": "<html><head></head><body>Example</body></html>\n", "privacy/index.html": policy })
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE" } } })
  const result = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(read(root, "privacy/index.html")).toBe(policy)
  expect(read(root, "index.html")).toContain("G-FIXTURE")
  expect(result.requiresManual).toEqual([expect.objectContaining({ path: "privacy/index.html", ownerBoundary: expect.objectContaining({ kind: "policy_page" }) })])
  expect(verifyInstallation({ root })).toMatchObject({ buildOk: true, requiresManual: [{ path: "privacy/index.html" }] })
})
