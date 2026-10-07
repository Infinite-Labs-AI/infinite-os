import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { generatedApiTexts, recordGeneratedApi } from "../jobs/generated-api.js"
import { measureOwnerDiff } from "../jobs/owner-diff.js"
import { renderServerLaneBrief, SERVER_LANE_GUIDE_FILE } from "./copy.js"
import { applyServerLane, planServerLane } from "./install.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })

function fixture() {
  const fx = createGitFixture({ files: { "README.md": "# Fixture\n", ".gitignore": ".infinite/\n" } })
  fixtures.push(fx)
  return fx
}

function writeGuide(fx: GitFixture, appRoot = ".") {
  mkdirSync(join(fx.root, appRoot), { recursive: true })
  const plan = planServerLane({ root: fx.root, appRoot, appRootAbsolute: join(fx.root, appRoot), framework: "next-app-router", previousManifest: null })
  const applied = applyServerLane({ root: fx.root, appRoot, framework: "next-app-router", plan, artifacts: { infinite: { siteSourceKey: "site_fixture", collectPath: "/infinite/collect", productionHosts: ["example.test"], consentMode: "not_required" } }, previousManifest: null })
  const file = appRoot === "." ? SERVER_LANE_GUIDE_FILE : `${appRoot}/${SERVER_LANE_GUIDE_FILE}`
  expect(readFileSync(join(fx.root, file), "utf8")).toBe(applied.brief)
  return { file, text: applied.brief }
}

it.each([".", "apps/site"])("measures the actual generated guide before and after commit at app root %s", async appRoot => {
  const fx = fixture()
  const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
  const guide = writeGuide(fx, appRoot)
  expect((await measureOwnerDiff({ root: fx.root, baseSha, appRoot })).state).toBe("checked")
  expect(generatedApiTexts(fx.root, guide.file)).toContain(guide.text)
  fx.git(["add", "-A"]); fx.git(["commit", "-m", "generated guide fixture"])
  const revision = fx.git(["rev-parse", "HEAD"]).trim()
  expect((await measureOwnerDiff({ root: fx.root, baseSha, appRoot, revision })).state).toBe("checked")
})

it("does not trust a copied guide from its managed banner or path", async () => {
  const fx = fixture()
  const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
  const guide = renderServerLaneBrief({ status: { kind: "created", middlewarePath: "middleware.ts", modulePath: "lib/infinite-server-lane.ts" }, siteSourceKey: "site_fixture", productionHosts: ["example.test"] })
  fx.write(SERVER_LANE_GUIDE_FILE, guide)
  expect(generatedApiTexts(fx.root, SERVER_LANE_GUIDE_FILE)).toEqual([])
  expect((await measureOwnerDiff({ root: fx.root, baseSha })).issues).toContainEqual(expect.objectContaining({ file: SERVER_LANE_GUIDE_FILE }))
})

it("refuses an API write appended to the recorded generated guide", async () => {
  const fx = fixture()
  const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
  const guide = writeGuide(fx)
  fx.write(guide.file, `${guide.text}\nwindow.fbq = () => undefined;\n`)
  expect((await measureOwnerDiff({ root: fx.root, baseSha })).issues).toContainEqual(expect.objectContaining({ file: guide.file }))
})

it("keeps policy paths protected even when their bytes have generated provenance", async () => {
  const fx = fixture()
  const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
  const guide = writeGuide(fx)
  const policy = "docs/privacy.md"
  recordGeneratedApi(fx.root, policy, guide.text)
  fx.write(policy, guide.text)
  expect((await measureOwnerDiff({ root: fx.root, baseSha })).issues).toContainEqual(expect.objectContaining({ file: policy, reason: expect.stringContaining("policy page") }))
})
