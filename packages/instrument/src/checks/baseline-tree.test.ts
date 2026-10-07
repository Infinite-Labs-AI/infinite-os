import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { expect, it } from "vitest"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { markBaseline } from "../git/baseline-ownership.js"
import { createGitOps } from "../git/index.js"
import { BaselineUnavailableError, baselineTree, sweepBaselineTrees } from "./baseline-tree.js"

it("R6 sweeps only dead owned baseline worktrees and removes their registrations", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base" } })
  try {
    const sha = fixture.git(["rev-parse", "HEAD"]).trim()
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const stale = await git.worktreeAddDetached(sha, "baseline")
    const active = await git.worktreeAddDetached(sha, "baseline")
    const review = await git.worktreeAddDetached(sha)
    unlinkSync(`${stale.dir}.baseline.json`)
    markBaseline(join(fixture.dir, "worktrees"), stale.dir, fixture.root, 2147483647)
    await sweepBaselineTrees(fixture.root, git)
    expect(existsSync(stale.dir)).toBe(false)
    expect(existsSync(`${stale.dir}.baseline.json`)).toBe(false)
    expect(existsSync(active.dir)).toBe(true)
    expect(existsSync(review.dir)).toBe(true)
    expect(await git.worktreeList!()).not.toContain(stale.dir)
    await git.worktreeRemove(active.dir)
    await git.worktreeRemove(review.dir)
  } finally { fixture.cleanup() }
})

it("R6 uses the clean recorded base in place, including ignored environment files", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base", ".gitignore": ".env.local\nnode_modules\n" } })
  try {
    fixture.write(".env.local", "PRIVATE_FIXTURE=present\n")
    fixture.write(".infinite/wizard/state.json", "{}")
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", base, git)
    expect(tree.root).toBe(fixture.root)
    await tree.dispose()
    expect(fixture.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1)
  } finally { fixture.cleanup() }
})

it("R6 preserves ignored environment reads and isolates ordinary dependency caches", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base", ".gitignore": ".env.local\nnode_modules\n" } })
  try {
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("source.ts", "edited")
    fixture.write(".env.local", "FIXTURE_VALUE=private-fixture-only\n")
    fixture.write("node_modules/.cache/fixture", "user cache")
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", base, git)
    try {
      expect(lstatSync(join(tree.root, ".env.local")).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(tree.root, ".env.local"), "utf8")).toContain("private-fixture-only")
      writeFileSync(join(tree.root, "node_modules/.cache/fixture"), "baseline cache")
      expect(readFileSync(join(fixture.root, "node_modules/.cache/fixture"), "utf8")).toBe("user cache")
    } finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})

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
      expect(lstatSync(join(tree.root, "node_modules")).isSymbolicLink()).toBe(false)
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
    fixture.write("source.ts", "edited")
    mkdirSync(join(fixture.dir, "external-source"))
    symlinkSync(join(fixture.dir, "external-source"), join(fixture.root, "node_modules/linked"))
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    await expect(baselineTree(fixture.root, ".", base, git)).rejects.toBeInstanceOf(BaselineUnavailableError)
    expect(fixture.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1)
  } finally { fixture.cleanup() }
})

it("rebases a tracked absolute symlink behind a dependency link onto the committed base", async () => {
  const fixture = createGitFixture({ files: { "source.cjs": "GREEN BASE", ".gitignore": "node_modules\n.env.local\n" } })
  try {
    symlinkSync(join(fixture.root, "source.cjs"), join(fixture.root, "linked.cjs"))
    fixture.git(["add", "linked.cjs"])
    fixture.git(["commit", "-m", "fixture link"])
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    mkdirSync(join(fixture.root, "node_modules"))
    symlinkSync("../linked.cjs", join(fixture.root, "node_modules/shared"))
    fixture.write("source.cjs", "REGRESSION FROM EDITED TREE")
    fixture.write(".env.local", "FIXTURE_ENV=retained\n")
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", base, git)
    try {
      expect(readFileSync(join(tree.root, "source.cjs"), "utf8")).toBe("GREEN BASE")
      expect(readFileSync(join(tree.root, "node_modules/shared"), "utf8")).toBe("GREEN BASE")
      expect(realpathSync(join(tree.root, "node_modules/shared"))).toBe(join(realpathSync(tree.root), "source.cjs"))
      // Environment links are deliberately added after code topology isolation and remain read-only
      // links to the owner's environment, not copies or rebased missing files.
      expect(realpathSync(join(tree.root, ".env.local"))).toBe(realpathSync(join(fixture.root, ".env.local")))
    } finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})

it.each(["external", "dangling", "cycle"] as const)("declines a %s final workspace dependency link and removes its worktree", async topology => {
  const fixture = createGitFixture({ files: { "source.cjs": "base", ".gitignore": "node_modules\n" } })
  try {
    const target = topology === "external" ? join(fixture.dir, "external.cjs") : topology === "cycle" ? "linked.cjs" : "missing.cjs"
    if (topology === "external") writeFileSync(target, "UNTRACKED EXTERNAL CODE")
    symlinkSync(target, join(fixture.root, "linked.cjs"))
    fixture.git(["add", "linked.cjs"])
    fixture.git(["commit", "-m", "fixture link"])
    const base = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("source.cjs", "edited")
    mkdirSync(join(fixture.root, "node_modules"))
    symlinkSync("../linked.cjs", join(fixture.root, "node_modules/shared"))
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    await expect(baselineTree(fixture.root, ".", base, git)).rejects.toBeInstanceOf(BaselineUnavailableError)
    expect(await git.worktreeList!()).toHaveLength(1)
  } finally { fixture.cleanup() }
})

it("surfaces a stale owned worktree removal failure instead of claiming cleanup succeeded", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base" } })
  try {
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const stale = await git.worktreeAddDetached(fixture.git(["rev-parse", "HEAD"]).trim(), "baseline")
    unlinkSync(`${stale.dir}.baseline.json`)
    markBaseline(join(fixture.dir, "worktrees"), stale.dir, fixture.root, 2147483647)
    await expect(sweepBaselineTrees(fixture.root, { ...git, worktreeRemove: async () => { throw new Error("fixture removal denied") } })).rejects.toThrow("fixture removal denied")
    expect(existsSync(stale.dir)).toBe(true)
    await git.worktreeRemove(stale.dir)
  } finally { fixture.cleanup() }
})

it("R7 refuses a forged sibling marker on a user worktree outside its cache", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base" } })
  try {
    const sha = fixture.git(["rev-parse", "HEAD"]).trim()
    const cache = join(fixture.dir, "owned-cache")
    const outside = join(fixture.dir, "user-worktree")
    fixture.git(["worktree", "add", "--detach", outside, sha])
    writeFileSync(join(outside, "uncommitted.txt"), "keep this")
    writeFileSync(`${outside}.baseline.json`, JSON.stringify({ schema: "infinite-tag.baseline.v1", root: realpathSync(fixture.root), pid: 2147483647 }))
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: cache })
    await sweepBaselineTrees(fixture.root, git)
    expect(readFileSync(join(outside, "uncommitted.txt"), "utf8")).toBe("keep this")
  } finally { fixture.cleanup() }
})

it("R7 copies a dangling dependency link without making the baseline unavailable", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base", ".gitignore": "node_modules\n" } })
  try {
    const sha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write("source.ts", "changed")
    mkdirSync(join(fixture.root, "node_modules"))
    symlinkSync("missing-package", join(fixture.root, "node_modules/dangling"))
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", sha, git)
    try { expect(lstatSync(join(tree.root, "node_modules/dangling")).isSymbolicLink()).toBe(true) }
    finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})

it("R7 ignores all wizard-local files for an otherwise clean baseline", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base" } })
  try {
    const sha = fixture.git(["rev-parse", "HEAD"]).trim()
    fixture.write(".infinite/install.json", "{}")
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: join(fixture.dir, "worktrees") })
    const tree = await baselineTree(fixture.root, ".", sha, git)
    try { expect(tree.root).toBe(fixture.root) } finally { await tree.dispose() }
  } finally { fixture.cleanup() }
})

it("R7 does not trust a copied marker or follow a symlink into another worktree", async () => {
  const fixture = createGitFixture({ files: { "source.ts": "base" } })
  try {
    const sha = fixture.git(["rev-parse", "HEAD"]).trim()
    const cache = join(fixture.dir, "worktrees")
    const git = createGitOps({ cwd: fixture.root, env: fixture.env, worktreeRoot: cache })
    const valid = await git.worktreeAddDetached(sha, "baseline")
    unlinkSync(`${valid.dir}.baseline.json`)
    markBaseline(cache, valid.dir, fixture.root, 2147483647)
    const marker = readFileSync(`${valid.dir}.baseline.json`, "utf8")
    const outside = join(fixture.dir, "user-tree")
    fixture.git(["worktree", "add", "--detach", outside, sha])
    writeFileSync(join(outside, "keep.txt"), "uncommitted")
    const link = join(cache, "baseline-redirect")
    symlinkSync(outside, link)
    writeFileSync(`${link}.baseline.json`, marker)
    const copy = await git.worktreeAddDetached(sha, "baseline")
    writeFileSync(`${copy.dir}.baseline.json`, marker)
    await sweepBaselineTrees(fixture.root, { ...git, worktreeList: async () => [link, copy.dir] })
    expect(existsSync(copy.dir)).toBe(true)
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("uncommitted")
    await git.worktreeRemove(copy.dir)
    await git.worktreeRemove(valid.dir)
  } finally { fixture.cleanup() }
})
