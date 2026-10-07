/** Measure a single wizard diff against its parent. No source is edited here. */
import type { Stats } from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { git } from "../agents/git-exec.js"
import { restoreFrozenUnits } from "./consent-units.js"
import { isPolicyPath } from "./owner-boundary.js"

export interface OwnerBoundaryMeasurement {
  state: "checked" | "changed" | "not_checked"
  scope: "working_tree" | "commit"
  baseSha: string
  headSha: string
  files: string[]
  filesAvailable?: boolean
  issues: Array<{ file: string; reason: string }>
  /** Exact reachable SHAs from the run's own commit record that were measured against their parents. */
  wizardCommits?: string[]
  /** Positive only after actually comparing a recorded commit to its parent. */
  measuredCommitCount?: number
  /** History gaps are reported, never converted into a successful measurement. */
  unverifiedReason?: string
  fileScope?: "wizard_commits" | "branch_history"
}
const metadata = (path: string) => path.startsWith(".infinite/") || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(path)

export async function measureOwnerDiff(input: {
  root: string; baseSha: string; revision?: string; appRoot?: string
  /** Exact paths selected for the next commit; committed revisions always measure their full diff. */
  paths?: readonly string[]
}): Promise<OwnerBoundaryMeasurement> {
  const measurement: OwnerBoundaryMeasurement = { state: "not_checked", scope: input.revision ? "commit" : "working_tree", baseSha: input.baseSha, headSha: input.revision ?? "", files: [], issues: [] }
  const fail = (file: string, reason: string) => { measurement.issues.push({ file, reason }); return measurement }
  if (!/^[a-f0-9]{40}$/.test(input.baseSha) || (input.revision && !/^[a-f0-9]{40}$/.test(input.revision))) return fail("(git)", "the recorded base or commit is unavailable")
  const head = await git(input.root, ["rev-parse", "--verify", input.revision ?? "HEAD"])
  if (head.code !== 0) return fail("(git)", "the final commit could not be read")
  measurement.headSha = head.stdout.toString("utf8").trim()
  const base = await git(input.root, ["rev-parse", "--verify", `${input.baseSha}^{commit}`])
  if (base.code !== 0) return fail("(git)", "the recorded base could not be read")
  const paths = new Set<string>()
  if (!input.revision && input.paths !== undefined) {
    for (const path of input.paths) paths.add(path)
  } else {
    const names = await git(input.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", input.baseSha, ...(input.revision ? [input.revision] : []), "--"])
    if (names.code !== 0) return fail("(git)", "the final diff could not be read")
    for (const path of names.stdout.toString("utf8").split("\0").filter(Boolean)) paths.add(path)
    if (!input.revision) {
      const extra = await git(input.root, ["ls-files", "--others", "--exclude-standard", "-z"])
      if (extra.code !== 0) return fail("(git)", "new files could not be read")
      for (const path of extra.stdout.toString("utf8").split("\0").filter(Boolean)) paths.add(path)
    }
  }
  measurement.files = [...paths].sort()
  measurement.filesAvailable = true
  const blob = async (revision: string, path: string): Promise<{ bytes: Buffer | null; error?: string }> => {
    const entry = await git(input.root, ["ls-tree", "-z", revision, "--", path])
    if (entry.code !== 0) return { bytes: null, error: "the source tree entry could not be read" }
    if (entry.stdout.length === 0) return { bytes: null }
    if (!/^100[67][0-7]{2} blob /.test(entry.stdout.toString("utf8"))) return { bytes: null, error: "the source tree entry is not a regular file" }
    const result = await git(input.root, ["show", `${revision}:${path}`])
    return result.code === 0 ? { bytes: result.stdout } : { bytes: null, error: "an existing source blob could not be read" }
  }
  measurement.state = "checked"
  for (const path of [...paths].sort()) {
    if (metadata(path)) continue
    if (path.startsWith("/") || path.split("/").includes("..")) { measurement.state = "not_checked"; fail(path, "invalid diff path"); continue }
    if (isPolicyPath(path, input.appRoot ?? ".")) { measurement.state = "changed"; fail(path, "a routed privacy/terms policy page is in the final diff"); continue }
    const beforeBlob = await blob(input.baseSha, path)
    if (beforeBlob.error) { measurement.state = "not_checked"; fail(path, beforeBlob.error); continue }
    let after: Buffer | null
    if (input.revision) {
      const afterBlob = await blob(input.revision, path)
      if (afterBlob.error) { measurement.state = "not_checked"; fail(path, afterBlob.error); continue }
      after = afterBlob.bytes
    } else {
      let info: Stats | null = null
      try { info = await lstat(join(input.root, path)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { measurement.state = "not_checked"; fail(path, "the changed source could not be inspected"); continue }
      }
      if (info && !info.isFile()) { measurement.state = "not_checked"; fail(path, "the changed source is not a regular file"); continue }
      try { after = info ? await readFile(join(input.root, path)) : null }
      catch { measurement.state = "not_checked"; fail(path, "the changed source could not be read"); continue }
    }
    const before = beforeBlob.bytes
    if ([before, after].some(bytes => bytes && (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)))) {
      measurement.state = "not_checked"; fail(path, "the changed source could not be decoded"); continue
    }
    const comparison = restoreFrozenUnits(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "", path)
    if (comparison.changes.length > 0) { measurement.state = "changed"; fail(path, "a consent-bearing top-level unit differs from the recorded base") }
  }
  return measurement
}

export function ownerBoundaryStop(measurement: OwnerBoundaryMeasurement): string {
  return `Nothing pushed: the wizard's consent/privacy diff check ${measurement.state === "changed" ? "found a change" : "could not finish"} in ${measurement.issues.map(issue => issue.file).join(", ") || "(git)"}. Review the named wizard edits before continuing. Owner-authored commits are left alone.`
}

/** Measure only SHAs this run recorded creating. Other commits are owner work, never inferred from trailers. */
export async function measureWizardCommits(input: { root: string; appRoot?: string; baseSha: string; headSha: string; wizardCommits?: readonly string[]; historyReason?: string }): Promise<OwnerBoundaryMeasurement> {
  const result: OwnerBoundaryMeasurement = { state: "not_checked", scope: "commit", baseSha: input.baseSha, headSha: input.headSha, files: [], issues: [], wizardCommits: [], measuredCommitCount: 0, fileScope: "wizard_commits" }
  const recorded = input.wizardCommits ?? []
  if (![input.baseSha, input.headSha, ...recorded].every(sha => /^[a-f0-9]{40}$/.test(sha))) { result.issues.push({ file: "(git)", reason: "the recorded commit SHAs are invalid" }); return result }
  for (const sha of [input.baseSha, input.headSha]) if ((await git(input.root, ["rev-parse", "--verify", `${sha}^{commit}`])).code !== 0) { result.issues.push({ file: "(git)", reason: "the pushed history could not be read" }); return result }
  result.state = "checked"
  if (input.historyReason) result.unverifiedReason = input.historyReason
  else if (input.wizardCommits === undefined) result.unverifiedReason = "the run has no saved wizard commit record"
  else if (recorded.length === 0) result.unverifiedReason = "no wizard commits were recorded or measured"
  for (const sha of [...new Set(recorded)]) {
    if ((await git(input.root, ["rev-parse", "--verify", `${sha}^{commit}`])).code !== 0) {
      result.unverifiedReason = "a recorded wizard commit is unavailable or no longer exists"
      continue
    }
    const reachable = await git(input.root, ["merge-base", "--is-ancestor", sha, input.headSha])
    if (reachable.code === 1) { result.unverifiedReason = "a recorded wizard commit is no longer reachable from this branch (it may have been amended or squashed)"; continue }
    if (reachable.code !== 0) { result.state = "not_checked"; result.issues.push({ file: "(git)", reason: `recorded wizard commit ${sha} could not be read` }); continue }
    const entry = await git(input.root, ["rev-list", "--parents", "-n", "1", sha])
    if (entry.code !== 0) { result.state = "not_checked"; result.issues.push({ file: "(git)", reason: `recorded wizard commit ${sha} has unreadable parents` }); continue }
    const [, ...parents] = entry.stdout.toString("utf8").trim().split(" ")
    result.wizardCommits!.push(sha)
    if (parents.length !== 1) { result.state = "not_checked"; result.issues.push({ file: "(git)", reason: `wizard commit ${sha} does not have exactly one parent` }); continue }
    const measured = await measureOwnerDiff({ root: input.root, appRoot: input.appRoot, baseSha: parents[0]!, revision: sha })
    result.measuredCommitCount!++
    result.files.push(...measured.files)
    if (measured.filesAvailable) result.filesAvailable = true
    result.issues.push(...measured.issues.map(issue => ({ ...issue, reason: `${sha.slice(0, 12)}: ${issue.reason}` })))
    if (measured.state === "not_checked" || (measured.state === "changed" && result.state !== "not_checked")) result.state = measured.state
  }
  if (result.unverifiedReason || result.measuredCommitCount === 0) {
    result.unverifiedReason ??= "no wizard commits could be measured"
    if (result.state === "checked") result.state = "not_checked"
    // Attribution is unavailable; show the actual branch diff, explicitly labelled as such.
    const paths = await git(input.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", input.baseSha, input.headSha, "--"])
    if (paths.code === 0) { result.files.push(...paths.stdout.toString("utf8").split("\0").filter(Boolean)); result.filesAvailable = true }
    else result.issues.push({ file: "(git)", reason: "changed files could not be listed" })
    result.fileScope = "branch_history"
  }
  result.files = [...new Set(result.files)].sort()
  return result
}

export async function unrecordedCommits(input: { root: string; baseSha: string; headSha: string; wizardCommits: readonly string[]; approvedForeignCommits: readonly string[]; priorHistoryHeads?: readonly string[] }): Promise<Array<{ sha: string; subject: string }> | null> {
  const prior = input.priorHistoryHeads ?? []
  if (![input.baseSha, input.headSha, ...input.wizardCommits, ...input.approvedForeignCommits, ...prior].every(sha => /^[a-f0-9]{40}$/.test(sha))) return null
  const reachable: string[] = []
  for (const sha of prior) if ((await git(input.root, ["merge-base", "--is-ancestor", sha, input.headSha])).code === 0) reachable.push(sha)
  const list = await git(input.root, ["log", "--reverse", "--format=%H%x00%s", "-z", `${input.baseSha}..${input.headSha}`, ...reachable.map(sha => `^${sha}`)])
  if (list.code !== 0) return null
  const fields = list.stdout.toString("utf8").split("\0")
  const known = new Set([...input.wizardCommits, ...input.approvedForeignCommits])
  const result: Array<{ sha: string; subject: string }> = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const sha = fields[at]!.trim()
    if (!/^[a-f0-9]{40}$/.test(sha)) return null
    if (!known.has(sha)) result.push({ sha, subject: fields[at + 1]! })
  }
  return result
}
