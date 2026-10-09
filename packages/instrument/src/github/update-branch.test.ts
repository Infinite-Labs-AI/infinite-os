import { expect, it } from "vitest"
import { join } from "node:path"
import { createGitFixture } from "../../test/wizard/git-fixture.js"
import { createGitOps } from "../git/index.js"
import { branchUpdateCommits } from "./update-branch.js"

it("recognizes only a merge of the recorded head and fetched base, not later unrelated commits", async () => {
  const fx = createGitFixture({ files: { "root.txt": "base" } })
  try {
    const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
    await git.createBranch("main", "infinite/tag/integration")
    fx.write("feature.txt", "feature")
    fx.git(["add", "feature.txt"])
    fx.git(["commit", "-m", "feature"])
    const previous = await git.head()
    fx.git(["checkout", "main"])
    fx.write("base.txt", "new base")
    fx.git(["add", "base.txt"])
    fx.git(["commit", "-m", "base"])
    const base = await git.head()
    fx.git(["checkout", "infinite/tag/integration"])
    fx.git(["merge", "--no-ff", "main", "-m", "requested integration"])
    const merged = await git.head()
    expect(await branchUpdateCommits(fx.root, git, previous, merged, base)).toEqual(expect.arrayContaining([base, merged]))
    fx.write("unrelated.txt", "unrelated")
    fx.git(["add", "unrelated.txt"])
    fx.git(["commit", "-m", "unrelated"])
    expect(await branchUpdateCommits(fx.root, git, previous, await git.head(), base)).toBeNull()
  } finally { fx.cleanup() }
})
