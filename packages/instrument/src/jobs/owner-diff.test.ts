import { readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { measureOwnerDiff, measureWizardCommits, ownerBoundaryStop } from "./owner-diff.js"

it("measures actual base-to-working and base-to-commit units, with a named stop and no repair of owner bytes", async () => {
  const fixture = createGitFixture({ files: { "tracking.ts": "function boot(){\n fbq?.('consent','revoke');\n}\nfunction safe(){return 1;}\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("tracking.ts", "function boot(){\n return;\n fbq?.('consent','revoke');\n}\nfunction safe(){return 2;}\n")
    const measurement = await measureOwnerDiff({ root: fixture.root, baseSha })
    expect(measurement.state).toBe("changed")
    expect(ownerBoundaryStop(measurement)).toContain("tracking.ts")
    expect(readFileSync(join(fixture.root, "tracking.ts"), "utf8")).toContain(" return;")
    fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "fixture owner edit"])
    expect((await measureOwnerDiff({ root: fixture.root, baseSha, revision: fixture.git(["rev-parse", "HEAD"]).trim() })).state).toBe("changed")
  } finally { fixture.cleanup() }
})

it("allows edited neighboring units and rejects routed policy deletion while allowing terms utilities", async () => {
  const fixture = createGitFixture({ files: { "tracking.ts": "function boot(){fbq('consent','grant');}\nfunction safe(){return 1;}\n", "pages/terms.tsx": "export default function Terms(){return null;}\n", "src/search/terms.ts": "export const terms = 1;\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("tracking.ts", "function boot(){fbq('consent','grant');}\nfunction safe(){return 2;}\n")
    fixture.write("src/search/terms.ts", "export const terms = 2;\n")
    expect((await measureOwnerDiff({ root: fixture.root, baseSha })).state).toBe("checked")
    fixture.git(["rm", "pages/terms.tsx"])
    expect((await measureOwnerDiff({ root: fixture.root, baseSha })).issues).toEqual([expect.objectContaining({ file: "pages/terms.tsx" })])
  } finally { fixture.cleanup() }
})

it("refuses a committed source symlink without treating its target text as measured source", async () => {
  const fixture = createGitFixture({ files: { "tracking.ts": "export const safe = 1;\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    rmSync(join(fixture.root, "tracking.ts"))
    symlinkSync("other.ts", join(fixture.root, "tracking.ts"))
    fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "fixture symlink"])
    const measured = await measureOwnerDiff({ root: fixture.root, baseSha, revision: fixture.git(["rev-parse", "HEAD"]).trim() })
    expect(measured.state).toBe("not_checked")
    expect(measured.issues).toEqual([{ file: "tracking.ts", reason: "the source tree entry is not a regular file" }])
  } finally { fixture.cleanup() }
})

it("distinguishes an unreadable committed blob from an absent source file", async () => {
  const fixture = createGitFixture({ files: { "tracking.ts": "export const safe = 1;\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("tracking.ts", "export const safe = 2;\n")
    fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "fixture unreadable blob"])
    const revision = fixture.git(["rev-parse", "HEAD"]).trim()
    const blob = fixture.git(["rev-parse", "HEAD:tracking.ts"]).trim()
    rmSync(join(fixture.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
    const measured = await measureOwnerDiff({ root: fixture.root, baseSha, revision })
    expect(measured.state).toBe("not_checked")
    expect(measured.issues).toEqual([{ file: "tracking.ts", reason: "an existing source blob could not be read" }])
  } finally { fixture.cleanup() }
})

it.each(["liquid", "php", "ejs", "njk"])("measures consent changes in %s templates like the fence", async extension => {
  const path = `view.${extension}`
  const fixture = createGitFixture({ files: { [path]: "fbq('consent','revoke');\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write(path, "fbq('consent','grant');\n")
    expect((await measureOwnerDiff({ root: fixture.root, baseSha })).state).toBe("changed")
  } finally { fixture.cleanup() }
})

it("still measures a recorded reachable wizard commit when the base has advanced over it", async () => {
  const fixture = createGitFixture({ files: { "tracking.ts": "fbq('consent','revoke');\n" } })
  try {
    fixture.write("tracking.ts", "fbq('consent','grant');\n")
    fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "unsafe wizard fixture"])
    const sha = fixture.git(["rev-parse", "HEAD"]).trim()
    expect((await measureWizardCommits({ root: fixture.root, baseSha: sha, headSha: sha, wizardCommits: [sha] })).state).toBe("changed")
  } finally { fixture.cleanup() }
})
