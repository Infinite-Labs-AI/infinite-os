import { mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { expect, it } from "vitest"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { createGitOps } from "../git/index.js"
import { BaselineUnavailableError, baselineTree } from "./baseline-tree.js"

it("retakes on the recorded base after HEAD advanced, with installed dependencies available", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base bytes\n", ".gitignore": "node_modules\n" } })
  try {
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("source.ts", "later committed bytes\n")
    fixture.git(["add", "source.ts"])
    fixture.git(["commit", "-m", "fixture advance"])
    mkdirSync(join(fixture.root, "node_modules"))
    writeFileSync(join(fixture.root, "node_modules/fixture"), "installed")
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", base, git)
    try {
      expect(readFileSync(join(tree.root, "source.ts"), "utf8")).toBe("base bytes\n")
      expect(lstatSync(join(tree.root, "node_modules")).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(tree.root, "node_modules/fixture"), "utf8")).toBe("installed")
      expect(readFileSync(join(fixture.root, "source.ts"), "utf8")).toBe("later committed bytes\n")
    } finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})


it("workspace package resolution reads GREEN BASE, never the edited workspace through node_modules", async () => {
  const fixture = createGitFixture({ files: { "packages/shared/index.js": "GREEN BASE", ".gitignore": "node_modules\n" } })
  try {
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("packages/shared/index.js", "REGRESSION IN EDITED HEAD")
    mkdirSync(join(fixture.root, "node_modules/@site"), { recursive: true })
    symlinkSync("../../packages/shared", join(fixture.root, "node_modules/@site/shared"))
    fixture.write("node_modules/dependency/index.js", "installed dependency")
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", base, git)
    try {
      expect(readFileSync(join(tree.root, "node_modules/@site/shared/index.js"), "utf8")).toBe("GREEN BASE")
      expect(readFileSync(join(tree.root, "node_modules/dependency/index.js"), "utf8")).toBe("installed dependency")
      expect(lstatSync(join(tree.root, "node_modules")).isSymbolicLink()).toBe(false)
      // Copies cannot let the baseline's build mutate the live installation's dependency bytes.
      writeFileSync(join(tree.root, "node_modules/dependency/index.js"), "baseline cache change")
      expect(readFileSync(join(fixture.root, "node_modules/dependency/index.js"), "utf8")).toBe("installed dependency")
    } finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})


it("copies the PnP loader so its relative workspace imports use base source", async () => {
  const fixture = createGitFixture({ files: { "packages/shared/index.cjs": 'module.exports = "GREEN BASE"', ".gitignore": ".pnp.cjs\n" } })
  try {
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("packages/shared/index.cjs", 'module.exports = "EDITED HEAD"')
    fixture.write(".pnp.cjs", 'module.exports = require("./packages/shared/index.cjs")')
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", base, git)
    try {
      expect(lstatSync(join(tree.root, ".pnp.cjs")).isSymbolicLink()).toBe(false)
      expect(createRequire(import.meta.url)(join(tree.root, ".pnp.cjs"))).toBe("GREEN BASE")
    } finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})

it("declines unsafe external source links instead of measuring the edited dependency", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base", ".gitignore": "node_modules\n" } })
  try {
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    mkdirSync(join(fixture.root, "node_modules"))
    mkdirSync(join(fixture.dir, "external-source"))
    symlinkSync(join(fixture.dir, "external-source"), join(fixture.root, "node_modules/linked"))
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    await expect(baselineTree(fixture.root, ".", base, git)).rejects.toBeInstanceOf(BaselineUnavailableError)
    expect(fixture.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1)
  } finally { fixture.cleanup() }
})
