import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { cleanup, item, makeFenceFixture, tempDir, write } from "../../test/wizard/repo.js"
import { Fence } from "../agents/fence.js"
import { ownerWiringRequirement } from "../frameworks/owner-boundary.js"
import { recognizedConsentHandling } from "../install/consent-handoff.js"
import { measureOwnerDiff } from "./owner-diff.js"
import { scopeOwnerJob } from "./owner-scope.js"

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))
const path = "src/consentController.ts"
const before = "export const enabled = true;\nexport const label = 'ready';\n"
const after = before.replace("true", "false")

it("keeps named consent files in the owner-only installer and planning boundary", () => {
  expect(ownerWiringRequirement(path, before, after, "added wiring")).toMatchObject({ path, ownerBoundary: { kind: "frozen_unit", line: 1 } })
  expect(scopeOwnerJob(item("preview_guard:meta", [path]), new Map([[path, before]]))).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "frozen_unit", file: path } })
  expect(recognizedConsentHandling({ [path]: before })).toBe(true)
})

it.each([true, false])("restores named consent files in the worker fence (claim: %s)", async claim => {
  const { root } = makeFenceFixture()
  const home = tempDir("named-boundary-")
  dirs.push(root, home)
  write(root, path, before)
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "boundary", turn: 1, items: [item("preview_guard:meta", [path])] })
  write(root, path, after)
  fence.recordEditActivity("preview_guard:meta", path)
  if (claim) expect((await fence.claimConsentProblems("preview_guard:meta")).join(" ")).toContain("your change there was put back")
  expect((await fence.end()).blocked).toContainEqual(expect.objectContaining({ reason: "consent_touched" }))
  expect(readFileSync(join(root, path), "utf8")).toBe(before)
})

it.each([false, true])("measures a named consent file edit as protected (committed: %s)", async commit => {
  const fixture = createGitFixture({ files: { [path]: before } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write(path, after)
    if (commit) { fixture.git(["add", path]); fixture.git(["commit", "-qm", "edit source"]) }
    const revision = commit ? fixture.git(["rev-parse", "HEAD"]).trim() : undefined
    expect(await measureOwnerDiff({ root: fixture.root, baseSha, revision })).toMatchObject({ state: "changed", issues: [expect.objectContaining({ file: path })] })
  } finally { fixture.cleanup() }
})
