// §3h.7 of the wizard build plan (run-scoped receipts, `POST /v1/runs/:runId/receipts` → the cloud)
// as code.
//
// NORMATIVE. A receipt state is the cloud's OWN read (ledger rows, a PostHog query, the relay ledger),
// never a grade of desktop facts. "verified" needs a receipt at or after the run's server start.
// GA4 and the Meta pixel are never `verified` (no per-visit read exists): `delivering` at best.
import { shapeOf } from "./shape.js"

export const RECEIPT_LANES = ["infinite", "posthog", "ga4", "meta_pixel", "server_lane", "meta_capi"] as const
export type ReceiptLane = (typeof RECEIPT_LANES)[number]

export const RECEIPT_STATES = ["verified", "delivering", "pending", "no_receipt", "not_verifiable", "undetermined"] as const
export type ReceiptState = (typeof RECEIPT_STATES)[number]

export const RECEIPT_PROVENANCE = ["cloud_ledger", "posthog_query", "desktop_test", "relay_ledger"] as const
export type ReceiptProvenance = (typeof RECEIPT_PROVENANCE)[number]

export const RECEIPT_PHASES = ["proven_live", "day7"] as const
export type ReceiptPhase = (typeof RECEIPT_PHASES)[number]

/** What the cloud stores per receipt (a hash of the marker, never a raw id). */
export const RECEIPT_MARKER_KINDS = ["event_id", "distinct_id", "probe_path", "seen_leaving", "meta_event_id", "none"] as const

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

/** One case in `contracts/tag-wizard-v1/receipts.fixtures.json`. */
export interface ReceiptsFixtureCase {
  id: string
  note: string
  /** The run's server start; every `verified` receiptAt is at or after it. */
  runStartedAt: string
  request: ReceiptsRequestFields
  response: ReceiptsResponseFields
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

export const RECEIPTS_FIXTURE_CASE_SHAPE = shapeOf<ReceiptsFixtureCase>()(
  "ReceiptsFixtureCase",
  ["id", "note", "runStartedAt", "request", "response"],
  [],
  { request: RECEIPTS_REQUEST_SHAPE, response: RECEIPTS_RESPONSE_SHAPE }
)
