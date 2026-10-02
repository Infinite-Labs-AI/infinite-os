// Shared plumbing for lane O4's three steps (`rehearsal`, `review`, `merge`): the run's public facts (keys and
// hosting, read through the bridge), the scanner built from them, the allowlist union, the managed files from
// the edit receipt, and small emit helpers. Nothing here spends a prompt or calls the cloud directly.
import { join } from "node:path"

import type { TagHosting, TagKeys } from "../wizard/contracts/bridge.js"
import type { WizardContext, WizardDeps } from "../wizard/contracts/deps.js"
import type { ChecklistItem, WizardEditRecord } from "../wizard/contracts/jobs.js"
import type { WizardStepId } from "../wizard/contracts/steps.js"
import { MCP_ENV } from "../wizard/contracts/agents.js"
import { INSTALL_MANIFEST_PATH, isPackageOrLockfile } from "../git/commit.js"
import { parseRemote } from "../hosts/index.js"
import { collectEnvLiterals, createScanner, type ScanLiteral, type Scanner } from "./scan.js"

export interface RunFacts {
  keys: TagKeys | null
  hosting: TagHosting | null
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
export async function loadRunFacts(deps: WizardDeps): Promise<RunFacts> {
  const keys = deps.bridge.has("tag.keys.v1") ? await deps.bridge.keys() : null
  const hosting = deps.bridge.has("tag.hosting.v1") ? await deps.bridge.hosting() : null
  const productionHost =
    keys?.infinite.productionHosts[0] ?? hosting?.vercel?.productionDomains[0] ?? hosting?.vercel?.productionAliases[0] ?? null
  return { keys, hosting, productionHost: productionHost ? productionHost.toLowerCase() : null, connectionIds: connectionIdsFrom(keys) }
}

/**
 * The §3g.5 scanner for this run: the repo's `.env*` values (root and app root), the bridge token, the MCP
 * token when this process holds it, with the connection IDs allowed. The wizard never reads the user's
 * session files to build this list (R2-02): the JWT shape covers the desktop bearer.
 */
export function buildScanner(ctx: Pick<WizardContext, "root" | "appRoot">, deps: Pick<WizardDeps, "bridge" | "env">, connectionIds: readonly string[]): Scanner {
  const literals: ScanLiteral[] = [...collectEnvLiterals([...new Set([ctx.root, join(ctx.root, ctx.appRoot)])])]
  const bridgeToken = deps.bridge.descriptor?.token
  if (typeof bridgeToken === "string" && bridgeToken.length >= 8) literals.push({ value: bridgeToken, kind: "bridge_token" })
  const mcpToken = deps.env[MCP_ENV.token]
  if (typeof mcpToken === "string" && mcpToken.length >= 8) literals.push({ value: mcpToken, kind: "mcp_token" })
  return createScanner({ literals, allowedIds: connectionIds })
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
