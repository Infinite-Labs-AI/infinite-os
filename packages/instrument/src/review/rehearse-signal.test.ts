// §3y.4 / IO-6: the rehearsal runs from the GitHub preview when Infinite has no Vercel connection but the repo shows
// a Vercel signal (a `.vercel/` link or a `vercel[bot]` deployment); with no signal it is undetermined with the new
// words. Fakes only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fakeBridge, fakeKeys, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import type { GitHostAdapter, GitOps } from "../wizard/contracts/git-host.js"
import type { AgentRunner } from "../wizard/contracts/agents.js"
import { localVercelLink, resolveVercelSignal } from "../wizard/vercel-signal.js"
import { rehearsalLines, rehearse } from "./rehearse.js"
import type { RunFacts } from "./context.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "rehearse-signal-"))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const HEAD = "e".repeat(40)

function host(preview: string | null, vercelSeen = true): GitHostAdapter & { projects: Array<string | null> } {
  const projects: Array<string | null> = []
  return {
    kind: "github",
    projects,
    setPreviewProject: (name: string | null) => projects.push(name),
    previewUrl: async () => preview,
    productionDeployment: async () => ({ state: "not_found" as const }),
    latestProductionDeployment: async () => null,
    vercelDeploymentSeen: async () => vercelSeen,
    readThreadDetails: async () => []
  } as unknown as GitHostAdapter & { projects: Array<string | null> }
}

function facts(over: Partial<RunFacts>): RunFacts {
  return { keys: fakeKeys(), hosting: { provider: "none", vercel: null }, productionHost: "fresh-acme.com", connectionIds: [], ...over }
}

async function rehearseWith(runFacts: RunFacts, gitHost: GitHostAdapter) {
  const root = repo()
  const ctx = testContext({ root, state: initialState({ runId: RUN_ID }) })
  const deps = testDeps({ bridge: fakeBridge({ hosting: { provider: "none", vercel: null } }), agents: {} as AgentRunner, git: {} as GitOps, host: gitHost })
  return rehearse(ctx, deps, { step: "rehearsal", runId: RUN_ID, head: HEAD, facts: runFacts, approvedConversions: [], evidenceUrls: [], consentRequired: false, ghReady: true })
}

describe("the rehearsal gate without an Infinite Vercel connection (§3y.4)", () => {
  it("a Vercel signal → the preview comes from GitHub Deployments and the rehearsal runs (graded), the project from .vercel", async () => {
    const gitHost = host("https://fresh-acme-git-x.vercel.app")
    const outcome = await rehearseWith(facts({ vercelSignal: true, vercelProject: "fresh-acme" }), gitHost)
    expect(outcome.state).toBe("graded")
    expect(outcome.previewUrl).toBe("https://fresh-acme-git-x.vercel.app")
    expect(gitHost.projects).toEqual(["fresh-acme"])
  })

  it("NEGATIVE: no signal at all → undetermined 'not_vercel', worded 'no Vercel preview found for this site'", async () => {
    const outcome = await rehearseWith(facts({ vercelSignal: false }), host("https://x.vercel.app"))
    expect(outcome).toMatchObject({ state: "undetermined", reason: "not_vercel" })
    expect(rehearsalLines(outcome).map((line) => line.text).join("\n")).toContain("Rehearsal: undetermined (no Vercel preview found for this site)")
  })
})

describe("vercelSignal (read once per run)", () => {
  it("a local .vercel/project.json links the repo and names the project; repo.json picks the app root's project", async () => {
    expect(await localVercelLink(nodeFs, repo({ ".vercel/project.json": JSON.stringify({ projectName: "smoke-site" }) }), ".")).toEqual({ linked: true, projectName: "smoke-site" })
    const mono = repo({ ".vercel/repo.json": JSON.stringify({ projects: [{ name: "docs", directory: "apps/docs" }, { name: "web", directory: "apps/web" }] }) })
    expect(await localVercelLink(nodeFs, mono, "apps/web")).toEqual({ linked: true, projectName: "web" })
    expect(await localVercelLink(nodeFs, repo(), ".")).toEqual({ linked: false, projectName: null })
  })

  it("a vercel[bot] deployment is the signal when nothing is linked locally, and the answer is cached in state", async () => {
    const root = repo()
    const ctx = testContext({ root, state: initialState({ runId: RUN_ID, site: { productionHost: "fresh-acme.com", source: "answer", decidedAt: "t" } }) })
    let reads = 0
    const gitHost = { ...host(null), vercelDeploymentSeen: async () => (reads += 1, true) } as unknown as GitHostAdapter
    expect(await resolveVercelSignal(ctx, { fs: nodeFs, host: gitHost }, { provider: "none", vercel: null })).toEqual({ signal: true, projectName: null })
    expect(await resolveVercelSignal(ctx, { fs: nodeFs, host: gitHost }, { provider: "none", vercel: null })).toEqual({ signal: true, projectName: null })
    expect(reads).toBe(1)
    expect(ctx.state.get().site?.vercelSignal).toBe(true)
  })
})

const nodeFs = {
  readText: async (path: string) => {
    try {
      return (await import("node:fs")).readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  writeTextAtomic: async () => undefined,
  exists: async () => false,
  mkdirp: async () => undefined
}
