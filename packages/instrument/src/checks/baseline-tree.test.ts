import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { markBaseline } from "../git/baseline-ownership.js"
import { createGitOps } from "../git/index.js"
import { baselineTree, sweepBaselineTrees } from "./baseline-tree.js"

it("uses the clean recorded base in place, including ignored environment files", async () => {
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

it("refuses a forged sibling marker on a user worktree outside its cache", async () => {
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

it("does not trust a copied marker or follow a symlink into another worktree", async () => {
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
