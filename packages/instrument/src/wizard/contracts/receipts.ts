// §3h.7 of the wizard build plan (run-scoped receipts, `POST /v1/runs/:runId/receipts` → the cloud)
// as code.
//
// NORMATIVE. A receipt state is the cloud's OWN read (ledger rows, a PostHog query, GA4's realtime report, the relay
// ledger), never a grade of desktop facts. "verified" needs a receipt at or after the run's server start.
//
// R4-3 (live run 4, amends §3h.7; LF4-P1-1 makes it ONE rule both repos run): with GA4 CONNECTED and the id seen
// leaving one of the connected property's web streams, the cloud asks the GA4 realtime report `/api/analytics/verify`
// uses (the workspace's own grant) for THAT stream's `page_view` count. GA4 realtime is minute-bucketed and carries NO
// per-visit id, so "GA4 received this visit" can only ever mean: a page_view in the minutes since the visit began and
// none in the quiet minutes just before it. The rule (`ga4RealtimeWindows` + `ga4RealtimeLane`, pinned by every
// `ga4Realtime` case in `receipts.fixtures.json`, which 1bu-1 vendors byte for byte and replays):
//   - Windows are whole clock minutes (realtime's `minutesAgo`, both ends inclusive, 0 = the read's own minute),
//     ANCHORED to the proof claim's absolute minute c (live-fix 4 round 1): `after` = minutes c and c + 1 only (the
//     visit follows the claim within seconds, so it lands in c, or in c + 1 for a claim late in its minute), `before`
//     = minutes c − 5..c − 1. Read at k = the read's minute − c, they are `after` = k..max(0, k − 1) and `before` =
//     k + 5..k + 1. When k + 5 > 29 the minutes before are past realtime's reach (null). A later read asks the SAME
//     minutes, never more: another visitor three minutes on is never this visit's page view.
//   - before > 0 → `delivering`, reason `ga4_realtime_busy` (another page view could be this one's: never singled out).
//   - before = 0 and after ≥ 1 → `verified`, provenance `ga4_realtime`, receiptAt = that read, reason null.
//   - before = 0 and after = 0 → `pending` inside the wait, then `no_receipt` reason `ga4_realtime_none`.
//   - the report could not be read, or the minutes before are past its reach → `delivering` reason
//     `ga4_realtime_unavailable`.
//   - every one of those has provenance `ga4_realtime` (GA4 was asked). GA4 not connected, or the id is not a stream of
//     the connected property → the seen-leaving answer (`delivering`, provenance `desktop_test`), GA4 not asked.
//   - FINAL answers stand (`ga4RealtimeFinal`): once the lane is `verified`, `delivering ga4_realtime_busy` or
//     `no_receipt ga4_realtime_none`, the cloud never asks GA4 again for that run and never overwrites the row; a
//     later poll (a resume, the app's re-pass, a read 30 minutes on) gets the stored answer. Only `pending` and
//     `ga4_realtime_unavailable` are asked again. `ga4RealtimeAfterReads` is the whole sequence.
// A page view in the claim's own minute but before the visit, or in the next minute from someone else, counts as
// `after`: that is the most a minute-level report can say, and the tag's words say exactly that ("in the minute of this
// visit or the next", never "this visit's page view").
// The Meta pixel is never `verified` (Meta reports only by the hour): `delivering` at best.
import { shapeOf } from "./shape.js"

export const RECEIPT_LANES = ["infinite", "posthog", "ga4", "meta_pixel", "server_lane", "meta_capi"] as const
export type ReceiptLane = (typeof RECEIPT_LANES)[number]

export const RECEIPT_STATES = ["verified", "delivering", "pending", "no_receipt", "not_verifiable", "undetermined"] as const
export type ReceiptState = (typeof RECEIPT_STATES)[number]

export const RECEIPT_PROVENANCE = ["cloud_ledger", "posthog_query", "desktop_test", "relay_ledger", "ga4_realtime"] as const
export type ReceiptProvenance = (typeof RECEIPT_PROVENANCE)[number]

export const RECEIPT_PHASES = ["proven_live", "day7"] as const
export type ReceiptPhase = (typeof RECEIPT_PHASES)[number]

/** R4-3: the reason codes the cloud's GA4 realtime read gives the `ga4` lane (anything else is shown as no reason). */
export const GA4_REALTIME_REASONS = ["ga4_realtime_busy", "ga4_realtime_none", "ga4_realtime_unavailable"] as const
export type Ga4RealtimeReason = (typeof GA4_REALTIME_REASONS)[number]

/**
 * What the cloud stores per receipt (a hash of the marker, never a raw id). Live run 5 (P3): a GA4 row decided by GA4's
 * realtime report is stored as `ga4_realtime` (same id, same hash), not `seen_leaving`, so the row names its source.
 */
export const RECEIPT_MARKER_KINDS = ["event_id", "distinct_id", "probe_path", "seen_leaving", "ga4_realtime", "meta_event_id", "none"] as const

/** LF4-P1-1: the quiet minutes before the visit the GA4 realtime rule needs, and realtime's reach on a standard property. */
export const GA4_REALTIME_BEFORE_MINUTES = 5
export const GA4_REALTIME_MAX_MINUTES_AGO = 29

export const RECEIPT_LIMITS = {
  /** The cloud keeps a lane `pending` while within this; the client re-polls. */
  defaultWaitMs: 120_000,
  pollIntervalMs: 10_000,
  maxInfiniteEventIds: 20
} as const

/** What the real visit observed, per lane. A lane the site does not run has no entry. */
export interface ReceiptMarkers {
  infinite?: { eventIds: string[] }
  posthog?: { distinctId: string }
  ga4?: { measurementId: string; seenLeaving: boolean; httpStatus: number | null }
  metaPixel?: { pixelId: string; seenLeaving: boolean; httpStatus: number | null }
  serverLane?: { probePath: string }
  metaCapi?: { metaEventIds: string[] }
}

/** The request body's verb fields (the bridge adds the envelope). */
export interface ReceiptsRequestFields {
  phase: ReceiptPhase
  markers: ReceiptMarkers
  waitMs: number
}

export interface LaneReceipt {
  state: ReceiptState
  receiptAt: string | null
  reason: string | null
  provenance: ReceiptProvenance
}

export interface ReceiptsResponseFields {
  runId: string
  phase: ReceiptPhase
  checkedAt: string
  lanes: Record<ReceiptLane, LaneReceipt>
}

/** One realtime minute range: `minutesAgo` from `startMinutesAgo` back to `endMinutesAgo`, both inclusive (0 = now). */
export interface Ga4MinuteRange {
  startMinutesAgo: number
  endMinutesAgo: number
}

export interface Ga4RealtimeWindows {
  before: Ga4MinuteRange
  after: Ga4MinuteRange
}

/** One read of GA4's realtime report by the cloud, for the visit's own stream. */
export interface Ga4RealtimeRead {
  /** When the cloud read it (a poll's `checkedAt`). */
  at: string
  /** The minutes asked (`ga4RealtimeWindows`); null when the minutes before the visit are past realtime's reach. */
  windows: Ga4RealtimeWindows | null
  /** The stream's page_view counts in each window; null when the report could not be read (or was not asked). */
  pageViews: { before: number; after: number } | null
  /**
   * Live-fix 4 round 1: true for a poll after the lane already held a FINAL answer (`ga4RealtimeFinal`): the cloud did
   * not ask GA4 (windows and pageViews are null) and answered the stored row.
   */
  notAsked?: true
}

/** The GA4 side of a receipts case: the workspace's GA4 is connected and the visit's id is one of its web streams. */
export interface Ga4RealtimeWorld {
  /** The run's proof claim (the real visit follows it within seconds). */
  proofClaimedAt: string
  /** Every poll's read, in order; the case's response is the last poll's. */
  reads: Ga4RealtimeRead[]
}

/**
 * LF4-P1-1 (anchored in live-fix 4 round 1): the minutes the cloud asks for a visit whose proof was claimed at
 * `proofClaimedAt`, read at `at`: always the claim's minute and the next (`after`) and the 5 before the claim's minute
 * (`before`), as `minutesAgo` from the read. Null when the minutes before are past GA4 realtime's reach.
 */
export function ga4RealtimeWindows(proofClaimedAt: string, at: string): Ga4RealtimeWindows | null {
  const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000)
  const k = Math.max(0, minute(at) - minute(proofClaimedAt))
  if (k + GA4_REALTIME_BEFORE_MINUTES > GA4_REALTIME_MAX_MINUTES_AGO) return null
  return {
    before: { startMinutesAgo: k + GA4_REALTIME_BEFORE_MINUTES, endMinutesAgo: k + 1 },
    after: { startMinutesAgo: k, endMinutesAgo: Math.max(0, k - 1) }
  }
}

/** LF4-P1-1: the `ga4` lane for one read (GA4 connected, the id one of its streams), the contract's one rule. */
export function ga4RealtimeLane(read: Ga4RealtimeRead, withinWait: boolean): LaneReceipt {
  const asked = (state: ReceiptState, reason: Ga4RealtimeReason | null, receiptAt: string | null = null): LaneReceipt => ({ state, receiptAt, reason, provenance: "ga4_realtime" })
  if (read.windows === null || read.pageViews === null) return asked("delivering", "ga4_realtime_unavailable")
  if (read.pageViews.before > 0) return asked("delivering", "ga4_realtime_busy")
  if (read.pageViews.after > 0) return asked("verified", null, read.at)
  return withinWait ? asked("pending", null) : asked("no_receipt", "ga4_realtime_none")
}

/**
 * Live-fix 4 round 1: a GA4 realtime answer no later read may change — `verified`, `delivering ga4_realtime_busy` (the
 * minutes before the claim are past, so they stay busy) and `no_receipt ga4_realtime_none` (decided once the wait
 * ended). `pending` and `ga4_realtime_unavailable` are asked again.
 */
export function ga4RealtimeFinal(lane: Pick<LaneReceipt, "state" | "reason" | "provenance">): boolean {
  if (lane.provenance !== "ga4_realtime") return false
  return lane.state === "verified" || (lane.state === "delivering" && lane.reason === "ga4_realtime_busy") || (lane.state === "no_receipt" && lane.reason === "ga4_realtime_none")
}

/**
 * Live-fix 4 round 1: the lane a run's polls end on, poll by poll (the wait runs from the first poll, like every other
 * lane's): each poll before a final answer asks GA4 (`ga4RealtimeLane`); every poll after one does not, and answers it.
 */
export function ga4RealtimeAfterReads(world: Ga4RealtimeWorld, waitMs: number): LaneReceipt | null {
  const first = world.reads[0]
  let lane: LaneReceipt | null = null
  for (const read of world.reads) {
    if (lane !== null && ga4RealtimeFinal(lane)) continue
    lane = ga4RealtimeLane(read, Date.parse(read.at) - Date.parse(first!.at) < waitMs)
  }
  return lane
}

/** One case in `contracts/tag-wizard-v1/receipts.fixtures.json`. */
export interface ReceiptsFixtureCase {
  id: string
  note: string
  /** The run's server start; every `verified` receiptAt is at or after it. */
  runStartedAt: string
  request: ReceiptsRequestFields
  response: ReceiptsResponseFields
  /** LF4-P1-1: present when the workspace's GA4 is connected (absent: GA4 is not connected, so it is never asked). */
  ga4Realtime?: Ga4RealtimeWorld
}

const LANE_RECEIPT_SHAPE = shapeOf<LaneReceipt>()("LaneReceipt", ["state", "receiptAt", "reason", "provenance"], [])

export const RECEIPT_MARKERS_SHAPE = shapeOf<ReceiptMarkers>()(
  "ReceiptMarkers",
  [],
  ["infinite", "posthog", "ga4", "metaPixel", "serverLane", "metaCapi"],
  {
    infinite: shapeOf<NonNullable<ReceiptMarkers["infinite"]>>()("Markers.infinite", ["eventIds"], []),
    posthog: shapeOf<NonNullable<ReceiptMarkers["posthog"]>>()("Markers.posthog", ["distinctId"], []),
    ga4: shapeOf<NonNullable<ReceiptMarkers["ga4"]>>()("Markers.ga4", ["measurementId", "seenLeaving", "httpStatus"], []),
    metaPixel: shapeOf<NonNullable<ReceiptMarkers["metaPixel"]>>()("Markers.metaPixel", ["pixelId", "seenLeaving", "httpStatus"], []),
    serverLane: shapeOf<NonNullable<ReceiptMarkers["serverLane"]>>()("Markers.serverLane", ["probePath"], []),
    metaCapi: shapeOf<NonNullable<ReceiptMarkers["metaCapi"]>>()("Markers.metaCapi", ["metaEventIds"], [])
  }
)

export const RECEIPTS_REQUEST_SHAPE = shapeOf<ReceiptsRequestFields>()("ReceiptsRequest", ["phase", "markers", "waitMs"], [], {
  markers: RECEIPT_MARKERS_SHAPE
})

export const RECEIPTS_RESPONSE_SHAPE = shapeOf<ReceiptsResponseFields>()("ReceiptsResult", ["runId", "phase", "checkedAt", "lanes"], [], {
  lanes: shapeOf<Record<ReceiptLane, LaneReceipt>>()(
    "ReceiptLanes",
    ["infinite", "posthog", "ga4", "meta_pixel", "server_lane", "meta_capi"],
    [],
    {
      infinite: LANE_RECEIPT_SHAPE,
      posthog: LANE_RECEIPT_SHAPE,
      ga4: LANE_RECEIPT_SHAPE,
      meta_pixel: LANE_RECEIPT_SHAPE,
      server_lane: LANE_RECEIPT_SHAPE,
      meta_capi: LANE_RECEIPT_SHAPE
    }
  )
})

const GA4_MINUTE_RANGE_SHAPE = shapeOf<Ga4MinuteRange>()("Ga4MinuteRange", ["startMinutesAgo", "endMinutesAgo"], [])

export const GA4_REALTIME_WORLD_SHAPE = shapeOf<Ga4RealtimeWorld>()("Ga4RealtimeWorld", ["proofClaimedAt", "reads"], [], {
  reads: {
    arrayOf: shapeOf<Ga4RealtimeRead>()("Ga4RealtimeRead", ["at", "windows", "pageViews"], ["notAsked"], {
      windows: { nullable: shapeOf<Ga4RealtimeWindows>()("Ga4RealtimeWindows", ["before", "after"], [], { before: GA4_MINUTE_RANGE_SHAPE, after: GA4_MINUTE_RANGE_SHAPE }) },
      pageViews: { nullable: shapeOf<{ before: number; after: number }>()("Ga4RealtimePageViews", ["before", "after"], []) }
    })
  }
})

export const RECEIPTS_FIXTURE_CASE_SHAPE = shapeOf<ReceiptsFixtureCase>()(
  "ReceiptsFixtureCase",
  ["id", "note", "runStartedAt", "request", "response"],
  ["ga4Realtime"],
  { request: RECEIPTS_REQUEST_SHAPE, response: RECEIPTS_RESPONSE_SHAPE, ga4Realtime: GA4_REALTIME_WORLD_SHAPE }
)
