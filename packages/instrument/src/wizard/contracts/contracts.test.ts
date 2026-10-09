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
  BRIDGE_DESCRIPTOR_SHAPE,
  BRIDGE_ERROR_CODES,
  BRIDGE_ERROR_RESPONSE_SHAPE,
  BRIDGE_ERROR_STATES,
  BRIDGE_ERROR_STATUS,
  BRIDGE_TOKEN_PATTERN,
  BRIDGE_VERB_IDS,
  BRIDGE_VERBS,
  CODEX_DISABLED_FEATURES,
  CODEX_REQUIRED_CONFIG,
  CODEX_REQUIRED_FLAGS,
  FAKE_BRIDGE_TOKEN,
  FINISH_LINE_SOURCES,
  GLOBAL_DENY_GLOBS,
  HOST_DENY_V1,
  HOST_DENY_V1_SHA256,
  NESTED_USER_ONLY_LINE_KINDS,
  PROVENANCE_SOURCES,
  STATE_CHANGING_VERBS,
  TAG_CAPABILITIES,
  WIZARD_CODE_EXIT,
  WIZARD_CODES,
  WIZARD_EVENT_SHAPES,
  WIZARD_EVENT_TYPES,
  YES_ASK_POLICY,
  agentArgvViolations,
  allowedFinishLineProvenance,
  bridgePathPattern,
  codexPermissionArgs,
  exitCodeFor,
  fakeClickIdFor,
  hostDenyFileText,
  isSanitizerSafeFieldName,
  matchBridgeVerb,
  runExitCode,
  schemaFileText,
  shapeErrors,
  testRequestModeErrors,
  wizardEventLineShape,
  yesApproves,
  type BridgeVerbFixture,
  type BridgeVerbSpec,
  type Cell,
  type ReceiptsFixtureCase,
  GA4_REALTIME_REASONS,
  ga4RealtimeLane,
  ga4RealtimeWindows,
  type ReportV2,
  type TestRunFixtureCase,
  type WizardCode
} from "./index.js"

import { BARE_PLATFORM_HOSTS, isDenyListedHost, isPreviewShapedHost } from "../site-host.js"

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

  it("negative: an extra key fails, at the top and nested", () => {
    expect(shapeErrors({ ...descriptor, extra: 1 }, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain('unknown key "extra"')
    const nested = { ...descriptor, runtime: { variant: "prod", label: "Infinite", extra: true } }
    expect(shapeErrors(nested, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain('$.runtime: unknown key "extra"')
  })

  it("negative: a missing required key fails", () => {
    const { bootId: _bootId, ...missing } = descriptor
    expect(shapeErrors(missing, BRIDGE_DESCRIPTOR_SHAPE).join()).toContain('missing required key "bootId"')
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

  it("the unknown_field example's request really breaks the strict decoder (and the valid rows do not)", () => {
    const row = fixtures.find((f) => (f.response as { error?: { code: string } }).error?.code === "unknown_field")!
    expect(shapeErrors(row.request, specOf(row.verb!).request!).join()).toContain("unknown key")
  })

  it("no field that crosses the bridge would be dropped by the desktop's sanitizer, or carries a cloud id", () => {
    const keys = fixtures.flatMap((f) => [...allKeys(f.request), ...allKeys(f.response)])
    expect(keys.filter((key) => !isSanitizerSafeFieldName(key))).toEqual([])
    expect(keys).not.toContain("engineProjectId")
    expect(keys).not.toContain("cloudWorkspaceId")
    expect(keys).not.toContain("projectToken")
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

describe("test-run.fixtures.json (§3h; the grader's cases)", () => {
  const cases = readJson<TestRunFixtureCase[]>("test-run.fixtures.json")
  const productionOrSibling = (host: string) => host === "acme-store.com" || host.endsWith(".acme-store.com")

  it("every request obeys the §3h.1 mode rules (a production dry load carries no clicks and no fake click id)", () => {
    for (const testCase of cases) {
      expect(testRequestModeErrors(testCase.request, productionOrSibling), testCase.id).toEqual([])
    }
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
})

describe("receipts.fixtures.json (§3h.7)", () => {
  const cases = readJson<ReceiptsFixtureCase[]>("receipts.fixtures.json")

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

  it("the run's exit is the highest-priority code (4 > 3 > 1 > 2 > 0)", () => {
    expect(runExitCode([])).toBe(0)
    expect(runExitCode(["INF_WIZ_DIRTY_TREE", "INF_WIZ_FENCE_TAMPER"])).toBe(1)
    expect(runExitCode(["INF_WIZ_FENCE_TAMPER", "INF_WIZ_MERGE_PARKED"])).toBe(3)
    expect(runExitCode(["INF_WIZ_MERGE_PARKED", "INF_WIZ_SIGNED_OUT", "INF_WIZ_NOT_BUILT"])).toBe(4)
  })
})

describe("YES_POLICY (§3d.4)", () => {
  it("negatives: --yes leaves other questions, packages, account writes and metered costs explicit", () => {
    for (const kind of [
      "npm_install",
      "account_settings",
      "agent_budget",
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
  it("every event type has a shape; a sample line validates and an extra key fails", () => {
    expect(Object.keys(WIZARD_EVENT_SHAPES).sort()).toEqual([...WIZARD_EVENT_TYPES].sort())
    const line = { v: 1, t: "step.done", at: "2026-10-02T09:00:00.000Z", step: "plan", outcome: "parked", code: "INF_WIZ_NEEDS_ANSWERS" }
    expect(shapeErrors(line, wizardEventLineShape("step.done"))).toEqual([])
    expect(shapeErrors({ ...line, verified: true }, wizardEventLineShape("step.done")).join()).toContain('unknown key "verified"')
  })
})

describe("agents (§3f.3 + the NORMATIVE §3f.7 amendment)", () => {
  const base = {
    homeRealpath: "/Users/acme",
    sensitiveRealpaths: ["/Users/acme/.growth-os", "/Users/acme/.codex", "/opt/growth-os-home", "/Users/acme/Library/Caches/infinite-tag"],
    codexBinDir: "/Users/acme/.local/bin",
    codexInstallRoot: "/Users/acme/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin"
  }

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
})

