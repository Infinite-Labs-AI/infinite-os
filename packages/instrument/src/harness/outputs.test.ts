import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { PROPOSED_CONVERSIONS_RELATIVE_PATH, ensureProposedIgnored, proposeConversions, writeProposal } from "./marking.js"
import { HARNESS_OUTPUTS_RELATIVE_PATH, readHarnessOutputs, recordHarnessFile, removeHarnessOutputs } from "./outputs.js"

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
