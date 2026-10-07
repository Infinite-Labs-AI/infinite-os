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

it.each(["privacy/index.html", "terms-and-conditions.html", "tos.html", "cookies.html", "product-terms-of-use.html", "api/privacy-policy/index.html", "docs/api/privacy-policy.html", "test/privacy-policy.html", "datenschutz.html", "data-protection.html", "eula.html", "disclaimer.html", "agb.html", "mentions-legales.html", "politica-de-privacidad.html"])("leaves static policy %s untouched while ordinary pages receive their tags", policyPath => {
  const policy = "<html><head></head><body>Owner policy text.</body></html>\n"
  const root = makeSite({ "index.html": "<html><head></head><body>Example</body></html>\n", [policyPath]: policy })
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE" } } })
  const result = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(read(root, policyPath)).toBe(policy)
  expect(read(root, "index.html")).toContain("G-FIXTURE")
  expect(result.requiresManual).toEqual([expect.objectContaining({ path: policyPath, ownerBoundary: expect.objectContaining({ kind: "policy_page" }) })])
  expect(verifyInstallation({ root })).toMatchObject({ buildOk: true, requiresManual: [{ path: policyPath }] })
})

it.each(["static-html", "vite-react"])("does not promise writable wiring for an HTML entry with no closing head (%s)", async framework => {
  const { previewOwnerWiring } = await import("./owner-wiring-preview.js")
  const root = makeSite({ "index.html": "<html><body>Example</body></html>\n" })
  const preview = previewOwnerWiring({ root, appRoot: ".", framework, plan: { files: ["index.html"], instructions: [{path: "index.html", action: "modify", description: "GA4", provider: "ga4", snippet: "<script>gtag('config', 'G-FIXTURE');</script>"}] } })
  expect(preview.canWire).toBe(false)
  expect(preview.writableEntrypoints).toEqual([])
  expect(preview.requirements).toEqual([expect.objectContaining({ path: "index.html", snippet: expect.stringContaining("G-FIXTURE") })])
})

it.each(cases)("allows ordinary generated files inside an application with a policy word in its name ($name)", async ({ files, path }) => {
  const { applyPosthogProxy } = await import("../workspace-artifacts.js")
  const scopedFiles = Object.fromEntries(Object.entries(files).map(([file, content]) => [`apps/legal/${file}`, content]))
  const root = makeSite(scopedFiles)
  const plan = planInstallation({ root, inspect: inspectWorkspace(root, { appRoot: "apps/legal" }), workspaceId: "ws_fixture", artifacts: applyPosthogProxy({ posthog: { projectKey: "phc_fixture", apiHost: "https://us.i.posthog.com" } }, { proxy: true }) })
  const result = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(result.changedFiles.some(file => file.startsWith("apps/legal/"))).toBe(true)
  expect(read(root, `apps/legal/${path}`)).toBe(files[path])
  expect(result.requiresManual).toContainEqual(expect.objectContaining({ path: `apps/legal/${path}`, ownerBoundary: expect.objectContaining({ kind: "frozen_unit" }) }))
})

it("leaves a policy page recorded by an older static install untouched during uninstall", async () => {
  const { staticHtmlAdapter } = await import("./static-html.js")
  const { readInstallManifest } = await import("../manifest.js")
  const { writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = makeSite({ "index.html": "<html><head></head><body>Example</body></html>\n" })
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE" } } })
  applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  const policy = read(root, "index.html").replace("Example", "Owner policy")
  writeFileSync(join(root, "terms-and-conditions.html"), policy)
  const manifest = readInstallManifest(root)!
  manifest.files.push("terms-and-conditions.html")
  const result = staticHtmlAdapter.uninstall!({ root, appRoot: ".", manifest, dryRun: false })
  expect(read(root, "terms-and-conditions.html")).toBe(policy)
  expect(result.restoredFiles).not.toContain("terms-and-conditions.html")
  expect(result.warnings.join("\n")).toContain("terms-and-conditions.html")
})

it.each(cases)("allows uninstall of ordinary generated files after the application moves under a policy-named package ($name)", async ({ files }) => {
  const { getFrameworkAdapter } = await import("./index.js")
  const { readInstallManifest } = await import("../manifest.js")
  const { existsSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = makeSite(files)
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE" } } })
  applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  const copied = Object.fromEntries([...new Set([...plan.files, ...Object.keys(files)])].filter(file => existsSync(join(root, file))).map(file => [`apps/legal/${file}`, read(root, file)]))
  const movedRoot = makeSite(copied)
  const manifest = readInstallManifest(root)!
  manifest.files = manifest.files.map(file => `apps/legal/${file}`)
  manifest.appRoot = "apps/legal"
  const result = getFrameworkAdapter(plan.framework)!.uninstall!({ root: movedRoot, appRoot: manifest.appRoot, manifest, dryRun: false })
  expect(result.warnings.some(warning => warning.includes("policy page"))).toBe(false)
  for (const [path, content] of Object.entries(files)) expect(read(movedRoot, `apps/legal/${path}`)).toBe(content)
  if (plan.framework.startsWith("next-")) expect(result.removedFiles).toContain("apps/legal/lib/infinite-analytics-client.tsx")
})

it.each(["policy.html", "policies.html", "recipes/cookies.html", "services/legal/index.html", "blog/our-privacy-first-approach.html", "insurance/policies/index.html", "api/privacy/index.html", "docs/api/privacy.html", "test/privacy.html"])("wires an ordinary page whose name is outside the exact policy list: %s", path => {
  const html = "<html><head></head><body>Ordinary page</body></html>\n"
  const root = makeSite({ "index.html": html, [path]: html })
  const plan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_fixture", artifacts: { ga4: { measurementId: "G-FIXTURE" } } })
  const result = applyInstallation({ root, workspaceId: "ws_fixture", plan, allowDirty: true })
  expect(read(root, path)).toContain("G-FIXTURE")
  expect(result.changedFiles).toContain(path)
  expect(result.requiresManual ?? []).toEqual([])
})
