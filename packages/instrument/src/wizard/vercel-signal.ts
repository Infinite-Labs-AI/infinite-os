// §3y.4: "is this site on Vercel?" without an Infinite Vercel connection. True when ANY of:
// - Infinite hosting is Vercel;
// - the repo is linked locally (`.vercel/project.json` or `.vercel/repo.json`);
// - the repo has at least one deployment by `vercel[bot]` (one `gh api` read per run, cached in state).
// The Vercel project name (to pick a monorepo's preview) comes from hosting, else `.vercel/project.json`
// `projectName`, else the `.vercel/repo.json` project whose `directory` is the app root; else null (one project only).
import { join } from "node:path"

import type { TagHosting } from "./contracts/bridge.js"
import type { WizardContext, WizardDeps, WizardFs } from "./contracts/deps.js"
import { deploymentReader } from "../hosts/github.js"

export interface VercelSignal {
  signal: boolean
  projectName: string | null
}

async function readJson(fs: Pick<WizardFs, "readText">, path: string): Promise<unknown> {
  const text = await fs.readText(path).catch(() => null)
  if (text === null) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const sameDir = (a: string, b: string) => (a === "" ? "." : a.replace(/\/+$/, "")) === (b === "" ? "." : b.replace(/\/+$/, ""))

/** The repo's local Vercel link (files only). `linked` = either file exists (even unreadable). */
export async function localVercelLink(fs: Pick<WizardFs, "readText">, root: string, appRoot: string): Promise<{ linked: boolean; projectName: string | null }> {
  const project = await readJson(fs, join(root, ".vercel", "project.json"))
  const repo = await readJson(fs, join(root, ".vercel", "repo.json"))
  const linked = project !== undefined || repo !== undefined
  const name = (project as { projectName?: unknown } | null | undefined)?.projectName
  if (typeof name === "string" && name.length > 0) return { linked, projectName: name }
  const projects = (repo as { projects?: unknown } | null | undefined)?.projects
  if (Array.isArray(projects)) {
    const match = projects.find((entry) => typeof entry === "object" && entry !== null && typeof (entry as { directory?: unknown }).directory === "string" && sameDir((entry as { directory: string }).directory, appRoot))
    const matchName = (match as { name?: unknown } | undefined)?.name
    if (typeof matchName === "string" && matchName.length > 0) return { linked, projectName: matchName }
  }
  return { linked, projectName: null }
}

/** §3y.4 `vercelSignal`, read once per run (cached in `state.site.vercelSignal` once the run has a site state). */
export async function resolveVercelSignal(ctx: Pick<WizardContext, "root" | "appRoot" | "state">, deps: Pick<WizardDeps, "fs" | "host">, hosting: TagHosting | null): Promise<VercelSignal> {
  const local = await localVercelLink(deps.fs, ctx.root, ctx.appRoot)
  if (hosting?.provider === "vercel" && hosting.vercel) return { signal: true, projectName: hosting.vercel.projectName }
  if (local.linked) return { signal: true, projectName: local.projectName }
  const cached = ctx.state.get().site?.vercelSignal
  if (cached !== undefined) return { signal: cached, projectName: local.projectName }
  const reader = deploymentReader(deps.host)
  const seen = reader ? await reader.vercelDeploymentSeen().catch(() => false) : false
  if (ctx.state.get().site) {
    ctx.state.update((state) => {
      if (state.site) state.site.vercelSignal = seen
    })
    await ctx.state.save()
  }
  return { signal: seen, projectName: local.projectName }
}
