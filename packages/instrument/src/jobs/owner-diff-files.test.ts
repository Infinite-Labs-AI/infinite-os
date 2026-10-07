import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
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
  { name: "Latin-1", file: "legacy/about-us.html", bytes: Buffer.from("<p>caf\u00e9</p>", "latin1") },
  { name: "UTF-16", file: "notes/readme.md", bytes: Buffer.from("# Notes\n", "utf16le") },
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

it("measures one changed file in a 15000-file source tree in milliseconds", async () => {
  const fx = createGitFixture({ files: { "src/ordinary.ts": "export const count = 1;\n" } })
  try {
    for (let i = 0; i < 14_999; i++) {
      const path = join(fx.root, "src", "unchanged", `module-${i}.ts`)
      if (i === 0) mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `export const value${i} = ${i};\n`)
    }
    fx.git(["add", "src/unchanged"]); fx.git(["commit", "-m", "large unchanged source tree"])
    const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
    fx.write("src/ordinary.ts", "export const count = 2;\n")
    const started = performance.now()
    const measured = await measureOwnerDiff({ root: fx.root, baseSha })
    const elapsedMs = performance.now() - started
    console.log(`One-file measurement in a 15000-file tree: ${elapsedMs.toFixed(1)} ms`)
    expect(measured).toMatchObject({ state: "checked", files: ["src/ordinary.ts"], issues: [] })
    expect(elapsedMs).toBeLessThan(1500)
    fx.git(["add", "src/ordinary.ts"]); fx.git(["commit", "-m", "one changed file in large tree"])
    const revision = fx.git(["rev-parse", "HEAD"]).trim()
    const commitStarted = performance.now()
    const committed = await measureOwnerDiff({ root: fx.root, baseSha, revision })
    const commitElapsedMs = performance.now() - commitStarted
    console.log(`Committed-file measurement in a 15000-file tree: ${commitElapsedMs.toFixed(1)} ms`)
    expect(committed).toMatchObject({ state: "checked", files: ["src/ordinary.ts"], issues: [] })
    expect(commitElapsedMs).toBeLessThan(1500)
  } finally { fx.cleanup() }
}, 30_000)
