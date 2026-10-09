// P0-2: Vercel's deployment protection answers an anonymous request with a 302 to its login (or a 401), so the
// desktop refuses the preview origin and every in-PR cell used to read "unknown" under a reason that blamed a missing
// proof file. The wizard now asks the preview first, without credentials and without following redirects: a login
// answer is `preview_protected`, said in ONE plain line, and the cells read "not tried (previews need a login)".
// Fakes only (a fake fetch, a fake bridge).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fakeBridge, fakeKeys, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import type { AgentRunner } from "../wizard/contracts/agents.js"
import type { GitHostAdapter, GitOps } from "../wizard/contracts/git-host.js"
import type { RunFacts } from "./context.js"
import {
  isVercelLoginAnswer,
  PREVIEW_LOGIN_CELL,
  PREVIEW_LOGIN_LINE,
  PREVIEW_LOGIN_PROBE_MS,
  previewNeedsLogin,
  rehearsalCells,
  rehearsalLines,
  rehearse
} from "./rehearse.js"

const PREVIEW = "https://fresh-acme-git-x-team.vercel.app"
const PROOF = `${PREVIEW}/.well-known/infinite-site-verification.txt`
const HEAD = "e".repeat(40)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Answer = { status: number; location?: string } | "network_error"

/** A fake fetch answering per URL; it records what was asked and how. */
function fakeFetch(answers: Record<string, Answer>): typeof fetch & { asked: Array<{ url: string; init: RequestInit | undefined }> } {
  const asked: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    asked.push({ url, init })
    const answer = answers[url] ?? { status: 200 }
    if (answer === "network_error") throw new TypeError("fetch failed")
    return new Response(answer.status === 401 ? "Authentication Required" : null, { status: answer.status, headers: answer.location ? { location: answer.location } : {} })
  }) as typeof fetch & { asked: typeof asked }
  fn.asked = asked
  return fn
}

function host(preview: string | null): GitHostAdapter {
  return {
    kind: "github",
    setPreviewProject: () => undefined,
    previewUrl: async () => preview,
    productionDeployment: async () => ({ state: "not_found" as const }),
    latestProductionDeployment: async () => null,
    vercelDeploymentSeen: async () => true,
    readThreadDetails: async () => []
  } as unknown as GitHostAdapter
}

function facts(): RunFacts {
  return { keys: fakeKeys(), hosting: { provider: "none", vercel: null }, productionHost: "fresh-acme.com", connectionIds: [], vercelSignal: true }
}

async function rehearseWith(fetchFn: typeof fetch | undefined) {
  const root = mkdtempSync(join(tmpdir(), "rehearse-login-"))
  roots.push(root)
  const ctx = testContext({ root, state: initialState({ runId: RUN_ID }) })
  const bridge = fakeBridge({ hosting: { provider: "none", vercel: null } })
  const modes: string[] = []
  const startTest = bridge.startTest.bind(bridge)
  bridge.startTest = async (request) => {
    modes.push(request.mode)
    return startTest(request)
  }
  const deps = testDeps({ bridge, agents: {} as AgentRunner, git: {} as GitOps, host: host(PREVIEW) })
  if (fetchFn) deps.fetch = fetchFn
  const outcome = await rehearse(ctx, deps, { step: "rehearsal", runId: RUN_ID, head: HEAD, facts: facts(), approvedConversions: [], evidenceUrls: [], consentRequired: false, ghReady: true })
  return { outcome, modes }
}

describe("Vercel's login answer", () => {
  it("a 401, or a redirect to vercel.com/sso-api, any *.vercel.com, or the deployment's own /_vercel/sso", () => {
    expect(isVercelLoginAnswer(401, null, PREVIEW)).toBe(true)
    expect(isVercelLoginAnswer(302, `https://vercel.com/sso-api?url=${encodeURIComponent(PREVIEW)}`, PREVIEW)).toBe(true)
    expect(isVercelLoginAnswer(307, "https://login.vercel.com/x", PREVIEW)).toBe(true)
    expect(isVercelLoginAnswer(302, "/_vercel/sso/start?next=%2F", PREVIEW)).toBe(true)
    expect(isVercelLoginAnswer(308, "HTTPS://VERCEL.COM./sso-api", PREVIEW)).toBe(true)
  })

  it("NEGATIVE: a served page, the site's own redirects, a look-alike host or a 403 are not Vercel's login", () => {
    expect(isVercelLoginAnswer(200, null, PREVIEW)).toBe(false)
    expect(isVercelLoginAnswer(302, "/login", PREVIEW)).toBe(false)
    expect(isVercelLoginAnswer(301, "https://fresh-acme.com/", PREVIEW)).toBe(false)
    expect(isVercelLoginAnswer(302, "https://notvercel.com/sso-api", PREVIEW)).toBe(false)
    expect(isVercelLoginAnswer(302, "https://fresh-acme-git-x-team.vercel.app/", PREVIEW)).toBe(false)
    expect(isVercelLoginAnswer(302, null, PREVIEW)).toBe(false)
    expect(isVercelLoginAnswer(403, null, PREVIEW)).toBe(false)
  })
})

describe("asking the preview before the desktop (previewNeedsLogin)", () => {
  it("asks the preview and its proof file once each, without credentials, never following a redirect, with a short timeout", async () => {
    const fetchFn = fakeFetch({ [PREVIEW]: { status: 302, location: "https://vercel.com/sso-api?url=x" } })
    expect(await previewNeedsLogin(fetchFn, PREVIEW)).toBe(true)
    expect(fetchFn.asked.map((entry) => entry.url).sort()).toEqual([PREVIEW, PROOF].sort())
    for (const { init } of fetchFn.asked) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(PREVIEW_LOGIN_PROBE_MS).toBeLessThanOrEqual(10_000)
  })

  it("the proof file alone behind the login is enough (a 401 on it)", async () => {
    expect(await previewNeedsLogin(fakeFetch({ [PROOF]: { status: 401 } }), PREVIEW)).toBe(true)
  })

  it("NEGATIVE: an open preview, a network error, a timeout-shaped failure or no fetch at all is never 'needs a login'", async () => {
    expect(await previewNeedsLogin(fakeFetch({}), PREVIEW)).toBe(false)
    expect(await previewNeedsLogin(fakeFetch({ [PREVIEW]: "network_error", [PROOF]: "network_error" }), PREVIEW)).toBe(false)
    expect(await previewNeedsLogin(fakeFetch({ [PROOF]: { status: 404 } }), PREVIEW)).toBe(false)
    expect(await previewNeedsLogin(undefined, PREVIEW)).toBe(false)
    expect(await previewNeedsLogin(fakeFetch({}), "not a url")).toBe(false)
  })
})

describe("the rehearsal on a preview behind Vercel's login", () => {
  it("is preview_protected before the desktop is asked: one plain line, and the cells read 'not tried', never 'unknown'", async () => {
    const { outcome, modes } = await rehearseWith(fakeFetch({ [PREVIEW]: { status: 302, location: "https://vercel.com/sso-api?url=x" } }))
    expect(outcome).toMatchObject({ state: "undetermined", reason: "preview_protected", previewUrl: PREVIEW })
    expect(modes).toEqual([])
    const lines = rehearsalLines(outcome)
    expect(lines).toEqual([{ text: PREVIEW_LOGIN_LINE, tone: "info" }])
    expect(PREVIEW_LOGIN_LINE).toBe("Your Vercel previews need a Vercel login, so the pull request was not tried before merge.")
    expect(lines[0]!.text).not.toMatch(/proof file|undetermined|unknown/)
    const { finishLine } = rehearsalCells(outcome, { head: HEAD, at: "2026-10-09T10:00:00.000Z", runId: RUN_ID })
    const cells = Object.values(finishLine)
    expect(cells).toHaveLength(7)
    for (const cell of cells) {
      expect(cell).toMatchObject({ state: "info", display: PREVIEW_LOGIN_CELL, reason: "preview_protected" })
      expect(cell!.value).not.toBeNull()
    }
    expect(PREVIEW_LOGIN_CELL).toBe("not tried (previews need a login)")
  })

  it("NEGATIVE: an open preview goes on to the desktop as before (rehearsal, then the preview's own load)", async () => {
    const { outcome, modes } = await rehearseWith(fakeFetch({}))
    expect(outcome.reason).not.toBe("preview_protected")
    expect(modes[0]).toBe("rehearsal")
  })

  it("NEGATIVE: an unreachable preview (network error) is not called protected; the desktop still tries it", async () => {
    const { outcome, modes } = await rehearseWith(fakeFetch({ [PREVIEW]: "network_error", [PROOF]: "network_error" }))
    expect(outcome.reason).not.toBe("preview_protected")
    expect(modes[0]).toBe("rehearsal")
  })
})
