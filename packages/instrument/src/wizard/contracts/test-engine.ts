// §3h.1–§3h.6 and the §3h.8 vocabulary of the wizard build plan as code: the desktop test engine's
// modes, the request the tag sends (`POST /v1/test/runs`), and the FACTS it returns.
//
// NORMATIVE. The desktop returns facts only (no `state`, no `verdict`); lane O6's grader is the ONE
// place they are graded. No URL query string or body ever comes back, only extracted ids, classes and
// counts; `pii` carries counts, never a value; no field ends in `token`.
import { arrayOf, shapeOf } from "./shape.js"

/** `dry_live` and `rehearsal` send nothing; `real_visit` is ONE real load after a granted proof claim. */
export const TEST_MODES = ["dry_live", "rehearsal", "real_visit"] as const
export type TestMode = (typeof TEST_MODES)[number]

/** The tools the test engine extracts facts for and the grader grades. */
export const TEST_TOOLS = ["infinite", "ga4", "posthog", "meta"] as const
export type TestTool = (typeof TEST_TOOLS)[number]

/** The fake fbclid used ONLY on no-send loads (decision 12): `INFINITE_TEST_NOT_REAL_<runId first 6 hex>`. */
export const FAKE_CLICK_ID_PREFIX = "INFINITE_TEST_NOT_REAL_" as const
export function fakeClickIdFor(runId: string): string {
  return `${FAKE_CLICK_ID_PREFIX}${runId.replace(/-/g, "").slice(0, 6)}`
}

/** §3h.3: appended to the default Electron UA. The server lane flags `monitor`; avoids posthog-js's `bot/` block. */
export const TEST_UA_SUFFIX = " InfiniteVerifyCheck/1 (+https://infinite.fast; analytics monitor)" as const

/** §3h.6: the server-lane probe path, `/__infinite_probe/<runId first 12 hex>`. */
export function serverLaneProbePathFor(runId: string): string {
  return `/__infinite_probe/${runId.replace(/-/g, "").slice(0, 12)}`
}

export const TEST_LIMITS = {
  maxTargets: 5,
  deadlineMs: { dry_live: 120_000, rehearsal: 180_000, real_visit: 90_000 }
} as const

/** The consent seed (used only when consent_mode = required; seeds Infinite's own keys only). */
export interface ConsentSeed {
  kind: "infinite_runtime_grant"
  /** The emitted config's `consent.storageKey` (the keys verb's `infinite.consentStorageKey`). */
  storageKey: string
}

export interface TestTarget {
  url: string
  label: string
}

/** Expected ids come ONLY from the keys verb (the connections). A tool with no connection has no entry. */
export interface TestExpect {
  /** Every stream id of the connected GA4 property (a live id matching any of them is right). */
  ga4?: string[]
  posthog?: { projectKey: string; apiHost: string }
  meta?: string[]
  infinite?: { siteSourceKey: string; collectPath: string }
}

/** §3h.2 `POST /v1/test/runs`. */
export interface TestRunRequest {
  protocolVersion: 1
  requestId: string
  mode: TestMode
  runId: string
  productionHost: string
  targets: TestTarget[]
  /** `rehearsal` mode only. */
  rehearsal?: { previewOrigin: string; headSha: string }
  expect: TestExpect
  /** No-send loads only: never against production in `dry_live`, never in `real_visit`. */
  fakeClickId?: boolean
  consentSeed?: ConsentSeed | null
  clicks?: Array<{ selector: string; label: string }>
  spaNavigation?: { path: string }
  /** `real_visit` only. */
  serverLaneProbe?: { path: string }
  deadlineMs: number
}

/**
 * §3h.1, which options each mode accepts. A `dry_live` may carry `fakeClickId` / `clicks` ONLY when no
 * target is the production host or a sibling (i.e. the preview's own URL); against production → 400.
 */
export const TEST_MODE_RULES = {
  dry_live: {
    allowed: ["spaNavigation", "consentSeed", "fakeClickId", "clicks"],
    onlyOffProduction: ["fakeClickId", "clicks"],
    exactlyOneTarget: false
  },
  rehearsal: {
    allowed: ["rehearsal", "fakeClickId", "clicks", "spaNavigation", "consentSeed"],
    onlyOffProduction: [],
    exactlyOneTarget: false
  },
  real_visit: { allowed: ["consentSeed", "serverLaneProbe"], onlyOffProduction: [], exactlyOneTarget: true }
} as const satisfies Record<TestMode, { allowed: readonly string[]; onlyOffProduction: readonly string[]; exactlyOneTarget: boolean }>

const MODE_OPTIONAL_KEYS = ["rehearsal", "fakeClickId", "consentSeed", "clicks", "spaNavigation", "serverLaneProbe"] as const

/**
 * The §3h.1 mode rules as a pure check (the desktop answers 400 on any of these). `isProductionOrSibling`
 * decides whether a target host is the production host or a registrable-domain sibling.
 */
export function testRequestModeErrors(request: TestRunRequest, isProductionOrSibling: (host: string) => boolean): string[] {
  const rules = TEST_MODE_RULES[request.mode]
  const errors: string[] = []
  const allowed: readonly string[] = rules.allowed
  for (const key of MODE_OPTIONAL_KEYS) {
    const value = request[key]
    const present = value !== undefined && value !== null && value !== false
    if (present && !allowed.includes(key)) errors.push(`${key} is not allowed in ${request.mode}`)
  }
  if (request.targets.length === 0 || request.targets.length > TEST_LIMITS.maxTargets) {
    errors.push(`targets must hold 1–${TEST_LIMITS.maxTargets} entries`)
  }
  if (rules.exactlyOneTarget && request.targets.length !== 1) errors.push(`${request.mode} needs exactly one target`)
  if (request.mode === "rehearsal" && !request.rehearsal) errors.push("rehearsal needs rehearsal.previewOrigin and headSha")
  const offProductionOnly: readonly string[] = rules.onlyOffProduction
  if (offProductionOnly.length > 0) {
    const touchesProduction = request.targets.some((target) => isProductionOrSibling(new URL(target.url).hostname))
    for (const key of offProductionOnly) {
      const value = request[key as (typeof MODE_OPTIONAL_KEYS)[number]]
      const present = value !== undefined && value !== null && value !== false
      if (present && touchesProduction) errors.push(`${key} is not allowed against the production host`)
    }
  }
  return errors
}

// ---- §3h.5 TestResult (facts only) ----

export type CmpDetected = "onetrust" | "cookiebot" | "usercentrics" | "other" | null

export interface TestEnvironment {
  ua: string
  automationDetected: boolean
  visibilityState: string
  blockedBySiteBotRules: boolean
  previewProtected: boolean
  consentSeeded: boolean
  cmpDetected: CmpDetected
}

export interface TestLoad {
  label: string
  url: string
  finalUrl: string
  status: number
  rendered: boolean
  managedMarkerSeen: boolean
  redirects: Array<{ from: string; to: string; status: number }>
}

export interface OtherBeacon {
  host: string
  pathClass: string
  method: string
  resourceType: string
  cancelled: boolean
}

/** `"cancelled"` in dry modes; the HTTP status in `real_visit`. */
export type BeaconStatus = "cancelled" | number

export interface Ga4BeaconFact {
  tid: string
  en: string
  dlHost: string
  transport: "get" | "post" | "beacon"
  status: BeaconStatus
  loadLabel: string
  afterNav: boolean
}

export interface PosthogEventFact {
  projectKey: string
  event: string
  distinctId: string
  host: string
  endpointHost: string
  sameOrigin: boolean
  libCustomApiHost: boolean
  status: BeaconStatus
}

export interface InfiniteEventFact {
  siteSourceKey: string
  eventName: string
  eventId: string
  nav: boolean
  status: BeaconStatus
}

export interface MetaTrFact {
  pixelId: string
  ev: string
  eid: string | null
  method: string
  status: BeaconStatus
}

export type MetaConsoleKind = "traffic_permissions_blocked" | "pixel_not_found" | "invalid_pixel_id" | "other"

export interface ClickFact {
  label: string
  selector: string
  found: boolean
  events: { ga4: string[]; posthog: string[]; meta: string[]; infinite: string[] }
  nonGetCancelled: number
  navigatedAfterMs: number | null
  navigationCancelled: boolean
}

export interface PiiFact {
  lane: TestTool | "other"
  kind: "email" | "phone" | "name_param"
  count: number
}

/** §3h.5. Facts only: no `state` or `verdict`. */
export interface TestResult {
  mode: TestMode
  runId: string
  startedAt: string
  finishedAt: string
  environment: TestEnvironment
  loads: TestLoad[]
  requests: { total: number; cancelled: number; otherBeacons: OtherBeacon[] }
  ga4: { events: Ga4BeaconFact[] }
  posthog: { events: PosthogEventFact[]; bootRequests: Array<{ path: string; status: BeaconStatus }> }
  infinite: { events: InfiniteEventFact[] }
  meta: {
    configRequests: string[]
    tr: MetaTrFact[]
    console: MetaConsoleKind[]
    /** The value is returned only when it carries the fake-click-id marker. */
    fbc: { present: boolean; value: string | null; domain: string | null }
    fbp: { present: boolean }
  }
  csp: { violations: Array<{ directive: string; blockedHost: string }> }
  clicks: ClickFact[]
  pii: PiiFact[]
  /** `real_visit` only. */
  serverLaneProbe: { path: string; status: number; sentAt: string } | null
  markers: { infiniteEventIds: string[]; posthogDistinctId: string | null; metaEventIds: string[] }
}

/**
 * Why the grader may return `undetermined` for a tool (§3h.8). Never a problem: no agent job is
 * seeded against consent wiring. `test_error` = a crash or deadline (never pass).
 */
export const TEST_UNDETERMINED_REASONS = [
  "automation_detected",
  "blocked_by_site_bot_rules",
  "preview_protected",
  "held_by_consent",
  "env_dependent",
  "not_connected",
  "test_error"
] as const
export type TestUndeterminedReason = (typeof TEST_UNDETERMINED_REASONS)[number]

/** One graded expectation in `test-run.fixtures.json` (§3h.8; lane O6's grader must agree). */
export interface TestRunFixtureExpectation {
  state: "pass" | "problem" | "undetermined" | "info"
  /** For `undetermined`, the TEST_UNDETERMINED_REASONS code; for `problem`, a short code (e.g. `no_pii`). */
  because?: string
}

/** One case in `contracts/tag-wizard-v1/test-run.fixtures.json`. */
export interface TestRunFixtureCase {
  id: string
  note: string
  request: TestRunRequest
  result: TestResult
  context: {
    consentMode: "not_required" | "required"
    /** Tools installed on the site (an installed tool with no beacon is a problem). */
    installedTools: TestTool[]
    envSourcedIds: Array<{ tool: TestTool; envName: string; file: string; line: number }>
  }
  expected: Partial<Record<TestTool, TestRunFixtureExpectation>>
}

// ---- shapes ----

export const TEST_EXPECT_SHAPE = shapeOf<TestExpect>()("TestExpect", [], ["ga4", "posthog", "meta", "infinite"], {
  posthog: shapeOf<NonNullable<TestExpect["posthog"]>>()("TestExpect.posthog", ["projectKey", "apiHost"], []),
  infinite: shapeOf<NonNullable<TestExpect["infinite"]>>()("TestExpect.infinite", ["siteSourceKey", "collectPath"], [])
})

export const TEST_RUN_REQUEST_SHAPE = shapeOf<TestRunRequest>()(
  "TestRunRequest",
  ["protocolVersion", "requestId", "mode", "runId", "productionHost", "targets", "expect", "deadlineMs"],
  ["rehearsal", "fakeClickId", "consentSeed", "clicks", "spaNavigation", "serverLaneProbe"],
  {
    targets: arrayOf(shapeOf<TestTarget>()("TestTarget", ["url", "label"], [])),
    rehearsal: shapeOf<NonNullable<TestRunRequest["rehearsal"]>>()("TestRunRequest.rehearsal", ["previewOrigin", "headSha"], []),
    expect: TEST_EXPECT_SHAPE,
    consentSeed: shapeOf<ConsentSeed>()("ConsentSeed", ["kind", "storageKey"], []),
    clicks: arrayOf(shapeOf<{ selector: string; label: string }>()("TestClick", ["selector", "label"], [])),
    spaNavigation: shapeOf<{ path: string }>()("SpaNavigation", ["path"], []),
    serverLaneProbe: shapeOf<{ path: string }>()("ServerLaneProbeRequest", ["path"], [])
  }
)

export const TEST_RESULT_SHAPE = shapeOf<TestResult>()(
  "TestResult",
  [
    "mode",
    "runId",
    "startedAt",
    "finishedAt",
    "environment",
    "loads",
    "requests",
    "ga4",
    "posthog",
    "infinite",
    "meta",
    "csp",
    "clicks",
    "pii",
    "serverLaneProbe",
    "markers"
  ],
  [],
  {
    environment: shapeOf<TestEnvironment>()(
      "TestEnvironment",
      ["ua", "automationDetected", "visibilityState", "blockedBySiteBotRules", "previewProtected", "consentSeeded", "cmpDetected"],
      []
    ),
    loads: arrayOf(
      shapeOf<TestLoad>()("TestLoad", ["label", "url", "finalUrl", "status", "rendered", "managedMarkerSeen", "redirects"], [], {
        redirects: arrayOf(shapeOf<TestLoad["redirects"][number]>()("Redirect", ["from", "to", "status"], []))
      })
    ),
    requests: shapeOf<TestResult["requests"]>()("TestRequests", ["total", "cancelled", "otherBeacons"], [], {
      otherBeacons: arrayOf(shapeOf<OtherBeacon>()("OtherBeacon", ["host", "pathClass", "method", "resourceType", "cancelled"], []))
    }),
    ga4: shapeOf<TestResult["ga4"]>()("Ga4Facts", ["events"], [], {
      events: arrayOf(shapeOf<Ga4BeaconFact>()("Ga4BeaconFact", ["tid", "en", "dlHost", "transport", "status", "loadLabel", "afterNav"], []))
    }),
    posthog: shapeOf<TestResult["posthog"]>()("PosthogFacts", ["events", "bootRequests"], [], {
      events: arrayOf(
        shapeOf<PosthogEventFact>()(
          "PosthogEventFact",
          ["projectKey", "event", "distinctId", "host", "endpointHost", "sameOrigin", "libCustomApiHost", "status"],
          []
        )
      ),
      bootRequests: arrayOf(shapeOf<{ path: string; status: BeaconStatus }>()("PosthogBootRequest", ["path", "status"], []))
    }),
    infinite: shapeOf<TestResult["infinite"]>()("InfiniteFacts", ["events"], [], {
      events: arrayOf(shapeOf<InfiniteEventFact>()("InfiniteEventFact", ["siteSourceKey", "eventName", "eventId", "nav", "status"], []))
    }),
    meta: shapeOf<TestResult["meta"]>()("MetaFacts", ["configRequests", "tr", "console", "fbc", "fbp"], [], {
      tr: arrayOf(shapeOf<MetaTrFact>()("MetaTrFact", ["pixelId", "ev", "eid", "method", "status"], [])),
      fbc: shapeOf<TestResult["meta"]["fbc"]>()("MetaFbc", ["present", "value", "domain"], []),
      fbp: shapeOf<TestResult["meta"]["fbp"]>()("MetaFbp", ["present"], [])
    }),
    csp: shapeOf<TestResult["csp"]>()("CspFacts", ["violations"], [], {
      violations: arrayOf(shapeOf<{ directive: string; blockedHost: string }>()("CspViolation", ["directive", "blockedHost"], []))
    }),
    clicks: arrayOf(
      shapeOf<ClickFact>()(
        "ClickFact",
        ["label", "selector", "found", "events", "nonGetCancelled", "navigatedAfterMs", "navigationCancelled"],
        [],
        { events: shapeOf<ClickFact["events"]>()("ClickEvents", ["ga4", "posthog", "meta", "infinite"], []) }
      )
    ),
    pii: arrayOf(shapeOf<PiiFact>()("PiiFact", ["lane", "kind", "count"], [])),
    serverLaneProbe: shapeOf<NonNullable<TestResult["serverLaneProbe"]>>()("ServerLaneProbeFact", ["path", "status", "sentAt"], []),
    markers: shapeOf<TestResult["markers"]>()("TestMarkers", ["infiniteEventIds", "posthogDistinctId", "metaEventIds"], [])
  }
)

export const TEST_RUN_FIXTURE_CASE_SHAPE = shapeOf<TestRunFixtureCase>()(
  "TestRunFixtureCase",
  ["id", "note", "request", "result", "context", "expected"],
  [],
  {
    request: TEST_RUN_REQUEST_SHAPE,
    result: TEST_RESULT_SHAPE,
    context: shapeOf<TestRunFixtureCase["context"]>()("TestRunFixtureContext", ["consentMode", "installedTools", "envSourcedIds"], [], {
      envSourcedIds: arrayOf(
        shapeOf<TestRunFixtureCase["context"]["envSourcedIds"][number]>()("EnvSourcedId", ["tool", "envName", "file", "line"], [])
      )
    }),
    expected: shapeOf<TestRunFixtureCase["expected"]>()("TestRunFixtureExpected", [], ["infinite", "ga4", "posthog", "meta"], {
      infinite: shapeOf<TestRunFixtureExpectation>()("Expectation", ["state"], ["because"]),
      ga4: shapeOf<TestRunFixtureExpectation>()("Expectation", ["state"], ["because"]),
      posthog: shapeOf<TestRunFixtureExpectation>()("Expectation", ["state"], ["because"]),
      meta: shapeOf<TestRunFixtureExpectation>()("Expectation", ["state"], ["because"])
    })
  }
)
