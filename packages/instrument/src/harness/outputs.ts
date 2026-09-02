// The harness's own writes outside the install manifest — REPORT.md, the proposal, the brief,
// conversions.json and the .gitignore fenced block — recorded in `.infinite/harness.json` so they
// can be removed exactly (nothing else) by `removeHarnessOutputs`, the harness half of uninstall.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { assertWriteTargetInsideRoot, writeFileAtomic } from "../frameworks/shared.js"

export const HARNESS_OUTPUTS_RELATIVE_PATH = ".infinite/harness.json"
export const GITIGNORE_FENCE_START = "# infinite:start"
export const GITIGNORE_FENCE_END = "# infinite:end"

export interface HarnessOutputs {
  version: 1
  /** Root-relative files the harness created (only ever under .infinite/). */
  files: string[]
  /** The exact fenced block appended to .gitignore, when the harness appended (or created) it. */
  gitignoreBlock?: { file: ".gitignore"; block: string; created: boolean }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readHarnessOutputs(root: string): HarnessOutputs | null {
  const absolutePath = join(root, HARNESS_OUTPUTS_RELATIVE_PATH)
  if (!existsSync(absolutePath)) return null
  const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"))
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new Error("Corrupt .infinite/harness.json — remove it manually to reset.")
  }
  return parsed as unknown as HarnessOutputs
}

function writeHarnessOutputs(root: string, outputs: HarnessOutputs): void {
  const absolutePath = join(root, HARNESS_OUTPUTS_RELATIVE_PATH)
  assertWriteTargetInsideRoot(root, absolutePath)
  writeFileAtomic(absolutePath, `${JSON.stringify(outputs, null, 2)}\n`)
}

/** Records one harness-created file (root-relative, must live under .infinite/). */
export function recordHarnessFile(root: string, relativePath: string): void {
  if (!relativePath.startsWith(".infinite/")) {
    throw new Error(`Refusing to record ${relativePath}: the harness only records its own .infinite/ files.`)
  }
  const outputs = readHarnessOutputs(root) ?? { version: 1, files: [] }
  if (!outputs.files.includes(relativePath)) outputs.files = [...outputs.files, relativePath].sort()
  writeHarnessOutputs(root, outputs)
}

/** Records the .gitignore block the harness appended or created. */
export function recordGitignoreBlock(root: string, block: string, created: boolean): void {
  const outputs = readHarnessOutputs(root) ?? { version: 1, files: [] }
  outputs.gitignoreBlock = { file: ".gitignore", block, created }
  writeHarnessOutputs(root, outputs)
}

export interface RemoveHarnessOutputsResult {
  removedFiles: string[]
  /** "removed" (block stripped / file deleted), "kept" (changed since), or "absent". */
  gitignore: "removed" | "kept" | "absent"
}

/**
 * Reverses the harness's own writes: deletes each recorded .infinite/ file, strips the fenced
 * .gitignore block only when it is byte-identical to what was appended (or deletes .gitignore
 * when the harness created it and it holds nothing else), then removes harness.json itself.
 */
export function removeHarnessOutputs(root: string): RemoveHarnessOutputsResult {
  const outputs = readHarnessOutputs(root)
  const result: RemoveHarnessOutputsResult = { removedFiles: [], gitignore: "absent" }
  if (!outputs) return result
  for (const relativePath of outputs.files) {
    if (!relativePath.startsWith(".infinite/")) continue
    const absolutePath = join(root, relativePath)
    assertWriteTargetInsideRoot(root, absolutePath)
    if (existsSync(absolutePath)) {
      rmSync(absolutePath)
      result.removedFiles.push(relativePath)
    }
  }
  const block = outputs.gitignoreBlock
  if (block) {
    const absolutePath = join(root, ".gitignore")
    assertWriteTargetInsideRoot(root, absolutePath)
    if (!existsSync(absolutePath)) {
      result.gitignore = "absent"
    } else {
      const current = readFileSync(absolutePath, "utf8")
      const withNewline = `${block.block}\n`
      if (block.created && current === withNewline) {
        rmSync(absolutePath)
        result.gitignore = "removed"
      } else if (current.includes(withNewline)) {
        writeFileAtomic(absolutePath, current.replace(withNewline, ""))
        result.gitignore = "removed"
      } else {
        result.gitignore = "kept"
      }
    }
  }
  rmSync(join(root, HARNESS_OUTPUTS_RELATIVE_PATH), { force: true })
  return result
}
