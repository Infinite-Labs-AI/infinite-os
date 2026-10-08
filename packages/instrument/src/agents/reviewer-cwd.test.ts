// Review I1 P1-4: the Claude reviewer's Read denies (every sensitive path, the wizard's cache root included)
// must never cover its own cwd, the detached review worktree; with the real path builders.
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defaultWorktreeRoot, worktreeDirFor } from "../git/worktree.js"
import { AGENT_MODELS } from "../wizard/contracts/agents.js"
import { buildClaudeReviewerArgv, reviewerDenyCoveringCwd, reviewerWasBlind } from "./claude.js"
import { resolveSensitivePaths } from "./paths.js"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-cwd-")))
  dirs.push(dir)
  return dir
}

const SHA = "a".repeat(40)

describe("the reviewer's worktree is outside every Read deny (review I1 P1-4)", () => {
  it("no reviewer deny is a prefix of the default review worktree", async () => {
    const h = home()
    const sensitive = await resolveSensitivePaths({ home: h, env: {} })
    const cwd = worktreeDirFor(defaultWorktreeRoot("7f3c2a91b0de", h), SHA)
    expect(reviewerDenyCoveringCwd(sensitive, cwd)).toBeNull()
    const argv = buildClaudeReviewerArgv({ sensitive, systemPrompt: "s", reviewSchema: "{}", maxTurns: 5, model: { model: AGENT_MODELS.claude_code.model, effort: AGENT_MODELS.claude_code.effort } })
    const denies = argv.filter((arg) => /^Read\(\/\//.test(arg)).map((arg) => arg.slice("Read(/".length, -1).replace(/\/\*\*$/, ""))
    expect(denies.length).toBeGreaterThan(0)
    for (const denied of denies) expect(cwd === denied || cwd.startsWith(`${denied}/`), denied).toBe(false)
    // Still under $HOME (the Codex profile's HOME deny keeps it closed to every other role).
    expect(cwd.startsWith(`${h}/`)).toBe(true)
  })

  it("a denial on the PR's own files means a blind review; a repo-secret denial does not", () => {
    const wt = "/Users/u/Library/Caches/infinite-tag-review/r/worktrees/review-x"
    expect(reviewerWasBlind([{ toolName: "Read", path: "app/page.tsx" }], wt)).toBe(true)
    expect(reviewerWasBlind([{ toolName: "Read", path: `${wt}/app/layout.tsx` }], wt)).toBe(true)
    expect(reviewerWasBlind([{ toolName: "Read", path: ".env.local" }, { toolName: "Read", path: `${wt}/.npmrc` }], wt)).toBe(false)
    expect(reviewerWasBlind([{ toolName: "Read", path: "/Users/u/.ssh/id_ed25519" }], wt)).toBe(false)
  })
})
