// §3i of the wizard build plan (the report schema `infinite-tag.report.v2`) as code: the report and
// cell shapes, the fixed row and finish-line ids, the reasons, the provenance sources, the
// `FINISH_LINE_SOURCES` table (§3i.7) as data, and the baseline response (§3i.5).
//
// NORMATIVE. Enforced by lane O1's builder AND by 1bu-1's C1 parser:
// 1. `value:null` → `display:"—"` plus one reason; never 0.
// 2. `provenance.source` is from PROVENANCE_SOURCES. There is no `agent` source.
// 3. "verified"/"proven" in `display` only with `provenance.receiptAt` AND `provenance.runId === runId`.
// 4. A denominator below 50 page views shows raw counts ("3 of 41"), never a percentage.
// 5. No deltas or arrows across columns; each cell carries its own window.
// 6. A measurement change is noted as "measurement changed", never as growth.
// 7. `in_pr` cells are keyed to `columns.in_pr.sha` and rebuilt on each new head.
import type { ServerLaneState } from "./bridge.js"
import { arrayOf, recordOf, shapeOf, type ObjectShape } from "./shape.js"

export const REPORT_SCHEMA = "infinite-tag.report.v2" as const

/** The three columns. The 7-day data is the single `day7.cell` (the `day7_checkin` row), not a fourth column. */
export const REPORT_COLUMN_IDS = ["live_today", "in_pr", "proven_live"] as const
export type ReportColumnId = (typeof REPORT_COLUMN_IDS)[number]

/** Report phases the cloud stores (a phase per column, plus the cloud's day-7 phase). */
export const REPORT_PHASES = ["live_today", "in_pr", "proven_live", "day7"] as const
export type ReportPhase = (typeof REPORT_PHASES)[number]

export const REPORT_PRODUCERS = ["tag", "desktop", "cloud"] as const
export type ReportProducer = (typeof REPORT_PRODUCERS)[number]

export const CELL_STATES = ["pass", "problem", "undetermined", "info", "pending", "not_measured"] as const
export type CellState = (typeof CELL_STATES)[number]

/** §3i.2. No `agent` source exists; a cell with any other source is rejected by the builder and the parser. */
export const PROVENANCE_SOURCES = ["wizard_check", "desktop_test", "cloud_read", "cloud_receipt", "plan_answer", "git_host"] as const
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

export const REASONS = [
  "not_connected",
  "needs_7_days",
  "via_tag_manager",
  "read_failed",
  "not_built",
  "below_sample_floor",
  "held_by_consent",
  "preview_protected",
  "env_dependent",
  "pending_deploy",
  "pending_open_infinite",
  "not_vercel",
  "automation_detected",
  "not_exercised",
  "not_probed"
] as const
export type Reason = (typeof REASONS)[number]

/** §3i.3 rule 4: below this many page views a share is shown as raw counts. */
export const SAMPLE_FLOOR_PAGE_VIEWS = 50
/** §3i.3 rule 1: the display of a null value. */
export const NULL_DISPLAY = "—" as const

export interface CellProvenance {
  source: ProvenanceSource
  checkId?: string
  window?: { from: string; to: string }
  at: string
  runId: string
  receiptAt?: string
}

/** §3i.2. */
export interface Cell {
  value: string | number | null
  display: string
  state: CellState
  provenance: CellProvenance
  reason?: Reason
  raw?: { numerator: number; denominator: number }
}

/** §3i.4: the fixed row ids, in the design table's order, with the design's labels. */
export const REPORT_ROWS = [
  { id: "checks_passing", label: "Checks passing (of 14)" },
  { id: "ga4_page_views_per_visit", label: "GA4 page views per visit" },
  { id: "posthog_route", label: "PostHog route" },
  { id: "meta_pixel", label: "Meta pixel" },
  { id: "preview_share", label: "Page views from preview links" },
  { id: "server_conversions", label: "Conversions sent from the server" },
  { id: "ga4_key_events", label: "GA4 key events" },
  { id: "consent_setting", label: "Consent setting" },
  { id: "live_test_per_tool", label: "Live test per tool" },
  { id: "day7_checkin", label: "7 days later" }
] as const
export type ReportRowId = (typeof REPORT_ROWS)[number]["id"]
export const REPORT_ROW_IDS: readonly ReportRowId[] = REPORT_ROWS.map((row) => row.id)

/** §3i.4: the 14 finish-line ids, in order (n = index + 1). */
export const FINISH_LINE_IDS = [
  "each_tool_once",
  "ids_match_connections",
  "previews_silent",
  "survives_ad_blockers",
  "spa_page_views",
  "conversions_server_side",
  "identity_joined",
  "utms_survive_redirects",
  "consent_recorded",
  "csp_allows",
  "ga4_key_events_received",
  "no_pii",
  "proof_from_real_visit",
  "keeps_being_checked"
] as const
export type FinishLineId = (typeof FINISH_LINE_IDS)[number]

export interface ReportColumnMeta {
  measuredAt: string | null
  sha: string | null
}

export interface ReportV2 {
  schema: typeof REPORT_SCHEMA
  runId: string
  tagVersion: string
  generatedAt: string
  site: { repoLabel: string; productionHost: string | null }
  columns: {
    live_today: ReportColumnMeta
    in_pr: ReportColumnMeta
    proven_live: ReportColumnMeta & { pending: "deploy" | "open_infinite" | "rerun_tag" | null }
  }
  rows: Array<{ id: ReportRowId; label: string; cells: Record<ReportColumnId, Cell> }>
  day7: { measuredAt: string | null; window: { from: string; to: string } | null; cell: Cell | null }
  finishLine: Array<{ n: number; id: FinishLineId; cells: Record<ReportColumnId, Cell> }>
  notes: string[]
}

/** One column as the run state keeps it between steps (lane O1's builder renders the report from these). */
export interface ReportColumnSnapshot {
  meta: ReportColumnMeta
  cells: Partial<Record<ReportRowId, Cell>>
  finishLine: Partial<Record<FinishLineId, Cell>>
}

// ---------------------------------------------------------------------------------------------
// §3i.7 FINISH_LINE_SOURCES
// ---------------------------------------------------------------------------------------------

/**
 * The named inputs a finish-line cell may be computed from. Each maps to the ONE provenance source a
 * cell built from it must carry (FINISH_LINE_INPUT_PROVENANCE), so the builder and the cloud parser
 * can both reject a cell computed from anything else.
 */
export const FINISH_LINE_INPUTS = [
  "dry_live.graded",
  "dry_live.ids_vs_keys",
  "dry_live.spa_navigation",
  "dry_live.pii",
  "rehearsal.graded",
  "rehearsal.ids_vs_keys",
  "rehearsal.preview_self",
  "rehearsal.spa_navigation",
  "rehearsal.posthog_via_proxy_once",
  "rehearsal.no_csp_violation",
  "rehearsal.redirects",
  "rehearsal.pii",
  "real_visit.graded",
  "real_visit.ids_vs_keys",
  "real_visit.csp",
  "real_visit.pii",
  "census",
  "census.identify_reset",
  "t0.host_matrix",
  "t1.live_bytes",
  "t1.proxy",
  "t1.redirect_walk",
  "t1.csp",
  "static.server_lane_mount_order",
  "static.job8",
  "static.job8.no_pii_in_outcome",
  "static.job9",
  "static.job13",
  "baseline.preview_share",
  "baseline.server_lane_state",
  "baseline.server_lane_outcomes",
  "baseline.conversions_infinite",
  "baseline.key_events",
  "keys.consent_mode",
  "site_source.response",
  "ga4_key_events.response",
  "plan.answer",
  "plan.checkin_opt_in",
  "receipts.posthog",
  "receipts.server_lane",
  "receipts.per_tool",
  "passive.first_real_outcome",
  "passive.first_identify",
  "run.checkin_due_at",
  "cloud.daily_check_registered"
] as const
export type FinishLineInput = (typeof FINISH_LINE_INPUTS)[number]

export const FINISH_LINE_INPUT_PROVENANCE: { readonly [I in FinishLineInput]: ProvenanceSource } = {
  "dry_live.graded": "desktop_test",
  "dry_live.ids_vs_keys": "desktop_test",
  "dry_live.spa_navigation": "desktop_test",
  "dry_live.pii": "desktop_test",
  "rehearsal.graded": "desktop_test",
  "rehearsal.ids_vs_keys": "desktop_test",
  "rehearsal.preview_self": "desktop_test",
  "rehearsal.spa_navigation": "desktop_test",
  "rehearsal.posthog_via_proxy_once": "desktop_test",
  "rehearsal.no_csp_violation": "desktop_test",
  "rehearsal.redirects": "desktop_test",
  "rehearsal.pii": "desktop_test",
  "real_visit.graded": "desktop_test",
  "real_visit.ids_vs_keys": "desktop_test",
  "real_visit.csp": "desktop_test",
  "real_visit.pii": "desktop_test",
  census: "wizard_check",
  "census.identify_reset": "wizard_check",
  "t0.host_matrix": "wizard_check",
  "t1.live_bytes": "wizard_check",
  "t1.proxy": "wizard_check",
  "t1.redirect_walk": "wizard_check",
  "t1.csp": "wizard_check",
  "static.server_lane_mount_order": "wizard_check",
  "static.job8": "wizard_check",
  "static.job8.no_pii_in_outcome": "wizard_check",
  "static.job9": "wizard_check",
  "static.job13": "wizard_check",
  "baseline.preview_share": "cloud_read",
  "baseline.server_lane_state": "cloud_read",
  "baseline.server_lane_outcomes": "cloud_read",
  "baseline.conversions_infinite": "cloud_read",
  "baseline.key_events": "cloud_read",
  "keys.consent_mode": "cloud_read",
  "site_source.response": "cloud_read",
  "ga4_key_events.response": "cloud_read",
  "plan.answer": "plan_answer",
  "plan.checkin_opt_in": "plan_answer",
  "receipts.posthog": "cloud_receipt",
  "receipts.server_lane": "cloud_receipt",
  "receipts.per_tool": "cloud_receipt",
  "passive.first_real_outcome": "cloud_read",
  "passive.first_identify": "cloud_read",
  "run.checkin_due_at": "cloud_read",
  "cloud.daily_check_registered": "cloud_read"
}

/**
 * One finish-line cell's allowed inputs. `notMeasured` = the cell is always "—" (`not_measured`) with
 * that reason and leaves N (the determinable count). `fixedState` = the cell is that state while its
 * inputs are what they are (e.g. `pending` until the passive check sees a real event).
 */
export interface FinishLineCellSource {
  inputs: readonly FinishLineInput[]
  notMeasured?: Reason
  fixedState?: "pending" | "info"
  reason?: Reason
}

const src = (...inputs: FinishLineInput[]): FinishLineCellSource => ({ inputs })
const dash = (reason: Reason): FinishLineCellSource => ({ inputs: [], notMeasured: reason })

/** §3i.7, one row per finish-line id. Each cell is computed ONLY from these inputs. */
export const FINISH_LINE_SOURCES: { readonly [F in FinishLineId]: { n: number } & Record<ReportColumnId, FinishLineCellSource> } = {
  each_tool_once: {
    n: 1,
    live_today: src("dry_live.graded", "census"),
    in_pr: src("rehearsal.graded", "census"),
    proven_live: src("real_visit.graded")
  },
  ids_match_connections: {
    n: 2,
    live_today: src("t1.live_bytes", "dry_live.ids_vs_keys"),
    in_pr: src("rehearsal.ids_vs_keys"),
    proven_live: src("real_visit.ids_vs_keys")
  },
  previews_silent: {
    n: 3,
    live_today: src("baseline.preview_share"),
    in_pr: src("t0.host_matrix", "rehearsal.preview_self"),
    proven_live: dash("needs_7_days")
  },
  survives_ad_blockers: {
    n: 4,
    live_today: src("t1.proxy", "baseline.server_lane_state"),
    in_pr: src("rehearsal.posthog_via_proxy_once", "static.server_lane_mount_order"),
    proven_live: src("receipts.posthog", "receipts.server_lane")
  },
  spa_page_views: {
    n: 5,
    live_today: src("dry_live.spa_navigation"),
    in_pr: src("rehearsal.spa_navigation"),
    proven_live: dash("not_exercised")
  },
  conversions_server_side: {
    n: 6,
    live_today: src("baseline.server_lane_outcomes", "baseline.conversions_infinite"),
    in_pr: src("static.job8"),
    proven_live: { inputs: ["passive.first_real_outcome"], fixedState: "pending" }
  },
  identity_joined: {
    n: 7,
    live_today: src("census.identify_reset"),
    in_pr: src("static.job9"),
    proven_live: { inputs: ["passive.first_identify"], fixedState: "pending" }
  },
  utms_survive_redirects: {
    n: 8,
    live_today: src("t1.redirect_walk"),
    in_pr: src("static.job13", "rehearsal.redirects"),
    proven_live: src("t1.redirect_walk")
  },
  consent_recorded: {
    n: 9,
    live_today: src("keys.consent_mode"),
    in_pr: src("plan.answer", "site_source.response"),
    proven_live: src("keys.consent_mode")
  },
  csp_allows: {
    n: 10,
    live_today: src("t1.csp"),
    in_pr: src("rehearsal.no_csp_violation"),
    proven_live: src("t1.csp", "real_visit.csp")
  },
  ga4_key_events_received: {
    n: 11,
    live_today: src("baseline.key_events"),
    in_pr: { inputs: ["ga4_key_events.response"], fixedState: "info" },
    // Pending until the cloud reads GA4's received key events again (the day-7 baseline).
    proven_live: { inputs: ["baseline.key_events"], fixedState: "pending", reason: "needs_7_days" }
  },
  no_pii: {
    n: 12,
    live_today: src("dry_live.pii"),
    in_pr: src("rehearsal.pii", "static.job8.no_pii_in_outcome"),
    proven_live: src("real_visit.pii")
  },
  proof_from_real_visit: {
    n: 13,
    live_today: dash("not_exercised"),
    in_pr: dash("not_exercised"),
    proven_live: src("receipts.per_tool")
  },
  keeps_being_checked: {
    n: 14,
    live_today: dash("not_exercised"),
    in_pr: src("plan.checkin_opt_in"),
    proven_live: src("run.checkin_due_at", "cloud.daily_check_registered")
  }
}

/** The provenance sources a finish-line cell may carry (empty = the cell must be "—" / not_measured). */
export function allowedFinishLineProvenance(id: FinishLineId, column: ReportColumnId): ProvenanceSource[] {
  const cell = FINISH_LINE_SOURCES[id][column]
  return [...new Set(cell.inputs.map((input) => FINISH_LINE_INPUT_PROVENANCE[input]))]
}

// ---------------------------------------------------------------------------------------------
// §3i.5 Baseline (C3 `GET baseline`)
// ---------------------------------------------------------------------------------------------

export type BaselineReadStatus = "ok" | "not_connected" | "read_failed"

export interface PageViewSplit {
  production: number
  preview: number
  other: number
}

/** Any unreadable part is null with a `status` saying why. Never 0. */
export interface BaselineResponseFields {
  window: { days: number; from: string; to: string }
  ga4: {
    status: BaselineReadStatus
    pageViews: PageViewSplit | null
    localhostExcluded: boolean | null
    topOffenders: Array<{ host: string; count: number }> | null
    keyEvents: Array<{ name: string; designated: boolean; received28d: number | null }> | null
    syncedAt: string | null
  }
  posthog: {
    status: BaselineReadStatus
    pageViews: PageViewSplit | null
    proxied: { tagged: number; webTotal: number } | null
    conversions: Array<{ name: string; count: number }> | null
  }
  conversions: { infinite: Array<{ name: string; count: number }> | null }
  serverLane: { laneState: ServerLaneState | null; documentRequests7d: number | null; outcomes7d: number | null }
  stripe: { status: "connected" | "not_connected" | "read_failed"; lastLiveEventAt: string | null }
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

const WINDOW_SHAPE = shapeOf<{ from: string; to: string }>()("Window", ["from", "to"], [])

export const CELL_SHAPE = shapeOf<Cell>()("Cell", ["value", "display", "state", "provenance"], ["reason", "raw"], {
  provenance: shapeOf<CellProvenance>()("CellProvenance", ["source", "at", "runId"], ["checkId", "window", "receiptAt"], {
    window: WINDOW_SHAPE
  }),
  raw: shapeOf<NonNullable<Cell["raw"]>>()("CellRaw", ["numerator", "denominator"], [])
})

const COLUMN_CELLS_SHAPE: ObjectShape = shapeOf<Record<ReportColumnId, Cell>>()("ColumnCells", ["live_today", "in_pr", "proven_live"], [], {
  live_today: CELL_SHAPE,
  in_pr: CELL_SHAPE,
  proven_live: CELL_SHAPE
})

const COLUMN_META_SHAPE = shapeOf<ReportColumnMeta>()("ReportColumnMeta", ["measuredAt", "sha"], [])

export const REPORT_V2_SHAPE = shapeOf<ReportV2>()(
  "ReportV2",
  ["schema", "runId", "tagVersion", "generatedAt", "site", "columns", "rows", "day7", "finishLine", "notes"],
  [],
  {
    site: shapeOf<ReportV2["site"]>()("ReportSite", ["repoLabel", "productionHost"], []),
    columns: shapeOf<ReportV2["columns"]>()("ReportColumns", ["live_today", "in_pr", "proven_live"], [], {
      live_today: COLUMN_META_SHAPE,
      in_pr: COLUMN_META_SHAPE,
      proven_live: shapeOf<ReportV2["columns"]["proven_live"]>()("ProvenLiveColumnMeta", ["measuredAt", "sha", "pending"], [])
    }),
    rows: arrayOf(shapeOf<ReportV2["rows"][number]>()("ReportRow", ["id", "label", "cells"], [], { cells: COLUMN_CELLS_SHAPE })),
    day7: shapeOf<ReportV2["day7"]>()("ReportDay7", ["measuredAt", "window", "cell"], [], { window: WINDOW_SHAPE, cell: CELL_SHAPE }),
    finishLine: arrayOf(shapeOf<ReportV2["finishLine"][number]>()("FinishLineRow", ["n", "id", "cells"], [], { cells: COLUMN_CELLS_SHAPE }))
  }
)

export const REPORT_COLUMN_SNAPSHOT_SHAPE = shapeOf<ReportColumnSnapshot>()("ReportColumnSnapshot", ["meta", "cells", "finishLine"], [], {
  meta: COLUMN_META_SHAPE,
  cells: recordOf(CELL_SHAPE),
  finishLine: recordOf(CELL_SHAPE)
})

const PAGE_VIEW_SPLIT_SHAPE = shapeOf<PageViewSplit>()("PageViewSplit", ["production", "preview", "other"], [])
const NAME_COUNT_SHAPE = shapeOf<{ name: string; count: number }>()("NameCount", ["name", "count"], [])

export const BASELINE_SHAPE = shapeOf<BaselineResponseFields>()(
  "Baseline",
  ["window", "ga4", "posthog", "conversions", "serverLane", "stripe"],
  [],
  {
    window: shapeOf<BaselineResponseFields["window"]>()("BaselineWindow", ["days", "from", "to"], []),
    ga4: shapeOf<BaselineResponseFields["ga4"]>()(
      "BaselineGa4",
      ["status", "pageViews", "localhostExcluded", "topOffenders", "keyEvents", "syncedAt"],
      [],
      {
        pageViews: PAGE_VIEW_SPLIT_SHAPE,
        topOffenders: arrayOf(shapeOf<{ host: string; count: number }>()("TopOffender", ["host", "count"], [])),
        keyEvents: arrayOf(
          shapeOf<NonNullable<BaselineResponseFields["ga4"]["keyEvents"]>[number]>()("BaselineKeyEvent", ["name", "designated", "received28d"], [])
        )
      }
    ),
    posthog: shapeOf<BaselineResponseFields["posthog"]>()("BaselinePosthog", ["status", "pageViews", "proxied", "conversions"], [], {
      pageViews: PAGE_VIEW_SPLIT_SHAPE,
      proxied: shapeOf<NonNullable<BaselineResponseFields["posthog"]["proxied"]>>()("BaselineProxied", ["tagged", "webTotal"], []),
      conversions: arrayOf(NAME_COUNT_SHAPE)
    }),
    conversions: shapeOf<BaselineResponseFields["conversions"]>()("BaselineConversions", ["infinite"], [], {
      infinite: arrayOf(NAME_COUNT_SHAPE)
    }),
    serverLane: shapeOf<BaselineResponseFields["serverLane"]>()("BaselineServerLane", ["laneState", "documentRequests7d", "outcomes7d"], []),
    stripe: shapeOf<BaselineResponseFields["stripe"]>()("BaselineStripe", ["status", "lastLiveEventAt"], [])
  }
)

/** The `ReportBuilder` lane O1 implements (renderers + the column builders). */
export interface ReportBuilder {
  /** Build the full report from the run's column snapshots; throws on any §3i.3 / §3i.7 violation. */
  build(input: {
    runId: string
    tagVersion: string
    site: ReportV2["site"]
    columns: { live_today: ReportColumnSnapshot | null; in_pr: ReportColumnSnapshot | null; proven_live: ReportColumnSnapshot | null }
    provenLivePending: ReportV2["columns"]["proven_live"]["pending"]
    day7: ReportV2["day7"] | null
    notes: string[]
  }): ReportV2
  renderTerminal(report: ReportV2, width: number): string
  /** Plain-text statuses; never a literal `- [ ]`. */
  renderMarkdown(report: ReportV2): string
  payload(report: ReportV2): ReportV2
}
