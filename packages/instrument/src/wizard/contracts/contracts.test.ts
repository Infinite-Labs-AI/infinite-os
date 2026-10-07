// The wizard contracts (§3a–§3i) against their published JSON: every fixture parses, every fixture's
// keys equal its TS type's key list (at every nested level the shapes name), the schema files are
// byte-identical to the TS constants, and the tables obey the plan's rules. Each rule has a negative.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import * as nodePath from "node:path"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  AGENT_KINDS,
  ASK_KINDS,
  BRIDGE_DESCRIPTOR_SHAPE,
  BRIDGE_ERROR_CODES,
  BRIDGE_ERROR_RESPONSE_SHAPE,
  BRIDGE_ERROR_STATES,
  BRIDGE_ERROR_STATUS,
  BRIDGE_ID_PATTERNS,
  BRIDGE_TOKEN_PATTERN,
  BRIDGE_VERB_FIXTURE_SHAPE,
  BRIDGE_VERB_IDS,
  BRIDGE_VERBS,
  CHECKLIST_ITEM_SHAPE,
  CLAIMS_SCHEMA,
  CLAUDE_REQUIRED_FLAGS,
  CODEX_DISABLED_FEATURES,
  CODEX_READ_CONFINEMENT,
  CODEX_REQUIRED_CONFIG,
  CODEX_REQUIRED_FLAGS,
  DOCTOR_EXIT_CODES,
  FAKE_BRIDGE_TOKEN,
  FINISH_LINE_IDS,
  FINISH_LINE_SOURCES,
  GLOBAL_DENY_GLOBS,
  HOST_DENY_V1,
  HOST_DENY_V1_SHA256,
  JOB_IDS,
  JOB_TABLE,
  NESTED_USER_ONLY_LINE_KINDS,
  PLAN_LINE_KINDS,
  PROVENANCE_SOURCES,
  RECEIPTS_FIXTURE_CASE_SHAPE,
  REPORT_ROW_IDS,
  REPORT_V2_SHAPE,
  REVIEW_SCHEMA,
  STATE_CHANGING_VERBS,
  TAG_CAPABILITIES,
  CLAIM_PUBLIC_SHAPE,
  PROVE_OUTCOMES,
  RESERVED_SITE_KEY_PATTERN,
  SITE_PROOF_BODY_PATTERN,
  SITE_PROOF_PATH,
  TEST_INFO_CODES,
  TEST_PROBLEM_CODES,
  TEST_RUN_FIXTURE_CASE_SHAPE,
  TEST_RUN_REQUEST_SHAPE,
  TEST_RESULT_SHAPE,
  TEST_UNDETERMINED_REASONS,
  WIZARD_CODE_EXIT,
  WIZARD_CODES,
  WIZARD_EVENT_SHAPES,
  WIZARD_EVENT_TYPES,
  WIZARD_RUN_STATE_SHAPE,
  WIZARD_STEP_IDS,
  WIZARD_STEP_META,
  YES_ASK_POLICY,
  YES_POLICY,
  agentArgvViolations,
  allowedFinishLineProvenance,
  bridgePathPattern,
  codexPermissionArgs,
  doctorExitCode,
  exitCodeFor,
  fakeClickIdFor,
  hostDenyFileText,
  isNestedUserOnly,
  isSanitizerSafeFieldName,
  matchBridgeVerb,
  normalizeHost,
  runExitCode,
  schemaFileText,
  serverLaneProbePathFor,
  shapeErrors,
  shapeOf,
  testExpectFromKeys,
  testRequestModeErrors,
  wizardBranchName,
  wizardEventLineShape,
  wizardManifestWorkspaceId,
  yesApproves,
  type BridgeVerbFixture,
  type BridgeVerbSpec,
  type Cell,
  type GitOps,
  type KeysResponse,
  type LaneReceipt,
  type ReceiptsFixtureCase,
  GA4_REALTIME_REASONS,
  ga4RealtimeAfterReads,
  ga4RealtimeFinal,
  ga4RealtimeLane,
  ga4RealtimeWindows,
  type ReportV2,
  type TestRunFixtureCase,
  type TestResult,
  type TestRunRequest,
  type WizardCode,
  type WizardRunState
} from "./index.js"

import { RECEIPT_MARKER_KINDS } from "./receipts.js"
import { BARE_PLATFORM_HOSTS, isDenyListedHost, isPreviewShapedHost, parseHostInput } from "../site-host.js"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const contractsDir = resolve(packageRoot, "contracts")
const wizardDir = resolve(contractsDir, "tag-wizard-v1")

const readText = (dir: string, name: string) => readFileSync(resolve(dir, name), "utf8")
const readJson = <T>(name: string): T => JSON.parse(readText(wizardDir, name)) as T

const EXPECTED_FILES = [
  "bridge-descriptor.example.json",
  "bridge-verbs.fixtures.json",
  "claims.schema.json",
  "receipts.fixtures.json",
  "report-v2.example.json",
  "review.schema.json",
  "run-state.example.json",
  "test-run.fixtures.json"
]

/** Every key, at any depth, of a JSON value. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, out))
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      allKeys(item, out)
    }
  }
  return out
}

describe("tag-wizard-v1 fixtures: files", () => {
  it("holds exactly the published fixture files, and every one parses", () => {
    expect(readdirSync(wizardDir).sort()).toEqual([...EXPECTED_FILES].sort())
    for (const name of EXPECTED_FILES) {
      expect(() => JSON.parse(readText(wizardDir, name)), name).not.toThrow()
      // Two-space JSON plus a trailing newline: the bytes 1bu-1 pins by sha256 are stable.
      expect(readText(wizardDir, name), name).toBe(schemaFileText(JSON.parse(readText(wizardDir, name))))
    }
  })

  it("no fixture value looks like a real token, workspace id or ad-account id", () => {
    for (const name of EXPECTED_FILES) {
      const text = readText(wizardDir, name)
      expect(text, name).not.toMatch(/ws_[0-9a-f]{16}/)
      expect(text, name).not.toMatch(/act_[0-9]{12,}/)
      // Infinite's own production pixel, assembled so the literal itself is not in this public file.
      expect(text, name).not.toContain(["555500", "001111222"].join(""))
      expect(text, name).not.toMatch(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./)
    }
  })
})

describe("shapeErrors (the key-list check every fixture goes through)", () => {
  const descriptor = readJson<Record<string, unknown>>("bridge-descriptor.example.json")

  it("accepts the descriptor", () => {
    expect(shapeErrors(descriptor, BRIDGE_DESCRIPTOR_SHAPE)).toEqual([])
  })

  it("negative: an extra key fails, at the top and nested", () => {
    expect(shapeErrors({ ...descriptor, extra: 1 }, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain('unknown key "extra"')
    const nested = { ...descriptor, runtime: { variant: "prod", label: "Infinite", extra: true } }
    expect(shapeErrors(nested, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain('$.runtime: unknown key "extra"')
  })

  it("negative: a missing required key fails", () => {
    const { bootId: _bootId, ...missing } = descriptor
    expect(shapeErrors(missing, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain('missing required key "bootId"')
  })

  it("negative: null is refused where the type has no null, at every nested level; accepted where it does", () => {
    expect(shapeErrors({ ...descriptor, runtime: null }, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain("$.runtime: null is not allowed")
    const report = readJson<Record<string, unknown> & { rows: Array<{ cells: Record<string, { provenance: unknown }> }> }>("report-v2.example.json")
    expect(shapeErrors({ ...report, site: null }, REPORT_V2_SHAPE).join()).toContain("$.site: null is not allowed")
    expect(shapeErrors({ ...report, columns: null }, REPORT_V2_SHAPE).join()).toContain("$.columns: null is not allowed")
    const nullProvenance = JSON.parse(JSON.stringify(report)) as typeof report
    nullProvenance.rows[0]!.cells.live_today!.provenance = null
    expect(shapeErrors(nullProvenance, REPORT_V2_SHAPE).join()).toContain("provenance: null is not allowed")
    const request = readJson<TestRunFixtureCase[]>("test-run.fixtures.json")[0]!.request
    expect(shapeErrors({ ...request, consentSeed: null }, TEST_RUN_REQUEST_SHAPE)).toEqual([])
    expect(shapeErrors({ ...request, expect: null }, TEST_RUN_REQUEST_SHAPE).join()).toContain("$.expect: null is not allowed")
    const result = readJson<TestRunFixtureCase[]>("test-run.fixtures.json")[0]!.result
    expect(shapeErrors({ ...result, serverLaneProbe: null }, TEST_RESULT_SHAPE)).toEqual([])
    expect(shapeErrors({ ...result, loads: [null] }, TEST_RESULT_SHAPE).join()).toContain("$.loads[0]: null is not allowed")
  })

  it("the key lists are compile-checked against the types", () => {
    interface X {
      a: string
      b?: number
    }
    expect(shapeOf<X>()("X", ["a"], ["b"]).required).toEqual(["a"])
    // @ts-expect-error a required key missing from the list does not compile
    shapeOf<X>()("X", [], ["b"])
    // @ts-expect-error an optional key missing from the list does not compile
    shapeOf<X>()("X", ["a"], [])
    // @ts-expect-error a key the type does not have does not compile
    shapeOf<X>()("X", ["a", "c"], ["b"])
  })
})

describe("the status fixture row (review I2 P3-6)", () => {
  it("advertises the same 17 protocol-1 capabilities as the descriptor (tag.test-facts.v1 and tag.site-claim.v1 included)", () => {
    const status = readJson<BridgeVerbFixture[]>("bridge-verbs.fixtures.json").find((f) => f.verb === "status" && f.status === 200)!
    const capabilities = (status.response as { capabilities: string[] }).capabilities
    expect(capabilities).toEqual([...TAG_CAPABILITIES])
    expect(capabilities).toContain("tag.test-facts.v1")
    expect(capabilities).toContain("tag.site-claim.v1")
    expect(capabilities).toEqual(readJson<{ capabilities: string[] }>("bridge-descriptor.example.json").capabilities)
  })
})

describe("bridge-descriptor.example.json (§3a.1)", () => {
  const descriptor = readJson<Record<string, unknown> & { capabilities: string[]; token: string; url: string }>(
    "bridge-descriptor.example.json"
  )

  it("advertises every protocol-1 capability, on loopback, with the fake 43-char token", () => {
    expect(descriptor.capabilities).toEqual([...TAG_CAPABILITIES])
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/)
    expect(descriptor.token).toBe(FAKE_BRIDGE_TOKEN)
    expect(FAKE_BRIDGE_TOKEN).toMatch(BRIDGE_TOKEN_PATTERN)
    expect(FAKE_BRIDGE_TOKEN).toContain("FAKE")
  })
})

function pollResult(rows: BridgeVerbFixture[], mode: TestResult["mode"]): TestResult | undefined {
  const row = rows.find((f) => f.verb === "test.poll" && f.status === 200 && (f.response as { result?: TestResult }).result?.mode === mode)
  return (row?.response as { result?: TestResult } | undefined)?.result
}

/** §3h.7 run-scoped proof: the real visit starts after the merge deploy is ready, and receipts ask only for what it saw. */
function proofChainViolations(rows: BridgeVerbFixture[]): string[] {
  const out: string[] = []
  const real = pollResult(rows, "real_visit")
  if (!real) return ["no real_visit result"]
  const ready = rows
    .filter((f) => f.verb === "hosting.deploy" && f.status === 200)
    .map((f) => (f.response as { mergeDeployment: { state: string; readyAt: string | null } | null }).mergeDeployment)
    .find((d) => d?.state === "ready")
  if (!ready?.readyAt) out.push("no ready merge deployment")
  else if (Date.parse(real.startedAt) < Date.parse(ready.readyAt)) out.push(`real visit started ${real.startedAt}, before the deploy was ready (${ready.readyAt})`)
  if (Date.parse(real.finishedAt) < Date.parse(real.startedAt)) out.push("real visit finished before it started")
  if (real.serverLaneProbe && Date.parse(real.serverLaneProbe.sentAt) < Date.parse(real.startedAt)) out.push("probe sent before the visit")
  const receipts = rows.find((f) => f.verb === "receipts" && f.status === 200)?.request as
    | { markers: { infinite?: { eventIds: string[] }; posthog?: { distinctId: string } } }
    | undefined
  if (!receipts) out.push("no receipts request")
  else {
    for (const id of receipts.markers.infinite?.eventIds ?? []) {
      if (!real.markers.infiniteEventIds.includes(id)) out.push(`receipts asks for ${id}, not observed by the real visit`)
    }
    if (receipts.markers.posthog && receipts.markers.posthog.distinctId !== real.markers.posthogDistinctId) {
      out.push(`receipts asks for distinct id ${receipts.markers.posthog.distinctId}, not the real visit's`)
    }
  }
  for (const mode of ["dry_live", "rehearsal"] as const) {
    const other = pollResult(rows, mode)
    if (!other) continue
    if (other.markers.posthogDistinctId !== null && other.markers.posthogDistinctId === real.markers.posthogDistinctId) {
      out.push(`real visit reuses another load's distinct id (${mode}); §3h.3 is a fresh partition per load`)
    }
    for (const id of real.markers.infiniteEventIds) if (other.markers.infiniteEventIds.includes(id)) out.push(`real visit event id ${id} also in ${mode}`)
  }
  return out
}

describe("bridge-verbs.fixtures.json (§3a)", () => {
  const fixtures = readJson<BridgeVerbFixture[]>("bridge-verbs.fixtures.json")
  const specOf = (verb: string): BridgeVerbSpec => BRIDGE_VERBS[verb as keyof typeof BRIDGE_VERBS]
  const isSuccess = (f: BridgeVerbFixture) => f.status < 400

  it("every row has exactly the fixture keys", () => {
    for (const [index, fixture] of fixtures.entries()) {
      expect(shapeErrors(fixture, BRIDGE_VERB_FIXTURE_SHAPE), `row ${index}`).toEqual([])
    }
  })

  it("success rows: right method, path, status, and exact request and response keys", () => {
    for (const fixture of fixtures.filter(isSuccess)) {
      const label = `${fixture.method} ${fixture.path}`
      expect(fixture.verb, label).not.toBeNull()
      const spec = specOf(fixture.verb!)
      expect(fixture.method, label).toBe(spec.method)
      expect(bridgePathPattern(spec).test(fixture.path), label).toBe(true)
      expect(matchBridgeVerb(fixture.method, fixture.path)?.verb, label).toBe(spec.verb)
      expect(fixture.status, label).toBe(spec.successStatus)
      if (spec.request === null) expect(fixture.request, label).toBeNull()
      else expect(shapeErrors(fixture.request, spec.request), label).toEqual([])
      expect(shapeErrors(fixture.response, spec.response), label).toEqual([])
      const response = fixture.response as { protocolVersion: number; requestId: string }
      expect(response.protocolVersion, label).toBe(1)
      if (fixture.request !== null) expect(response.requestId, label).toBe((fixture.request as { requestId: string }).requestId)
    }
  })

  it("covers every verb with at least one success row", () => {
    const covered = new Set(fixtures.filter(isSuccess).map((f) => f.verb))
    expect(BRIDGE_VERB_IDS.filter((verb) => !covered.has(verb))).toEqual([])
  })

  it("error rows: an example of EVERY error code, each with its HTTP status and the error envelope", () => {
    const errors = fixtures.filter((f) => !isSuccess(f))
    const codes = new Set(errors.map((f) => (f.response as { error: { code: string } }).error.code))
    expect([...codes].sort()).toEqual([...BRIDGE_ERROR_CODES].sort())
    for (const fixture of errors) {
      const error = (fixture.response as { error: { code: keyof typeof BRIDGE_ERROR_STATUS; state?: string; upstreamStatus?: number } }).error
      expect(shapeErrors(fixture.response, BRIDGE_ERROR_RESPONSE_SHAPE), error.code).toEqual([])
      expect(fixture.status, error.code).toBe(BRIDGE_ERROR_STATUS[error.code])
      // §3z.2: upstreamStatus appears only on cloud_error; a state is one §3z.3 lists for its code.
      if (error.upstreamStatus !== undefined) expect(error.code).toBe("cloud_error")
      const known = (BRIDGE_ERROR_STATES as Partial<Record<string, readonly string[]>>)[error.code]
      if (error.state !== undefined && error.code !== "claimed_by_other") expect(known, `${error.code} state ${error.state}`).toContain(error.state)
    }
  })

  it("§3z rows: the three new codes, the relay binding while not rolled out, the skip-only provision and the facts verb", () => {
    const errorOf = (f: BridgeVerbFixture) => (f.response as { error?: { code: string; state?: string; field?: string } }).error
    expect(fixtures.find((f) => errorOf(f)?.code === "role_required")?.status).toBe(403)
    expect(errorOf(fixtures.find((f) => errorOf(f)?.code === "site_setup_locked")!)?.state).toBe("live_site_lock")
    expect(fixtures.find((f) => errorOf(f)?.code === "internal_error")?.status).toBe(500)
    const bind = fixtures.find((f) => f.verb === "meta-relay.enable" && f.status === 200 && (f.response as { reason: string | null }).reason === "not_rolled_out")
    expect(bind?.response).toMatchObject({ available: false, enabled: true, bound: { sourceRef: "meta_src_FAKE_0001" } })
    const serving = fixtures.find((f) => f.verb === "server-lane.provision-env" && (f.request as { redeploy?: string } | null)?.redeploy === "serving_production")!
    expect(serving.status).toBe(400)
    expect(errorOf(serving)?.field).toBe("redeploy")
    for (const row of fixtures.filter((f) => f.verb === "server-lane.provision-env" && f.status === 200)) expect((row.request as { redeploy: string }).redeploy).toBe("skip")
    const facts = fixtures.find((f) => f.verb === "test.facts" && f.status === 200)!
    expect((facts.response as { result: TestResult }).result.mode).toBe("real_visit")
    expect(fixtures.some((f) => f.verb === "baseline" && f.status === 200 && f.path.includes("&since="))).toBe(true)
    // A10: every proofState PATCH names its producer.
    for (const row of fixtures.filter((f) => f.verb === "runs.patch" && (f.request as { patch?: { proofState?: string } } | null)?.patch?.proofState)) {
      expect((row.request as { producer?: string }).producer).toBe("tag")
    }
  })

  it("§3y.2 rows: site-claim answers exactly one of source / claim, the claim's key is reserved-shaped and its proof body exact", () => {
    const claimRows = fixtures.filter((f) => f.verb === "site-claim" && f.status === 200)
    expect(claimRows.map((row) => (row.response as { state: string }).state).sort()).toEqual(["pending_proof", "ready"])
    for (const row of claimRows) {
      const response = row.response as { state: string; siteSource: unknown; claim: unknown }
      expect((response.siteSource === null) !== (response.claim === null), row.path).toBe(true)
      expect(response.state === "ready" ? response.siteSource : response.claim).not.toBeNull()
    }
    const claims = fixtures.flatMap((f) => {
      const response = f.response as { claim?: { siteSourceKey: string; proofBody: string; proofPath: string; state: string } | null }
      return response.claim ? [response.claim] : []
    })
    expect(claims.length).toBeGreaterThanOrEqual(2)
    for (const claim of claims) {
      expect(claim.siteSourceKey).toMatch(RESERVED_SITE_KEY_PATTERN)
      expect(claim.proofBody).toMatch(SITE_PROOF_BODY_PATTERN)
      expect(claim.proofPath).toBe(SITE_PROOF_PATH)
    }
    // A proven prove answer carries the source WITH the reserved key; pending and none carry no source.
    const proves = fixtures.filter((f) => f.verb === "site-prove" && f.status === 200).map((f) => f.response as { state: string; siteSource: { siteSourceKey: string } | null; hosts: Array<{ outcome: string }> })
    expect(proves.map((p) => p.state).sort()).toEqual(["none", "pending", "proven"])
    for (const prove of proves) {
      expect(prove.siteSource === null, prove.state).toBe(prove.state !== "proven")
      for (const host of prove.hosts) expect(PROVE_OUTCOMES).toContain(host.outcome)
    }
    expect(proves.find((p) => p.state === "proven")!.siteSource!.siteSourceKey).toBe(claims[0]!.siteSourceKey)
    // Negative: the shape refuses a claim answer that adds a field (the tag decodes strictly).
    const pending = claimRows.find((row) => (row.response as { state: string }).state === "pending_proof")!
    expect(shapeErrors({ ...(pending.response as object), extra: true }, BRIDGE_VERBS["site-claim"].response).join()).toContain('unknown key "extra"')
    expect(shapeErrors({ ...((pending.response as { claim: object }).claim), token: "x" }, CLAIM_PUBLIC_SHAPE).join()).toContain('unknown key "token"')
  })

  it("negative: a provision-env body that asks for a production redeploy does not type-check as protocol 1", () => {
    // @ts-expect-error protocol 1 accepts only redeploy:"skip" (§3z.7, A9)
    const body: import("./bridge.js").ProvisionEnvBody = { protocolVersion: 1, requestId: "x", redeploy: "serving_production" }
    expect(body.redeploy).toBe("serving_production")
  })

  it("the routing examples really miss: route_not_found matches no verb, method_not_allowed uses another method", () => {
    const byCode = (code: string) => fixtures.find((f) => (f.response as { error?: { code: string } }).error?.code === code)!
    const notFound = byCode("route_not_found")
    expect(notFound.verb).toBeNull()
    expect(matchBridgeVerb(notFound.method, notFound.path)).toBeNull()
    const notAllowed = byCode("method_not_allowed")
    expect(notAllowed.method).not.toBe(specOf(notAllowed.verb!).method)
  })

  it("the unknown_field example's request really breaks the strict decoder (and the valid rows do not)", () => {
    const row = fixtures.find((f) => (f.response as { error?: { code: string } }).error?.code === "unknown_field")!
    expect(shapeErrors(row.request, specOf(row.verb!).request!).join()).toContain("unknown key")
  })

  it("ids have their documented shapes", () => {
    const text = JSON.stringify(fixtures)
    for (const id of text.match(/lk_[A-Za-z0-9_-]+/g) ?? []) expect(id).toMatch(BRIDGE_ID_PATTERNS.linkId)
    for (const id of text.match(/lr_[A-Za-z0-9_-]+/g) ?? []) expect(id).toMatch(BRIDGE_ID_PATTERNS.linkRequestId)
    for (const id of text.match(/tr_[A-Za-z0-9_-]+/g) ?? []) expect(id).toMatch(BRIDGE_ID_PATTERNS.testRunId)
    for (const fp of text.match(/sha256:[0-9a-f]+/g) ?? []) expect(fp).toMatch(BRIDGE_ID_PATTERNS.repoFingerprint)
  })

  it("no field that crosses the bridge would be dropped by the desktop's sanitizer, or carries a cloud id", () => {
    const keys = fixtures.flatMap((f) => [...allKeys(f.request), ...allKeys(f.response)])
    expect(keys.filter((key) => !isSanitizerSafeFieldName(key))).toEqual([])
    expect(keys).not.toContain("engineProjectId")
    expect(keys).not.toContain("cloudWorkspaceId")
    expect(keys).not.toContain("projectToken")
  })

  it("negative: the sanitizer rule mirrors the desktop's (normalised names, the private key set, prototype keys)", () => {
    for (const name of ["projectKey", "siteSourceKey", "pixelId", "runId", "linkId", "keyEvents"]) expect(isSanitizerSafeFieldName(name), name).toBe(true)
    for (const name of [
      "fooToken",
      "token",
      "apikey",
      "ApiKey",
      "api_key",
      "API-KEY",
      "credentialRef",
      "mcpCredential",
      "encryptionKey",
      "providerRoute",
      "service_role_key",
      "authorization",
      "engineProjectId",
      "cloud_workspace_id",
      "confirmationId",
      "access_token",
      "__proto__",
      "constructor",
      "prototype"
    ]) {
      expect(isSanitizerSafeFieldName(name), name).toBe(false)
    }
  })

  it("path params match only their id shape: '..', an encoded dot-dot or a foreign id is no route", () => {
    const runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    expect(matchBridgeVerb("GET", `/v1/runs/${runId}`)?.verb).toBe("runs.get")
    expect(matchBridgeVerb("POST", `/v1/runs/${runId}/receipts`)?.verb).toBe("receipts")
    expect(matchBridgeVerb("GET", "/v1/test/runs/tr_FAKEdryLive00000000000?wait=25")?.verb).toBe("test.poll")
    expect(matchBridgeVerb("GET", "/v1/link/request/lr_FAKElinkRequestAcme000?wait=25")?.verb).toBe("link.poll")
    for (const path of ["/v1/runs/..", "/v1/runs/%2e%2e", "/v1/runs/.", "/v1/runs/abc", `/v1/runs/${runId.toUpperCase()}`, "/v1/test/runs/..", "/v1/test/runs/lr_FAKElinkRequestAcme000", "/v1/link/request/x"]) {
      expect(matchBridgeVerb(path.startsWith("/v1/runs/") ? "GET" : "GET", path), path).toBeNull()
    }
    expect(() => bridgePathPattern({ path: "/v1/things/:thingId" })).toThrow(/no id pattern/)
  })

  it("the story's proof chain is run-scoped: the real visit runs after the deploy, and receipts ask only for its markers", () => {
    expect(proofChainViolations(fixtures)).toEqual([])
  })

  it("negatives: receipts that reuse the dry load's markers, or a real visit before the deploy, are caught", () => {
    const clone = () => JSON.parse(JSON.stringify(fixtures)) as BridgeVerbFixture[]
    const reused = clone()
    const dry = pollResult(reused, "dry_live")!
    const receipts = reused.find((f) => f.verb === "receipts" && f.status === 200)!.request as { markers: { infinite: { eventIds: string[] }; posthog: { distinctId: string } } }
    receipts.markers.infinite.eventIds = [...dry.markers.infiniteEventIds]
    receipts.markers.posthog.distinctId = dry.markers.posthogDistinctId!
    const errors = proofChainViolations(reused).join()
    expect(errors).toContain("not observed by the real visit")
    expect(errors).toContain("distinct id")

    const early = clone()
    pollResult(early, "real_visit")!.startedAt = "2026-10-02T09:10:00.000Z"
    expect(proofChainViolations(early).join()).toContain("before the deploy was ready")

    const sharedId = clone()
    pollResult(sharedId, "real_visit")!.markers.posthogDistinctId = pollResult(sharedId, "dry_live")!.markers.posthogDistinctId
    expect(proofChainViolations(sharedId).join()).toContain("reuses another load's distinct id")
  })

  it("every test run loads only its own targets, and the preview's own URL is a separate dry_live after the rehearsal", () => {
    const starts = fixtures.filter((f) => f.verb === "test.start" && f.status === 202)
    for (const start of starts) {
      const testRunId = (start.response as { testRunId: string }).testRunId
      const poll = fixtures.find((f) => f.verb === "test.poll" && f.status === 200 && f.path.includes(testRunId) && (f.response as { result?: unknown }).result)
      if (!poll) continue
      const result = (poll.response as { result: TestResult }).result
      expect(loadsOffTarget(start.request as TestRunRequest, result), testRunId).toEqual([])
      expect(result.mode).toBe((start.request as TestRunRequest).mode)
    }
    const modes = starts.map((f) => `${(f.request as TestRunRequest).mode}:${(f.request as TestRunRequest).targets[0]!.label}`)
    expect(modes.indexOf("dry_live:preview_self")).toBe(modes.indexOf("rehearsal:home") + 1)
  })

  it("every test request's expect is exactly testExpectFromKeys(the keys row) (R2-16)", () => {
    const keys = fixtures.find((f) => f.verb === "keys" && f.status === 200)!.response as KeysResponse
    const derived = testExpectFromKeys(keys)
    // §3z.9 (A16): expect.posthog.apiHost is the connection's INGEST host, never "/ingest".
    expect(derived.posthog).toEqual({ projectKey: keys.posthog.projectKey, apiHost: keys.posthog.ingestHost })
    expect(testExpectFromKeys({ ...keys, posthog: { ...keys.posthog, apiHost: "/ingest", ingestHost: "https://eu.i.posthog.com" } }).posthog?.apiHost).toBe("https://eu.i.posthog.com")
    expect(testExpectFromKeys({ ...keys, posthog: { ...keys.posthog, ingestHost: null } }).posthog).toBeUndefined()
    for (const start of fixtures.filter((f) => f.verb === "test.start" && f.status === 202)) {
      expect((start.request as TestRunRequest).expect, (start.response as { testRunId: string }).testRunId).toEqual(derived)
    }
    // Negatives: an unconnected tool gets no entry; a tool that is connected but has no ids gets none either.
    expect(testExpectFromKeys({ ...keys, posthog: { ...keys.posthog, status: "not_connected" } }).posthog).toBeUndefined()
    expect(testExpectFromKeys({ ...keys, meta: { status: "connected", pixels: [] } }).meta).toBeUndefined()
  })

  it("§3y.2: while a claim is pending, expect.infinite is the claim's reserved key (a cloud answer); the keys win once proven", () => {
    const keys = fixtures.find((f) => f.verb === "keys" && f.status === 200)!.response as KeysResponse
    const fresh: KeysResponse = { ...keys, infinite: { status: "not_provisioned", siteSourceKey: null, productionHosts: [], consentMode: null, consentStorageKey: null, collectPath: null } }
    const claim = { siteSourceKey: "site_fa4e000000000000000000000000c1a1", collectPath: "/infinite/ledger", state: "pending_proof" }
    expect(testExpectFromKeys(fresh).infinite).toBeUndefined()
    expect(testExpectFromKeys(fresh, claim).infinite).toEqual({ siteSourceKey: claim.siteSourceKey, collectPath: "/infinite/ledger" })
    // NEGATIVE: a proven (or expired) claim is never consulted; a ready source always wins over a claim.
    expect(testExpectFromKeys(fresh, { ...claim, state: "proven" }).infinite).toBeUndefined()
    expect(testExpectFromKeys(keys, claim).infinite?.siteSourceKey).toBe(keys.infinite.siteSourceKey)
  })

  it("the story is internally consistent: lane state, relay availability, and only click-tested GA4 key events", () => {
    const keys = fixtures.find((f) => f.verb === "keys" && f.status === 200)!.response as KeysResponse
    const laneStatus = fixtures.find((f) => f.verb === "server-lane.status" && f.status === 200)!.response as { laneState: string }
    expect(keys.serverLane.laneState).toBe(laneStatus.laneState)
    const storyEnd = fixtures.findIndex((f) => f.verb === "link.revoke" && f.status === 200)
    const story = fixtures.slice(0, storyEnd + 1)
    const relayStatus = story.find((f) => f.verb === "meta-relay.status")!.response as { available: boolean }
    expect(relayStatus.available).toBe(true)
    const clickTested = new Set<string>()
    for (const row of story) {
      const patch = (row.request as { patch?: { clickTestedConversions?: string[] } } | null)?.patch
      patch?.clickTestedConversions?.forEach((name) => clickTested.add(name))
      if (row.verb === "ga4-key-events") {
        for (const name of (row.request as { names: string[] }).names) expect(clickTested.has(name), name).toBe(true)
      }
    }
    const expiredPoll = fixtures.find((f) => f.verb === "link.poll" && f.status === 200 && (f.response as { state: string }).state === "expired")
    expect(expiredPoll, "the §3a.3 200 expired poll").toBeDefined()
  })

  it("the verb table: keys equal verbs, capabilities are known, and the §3a.9.4 state-changing set is marked", () => {
    for (const id of BRIDGE_VERB_IDS) {
      expect(BRIDGE_VERBS[id].verb).toBe(id)
      expect(TAG_CAPABILITIES).toContain(BRIDGE_VERBS[id].capability)
      expect(BRIDGE_VERBS[id].linkScoped || !BRIDGE_VERBS[id].paid, `${id}: paid implies link-scoped`).toBe(true)
    }
    expect([...STATE_CHANGING_VERBS].sort()).toEqual(
      [
        "server-lane.provision-env",
        "ga4-key-events",
        "conversions",
        "meta-relay.enable",
        "site-source",
        "site-claim",
        "site-prove",
        "uninstall.remove-env",
        "uninstall.disable-site-source",
        "runs.proof-claim",
        "link.revoke"
      ].sort()
    )
    expect(matchBridgeVerb("GET", "/v1/turn")).toBeNull()
    expect(matchBridgeVerb("POST", "/v1/keys")).toBeNull()
    expect(matchBridgeVerb("GET", "/v1/runs/abc/proof-claim")).toBeNull()
  })
})

/** Every §3h.8 rule a grader must be tested against, and every expectation's code must come from the vocabulary. */
function expectationGaps(cases: TestRunFixtureCase[]): string[] {
  const out: string[] = []
  const seen = { problem: new Set<string>(), undetermined: new Set<string>(), info: new Set<string>() }
  const posthogDuplicate = cases.some((c) => c.expected.posthog?.because === "duplicate_page_view")
  const ga4Duplicate = cases.some((c) => c.expected.ga4?.because === "duplicate_page_view")
  const metaTr4xx = cases.some((c) => c.expected.meta?.because === "meta_tr_rejected" && c.result.meta.tr.some((t) => typeof t.status === "number" && t.status >= 400 && t.status < 500))
  for (const c of cases) {
    for (const [key, e] of Object.entries(c.expected)) {
      if (!e) continue
      const where = `${c.id}.${key}`
      if (e.state === "problem") {
        if (!(TEST_PROBLEM_CODES as readonly string[]).includes(e.because ?? "")) out.push(`${where}: problem code ${e.because} not in TEST_PROBLEM_CODES`)
        seen.problem.add(e.because ?? "")
      }
      if (e.state === "undetermined") {
        if (!(TEST_UNDETERMINED_REASONS as readonly string[]).includes(e.because ?? "")) out.push(`${where}: reason ${e.because} not in TEST_UNDETERMINED_REASONS`)
        seen.undetermined.add(e.because ?? "")
      }
      if (e.state === "info") {
        if (!(TEST_INFO_CODES as readonly string[]).includes(e.because ?? "")) out.push(`${where}: info code ${e.because} not in TEST_INFO_CODES`)
        if (typeof e.count !== "number") out.push(`${where}: info without a measured count`)
        seen.info.add(e.because ?? "")
      }
      if (e.count !== undefined && e.state !== "info") out.push(`${where}: count on a non-info expectation`)
    }
  }
  for (const code of TEST_PROBLEM_CODES) if (!seen.problem.has(code)) out.push(`no case for problem ${code}`)
  // test_error has no facts to fixture (a crash or deadline); every other reason needs a case.
  for (const reason of TEST_UNDETERMINED_REASONS) if (reason !== "test_error" && !seen.undetermined.has(reason)) out.push(`no case for undetermined ${reason}`)
  for (const code of TEST_INFO_CODES) if (!seen.info.has(code)) out.push(`no case for info ${code}`)
  if (!ga4Duplicate || !posthogDuplicate) out.push("duplicate_page_view needs a GA4 page_view AND a PostHog $pageview case")
  if (!metaTr4xx) out.push("meta_tr_rejected needs a case whose tr status is 4xx")
  return out
}

/** Every load is one of its request's targets (D2 loads only what it was asked to load). */
function loadsOffTarget(request: TestRunRequest, result: TestResult): string[] {
  const targets = new Set(request.targets.map((t) => t.url))
  return result.loads.filter((load) => !targets.has(load.url)).map((load) => `${load.label}: ${load.url} is not a target`)
}

describe("test-run.fixtures.json (§3h; the grader's cases)", () => {
  const cases = readJson<TestRunFixtureCase[]>("test-run.fixtures.json")
  const productionOrSibling = (host: string) => host === "acme-store.com" || host.endsWith(".acme-store.com")

  it("every case has exactly the case keys, the request keys and the FACT keys (no state, no verdict)", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    for (const testCase of cases) {
      expect(shapeErrors(testCase, TEST_RUN_FIXTURE_CASE_SHAPE), testCase.id).toEqual([])
      expect(testCase.result.mode, testCase.id).toBe(testCase.request.mode)
      const resultKeys = allKeys(testCase.result)
      expect(resultKeys, testCase.id).not.toContain("verdict")
      expect(resultKeys.filter((key) => !isSanitizerSafeFieldName(key)), testCase.id).toEqual([])
    }
  })

  it("every request obeys the §3h.1 mode rules (a production dry load carries no clicks and no fake click id)", () => {
    for (const testCase of cases) {
      expect(testRequestModeErrors(testCase.request, productionOrSibling), testCase.id).toEqual([])
    }
  })

  it("negatives: the mode rules refuse what the desktop answers 400 to", () => {
    const real = cases.find((c) => c.request.mode === "real_visit")!.request
    expect(testRequestModeErrors({ ...real, clicks: [{ selector: "a", label: "a" }] }, productionOrSibling).join()).toContain(
      "clicks is not allowed in real_visit"
    )
    expect(testRequestModeErrors({ ...real, targets: [...real.targets, ...real.targets] }, productionOrSibling).join()).toContain(
      "exactly one target"
    )
    const dry = cases.find((c) => c.request.mode === "dry_live")!.request
    const dryOnProductionWithFakeId: TestRunRequest = { ...dry, fakeClickId: true }
    expect(testRequestModeErrors(dryOnProductionWithFakeId, productionOrSibling).join()).toContain(
      "fakeClickId is not allowed against the production host"
    )
    const dryOnPreview: TestRunRequest = { ...dryOnProductionWithFakeId, targets: [{ url: "https://acme-git-x.vercel.app/", label: "preview_self" }] }
    expect(testRequestModeErrors(dryOnPreview, productionOrSibling)).toEqual([])
  })

  it("negatives: the production host is normalised first, a bad URL is an error, and a real visit targets production", () => {
    const dry = cases.find((c) => c.request.mode === "dry_live" && c.request.targets[0]!.label === "home")!.request
    for (const url of ["https://WWW.Acme-Store.COM./", "https://acme-store.com./", "https://ACME-STORE.COM/"]) {
      const withClicks: TestRunRequest = { ...dry, targets: [{ url, label: "home" }], clicks: [{ selector: "a", label: "a" }], fakeClickId: true }
      const errors = testRequestModeErrors(withClicks, productionOrSibling).join()
      expect(errors, url).toContain("clicks is not allowed against the production host")
      expect(errors, url).toContain("fakeClickId is not allowed against the production host")
    }
    expect(testRequestModeErrors({ ...dry, targets: [{ url: "not a url", label: "home" }] }, productionOrSibling).join()).toContain("invalid URL")
    expect(() => testRequestModeErrors({ ...dry, targets: [{ url: "::", label: "home" }] }, productionOrSibling)).not.toThrow()
    const real = cases.find((c) => c.request.mode === "real_visit")!.request
    for (const url of ["https://evil.example/", "https://acme-store-git-infinite-tag-2026-10-02-7f3c2a-acme.vercel.app/"]) {
      expect(testRequestModeErrors({ ...real, targets: [{ url, label: "home" }] }, productionOrSibling).join(), url).toContain(
        "real_visit target must be the production host"
      )
    }
    expect(testRequestModeErrors({ ...real, targets: [{ url: "https://Www.Acme-Store.com./", label: "home" }] }, productionOrSibling)).toEqual([])
  })

  it("the fake click id appears only where a no-send load put it, never in a real visit", () => {
    for (const testCase of cases) {
      const text = JSON.stringify(testCase.result)
      if (testCase.request.mode === "real_visit") expect(text, testCase.id).not.toContain("INFINITE_TEST_NOT_REAL_")
      if (text.includes("INFINITE_TEST_NOT_REAL_")) {
        expect(testCase.request.fakeClickId, testCase.id).toBe(true)
        expect(text, testCase.id).toContain(fakeClickIdFor(testCase.request.runId))
      }
    }
  })

  it("expectations: undetermined always names a TEST_UNDETERMINED_REASONS code, and the §3h.8 cases are all present", () => {
    for (const testCase of cases) {
      for (const [tool, expectation] of Object.entries(testCase.expected)) {
        if (expectation?.state === "undetermined") {
          expect(TEST_UNDETERMINED_REASONS as readonly string[], `${testCase.id}.${tool}`).toContain(expectation.because)
        }
      }
    }
    expect(expectationGaps(cases)).toEqual([])
    // A tid equal to either of two connection streams is a pass.
    const second = cases.find((c) => c.id === "dry_live_ga4_second_stream")!
    expect(second.request.expect.ga4).toContain(second.result.ga4.events[0]!.tid)
    expect(second.expected.ga4?.state).toBe("pass")
  })

  it("negative: a fixture set missing a §3h.8 rule, or using an unknown code, is caught", () => {
    expect(expectationGaps(cases.filter((c) => c.id !== "dry_live_meta_automatic_events_info")).join()).toContain("no case for info meta_automatic_events")
    expect(expectationGaps(cases.filter((c) => c.id !== "real_visit_meta_tr_rejected")).join()).toContain("meta_tr_rejected")
    expect(expectationGaps(cases.filter((c) => c.id !== "dry_live_posthog_double_pageview")).join()).toContain("PostHog $pageview")
    expect(expectationGaps(cases.filter((c) => c.id !== "dry_live_posthog_not_connected")).join()).toContain("undetermined not_connected")
    const unknown = JSON.parse(JSON.stringify(cases)) as TestRunFixtureCase[]
    unknown[0]!.expected.ga4 = { state: "problem", because: "looks_bad" }
    expect(expectationGaps(unknown).join()).toContain("looks_bad not in TEST_PROBLEM_CODES")
  })

  it("D10: Meta automatic events are graded beside the Meta tool, with a count, for an adopted pixel", () => {
    const info = cases.find((c) => c.id === "dry_live_meta_automatic_events_info")!
    expect(info.context.metaPixelOwnership).toBe("adopted")
    expect(info.expected.meta?.state).toBe("pass")
    expect(info.expected.meta_automatic_events).toEqual({ state: "info", because: "meta_automatic_events", count: 1 })
    expect(info.result.clicks).toEqual([])
    const blocked = cases.find((c) => c.id === "dry_live_meta_traffic_permissions_blocked")!
    expect(blocked.expected.meta_automatic_events).toEqual({ state: "undetermined", because: "traffic_permissions_blocked" })
  })

  it("a tool with no connection has no expect entry and reads undetermined(not_connected)", () => {
    const notConnected = cases.find((c) => c.id === "dry_live_posthog_not_connected")!
    expect(notConnected.request.expect.posthog).toBeUndefined()
    expect(notConnected.result.posthog.events.length).toBeGreaterThan(0)
    expect(notConnected.expected.posthog).toEqual({ state: "undetermined", because: "not_connected" })
  })

  it("every load is one of its request's targets; preview_self is its own dry_live, never a rehearsal load", () => {
    for (const testCase of cases) expect(loadsOffTarget(testCase.request, testCase.result), testCase.id).toEqual([])
    for (const testCase of cases.filter((c) => c.request.mode === "rehearsal")) {
      expect(testCase.result.loads.map((l) => l.label), testCase.id).not.toContain("preview_self")
    }
    const previewSelf = cases.find((c) => c.request.targets.some((t) => t.label === "preview_self"))!
    expect(previewSelf.request.mode).toBe("dry_live")
    // Negative: the old shape (a rehearsal that loads the bare apex and the preview, neither of them a target).
    const drifted = JSON.parse(JSON.stringify(cases.find((c) => c.id === "rehearsal_click_test")!)) as TestRunFixtureCase
    drifted.result.loads.push({ ...drifted.result.loads[0]!, label: "preview_self", url: "https://acme-git-x.vercel.app/" })
    expect(loadsOffTarget(drifted.request, drifted.result).join()).toContain("preview_self")
  })

  it("markers come from the load's own events (one set per load, never copied from another load)", () => {
    for (const testCase of cases) {
      const r = testCase.result
      expect([...r.markers.infiniteEventIds].sort(), testCase.id).toEqual([...new Set(r.infinite.events.map((e) => e.eventId))].sort())
      const distinct = [...new Set(r.posthog.events.map((e) => e.distinctId))]
      expect(r.markers.posthogDistinctId, testCase.id).toBe(distinct[0] ?? null)
    }
  })

  it("expect comes only from the keys verb: every present entry equals testExpectFromKeys(keys)", () => {
    const keys = readJson<BridgeVerbFixture[]>("bridge-verbs.fixtures.json").find((f) => f.verb === "keys" && f.status === 200)!.response as KeysResponse
    const derived = testExpectFromKeys(keys)
    for (const testCase of cases) {
      for (const [tool, value] of Object.entries(testCase.request.expect)) {
        expect(value, `${testCase.id}.${tool}`).toEqual(derived[tool as keyof typeof derived])
      }
    }
  })

  it("helpers: the fake click id and the probe path come from the run id", () => {
    expect(fakeClickIdFor("7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80")).toBe("INFINITE_TEST_NOT_REAL_7f3c2a")
    expect(serverLaneProbePathFor("7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80")).toBe("/__infinite_probe/7f3c2a91b0de")
  })
})

describe("receipts.fixtures.json (§3h.7)", () => {
  const cases = readJson<ReceiptsFixtureCase[]>("receipts.fixtures.json")

  it("every case has exactly the case, request and response keys", () => {
    for (const testCase of cases) expect(shapeErrors(testCase, RECEIPTS_FIXTURE_CASE_SHAPE), testCase.id).toEqual([])
  })

  it("verified only with a receipt at or after the run's server start; GA4 only from its realtime read (R4-3); the Meta pixel never", () => {
    for (const testCase of cases) {
      for (const [lane, receipt] of Object.entries(testCase.response.lanes)) {
        if (receipt.state === "verified") {
          expect(receipt.receiptAt, `${testCase.id}.${lane}`).not.toBeNull()
          expect(Date.parse(receipt.receiptAt!) >= Date.parse(testCase.runStartedAt), `${testCase.id}.${lane}`).toBe(true)
        }
      }
      const ga4 = testCase.response.lanes.ga4
      if (ga4.state === "verified") expect(ga4.provenance, testCase.id).toBe("ga4_realtime")
      if (ga4.provenance === "ga4_realtime" && ga4.reason !== null) expect(GA4_REALTIME_REASONS as readonly string[], testCase.id).toContain(ga4.reason)
      expect(testCase.response.lanes.meta_pixel.state).not.toBe("verified")
    }
    // R4-3: the received case and the busy case are both pinned.
    expect(cases.find((testCase) => testCase.id === "ga4_realtime_received")?.response.lanes.ga4).toMatchObject({ state: "verified", provenance: "ga4_realtime" })
    expect(cases.find((testCase) => testCase.id === "ga4_realtime_busy")?.response.lanes.ga4).toMatchObject({ state: "delivering", reason: "ga4_realtime_busy" })
  })

  it("LF4-P1-1: every GA4 realtime case is the ONE rule — its windows, poll by poll, and its lane from the reads (1bu-1 replays the same bytes)", () => {
    const ga4Cases = cases.filter((testCase) => testCase.ga4Realtime !== undefined)
    expect(ga4Cases.map((testCase) => testCase.id).sort()).toEqual([
      "ga4_realtime_busy",
      "ga4_realtime_final_stands",
      "ga4_realtime_late_visitor",
      "ga4_realtime_none",
      "ga4_realtime_pending",
      "ga4_realtime_received",
      "ga4_realtime_unavailable"
    ])
    for (const testCase of ga4Cases) {
      const world = testCase.ga4Realtime!
      const first = world.reads[0]!
      let lane: LaneReceipt | null = null
      for (const read of world.reads) {
        if (lane !== null && ga4RealtimeFinal(lane)) {
          // After a final answer the cloud never asks GA4 again.
          expect(read, `${testCase.id} @ ${read.at}`).toEqual({ at: read.at, windows: null, pageViews: null, notAsked: true })
          continue
        }
        expect(read.notAsked, `${testCase.id} @ ${read.at}`).toBeUndefined()
        expect(read.windows, `${testCase.id} @ ${read.at}`).toEqual(ga4RealtimeWindows(world.proofClaimedAt, read.at))
        // The wait runs from the lane's first poll (the cloud's stored row), like every other lane's.
        lane = ga4RealtimeLane(read, Date.parse(read.at) - Date.parse(first.at) < testCase.request.waitMs)
      }
      expect(testCase.response.checkedAt, testCase.id).toBe(world.reads[world.reads.length - 1]!.at)
      expect(testCase.response.lanes.ga4, testCase.id).toEqual(lane)
      expect(ga4RealtimeAfterReads(world, testCase.request.waitMs), testCase.id).toEqual(lane)
      expect(testCase.request.markers.ga4, testCase.id).toMatchObject({ seenLeaving: true })
    }
    // GA4 not connected (no world): GA4 is never asked, so its lane is the desktop's seen-leaving answer.
    for (const testCase of cases.filter((entry) => entry.ga4Realtime === undefined)) {
      expect(testCase.response.lanes.ga4.provenance, testCase.id).toBe("desktop_test")
      expect(testCase.response.lanes.ga4.state, testCase.id).not.toBe("verified")
    }
  })

  it("LF4-P1-1 negatives: the rule never says verified for a busy stream, a refused read, a passed window or nothing counted", () => {
    const windows = ga4RealtimeWindows("2026-10-02T09:40:00.000Z", "2026-10-02T09:40:30.000Z")
    const read = (pageViews: { before: number; after: number } | null, w = windows) => ({ at: "2026-10-02T09:40:30.000Z", windows: w, pageViews })
    expect(ga4RealtimeLane(read({ before: 1, after: 5 }), true)).toMatchObject({ state: "delivering", reason: "ga4_realtime_busy" })
    expect(ga4RealtimeLane(read(null), true)).toMatchObject({ state: "delivering", reason: "ga4_realtime_unavailable" })
    expect(ga4RealtimeLane(read({ before: 0, after: 1 }, null), true)).toMatchObject({ state: "delivering", reason: "ga4_realtime_unavailable" })
    expect(ga4RealtimeLane(read({ before: 0, after: 0 }), false)).toMatchObject({ state: "no_receipt", reason: "ga4_realtime_none" })
    expect(ga4RealtimeLane(read({ before: 0, after: 1 }), true)).toEqual({ state: "verified", receiptAt: "2026-10-02T09:40:30.000Z", reason: null, provenance: "ga4_realtime" })
    // Whole clock minutes: a claim at :59 read 2 s later is already minute 1, so the claim's minute stays "after".
    expect(ga4RealtimeWindows("2026-10-02T09:40:59.000Z", "2026-10-02T09:41:01.000Z")).toEqual({
      before: { startMinutesAgo: 6, endMinutesAgo: 2 },
      after: { startMinutesAgo: 1, endMinutesAgo: 0 }
    })
    // Live-fix 4 round 1: anchored to the claim's absolute minutes. Read 10 minutes on, `after` is still only the claim's
    // minute and the next (never minutes 10..0, where any later visitor would count), and `before` still the 5 before.
    expect(ga4RealtimeWindows("2026-10-02T09:40:10.000Z", "2026-10-02T09:50:30.000Z")).toEqual({
      before: { startMinutesAgo: 15, endMinutesAgo: 11 },
      after: { startMinutesAgo: 10, endMinutesAgo: 9 }
    })
    // Past realtime's 29-minute reach the 5 minutes before the claim cannot all be read.
    expect(ga4RealtimeWindows("2026-10-02T09:00:00.000Z", "2026-10-02T09:25:00.000Z")).toBeNull()
    expect(ga4RealtimeWindows("2026-10-02T09:00:00.000Z", "2026-10-02T09:24:00.000Z")).toEqual({
      before: { startMinutesAgo: 29, endMinutesAgo: 25 },
      after: { startMinutesAgo: 24, endMinutesAgo: 23 }
    })
  })

  it("live-fix 4 round 1: a final GA4 answer (verified, busy, none) stands; pending and unavailable are asked again", () => {
    const lane = (state: LaneReceipt["state"], reason: string | null, provenance: LaneReceipt["provenance"] = "ga4_realtime") => ({ state, reason, provenance })
    expect(ga4RealtimeFinal(lane("verified", null))).toBe(true)
    expect(ga4RealtimeFinal(lane("delivering", "ga4_realtime_busy"))).toBe(true)
    expect(ga4RealtimeFinal(lane("no_receipt", "ga4_realtime_none"))).toBe(true)
    expect(ga4RealtimeFinal(lane("pending", null))).toBe(false)
    expect(ga4RealtimeFinal(lane("delivering", "ga4_realtime_unavailable"))).toBe(false)
    // The desktop's seen-leaving answer is not GA4's: never final here.
    expect(ga4RealtimeFinal(lane("no_receipt", "not seen leaving", "desktop_test"))).toBe(false)
    // NEGATIVE (the verifier's repro b/c): without finality, a stored none re-read later by a poll that counts another
    // visitor's page view, or past reach, would re-decide it.
    const world = {
      proofClaimedAt: "2026-10-02T09:40:10.000Z",
      reads: [
        { at: "2026-10-02T09:40:20.000Z", windows: ga4RealtimeWindows("2026-10-02T09:40:10.000Z", "2026-10-02T09:40:20.000Z"), pageViews: { before: 0, after: 0 } },
        { at: "2026-10-02T09:42:30.000Z", windows: ga4RealtimeWindows("2026-10-02T09:40:10.000Z", "2026-10-02T09:42:30.000Z"), pageViews: { before: 0, after: 0 } },
        { at: "2026-10-02T09:52:30.000Z", windows: ga4RealtimeWindows("2026-10-02T09:40:10.000Z", "2026-10-02T09:52:30.000Z"), pageViews: { before: 0, after: 1 } },
        { at: "2026-10-02T10:15:00.000Z", windows: null, pageViews: null }
      ]
    }
    expect(ga4RealtimeAfterReads(world, 120_000)).toMatchObject({ state: "no_receipt", reason: "ga4_realtime_none" })
  })

  it("every case asks only for the markers the story's real visit observed (never a dry load's)", () => {
    const real = pollResult(readJson<BridgeVerbFixture[]>("bridge-verbs.fixtures.json"), "real_visit")!
    for (const testCase of cases) {
      expect(testCase.request.markers.infinite?.eventIds, testCase.id).toEqual(real.markers.infiniteEventIds)
      if (testCase.request.markers.posthog) expect(testCase.request.markers.posthog.distinctId, testCase.id).toBe(real.markers.posthogDistinctId)
    }
  })
})

/** §3i.3 rules 1–3 and §3i.7, as the test reads them (lane O1's builder and C1's parser enforce the same). */
function reportViolations(report: ReportV2): string[] {
  const out: string[] = []
  const check = (where: string, cell: Cell) => {
    if (!(PROVENANCE_SOURCES as readonly string[]).includes(cell.provenance.source)) out.push(`${where}: provenance ${cell.provenance.source}`)
    if (cell.value === null && (cell.display !== "—" || cell.reason === undefined)) out.push(`${where}: null must show "—" with a reason`)
    if (/verified|proven/i.test(cell.display) && (!cell.provenance.receiptAt || cell.provenance.runId !== report.runId)) {
      out.push(`${where}: "verified" without this run's receipt`)
    }
    if (cell.provenance.runId !== report.runId) out.push(`${where}: another run's provenance`)
    if (cell.raw && cell.raw.denominator < 50 && /%/.test(cell.display)) out.push(`${where}: a percentage below the sample floor`)
  }
  for (const row of report.rows) for (const [col, cell] of Object.entries(row.cells)) check(`${row.id}.${col}`, cell)
  for (const line of report.finishLine) {
    for (const [col, cell] of Object.entries(line.cells)) {
      check(`finish.${line.id}.${col}`, cell)
      const spec = FINISH_LINE_SOURCES[line.id][col as "live_today" | "in_pr" | "proven_live"]
      if (spec.notMeasured) {
        if (cell.state !== "not_measured") out.push(`finish.${line.id}.${col}: must be not_measured`)
      } else if (!allowedFinishLineProvenance(line.id, col as "live_today").includes(cell.provenance.source)) {
        out.push(`finish.${line.id}.${col}: source ${cell.provenance.source} is not one §3i.7 allows`)
      }
    }
  }
  return out
}

describe("report-v2.example.json (§3i)", () => {
  const report = readJson<ReportV2>("report-v2.example.json")

  it("has exactly the report keys, every row and finish-line id in order, and obeys §3i.3 + §3i.7", () => {
    expect(shapeErrors(report, REPORT_V2_SHAPE)).toEqual([])
    expect(report.rows.map((row) => row.id)).toEqual([...REPORT_ROW_IDS])
    expect(report.finishLine.map((line) => [line.n, line.id])).toEqual(FINISH_LINE_IDS.map((id, index) => [index + 1, id]))
    expect(reportViolations(report)).toEqual([])
  })

  it("negatives: an agent-sourced cell, an unreceipted 'verified', a null shown as 0, and a wrong finish-line source all fail", () => {
    const clone = () => JSON.parse(JSON.stringify(report)) as ReportV2
    const agent = clone()
    ;(agent.rows[1]!.cells.live_today.provenance as { source: string }).source = "agent"
    expect(reportViolations(agent).join()).toContain("provenance agent")

    const unreceipted = clone()
    unreceipted.rows[1]!.cells.proven_live = { ...unreceipted.rows[1]!.cells.proven_live, display: "verified", provenance: { ...unreceipted.rows[1]!.cells.proven_live.provenance } }
    delete unreceipted.rows[1]!.cells.proven_live.provenance.receiptAt
    expect(reportViolations(unreceipted).join()).toContain('"verified" without')

    const zero = clone()
    zero.rows[4]!.cells.proven_live = { ...zero.rows[4]!.cells.proven_live, display: "0" }
    expect(reportViolations(zero).join()).toContain('must show "—"')

    const wrongSource = clone()
    wrongSource.finishLine[0]!.cells.proven_live.provenance.source = "plan_answer"
    expect(reportViolations(wrongSource).join()).toContain("not one §3i.7 allows")
  })

  it("the per-tool proven cell claims receipts only for the lanes the story's receipts verified (GA4 / Meta pixel are only seen leaving)", () => {
    const receipts = readJson<BridgeVerbFixture[]>("bridge-verbs.fixtures.json").find((f) => f.verb === "receipts" && f.status === 200)!
      .response as { lanes: Record<string, { state: string }> }
    const toolLanes = ["infinite", "posthog", "ga4", "meta_pixel"]
    const verified = toolLanes.filter((lane) => receipts.lanes[lane]!.state === "verified").length
    const leaving = toolLanes.filter((lane) => receipts.lanes[lane]!.state === "delivering").length
    const display = report.rows.find((row) => row.id === "live_test_per_tool")!.cells.proven_live.display
    expect(display).toContain(`${verified} verified`)
    expect(display).toContain(`${leaving} seen leaving`)
    // Negative: the old copy claimed a receipt for every tool.
    expect(display).not.toMatch(/(\d+) of \1 tools: receipts/)
  })

  it("FINISH_LINE_SOURCES covers the 14 ids in order, and every measured cell has an allowed provenance", () => {
    expect(Object.keys(FINISH_LINE_SOURCES)).toEqual([...FINISH_LINE_IDS])
    FINISH_LINE_IDS.forEach((id, index) => {
      expect(FINISH_LINE_SOURCES[id].n).toBe(index + 1)
      for (const col of ["live_today", "in_pr", "proven_live"] as const) {
        const spec = FINISH_LINE_SOURCES[id][col]
        if (!spec.notMeasured && spec.inputs.length > 0) expect(allowedFinishLineProvenance(id, col).length, `${id}.${col}`).toBeGreaterThan(0)
      }
    })
    expect(FINISH_LINE_SOURCES.proof_from_real_visit.live_today.notMeasured).toBe("not_exercised")
    expect(allowedFinishLineProvenance("proof_from_real_visit", "proven_live")).toEqual(["cloud_receipt"])
  })
})

describe("run-state.example.json (§3d.6)", () => {
  it("has exactly the run-state keys, its jobs exactly the ChecklistItem keys", () => {
    const state = readJson<{ jobs: unknown[]; schema: string }>("run-state.example.json")
    expect(shapeErrors(state, WIZARD_RUN_STATE_SHAPE)).toEqual([])
    expect(state.schema).toBe("infinite-tag.wizard-state.v1")
    for (const item of state.jobs) expect(shapeErrors(item, CHECKLIST_ITEM_SHAPE)).toEqual([])
  })
})

describe("review.schema.json and claims.schema.json (§3f.8, §3e.3)", () => {
  it("are byte-identical to the TS constants", () => {
    expect(readText(wizardDir, "review.schema.json")).toBe(schemaFileText(REVIEW_SCHEMA))
    expect(readText(wizardDir, "claims.schema.json")).toBe(schemaFileText(CLAIMS_SCHEMA))
    expect(JSON.parse(readText(wizardDir, "review.schema.json"))).toEqual(REVIEW_SCHEMA)
    expect(JSON.parse(readText(wizardDir, "claims.schema.json"))).toEqual(CLAIMS_SCHEMA)
  })

  it("negative: a drifted copy is caught", () => {
    const drifted = { ...REVIEW_SCHEMA, required: ["verdict", "summary", "checklist"] }
    expect(schemaFileText(drifted)).not.toBe(readText(wizardDir, "review.schema.json"))
  })
})

describe("host-deny-v1.json (§3h.9)", () => {
  it("is §3h.9 as ONE line + newline, byte-identical to HOST_DENY_V1 and to the sha256 1bu-1 (B0) pins", () => {
    const text = readText(contractsDir, "host-deny-v1.json")
    expect(text).toBe(hostDenyFileText())
    expect(text).toBe(`${JSON.stringify(HOST_DENY_V1)}\n`)
    expect(Buffer.byteLength(text)).toBe(208)
    expect(createHash("sha256").update(text).digest("hex")).toBe(HOST_DENY_V1_SHA256)
    expect(HOST_DENY_V1_SHA256).toBe("5ba888c09c73d6d497e41bcb1c1fd9a123e6154f38e3c59b2fd4fcdc5cf74fe8")
    // Negative: the pretty-printed form is a different byte string (and a different pin).
    expect(schemaFileText(HOST_DENY_V1)).not.toBe(text)
    expect(JSON.parse(readText(contractsDir, "host-deny-v1.json"))).toEqual({
      version: 1,
      deny: {
        exact: ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"],
        suffix: [".localhost", ".local", ".vercel.app", ".netlify.app", ".pages.dev"]
      },
      normalize: "trim,lowercase,strip-one-trailing-dot"
    })
  })

  it("is frozen all the way down, so no lane can mutate the shared list", () => {
    expect(Object.isFrozen(HOST_DENY_V1)).toBe(true)
    expect(Object.isFrozen(HOST_DENY_V1.deny)).toBe(true)
    expect(Object.isFrozen(HOST_DENY_V1.deny.exact)).toBe(true)
    expect(Object.isFrozen(HOST_DENY_V1.deny.suffix)).toBe(true)
    expect(() => (HOST_DENY_V1.deny.suffix as string[]).push(".evil")).toThrow()
    expect(HOST_DENY_V1.deny.suffix).toHaveLength(5)
  })

  it("normalizeHost applies §3h.9's rule: trim, lowercase, strip ONE trailing dot", () => {
    expect(normalizeHost("  WWW.Acme-Store.COM. ")).toBe("www.acme-store.com")
    expect(normalizeHost("acme-store.com")).toBe("acme-store.com")
    expect(normalizeHost("acme-store.com..")).toBe("acme-store.com.")
  })
})

describe("host-class-v1.fixture.json (review-2 P3-4 + the 2026-10-03 founder ruling: the production-host class, pinned in both repos)", () => {
  // The SAME bytes as 1bu-1 `src/lib/analytics/wizard/host-class-v1.fixture.json`, which pins the same sha256 against
  // the cloud's classifier: the tag and the cloud class every listed host the same way. Change it in both repos together.
  const HOST_CLASS_V1_SHA256 = "d3de17c350439099355a0b3fc8aec9fe988365fc8cccca50ce46e29202459ba1"
  const text = readText(contractsDir, "host-class-v1.fixture.json")
  const doc = JSON.parse(text) as { version: number; classes: string[]; cases: Array<{ host: string; class: string; note: string }> }
  /** The tag's own class of a host, from the rules `parseHostInput` applies (`refused` = the production-host test). */
  const classWith = (refused: (host: string) => boolean) => (host: string): string => {
    const normalized = host.trim().toLowerCase().replace(/\.$/, "")
    if (!refused(host)) return isDenyListedHost(host) ? "inconsistent" : "custom"
    if (BARE_PLATFORM_HOSTS.includes(normalized)) return "bare_platform"
    if (normalized.endsWith(".vercel.app")) return "vercel"
    return "preview"
  }
  const classOf = classWith(isPreviewShapedHost)

  it("is pinned by sha256 (the bytes 1bu-1 pins)", () => {
    expect(createHash("sha256").update(text).digest("hex")).toBe(HOST_CLASS_V1_SHA256)
    expect(doc.version).toBe(1)
    expect(doc.classes).toEqual(["vercel", "preview", "bare_platform", "custom"])
    for (const klass of doc.classes) expect(doc.cases.some((entry) => entry.class === klass)).toBe(true)
  })

  it("the tag's own rule classes every case exactly as the fixture says, and accepts ONLY custom", () => {
    expect(doc.cases.map((entry) => [entry.host, classOf(entry.host)])).toEqual(doc.cases.map((entry) => [entry.host, entry.class]))
    for (const entry of doc.cases) {
      if (!/^[a-z0-9.-]+\.?$/i.test(entry.host) || !entry.host.includes(".")) continue
      expect([entry.host, parseHostInput(entry.host).ok]).toEqual([entry.host, entry.class === "custom"])
    }
  })

  it("NEGATIVE: a drifted rule is caught (a Vercel production alias accepted, a bare platform domain accepted, *.github.io accepted)", () => {
    // Round 3's rule accepted a one-label production alias; review-2's accepted github.io and *.github.io.
    const productionAlias = (host: string) => /^[a-z0-9]+(?:-[a-z]+)*\.vercel\.app\.?$/i.test(host.trim()) && !host.includes("-git-")
    const aliasAccepted = classWith((host) => isPreviewShapedHost(host) && !productionAlias(host))
    expect(doc.cases.filter((entry) => aliasAccepted(entry.host) !== entry.class).map((entry) => entry.host)).toContain("example-shop-site.vercel.app")
    const githubAccepted = classWith((host) => isPreviewShapedHost(host) && !/github\.io$/.test(host))
    expect(doc.cases.filter((entry) => githubAccepted(entry.host) !== entry.class).map((entry) => entry.host)).toEqual(["acme.github.io", "github.io"])
    const bareAccepted = classWith((host) => isPreviewShapedHost(host) && !BARE_PLATFORM_HOSTS.includes(host))
    expect(doc.cases.some((entry) => bareAccepted(entry.host) !== entry.class)).toBe(true)
  })
})

describe("codes (§3d.5)", () => {
  it("exitCodeFor covers every WizardCode with the table's exit", () => {
    expect(WIZARD_CODES).toHaveLength(Object.keys(WIZARD_CODE_EXIT).length)
    const expected: Record<number, string[]> = {
      1: ["APPLY_ROLLED_BACK", "AGENT_TOOLLESS", "AGENT_TIMEOUT", "PUSH_REFUSED", "PR_CREATE_FAILED", "REVIEW_UNPARSEABLE", "PROOF_INCOMPLETE", "BRANCH_FAILED", "FENCE_TAMPER", "AGENT_FAILED", "VALIDATION_FAILED"],
      2: ["NOT_BUILT", "NOT_MAC", "UNSUPPORTED_PLATFORM", "NO_GIT", "DIRTY_TREE", "BRIDGE_PROTOCOL", "LOCKED", "RUNTIME_MISMATCH", "INFINITE_WORKSPACE"],
      3: ["NEEDS_ANSWERS", "MERGE_PARKED", "AGENT_OUT_OF_USAGE", "DEPLOY_TIMEOUT", "PREVIEW_NOT_FOUND", "SITE_LOCKED", "INFINITE_UNAVAILABLE", "DEV_SERVER_RUNNING", "DEPLOY_FAILED", "HOST_UNCONFIRMED"],
      4: ["NO_APP", "SIGNED_OUT", "SUBSCRIPTION_REQUIRED", "LINK_DECLINED", "LINK_EXPIRED"]
    }
    for (const [exit, codes] of Object.entries(expected)) {
      for (const short of codes) expect(exitCodeFor(`INF_WIZ_${short}` as WizardCode), short).toBe(Number(exit))
    }
    expect(Object.values(expected).flat()).toHaveLength(WIZARD_CODES.length)
    for (const code of WIZARD_CODES) expect(code.startsWith("INF_WIZ_")).toBe(true)
  })

  it("negative: a code missing from the table throws", () => {
    expect(() => exitCodeFor("INF_WIZ_NOT_A_CODE" as WizardCode)).toThrow(/Unknown WizardCode/)
  })

  it("the run's exit is the highest-priority code (4 > 3 > 1 > 2 > 0)", () => {
    expect(runExitCode([])).toBe(0)
    expect(runExitCode(["INF_WIZ_DIRTY_TREE", "INF_WIZ_FENCE_TAMPER"])).toBe(1)
    expect(runExitCode(["INF_WIZ_FENCE_TAMPER", "INF_WIZ_MERGE_PARKED"])).toBe(3)
    expect(runExitCode(["INF_WIZ_MERGE_PARKED", "INF_WIZ_SIGNED_OUT", "INF_WIZ_NOT_BUILT"])).toBe(4)
  })

  it("doctor: 0 clean, 1 any problem, 3 undetermined without a problem; info changes nothing", () => {
    expect(doctorExitCode(["pass", "info"])).toBe(DOCTOR_EXIT_CODES.clean)
    expect(doctorExitCode(["pass", "undetermined"])).toBe(3)
    expect(doctorExitCode(["undetermined", "problem"])).toBe(1)
  })
})

describe("YES_POLICY (§3d.4)", () => {
  it("has a row for every plan line kind", () => {
    expect(Object.keys(YES_POLICY).sort()).toEqual([...PLAN_LINE_KINDS].sort())
    expect(Object.keys(YES_ASK_POLICY).sort()).toEqual([...ASK_KINDS].sort())
  })

  it("--yes approves the additive and managed kinds", () => {
    for (const kind of ["install_provider", "server_lane", "preview_guard_managed"] as const) {
      expect(yesApproves({ kind }), kind).toBe(true)
    }
    expect(yesApproves({ kind: "improve_additive", ownership: "managed" })).toBe(true)
  })

  it("negatives: --yes never approves questions, packages, account writes or metered costs", () => {
    for (const kind of [
      "npm_install",
      "account_settings",
      "agent_budget",
      "consent_mode",
      "conversion_names",
      "privacy_text",
      "meta_relay",
      "user_action"
    ] as const) {
      expect(yesApproves({ kind }), kind).toBe(false)
    }
    expect(yesApproves({ kind: "improve_additive", ownership: "adopted" })).toBe(true)
    // Repository permission applies to existing providers too; explicit declines still win.
    expect(yesApproves({ kind: "improve_additive" })).toBe(true)
    expect(NESTED_USER_ONLY_LINE_KINDS).toContain("consent_mode")
    expect(NESTED_USER_ONLY_LINE_KINDS).toContain("meta_relay")
    expect(NESTED_USER_ONLY_LINE_KINDS).not.toContain("install_provider")
    for (const kind of ["confirm", "single", "teammate-comments", "agent-questions"] as const) expect(YES_ASK_POLICY[kind]).toBe("never")
  })
})

describe("steps, jobs and events tables", () => {
  it("the step meta is keyed and numbered exactly as WIZARD_STEP_IDS", () => {
    expect(Object.keys(WIZARD_STEP_META)).toEqual([...WIZARD_STEP_IDS])
    WIZARD_STEP_IDS.forEach((id, index) => {
      expect(WIZARD_STEP_META[id].id).toBe(id)
      expect(WIZARD_STEP_META[id].n).toBe(index)
      for (const capability of WIZARD_STEP_META[id].requiredCapabilities) expect(TAG_CAPABILITIES).toContain(capability)
    })
  })

  it("jobs 1–16 are keyed and numbered exactly as JOB_IDS", () => {
    expect(Object.keys(JOB_TABLE)).toEqual([...JOB_IDS])
    JOB_IDS.forEach((id, index) => {
      expect(JOB_TABLE[id].jobId).toBe(id)
      expect(JOB_TABLE[id].n).toBe(index + 1)
    })
  })

  it("every event type has a shape; a sample line validates and an extra key fails", () => {
    expect(Object.keys(WIZARD_EVENT_SHAPES).sort()).toEqual([...WIZARD_EVENT_TYPES].sort())
    const line = { v: 1, t: "step.done", at: "2026-10-02T09:00:00.000Z", step: "plan", outcome: "parked", code: "INF_WIZ_NEEDS_ANSWERS" }
    expect(shapeErrors(line, wizardEventLineShape("step.done"))).toEqual([])
    expect(shapeErrors({ ...line, verified: true }, wizardEventLineShape("step.done")).join()).toContain('unknown key "verified"')
  })

  it("names: the wizard branch and the wizard manifest id never look like a cloud id", () => {
    expect(wizardBranchName(new Date("2026-10-02T12:00:00Z"), "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80")).toBe("infinite/tag/2026-10-02-7f3c2a")
    const workspaceId = wizardManifestWorkspaceId(`sha256:${"ab".repeat(32)}`)
    expect(workspaceId).toBe("wizard:abababababababab")
    expect(workspaceId).not.toMatch(/ws_[0-9a-f]{16}/)
    expect(() => wizardManifestWorkspaceId("not-a-fingerprint")).toThrow()
  })
})

describe("agents (§3f.3 + the NORMATIVE §3f.7 amendment)", () => {
  const base = {
    homeRealpath: "/Users/acme",
    sensitiveRealpaths: ["/Users/acme/.growth-os", "/Users/acme/.codex", "/opt/growth-os-home", "/Users/acme/Library/Caches/infinite-tag"],
    codexBinDir: "/Users/acme/.local/bin",
    codexInstallRoot: "/Users/acme/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin"
  }

  it("CODEX_READ_CONFINEMENT is set (L7 passed): Codex is ON in both roles, with the two profiles", () => {
    expect(CODEX_READ_CONFINEMENT).not.toBeNull()
    expect(CODEX_READ_CONFINEMENT.profiles).toEqual({ worker: "infinite_tag", reviewer: "infinite_tag_ro" })
    expect(CODEX_READ_CONFINEMENT.projectRootsAccess).toEqual({ worker: "write", reviewer: "read" })
  })

  it("codexPermissionArgs builds the exact L7 worker and reviewer profiles from realpaths", () => {
    expect(codexPermissionArgs({ role: "worker", ...base })).toEqual([
      "-c",
      'default_permissions="infinite_tag"',
      "-c",
      'permissions.infinite_tag.filesystem={":root"="read", "/Users/acme"="none", "/opt/growth-os-home"="none", "/Users/acme/.local/bin"="read", "/Users/acme/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin"="read", ":project_roots"="write"}'
    ])
    const reviewer = codexPermissionArgs({ role: "reviewer", ...base })
    expect(reviewer[1]).toBe('default_permissions="infinite_tag_ro"')
    expect(reviewer[3]).toMatch(/^permissions\.infinite_tag_ro\.filesystem=\{/)
    expect(reviewer[3]).toContain('":project_roots"="read"}')
  })

  it("its output never selects a legacy sandbox (-s / --sandbox / sandbox_mode)", () => {
    for (const role of ["worker", "reviewer"] as const) {
      const args = codexPermissionArgs({ role, ...base })
      expect(args).not.toContain("-s")
      expect(args).not.toContain("--sandbox")
      expect(args.join(" ")).not.toContain("sandbox_mode")
    }
  })

  it("negatives: relative or unnormalised paths, HOME = /, and a re-allow that would re-open HOME or a sensitive path all throw", () => {
    expect(() => codexPermissionArgs({ role: "worker", ...base, homeRealpath: "Users/acme" })).toThrow(/absolute/)
    expect(() => codexPermissionArgs({ role: "worker", ...base, homeRealpath: "/Users/acme/" })).toThrow(/normalised/)
    expect(() => codexPermissionArgs({ role: "worker", ...base, codexBinDir: "/Users/acme/../acme/.local/bin" })).toThrow(/normalised/)
    expect(() => codexPermissionArgs({ role: "worker", ...base, homeRealpath: "/" })).toThrow(/whole disk/)
    // A codex binary straight in $HOME would re-allow READ on all of it.
    expect(() => codexPermissionArgs({ role: "worker", ...base, codexBinDir: "/Users/acme" })).toThrow(/re-open \/Users\/acme/)
    expect(() => codexPermissionArgs({ role: "worker", ...base, codexInstallRoot: "/opt" })).toThrow(/re-open \/opt\/growth-os-home/)
    expect(() => codexPermissionArgs({ role: "worker", ...base, codexInstallRoot: "/" })).toThrow(/re-open/)
    expect(() => codexPermissionArgs({ role: "worker", ...base, sensitiveRealpaths: ["/opt/a\nb"] })).toThrow(/control/)
  })

  it("B20: repo secrets are their own \"none\" entries after :project_roots; the worker reads .git only; the reviewer gets no .git entry", () => {
    const repoDenies = { none: ["/work/acme/.env", "/work/acme/apps/web/.env.local", "/work/acme/.npmrc"], readOnly: ["/work/acme/.git"] }
    const worker = codexPermissionArgs({ role: "worker", ...base, repoDenies })[3]!
    const roots = worker.indexOf('":project_roots"="write"')
    expect(roots).toBeGreaterThan(0)
    for (const path of repoDenies.none) expect(worker.indexOf(`"${path}"="none"`)).toBeGreaterThan(roots)
    expect(worker.indexOf('"/work/acme/.git"="read"')).toBeGreaterThan(roots)
    const reviewer = codexPermissionArgs({ role: "reviewer", ...base, repoDenies })[3]!
    expect(reviewer).toContain('"/work/acme/.env"="none"')
    expect(reviewer).not.toContain("/work/acme/.git")
    // negative: a relative secret path throws (a profile key must be a realpath)
    expect(() => codexPermissionArgs({ role: "worker", ...base, repoDenies: { none: [".env"] } })).toThrow(/absolute/)
  })

  it("a quote or backslash in a path is escaped as a TOML basic string (it cannot break out of the key)", () => {
    const args = codexPermissionArgs({ role: "worker", ...base, sensitiveRealpaths: ['/opt/we"ird\\dir'] })
    expect(args[3]).toContain('"/opt/we\\"ird\\\\dir"="none"')
  })

  it("the disable list covers every §3f.3 + §3f.7 feature for every role", () => {
    for (const feature of ["shell_snapshot", "skill_search", "view_image", "goals", "multi_agent", "apps", "plugins", "browser_use", "computer_use", "image_generation"]) {
      expect(CODEX_DISABLED_FEATURES as readonly string[], feature).toContain(feature)
    }
    expect(CODEX_REQUIRED_CONFIG as readonly string[]).toContain("skills.include_instructions=false")
    expect(CLAUDE_REQUIRED_FLAGS).toEqual(["--restricted"])
  })

  const codexArgv = (role: "worker" | "reviewer", extra: string[] = []) => [
    "exec",
    "--json",
    "-C",
    "/repo",
    ...CODEX_REQUIRED_FLAGS,
    "--ignore-rules",
    ...codexPermissionArgs({ role, ...base }),
    ...CODEX_REQUIRED_CONFIG.flatMap((setting) => ["-c", setting]),
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
    ...extra,
    "-"
  ]
  const claudeArgv = ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--tools", "Read,Edit,Write,Glob,Grep"]

  it("agentArgvViolations passes a compliant argv for every agent and role", () => {
    expect(agentArgvViolations("codex", codexArgv("worker"))).toEqual([])
    expect(agentArgvViolations("codex", codexArgv("reviewer"))).toEqual([])
    expect(agentArgvViolations("claude_code", claudeArgv)).toEqual([])
    expect(AGENT_KINDS).toEqual(["claude_code", "codex"])
  })

  it("negatives: -s, --sandbox, sandbox_mode, a missing disable, a missing profile, Claude without --restricted, --dangerously*", () => {
    expect(agentArgvViolations("codex", codexArgv("worker", ["-s", "workspace-write"])).join()).toContain("forbidden codex flag -s")
    expect(agentArgvViolations("codex", codexArgv("worker", ["--sandbox=read-only"])).join()).toContain("forbidden codex flag --sandbox=read-only")
    expect(agentArgvViolations("codex", codexArgv("worker", ["-c", 'sandbox_mode="workspace-write"'])).join()).toContain("forbidden codex config sandbox_mode")
    const noViewImage = codexArgv("worker").filter((arg) => arg !== "features.view_image=false")
    expect(agentArgvViolations("codex", noViewImage).join()).toContain("missing features.view_image=false")
    const noProfile = codexArgv("worker").filter((arg) => !arg.startsWith("default_permissions="))
    expect(agentArgvViolations("codex", noProfile).join()).toContain("missing default_permissions profile")
    expect(agentArgvViolations("claude_code", claudeArgv.filter((arg) => arg !== "--restricted")).join()).toContain("missing --restricted")
    expect(agentArgvViolations("claude_code", [...claudeArgv, "--setting-sources", "user"]).join()).toContain("--setting-sources")
    expect(agentArgvViolations("claude_code", [...claudeArgv, "--dangerously-skip-permissions"]).join()).toContain("forbidden flag")
  })
})

describe("allowlist, nested mode, run state and git (§3e, §3d.7, §3g)", () => {
  it("the global deny covers every lockfile and the tool dirs at ANY depth (monorepo app roots)", () => {
    const globs = GLOBAL_DENY_GLOBS as readonly string[]
    for (const glob of ["npm-shrinkwrap.json", "**/npm-shrinkwrap.json", "**/.infinite/**", "**/.claude/**", "**/.codex/**", "**/.git/**"]) {
      expect(globs, glob).toContain(glob)
    }
    const matchesGlob = (nodePath as { matchesGlob?: (path: string, glob: string) => boolean }).matchesGlob
    if (matchesGlob) {
      const denied = (path: string) => globs.some((glob) => matchesGlob(path, glob))
      for (const path of ["apps/web/.infinite/install.json", "npm-shrinkwrap.json", "apps/web/npm-shrinkwrap.json", "apps/web/.claude/settings.json", ".git/config"]) {
        expect(denied(path), path).toBe(true)
      }
      expect(denied("apps/web/app/layout.tsx")).toBe(false)
    }
  })

  it("nested mode: repository improvements are shown; human decisions stay user-only", () => {
    expect(isNestedUserOnly({ kind: "improve_additive", ownership: "managed" })).toBe(false)
    expect(isNestedUserOnly({ kind: "improve_additive", ownership: "adopted" })).toBe(false)
    expect(isNestedUserOnly({ kind: "improve_additive" })).toBe(false)
    expect(isNestedUserOnly({ kind: "consent_mode" })).toBe(true)
    expect(isNestedUserOnly({ kind: "install_provider" })).toBe(false)
    for (const kind of NESTED_USER_ONLY_LINE_KINDS) if (kind !== "improve_additive") expect(isNestedUserOnly({ kind }), kind).toBe(true)
  })

  it("run state: a DECLINED line's job is dropped; only an UNANSWERED line's job is blocked:needs_you (§3e.7)", () => {
    const state = readJson<WizardRunState>("run-state.example.json")
    expect(declinedLineJobs(state)).toEqual([])
    const declined = JSON.parse(JSON.stringify(state)) as WizardRunState
    declined.plan!.lines.find((line) => line.id === "preview_guard_adopted:meta")!.approved = false
    expect(declinedLineJobs(declined).join()).toContain("preview_guard:meta")
  })

  it("GitOps declares pull --ff-only for the update-branch step (§3g.4 step 5)", () => {
    const method: keyof GitOps = "pullFfOnly"
    expect(method).toBe("pullFfOnly")
  })
})

/** Jobs that keep living although the plan line they need was declined (they must be dropped, not parked). */
function declinedLineJobs(state: WizardRunState): string[] {
  const out: string[] = []
  const lines = new Map((state.plan?.lines ?? []).map((line) => [line.id, line.approved]))
  for (const item of state.jobs) {
    const target = item.id.includes(":") ? item.id.slice(item.id.indexOf(":") + 1) : null
    for (const kind of JOB_TABLE[item.jobId as keyof typeof JOB_TABLE].requiresApprovedLine as readonly string[]) {
      const approved = lines.get(target ? `${kind}:${target}` : kind)
      if (approved === false) out.push(`${item.id} needs declined ${kind}`)
      if (item.state === "blocked" && item.blockedReason === "needs_you" && approved === true) out.push(`${item.id} parked although ${kind} is approved`)
    }
  }
  return out
}

describe("receipt marker kinds (the cloud's analytics_wizard_receipts_marker_kind check)", () => {
  it("live run 5: a GA4 row decided by GA4's realtime report has its own kind; the list matches 1bu-1's migration 20261026100000", () => {
    expect([...RECEIPT_MARKER_KINDS]).toEqual(["event_id", "distinct_id", "probe_path", "seen_leaving", "ga4_realtime", "meta_event_id", "none"])
  })
})
