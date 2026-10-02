// The harness's own writes outside the install manifest — REPORT.md, the proposal, the brief,
// conversions.json and the .gitignore fenced block — recorded in `.infinite/harness.json` so they
// can be removed exactly (nothing else) by `removeHarnessOutputs`, the harness half of uninstall.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { assertWriteTargetInsideRoot, writeFileAtomic } from "../frameworks/shared.js"

export const HARNESS_OUTPUTS_RELATIVE_PATH = ".infinite/harness.json"
export const GITIGNORE_FENCE_START = "# infinite:start"
export const GITIGNORE_FENCE_END = "# infinite:end"

/**
 * What the fenced .gitignore block ignores: the local conversion proposal (it quotes page text), the
 * wizard's own run directory (state, lock, PR body, review brief), the harness report and its brief.
 * `.infinite/install.json` is deliberately NOT here: it is the committed edit receipt.
 */
export const GITIGNORE_FENCE_PATHS = [
  ".infinite/conversions.proposed.json",
  ".infinite/wizard/",
  ".infinite/REPORT.md",
  ".infinite/harness-brief.json"
] as const

/** The block the harness and the wizard write (one path per line between the markers). */
export const GITIGNORE_FENCE_BLOCK = [GITIGNORE_FENCE_START, ...GITIGNORE_FENCE_PATHS, GITIGNORE_FENCE_END].join("\n")

/** The one-line fence the harness wrote before the wizard (≤ 0.11): only the proposal. It is upgraded, never left. */
export const LEGACY_GITIGNORE_FENCE_BLOCK = [GITIGNORE_FENCE_START, ".infinite/conversions.proposed.json", GITIGNORE_FENCE_END].join("\n")

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

export type GitignoreFenceChange = "present" | "appended" | "created" | "upgraded"

/** The fenced region (from the START line through the END line), located by whole lines. */
function findFence(text: string): { start: number; end: number; region: string } | null {
  const lines = text.split("\n")
  let offset = 0
  let startOffset = -1
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    if (startOffset < 0 && line === GITIGNORE_FENCE_START) startOffset = offset
    else if (startOffset >= 0 && line === GITIGNORE_FENCE_END) {
      const end = offset + line.length
      return { start: startOffset, end, region: text.slice(startOffset, end) }
    }
    offset += raw.length + 1
  }
  return null
}

/**
 * Makes `.gitignore` ignore every GITIGNORE_FENCE_PATHS entry inside ONE fenced block, and records the
 * block in `.infinite/harness.json` so uninstall restores `.gitignore` byte-identically.
 * - no `.gitignore` → created with the block (`created`);
 * - the block already there → `present`;
 * - the old one-line fence (or any fence missing a path) → REWRITTEN in place to carry every path
 *   (`upgraded`); an old fence is never left as is;
 * - no fence, but every path already ignored by the user's own lines → `present` (nothing written);
 * - otherwise the block is appended (`appended`).
 */
export function ensureGitignoreFence(root: string): GitignoreFenceChange {
  const absolutePath = join(root, ".gitignore")
  assertWriteTargetInsideRoot(root, absolutePath)
  if (!existsSync(absolutePath)) {
    writeFileAtomic(absolutePath, `${GITIGNORE_FENCE_BLOCK}\n`)
    recordGitignoreBlock(root, GITIGNORE_FENCE_BLOCK, true)
    return "created"
  }
  const current = readFileSync(absolutePath, "utf8")
  const fence = findFence(current)
  if (fence) {
    const eol = fence.region.includes("\r\n") ? "\r\n" : "\n"
    const regionLines = fence.region.split("\n").map((line) => line.replace(/\r$/, ""))
    const inner = regionLines.slice(1, -1)
    const missing = GITIGNORE_FENCE_PATHS.filter((path) => !inner.some((line) => line.trim() === path))
    if (missing.length === 0) return "present"
    const upgraded =
      fence.region.replace(/\r\n/g, "\n") === LEGACY_GITIGNORE_FENCE_BLOCK
        ? GITIGNORE_FENCE_BLOCK
        : [GITIGNORE_FENCE_START, ...inner, ...missing, GITIGNORE_FENCE_END].join("\n")
    const block = upgraded.split("\n").join(eol)
    writeFileAtomic(absolutePath, `${current.slice(0, fence.start)}${block}${current.slice(fence.end)}`)
    const previous = readHarnessOutputs(root)?.gitignoreBlock
    recordGitignoreBlock(root, block, previous?.created ?? false)
    return "upgraded"
  }
  const userLines = new Set(current.split(/\r?\n/).map((line) => line.trim()))
  if (GITIGNORE_FENCE_PATHS.every((path) => userLines.has(path))) return "present"
  const separator = current === "" || current.endsWith("\n") ? "" : "\n"
  writeFileAtomic(absolutePath, `${current}${separator}${GITIGNORE_FENCE_BLOCK}\n`)
  recordGitignoreBlock(root, GITIGNORE_FENCE_BLOCK, false)
  return "appended"
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
      // The block ends with the line end it was written with: CRLF when the file was CRLF (an upgraded
      // fence keeps the file's line ends), else LF.
      const eols = block.block.includes("\r\n") ? ["\r\n", "\n"] : ["\n", "\r\n"]
      const withEol = eols.map((eol) => `${block.block}${eol}`).find((candidate) => current.includes(candidate))
      if (withEol && block.created && current === withEol) {
        rmSync(absolutePath)
        result.gitignore = "removed"
      } else if (withEol) {
        writeFileAtomic(absolutePath, current.replace(withEol, ""))
        result.gitignore = "removed"
      } else {
        result.gitignore = "kept"
      }
    }
  }
  rmSync(join(root, HARNESS_OUTPUTS_RELATIVE_PATH), { force: true })
  return result
}
