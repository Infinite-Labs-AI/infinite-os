import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { measureOwnerDiff } from "./owner-diff.js"

it("limits working-tree measurement to selected paths and keeps commit measurement complete", async () => {
  const fx = createGitFixture({ files: { "src/ordinary.ts": "export const count = 1;\n", "assets/logo.png": "old image" } })
  try {
    const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
    fx.write("src/ordinary.ts", "export const count = 2;\n")
    writeFileSync(join(fx.root, "assets/logo.png"), Buffer.from([0, 255, 128]))
    expect(await measureOwnerDiff({ root: fx.root, baseSha, paths: ["src/ordinary.ts"] })).toMatchObject({ state: "checked", files: ["src/ordinary.ts"], issues: [] })
    expect(await measureOwnerDiff({ root: fx.root, baseSha, paths: [] })).toMatchObject({ state: "checked", files: [], issues: [] })
    expect(await measureOwnerDiff({ root: fx.root, baseSha, paths: ["assets/logo.png"] })).toMatchObject({ state: "not_checked", files: ["assets/logo.png"] })
    fx.git(["add", "src/ordinary.ts", "assets/logo.png"]); fx.git(["commit", "-m", "binary and source fixture"])
    const revision = fx.git(["rev-parse", "HEAD"]).trim()
    expect(await measureOwnerDiff({ root: fx.root, baseSha, revision, paths: [] })).toMatchObject({ state: "not_checked", files: ["assets/logo.png", "src/ordinary.ts"] })
  } finally { fx.cleanup() }
})

it.each([
  { name: "NUL bytes", file: "vendor/lib.min.js", bytes: Buffer.from([0, 255, 128]) },
])("names only the changed file when $name cannot be decoded", async ({ file, bytes }) => {
  const fx = createGitFixture({ files: { "src/ordinary.ts": "export const count = 1;\n", [file]: "Original UTF-8 source\n" } })
  try {
    const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
    writeFileSync(join(fx.root, file), bytes)
    const working = await measureOwnerDiff({ root: fx.root, baseSha })
    expect(working).toMatchObject({ state: "not_checked", files: [file], issues: [{ file, reason: "the changed source could not be decoded" }] })
    fx.git(["add", file]); fx.git(["commit", "-m", "changed encoded fixture"])
    const committed = await measureOwnerDiff({ root: fx.root, baseSha, revision: fx.git(["rev-parse", "HEAD"]).trim() })
    expect(committed).toMatchObject({ state: "not_checked", files: [file], issues: [{ file, reason: "the changed source could not be decoded" }] })
  } finally { fx.cleanup() }
})

