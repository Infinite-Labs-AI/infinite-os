import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { PROPOSED_CONVERSIONS_RELATIVE_PATH, ensureProposedIgnored, proposeConversions, writeProposal } from "./marking.js"
import {
  GITIGNORE_FENCE_BLOCK,
  GITIGNORE_FENCE_PATHS,
  HARNESS_OUTPUTS_RELATIVE_PATH,
  LEGACY_GITIGNORE_FENCE_BLOCK,
  ensureGitignoreFence,
  readHarnessOutputs,
  recordGitignoreBlock,
  recordHarnessFile,
  removeHarnessOutputs
} from "./outputs.js"

const tempRoots: string[] = []
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-outputs-"))
  tempRoots.push(root)
  return root
}
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe("harness outputs manifest", () => {
  it("records the proposal and the gitignore block, and removes exactly them", () => {
    const root = makeRoot()
    writeFileSync(join(root, "index.html"), `<a href="/x">Go</a>\n`)
    writeFileSync(join(root, ".gitignore"), "node_modules\n")
    writeProposal(root, proposeConversions({ root, appRoot: "." }))
    expect(ensureProposedIgnored(root)).toBe("appended")
    const outputs = readHarnessOutputs(root)
    expect(outputs?.files).toEqual([PROPOSED_CONVERSIONS_RELATIVE_PATH])
    expect(outputs?.gitignoreBlock?.created).toBe(false)

    const result = removeHarnessOutputs(root)
    expect(result.removedFiles).toEqual([PROPOSED_CONVERSIONS_RELATIVE_PATH])
    expect(result.gitignore).toBe("removed")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n")
    expect(existsSync(join(root, HARNESS_OUTPUTS_RELATIVE_PATH))).toBe(false)
  })

  it("deletes a .gitignore it created when nothing else was added, keeps one that changed", () => {
    const created = makeRoot()
    expect(ensureProposedIgnored(created)).toBe("created")
    expect(removeHarnessOutputs(created).gitignore).toBe("removed")
    expect(existsSync(join(created, ".gitignore"))).toBe(false)

    const changed = makeRoot()
    writeFileSync(join(changed, ".gitignore"), "dist\n")
    ensureProposedIgnored(changed)
    writeFileSync(join(changed, ".gitignore"), readFileSync(join(changed, ".gitignore"), "utf8").replace("# infinite:end", "# mine-inside-the-block\n# infinite:end"))
    expect(removeHarnessOutputs(changed).gitignore).toBe("kept")
  })

  it("only ever records files under .infinite/", () => {
    const root = makeRoot()
    expect(() => recordHarnessFile(root, "index.html")).toThrow(/only records its own/)
  })
})

describe("the gitignore fence (wizard)", () => {
  it("is one multi-line block that ignores the proposal, the wizard dir, the report and the brief", () => {
    const root = makeRoot()
    writeFileSync(join(root, ".gitignore"), "node_modules\n")
    expect(ensureGitignoreFence(root)).toBe("appended")
    const text = readFileSync(join(root, ".gitignore"), "utf8")
    expect(text).toBe(`node_modules\n${GITIGNORE_FENCE_BLOCK}\n`)
    expect(GITIGNORE_FENCE_PATHS).toEqual([".infinite/conversions.proposed.json", ".infinite/wizard/", ".infinite/REPORT.md", ".infinite/harness-brief.json"])
    expect(text.match(/# infinite:start/g)).toHaveLength(1)
    expect(text).not.toContain(".infinite/install.json")
    expect(ensureGitignoreFence(root)).toBe("present")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(text)
  })

  it("rewrites an old one-line fence to the full block (negative: leaving it as is fails), and uninstall still restores .gitignore byte-identically", () => {
    const root = makeRoot()
    const original = "node_modules\n"
    // What a 0.11 harness run left behind: the one-line fence, recorded in harness.json.
    writeFileSync(join(root, ".gitignore"), `${original}${LEGACY_GITIGNORE_FENCE_BLOCK}\n`)
    recordGitignoreBlock(root, LEGACY_GITIGNORE_FENCE_BLOCK, false)

    expect(ensureGitignoreFence(root)).toBe("upgraded")
    const upgraded = readFileSync(join(root, ".gitignore"), "utf8")
    expect(upgraded).not.toBe(`${original}${LEGACY_GITIGNORE_FENCE_BLOCK}\n`)
    expect(upgraded).toBe(`${original}${GITIGNORE_FENCE_BLOCK}\n`)
    for (const path of GITIGNORE_FENCE_PATHS) expect(upgraded.split("\n")).toContain(path)
    expect(upgraded.match(/# infinite:start/g)).toHaveLength(1)
    expect(readHarnessOutputs(root)?.gitignoreBlock).toEqual({ file: ".gitignore", block: GITIGNORE_FENCE_BLOCK, created: false })

    expect(removeHarnessOutputs(root).gitignore).toBe("removed")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(original)
  })

  it("an upgraded fence the harness created is deleted with the file it created", () => {
    const root = makeRoot()
    writeFileSync(join(root, ".gitignore"), `${LEGACY_GITIGNORE_FENCE_BLOCK}\n`)
    recordGitignoreBlock(root, LEGACY_GITIGNORE_FENCE_BLOCK, true)
    expect(ensureGitignoreFence(root)).toBe("upgraded")
    expect(removeHarnessOutputs(root).gitignore).toBe("removed")
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
  })

  it("keeps the user's own lines inside a changed fence and adds only the missing paths", () => {
    const root = makeRoot()
    writeFileSync(join(root, ".gitignore"), "# infinite:start\n.infinite/conversions.proposed.json\n# mine\n# infinite:end\ndist\n")
    expect(ensureGitignoreFence(root)).toBe("upgraded")
    const text = readFileSync(join(root, ".gitignore"), "utf8")
    expect(text).toBe(
      "# infinite:start\n.infinite/conversions.proposed.json\n# mine\n.infinite/wizard/\n.infinite/REPORT.md\n.infinite/harness-brief.json\n# infinite:end\ndist\n"
    )
  })

  it("creates .gitignore when there is none, and keeps CRLF line ends when upgrading", () => {
    const created = makeRoot()
    expect(ensureGitignoreFence(created)).toBe("created")
    expect(readFileSync(join(created, ".gitignore"), "utf8")).toBe(`${GITIGNORE_FENCE_BLOCK}\n`)

    const crlf = makeRoot()
    writeFileSync(join(crlf, ".gitignore"), `dist\r\n${LEGACY_GITIGNORE_FENCE_BLOCK.split("\n").join("\r\n")}\r\n`)
    expect(ensureGitignoreFence(crlf)).toBe("upgraded")
    expect(readFileSync(join(crlf, ".gitignore"), "utf8")).toBe(`dist\r\n${GITIGNORE_FENCE_BLOCK.split("\n").join("\r\n")}\r\n`)
  })

  it("a CRLF fence (upgraded in place) is removed byte-identically by uninstall (O1-14)", () => {
    const root = makeRoot()
    const original = "dist\r\nnode_modules\r\n"
    const legacy = LEGACY_GITIGNORE_FENCE_BLOCK.split("\n").join("\r\n")
    writeFileSync(join(root, ".gitignore"), `${original}${legacy}\r\n`)
    recordGitignoreBlock(root, legacy, false)
    expect(ensureGitignoreFence(root)).toBe("upgraded")
    expect(removeHarnessOutputs(root).gitignore).toBe("removed")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(original)

    // A fence the harness CREATED in a CRLF upgrade is deleted with the file.
    const created = makeRoot()
    writeFileSync(join(created, ".gitignore"), `${legacy}\r\n`)
    recordGitignoreBlock(created, legacy, true)
    expect(ensureGitignoreFence(created)).toBe("upgraded")
    expect(removeHarnessOutputs(created).gitignore).toBe("removed")
    expect(existsSync(join(created, ".gitignore"))).toBe(false)
  })
})
