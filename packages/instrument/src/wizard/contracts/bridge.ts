// §3a of the wizard build plan (the desktop tag bridge, `infinite-desktop-tag`, protocol 1) as code,
// plus the §3b response shapes the bridge forwards from the cloud (keys, hosting, deploy status, runs).
//
// NORMATIVE. Names, shapes, codes and statuses here are the contract between infinite-tag (lane O2's
// client) and the Infinite desktop app (1bu-1 lane D1/D2). The JSON fixtures in
// `contracts/tag-wizard-v1/` are checked against the shapes below by `contracts.test.ts`, and 1bu-1
// vendors those fixtures. The tag never calls the cloud directly; it talks to this bridge only.
//
// Interpretations F0 made where §3a is terse (also in the F0 note):
// - every JSON request body (POST/PATCH) carries the `{protocolVersion, requestId}` envelope, as the
//   link and runs requests in §3a show; the §3a.6 settings requests list only their verb fields;
// - `claimed_by_other` (409) carries the current proof state in `error.state`;
// - `cloud_error` (502) carries the cloud's status in `error.upstreamStatus`.
// Sanitizer-safe names: no field that crosses the bridge ends in `token`, equals `apikey` or contains
// `credential` (the desktop drops such keys). The descriptor's `token` is read from a local file, never
// sent over HTTP.
import type { AgentReviewerKind, AgentWorkerKind } from "./agents.js"
import type { BaselineResponseFields, ReportPhase, ReportV2 } from "./report.js"
import { BASELINE_SHAPE, REPORT_V2_SHAPE } from "./report.js"
import type { ReceiptsRequestFields, ReceiptsResponseFields } from "./receipts.js"
import { RECEIPTS_REQUEST_SHAPE, RECEIPTS_RESPONSE_SHAPE } from "./receipts.js"
import { arrayOf, nullable, oneOf, shapeOf, type ObjectShape } from "./shape.js"
import type { TestResult, TestRunRequest } from "./test-engine.js"
import { TEST_RESULT_SHAPE, TEST_RUN_REQUEST_SHAPE } from "./test-engine.js"

// ---------------------------------------------------------------------------------------------
// §3a.1 Discovery
// ---------------------------------------------------------------------------------------------

export const BRIDGE_SERVICE = "infinite-desktop-tag" as const
export const BRIDGE_PROTOCOL_VERSION = 1 as const
/** `$GROWTH_OS_HOME`, else `~/.growth-os`. Each Dev instance has its own home. */
export const GROWTH_OS_HOME_ENV = "GROWTH_OS_HOME" as const
export const DEFAULT_GROWTH_OS_HOME_DIRNAME = ".growth-os" as const
/** `<home>/desktop-tag/` (0700), holding `bridge.json` and `state.json` (each 0600). */
export const BRIDGE_DIRNAME = "desktop-tag" as const
export const BRIDGE_DESCRIPTOR_FILENAME = "bridge.json" as const
export const BRIDGE_STATE_FILENAME = "state.json" as const
export const BRIDGE_DIR_MODE = 0o700
export const BRIDGE_FILE_MODE = 0o600

/** Every capability a protocol-1 bridge can advertise (§3a.1). Clients ignore capabilities they do not know. */
export const TAG_CAPABILITIES = [
  "tag.status.v1",
  "tag.link.v1",
  "tag.keys.v1",
  "tag.hosting.v1",
  "tag.runs.v1",
  "tag.receipts.v1",
  "tag.report.v2",
  "tag.baseline.v1",
  "tag.site-source.v1",
  "tag.conversions.v1",
  "tag.ga4-key-events.v1",
  "tag.server-lane.v1",
  "tag.meta-relay.v1",
  "tag.uninstall.v1",
  "tag.test.v1"
] as const
export type TagCapability = (typeof TAG_CAPABILITIES)[number]

/** `prod`, `dev`, `devN` (a numbered Dev instance) or `clean`. */
export type RuntimeVariant = "prod" | "dev" | `dev${number}` | "clean"
export const RUNTIME_VARIANT_PATTERN = /^(prod|dev|dev[0-9]+|clean)$/

export interface BridgeRuntime {
  variant: RuntimeVariant
  label: string
}

export interface BridgeProtocolRange {
  min: number
  max: number
}

/** `<home>/desktop-tag/bridge.json`. Owned by the current uid, not a symlink, read with O_NOFOLLOW. */
export interface BridgeDescriptor {
  schemaVersion: 1
  service: typeof BRIDGE_SERVICE
  protocol: BridgeProtocolRange
  /** Unknown capabilities are ignored (new capabilities only; S3 §1.9). */
  capabilities: string[]
  /** Always `http://127.0.0.1:<port>`. */
  url: string
  pid: number
  bootId: string
  desktopVersion: string
  runtime: BridgeRuntime
  /** base64url, 43 chars. Fixtures use FAKE_BRIDGE_TOKEN, never a random-looking value. */
  token: string
  startedAt: string
}

/**
 * The obviously fake bearer used in every example and fixture: 43 characters, the base64url alphabet,
 * so it has a real token's shape, and low-entropy so no secret scanner reads it as a key. (§0 of the
 * plan prints a 48-character literal while saying "43 chars"; F0 keeps the 43 the descriptor needs.)
 */
export const FAKE_BRIDGE_TOKEN = "FAKE-TEST-TOKEN-not-a-secret-00000000000000" as const
/** A real descriptor token: base64url, 43 characters (32 random bytes). */
export const BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type BridgeAppState = "booting" | "signed_out" | "ready"

/** `<home>/desktop-tag/state.json`. */
export interface BridgeStateFile {
  schemaVersion: 1
  state: BridgeAppState
  updatedAt: string
}

// ---------------------------------------------------------------------------------------------
// §3a.2 Transport, envelope, errors
// ---------------------------------------------------------------------------------------------

export const BRIDGE_HEADERS = {
  authorization: "Authorization",
  tagVersion: "X-Infinite-Tag-Version",
  /** Link-scoped verbs only: `lk_…`. */
  linkId: "X-Infinite-Link-Id",
  contentType: "Content-Type",
  cacheControl: "Cache-Control",
  retryAfter: "Retry-After",
  wwwAuthenticate: "WWW-Authenticate"
} as const

export const BRIDGE_LIMITS = {
  /** Request bodies above this → 413 `body_too_large`. */
  maxBodyBytes: 64 * 1024,
  /** The client allows this long per call. */
  clientTimeoutMs: 35_000,
  /** The server holds a long-poll at most this long (`?wait=25`). */
  longPollMaxSeconds: 25,
  /** Link approval, overall. */
  linkApprovalMs: 5 * 60_000,
  maxPendingLinkRequests: 3,
  linkRequestsPerMinute: 10,
  /** Test runs, enforced server-side from `deadlineMs`. */
  testDeadlineMs: { dry_live: 120_000, rehearsal: 180_000, real_visit: 90_000 }
} as const

export const BRIDGE_ID_PATTERNS = {
  linkCode: /^[0-9]{4}$/,
  linkRequestId: /^lr_[A-Za-z0-9_-]{22}$/,
  linkId: /^lk_[A-Za-z0-9_-]{22}$/,
  testRunId: /^tr_[A-Za-z0-9_-]{22}$/,
  repoFingerprint: /^sha256:[0-9a-f]{64}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  sha40: /^[0-9a-f]{40}$/
} as const

/** Every request body and every response carries this. `requestId` is echoed (or a fresh uuid). */
export interface BridgeEnvelope {
  protocolVersion: 1
  requestId: string
}

/** §3a.2: each error code and its HTTP status. */
export const BRIDGE_ERROR_STATUS = {
  invalid_request: 400,
  unknown_field: 400,
  unauthorized: 401,
  subscription_required: 402,
  missing_scope: 403,
  origin_refused: 403,
  route_not_found: 404,
  link_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  link_revoked: 409,
  link_invalid: 409,
  signed_out: 409,
  busy: 409,
  relay_not_available: 409,
  foreign_site_hosts: 409,
  ambiguous_connection: 409,
  claimed_by_other: 409,
  expired: 410,
  body_too_large: 413,
  rate_limited: 429,
  cloud_error: 502,
  cloud_auth_failed: 502,
  capability_unavailable: 503,
  upstream_timeout: 504
} as const

export type BridgeErrorCode = keyof typeof BRIDGE_ERROR_STATUS
export const BRIDGE_ERROR_CODES = Object.keys(BRIDGE_ERROR_STATUS) as BridgeErrorCode[]

/** `link_invalid`'s `state`. */
export type LinkInvalidState = "project_missing" | "not_cloud_linked" | "not_member"

export interface BridgeErrorBody {
  code: BridgeErrorCode
  message: string
  retryable: boolean
  /** `invalid_request`: the offending field. */
  field?: string
  /** `link_invalid`: a LinkInvalidState. `claimed_by_other`: the run's current ProofState. */
  state?: string
  /** `cloud_error`: the cloud's HTTP status. A cloud 401 is never re-emitted as 401. */
  upstreamStatus?: number
}

export interface BridgeErrorResponse extends BridgeEnvelope {
  error: BridgeErrorBody
}

// ---------------------------------------------------------------------------------------------
// §3a.7 Status
// ---------------------------------------------------------------------------------------------

export interface StatusResponse extends BridgeEnvelope {
  service: typeof BRIDGE_SERVICE
  bootId: string
  desktopVersion: string
  runtime: BridgeRuntime
  signedIn: true
  capabilities: string[]
  protocol: BridgeProtocolRange
}

// ---------------------------------------------------------------------------------------------
// §3a.3 Link
// ---------------------------------------------------------------------------------------------

export interface LinkSite {
  /** sha256(normalized remote + "\n" + appRoot), or sha256("path:" + realpath + "\n" + appRoot). */
  repoFingerprint: string
  /** The normalised remote (no userinfo, query, fragment or .git). Never the raw remote. */
  repoLabel: string
  appRoot: string
  folderLabel: string
  productionHostHint: string | null
}

export interface LinkRequestBody extends BridgeEnvelope {
  /** `^[0-9]{4}$`, crypto-random; the card shows the code it was sent. */
  code: string
  site: LinkSite
  client: { tagVersion: string }
}

/** Never carries an engineProjectId or a cloudWorkspaceId. */
export interface Link {
  linkId: string
  workspace: { name: string }
  site: { repoLabel: string; appRoot: string }
  approvedAt: string
  remembered: boolean
}

export interface LinkRequestResponse extends BridgeEnvelope {
  linkRequestId: string
  state: "pending" | "approved"
  expiresAt: string
  link?: Link
}

export type LinkRequestState = "pending" | "approved" | "declined" | "expired"

export interface LinkPollResponse extends BridgeEnvelope {
  state: LinkRequestState
  link?: Link
}

export interface LinkRevokeBody extends BridgeEnvelope {
  linkId: string
}

export interface LinkRevokeResponse extends BridgeEnvelope {
  revoked: true
}

// ---------------------------------------------------------------------------------------------
// §3a.4 + §3b Keys and hosting (forwarded, link-scoped, paid)
// ---------------------------------------------------------------------------------------------

export type ConsentMode = "not_required" | "required"
export type ServerLaneState = "no_secret" | "awaiting_first_event" | "receiving"

export interface InfiniteKeys {
  status: "ready" | "not_provisioned"
  siteSourceKey: string | null
  productionHosts: string[]
  consentMode: ConsentMode | null
  /** The emitted config's `consent.storageKey` (D2 seeds it on consent-required sites). */
  consentStorageKey: string | null
  collectPath: string | null
}

export interface Ga4Stream {
  measurementId: string
  defaultUri: string | null
  streamName: string | null
}

export interface Ga4Keys {
  status: "connected" | "not_connected" | "read_failed"
  propertyLabel: string | null
  streams: Ga4Stream[]
}

export interface PosthogKeys {
  status: "connected" | "not_connected" | "read_failed"
  projectKey: string | null
  apiHost: string | null
  /** us/app → https://us.i.posthog.com, eu → https://eu.i.posthog.com, self-hosted = apiHost. */
  ingestHost: string | null
  uiHost: string | null
  region: "us" | "eu" | "self_hosted" | null
}

export interface MetaPixel {
  pixelId: string
  sourceRef: string
  adAccountLabel: string | null
}

export interface MetaKeys {
  /** `infinite_dataset`: the pixel is Infinite's own dataset, or the workspace is Infinite's → `pixels: []`. */
  status: "connected" | "not_connected" | "no_pixel" | "multiple" | "infinite_dataset"
  pixels: MetaPixel[]
}

/** §3b `GET keys`: public IDs only. No `*token` field. */
export interface TagKeys {
  infinite: InfiniteKeys
  ga4: Ga4Keys
  posthog: PosthogKeys
  meta: MetaKeys
  serverLane: { laneState: ServerLaneState; envWriteGranted: boolean }
}

export interface KeysResponse extends BridgeEnvelope, TagKeys {}

export type EnvTarget = "production" | "preview" | "development"

export interface VercelHosting {
  projectRef: string
  projectName: string
  productionBranch: string
  rootDirectory: string | null
  framework: string | null
  productionDomains: string[]
  /** `*.vercel.app` production aliases. */
  productionAliases: string[]
  envWriteGranted: boolean
  previewProtection: "none" | "vercel_authentication" | "password" | "unknown"
  /** Present only when `envNames` were asked for: presence per target, never a value. */
  envTargets?: Record<string, EnvTarget[]>
}

export interface TagHosting {
  provider: "vercel" | "none"
  vercel: VercelHosting | null
}

export interface HostingResponse extends BridgeEnvelope, TagHosting {}

export type DeploymentState = "not_found" | "building" | "ready" | "error" | "canceled"

export interface DeployStatusResponse extends BridgeEnvelope {
  mergeDeployment: { state: DeploymentState; readyAt: string | null } | null
  serving: { sha: string; readyAt: string | null; createdAt: string; ref: string | null } | null
  target: "production"
}

// ---------------------------------------------------------------------------------------------
// §3a.5 + §3b Runs, receipts, report, baseline (forwarded, link-scoped, paid)
// ---------------------------------------------------------------------------------------------

export type WizardRunPhase = "before" | "in_pr" | "merged" | "proven" | "abandoned"
export type ProofState = "pending" | "pending_desktop" | "proving" | "proven" | "problem" | "undetermined"
export type ProofProducer = "tag" | "desktop"

/** Sent at the END of the `agent` step (worker and reviewer are known only then). */
export interface StartRunBody extends BridgeEnvelope {
  tagVersion: string
  repoFingerprint: string
  worker: AgentWorkerKind
  reviewer: AgentReviewerKind
}

export interface StartRunResponse extends BridgeEnvelope {
  runId: string
  /** The server clock (receipts count only at or after it). */
  startedAt: string
}

export interface ProofClaimBody extends BridgeEnvelope {
  producer: ProofProducer
}

/** The loser gets 409 `claimed_by_other` with the current ProofState in `error.state`. */
export interface ProofClaimResponse extends BridgeEnvelope {
  granted: true
  proofState: "proving"
}

/**
 * §3b runs PATCH. `phase` only moves forward; `clickTestedConversions` is an append-only union;
 * `proofState` is accepted only from `proving` and only from the producer holding the claim.
 */
export interface RunPatch {
  prUrl?: string
  prNumber?: number
  prHeadSha?: string
  mergeSha?: string
  mergedAt?: string
  approvedConversions?: string[]
  clickTestedConversions?: string[]
  phase?: WizardRunPhase
  checkinOptIn?: boolean
  proofState?: "proven" | "problem" | "undetermined"
}

export interface PatchRunBody extends BridgeEnvelope {
  patch: RunPatch
}

/** A run's public fields (§3c.1 columns minus workspace, site-source and engine-project ids). */
export interface WizardRunPublic {
  runId: string
  tagVersion: string
  repoFingerprint: string
  worker: AgentWorkerKind
  reviewer: AgentReviewerKind
  startedAt: string
  phase: WizardRunPhase
  prUrl: string | null
  prNumber: number | null
  prHeadSha: string | null
  mergeSha: string | null
  mergedAt: string | null
  deployedSha: string | null
  deployedAt: string | null
  proofState: ProofState
  proofClaimedBy: ProofProducer | null
  approvedConversions: string[]
  clickTestedConversions: string[]
  checkinOptIn: boolean
  checkinDueAt: string | null
  checkinDoneAt: string | null
}

export interface RunResponse extends BridgeEnvelope {
  run: WizardRunPublic
}

export interface ReceiptsBody extends BridgeEnvelope, ReceiptsRequestFields {}
export interface ReceiptsResponse extends BridgeEnvelope, ReceiptsResponseFields {}

/** The tag posts its own full reports; the desktop's partial goes to the cloud directly (§3i.6). */
export interface ReportPostBody extends BridgeEnvelope {
  phase: ReportPhase
  producer: "tag"
  partial: false
  report: ReportV2
}

export interface ReportPostResponse extends BridgeEnvelope {
  id: string
  phase: ReportPhase
  storedAt: string
  /** The client checks the echo against what it sent. */
  echo: { schema: ReportV2["schema"]; runId: string }
}

export interface BaselineResponse extends BridgeEnvelope, BaselineResponseFields {}

// ---------------------------------------------------------------------------------------------
// §3a.6 Settings verbs (forwarded, link-scoped, paid)
// ---------------------------------------------------------------------------------------------

export interface SiteSourceBody extends BridgeEnvelope {
  /** At most 10. D1 adds `sharedAcknowledged` from the link record when it forwards. */
  productionHosts: string[]
  consentMode: ConsentMode
}

export interface SiteSourceResponse extends BridgeEnvelope {
  siteSourceKey: string
  productionHosts: string[]
  consentMode: ConsentMode
  created: boolean
}

/** §3b `CONVERSION_TYPES`. Subscribe = `type:"custom"`, `label:"Subscribe"`. */
export const CONVERSION_TYPES = ["signup", "lead", "booking", "purchase", "trial", "download", "custom"] as const
export type ConversionType = (typeof CONVERSION_TYPES)[number]
export const CONVERSION_DEDUPES = ["event", "session", "visitor_ttl", "account"] as const
export type ConversionDedupe = (typeof CONVERSION_DEDUPES)[number]
/** A conversion name: `^[a-z][a-z0-9_]{0,63}$`. */
export const CONVERSION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export interface ConversionDeclaration {
  name: string
  type: ConversionType
  /** ≤ 60 chars. */
  label?: string
  dedupe: ConversionDedupe
}

export interface ConversionsBody extends BridgeEnvelope {
  runId: string
  conversions: ConversionDeclaration[]
}

export interface ConversionsResponse extends BridgeEnvelope {
  declared: string[]
  refused: Array<{ name: string; reason: string }>
}

export interface Ga4KeyEventsBody extends BridgeEnvelope {
  runId: string
  /** Each must be in approved_conversions ∩ click_tested_conversions. */
  names: string[]
}

export interface Ga4KeyEventsResponse extends BridgeEnvelope {
  created: string[]
  alreadyExisted: string[]
  refused: Array<{ name: string; reason: "not_approved" | "not_click_tested" }>
}

/** The server lane as the tag may see it: states and timestamps only, never the secret. */
export interface TagServerLaneStatus {
  laneState: ServerLaneState
  secretSetAt: string | null
  lastReceivedAt: string | null
  envWriteGranted: boolean
}

export interface ServerLaneStatusResponse extends BridgeEnvelope, TagServerLaneStatus {}

/** The wizard always sends `skip`: the settings go live with the user's merge. */
export interface ProvisionEnvBody extends BridgeEnvelope {
  redeploy: "skip" | "serving_production"
}

/** `skipped.reason` is `not_requested` when the wizard sent `redeploy:"skip"`. */
export type ServerLaneRedeploy =
  | { deploymentId: string }
  | { skipped: true; reason: string }
  | { unconfirmed: true; reason: string }

export interface ProvisionEnvResponse extends BridgeEnvelope {
  /** The env NAMES written (never a value). */
  written: string[]
  mintedNewSecret: boolean
  redeploy: ServerLaneRedeploy
  status: TagServerLaneStatus
}

export type MetaRelayUnavailableReason = "not_rolled_out" | "no_pixel" | "infinite_dataset" | "non_production_source"

export interface MetaRelayStatusResponse extends BridgeEnvelope {
  available: boolean
  reason: MetaRelayUnavailableReason | null
  bound: { sourceRef: string; pixelId: string } | null
  enabled: boolean
}

export interface MetaRelayEnableBody extends BridgeEnvelope {
  sourceRef: string
  enable: true
}

export interface RemoveEnvResponse extends BridgeEnvelope {
  removed: string[]
}

export interface DisableSiteSourceResponse extends BridgeEnvelope {
  disabled: true
}

// ---------------------------------------------------------------------------------------------
// §3a.8 Test engine (local, link-scoped, paid; D2). Request and result shapes are in test-engine.ts.
// ---------------------------------------------------------------------------------------------

export type TestRunState = "queued" | "running" | "done" | "failed" | "cancelled"

export interface TestRunStartResponse extends BridgeEnvelope {
  testRunId: string
  state: "queued"
}

export interface TestRunPollResponse extends BridgeEnvelope {
  state: TestRunState
  progress: Array<{ at: string; text: string }>
  result?: TestResult
  error?: { code: string; message: string }
}

export interface TestRunCancelResponse extends BridgeEnvelope {
  testRunId: string
  state: "cancelled"
}

// ---------------------------------------------------------------------------------------------
// The verb table
// ---------------------------------------------------------------------------------------------

export const BRIDGE_VERB_IDS = [
  "status",
  "link.request",
  "link.poll",
  "link.revoke",
  "keys",
  "hosting",
  "hosting.deploy",
  "runs.start",
  "runs.proof-claim",
  "runs.patch",
  "runs.get",
  "receipts",
  "report",
  "baseline",
  "site-source",
  "conversions",
  "ga4-key-events",
  "server-lane.status",
  "server-lane.provision-env",
  "meta-relay.status",
  "meta-relay.enable",
  "uninstall.remove-env",
  "uninstall.disable-site-source",
  "test.start",
  "test.poll",
  "test.cancel"
] as const
export type BridgeVerbId = (typeof BRIDGE_VERB_IDS)[number]

export type BridgeMethod = "GET" | "POST" | "PATCH"

export interface BridgeVerbSpec {
  verb: BridgeVerbId
  method: BridgeMethod
  /** The path with `:param` segments. */
  path: string
  /** Query parameters the verb reads (all optional unless the verb says otherwise). */
  query: readonly string[]
  capability: TagCapability
  /** Carries `X-Infinite-Link-Id`; the desktop resolves the workspace ONLY from that link record. */
  linkScoped: boolean
  /** 402 `subscription_required` when the linked workspace is not subscribed. */
  paid: boolean
  successStatus: 200 | 201 | 202
  /** The JSON body's shape; null for GET. */
  request: ObjectShape | null
  response: ObjectShape
  /** True for verbs that change state; the engine never calls one while an agent child is alive (§3a.9.4). */
  stateChanging: boolean
}

// ---- shapes (exhaustive per type; see shape.ts) ----

const ENVELOPE = ["protocolVersion", "requestId"] as const

const RUNTIME_SHAPE = shapeOf<BridgeRuntime>()("BridgeRuntime", ["variant", "label"], [])
const PROTOCOL_SHAPE = shapeOf<BridgeProtocolRange>()("BridgeProtocolRange", ["min", "max"], [])

export const BRIDGE_DESCRIPTOR_SHAPE = shapeOf<BridgeDescriptor>()(
  "BridgeDescriptor",
  ["schemaVersion", "service", "protocol", "capabilities", "url", "pid", "bootId", "desktopVersion", "runtime", "token", "startedAt"],
  [],
  { protocol: PROTOCOL_SHAPE, runtime: RUNTIME_SHAPE }
)

export const BRIDGE_STATE_FILE_SHAPE = shapeOf<BridgeStateFile>()("BridgeStateFile", ["schemaVersion", "state", "updatedAt"], [])

export const BRIDGE_ERROR_BODY_SHAPE = shapeOf<BridgeErrorBody>()(
  "BridgeErrorBody",
  ["code", "message", "retryable"],
  ["field", "state", "upstreamStatus"]
)
export const BRIDGE_ERROR_RESPONSE_SHAPE = shapeOf<BridgeErrorResponse>()("BridgeErrorResponse", [...ENVELOPE, "error"], [], {
  error: BRIDGE_ERROR_BODY_SHAPE
})

const STATUS_RESPONSE_SHAPE = shapeOf<StatusResponse>()(
  "StatusResponse",
  [...ENVELOPE, "service", "bootId", "desktopVersion", "runtime", "signedIn", "capabilities", "protocol"],
  [],
  { runtime: RUNTIME_SHAPE, protocol: PROTOCOL_SHAPE }
)

const LINK_SITE_SHAPE = shapeOf<LinkSite>()("LinkSite", ["repoFingerprint", "repoLabel", "appRoot", "folderLabel", "productionHostHint"], [])
const LINK_SHAPE = shapeOf<Link>()("Link", ["linkId", "workspace", "site", "approvedAt", "remembered"], [], {
  workspace: shapeOf<Link["workspace"]>()("Link.workspace", ["name"], []),
  site: shapeOf<Link["site"]>()("Link.site", ["repoLabel", "appRoot"], [])
})
const LINK_REQUEST_BODY_SHAPE = shapeOf<LinkRequestBody>()("LinkRequestBody", [...ENVELOPE, "code", "site", "client"], [], {
  site: LINK_SITE_SHAPE,
  client: shapeOf<LinkRequestBody["client"]>()("LinkRequestBody.client", ["tagVersion"], [])
})
const LINK_REQUEST_RESPONSE_SHAPE = shapeOf<LinkRequestResponse>()(
  "LinkRequestResponse",
  [...ENVELOPE, "linkRequestId", "state", "expiresAt"],
  ["link"],
  { link: LINK_SHAPE }
)
const LINK_POLL_RESPONSE_SHAPE = shapeOf<LinkPollResponse>()("LinkPollResponse", [...ENVELOPE, "state"], ["link"], { link: LINK_SHAPE })
const LINK_REVOKE_BODY_SHAPE = shapeOf<LinkRevokeBody>()("LinkRevokeBody", [...ENVELOPE, "linkId"], [])
const LINK_REVOKE_RESPONSE_SHAPE = shapeOf<LinkRevokeResponse>()("LinkRevokeResponse", [...ENVELOPE, "revoked"], [])

export const TAG_KEYS_FIELDS = {
  infinite: shapeOf<InfiniteKeys>()(
    "InfiniteKeys",
    ["status", "siteSourceKey", "productionHosts", "consentMode", "consentStorageKey", "collectPath"],
    []
  ),
  ga4: shapeOf<Ga4Keys>()("Ga4Keys", ["status", "propertyLabel", "streams"], [], {
    streams: arrayOf(shapeOf<Ga4Stream>()("Ga4Stream", ["measurementId", "defaultUri", "streamName"], []))
  }),
  posthog: shapeOf<PosthogKeys>()("PosthogKeys", ["status", "projectKey", "apiHost", "ingestHost", "uiHost", "region"], []),
  meta: shapeOf<MetaKeys>()("MetaKeys", ["status", "pixels"], [], {
    pixels: arrayOf(shapeOf<MetaPixel>()("MetaPixel", ["pixelId", "sourceRef", "adAccountLabel"], []))
  }),
  serverLane: shapeOf<TagKeys["serverLane"]>()("TagKeys.serverLane", ["laneState", "envWriteGranted"], [])
} as const
const KEYS_RESPONSE_SHAPE = shapeOf<KeysResponse>()(
  "KeysResponse",
  [...ENVELOPE, "infinite", "ga4", "posthog", "meta", "serverLane"],
  [],
  TAG_KEYS_FIELDS
)

const VERCEL_HOSTING_SHAPE = shapeOf<VercelHosting>()(
  "VercelHosting",
  [
    "projectRef",
    "projectName",
    "productionBranch",
    "rootDirectory",
    "framework",
    "productionDomains",
    "productionAliases",
    "envWriteGranted",
    "previewProtection"
  ],
  ["envTargets"]
)
const HOSTING_RESPONSE_SHAPE = shapeOf<HostingResponse>()("HostingResponse", [...ENVELOPE, "provider", "vercel"], [], {
  vercel: nullable(VERCEL_HOSTING_SHAPE)
})
const DEPLOY_STATUS_RESPONSE_SHAPE = shapeOf<DeployStatusResponse>()(
  "DeployStatusResponse",
  [...ENVELOPE, "mergeDeployment", "serving", "target"],
  [],
  {
    mergeDeployment: nullable(shapeOf<NonNullable<DeployStatusResponse["mergeDeployment"]>>()("MergeDeployment", ["state", "readyAt"], [])),
    serving: nullable(shapeOf<NonNullable<DeployStatusResponse["serving"]>>()("ServingDeployment", ["sha", "readyAt", "createdAt", "ref"], []))
  }
)

const START_RUN_BODY_SHAPE = shapeOf<StartRunBody>()("StartRunBody", [...ENVELOPE, "tagVersion", "repoFingerprint", "worker", "reviewer"], [])
const START_RUN_RESPONSE_SHAPE = shapeOf<StartRunResponse>()("StartRunResponse", [...ENVELOPE, "runId", "startedAt"], [])
const PROOF_CLAIM_BODY_SHAPE = shapeOf<ProofClaimBody>()("ProofClaimBody", [...ENVELOPE, "producer"], [])
const PROOF_CLAIM_RESPONSE_SHAPE = shapeOf<ProofClaimResponse>()("ProofClaimResponse", [...ENVELOPE, "granted", "proofState"], [])
export const RUN_PATCH_SHAPE = shapeOf<RunPatch>()(
  "RunPatch",
  [],
  [
    "prUrl",
    "prNumber",
    "prHeadSha",
    "mergeSha",
    "mergedAt",
    "approvedConversions",
    "clickTestedConversions",
    "phase",
    "checkinOptIn",
    "proofState"
  ]
)
const PATCH_RUN_BODY_SHAPE = shapeOf<PatchRunBody>()("PatchRunBody", [...ENVELOPE, "patch"], [], { patch: RUN_PATCH_SHAPE })
export const WIZARD_RUN_PUBLIC_SHAPE = shapeOf<WizardRunPublic>()(
  "WizardRunPublic",
  [
    "runId",
    "tagVersion",
    "repoFingerprint",
    "worker",
    "reviewer",
    "startedAt",
    "phase",
    "prUrl",
    "prNumber",
    "prHeadSha",
    "mergeSha",
    "mergedAt",
    "deployedSha",
    "deployedAt",
    "proofState",
    "proofClaimedBy",
    "approvedConversions",
    "clickTestedConversions",
    "checkinOptIn",
    "checkinDueAt",
    "checkinDoneAt"
  ],
  []
)
const RUN_RESPONSE_SHAPE = shapeOf<RunResponse>()("RunResponse", [...ENVELOPE, "run"], [], { run: WIZARD_RUN_PUBLIC_SHAPE })

const RECEIPTS_BODY_SHAPE: ObjectShape = {
  ...RECEIPTS_REQUEST_SHAPE,
  name: "ReceiptsBody",
  required: [...ENVELOPE, ...RECEIPTS_REQUEST_SHAPE.required]
}
const RECEIPTS_BRIDGE_RESPONSE_SHAPE: ObjectShape = {
  ...RECEIPTS_RESPONSE_SHAPE,
  name: "ReceiptsResponse",
  required: [...ENVELOPE, ...RECEIPTS_RESPONSE_SHAPE.required]
}
const REPORT_POST_BODY_SHAPE = shapeOf<ReportPostBody>()("ReportPostBody", [...ENVELOPE, "phase", "producer", "partial", "report"], [], {
  report: REPORT_V2_SHAPE
})
const REPORT_POST_RESPONSE_SHAPE = shapeOf<ReportPostResponse>()("ReportPostResponse", [...ENVELOPE, "id", "phase", "storedAt", "echo"], [], {
  echo: shapeOf<ReportPostResponse["echo"]>()("ReportPostResponse.echo", ["schema", "runId"], [])
})
const BASELINE_RESPONSE_SHAPE: ObjectShape = {
  ...BASELINE_SHAPE,
  name: "BaselineResponse",
  required: [...ENVELOPE, ...BASELINE_SHAPE.required]
}

const SITE_SOURCE_BODY_SHAPE = shapeOf<SiteSourceBody>()("SiteSourceBody", [...ENVELOPE, "productionHosts", "consentMode"], [])
const SITE_SOURCE_RESPONSE_SHAPE = shapeOf<SiteSourceResponse>()(
  "SiteSourceResponse",
  [...ENVELOPE, "siteSourceKey", "productionHosts", "consentMode", "created"],
  []
)
const CONVERSIONS_BODY_SHAPE = shapeOf<ConversionsBody>()("ConversionsBody", [...ENVELOPE, "runId", "conversions"], [], {
  conversions: arrayOf(shapeOf<ConversionDeclaration>()("ConversionDeclaration", ["name", "type", "dedupe"], ["label"]))
})
const NAME_REASON_SHAPE = shapeOf<{ name: string; reason: string }>()("NameReason", ["name", "reason"], [])
const CONVERSIONS_RESPONSE_SHAPE = shapeOf<ConversionsResponse>()("ConversionsResponse", [...ENVELOPE, "declared", "refused"], [], {
  refused: arrayOf(NAME_REASON_SHAPE)
})
const GA4_KEY_EVENTS_BODY_SHAPE = shapeOf<Ga4KeyEventsBody>()("Ga4KeyEventsBody", [...ENVELOPE, "runId", "names"], [])
const GA4_KEY_EVENTS_RESPONSE_SHAPE = shapeOf<Ga4KeyEventsResponse>()(
  "Ga4KeyEventsResponse",
  [...ENVELOPE, "created", "alreadyExisted", "refused"],
  [],
  { refused: arrayOf(NAME_REASON_SHAPE) }
)
const TAG_SERVER_LANE_STATUS_FIELDS = ["laneState", "secretSetAt", "lastReceivedAt", "envWriteGranted"] as const
export const TAG_SERVER_LANE_STATUS_SHAPE = shapeOf<TagServerLaneStatus>()("TagServerLaneStatus", TAG_SERVER_LANE_STATUS_FIELDS, [])
const SERVER_LANE_STATUS_RESPONSE_SHAPE = shapeOf<ServerLaneStatusResponse>()(
  "ServerLaneStatusResponse",
  [...ENVELOPE, ...TAG_SERVER_LANE_STATUS_FIELDS],
  []
)
const PROVISION_ENV_BODY_SHAPE = shapeOf<ProvisionEnvBody>()("ProvisionEnvBody", [...ENVELOPE, "redeploy"], [])
const PROVISION_ENV_RESPONSE_SHAPE = shapeOf<ProvisionEnvResponse>()(
  "ProvisionEnvResponse",
  [...ENVELOPE, "written", "mintedNewSecret", "redeploy", "status"],
  [],
  {
    redeploy: oneOf(
      shapeOf<{ deploymentId: string }>()("Redeploy.deployment", ["deploymentId"], []),
      shapeOf<{ skipped: true; reason: string }>()("Redeploy.skipped", ["skipped", "reason"], []),
      shapeOf<{ unconfirmed: true; reason: string }>()("Redeploy.unconfirmed", ["unconfirmed", "reason"], [])
    ),
    status: TAG_SERVER_LANE_STATUS_SHAPE
  }
)
const META_RELAY_STATUS_RESPONSE_SHAPE = shapeOf<MetaRelayStatusResponse>()(
  "MetaRelayStatusResponse",
  [...ENVELOPE, "available", "reason", "bound", "enabled"],
  [],
  { bound: nullable(shapeOf<NonNullable<MetaRelayStatusResponse["bound"]>>()("MetaRelayBinding", ["sourceRef", "pixelId"], [])) }
)
const META_RELAY_ENABLE_BODY_SHAPE = shapeOf<MetaRelayEnableBody>()("MetaRelayEnableBody", [...ENVELOPE, "sourceRef", "enable"], [])
const EMPTY_BODY_SHAPE = shapeOf<BridgeEnvelope>()("EmptyBody", [...ENVELOPE], [])
const REMOVE_ENV_RESPONSE_SHAPE = shapeOf<RemoveEnvResponse>()("RemoveEnvResponse", [...ENVELOPE, "removed"], [])
const DISABLE_SITE_SOURCE_RESPONSE_SHAPE = shapeOf<DisableSiteSourceResponse>()("DisableSiteSourceResponse", [...ENVELOPE, "disabled"], [])

const TEST_RUN_START_RESPONSE_SHAPE = shapeOf<TestRunStartResponse>()("TestRunStartResponse", [...ENVELOPE, "testRunId", "state"], [])
const TEST_RUN_POLL_RESPONSE_SHAPE = shapeOf<TestRunPollResponse>()("TestRunPollResponse", [...ENVELOPE, "state", "progress"], ["result", "error"], {
  progress: arrayOf(shapeOf<{ at: string; text: string }>()("TestRunProgress", ["at", "text"], [])),
  result: TEST_RESULT_SHAPE,
  error: shapeOf<{ code: string; message: string }>()("TestRunError", ["code", "message"], [])
})
const TEST_RUN_CANCEL_RESPONSE_SHAPE = shapeOf<TestRunCancelResponse>()("TestRunCancelResponse", [...ENVELOPE, "testRunId", "state"], [])

/** Every §3a verb, one row each (the key equals the row's `verb`; checked at compile time). */
export const BRIDGE_VERBS = {
  status: { verb: "status", method: "GET", path: "/v1/status", query: [], capability: "tag.status.v1", linkScoped: false, paid: false, successStatus: 200, request: null, response: STATUS_RESPONSE_SHAPE, stateChanging: false },
  "link.request": { verb: "link.request", method: "POST", path: "/v1/link/request", query: [], capability: "tag.link.v1", linkScoped: false, paid: false, successStatus: 200, request: LINK_REQUEST_BODY_SHAPE, response: LINK_REQUEST_RESPONSE_SHAPE, stateChanging: false },
  "link.poll": { verb: "link.poll", method: "GET", path: "/v1/link/request/:linkRequestId", query: ["wait"], capability: "tag.link.v1", linkScoped: false, paid: false, successStatus: 200, request: null, response: LINK_POLL_RESPONSE_SHAPE, stateChanging: false },
  "link.revoke": { verb: "link.revoke", method: "POST", path: "/v1/link/revoke", query: [], capability: "tag.link.v1", linkScoped: false, paid: false, successStatus: 200, request: LINK_REVOKE_BODY_SHAPE, response: LINK_REVOKE_RESPONSE_SHAPE, stateChanging: true },
  keys: { verb: "keys", method: "GET", path: "/v1/keys", query: [], capability: "tag.keys.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: KEYS_RESPONSE_SHAPE, stateChanging: false },
  hosting: { verb: "hosting", method: "GET", path: "/v1/hosting", query: ["envNames"], capability: "tag.hosting.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: HOSTING_RESPONSE_SHAPE, stateChanging: false },
  "hosting.deploy": { verb: "hosting.deploy", method: "GET", path: "/v1/hosting/deploy", query: ["sha"], capability: "tag.hosting.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: DEPLOY_STATUS_RESPONSE_SHAPE, stateChanging: false },
  "runs.start": { verb: "runs.start", method: "POST", path: "/v1/runs", query: [], capability: "tag.runs.v1", linkScoped: true, paid: true, successStatus: 201, request: START_RUN_BODY_SHAPE, response: START_RUN_RESPONSE_SHAPE, stateChanging: false },
  "runs.proof-claim": { verb: "runs.proof-claim", method: "POST", path: "/v1/runs/:runId/proof-claim", query: [], capability: "tag.runs.v1", linkScoped: true, paid: true, successStatus: 200, request: PROOF_CLAIM_BODY_SHAPE, response: PROOF_CLAIM_RESPONSE_SHAPE, stateChanging: true },
  "runs.patch": { verb: "runs.patch", method: "PATCH", path: "/v1/runs/:runId", query: [], capability: "tag.runs.v1", linkScoped: true, paid: true, successStatus: 200, request: PATCH_RUN_BODY_SHAPE, response: RUN_RESPONSE_SHAPE, stateChanging: false },
  "runs.get": { verb: "runs.get", method: "GET", path: "/v1/runs/:runId", query: [], capability: "tag.runs.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: RUN_RESPONSE_SHAPE, stateChanging: false },
  receipts: { verb: "receipts", method: "POST", path: "/v1/runs/:runId/receipts", query: [], capability: "tag.receipts.v1", linkScoped: true, paid: true, successStatus: 200, request: RECEIPTS_BODY_SHAPE, response: RECEIPTS_BRIDGE_RESPONSE_SHAPE, stateChanging: false },
  report: { verb: "report", method: "POST", path: "/v1/runs/:runId/report", query: [], capability: "tag.report.v2", linkScoped: true, paid: true, successStatus: 201, request: REPORT_POST_BODY_SHAPE, response: REPORT_POST_RESPONSE_SHAPE, stateChanging: false },
  baseline: { verb: "baseline", method: "GET", path: "/v1/baseline", query: ["runId"], capability: "tag.baseline.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: BASELINE_RESPONSE_SHAPE, stateChanging: false },
  "site-source": { verb: "site-source", method: "POST", path: "/v1/site-source", query: [], capability: "tag.site-source.v1", linkScoped: true, paid: true, successStatus: 200, request: SITE_SOURCE_BODY_SHAPE, response: SITE_SOURCE_RESPONSE_SHAPE, stateChanging: true },
  conversions: { verb: "conversions", method: "POST", path: "/v1/conversions", query: [], capability: "tag.conversions.v1", linkScoped: true, paid: true, successStatus: 200, request: CONVERSIONS_BODY_SHAPE, response: CONVERSIONS_RESPONSE_SHAPE, stateChanging: true },
  "ga4-key-events": { verb: "ga4-key-events", method: "POST", path: "/v1/ga4/key-events", query: [], capability: "tag.ga4-key-events.v1", linkScoped: true, paid: true, successStatus: 200, request: GA4_KEY_EVENTS_BODY_SHAPE, response: GA4_KEY_EVENTS_RESPONSE_SHAPE, stateChanging: true },
  "server-lane.status": { verb: "server-lane.status", method: "GET", path: "/v1/server-lane", query: [], capability: "tag.server-lane.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: SERVER_LANE_STATUS_RESPONSE_SHAPE, stateChanging: false },
  "server-lane.provision-env": { verb: "server-lane.provision-env", method: "POST", path: "/v1/server-lane/provision-env", query: [], capability: "tag.server-lane.v1", linkScoped: true, paid: true, successStatus: 200, request: PROVISION_ENV_BODY_SHAPE, response: PROVISION_ENV_RESPONSE_SHAPE, stateChanging: true },
  "meta-relay.status": { verb: "meta-relay.status", method: "GET", path: "/v1/meta-relay", query: [], capability: "tag.meta-relay.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: META_RELAY_STATUS_RESPONSE_SHAPE, stateChanging: false },
  "meta-relay.enable": { verb: "meta-relay.enable", method: "POST", path: "/v1/meta-relay", query: [], capability: "tag.meta-relay.v1", linkScoped: true, paid: true, successStatus: 200, request: META_RELAY_ENABLE_BODY_SHAPE, response: META_RELAY_STATUS_RESPONSE_SHAPE, stateChanging: true },
  "uninstall.remove-env": { verb: "uninstall.remove-env", method: "POST", path: "/v1/server-lane/remove-env", query: [], capability: "tag.uninstall.v1", linkScoped: true, paid: true, successStatus: 200, request: EMPTY_BODY_SHAPE, response: REMOVE_ENV_RESPONSE_SHAPE, stateChanging: true },
  "uninstall.disable-site-source": { verb: "uninstall.disable-site-source", method: "POST", path: "/v1/site-source/disable", query: [], capability: "tag.uninstall.v1", linkScoped: true, paid: true, successStatus: 200, request: EMPTY_BODY_SHAPE, response: DISABLE_SITE_SOURCE_RESPONSE_SHAPE, stateChanging: true },
  "test.start": { verb: "test.start", method: "POST", path: "/v1/test/runs", query: [], capability: "tag.test.v1", linkScoped: true, paid: true, successStatus: 202, request: TEST_RUN_REQUEST_SHAPE, response: TEST_RUN_START_RESPONSE_SHAPE, stateChanging: false },
  "test.poll": { verb: "test.poll", method: "GET", path: "/v1/test/runs/:testRunId", query: ["wait"], capability: "tag.test.v1", linkScoped: true, paid: true, successStatus: 200, request: null, response: TEST_RUN_POLL_RESPONSE_SHAPE, stateChanging: false },
  "test.cancel": { verb: "test.cancel", method: "POST", path: "/v1/test/runs/:testRunId/cancel", query: [], capability: "tag.test.v1", linkScoped: true, paid: true, successStatus: 200, request: EMPTY_BODY_SHAPE, response: TEST_RUN_CANCEL_RESPONSE_SHAPE, stateChanging: false }
} as const satisfies { readonly [V in BridgeVerbId]: BridgeVerbSpec & { readonly verb: V } }

/** The id shape each path parameter must have; a segment that does not match is no route (404), never forwarded. */
export const BRIDGE_PATH_PARAM_PATTERNS = {
  runId: BRIDGE_ID_PATTERNS.uuid,
  testRunId: BRIDGE_ID_PATTERNS.testRunId,
  linkRequestId: BRIDGE_ID_PATTERNS.linkRequestId
} as const

/**
 * Exact-match regexp for a verb's path (the query string is ignored). Each `:param` matches ONLY its
 * BRIDGE_PATH_PARAM_PATTERNS id shape, so `/v1/runs/..` or `/v1/runs/%2e%2e` addresses no verb. An unknown
 * param name throws (a table row with a param nobody validates would forward anything).
 */
export function bridgePathPattern(spec: Pick<BridgeVerbSpec, "path">): RegExp {
  const source = spec.path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const name = segment.slice(1)
      const pattern = (BRIDGE_PATH_PARAM_PATTERNS as Record<string, RegExp>)[name]
      if (!pattern) throw new Error(`bridge path ${spec.path}: no id pattern for :${name}`)
      return `(?:${pattern.source.replace(/^\^/, "").replace(/\$$/, "")})`
    })
    .join("/")
  return new RegExp(`^${source}(?:\\?[^#]*)?$`)
}

/** The verb a request addresses, or null (→ 404 `route_not_found`). */
export function matchBridgeVerb(method: string, pathWithQuery: string): BridgeVerbSpec | null {
  for (const id of BRIDGE_VERB_IDS) {
    const spec: BridgeVerbSpec = BRIDGE_VERBS[id]
    if (spec.method === method && bridgePathPattern(spec).test(pathWithQuery)) return spec
  }
  return null
}

/** The verbs that change state (`provision-env`, `ga4/key-events`, `conversions`, `meta-relay` POST, `site-source`, `uninstall`, `proof-claim`; plus `link.revoke`). */
export const STATE_CHANGING_VERBS: readonly BridgeVerbId[] = BRIDGE_VERB_IDS.filter((id) => BRIDGE_VERBS[id].stateChanging)

/** One cross-repo fixture row: `contracts/tag-wizard-v1/bridge-verbs.fixtures.json`. */
export interface BridgeVerbFixture {
  /** null only for the `route_not_found` example (no verb serves that path). */
  verb: BridgeVerbId | null
  /** A BridgeMethod, except in the `method_not_allowed` example. */
  method: string
  /** The concrete path, query included. */
  path: string
  /** The JSON body; null for GET. */
  request: unknown
  status: number
  response: unknown
}

export const BRIDGE_VERB_FIXTURE_SHAPE = shapeOf<BridgeVerbFixture>()("BridgeVerbFixture", ["verb", "method", "path", "request", "status", "response"], [])

// ---------------------------------------------------------------------------------------------
// The client lane O2 implements (one typed method per verb; strict response decoding; BridgeError)
// ---------------------------------------------------------------------------------------------

/** What every call needs besides its body: the run's link (link-scoped verbs) and an abort signal. */
export interface BridgeCallOptions {
  signal?: AbortSignal
}

/** Request bodies without the envelope: the client adds `protocolVersion` and `requestId`. */
export type WithoutEnvelope<T> = Omit<T, keyof BridgeEnvelope>

export interface TagBridgeClient {
  readonly descriptor: BridgeDescriptor
  /** True when the descriptor advertises the capability. */
  has(capability: TagCapability): boolean
  /** The link every link-scoped call carries (`X-Infinite-Link-Id`); set after `link` approves. */
  setLinkId(linkId: string | null): void

  status(options?: BridgeCallOptions): Promise<StatusResponse>
  requestLink(body: WithoutEnvelope<LinkRequestBody>, options?: BridgeCallOptions): Promise<LinkRequestResponse>
  pollLink(linkRequestId: string, waitSeconds: number, options?: BridgeCallOptions): Promise<LinkPollResponse>
  revokeLink(linkId: string, options?: BridgeCallOptions): Promise<LinkRevokeResponse>

  keys(options?: BridgeCallOptions): Promise<KeysResponse>
  hosting(envNames?: readonly string[], options?: BridgeCallOptions): Promise<HostingResponse>
  deployStatus(sha: string, options?: BridgeCallOptions): Promise<DeployStatusResponse>

  startRun(body: WithoutEnvelope<StartRunBody>, options?: BridgeCallOptions): Promise<StartRunResponse>
  claimProof(runId: string, producer: ProofProducer, options?: BridgeCallOptions): Promise<ProofClaimResponse>
  patchRun(runId: string, patch: RunPatch, options?: BridgeCallOptions): Promise<RunResponse>
  getRun(runId: string, options?: BridgeCallOptions): Promise<RunResponse>
  postReceipts(runId: string, body: ReceiptsRequestFields, options?: BridgeCallOptions): Promise<ReceiptsResponse>
  postReport(runId: string, phase: ReportPhase, report: ReportV2, options?: BridgeCallOptions): Promise<ReportPostResponse>
  baseline(runId: string, options?: BridgeCallOptions): Promise<BaselineResponse>

  ensureSiteSource(body: WithoutEnvelope<SiteSourceBody>, options?: BridgeCallOptions): Promise<SiteSourceResponse>
  declareConversions(body: WithoutEnvelope<ConversionsBody>, options?: BridgeCallOptions): Promise<ConversionsResponse>
  markGa4KeyEvents(body: WithoutEnvelope<Ga4KeyEventsBody>, options?: BridgeCallOptions): Promise<Ga4KeyEventsResponse>
  serverLaneStatus(options?: BridgeCallOptions): Promise<ServerLaneStatusResponse>
  provisionServerLaneEnv(body: WithoutEnvelope<ProvisionEnvBody>, options?: BridgeCallOptions): Promise<ProvisionEnvResponse>
  metaRelayStatus(options?: BridgeCallOptions): Promise<MetaRelayStatusResponse>
  enableMetaRelay(body: WithoutEnvelope<MetaRelayEnableBody>, options?: BridgeCallOptions): Promise<MetaRelayStatusResponse>
  removeServerLaneEnv(options?: BridgeCallOptions): Promise<RemoveEnvResponse>
  disableSiteSource(options?: BridgeCallOptions): Promise<DisableSiteSourceResponse>

  startTest(body: WithoutEnvelope<TestRunRequest>, options?: BridgeCallOptions): Promise<TestRunStartResponse>
  pollTest(testRunId: string, waitSeconds: number, options?: BridgeCallOptions): Promise<TestRunPollResponse>
  cancelTest(testRunId: string, options?: BridgeCallOptions): Promise<TestRunCancelResponse>
}

/**
 * The keys the desktop's output sanitizer drops (normalised: lowercase, non-alphanumerics removed). Mirrors
 * `bu:apps/desktop/src/main/brain/agent/cmdl-local-bridge.ts` `PRIVATE_OUTPUT_KEYS` exactly; a contract field
 * with one of these names would silently vanish on the way through the bridge.
 */
export const DESKTOP_PRIVATE_OUTPUT_KEYS = [
  "authorization",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "servicerolekey",
  "apikey",
  "encryptionkey",
  "confirmationid",
  "internalconfirmationid",
  "executioncontext",
  "rawexecutioncontext",
  "providerroute",
  "providersessionid",
  "engineprojectid",
  "cloudworkspaceid",
  "clouduserid",
  "authgeneration",
  "chatturnid",
  "rendererturnid",
  "webcontentsid"
] as const

/**
 * The desktop sanitizer's field-name rule (§0), mirrored from `isPrivateOutputKey` in the same file: false for
 * `__proto__`, any name whose normalised form is in DESKTOP_PRIVATE_OUTPUT_KEYS, is or ends in `token`, contains
 * `credential`, or is `prototype` / `constructor`. A field this rejects must not appear in any bridge shape.
 */
export function isSanitizerSafeFieldName(name: string): boolean {
  if (name === "__proto__") return false
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  return !(
    (DESKTOP_PRIVATE_OUTPUT_KEYS as readonly string[]).includes(normalized) ||
    normalized.endsWith("token") ||
    normalized.includes("credential") ||
    normalized === "prototype" ||
    normalized === "constructor"
  )
}

/** Shapes re-exported for the contract tests and for strict decoders. */
export const BRIDGE_SHAPES = {
  descriptor: BRIDGE_DESCRIPTOR_SHAPE,
  stateFile: BRIDGE_STATE_FILE_SHAPE,
  errorResponse: BRIDGE_ERROR_RESPONSE_SHAPE,
  verbFixture: BRIDGE_VERB_FIXTURE_SHAPE,
  linkSite: LINK_SITE_SHAPE,
  link: LINK_SHAPE,
  vercelHosting: VERCEL_HOSTING_SHAPE,
  runPublic: WIZARD_RUN_PUBLIC_SHAPE,
  runPatch: RUN_PATCH_SHAPE
} as const
