// The wizard contracts (§3a–§3i) against their published JSON: every fixture parses, every fixture's
// keys equal its TS type's key list (at every nested level the shapes name), the schema files are
// byte-identical to the TS constants, and the tables obey the plan's rules. Each rule has a negative.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  ASK_KINDS,
  BRIDGE_DESCRIPTOR_SHAPE,
  BRIDGE_ERROR_CODES,
  BRIDGE_ERROR_RESPONSE_SHAPE,
  BRIDGE_ERROR_STATUS,
  BRIDGE_ID_PATTERNS,
  BRIDGE_TOKEN_PATTERN,
  BRIDGE_VERB_FIXTURE_SHAPE,
  BRIDGE_VERB_IDS,
  BRIDGE_VERBS,
  CHECKLIST_ITEM_SHAPE,
  CLAIMS_SCHEMA,
  DOCTOR_EXIT_CODES,
  FAKE_BRIDGE_TOKEN,
  FINISH_LINE_IDS,
  FINISH_LINE_SOURCES,
  HOST_DENY_V1,
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
  TEST_RUN_FIXTURE_CASE_SHAPE,
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
  allowedFinishLineProvenance,
  bridgePathPattern,
  doctorExitCode,
  exitCodeFor,
  fakeClickIdFor,
  isSanitizerSafeFieldName,
  matchBridgeVerb,
  runExitCode,
  schemaFileText,
  serverLaneProbePathFor,
  shapeErrors,
  shapeOf,
  testRequestModeErrors,
  wizardBranchName,
  wizardEventLineShape,
  wizardManifestWorkspaceId,
  yesApproves,
  type BridgeVerbFixture,
  type BridgeVerbSpec,
  type Cell,
  type ReceiptsFixtureCase,
  type ReportV2,
  type TestRunFixtureCase,
  type TestRunRequest,
  type WizardCode
} from "./index.js"

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
      expect(text, name).not.toContain("914812061724377")
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

  it("error rows: one example of EVERY error code, each with its HTTP status and the error envelope", () => {
    const errors = fixtures.filter((f) => !isSuccess(f))
    const codes = errors.map((f) => (f.response as { error: { code: string } }).error.code)
    expect([...codes].sort()).toEqual([...BRIDGE_ERROR_CODES].sort())
    for (const fixture of errors) {
      const code = (fixture.response as { error: { code: keyof typeof BRIDGE_ERROR_STATUS } }).error.code
      expect(shapeErrors(fixture.response, BRIDGE_ERROR_RESPONSE_SHAPE), code).toEqual([])
      expect(fixture.status, code).toBe(BRIDGE_ERROR_STATUS[code])
    }
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

  it("negative: the sanitizer rule flags token / apikey / credential names", () => {
    expect(isSanitizerSafeFieldName("projectKey")).toBe(true)
    for (const name of ["fooToken", "token", "apikey", "ApiKey", "credentialRef", "mcpCredential"]) {
      expect(isSanitizerSafeFieldName(name), name).toBe(false)
    }
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
    const reasons = new Set(cases.flatMap((c) => Object.values(c.expected).map((e) => e?.because)))
    for (const because of [
      "held_by_consent",
      "preview_protected",
      "automation_detected",
      "blocked_by_site_bot_rules",
      "env_dependent",
      "duplicate_page_view",
      "wrong_id",
      "no_pii",
      "traffic_permissions_blocked",
      "previews_send_data",
      "no_beacon"
    ]) {
      expect(reasons.has(because), because).toBe(true)
    }
    // A tid equal to either of two connection streams is a pass.
    const second = cases.find((c) => c.id === "dry_live_ga4_second_stream")!
    expect(second.request.expect.ga4).toContain(second.result.ga4.events[0]!.tid)
    expect(second.expected.ga4?.state).toBe("pass")
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

  it("verified only with a receipt at or after the run's server start; GA4 and the Meta pixel are never verified", () => {
    for (const testCase of cases) {
      for (const [lane, receipt] of Object.entries(testCase.response.lanes)) {
        if (receipt.state === "verified") {
          expect(receipt.receiptAt, `${testCase.id}.${lane}`).not.toBeNull()
          expect(Date.parse(receipt.receiptAt!) >= Date.parse(testCase.runStartedAt), `${testCase.id}.${lane}`).toBe(true)
        }
      }
      expect(testCase.response.lanes.ga4.state).not.toBe("verified")
      expect(testCase.response.lanes.meta_pixel.state).not.toBe("verified")
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
  it("is byte-identical to HOST_DENY_V1, with the plan's lists", () => {
    expect(readText(contractsDir, "host-deny-v1.json")).toBe(schemaFileText(HOST_DENY_V1))
    expect(JSON.parse(readText(contractsDir, "host-deny-v1.json"))).toEqual({
      version: 1,
      deny: {
        exact: ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"],
        suffix: [".localhost", ".local", ".vercel.app", ".netlify.app", ".pages.dev"]
      },
      normalize: "trim,lowercase,strip-one-trailing-dot"
    })
  })
})

describe("codes (§3d.5)", () => {
  it("exitCodeFor covers every WizardCode with the table's exit", () => {
    expect(WIZARD_CODES).toHaveLength(Object.keys(WIZARD_CODE_EXIT).length)
    const expected: Record<number, string[]> = {
      1: ["APPLY_ROLLED_BACK", "AGENT_TOOLLESS", "AGENT_TIMEOUT", "PUSH_REFUSED", "PR_CREATE_FAILED", "REVIEW_UNPARSEABLE", "PROOF_INCOMPLETE", "BRANCH_FAILED", "FENCE_TAMPER"],
      2: ["NOT_BUILT", "NOT_MAC", "UNSUPPORTED_PLATFORM", "NO_GIT", "DIRTY_TREE", "BRIDGE_PROTOCOL", "LOCKED", "RUNTIME_MISMATCH"],
      3: ["NEEDS_ANSWERS", "MERGE_PARKED", "AGENT_OUT_OF_USAGE", "DEPLOY_TIMEOUT", "PREVIEW_NOT_FOUND"],
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
    for (const kind of ["install_provider", "server_lane", "npm_install", "preview_guard_managed", "agent_budget", "meta_goal"] as const) {
      expect(yesApproves({ kind }), kind).toBe(true)
    }
    expect(yesApproves({ kind: "improve_additive", ownership: "managed" })).toBe(true)
  })

  it("negatives: --yes never approves a line that changes an existing tag, sends data, or is the user's decision", () => {
    for (const kind of [
      "consent_mode",
      "conversion_names",
      "privacy_text",
      "remove_duplicate",
      "preview_guard_adopted",
      "autoconfig_off_adopted",
      "sensitive_pages",
      "posthog_defaults_bump_adopted",
      "capture_beside_adopted_pixel",
      "retire_fbc_writer",
      "meta_relay",
      "user_action"
    ] as const) {
      expect(yesApproves({ kind }), kind).toBe(false)
    }
    expect(yesApproves({ kind: "improve_additive", ownership: "adopted" })).toBe(false)
    // Fail-safe: a line that does not say whose provider it improves is treated as adopted.
    expect(yesApproves({ kind: "improve_additive" })).toBe(false)
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
