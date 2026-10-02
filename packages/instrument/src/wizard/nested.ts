// Nested-agent mode's `jobs` step (§3d.7, R2-14). The wizard was launched by an agent (a nesting marker
// is set, no TTY, `--json`): no agent is spawned. Instead:
// 1. HANDOFF: the agent jobs go out as `job.seeded` events with their brief, the tree is snapshotted
//    (outside the repo and outside $TMPDIR), and the run parks (exit 3) for the parent agent to do them.
// 2. RESUME (`npx infinite-tag --resume --json`): the same diff gate as the fence and the post-turn gate
//    run on the parent agent's edits. As in the fence (§3f.6), every rejected edit is REVERTED to its
//    snapshot (or HEAD) bytes before any build or T0, with the parent agent's bytes kept aside under the
//    snapshot dir and reported: an edit outside the seeded jobs' allowlists (or on a globally denied
//    path, or a deletion), a hunk touching a consent call (it blocks its job) and a post-turn gate hit (it
//    blocks its job). Only allowlisted, clean paths are staged, so the S / B / T0 checks run on exactly
//    the tree the commit will hold. Then the wizard's own checks decide each item's state (claims are not
//    needed; the parent agent can only change files).
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { promises as fsp } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { WIZARD_TOKEN_SCRATCH_HOME_RELATIVE } from "./contracts/agents.js"
import type { StepOutcome, WizardContext, WizardDeps } from "./contracts/deps.js"
import {
  GLOBAL_DENY_GLOBS,
  type CheckResult,
  type ChecklistItem,
  type CheckTier,
  type TurnDiff
} from "./contracts/jobs.js"
import { WIZARD_PATHS } from "./contracts/state.js"
import { diffLines, matchesAnyGlob } from "./text-diff.js"

export const NESTED_SNAPSHOT_SCHEMA = "infinite-tag.nested-snapshot.v1" as const
export const NESTED_BRIEF_PATH = ".infinite/wizard/nested-brief.md"
/** The tiers the wizard runs on resume before anything is committed (live tiers run later in the run). */
export const NESTED_RESUME_TIERS: readonly CheckTier[] = ["S", "B", "T0"]

/** `gtag('consent', …)` and the common CMP APIs: a hunk touching one blocks its job (§3e.2). */
export const CONSENT_CALL_PATTERN =
  /gtag\s*\(\s*['"`]consent['"`]|__tcfapi|__cmp\s*\(|OneTrust|Optanon|Cookiebot|CookieConsent|UC_UI|usercentrics|klaro\.|didomi/i

interface SnapshotManifest {
  schema: typeof NESTED_SNAPSHOT_SCHEMA
  headSha: string
  createdAt: string
  itemIds: string[]
  /** Files that differed from HEAD when the jobs were handed off: path → sha256 of the copy (null = absent). */
  dirty: Record<string, string | null>
}

function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024
  })
  return { ok: result.status === 0, stdout: result.stdout ?? "" }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Every path that differs from HEAD (staged, unstaged, untracked; not ignored), repo-relative. */
export function dirtyPaths(root: string): string[] {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (!status.ok) throw new Error("git status failed in the repo")
  const out: string[] = []
  const entries = status.stdout.split("\0")
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    out.push(entry.slice(3))
    // A rename/copy carries its source path as the next entry.
    if (code.includes("R") || code.includes("C")) {
      const source = entries[index + 1]
      if (source) out.push(source)
      index += 1
    }
  }
  return [...new Set(out)]
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") return null
    throw error
  }
}

/** `~/Library/Caches/infinite-tag/snapshots/<run>/nested` (outside the repo and outside $TMPDIR). */
export function nestedSnapshotDir(env: WizardDeps["env"], runKey: string): string {
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir()
  return join(home, WIZARD_TOKEN_SCRATCH_HOME_RELATIVE, "snapshots", runKey, "nested")
}

function agentItems(jobs: readonly ChecklistItem[]): ChecklistItem[] {
  return jobs.filter((item) => item.owner === "agent" && (item.state === "pending" || item.state === "claimed"))
}

function allowedFor(items: readonly ChecklistItem[], path: string, isNew: boolean): ChecklistItem[] {
  return items.filter((item) => item.allow.files.includes(path) || (isNew && item.allow.create.includes(path)))
}

async function handoff(ctx: WizardContext, deps: WizardDeps, items: ChecklistItem[]): Promise<StepOutcome> {
  const state = ctx.state.get()
  const runKey = state.runId ?? state.displayId
  const dir = nestedSnapshotDir(deps.env, runKey)
  await fsp.mkdir(join(dir, "files"), { recursive: true, mode: 0o700 })
  await fsp.chmod(dir, 0o700)
  const head = git(ctx.root, ["rev-parse", "HEAD"])
  if (!head.ok) throw new Error("git rev-parse HEAD failed")
  const dirty: Record<string, string | null> = {}
  for (const path of dirtyPaths(ctx.root)) {
    if (path.startsWith(`${WIZARD_PATHS.dir}/`)) continue
    const content = await readOrNull(join(ctx.root, path))
    dirty[path] = content === null ? null : sha256(content)
    if (content !== null) {
      const copy = join(dir, "files", path)
      await fsp.mkdir(dirname(copy), { recursive: true, mode: 0o700 })
      await fsp.writeFile(copy, content, { mode: 0o600 })
    }
  }
  const manifest: SnapshotManifest = {
    schema: NESTED_SNAPSHOT_SCHEMA,
    headSha: head.stdout.trim(),
    createdAt: ctx.now().toISOString(),
    itemIds: items.map((item) => item.id),
    dirty
  }
  await fsp.writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

  const brief = deps.registry.brief(items)
  await deps.fs.writeTextAtomic(join(ctx.root, NESTED_BRIEF_PATH), `${brief}\n`, 0o600)
  for (const item of items) ctx.emit.emit("job.seeded", { item })
  ctx.state.update((draft) => {
    draft.snapshot = { dir }
  })
  await ctx.state.save()
  return {
    kind: "parked",
    code: "INF_WIZ_NEEDS_ANSWERS",
    reason: `${items.length} agent job${items.length === 1 ? "" : "s"} handed to you (the agent that ran the wizard); the brief is in ${NESTED_BRIEF_PATH}.`,
    resumeHint: "Do the jobs (only the files each job lists), then run npx infinite-tag --resume --json."
  }
}

async function originalContent(ctx: WizardContext, dir: string, manifest: SnapshotManifest, path: string): Promise<string | null> {
  if (path in manifest.dirty) {
    if (manifest.dirty[path] === null) return null
    return readOrNull(join(dir, "files", path))
  }
  const blob = git(ctx.root, ["show", `${manifest.headSha}:${path}`])
  return blob.ok ? blob.stdout : null
}

export interface NestedGateReport {
  staged: string[]
  /** Changed paths outside every seeded job's allowlist (or globally denied, or deleted): reverted. */
  outsideAllowlist: string[]
  /** Paths whose hunks touched a consent call (reverted; their jobs are blocked). */
  consentTouched: string[]
  /** Paths the post-turn gate flagged (reverted; their jobs are blocked). */
  gateHits: string[]
  /** Where the parent agent's bytes of every reverted path were kept (`<snapshot>/rejected/<path>`). */
  rejectedDir: string
}

/** Keeps the parent agent's bytes aside, then puts the snapshot (or HEAD) bytes back; a new file is removed. */
async function revertToSnapshot(root: string, rejectedDir: string, path: string, before: string | null, after: string | null): Promise<void> {
  if (after !== null) {
    const copy = join(rejectedDir, path)
    await fsp.mkdir(dirname(copy), { recursive: true, mode: 0o700 })
    await fsp.writeFile(copy, after, { mode: 0o600 })
  }
  const target = join(root, path)
  if (before === null) {
    await fsp.rm(target, { force: true })
  } else {
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.writeFile(target, before)
  }
}

async function resume(ctx: WizardContext, deps: WizardDeps, dir: string): Promise<StepOutcome> {
  const manifestText = await readOrNull(join(dir, "manifest.json"))
  if (manifestText === null) {
    throw new Error(`The nested-mode snapshot is missing (${dir}); run npx infinite-tag again from the start.`)
  }
  const manifest = JSON.parse(manifestText) as SnapshotManifest
  if (manifest.schema !== NESTED_SNAPSHOT_SCHEMA) throw new Error("The nested-mode snapshot has another schema.")
  const state = ctx.state.get()
  const seeded = state.jobs.filter((item) => manifest.itemIds.includes(item.id))

  const candidates = new Set([...dirtyPaths(ctx.root), ...Object.keys(manifest.dirty)])
  const report: NestedGateReport = { staged: [], outsideAllowlist: [], consentTouched: [], gateHits: [], rejectedDir: join(dir, "rejected") }
  const contents = new Map<string, { before: string | null; after: string | null }>()
  const blocked = new Map<string, { reason: "consent_touched" | "agent_blocked"; note: string }>()
  const diff: TurnDiff = { files: [] }
  const ownersByPath = new Map<string, ChecklistItem[]>()

  for (const path of [...candidates].sort()) {
    if (path.startsWith(`${WIZARD_PATHS.dir}/`)) continue
    const before = await originalContent(ctx, dir, manifest, path)
    const after = await readOrNull(join(ctx.root, path))
    if (before === after) continue
    contents.set(path, { before, after })
    const owners = matchesAnyGlob(path, GLOBAL_DENY_GLOBS) ? [] : allowedFor(seeded, path, before === null)
    if (owners.length === 0 || after === null) {
      // Outside the allowlist, globally denied, or a deletion (no v1 job deletes a file): reverted below.
      report.outsideAllowlist.push(path)
      continue
    }
    const change = diffLines(before, after)
    const touchesConsent = [...change.added, ...change.removed].some((line) => CONSENT_CALL_PATTERN.test(line.text))
    if (touchesConsent) {
      report.consentTouched.push(path)
      for (const owner of owners) blocked.set(owner.id, { reason: "consent_touched", note: `${path} touches a consent call; left unstaged` })
      continue
    }
    diff.files.push({ path, added: change.added, removed: change.removed })
    ownersByPath.set(path, owners)
  }

  // The post-turn gate (§3f.9) on what is left, before any build or T0.
  const connectionIds = await connectionIdsFor(deps)
  const gate = diff.files.length > 0 ? await deps.checks.turnGate(diff, { connectionIds }) : []
  const hitPaths = new Set<string>()
  for (const result of gate) {
    if (result.state !== "problem") continue
    for (const evidence of result.evidence ?? []) if ("file" in evidence) hitPaths.add(evidence.file)
    if (!result.evidence?.some((evidence) => "file" in evidence)) for (const file of diff.files) hitPaths.add(file.path)
  }
  for (const path of hitPaths) {
    report.gateHits.push(path)
    for (const owner of ownersByPath.get(path) ?? []) {
      blocked.set(owner.id, { reason: "agent_blocked", note: `${path}: the wizard's safety check flagged this edit; reverted` })
    }
  }
  // Every rejected edit goes back to its snapshot bytes BEFORE any build or T0 (§3f.6, §3a.9.5): no check
  // may evaluate code the gate rejected, and the checks see exactly what the commit will hold.
  for (const path of [...new Set([...report.outsideAllowlist, ...report.consentTouched, ...report.gateHits])]) {
    const change = contents.get(path)
    if (change) await revertToSnapshot(ctx.root, report.rejectedDir, path, change.before, change.after)
  }
  report.staged = diff.files.map((file) => file.path).filter((path) => !hitPaths.has(path))
  if (report.staged.length > 0) await deps.git.stage(report.staged)

  // The wizard's own checks decide (S, B, T0); a blocked item is not checked.
  const runId = state.runId
  const touched = new Set(report.staged)
  const checkable = seeded.filter((item) => !blocked.has(item.id) && item.allow.files.concat(item.allow.create).some((file) => touched.has(file)))
  const results: CheckResult[] = []
  for (const item of checkable) {
    for (const tier of NESTED_RESUME_TIERS) {
      for (const spec of deps.registry.checksFor(item, tier)) {
        const result = await deps.checks.run(spec.checkId, { item, root: ctx.root, appRoot: ctx.appRoot, runId })
        results.push(...(Array.isArray(result) ? result : [result]))
      }
    }
  }
  const checked = runId ? deps.registry.apply(checkable, results, runId) : checkable
  const byId = new Map(checked.map((item) => [item.id, item]))
  ctx.state.update((draft) => {
    draft.jobs = draft.jobs.map((item) => {
      const block = blocked.get(item.id)
      if (block) return { ...item, state: "blocked", blockedReason: block.reason }
      return byId.get(item.id) ?? item
    })
    draft.snapshot = null
  })
  await ctx.state.save()
  for (const item of ctx.state.get().jobs.filter((job) => manifest.itemIds.includes(job.id))) {
    const block = blocked.get(item.id)
    ctx.emit.emit("job.state", { itemId: item.id, state: item.state, by: "wizard", ...(block ? { note: block.note } : {}) })
  }
  const home = deps.env.HOME && deps.env.HOME.trim() !== "" ? deps.env.HOME : homedir()
  const keptIn = report.rejectedDir.startsWith(`${home}/`) ? `~${report.rejectedDir.slice(home.length)}` : report.rejectedDir
  for (const path of report.outsideAllowlist) {
    ctx.emit.emit("step.sub", { step: "jobs", text: `Undone (outside the jobs' files): ${path}; your version is in ${keptIn}`, tone: "warn" })
  }
  for (const path of [...report.consentTouched, ...report.gateHits]) {
    ctx.emit.emit("step.sub", { step: "jobs", text: `Undone (blocked by the wizard's checks): ${path}; your version is in ${keptIn}`, tone: "warn" })
  }
  const done = ctx.state.get().jobs.filter((job) => manifest.itemIds.includes(job.id) && job.state !== "pending" && job.state !== "blocked" && job.state !== "failed").length
  const parts = [`${done} of ${seeded.length} jobs pass the wizard's checks`]
  if (blocked.size > 0) parts.push(`${blocked.size} blocked`)
  const undone = report.outsideAllowlist.length + report.consentTouched.length + report.gateHits.length
  if (undone > 0) parts.push(`${undone} edit(s) undone (kept in ${keptIn})`)
  return { kind: "ok", status: parts.join(" · ") }
}

async function connectionIdsFor(deps: WizardDeps): Promise<string[]> {
  if (!deps.bridge.has("tag.keys.v1")) return []
  const keys = await deps.bridge.keys()
  const ids: string[] = []
  for (const stream of keys.ga4.streams) ids.push(stream.measurementId)
  if (keys.posthog.projectKey) ids.push(keys.posthog.projectKey)
  for (const pixel of keys.meta.pixels) ids.push(pixel.pixelId)
  if (keys.infinite.siteSourceKey) ids.push(keys.infinite.siteSourceKey)
  return ids
}

/** The engine runs this instead of the `jobs` step in nested mode. */
export async function runNestedJobsHandoff(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const state = ctx.state.get()
  if (state.snapshot) return resume(ctx, deps, state.snapshot.dir)
  const items = agentItems(state.jobs)
  if (items.length === 0) return { kind: "ok", status: "No agent jobs for this site." }
  return handoff(ctx, deps, items)
}
