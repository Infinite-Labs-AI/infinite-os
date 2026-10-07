/** Measure the owner's frozen units against the recorded base, before any push. No source is edited here. */
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
  issues: Array<{ file: string; reason: string }>
}
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|mdx?|json)$/i
const metadata = (path: string) => path.startsWith(".infinite/") || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(path)

export async function measureOwnerDiff(input: { root: string; baseSha: string; revision?: string; appRoot?: string }): Promise<OwnerBoundaryMeasurement> {
  const measurement: OwnerBoundaryMeasurement = { state: "not_checked", scope: input.revision ? "commit" : "working_tree", baseSha: input.baseSha, headSha: input.revision ?? "", files: [], issues: [] }
  const fail = (file: string, reason: string) => { measurement.issues.push({ file, reason }); return measurement }
  if (!/^[a-f0-9]{40}$/.test(input.baseSha) || (input.revision && !/^[a-f0-9]{40}$/.test(input.revision))) return fail("(git)", "the recorded base or commit is unavailable")
  const head = await git(input.root, ["rev-parse", "--verify", input.revision ?? "HEAD"])
  if (head.code !== 0) return fail("(git)", "the final commit could not be read")
  measurement.headSha = head.stdout.toString("utf8").trim()
  const base = await git(input.root, ["rev-parse", "--verify", `${input.baseSha}^{commit}`])
  if (base.code !== 0) return fail("(git)", "the recorded base could not be read")
  const names = await git(input.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", input.baseSha, ...(input.revision ? [input.revision] : []), "--"])
  if (names.code !== 0) return fail("(git)", "the final diff could not be read")
  const paths = new Set(names.stdout.toString("utf8").split("\0").filter(Boolean))
  if (!input.revision) {
    const extra = await git(input.root, ["ls-files", "--others", "--exclude-standard", "-z"])
    if (extra.code !== 0) return fail("(git)", "new files could not be read")
    for (const path of extra.stdout.toString("utf8").split("\0").filter(Boolean)) paths.add(path)
  }
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
    if (!SOURCE.test(path)) continue
    measurement.files.push(path)
    const beforeBlob = await blob(input.baseSha, path)
    if (beforeBlob.error) { measurement.state = "not_checked"; fail(path, beforeBlob.error); continue }
    let after: Buffer | null
    if (input.revision) {
      const afterBlob = await blob(input.revision, path)
      if (afterBlob.error) { measurement.state = "not_checked"; fail(path, afterBlob.error); continue }
      after = afterBlob.bytes
    } else {
      const info = await lstat(join(input.root, path)).catch(() => null)
      if (info && !info.isFile()) { measurement.state = "not_checked"; fail(path, "the changed source is not a regular file"); continue }
      try { after = info ? await readFile(join(input.root, path)) : null }
      catch { measurement.state = "not_checked"; fail(path, "the changed source could not be read"); continue }
    }
    const before = beforeBlob.bytes
    if ([before, after].some(bytes => bytes && (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)))) {
      measurement.state = "not_checked"; fail(path, "the changed source could not be decoded"); continue
    }
    const comparison = restoreFrozenUnits(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "")
    if (comparison.changes.length > 0) { measurement.state = "changed"; fail(path, "a consent-bearing top-level unit differs from the recorded base") }
  }
  return measurement
}

export function ownerBoundaryStop(measurement: OwnerBoundaryMeasurement): string {
  return `Nothing pushed: consent/privacy final-diff check ${measurement.state === "changed" ? "found a change" : "could not finish"} in ${measurement.issues.map(issue => issue.file).join(", ") || "(git)"}. These bytes may include owner-authored or earlier edits, so the wizard cannot safely overwrite them. Restore the named owner code yourself, then run npx infinite-tag again.`
}
