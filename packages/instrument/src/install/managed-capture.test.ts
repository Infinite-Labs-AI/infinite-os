import { afterEach, expect, it } from "vitest"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { rmSync, writeFileSync } from "node:fs"
import { cleanupSites, fakeBefore, fakeHosting, fakeKeys, fakeProductionDeniedConflict, IDS, makeSite, read, candidate, fakeContext, notConnectedKeys } from "../../test/wizard/o7-fakes.js"
import { createBrowserVm } from "../../test/site-code/browser-vm.js"
import { WizardInstaller } from "./installer.js"
import { applyManagedCapture, planManagedCapture, readManagedCapture } from "./managed-capture.js"
import { GENERATED_API_RECORD, generatedApiTexts, recordGeneratedApi } from "../jobs/generated-api.js"
import { nodeWizardFs } from "../wizard/fs.js"
import { itemT0Scenarios } from "../wizard/item-t0.js"
import { runT0Scenarios } from "../t0/scenarios.js"
import { o9CheckFunctions } from "../checks/o9.js"
import { verifyManagedCaptureJobs } from "../wizard/steps/install.js"
import { createJobRegistry } from "../jobs/registry.js"
import type { CheckRunner } from "../wizard/contracts/jobs.js"
import { runSetupChecks } from "../setup-checks/index.js"
import { renderInfiniteBrowserTag } from "../runtime/infinite-browser.js"
import { buildMetaClickIdCaptureScript } from "../providers/meta-browser/click-id.js"
import { CONSENT_YES, consentActivationFor } from "./consent-handoff.js"

afterEach(cleanupSites)
const pixel = "if (typeof window !== 'undefined') { fbq('init','7777000011112222'); fbq('consent','revoke'); }\n"
const files = { "package.json": '{"dependencies":{"next":"16.0.0","react":"19.0.0"}}', "pages/_app.tsx": 'import "../src/pixel"\nexport default function App({Component,pageProps}) { return <Component {...pageProps} /> }\n', "src/pixel.ts": pixel }

async function installed(framework = "next-pages-router", mode: "required" | "not_required" = "required") {
  const pixelFile = framework === "static-html" ? "assets/pixel.js" : "src/pixel.js"
  const source = '"use client";\nif (typeof window !== "undefined") { window.fbq("init","7777000011112222"); window.fbq("consent","revoke"); }\nexport default function Pixel(){ return null; }\n'
  const entry = framework === "next-app-router" ? "app/layout.tsx" : framework === "next-pages-router" ? "pages/_app.tsx" : "index.html"
  const entrySource = framework === "next-app-router" ? 'import Pixel from "../src/pixel"\nexport default function RootLayout({children}) { return <html><head></head><body><Pixel />{children}</body></html> }\n'
    : framework === "next-pages-router" ? 'import "../src/pixel"\nexport default function App({Component,pageProps}) { return <Component {...pageProps} /> }\n'
    : '<html><head><script src="/assets/pixel.js"></script></head><body><div id="root"></div></body></html>\n'
  const repoFiles: Record<string, string> = { [entry]: entrySource, [pixelFile]: source }
  if (framework.startsWith("next-")) repoFiles["package.json"] = files["package.json"]
  if (framework === "vite-react") { repoFiles["package.json"] = '{"dependencies":{"vite":"5.0.0","react":"18.0.0"}}'; repoFiles["src/main.js"] = 'import "./pixel.js"\n'; repoFiles[entry] = entrySource.replace('<script src="/assets/pixel.js"></script>', '<script type="module" src="/src/main.js"></script>') }
  const root = makeSite(repoFiles)
  const subject = new WizardInstaller({ root, repoFingerprint: IDS.fingerprint, runId: () => IDS.run, agent: () => null, consentFlag: () => mode, productionDeniedConflict: fakeProductionDeniedConflict })
  const scan = await subject.scan({ root, hosting: fakeHosting() })
  const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
  const result = await subject.apply(plan, { approved: [], declined: [], edits: { consent_mode: mode } })
  expect(result.ok, result.reason ?? "").toBe(true)
  const proof = await readManagedCapture(root, nodeWizardFs.readText)
  expect(proof, JSON.stringify(result.ownerRequirements)).not.toBeNull()
  return { root, subject, scan, result, proof: proof!, entry, pixelFile, source }
}

it("plans a managed capture at the free app entry without editing the frozen pixel module", async () => {
  const root = makeSite(files)
  const subject = new WizardInstaller({ root, repoFingerprint: IDS.fingerprint, runId: () => IDS.run, agent: () => null, consentFlag: () => "required", productionDeniedConflict: fakeProductionDeniedConflict })
  const scan = await subject.scan({ root, hosting: fakeHosting() })
  subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
  expect((scan as typeof scan & { managedCapture?: unknown }).managedCapture).toMatchObject({ canWire: true, entrypoints: ["pages/_app.tsx"], module: "lib/infinite-meta-click-id.js", requirements: [] })
  expect(read(root, "src/pixel.ts")).toBe(pixel)
  expect(read(root, "pages/_app.tsx")).toBe(files["pages/_app.tsx"])
})

it.each(["next-pages-router", "next-app-router", "vite-react", "static-html"])("emits reachable capture before the unchanged pixel with its existing gate: %s", async framework => {
  const site = await installed(framework)
  expect(read(site.root, site.pixelFile)).toBe(site.source)
  expect(site.proof.browserCode).toBe(read(site.root, site.proof.record.module))
  expect(runSetupChecks(site.root).checks.find(check => check.check === "click_id_capture")?.state).toBe("ok")
  for (const allowed of [false, true]) {
    const browser = createBrowserVm({ url: "https://example.test/?fbclid=fixtureClick" })
    browser.window.__infiniteConsentAllowed = () => allowed
    let seen = "unread"
    browser.window.fbq = (event: string) => { if (event === "init") seen = browser.cookies.read() }
    browser.runScript(site.proof.browserCode)
    browser.runScript(site.source.split("export default")[0]!)
    expect(browser.scriptErrors).toEqual([])
    expect(seen.includes("_fbc=")).toBe(allowed)
    expect(browser.cookies.writes.length > 0).toBe(allowed)
  }
})

it.each(["vite-react", "static-html"])("preserves existing SDK bytes and requires ownership of the capture module: %s", async framework => {
  const site = await installed(framework)
  const loader = '\n  <script src="/infinite-meta-click-id.js" data-infinite-meta-capture></script>'
  const before = read(site.root, site.entry).replace(loader, "")
  writeFileSync(join(site.root, site.entry), before)
  const input = { root: site.root, appRoot: ".", framework, pixels: site.scan.facts.meta, htmlPages: [site.entry] }
  expect(generatedApiTexts(site.root, site.entry).length).toBeGreaterThan(0)
  expect(planManagedCapture(input)).toMatchObject({ canWire: true, editEntrypoints: [site.entry], requirements: [] })
  expect(applyManagedCapture({ ...input, mode: "required", runId: IDS.run, seq: 0 }).changedFiles).toEqual([site.entry])
  expect(read(site.root, site.pixelFile)).toBe(site.source)

  // An unrelated loader insertion preserves old SDK statements byte-for-byte without needing their provenance.
  writeFileSync(join(site.root, site.entry), before)
  rmSync(join(site.root, GENERATED_API_RECORD))
  expect(planManagedCapture(input)).toMatchObject({ canWire: true, editEntrypoints: [site.entry], requirements: [] })
  expect(applyManagedCapture({ ...input, mode: "required", runId: IDS.run, seq: 0 }).changedFiles).toEqual([site.entry])
  expect(read(site.root, site.entry).replace(loader, "")).toBe(before)

  // The canonical-looking target module and its marker/path cannot substitute for an ownership receipt.
  writeFileSync(join(site.root, site.entry), before)
  const receipt = JSON.parse(read(site.root, ".infinite/install.json"))
  delete receipt.managedCapture
  writeFileSync(join(site.root, ".infinite/install.json"), JSON.stringify(receipt))
  expect(read(site.root, site.proof.record.module)).toBe(site.proof.browserCode)
  expect(planManagedCapture(input)).toMatchObject({ canWire: false, requirements: [expect.objectContaining({ reason: expect.stringContaining("target module is not recorded as ours"), ownerBoundary: expect.objectContaining({ kind: "unproven_wiring" }) })] })
  expect(applyManagedCapture({ ...input, mode: "required", runId: IDS.run, seq: 0 }).changedFiles).toEqual([])
  expect(read(site.root, site.entry)).toBe(before)
})

it("keeps owner consent frozen alongside recorded generated HTML", async () => {
  const site = await installed("static-html")
  const before = read(site.root, site.entry).replace('\n  <script src="/infinite-meta-click-id.js" data-infinite-meta-capture></script>', "")
    .replace("</head>", '<script>fbq("consent", "revoke");</script></head>')
  writeFileSync(join(site.root, site.entry), before)
  const input = { root: site.root, appRoot: ".", framework: "static-html", pixels: site.scan.facts.meta, htmlPages: [site.entry] }
  expect(generatedApiTexts(site.root, site.entry).length).toBeGreaterThan(0)
  expect(planManagedCapture(input)).toMatchObject({ canWire: false, requirements: [expect.objectContaining({ ownerBoundary: expect.objectContaining({ kind: "frozen_unit" }) })] })
  expect(applyManagedCapture({ ...input, mode: "required", runId: IDS.run, seq: 0 }).changedFiles).toEqual([])
  expect(read(site.root, site.entry)).toBe(before)
})

it("upgrades a previously recorded fixed capture artifact without adopting unrecorded bytes", async () => {
  const site = await installed()
  const earlier = site.proof.browserCode.replace("Public install artifacts only.", "Earlier fixed emitter output.")
  writeFileSync(join(site.root, site.proof.record.module), earlier)
  const receipt = JSON.parse(read(site.root, ".infinite/install.json"))
  receipt.managedCapture.moduleHash = createHash("sha256").update(earlier).digest("hex")
  writeFileSync(join(site.root, ".infinite/install.json"), JSON.stringify(receipt))
  const input = { root: site.root, appRoot: ".", framework: "next-pages-router", pixels: site.scan.facts.meta }
  expect(planManagedCapture(input)?.canWire).toBe(false)
  recordGeneratedApi(site.root, site.proof.record.module, earlier)
  expect(planManagedCapture(input)?.canWire).toBe(true)
  expect(applyManagedCapture({ ...input, mode: "required", runId: IDS.run, seq: 0 }).changedFiles).toEqual([site.proof.record.module])
  expect(read(site.root, site.proof.record.module)).toBe(site.proof.browserCode)
})

it("executes the actual recorded artifact in T0, under a sandbox grant", async () => {
  const site = await installed()
  const item = candidate("meta_improve", "capture", { owner: "code", allow: { files: site.proof.record.entrypoints, create: [site.proof.record.module] } })
  const scenarios = await itemT0Scenarios(item, [{ checkId: "fbc_capture" }], { productionHost: "example.test" }, { root: site.root, fs: nodeWizardFs })
  expect(JSON.stringify(scenarios[0]?.params.source)).toContain("infiniteMetaClickId")
  expect(await runT0Scenarios(scenarios, {}, { runId: IDS.run, now: () => new Date("2026-10-07T00:00:00Z") })).toEqual([expect.objectContaining({ state: "pass", reason: expect.stringContaining("works when consent is granted") })])
})

it("advances the installer-owned capture from real S and T0 results without a worker", async () => {
  const site = await installed()
  const ctx = fakeContext({ root: site.root })
  const item = candidate("meta_improve", "capture", { owner: "code", allow: { files: site.proof.record.entrypoints, create: [site.proof.record.module] }, checks: [{ id: "click_id_capture", tier: "S", state: "not_run" }, { id: "fbc_capture", tier: "T0", state: "not_run" }, { id: "meta_seen_leaving", tier: "PV", state: "not_run" }] })
  ctx.state.update(state => { state.jobs = [item] })
  const checks = { run: async (_id: string, input: unknown) => o9CheckFunctions({ root: site.root, version: "fixture" }).click_id_capture(input, { runId: IDS.run, now: ctx.now }), t0: async (scenarios: Parameters<CheckRunner["t0"]>[0], artifacts: Parameters<CheckRunner["t0"]>[1]) => runT0Scenarios(scenarios, artifacts, { runId: IDS.run, now: ctx.now }) } as Pick<CheckRunner, "run" | "t0">
  await verifyManagedCaptureJobs(ctx, { fs: nodeWizardFs, registry: createJobRegistry({ briefFacts: () => null }), checks: checks as CheckRunner }, site.result, { productionHost: "example.test" })
  const checked = ctx.state.get().jobs[0]!
  expect(checked.state).toBe("done_in_code")
  expect(checked.note).toContain("Installed, waiting on your banner signal")
  expect(checked.checks.filter(check => check.tier === "S" || check.tier === "T0").every(check => check.state === "pass" && check.runId === IDS.run)).toBe(true)
  expect(checked.checks.find(check => check.tier === "PV")?.state).toBe("not_run")
  const [afterVisit] = createJobRegistry({ briefFacts: () => null }).apply([checked], [{ checkId: "meta_seen_leaving", tier: "PV", state: "pass", at: "2099-01-01T00:00:00Z", runId: IDS.run }], IDS.run, { afterDeploy: true })
  expect(afterVisit).toMatchObject({ state: "done_in_code", consentActivation: "waiting_banner_signal", note: expect.stringContaining("waiting on your banner signal") })
})

it.each([false, true])("the exact banner dispatch activates and revokes required capture (Infinite runtime: %s)", async withRuntime => {
  const site = await installed()
  const browser = createBrowserVm({ url: "https://example.test/?fbclid=bannerClick" })
  browser.window.CustomEvent = class { constructor(public type: string, public init: { detail: unknown }) {} get detail() { return this.init.detail } }
  browser.runScript(site.proof.browserCode)
  if (withRuntime) browser.runHtml(renderInfiniteBrowserTag({ siteSourceKey: "site_fixture_key", collectPath: "/infinite/ledger", respectDnt: true, consent: { mode: "required", storageKey: "infinite_analytics_consent" }, productionHosts: ["example.test"] }))
  expect(browser.cookies.writes).toEqual([])
  expect(browser.beacons).toEqual([])
  const yes = 'window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", { detail: { granted: true } }));'
  const no = 'window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", { detail: { granted: false } }));'
  browser.runScript(yes)
  await browser.advance(0)
  expect(browser.cookies.writes).toEqual([])
  browser.runScript('window.dispatchEvent({ type: "pointerdown", isTrusted: true });')
  browser.runScript(yes)
  await browser.advance(0)
  expect(browser.scriptErrors).toEqual([])
  expect(browser.cookies.values("_fbc")).toHaveLength(1)
  expect(browser.evaluate('window.infiniteMetaClickId()')).not.toBe("")
  if (withRuntime) expect(browser.beacons.length + browser.fetches.length).toBeGreaterThan(0)
  await browser.advance(10_001)
  browser.runScript(no)
  await browser.advance(0)
  expect(browser.localValues.get("infinite_analytics_consent")).toBe("denied")
  expect(browser.evaluate('window.infiniteMetaClickId()')).toBe("")
  expect(browser.cookies.values("_fbc")).toEqual([])
  if (withRuntime) expect(browser.evaluate('window.__infiniteConsentAllowed()')).toBe(false)
  browser.runScript('window.dispatchEvent({ type: "pointerdown", isTrusted: true });')
  browser.runScript(yes)
  await browser.advance(0)
  expect(browser.cookies.values("_fbc")).toHaveLength(1)
})

it.each([false, true].flatMap(withRuntime => ["none", "recent", "expired"].map(gesture => ({ withRuntime, gesture }))))("withdrawal removes this instance's cookie without requiring a gesture: $withRuntime / $gesture", async ({ withRuntime, gesture }) => {
  const browser = createBrowserVm({ url: "https://example.test/?fbclid=storedGrant", localStorage: { infinite_analytics_consent: "granted" } })
  browser.runScript(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "required" } }))
  if (withRuntime) browser.runHtml(renderInfiniteBrowserTag({ siteSourceKey: "site_fixture_key", collectPath: "/infinite/ledger", respectDnt: true, consent: { mode: "required", storageKey: "infinite_analytics_consent" }, productionHosts: ["example.test"] }))
  expect(browser.cookies.values("_fbc")).toHaveLength(1)
  if (gesture !== "none") browser.runScript('window.dispatchEvent({ type: "pointerdown" });')
  if (gesture === "expired") await browser.advance(10_001)
  browser.runScript('window.dispatchEvent({ type: "infinite:analytics-consent-change", detail: { granted: false } });')
  await browser.advance(0)
  expect(browser.cookies.values("_fbc")).toEqual([])
  expect(browser.evaluate('window.infiniteMetaClickId()')).toBe("")
  expect(browser.localValues.get("infinite_analytics_consent")).toBe("denied")
  if (withRuntime) expect(browser.evaluate('window.__infiniteConsentAllowed()')).toBe(false)
})

it("a refusal survives unavailable storage and does not delete a foreign replacement cookie", () => {
  const browser = createBrowserVm({ url: "https://example.test/?fbclid=ownedClick", storageThrows: true })
  browser.runScript(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "not_required" } }))
  browser.cookies.write("_fbc=fb.1.1000000000000.foreign;domain=example.test;path=/")
  browser.runScript('window.dispatchEvent({ type: "infinite:analytics-consent-change", detail: { granted: false } });')
  expect(browser.scriptErrors).toEqual([])
  expect(browser.cookies.values("_fbc")).toEqual(["fb.1.1000000000000.foreign"])
  expect(browser.evaluate('window.infiniteMetaClickId()')).toBe("")
})

it("does not mistake a shadow copy for ownership of a foreign replacement", () => {
  const browser = createBrowserVm({ url: "https://www.example.test/?fbclid=ownedClick" })
  browser.runScript(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "not_required" } }))
  const own = browser.cookies.values("_fbc")[0]!
  browser.cookies.write(`_fbc=${own};path=/`)
  browser.cookies.write("_fbc=fb.1.1000000000000.foreign;domain=example.test;path=/")
  browser.runScript('window.dispatchEvent({ type: "infinite:analytics-consent-change", detail: { granted: false } });')
  expect(browser.cookies.values("_fbc")).toEqual(expect.arrayContaining([own, "fb.1.1000000000000.foreign"]))
})

it("an in-memory standalone grant cannot override a later runtime denial", async () => {
  const browser = createBrowserVm({ url: "https://example.test/?fbclid=ownedClick", storageThrows: true })
  browser.runScript(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "required" } }))
  browser.runScript('window.dispatchEvent({ type: "pointerdown" }); window.dispatchEvent({ type: "infinite:analytics-consent-change", detail: { granted: true } });')
  await browser.advance(0)
  expect(browser.evaluate('window.infiniteMetaClickId()')).not.toBe("")
  browser.window.__infiniteConsentAllowed = () => false
  expect(browser.evaluate('window.infiniteMetaClickId()')).toBe("")
})

it.each([false, true])("requires a recorded gesture even when the clock is zero (runtime: %s)", async withRuntime => {
  const browser = createBrowserVm({ url: "https://example.test/?fbclid=clockZero", now: 0 })
  browser.runScript(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "required" } }))
  if (withRuntime) browser.runHtml(renderInfiniteBrowserTag({ siteSourceKey: "site_fixture_key", collectPath: "/infinite/ledger", respectDnt: true, consent: { mode: "required", storageKey: "infinite_analytics_consent" }, productionHosts: ["example.test"] }))
  browser.runScript('window.dispatchEvent({ type: "infinite:analytics-consent-change", detail: { granted: true } });')
  await browser.advance(0)
  expect(browser.cookies.values("_fbc")).toEqual([])
  expect(browser.localValues.get("infinite_analytics_consent")).not.toBe("granted")
  browser.runScript('window.dispatchEvent({ type: "pointerdown" }); window.dispatchEvent({ type: "infinite:analytics-consent-change", detail: { granted: true } });')
  await browser.advance(0)
  expect(browser.localValues.get("infinite_analytics_consent")).toBe("granted")
})

it("a new Meta-only install obeys required mode without an Infinite artifact", async () => {
  const root = makeSite({ "index.html": "<html><head></head><body>Example</body></html>" })
  const keys = notConnectedKeys()
  keys.meta = fakeKeys().meta
  const hosting = { provider: "none" as const, vercel: null }
  const subject = new WizardInstaller({ root, repoFingerprint: IDS.fingerprint, runId: () => IDS.run, agent: () => null, consentFlag: () => "required", productionDeniedConflict: fakeProductionDeniedConflict })
  const scan = await subject.scan({ root, hosting })
  const plan = subject.buildPlan(scan, keys, fakeBefore({ keys, hosting }), [])
  const result = await subject.apply(plan, { approved: [], declined: [], edits: { consent_mode: "required" } })
  expect(result.ok).toBe(true)
  expect(result.artifacts.infinite).toBeUndefined()
  expect(result.artifacts.meta).toBeDefined()
  const browser = createBrowserVm({ url: "https://acme-store.com/?fbclid=metaOnly" })
  browser.window.CustomEvent = class { constructor(public type: string, public init: { detail: unknown }) {} get detail() { return this.init.detail } }
  browser.runHtml(read(root, "index.html"))
  expect(browser.scriptErrors).toEqual([])
  expect(browser.cookies.writes).toEqual([])
  browser.runScript('window.dispatchEvent({ type: "pointerdown", isTrusted: true });')
  browser.runScript(CONSENT_YES)
  await browser.advance(0)
  expect(browser.cookies.values("_fbc")).toHaveLength(1)
  const ctx = fakeContext({ root })
  ctx.state.update(state => { state.plan = { hash: plan.hash, lines: [], answers: { consentMode: "required", conversions: [], privacyApproved: null, npmInstall: null, metaGoal: null } } })
  expect(await consentActivationFor(ctx, { fs: nodeWizardFs })).toEqual({ mode: "required", infinite: false, capture: true })
})

it("emits lintable standalone JavaScript without disabling customer rules", async () => {
  const site = await installed()
  const require = createRequire(import.meta.url)
  const { Linter } = require("eslint")
  const recommended = require("@eslint/js").configs.recommended.rules
  const messages = new Linter().verify(site.proof.browserCode, [{ languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: Object.fromEntries(["window", "document", "location", "navigator", "localStorage", "URLSearchParams", "setTimeout"].map(name => [name, "readonly"])) }, rules: { ...recommended, "no-var": "error", "prefer-const": "error", "no-unused-expressions": "error" } }])
  expect(messages).toEqual([])
})

it("retains last-click and cookie-shadow cleanup behavior in the standalone module", async () => {
  const site = await installed()
  const browser = createBrowserVm({ url: "https://www.example.test/?fbclid=newClick", cookies: ["_fbc=fb.2.1000000000000.old;path=/", "_fbc=fb.2.1000000000000.shadow;domain=www.example.test;path=/", "_fbc=fb.1.1000000000000.older;domain=example.test;path=/"] })
  browser.window.__infiniteConsentAllowed = () => true
  browser.runScript(site.proof.browserCode)
  expect(browser.scriptErrors).toEqual([])
  expect(browser.cookies.values("_fbc")).toEqual([expect.stringMatching(/^fb\.1\.\d+\.newClick$/)])
})

it.each([false, [], ["./other.js"]])("refuses a package configuration that may drop the side-effect import (%j)", async sideEffects => {
  const root = makeSite({ ...files, "package.json": JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" }, sideEffects }) })
  const subject = new WizardInstaller({ root, repoFingerprint: IDS.fingerprint, runId: () => IDS.run, agent: () => null, consentFlag: () => "required", productionDeniedConflict: fakeProductionDeniedConflict })
  const scan = await subject.scan({ root })
  expect(scan.managedCapture).toMatchObject({ canWire: false, requirements: [expect.objectContaining({ ownerBoundary: { kind: "unproven_wiring", file: "pages/_app.tsx", line: 1 } })] })
})

it("does not prove a missing, late, changed or disconnected capture module", async () => {
  const site = await installed()
  const entry = read(site.root, site.entry)
  writeFileSync(join(site.root, site.entry), entry.split("\n").slice(1).join("\n") + "\n" + entry.split("\n")[0])
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
  writeFileSync(join(site.root, site.entry), entry)
  writeFileSync(join(site.root, site.proof.record.module), site.proof.browserCode.replace("return false;", "return true;"))
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
  writeFileSync(join(site.root, site.proof.record.module), site.proof.browserCode)
  rmSync(join(site.root, site.pixelFile))
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
})

it("does not prove a shadowed Script alias or a head in an uncalled helper", async () => {
  const site = await installed("next-app-router")
  const entry = read(site.root, site.entry)
  writeFileSync(join(site.root, site.entry), entry.replace("RootLayout({children})", "RootLayout({children, InfiniteMetaCaptureScript})"))
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
  writeFileSync(join(site.root, site.entry), entry.replace("export default function RootLayout", "function UncalledLayout") + "\nexport default function RootLayout(){ return null; }\n")
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
})

it("does not prove capture order when a native script precedes the fixed HTML head", async () => {
  const site = await installed("static-html")
  const entry = read(site.root, site.entry)
  writeFileSync(join(site.root, site.entry), '<script src="/assets/pixel.js"></script>\n' + entry)
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
  const scan = await site.subject.scan({ root: site.root })
  expect(scan.managedCapture?.canWire).toBe(false)
})

it("does not infer Next module order for a pixel emitted as a native script", async () => {
  const site = await installed("next-app-router")
  writeFileSync(join(site.root, site.pixelFile), 'export default function Pixel(){ return <script>{`fbq("init","7777000011112222");`}</script>; }\n')
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
  const scan = await site.subject.scan({ root: site.root })
  expect(scan.managedCapture?.canWire).toBe(false)
})

it("uses a valid owner-added loader in a frozen entry without editing that entry", async () => {
  const entry = 'import "../lib/infinite-meta-click-id.js"\n' + files["pages/_app.tsx"] + "\nconst OWNER_MODE = { analytics_storage: 'denied' };\ngtag('consent', 'default', OWNER_MODE);\n"
  const root = makeSite({ ...files, "pages/_app.tsx": entry })
  const subject = new WizardInstaller({ root, repoFingerprint: IDS.fingerprint, runId: () => IDS.run, agent: () => null, consentFlag: () => "required", productionDeniedConflict: fakeProductionDeniedConflict })
  const scan = await subject.scan({ root, hosting: fakeHosting() })
  const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
  expect(scan.managedCapture).toMatchObject({ canWire: true, entrypoints: ["pages/_app.tsx"], editEntrypoints: [] })
  const result = await subject.apply(plan, { approved: [], declined: [], edits: { consent_mode: "required" } })
  expect(result.ok, result.reason ?? "").toBe(true)
  expect(result.changedFiles).toContain("lib/infinite-meta-click-id.js")
  expect(result.changedFiles).not.toContain("pages/_app.tsx")
  expect(read(root, "pages/_app.tsx")).toBe(entry)
  expect(read(root, "src/pixel.ts")).toBe(pixel)
  expect(await readManagedCapture(root, nodeWizardFs.readText)).not.toBeNull()
})

it("accepts a simple const before the unconditional root layout return", async () => {
  const site = await installed("next-app-router")
  const entry = read(site.root, site.entry)
  writeFileSync(join(site.root, site.entry), entry.replace("{ return <html>", '{ const title = "Example"; return <html>'))
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).not.toBeNull()
})

it("keeps an existing wrong cookie writer as a problem despite the managed module", async () => {
  const site = await installed()
  writeFileSync(join(site.root, site.pixelFile), site.source + '\ndocument.cookie = "_fbc=fb.1.1234567890000.old;path=/";\n')
  const item = candidate("meta_improve", "capture", { owner: "code", allow: { files: site.proof.record.entrypoints, create: [site.proof.record.module] } })
  const result = await o9CheckFunctions({ root: site.root, version: "fixture" }).click_id_capture({ item, root: site.root, appRoot: "." }, { runId: IDS.run, now: () => new Date("2026-10-07T00:00:00Z") })
  expect(result).toEqual([expect.objectContaining({ state: "problem", reason: expect.stringContaining("host-only") })])
})

it.each([
  ["next-app-router", "next.config.js", 'module.exports = { basePath: "/shop" };\n'],
  ["vite-react", "vite.config.js", 'export default { publicDir: "assets" };\n']
])("refuses an uncertain public-asset mapping for %s", async (framework, config, source) => {
  const site = await installed(framework!)
  writeFileSync(join(site.root, config!), source!)
  expect(await readManagedCapture(site.root, nodeWizardFs.readText)).toBeNull()
  const scan = await site.subject.scan({ root: site.root })
  expect(scan.managedCapture).toMatchObject({ canWire: false, requirements: [expect.objectContaining({ reason: expect.stringContaining("public-asset") })] })
})
