import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { fakeBefore, fakeHosting, fakeKeys, fakeProductionDeniedConflict, IDS } from "../../test/wizard/o7-fakes.js"
import { readInstallManifest, computeContentHash } from "../manifest.js"
import { planNextConfigProxy } from "../frameworks/vercel-config.js"
import { uninstallInstallation } from "../uninstall.js"
import { WizardInstaller } from "./installer.js"
import { makeEditRecord } from "./edits.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8")
const subject = (root: string) => new WizardInstaller({ root, repoFingerprint: IDS.fingerprint, runId: () => IDS.run, agent: () => null, consentFlag: () => "not_required", productionDeniedConflict: fakeProductionDeniedConflict, build: async () => ({ ok: true, failureSignature: [], durationMs: 1 }) })

async function installed() {
  const fx = createGitFixture({ files: {
    ".gitignore": "node_modules/\n.infinite/wizard/\n",
    "package.json": '{"dependencies":{"next":"15.0.0","react":"19.0.0","posthog-js":"1.0.0"}}',
    "app/layout.tsx": 'import { Providers } from "./providers";\nexport default function Layout({children}) { return <html><body><Providers>{children}</Providers></body></html> }\n',
    "app/providers.tsx": `"use client";\nimport posthog from "posthog-js";\nposthog.init("${IDS.posthog}", { api_host: "https://us.i.posthog.com" });\nexport function Providers({children}) { return children; }\n`
  } }); fixtures.push(fx)
  const installer = subject(fx.root)
  const plan = installer.buildPlan(await installer.scan({ root: fx.root, hosting: fakeHosting() }), fakeKeys(), fakeBefore(), [])
  const approvals = { approved: plan.lines.filter(line => line.requires === "approval").map(line => line.id), declined: [], edits: { consent_mode: "not_required" } }
  expect(await installer.apply(plan, approvals)).toMatchObject({ ok: true })
  const before = read(fx.root, "next.config.mjs")
  expect(before).not.toContain('source: "/ingest/:path*"')
  fx.git(["add", "-A"]); fx.git(["commit", "-m", "wizard install fixture"])
  const after = before.replace("return [", 'return [\n      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },')
  expect(after).not.toBe(before)
  const edit = makeEditRecord({ file: "next.config.mjs", before, after, by: "agent", runId: IDS.run, jobId: "posthog_improve:proxy", planLineId: null })
  fx.write(edit.file, after)
  await installer.recordEdits([edit])
  fx.git(["add", edit.file, ".infinite/install.json"]); fx.git(["commit", "-m", "verified agent proxy fixture"])
  return { fx, approvals, before, after }
}

it("resumes an exact recorded agent extension without re-emitting it or changing the reversal anchor", async () => {
  const w = await installed()
  const resumed = subject(w.fx.root)
  const plan = resumed.buildPlan(await resumed.scan({ root: w.fx.root, hosting: fakeHosting() }), fakeKeys(), fakeBefore(), [])
  expect(await resumed.refreshManaged(plan, w.approvals)).toEqual({ changedFiles: [], blocked: [] })
  expect(read(w.fx.root, "next.config.mjs")).toBe(w.after)
  expect(readInstallManifest(w.fx.root)!.configOwnership!["next.config.mjs"]).toMatchObject({ kind: "created", installedHash: computeContentHash(w.before) })
  expect(w.fx.git(["status", "--porcelain", "--untracked-files=no"])).toBe("")
})

it.each(["unrecorded owner edit", "unrecorded owner revert", "broken recorded chain", "invalid recorded text edit", "unrecorded edit with refreshed content hash"])("does not accept %s as generated ownership", async mode => {
  const w = await installed()
  const receipt = readInstallManifest(w.fx.root)!
  if (mode === "broken recorded chain") {
    receipt.edits!.find(edit => edit.file === "next.config.mjs")!.beforeHash = `sha256:${"f".repeat(64)}`
    writeFileSync(join(w.fx.root, ".infinite/install.json"), JSON.stringify(receipt))
  } else if (mode === "invalid recorded text edit") {
    receipt.edits!.find(edit => edit.file === "next.config.mjs")!.textEdits[0]!.inserted = "not the recorded insertion"
    writeFileSync(join(w.fx.root, ".infinite/install.json"), JSON.stringify(receipt))
  } else w.fx.write("next.config.mjs", mode === "unrecorded owner revert" ? w.before : `${w.after}\n// Owner change, not recorded by the wizard\n`)
  const bytes = read(w.fx.root, "next.config.mjs")
  if (mode === "unrecorded edit with refreshed content hash") receipt.contentHashes["next.config.mjs"] = computeContentHash(bytes)
  const plan = planNextConfigProxy(w.fx.root, { infinite: { path: "/infinite/ledger", destination: "https://example.test/collect" } }, receipt.configOwnership, { deferUnmanaged: true, previousManifest: receipt })
  expect(plan.blockers).toEqual([expect.stringContaining("ownership hash")])
  expect(read(w.fx.root, "next.config.mjs")).toBe(bytes)
})

it("follows every exact edit in the chain back to the original config anchor", async () => {
  const w = await installed()
  const afterSecond = `${w.after}\n// Second verified edit\n`
  w.fx.write("next.config.mjs", afterSecond)
  await subject(w.fx.root).recordEdits([makeEditRecord({ file: "next.config.mjs", before: w.after, after: afterSecond, by: "agent", runId: IDS.run, jobId: "setup_check_fixes:config", planLineId: null, seq: 1 })])
  w.fx.git(["add", "next.config.mjs", ".infinite/install.json"]); w.fx.git(["commit", "-m", "second verified fixture edit"])
  const resumed = subject(w.fx.root)
  const plan = resumed.buildPlan(await resumed.scan({ root: w.fx.root, hosting: fakeHosting() }), fakeKeys(), fakeBefore(), [])
  expect(await resumed.refreshManaged(plan, w.approvals)).toEqual({ changedFiles: [], blocked: [] })
  expect(read(w.fx.root, "next.config.mjs")).toBe(afterSecond)
})

it("still reverses the recorded extension and removes the original hash-owned config on uninstall", async () => {
  const w = await installed()
  const result = uninstallInstallation({ root: w.fx.root, dryRun: false, allowDirty: true })
  expect(result.editsLeftAsIs ?? []).not.toContain("next.config.mjs")
  expect(result.removedFiles).toContain("next.config.mjs")
  expect(existsSync(join(w.fx.root, "next.config.mjs"))).toBe(false)
})
