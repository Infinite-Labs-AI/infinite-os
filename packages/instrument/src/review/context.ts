// Shared plumbing for lane O4's three steps (`rehearsal`, `review`, `merge`): the run's public facts (keys and
// hosting, read through the bridge), the scanner built from them, the allowlist union, the managed files from
// the edit receipt, and small emit helpers. Nothing here spends a prompt or calls the cloud directly.
import { bridgeFailureCode, hardStopOutcome } from "../bridge/outcomes.js"
import type { WizardCode } from "../wizard/contracts/codes.js"
import { join } from "node:path"

import type { TagHosting, TagKeys } from "../wizard/contracts/bridge.js"
import type { StepOutcome, WizardContext, WizardDeps } from "../wizard/contracts/deps.js"
import type { ChecklistItem, WizardEditRecord } from "../wizard/contracts/jobs.js"
import type { WizardStepId } from "../wizard/contracts/steps.js"
import type { SiteClaimState, SiteState } from "../wizard/contracts/state.js"
import { resolveProductionHost } from "../wizard/site-host.js"
import { MCP_ENV } from "../wizard/contracts/agents.js"
import { INSTALL_MANIFEST_PATH, isPackageOrLockfile } from "../git/commit.js"
import { parseRemote } from "../hosts/index.js"
import { collectEnvLiterals, createScanner, type ScanLiteral, type Scanner } from "./scan.js"
import { readBeforeFactsFile } from "../wizard/handoff/before-facts.js"

export interface RunFacts {
  keys: TagKeys | null
  hosting: TagHosting | null
  /**
   * §3y.2: the run's pending site-file claim (a cloud answer). While it is pending the rehearsal and the real visit
   * expect Infinite's tag with its reserved key (`testExpectFromKeys(keys, claim)`). Absent = none.
   */
  claim?: SiteClaimState | null
  /** §3y.4: the run's cached Vercel signal (Infinite hosting, `.vercel/*`, or a `vercel[bot]` deployment). */
  vercelSignal?: boolean
  /** §3y.4: the Vercel project name from `.vercel/*` (picks a monorepo's preview when Infinite hosting is not Vercel). */
  vercelProject?: string | null
  /** A keys or hosting read failed (not "absent"): the rehearsal is then undetermined (read failed), never guessed. */
  readFailed?: boolean
  /** The production host the rehearsal serves the preview under (site source first, then Vercel's domains). */
  productionHost: string | null
  /** Every public id the connections hold (never a secret). */
  connectionIds: string[]
}

/** The public IDs of the run's connections: allowed in commits and posts, redacted on public repos when not in the diff. */
export function connectionIdsFrom(keys: TagKeys | null): string[] {
  if (!keys) return []
  const ids = [
    ...keys.ga4.streams.map((stream) => stream.measurementId),
    ...keys.meta.pixels.map((pixel) => pixel.pixelId),
    keys.posthog.projectKey,
    keys.infinite.siteSourceKey
  ]
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
}

/**
 * Reads keys and hosting once per step (both public-ID reads; neither returns a secret). The `before` step read
 * them too, but the run state has no field for them (§3d.6), so each O4 step re-reads them here.
 */
export async function loadRunFacts(deps: WizardDeps, site: SiteState | null = null): Promise<RunFacts> {
  let readFailed = false
  // A 402 / signed-out stops the step (`bridgeStop`); any other failed read is "unknown", never a guess.
  const read = async <T>(capability: "tag.keys.v1" | "tag.hosting.v1", fn: () => Promise<T>): Promise<T | null> => {
    if (!deps.bridge.has(capability)) return null
    try {
      return await fn()
    } catch (error) {
      if (bridgeStopCode(error) !== null || bridgeErrorCode(error) === null) throw error
      readFailed = true
      return null
    }
  }
  const keys = await read("tag.keys.v1", () => deps.bridge.keys())
  const hosting = await read("tag.hosting.v1", () => deps.bridge.hosting())
  // §3y.1: one precedence (site source, Vercel's domains, this run's answer or flag); a Vercel alias last, as before.
  const productionHost = resolveProductionHost({ keys, hosting, site }).host ?? hosting?.vercel?.productionAliases[0] ?? null
  const claim = site?.claim?.state === "pending_proof" ? site.claim : null
  const connectionIds = [...new Set([...connectionIdsFrom(keys), ...(claim ? [claim.siteSourceKey] : [])])]
  return {
    keys,
    hosting,
    productionHost: productionHost ? productionHost.toLowerCase() : null,
    connectionIds,
    ...(claim ? { claim } : {}),
    ...(site?.vercelSignal !== undefined ? { vercelSignal: site.vercelSignal } : {}),
    ...(readFailed ? { readFailed } : {})
  }
}

/**
 * The bridge error code of a thrown error (lane O2's `BridgeError {status, code, retryable}`), or null when it is
 * not a bridge error. Duck-typed, so this lane does not import O2's client.
 */
export function bridgeErrorCode(error: unknown): string | null {
  return bridgeFailureCode(error)
}

/** The HARD bridge failures that stop the run whatever the step was doing (§3z.4, `bridge/outcomes.ts`). */
export function bridgeStopCode(error: unknown): WizardCode | null {
  const outcome = hardStopOutcome(error)
  return outcome && outcome.kind !== "ok" && outcome.kind !== "skipped" ? outcome.code : null
}

/** A step's hard bridge failure as its outcome (§3z.4); anything else rethrows or degrades. */
export function bridgeStop(error: unknown): StepOutcome | null {
  return hardStopOutcome(error)
}

/**
 * A run PATCH or GA4 key-event call that is not a stop: one retry when the bridge says it is retryable, then a
 * warning line (the step goes on; the merge step PATCHes the run again).
 */
export async function bestEffortBridge(ctx: WizardContext, step: WizardStepId, what: string, call: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await call()
      return true
    } catch (error) {
      if (bridgeStopCode(error) !== null || bridgeErrorCode(error) === null) throw error
      const retryable = (error as { retryable?: unknown }).retryable === true
      if (attempt === 1 && retryable) continue
      sub(ctx, step, `Could not ${what} (${bridgeErrorCode(error)}); the run goes on`, "warn")
      return false
    }
  }
  return false
}

/**
 * The §3g.5 scanner for this run: the repo's `.env*` values (root and app root), the bridge token, the MCP
 * token when this process holds it, with the connection IDs allowed. The wizard never reads the user's
 * session files to build this list (R2-02): the JWT shape covers the desktop bearer.
 */
export function buildScanner(
  ctx: Pick<WizardContext, "root" | "appRoot">,
  deps: Pick<WizardDeps, "bridge" | "env"> & { agents?: Pick<WizardDeps["agents"], "secretLiterals"> },
  connectionIds: readonly string[]
): Scanner {
  const literals: ScanLiteral[] = [...collectEnvLiterals([...new Set([ctx.root, join(ctx.root, ctx.appRoot)])])]
  let bridgeToken: unknown = null
  try {
    bridgeToken = deps.bridge.descriptor?.token
  } catch {
    // No descriptor readable now: the runner's own list still carries the token it was given.
  }
  if (typeof bridgeToken === "string" && bridgeToken.length >= 8) literals.push({ value: bridgeToken, kind: "bridge_token" })
  const mcpToken = deps.env[MCP_ENV.token]
  if (typeof mcpToken === "string" && mcpToken.length >= 8) literals.push({ value: mcpToken, kind: "mcp_token" })
  // B5: the runner's own secret literals (every MCP token its turns used, and the bridge token).
  for (const literal of deps.agents?.secretLiterals?.() ?? []) {
    if (literal.length >= 8 && !literals.some((entry) => entry.value === literal)) literals.push({ value: literal, kind: "mcp_token" })
  }
  return createScanner({ literals, allowedIds: connectionIds })
}

/**
 * R4-9 / LF4-P3-5: the public ids the run READ from the site (not only its connections'): every literal id the census
 * found in the site's code, the ids the dry load saw leaving (GA4 measurement ids, Meta pixel ids), and the ids the
 * real visit read. They are public (in the page's own HTML), so neither they nor their masked form is ever a "phone":
 * every scanner that writes a reason (rehearsal, jobs, done) allows them. The exact-masked-form rule stays, so a real
 * phone number is still redacted.
 */
export async function runPublicIds(ctx: Pick<WizardContext, "root" | "runId" | "state">, deps: Pick<WizardDeps, "fs">): Promise<string[]> {
  const runId = ctx.runId ?? ctx.state.get().runId
  const before = await readBeforeFactsFile(deps.fs, ctx.root, runId)
  const ids: string[] = []
  for (const entry of before?.facts.census.entries ?? []) if (typeof entry.id === "string" && entry.id !== "") ids.push(entry.id)
  const dry = before?.facts.dryLive
  for (const event of dry?.ga4?.events ?? []) if (typeof event.tid === "string" && event.tid !== "") ids.push(event.tid)
  for (const tr of dry?.meta?.tr ?? []) if (typeof tr.pixelId === "string" && tr.pixelId !== "") ids.push(tr.pixelId)
  for (const tool of ctx.state.get().proof?.tools ?? []) ids.push(...tool.ids)
  return [...new Set(ids)]
}

/** The union of the run's job allowlists (repo-root relative). */
export function allowlistUnion(jobs: readonly ChecklistItem[]): string[] {
  return [...new Set(jobs.flatMap((job) => [...job.allow.files, ...job.allow.create]))].sort()
}

interface ManifestLike {
  files?: unknown
  configOwnership?: unknown
  serverLane?: { middleware?: unknown; module?: unknown; brief?: unknown; guide?: unknown; created?: unknown } | null
  edits?: unknown
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/**
 * From `.infinite/install.json`: the files the wizard's own install manages, and the package.json / lockfiles
 * the npm job recorded edits for (§3g.1: those ARE staged, because the PR imports the installed package).
 */
export async function manifestFiles(deps: Pick<WizardDeps, "fs">, root: string): Promise<{ managed: string[]; npmFiles: string[] }> {
  const text = await deps.fs.readText(join(root, INSTALL_MANIFEST_PATH))
  if (text === null) return { managed: [], npmFiles: [] }
  let manifest: ManifestLike
  try {
    manifest = JSON.parse(text) as ManifestLike
  } catch {
    return { managed: [], npmFiles: [] }
  }
  const managed = new Set<string>(strings(manifest.files))
  if (manifest.configOwnership && typeof manifest.configOwnership === "object") {
    for (const key of Object.keys(manifest.configOwnership)) managed.add(key)
  }
  const lane = manifest.serverLane ?? null
  if (lane) {
    for (const value of [lane.middleware, lane.module, lane.brief, lane.guide]) if (typeof value === "string") managed.add(value)
    for (const value of strings(lane.created)) managed.add(value)
  }
  const npmFiles = new Set<string>()
  const edits = Array.isArray(manifest.edits) ? (manifest.edits as Array<Partial<WizardEditRecord>>) : []
  for (const edit of edits) {
    if (typeof edit.file !== "string") continue
    if (isPackageOrLockfile(edit.file)) {
      // Only the wizard's own (npm job) edits; an agent may never touch these files.
      if (edit.by === "wizard") npmFiles.add(edit.file)
      continue
    }
    if (edit.by === "wizard") managed.add(edit.file)
  }
  for (const path of [...managed]) if (isPackageOrLockfile(path)) managed.delete(path)
  return { managed: [...managed].sort(), npmFiles: [...npmFiles].sort() }
}

export function sub(ctx: WizardContext, step: WizardStepId, text: string, tone: "ok" | "warn" | "info" | "pending" = "info"): void {
  ctx.emit.emit("step.sub", { step, text: text.slice(0, 120), tone })
}

export function status(ctx: WizardContext, step: WizardStepId, text: string): void {
  ctx.emit.emit("step.status", { step, text: text.slice(0, 160) })
}

/** The repo's normalised label (`host/owner/repo`, credentials stripped), or the folder name. */
export function repoLabelFrom(remoteUrl: string | null, root: string): string {
  const parsed = remoteUrl ? parseRemote(remoteUrl) : null
  return parsed?.label ?? root.split("/").filter(Boolean).pop() ?? "this repo"
}

/** §3a.9.4 engine invariant: no state-changing bridge verb while an agent child is alive. */
export function assertNoAgentAlive(deps: Pick<WizardDeps, "agents">, verb: string): void {
  if (deps.agents.isAgentAlive()) throw new Error(`engine invariant: ${verb} while an agent is running`)
}

/** The run id the O4 steps need (the `agent` step created it). */
export function requireRunId(ctx: WizardContext): string | null {
  return ctx.runId ?? ctx.state.get().runId ?? null
}
