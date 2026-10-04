// I1b: the wizard's own bookkeeping never blocks its uninstall, and nothing else gets through.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { onlyWizardBookkeepingDirty } from "./installer.js"

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-tag-bookkeeping-")))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" } })
  git("init", "-q", "-b", "main")
  writeFileSync(join(root, "README.md"), "# site\n")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  return root
}

describe("onlyWizardBookkeepingDirty", () => {
  it("the fence's untracked .infinite/harness.json and the run directory are bookkeeping", () => {
    const root = repo()
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(join(root, ".infinite/harness.json"), "{}\n")
    writeFileSync(join(root, ".infinite/wizard/state.json"), "{}\n")
    expect(onlyWizardBookkeepingDirty(root)).toBe(true)
  })

  it("NEGATIVE: a user's edit (or any other untracked file) next to it is not", () => {
    const root = repo()
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/harness.json"), "{}\n")
    writeFileSync(join(root, "README.md"), "# site, edited\n")
    expect(onlyWizardBookkeepingDirty(root)).toBe(false)
    const other = repo()
    writeFileSync(join(other, "notes.txt"), "mine\n")
    expect(onlyWizardBookkeepingDirty(other)).toBe(false)
  })

  it("NEGATIVE: a clean tree needs no exemption (false: the normal gate applies)", () => {
    expect(onlyWizardBookkeepingDirty(repo())).toBe(false)
  })
})
