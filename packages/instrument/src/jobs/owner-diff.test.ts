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

it.each(["liquid",])("measures consent changes in %s templates like the fence", async extension => {
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

it("does not report a pass when the wizard commit record is empty", async () => {
  const wizardCommits: string[] = []
  const fixture = createGitFixture({ files: { "tracking.ts": "export const count = 1;\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("tracking.ts", "export const count = 2;\n")
    fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "older run fixture"])
    const headSha = fixture.git(["rev-parse", "HEAD"]).trim()
    const result = await measureWizardCommits({ root: fixture.root, baseSha, headSha, wizardCommits })
    expect(result.state).toBe("not_checked")
    expect(result.unverifiedReason).toMatch(/record|no wizard commits/i)
    expect(result.measuredCommitCount).toBe(0)
    expect(result.files).toContain("tracking.ts")
  } finally { fixture.cleanup() }
})

it.each(["amended",])("retains an explicit unverified result for a %s wizard SHA", async mode => {
  const fixture = createGitFixture({ files: { "tracking.ts": "export const count = 1;\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("tracking.ts", "export const count = 2;\n")
    fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "wizard fixture"])
    const wizardSha = fixture.git(["rev-parse", "HEAD"]).trim()
    if (mode === "squashed") {
      fixture.write("tracking.ts", "export const count = 3;\n")
      fixture.git(["add", "tracking.ts"]); fixture.git(["commit", "-m", "second wizard fixture"])
      fixture.git(["reset", "--soft", baseSha]); fixture.git(["commit", "-m", "owner squashed fixture"])
    } else fixture.git(["commit", "--amend", "-m", "owner amended fixture"])
    const headSha = fixture.git(["rev-parse", "HEAD"]).trim()
    const result = await measureWizardCommits({ root: fixture.root, baseSha, headSha, wizardCommits: [mode === "missing" ? "f".repeat(40) : wizardSha] })
    expect(result.state).toBe("not_checked")
    expect(result.unverifiedReason).toMatch(mode === "missing" ? /unavailable|missing|no longer exists/ : /amended|squashed|reachable/)
    expect(result.measuredCommitCount).toBe(0)
    expect(result.files).toContain("tracking.ts")
  } finally { fixture.cleanup() }
})

it("measures a changed component without following its policy-page imports or the current working tree", async () => {
  const fixture = createGitFixture({ files: { "app/privacy/page.tsx": 'import Content from "../../components/Content"; export default Content;\n', "components/Content.tsx": "export default function Content(){return <p>Original policy</p>}\n" } })
  try {
    const baseSha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("components/Content.tsx", "export default function Content(){return <p>Changed policy</p>}\n")
    fixture.git(["add", "components/Content.tsx"]); fixture.git(["commit", "-m", "wizard component fixture"])
    const revision = fixture.git(["rev-parse", "HEAD"]).trim()
    // An uncommitted page edit is outside this historical commit measurement.
    fixture.write("app/privacy/page.tsx", "export default function Page(){return null}\n")
    const measured = await measureOwnerDiff({ root: fixture.root, baseSha, revision })
    expect(measured.state).toBe("checked")
    expect(measured.files).toEqual(["components/Content.tsx"])
    expect(measured.issues).toEqual([])
  } finally { fixture.cleanup() }
})
