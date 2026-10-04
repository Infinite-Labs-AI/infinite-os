// §3y.4 / IO-6: the rehearsal runs from the GitHub preview when Infinite has no Vercel connection but the repo shows
// a Vercel signal (a `.vercel/` link or a `vercel[bot]` deployment); with no signal it is undetermined with the new
// words. Fakes only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fakeBridge, fakeHosting, fakeKeys, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import { BridgeError } from "../bridge/errors.js"
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

  it("review P1-2 / P2-1: the desktop REFUSES the preview (no Vercel connection) → undetermined, said as a refusal (no claim: 'preview_unconfirmed'; a pending claim: 'preview_unserved'); the preview's own load is not asked", async () => {
    const root = repo()
    const ctx = testContext({ root, state: initialState({ runId: RUN_ID }) })
    const bridge = fakeBridge({ hosting: { provider: "none", vercel: null } })
    const sent: string[] = []
    bridge.startTest = async (request) => {
      sent.push(request.mode)
      throw new BridgeError({ status: 400, code: "invalid_request", message: "The preview is not this site's Vercel project.", retryable: false, field: "rehearsal.previewOrigin" })
    }
    const deps = testDeps({ bridge, agents: {} as AgentRunner, git: {} as GitOps, host: host("https://fresh-acme-git-x.vercel.app") })
    const outcome = await rehearse(ctx, deps, { step: "rehearsal", runId: RUN_ID, head: HEAD, facts: facts({ vercelSignal: true }), approvedConversions: [], evidenceUrls: [], consentRequired: false, ghReady: true })
    expect(outcome).toMatchObject({ state: "undetermined", reason: "preview_unconfirmed", previewUrl: "https://fresh-acme-git-x.vercel.app" })
    const text = rehearsalLines(outcome).map((line) => line.text).join("\n")
    expect(text).toBe("Rehearsal: undetermined (Infinite can't confirm the preview is this site's without a Vercel connection)")
    expect(text).not.toContain("did not finish")
    expect(sent).toEqual(["rehearsal"])
    // With a pending claim the desktop checked the preview for its proof file: that is what it did not find.
    const claimed = await rehearse(testContext({ root: repo(), state: initialState({ runId: RUN_ID }) }), deps, {
      step: "rehearsal",
      runId: RUN_ID,
      head: HEAD,
      facts: facts({ vercelSignal: true, claim: { hosts: ["fresh-acme.com"], siteSourceKey: "site_fa4e000000000000000000000000c1a1", collectPath: "/infinite/ledger", consentStorageKey: "infinite_analytics_consent", proofPath: "/.well-known/infinite-site-verification.txt", state: "pending_proof" } }),
      approvedConversions: [],
      evidenceUrls: [],
      consentRequired: false,
      ghReady: true
    })
    expect(claimed.reason).toBe("preview_unserved")
    expect(rehearsalLines(claimed)[0]!.text).toBe("Rehearsal: undetermined (the preview did not serve this pull request's proof file, e.g. it is protected)")
  })

  it("review P2-1: a refusal of a dry_live target (targets.0.url) with Vercel connected → 'preview_refused'; any OTHER 4xx stays test_error", async () => {
    const vercelHosting = { provider: "vercel" as const, vercel: { ...fakeHosting().vercel!, previewProtection: "none" as const } }
    const run = async (error: BridgeError) => {
      const ctx = testContext({ root: repo(), state: initialState({ runId: RUN_ID }) })
      const bridge = fakeBridge({ hosting: vercelHosting })
      bridge.startTest = async () => {
        throw error
      }
      const deps = testDeps({ bridge, agents: {} as AgentRunner, git: {} as GitOps, host: host("https://acme-store-git-x.vercel.app") })
      return rehearse(ctx, deps, { step: "rehearsal", runId: RUN_ID, head: HEAD, facts: facts({ hosting: vercelHosting }), approvedConversions: [], evidenceUrls: [], consentRequired: false, ghReady: true })
    }
    const refused = await run(new BridgeError({ status: 400, code: "invalid_request", message: "x", retryable: false, field: "targets.0.url" }))
    expect(refused.reason).toBe("preview_refused")
    expect(rehearsalLines(refused)[0]!.text).toBe("Rehearsal: undetermined (Infinite refused the preview: it is not this site's Vercel project)")
    // An invalid_request about another field is not a preview refusal.
    expect((await run(new BridgeError({ status: 400, code: "invalid_request", message: "x", retryable: false, field: "spaNavigation" }))).reason).toBe("test_error")
    expect((await run(new BridgeError({ status: 400, code: "invalid_request", message: "x", retryable: false }))).reason).toBe("test_error")
    // The terminal cuts sub lines at 120 characters: each refusal line fits whole.
    for (const reason of ["preview_unconfirmed", "preview_unserved", "preview_refused"] as const) {
      const text = rehearsalLines({ ...refused, reason })[0]!.text
      expect(text.length, text).toBeLessThanOrEqual(120)
    }
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
