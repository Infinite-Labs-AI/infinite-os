// A fake Infinite desktop tag bridge for tests (lane O2; I1's offline end-to-end test uses it too).
//
// An in-process loopback HTTP server that implements every §3a verb from F0's cross-repo fixtures
// (`contracts/tag-wizard-v1/bridge-verbs.fixtures.json`), with the desktop's transport rules (§3a.2: Origin /
// Host refusal before the bearer check, bearer, strict body decoding, 64 KB bodies, link-scoped verbs need an
// approved `X-Infinite-Link-Id`, paid verbs 402 when unsubscribed) and scripting hooks: link approve /
// decline / expire / remembered / pending, 402, scripted errors per verb, test results per mode, receipts,
// proof claim won / lost, deploy states (incl. a canceled merge build and a later serving SHA), the Meta relay,
// and a connection that hangs up after the verb took effect (an app dying mid-response).
//
// It refuses what the real desktop (D2) and cloud (C1) refuse, so an offline end-to-end run cannot pass with a
// regression the real stack would catch:
// - `test.start`: the §3h.1 mode rules (`testRequestModeErrors`: `real_visit` with `fakeClickId` / `clicks` /
//   `spaNavigation` / `targets.length ≠ 1`, `dry_live` with clicks or the fake click id against production)
//   → 400 `invalid_request`; a preview origin the desktop cannot tie to this site (the hosting read's Vercel
//   project, or with no Vercel connection a pending claim's proof file it serves; review P1-2, `refusedPreviewField`)
//   → 400 `invalid_request` with its `field`; a `real_visit` without the tag's granted proof claim → 409 `claimed_by_other`;
// - `runs.proof-claim`: one claim (`pending|pending_desktop → proving`); any other state → 409 with `state`;
// - `runs.patch`: `phase` only moves forward (400), `mergeSha` is set once (400), `proofState` only while
//   `proving` (409 `claimed_by_other`; the same result again is a no-op), plus the cloud's own body rules
//   (`cloudPatchRefusal`: conversion-name pattern, ≤ 20 names, 40-hex SHAs, `producer` with `proofState`,
//   no `phase:"proven"` before a proof);
// - `report`: the cloud's report parser (`parseCloudReport`, a port of 1bu-1's `parseReportV2`, final verify
//   F17): a report the real cloud refuses is a 400 `invalid_request` naming the field, never a 201.
//
// It records every call in order (`calls`) and writes a descriptor (0700 dir, 0600 file) into a temp
// `GROWTH_OS_HOME`. Every response it sends is checked against the verb's exact response shape, so the fake
// cannot drift from the contract. Its bearer is the obviously fake FAKE_BRIDGE_TOKEN.
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BRIDGE_DIRNAME,
  BRIDGE_ERROR_RESPONSE_SHAPE,
  BRIDGE_ERROR_STATUS,
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SERVICE,
  BRIDGE_VERB_IDS,
  BRIDGE_VERBS,
  FAKE_BRIDGE_TOKEN,
  TAG_CAPABILITIES,
  bridgePathPattern,
  matchBridgeVerb,
  type BridgeDescriptor,
  type BridgeErrorCode,
  type BridgeRuntime,
  type BridgeVerbFixture,
  type BridgeVerbId,
  type ClaimPublic,
  type DeployStatusResponse,
  type ProveOutcome,
  type Link,
  type MetaRelayStatusResponse,
  type TagHosting,
  type TagKeys,
  type WizardRunPublic
} from "../../src/wizard/contracts/bridge.js"
import { shapeErrors } from "../../src/wizard/contracts/shape.js"
import type { ReceiptsResponseFields } from "../../src/wizard/contracts/receipts.js"
import { testRequestModeErrors, type TestMode, type TestResult, type TestRunFixtureCase, type TestRunRequest } from "../../src/wizard/contracts/test-engine.js"
import { normalizeHost } from "../../src/wizard/contracts/host-deny.js"
import { cloudPatchRefusal, parseCloudReport } from "./cloud-rules.js"

const CONTRACTS_DIR = new URL("../../contracts/tag-wizard-v1/", import.meta.url)

export function loadVerbFixtures(): BridgeVerbFixture[] {
  return JSON.parse(readFileSync(new URL("bridge-verbs.fixtures.json", CONTRACTS_DIR), "utf8")) as BridgeVerbFixture[]
}

export function loadTestRunCases(): TestRunFixtureCase[] {
  return JSON.parse(readFileSync(new URL("test-run.fixtures.json", CONTRACTS_DIR), "utf8")) as TestRunFixtureCase[]
}

export function loadDescriptorExample(): BridgeDescriptor {
  return JSON.parse(readFileSync(new URL("bridge-descriptor.example.json", CONTRACTS_DIR), "utf8")) as BridgeDescriptor
}

/** The first success response of a verb in the fixtures (deep copy). */
export function fixtureResponse(verb: BridgeVerbId, predicate?: (row: BridgeVerbFixture) => boolean): Record<string, unknown> {
  const row = loadVerbFixtures().find((candidate) => candidate.verb === verb && candidate.status < 300 && (predicate ? predicate(candidate) : true))
  if (!row) throw new Error(`fake bridge: no success fixture for ${verb}`)
  return structuredClone(row.response) as Record<string, unknown>
}

export type LinkMode = "approve" | "decline" | "expire" | "expire_410" | "remembered" | "pending"

export interface ScriptedError {
  status?: number
  code: BridgeErrorCode
  message?: string
  retryable?: boolean
  field?: string
  state?: string
  upstreamStatus?: number
  /** Answer once, then behave normally. */
  once?: boolean
}

export interface FakeDeployState {
  mergeDeployment: DeployStatusResponse["mergeDeployment"]
  serving: DeployStatusResponse["serving"]
}

/**
 * A deploy sequence for `prove`: the merge's own production build is canceled (or skipped), and a LATER
 * deployment is serving production (`servingSha`, which may or may not descend from the merge).
 */
export function deployCanceledThenServing(servingSha: string, polls = 1): FakeDeployState[] {
  const building: FakeDeployState = {
    mergeDeployment: { state: "building", readyAt: null },
    serving: { sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d", readyAt: "2026-10-02T07:20:00.000Z", createdAt: "2026-10-02T07:18:00.000Z", ref: "main" }
  }
  const canceled: FakeDeployState = {
    mergeDeployment: { state: "canceled", readyAt: null },
    serving: { sha: servingSha, readyAt: "2026-10-02T09:45:00.000Z", createdAt: "2026-10-02T09:43:00.000Z", ref: "main" }
  }
  return [...Array.from({ length: polls }, () => building), canceled]
}

export interface FakeBridgeScript {
  link: LinkMode
  /** Polls answered `pending` before the scripted outcome. */
  linkPollsBeforeAnswer: number
  workspaceName: string
  /** false → every paid verb answers 402 subscription_required. */
  paid: boolean
  runtime: BridgeRuntime
  capabilities: string[]
  keys: TagKeys
  hosting: TagHosting
  run: WizardRunPublic
  proofClaim: "won" | "lost"
  /** Consumed one per deploy-status call; the last one repeats. */
  deploy: FakeDeployState[]
  testResults: Partial<Record<TestMode, TestResult>>
  /**
   * Picks a result per REQUEST (e.g. the preview's own `dry_live` vs production's); undefined falls back
   * to `testResults[mode]`, then the fixture.
   */
  testResultFor?: (request: TestRunRequest) => TestResult | undefined
  testPollsBeforeDone: number
  /** The receipts answer (default: the fixture's verified run). */
  receipts: ReceiptsResponseFields | null
  metaRelay: Omit<MetaRelayStatusResponse, "protocolVersion" | "requestId">
  errors: Partial<Record<BridgeVerbId, ScriptedError>>
  /** Verbs whose connection is destroyed AFTER the verb took effect, instead of answering (once each). */
  hangUpAfter: BridgeVerbId[]
  /** §3z.9 (A21): the real-visit facts the desktop proof watcher stored for the run (null → 404 not_found). */
  storedFacts: TestResult | null
  /**
   * §3y.2/§3y.3: the workspace's site-file claim as the cloud holds it (null = none). `site-claim` creates it when
   * no host is verified or served by the Vercel connection; `site-prove` proves it only while `siteFileServed`
   * is true (the test flips it when the merge deploys), creating the source with the RESERVED key, exactly as
   * the cloud does, and handing a merged, undeployed run to `pending_desktop`.
   */
  claim: ClaimPublic | null
  siteFileServed: boolean
  /** What `site-prove` reports per host while the file is not served. */
  siteFileOutcome: ProveOutcome
  /**
   * Review P1-2: with no Vercel connection, the desktop accepts a preview origin only when it serves the pending
   * claim's proof line (it GETs `<origin>/.well-known/infinite-site-verification.txt`). The PR carries that file, so a
   * preview of it serves it (true); false = the preview does not (protected, a 404, another line).
   */
  previewServesClaimProof: boolean
}

export interface FakeBridgeCall {
  verb: BridgeVerbId | null
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
  status: number
}

export interface FakeBridge {
  url: string
  port: number
  home: string
  env: Record<string, string>
  descriptor: BridgeDescriptor
  script: FakeBridgeScript
  calls: FakeBridgeCall[]
  /** A handler that threw: its message, kept here (the 500 the client gets carries no error detail). */
  internalErrors: string[]
  callsFor(verb: BridgeVerbId): FakeBridgeCall[]
  /** Rewrite the descriptor (e.g. another runtime variant) and keep serving. */
  rewriteDescriptor(change: Partial<BridgeDescriptor>): void
  close(): Promise<void>
}

const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
/** The run's start on the fake cloud's clock (`runs.start` answers it; the report parser's rule 3 reads it). */
export const FAKE_RUN_STARTED_AT = "2026-10-02T09:02:00.000Z"
const LINK_ID = "lk_FAKElinkAcmeStore00000"
const TEST_RUN_IDS: Record<TestMode, string> = {
  dry_live: "tr_FAKEdryLive00000000000",
  rehearsal: "tr_FAKErehearsal000000000",
  real_visit: "tr_FAKErealVisit000000000"
}

function defaultScript(): FakeBridgeScript {
  const keys = fixtureResponse("keys")
  delete keys.protocolVersion
  delete keys.requestId
  const hosting = fixtureResponse("hosting")
  delete hosting.protocolVersion
  delete hosting.requestId
  const run = fixtureResponse("runs.get").run as WizardRunPublic
  const relay = fixtureResponse("meta-relay.status")
  delete relay.protocolVersion
  delete relay.requestId
  const deployRows = loadVerbFixtures().filter((row) => row.verb === "hosting.deploy" && row.status < 300)
  return {
    link: "approve",
    linkPollsBeforeAnswer: 0,
    workspaceName: "Acme",
    paid: true,
    runtime: { variant: "prod", label: "Infinite" },
    capabilities: [...TAG_CAPABILITIES],
    keys: keys as unknown as TagKeys,
    hosting: hosting as unknown as TagHosting,
    // A FRESH run (the fixture's run is a finished one): phase before, nothing merged, deployed or claimed.
    run: {
      ...structuredClone(run),
      phase: "before",
      prUrl: null,
      prNumber: null,
      prHeadSha: null,
      mergeSha: null,
      mergedAt: null,
      deployedSha: null,
      deployedAt: null,
      approvedConversions: [],
      clickTestedConversions: [],
      proofState: "pending",
      proofClaimedBy: null,
      checkinDueAt: null
    },
    proofClaim: "won",
    deploy: deployRows.map((row) => {
      const response = row.response as DeployStatusResponse
      return { mergeDeployment: response.mergeDeployment, serving: response.serving }
    }),
    testResults: {},
    testPollsBeforeDone: 0,
    receipts: null,
    metaRelay: relay as unknown as FakeBridgeScript["metaRelay"],
    errors: {},
    hangUpAfter: [],
    storedFacts: null,
    claim: null,
    siteFileServed: false,
    siteFileOutcome: "not_served",
    previewServesClaimProof: true
  }
}

/** The fake cloud's reserved key and proof token (fixture-shaped, obviously fake). */
export const FAKE_RESERVED_SITE_KEY = "site_fa4e000000000000000000000000c1a1"
export const FAKE_PROOF_BODY = "infinite-site-verification: isv_FAKEacmeProofToken0000\n"

/** The cloud's verified-host rule as the fake applies it: the source's hosts, or the Vercel connection's domains. */
function verifiedHosts(script: FakeBridgeScript): Set<string> {
  const hosts = new Set<string>()
  if (script.keys.infinite.status === "ready") for (const host of script.keys.infinite.productionHosts) hosts.add(normalizeHost(host))
  if (script.hosting.provider === "vercel" && script.hosting.vercel) {
    for (const host of [...script.hosting.vercel.productionDomains, ...script.hosting.vercel.productionAliases]) hosts.add(normalizeHost(host))
  }
  return hosts
}

/** The run phases in order (§3b: `phase` only moves forward; `abandoned` from any unfinished phase). */
const PHASE_RANK: Record<WizardRunPublic["phase"], number> = { before: 0, in_pr: 1, merged: 2, proven: 3, abandoned: 4 }

/** C1's rule (`runs.ts nextPhase`): the same phase is a no-op; otherwise forward only, never out of a finished run. */
export function phaseMoveAllowed(current: WizardRunPublic["phase"], wanted: WizardRunPublic["phase"]): boolean {
  if (wanted === current) return true
  const finished = current === "proven" || current === "abandoned"
  return wanted === "abandoned" ? !finished : !finished && PHASE_RANK[wanted] > PHASE_RANK[current]
}

/** The production host or a subdomain of it (or of its apex, for a `www.` production host). */
function productionOrSibling(productionHost: string): (host: string) => boolean {
  const apex = normalizeHost(productionHost).replace(/^www\./, "")
  return (host) => {
    const candidate = normalizeHost(host)
    return candidate === apex || candidate.endsWith(`.${apex}`)
  }
}

// ---------------------------------------------------------------------------------------------
// The desktop's preview rule (review P1-2), ported from 1bu-1 `apps/desktop/src/main/analytics-tag/`:
// `test-engine/routes.ts` `previewOriginsOf`, `tag-wizard-wiring.ts` `verifyPreviewOrigins` (+ `verifyByPendingClaim`,
// 1bu-1 9c7d0680bc) and `isProjectPreviewOrigin`, `test-engine/rehearsal.ts` `isVercelPreviewOrigin`,
// `test-engine/hosts.ts` `isSiblingHost`. A preview origin is accepted only when
// - the hosting read names a Vercel project and the origin is `<projectName>-<…>.vercel.app`, not a production alias;
// - or the hosting read is `provider:"none"` (no Vercel connection), the workspace's claim is `pending_proof` with a
//   well-formed proof line, and every origin serves that line (`previewServesClaimProof`).
// Anything else is 400 `invalid_request` naming the first preview's field, before any window opens. So an offline run
// cannot pass on a preview the real app refuses.
// ---------------------------------------------------------------------------------------------

function isVercelPreviewOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false
  if (`${url.protocol}//${url.host}` !== origin.replace(/\/$/, "")) return false
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)
}

function isSiblingHost(a: string, b: string): boolean {
  const left = normalizeHost(a).replace(/^www\./, "")
  const right = normalizeHost(b).replace(/^www\./, "")
  if (!left || !right) return false
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
}

/** The preview origins a test request names: the rehearsal's preview, and every dry_live target off production. */
export function previewOriginsOf(request: TestRunRequest): Array<{ origin: string; field: string }> {
  const out: Array<{ origin: string; field: string }> = []
  if (request.rehearsal) out.push({ origin: request.rehearsal.previewOrigin, field: "rehearsal.previewOrigin" })
  if (request.mode === "dry_live") {
    for (const [index, target] of request.targets.entries()) {
      const url = new URL(target.url)
      if (!isSiblingHost(url.hostname, request.productionHost)) out.push({ origin: url.origin, field: `targets.${index}.url` })
    }
  }
  return out
}

export function isProjectPreviewOrigin(origin: string, project: { projectName: string; productionAliases: readonly string[] }): boolean {
  if (!isVercelPreviewOrigin(origin)) return false
  const host = new URL(origin).hostname
  if (project.productionAliases.map((alias) => alias.toLowerCase()).includes(host)) return false
  const name = project.projectName.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) return false
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-z0-9-]+\\.vercel\\.app$`).test(host)
}

const PROOF_LINE = /^infinite-site-verification: isv_[A-Za-z0-9_-]{22}$/

/** `verifyPreviewOrigins` over the hosting read: the field of the first refused preview, or null (all accepted / none). */
export function refusedPreviewField(
  request: TestRunRequest,
  hosting: TagHosting,
  pending: { claim: ClaimPublic | null; previewServesClaimProof: boolean } = { claim: null, previewServesClaimProof: false }
): string | null {
  const previews = previewOriginsOf(request)
  if (previews.length === 0) return null
  if (hosting.provider === "none" && hosting.vercel === null) {
    // `verifyByPendingClaim`: the pending claim is the only proof left (every origin already passed the shape check).
    const claim = pending.claim
    const ok =
      claim !== null &&
      claim.state === "pending_proof" &&
      PROOF_LINE.test(claim.proofBody.trim()) &&
      previews.every((row) => isVercelPreviewOrigin(row.origin.replace(/\/$/, ""))) &&
      pending.previewServesClaimProof
    return ok ? null : previews[0]!.field
  }
  const vercel = hosting.vercel
  if (!vercel || typeof vercel.projectName !== "string") return previews[0]!.field
  const project = { projectName: vercel.projectName, productionAliases: Array.isArray(vercel.productionAliases) ? vercel.productionAliases : [] }
  return previews.every((row) => isProjectPreviewOrigin(row.origin.replace(/\/$/, ""), project)) ? null : previews[0]!.field
}

function testResultFor(mode: TestMode, script: FakeBridgeScript, request: TestRunRequest | null = null): TestResult {
  const picked = request && script.testResultFor ? script.testResultFor(request) : undefined
  if (picked) return picked
  const scripted = script.testResults[mode]
  if (scripted) return scripted
  const fixture = loadTestRunCases().find((candidate) => candidate.request.mode === mode)
  if (!fixture) throw new Error(`fake bridge: no test fixture for ${mode}`)
  return fixture.result
}

async function readBody(req: IncomingMessage, limit: number): Promise<{ text: string; tooLarge: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) tooLarge = true
    else chunks.push(buffer)
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge }
}

export interface StartFakeBridgeOptions {
  script?: Partial<FakeBridgeScript>
  /** An existing GROWTH_OS_HOME to write into (default: a new temp dir). */
  home?: string
}

export async function startFakeBridge(options: StartFakeBridgeOptions = {}): Promise<FakeBridge> {
  const script: FakeBridgeScript = { ...defaultScript(), ...options.script }
  const calls: FakeBridgeCall[] = []
  const internalErrors: string[] = []
  const home = options.home ?? mkdtempSync(join(tmpdir(), "infinite-tag-fake-home-"))
  const ownsHome = options.home === undefined
  const linkRequests = new Map<string, { polls: number; site: { repoLabel: string; appRoot: string } }>()
  const approvedLinks = new Set<string>()
  const testRuns = new Map<string, { mode: TestMode; polls: number; request: TestRunRequest }>()
  let deployIndex = 0
  let port = 0

  const send = (res: ServerResponse, record: FakeBridgeCall, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const hangUp = record.verb !== null ? script.hangUpAfter.indexOf(record.verb) : -1
    if (hangUp >= 0) {
      // The app "dies" mid-response: the effect happened, the caller never hears about it.
      script.hangUpAfter.splice(hangUp, 1)
      record.status = -1
      res.socket?.destroy()
      return
    }
    record.status = status
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers })
    res.end(JSON.stringify(body))
  }
  const fail = (
    res: ServerResponse,
    record: FakeBridgeCall,
    requestId: string,
    code: BridgeErrorCode,
    extra: Partial<ScriptedError> = {}
  ) => {
    const status = extra.status ?? BRIDGE_ERROR_STATUS[code]
    const error: Record<string, unknown> = {
      code,
      message: extra.message ?? `fake bridge: ${code}`,
      retryable: extra.retryable ?? (status === 429 || status >= 500)
    }
    if (extra.field !== undefined) error.field = extra.field
    if (extra.state !== undefined) error.state = extra.state
    if (extra.upstreamStatus !== undefined) error.upstreamStatus = extra.upstreamStatus
    const body = { protocolVersion: 1, requestId, error }
    const problems = shapeErrors(body, BRIDGE_ERROR_RESPONSE_SHAPE)
    if (problems.length > 0) throw new Error(`fake bridge drifted from the error contract: ${problems[0]}`)
    const headers: Record<string, string> = {}
    if (code === "unauthorized") headers["WWW-Authenticate"] = 'Bearer realm="infinite-desktop-tag"'
    if (code === "rate_limited") headers["Retry-After"] = "1"
    send(res, record, status, body, headers)
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET"
      const path = req.url ?? "/"
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === "authorization") continue
        headers[key] = Array.isArray(value) ? value.join(", ") : (value ?? "")
      }
      const record: FakeBridgeCall = { verb: null, method, path, headers, body: null, status: 0 }
      calls.push(record)
      const { text, tooLarge } = await readBody(req, BRIDGE_LIMITS.maxBodyBytes)
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      record.body = body
      // §3z.2 (A7): echo the body's id (POST/PATCH) or the GET's `X-Request-Id` header, else a fresh uuid.
      const headerId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null
      const requestId =
        typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).requestId === "string"
          ? ((body as Record<string, unknown>).requestId as string)
          : (headerId ?? randomUUID())

      // §3a.2: Origin / Host first (DNS rebinding), then the bearer.
      if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return fail(res, record, requestId, "origin_refused")
      if (req.headers.authorization !== `Bearer ${FAKE_BRIDGE_TOKEN}`) return fail(res, record, requestId, "unauthorized")

      const spec = matchBridgeVerb(method, path)
      if (!spec) {
        const otherMethod = BRIDGE_VERB_IDS.some((id) => bridgePathPattern(BRIDGE_VERBS[id]).test(path))
        return fail(res, record, requestId, otherMethod ? "method_not_allowed" : "route_not_found")
      }
      record.verb = spec.verb
      if (tooLarge) return fail(res, record, requestId, "body_too_large")
      if (spec.request) {
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return fail(res, record, requestId, "invalid_request", { field: "Content-Type" })
        }
        const problems = shapeErrors(body, spec.request)
        const unknown = problems.find((problem) => problem.includes("unknown key"))
        if (unknown) return fail(res, record, requestId, "unknown_field", { message: unknown })
        if (problems.length > 0) return fail(res, record, requestId, "invalid_request", { message: problems[0] ?? "" })
      } else if (text) {
        return fail(res, record, requestId, "invalid_request", { message: "GET takes no body" })
      }
      // §3z.2: a query string on a POST or PATCH route → 400 unknown_field, before any cloud call.
      if (method !== "GET" && path.includes("?")) return fail(res, record, requestId, "unknown_field", { message: "POST/PATCH take no query" })
      if (!req.headers["x-infinite-tag-version"]) return fail(res, record, requestId, "invalid_request", { field: "X-Infinite-Tag-Version" })
      if (!script.capabilities.includes(spec.capability)) return fail(res, record, requestId, "capability_unavailable")

      const scripted = script.errors[spec.verb]
      if (scripted) {
        if (scripted.once) delete script.errors[spec.verb]
        return fail(res, record, requestId, scripted.code, scripted)
      }
      if (spec.linkScoped) {
        const linkId = req.headers["x-infinite-link-id"]
        if (typeof linkId !== "string" || !approvedLinks.has(linkId)) return fail(res, record, requestId, "link_not_found")
      }
      if (spec.paid && !script.paid) return fail(res, record, requestId, "subscription_required")

      const reqBody = (body ?? {}) as Record<string, unknown>
      const url = new URL(path, `http://127.0.0.1:${port}`)
      const ok = (fields: Record<string, unknown>) => {
        const response = { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId, ...fields }
        const problems = shapeErrors(response, spec.response)
        if (problems.length > 0) throw new Error(`fake bridge drifted from the ${spec.verb} contract: ${problems[0]}`)
        send(res, record, spec.successStatus, response)
      }
      const strip = (value: Record<string, unknown>) => {
        const copy = { ...value }
        delete copy.protocolVersion
        delete copy.requestId
        return copy
      }
      const makeLink = (site: { repoLabel: string; appRoot: string }, remembered: boolean): Link => {
        approvedLinks.add(LINK_ID)
        return { linkId: LINK_ID, workspace: { name: script.workspaceName }, site, approvedAt: "2026-10-02T09:01:00.000Z", remembered }
      }

      switch (spec.verb) {
        case "status":
          return ok({
            service: BRIDGE_SERVICE,
            bootId: descriptor.bootId,
            desktopVersion: descriptor.desktopVersion,
            runtime: script.runtime,
            signedIn: true,
            capabilities: script.capabilities,
            protocol: { min: 1, max: 1 }
          })
        case "link.request": {
          const site = reqBody.site as { repoLabel: string; appRoot: string }
          const linkSite = { repoLabel: site.repoLabel, appRoot: site.appRoot }
          const linkRequestId = `lr_${randomUUID().replace(/-/g, "").slice(0, 22)}`
          if (script.link === "remembered") {
            return ok({ linkRequestId, state: "approved", expiresAt: "2026-10-02T09:06:00.000Z", link: makeLink(linkSite, true) })
          }
          linkRequests.set(linkRequestId, { polls: 0, site: linkSite })
          return ok({ linkRequestId, state: "pending", expiresAt: "2026-10-02T09:06:00.000Z" })
        }
        case "link.poll": {
          const id = url.pathname.split("/").pop() ?? ""
          const pending = linkRequests.get(id)
          if (!pending) return fail(res, record, requestId, "not_found")
          pending.polls += 1
          if (script.link === "pending" || pending.polls <= script.linkPollsBeforeAnswer) return ok({ state: "pending" })
          if (script.link === "approve") return ok({ state: "approved", link: makeLink(pending.site, false) })
          if (script.link === "decline") return ok({ state: "declined" })
          if (script.link === "expire_410") return fail(res, record, requestId, "expired")
          return ok({ state: "expired" })
        }
        case "link.revoke":
          approvedLinks.delete(String(reqBody.linkId))
          return ok({ revoked: true })
        case "keys":
          return ok({ ...structuredClone(script.keys) })
        case "hosting": {
          // As the desktop decodes it since review I2 P1-2 (§3b): at most 10 public build-time names, else 400.
          const envNames = url.searchParams.get("envNames")
          if (envNames !== null) {
            const names = envNames.split(",")
            if (names.length > 10 || names.some((name) => !/^(NEXT_PUBLIC|VITE|PUBLIC)_[A-Z0-9_]{1,64}$/.test(name))) {
              return fail(res, record, requestId, "invalid_request", { field: "envNames" })
            }
          }
          return ok({ ...structuredClone(script.hosting) })
        }
        case "hosting.deploy": {
          const state = script.deploy[Math.min(deployIndex, script.deploy.length - 1)]
          deployIndex += 1
          if (!state) return fail(res, record, requestId, "not_found")
          return ok({ mergeDeployment: state.mergeDeployment, serving: state.serving, target: "production" })
        }
        case "runs.start":
          script.run = {
            ...script.run,
            runId: RUN_ID,
            startedAt: FAKE_RUN_STARTED_AT,
            worker: reqBody.worker as WizardRunPublic["worker"],
            reviewer: reqBody.reviewer as WizardRunPublic["reviewer"]
          }
          return ok({ runId: RUN_ID, startedAt: FAKE_RUN_STARTED_AT })
        case "runs.proof-claim":
          if (script.proofClaim === "lost") return fail(res, record, requestId, "claimed_by_other", { state: "proving" })
          // ONE claim: only `pending | pending_desktop → proving` (C1's atomic conditional update).
          if (script.run.proofState !== "pending" && script.run.proofState !== "pending_desktop") {
            return fail(res, record, requestId, "claimed_by_other", { state: script.run.proofState })
          }
          script.run = { ...script.run, proofState: "proving", proofClaimedBy: reqBody.producer as "tag" | "desktop" }
          return ok({ granted: true, proofState: "proving" })
        case "runs.patch": {
          const patch = (reqBody.patch ?? {}) as Partial<WizardRunPublic> & { clickTestedConversions?: string[] }
          const refusal = cloudPatchRefusal(reqBody as { patch?: Record<string, unknown>; producer?: unknown }, script.run)
          if (refusal) return fail(res, record, requestId, "invalid_request", { field: refusal.field, message: refusal.reason })
          if (patch.phase !== undefined && !phaseMoveAllowed(script.run.phase, patch.phase)) {
            return fail(res, record, requestId, "invalid_request", { field: "patch.phase", message: `phase only moves forward (the run is ${script.run.phase}).` })
          }
          if (patch.mergeSha !== undefined && script.run.mergeSha !== null && script.run.mergeSha !== patch.mergeSha) {
            return fail(res, record, requestId, "invalid_request", { field: "patch.mergeSha", message: "mergeSha is already set for this run." })
          }
          if (patch.proofState !== undefined && script.run.proofState !== "proving" && script.run.proofState !== patch.proofState) {
            return fail(res, record, requestId, "claimed_by_other", { state: script.run.proofState, message: "This run is not being proven; claim it first." })
          }
          // §3z.8 (A10): the proofState PATCH names its producer, which must hold the claim.
          if (patch.proofState !== undefined && reqBody.producer !== script.run.proofClaimedBy) {
            return fail(res, record, requestId, "claimed_by_other", { state: script.run.proofState, message: "Only the producer holding the proof claim may set proofState." })
          }
          if (patch.approvedConversions !== undefined && patch.approvedConversions.length > 20) {
            return fail(res, record, requestId, "invalid_request", { field: "patch.approvedConversions" })
          }
          if (typeof patch.prUrl === "string" && (patch.prUrl.length > 300 || !patch.prUrl.startsWith("https://"))) {
            return fail(res, record, requestId, "invalid_request", { field: "patch.prUrl" })
          }
          const next = { ...script.run }
          for (const [key, value] of Object.entries(patch)) {
            if (key === "clickTestedConversions") {
              next.clickTestedConversions = [...new Set([...next.clickTestedConversions, ...(value as string[])])]
            } else {
              ;(next as unknown as Record<string, unknown>)[key] = value
            }
          }
          script.run = next
          return ok({ run: script.run })
        }
        case "runs.get": {
          // A run this workspace never started (another workspace's run id) is a 404, as C1 answers.
          const id = decodeURIComponent(url.pathname.split("/").pop() ?? "")
          if (id !== script.run.runId) return fail(res, record, requestId, "not_found")
          return ok({ run: script.run })
        }
        case "receipts":
          return ok(script.receipts ? { ...structuredClone(script.receipts) } : strip(fixtureResponse("receipts")))
        case "report": {
          // As the cloud's POST report route: the run must exist, then every cell is parsed at the door.
          const runId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
          if (runId !== script.run.runId) return fail(res, record, requestId, "not_found")
          const verdict = parseCloudReport(reqBody.report, {
            runId,
            startedAt: script.run.startedAt,
            phase: reqBody.phase as "live_today" | "in_pr" | "proven_live" | "day7",
            producer: reqBody.producer as "tag" | "desktop" | "cloud",
            partial: reqBody.partial as boolean
          })
          if (!verdict.ok) return fail(res, record, requestId, "invalid_request", { field: verdict.field, message: verdict.reason })
          const report = reqBody.report as { schema: string; runId: string }
          return ok({ id: randomUUID(), phase: reqBody.phase, storedAt: "2026-10-02T09:46:00.000Z", echo: { schema: report.schema, runId: report.runId } })
        }
        case "baseline":
          return ok(strip(fixtureResponse("baseline")))
        case "site-source":
          return ok({
            siteSourceKey: script.keys.infinite.siteSourceKey ?? "site_FAKEacmeStoreSourceKey",
            productionHosts: reqBody.productionHosts,
            consentMode: reqBody.consentMode,
            created: script.keys.infinite.status !== "ready"
          })
        case "conversions": {
          const conversions = (reqBody.conversions ?? []) as Array<{ name: string }>
          const approved = new Set(script.run.approvedConversions)
          return ok({
            declared: conversions.filter((c) => approved.has(c.name)).map((c) => c.name),
            refused: conversions.filter((c) => !approved.has(c.name)).map((c) => ({ name: c.name, reason: "not_approved" }))
          })
        }
        case "ga4-key-events": {
          const names = (reqBody.names ?? []) as string[]
          const approved = new Set(script.run.approvedConversions)
          const tested = new Set(script.run.clickTestedConversions)
          return ok({
            created: names.filter((name) => approved.has(name) && tested.has(name)),
            alreadyExisted: [],
            refused: names
              .filter((name) => !approved.has(name) || !tested.has(name))
              .map((name) => ({ name, reason: approved.has(name) ? "not_click_tested" : "not_approved" }))
          })
        }
        case "server-lane.status":
          return ok(strip(fixtureResponse("server-lane.status")))
        case "server-lane.provision-env": {
          // §3z.7 (A9): protocol 1 accepts only redeploy:"skip" (the shape refuses anything else first).
          if (reqBody.redeploy !== "skip") return fail(res, record, requestId, "invalid_request", { field: "redeploy" })
          const response = strip(fixtureResponse("server-lane.provision-env"))
          response.redeploy = { skipped: true, reason: "not_requested" }
          return ok(response)
        }
        case "meta-relay.status":
          return ok({ ...script.metaRelay })
        case "meta-relay.enable": {
          // §3z.7 (A23): it binds while not rolled out (200, available:false); other reasons refuse with 409.
          if (!script.metaRelay.available && script.metaRelay.reason !== "not_rolled_out") {
            return fail(res, record, requestId, "relay_not_available", { state: script.metaRelay.reason ?? "no_pixel" })
          }
          const pixel = script.keys.meta.pixels.find((candidate) => candidate.sourceRef === reqBody.sourceRef)
          if (!pixel) return fail(res, record, requestId, "not_found", { field: "sourceRef" })
          script.metaRelay = { ...script.metaRelay, bound: { sourceRef: pixel.sourceRef, pixelId: pixel.pixelId }, enabled: true }
          return ok({ ...script.metaRelay })
        }
        case "uninstall.remove-env":
          return ok(strip(fixtureResponse("uninstall.remove-env")))
        case "uninstall.disable-site-source":
          return ok({ disabled: true })
        case "site-claim": {
          const hosts = (reqBody.productionHosts as string[]).map(normalizeHost)
          const consentMode = reqBody.consentMode as ClaimPublic["consentMode"]
          const verified = verifiedHosts(script)
          if (hosts.every((host) => verified.has(host) || verified.has(host.replace(/^www\./, "")) || verified.has(`www.${host}`))) {
            return ok({
              state: "ready",
              siteSource: { siteSourceKey: script.keys.infinite.siteSourceKey ?? "site_FAKEacmeStoreSourceKey", productionHosts: hosts, consentMode, created: script.keys.infinite.status !== "ready" },
              claim: null
            })
          }
          if (script.keys.infinite.status === "ready") return fail(res, record, requestId, "invalid_request", { field: "productionHosts", state: "unverified_host" })
          // At most ONE pending claim: a repeat keeps its token and key and replaces the hosts and consent.
          script.claim = {
            hosts,
            siteSourceKey: script.claim?.siteSourceKey ?? FAKE_RESERVED_SITE_KEY,
            consentMode,
            collectPath: "/infinite/ledger",
            consentStorageKey: "infinite_analytics_consent",
            proofPath: "/.well-known/infinite-site-verification.txt",
            proofBody: script.claim?.proofBody ?? FAKE_PROOF_BODY,
            state: "pending_proof",
            provenHosts: [],
            lastCheck: script.claim?.lastCheck ?? null,
            expiresAt: "2026-11-01T09:20:00.000Z"
          }
          return ok({ state: "pending_proof", siteSource: null, claim: structuredClone(script.claim) })
        }
        case "site-claim-read":
          return ok({ claim: script.claim ? structuredClone(script.claim) : null })
        case "site-prove": {
          const claim = script.claim
          if (!claim) return ok({ state: "none", hosts: [], siteSource: null })
          const source = (created: boolean) => ({ siteSourceKey: claim.siteSourceKey, productionHosts: claim.provenHosts, consentMode: claim.consentMode, created })
          if (claim.state === "proven") return ok({ state: "proven", hosts: claim.provenHosts.map((host) => ({ host, outcome: "proven" })), siteSource: source(false) })
          const at = "2026-10-02T10:03:00.000Z"
          if (!script.siteFileServed) {
            claim.lastCheck = { at, outcome: script.siteFileOutcome }
            return ok({ state: "pending", hosts: claim.hosts.map((host) => ({ host, outcome: script.siteFileOutcome })), siteSource: null })
          }
          // Proven: the source is created WITH the reserved key; ingest accepts it from now on.
          claim.state = "proven"
          claim.provenHosts = [...claim.hosts]
          claim.lastCheck = { at, outcome: "proven" }
          script.keys = {
            ...script.keys,
            infinite: { status: "ready", siteSourceKey: claim.siteSourceKey, productionHosts: [...claim.hosts], consentMode: claim.consentMode, consentStorageKey: claim.consentStorageKey, collectPath: claim.collectPath }
          }
          if (script.run.mergeSha !== null && script.run.deployedAt === null) {
            script.run = { ...script.run, deployedSha: script.run.mergeSha, deployedAt: at, proofState: script.run.proofState === "pending" ? "pending_desktop" : script.run.proofState }
          }
          return ok({ state: "proven", hosts: claim.hosts.map((host) => ({ host, outcome: "proven" })), siteSource: source(true) })
        }
        case "test.start": {
          const request = reqBody as unknown as TestRunRequest
          const modeErrors = testRequestModeErrors(request, productionOrSibling(request.productionHost))
          if (modeErrors.length > 0) return fail(res, record, requestId, "invalid_request", { message: modeErrors.join("; ") })
          // Review P1-2: the desktop's preview rule (see `refusedPreviewField`), checked before the real-visit claim.
          const refusedField = refusedPreviewField(request, script.hosting, { claim: script.claim, previewServesClaimProof: script.previewServesClaimProof })
          if (refusedField !== null) return fail(res, record, requestId, "invalid_request", { field: refusedField, message: "Infinite can't confirm this preview is this site's." })
          // §3h.1: the one real visit only after the tag's granted proof claim (D2's route check).
          if (request.mode === "real_visit" && (script.run.proofState !== "proving" || script.run.proofClaimedBy !== "tag")) {
            return fail(res, record, requestId, "claimed_by_other", { state: script.run.proofState, message: "real_visit needs a granted proof claim." })
          }
          const mode = request.mode
          const testRunId = TEST_RUN_IDS[mode]
          testRuns.set(testRunId, { mode, polls: 0, request })
          return ok({ testRunId, state: "queued" })
        }
        case "test.poll": {
          const id = url.pathname.split("/").pop() ?? ""
          const run = testRuns.get(id)
          if (!run) return fail(res, record, requestId, "not_found")
          run.polls += 1
          const progress = [{ at: "2026-10-02T09:10:00.000Z", text: "Loading the site (nothing sent)" }]
          if (run.polls <= script.testPollsBeforeDone) return ok({ state: "running", progress })
          return ok({ state: "done", progress, result: testResultFor(run.mode, script, run.request) })
        }
        case "test.cancel": {
          const id = url.pathname.split("/").slice(-2)[0] ?? ""
          return ok({ testRunId: id, state: "cancelled" })
        }
        case "test.facts": {
          if (!script.storedFacts || script.storedFacts.runId !== url.searchParams.get("runId")) return fail(res, record, requestId, "not_found")
          return ok({ result: structuredClone(script.storedFacts) })
        }
      }
    })().catch((error: unknown) => {
      // The detail stays on the test's side (`internalErrors`); the response says only that it failed.
      internalErrors.push(error instanceof Error ? error.message : String(error))
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end("fake bridge: internal error")
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port

  const dir = join(home, BRIDGE_DIRNAME)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const descriptor: BridgeDescriptor = {
    schemaVersion: 1,
    service: BRIDGE_SERVICE,
    protocol: { min: 1, max: 1 },
    capabilities: [...script.capabilities],
    url: `http://127.0.0.1:${port}`,
    pid: process.pid,
    bootId: randomUUID(),
    desktopVersion: "0.4.1",
    runtime: script.runtime,
    token: FAKE_BRIDGE_TOKEN,
    startedAt: "2026-10-02T09:00:00.000Z"
  }
  const writeDescriptor = (value: BridgeDescriptor) => {
    const file = join(dir, "bridge.json")
    writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
    const stateFile = join(dir, "state.json")
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, state: "ready", updatedAt: "2026-10-02T09:00:00.000Z" }), { mode: 0o600 })
    chmodSync(stateFile, 0o600)
  }
  writeDescriptor(descriptor)

  const bridge: FakeBridge = {
    url: descriptor.url,
    port,
    home,
    env: { GROWTH_OS_HOME: home },
    descriptor,
    script,
    calls,
    internalErrors,
    callsFor: (verb) => calls.filter((call) => call.verb === verb),
    rewriteDescriptor(change) {
      Object.assign(descriptor, change)
      writeDescriptor(descriptor)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (ownsHome) rmSync(home, { recursive: true, force: true })
          resolve()
        })
        server.closeAllConnections?.()
      })
  }
  return bridge
}
