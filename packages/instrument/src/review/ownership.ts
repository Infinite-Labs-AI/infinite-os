// §3x.3 / DECISIONS §1.5: whose code a review finding is on. The second reviewer reads the whole pull request, and
// the wizard's own install is part of it. A finding on Infinite's managed runtime (a module the install CREATED and
// owns whole) or on the wizard's own change (a config it created, the gitignore fence, its proof file,
// `.infinite/install.json`, the managed import / mount lines it added to a customer file) is never handed to the
// customer's agent: run 3 handed `lib/infinite-analytics.ts` to Claude Code as job 16, which would have broken the
// managed hash and fixed Infinite's runtime for one customer only.
//
// The facts come from the install receipt (`.infinite/install.json`) and the PR's base commit (a file absent there
// was created by this run), never from the reviewer.
import { join } from "node:path"
import { hasRecordedPolicyEdits, isPolicyPath } from "../jobs/owner-boundary.js"

import type { WizardDeps } from "../wizard/contracts/deps.js"
import type { InfiniteOwnLabel } from "./post.js"

export const INSTALL_MANIFEST_FILE = ".infinite/install.json"
/** A line the install adds to a customer file to mount Infinite's managed code (an import or the client mount). */
const MANAGED_MOUNT_LINE = /infinite-analytics|InfiniteAnalytics|infinite-tag:(?:start|end)|infinite:(?:start|end)/

interface ReceiptLike {
  files?: unknown
  configOwnership?: unknown
  serverLane?: { middleware?: unknown; module?: unknown; brief?: unknown; guide?: unknown; created?: unknown } | null
  edits?: unknown
}

interface ReceiptEdit {
  file: string
  by: "wizard" | "agent"
  beforeHash: string | null
  textEdits: Array<{ offset: number; removed: string; inserted: string }>
}

export interface WizardOwnership {
  writtenByRun?(path: string, line: number | null): boolean
  /** Metadata from the already parsed receipt; never reads a policy file for this fact. */
  recordedPolicyEdits?(runId: string): boolean
  /** Every file the wizard itself wrote (the reviewer's `plan.json` `wizardFiles`): managed ∪ the wizard's own edits. */
  wizardFiles: string[]
  /** Whose code a finding at `path:line` is on; null = the customer's. */
  classify(path: string, line: number | null): InfiniteOwnLabel | null
  /**
   * LF4-P1-3: the names only Infinite's runtime files define and do not export (`runtimeInternalNames`), read from the
   * files this run installed. A finding that asks to change one asks to change Infinite's code, whatever line it is on.
   */
  runtimeInternals: ReadonlySet<string>
  /** LF4-P1-3 (round 1): the names the runtime this run installed exports (`runtimeExportedNames`). */
  runtimeExports: ReadonlySet<string>
}

/** The runtime's text with its string-literal escapes read as spaces (its browser code ships inside a JS string). */
function runtimeText(raw: string): string {
  return raw.replace(/\\[nrt]/g, " ")
}

/**
 * LF4-P1-3 (round 1): the names Infinite's runtime EXPORTS — the helpers a customer's code imports and calls
 * (`infiniteTrackThenNavigate`, the client component), read from its own bytes.
 */
export function runtimeExportedNames(sources: readonly string[]): Set<string> {
  const exported = new Set<string>()
  for (const raw of sources) {
    const text = runtimeText(raw)
    for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(match[1]!)
    for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
      for (const part of match[1]!.split(",")) {
        const name = part.split(/\s+as\s+/).pop()?.trim()
        if (name) exported.add(name)
      }
    }
  }
  return exported
}

/**
 * LF4-P1-3: the identifiers Infinite's runtime keeps to itself, derived from its own bytes (never a keyword list):
 * every name it declares, plus every `window.__infinite…` / `window.infinite…` global it reads or sets, minus every name
 * it exports (the helpers the customer's code calls, which are the customer's to call right).
 *
 * Round 1: only names in Infinite's OWN namespace count — the runtime names everything it puts in the page's scope (its
 * globals, its helpers, its constants) `infinite…` / `__infinite…` / `INFINITE_…`. A runtime local like `userAgent`,
 * `hasValue`, `cleanValue` or `budgetMs` is a generic name any site's code uses, so a finding naming one (a customer
 * route's `userAgent` filter) says nothing about Infinite's code.
 */
export function runtimeInternalNames(sources: readonly string[]): Set<string> {
  const exported = runtimeExportedNames(sources)
  const declared = new Set<string>()
  for (const raw of sources) {
    const text = runtimeText(raw)
    for (const match of text.matchAll(/\b(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]!)
    for (const match of text.matchAll(/\b(?:window|globalThis|self)\s*\.\s*((?:__)?infinite[\w$]*)/g)) declared.add(match[1]!)
  }
  return new Set([...declared].filter((name) => !exported.has(name) && /^(?:__infinite|infinite|INFINITE_)[\w$]{3,}$/.test(name)))
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

/** The 1-based lines `inserted` occupies in `text` (its first occurrence), or null when it is not there. */
function insertedLines(text: string, inserted: string): [number, number] | null {
  if (inserted === "") return null
  const at = text.indexOf(inserted)
  if (at < 0) return null
  const first = text.slice(0, at).split("\n").length
  const body = inserted.endsWith("\n") ? inserted.slice(0, -1) : inserted
  return [first, first + body.split("\n").length - 1]
}

/** `.infinite/install.json` is there but does not parse: whose code a file is cannot be told. */
export class InstallReceiptUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`${INSTALL_MANIFEST_FILE} does not parse (${cause instanceof Error ? cause.message.slice(0, 80) : String(cause).slice(0, 80)}), so the wizard cannot tell Infinite's own files from yours. Restore it from git (git checkout -- .infinite/install.json), then run again.`)
    this.name = "InstallReceiptUnreadableError"
  }
}

/**
 * Reads the receipt and the tree. `existedAtBase(path)` = the file is in the PR's base commit (null = unknown, and
 * then the file is never called Infinite's own code: only a file the run CREATED can be Infinite's whole).
 */
export async function wizardOwnership(
  deps: Pick<WizardDeps, "fs">,
  root: string,
  existedAtBase: (path: string) => Promise<boolean | null>,
  appRoot = "."
): Promise<WizardOwnership> {
  const text = await deps.fs.readText(join(root, INSTALL_MANIFEST_FILE))
  let receipt: ReceiptLike = {}
  if (text !== null) {
    try {
      receipt = JSON.parse(text) as ReceiptLike
    } catch (error) {
      // Review P3-3: never an empty receipt. With no receipt every Infinite file would read as the customer's, and a
      // finding on Infinite's own code would go to the customer's agent; the run stops here, naming why.
      throw new InstallReceiptUnreadableError(error)
    }
  }
  const managed = new Set(strings(receipt.files))
  const configs = new Set(receipt.configOwnership && typeof receipt.configOwnership === "object" ? Object.keys(receipt.configOwnership) : [])
  const lane = receipt.serverLane ?? null
  if (lane) for (const value of [lane.middleware, lane.module, lane.brief, lane.guide, ...strings(lane.created)]) if (typeof value === "string") managed.add(value)
  for (const config of configs) managed.add(config)
  const edits = (Array.isArray(receipt.edits) ? (receipt.edits as ReceiptEdit[]) : []).filter((edit) => edit && edit.by === "wizard" && typeof edit.file === "string" && !/(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(edit.file))

  /** Whole files: Infinite's runtime (created by the install, not a config), or the wizard's own change. */
  const runtime = new Set<string>()
  const wizardWhole = new Set<string>([INSTALL_MANIFEST_FILE])
  /** The wizard's own lines in a customer file. */
  const wizardLines = new Map<string, Array<[number, number]>>()
  const addLines = (file: string, range: [number, number]) => wizardLines.set(file, [...(wizardLines.get(file) ?? []), range])

  for (const file of managed) {
    const existed = await existedAtBase(file)
    if (existed === false) {
      if (configs.has(file)) wizardWhole.add(file)
      else runtime.add(file)
      continue
    }
    // A customer file the install edited: only its managed mount lines are the wizard's.
    const current = await deps.fs.readText(join(root, file))
    if (current === null) continue
    current.split("\n").forEach((lineText, index) => {
      if (MANAGED_MOUNT_LINE.test(lineText)) addLines(file, [index + 1, index + 1])
    })
  }
  for (const edit of edits) {
    if (edit.beforeHash === null) {
      wizardWhole.add(edit.file)
      continue
    }
    const current = await deps.fs.readText(join(root, edit.file))
    if (current === null) continue
    for (const textEdit of edit.textEdits ?? []) {
      const range = insertedLines(current, textEdit.inserted)
      if (range) addLines(edit.file, range)
    }
  }
  const agentLines = new Map<string, Array<[number, number]>>()
  const agentWhole = new Set<string>()
  for (const edit of (Array.isArray(receipt.edits) ? receipt.edits as ReceiptEdit[] : [])) {
    if (!edit || edit.by !== "agent" || typeof edit.file !== "string") continue
    if (edit.beforeHash === null || isPolicyPath(edit.file, appRoot)) { agentWhole.add(edit.file); continue }
    if (!Array.isArray(edit.textEdits) || edit.textEdits.length === 0) continue
    const current = await deps.fs.readText(join(root, edit.file))
    if (current === null) continue
    for (const change of edit.textEdits ?? []) {
      const range = insertedLines(current, change.inserted)
      if (range) agentLines.set(edit.file, [...agentLines.get(edit.file) ?? [], range])
    }
  }
  const runtimeSources: string[] = []
  for (const file of runtime) {
    const text = await deps.fs.readText(join(root, file))
    if (text !== null) runtimeSources.push(text)
  }
  const runtimeInternals = runtimeInternalNames(runtimeSources)
  const runtimeExports = runtimeExportedNames(runtimeSources)
  const receiptEditFiles = new Set(edits.map((edit) => edit.file))
  const wizardFiles = [...new Set([...managed, ...receiptEditFiles, INSTALL_MANIFEST_FILE])].sort()
  return {
    writtenByRun(path, line) {
      if (runtime.has(path) || wizardWhole.has(path) || agentWhole.has(path)) return true
      const ranges = [...wizardLines.get(path) ?? [], ...agentLines.get(path) ?? []]
      return line === null ? ranges.length > 0 : ranges.some(([first, last]) => line >= first && line <= last)
    },
    recordedPolicyEdits: runId => hasRecordedPolicyEdits([], receipt, runId),
    wizardFiles,
    runtimeInternals,
    runtimeExports,
    classify(path, line) {
      if (runtime.has(path)) return "Infinite's own code"
      if (wizardWhole.has(path)) return "the wizard's own change"
      const ranges = wizardLines.get(path)
      if (!ranges) return null
      // A line-less finding is the wizard's only on a file the wizard's own receipt edit is in (the gitignore fence);
      // on a customer file that merely mounts the managed code it is about the customer's code.
      if (line === null) return receiptEditFiles.has(path) ? "the wizard's own change" : null
      return ranges.some(([from, to]) => line >= from && line <= to) ? "the wizard's own change" : null
    }
  }
}
