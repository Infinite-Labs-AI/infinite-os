/**
 * Answer view contract. One typed, cleaned description of one tool result or one pending write,
 * sent by an app host to any renderer. Renderers draw it and never derive new facts from it:
 * no totals across nulls, no % between steps, no sums across legs. Words are DATA in the frame.
 * Key rule: no key may end in "token", contain "credential", or equal a host-private key.
 */
// ---- contract body (vendored verbatim into 1bu-1; edit only in infinite-os) ----
export const ANSWER_VIEW_CONTRACT_REVISION = 1 as const;
export const RESULT_VIEW_CAPABILITY = "result.view.v1" as const;
export const CONFIRM_FIELDS_CAPABILITY = "confirm.fields.v1" as const;
export const CONFIRM_STREAM_CAPABILITY = "confirm.stream.v1" as const;
export const APP_OPEN_CAPABILITY = "app.open.v1" as const;
export const ANSWER_VIEW_LIMITS = {
  maxRows: 200, maxCellChars: 500, maxTextChars: 2_000, maxDocumentChars: 64_000, maxFrameBytes: 262_144,
} as const;

export const ANSWER_VIEW_KINDS = [
  "numbers", "list", "record", "document", "images", "change",
  "launch", "job", "compare", "health", "link", "quiet",
] as const;
export type AnswerViewKind = (typeof ANSWER_VIEW_KINDS)[number];

/** 24 states. `working` and `applying` are renderer-local (tool.start / after a yes); never sent. */
export const ANSWER_VIEW_STATES = [
  "working", "ready", "nothing_found", "not_measured", "partial", "out_of_date",
  "not_connected", "blocked", "finish_in_app", "needs_yes", "needs_answer", "applying",
  "done", "failed", "cancelled", "expired", "outcome_unknown", "hit_limit",
  "background", "opened_in_app", "preview", "no_change", "showing_defaults", "cmdl_only",
] as const;
export type AnswerViewState = (typeof ANSWER_VIEW_STATES)[number];

export type IsoTime = string;
/** Why a value is null. show "dash" = "—" + footnote (not measured); "words" = print words in place ("New"). */
export interface ReasonV1 { code: string; words: string; show?: "dash" | "words" }
/** A host place. `place`/`params` are opaque host strings; `url` is a host-minted deep link (optional; never sent over the bridge). */
export interface AppLinkV1 { place: string; label: string; params?: Record<string, string>; url?: string }
/** The message a client sends as a NEW user turn. Clients never call tools directly. */
export interface NextStepV1 { label: string; ask: string }
export interface StateReasonV1 { code: string; words: string; fix?: { label: string; appLink?: AppLinkV1; ask?: string } }
export interface ProvenanceV1 { source: string; via: "our_db" | "live_read" | "this_mac" | "server"; verdictsBy?: string }
export interface CostV1 {
  usd: number | null; estimate: boolean;
  whoPays: "infinite" | "your_chatgpt_plan" | "your_google_key" | "none"; reason?: ReasonV1;
}
export type OutcomeV1 = "applied" | "not_sent" | "unknown" | "no_change" | "partial";
/** retryable: certain nothing ran. safe_resend: unknown but the server dedupes. check_first: run reconcile. */
export type RetryV1 = "retryable" | "safe_resend" | "check_first" | "never";
export interface StatusWordV1 { word: string; tone: "ok" | "warn" | "bad" | "muted" }
export interface TruncationV1 { shown: number; total: number | null; reason?: string; more?: NextStepV1 }

export interface ApprovalFieldV1 {
  key: string; label: string; input: "money_per_day" | "choice" | "text"; required: boolean;
  currency?: string; options?: { value: string; label: string }[]; current?: string | null;
}
export type ApprovalFieldAnswerV1 = { text: string } | { choice: string };
export interface ApprovalV1 {
  /** card = host approval with a handle + TTL; operation_managed = the tool asks twice (send `ask`). */
  kind: "card" | "operation_managed";
  turnId?: string; handle?: string;            // card only
  title: string;
  summary: string | null;                      // Cmd+L: title tooltip; terminal: behind "?"
  confirmLabel: string;                        // "Pause", "Lower to $30/day", "Launch 3 ads"
  dismissLabel: string;                        // "Dismiss"
  doneTitle?: string;
  rows: { label: string; value: string }[];    // describePendingWrite
  detailRows?: { label: string; value: string }[];
  effect?: string;                             // "Starts spending", "LIVE theme"
  fields?: ApprovalFieldV1[];
  expiresAt?: IsoTime;
  role?: "owner_admin";
  ask?: string;                                // operation_managed only
  finishInApp?: { words: string; appLink: AppLinkV1 };
}
export interface ReceiptV1 {
  sentence: string; tone: "ok" | "warn"; provenanceLine?: string; revertible: boolean;
  undo?: { label: string; expiresAt: IsoTime; actionRef: string };
}
export interface ReconcileV1 { label: string; ask: string }

// ── bodies ──
/** A picture by reference only (Cmd+L's CreativeThumb reads our archive by id). Never a URL. The terminal ignores it. */
export interface CreativeRefV1 { archiveAssetId: string }
export interface CellV1 { value: number | null; reason?: ReasonV1; untrusted?: true }      // money in MAJOR units; percent in points
export interface TextCellV1 { text: string | null; reason?: ReasonV1; untrusted?: true }
export interface WindowV1 { from: string; to: string; tz: string; label: string }          // YYYY-MM-DD
export type UnitV1 = "money" | "count" | "percent" | "ratio" | "seconds" | "text";
export interface ColumnV1 { key: string; label: string; unit: UnitV1; factGroup: string }  // never combine across factGroups
export type CoverageStatusV1 = "measured" | "partial" | "zero" | "not_measured" | "not_synced"
  | "not_broken_down" | "not_verified" | "unknown_at_this_level";
export interface CoverageV1 { requestedDays: number; measuredDays: number; days: { date: string; status: CoverageStatusV1 }[] }
export interface NumbersRowV1 { id: string; label: string; untrusted?: true; status?: StatusWordV1; cells: Record<string, CellV1 | TextCellV1> }
/** ofPrevious: renderer may print "127 of 176" (both measured); never a %. */
export interface StepV1 { key: string; label: string; count: number | null; reason?: ReasonV1; countingSince?: string; ofPrevious?: true }
/** settled = the leg that excludes today when a today leg exists; `final` false if its window still holds unsettled days. */
export interface NumbersLegV1 {
  window: WindowV1; final: boolean; asOf: IsoTime | null; rows: NumbersRowV1[];
  totals?: Record<string, CellV1>; coverage?: CoverageV1; steps?: StepV1[];
}
export interface TodayLegV1 extends NumbersLegV1 {
  final: false; asOf: IsoTime;
  refresh?: { status: "fresh" | "still_running" | "held" | "failed" | "skipped"; retryAt?: IsoTime };
}
export interface LeaderV1 { measure: { key: string; label: string }; rowId: string; rowLabel: string; value: CellV1 }
export type SectionV1 =
  | { title: string; kind: "numbers"; body: NumbersBodyV1 } | { title: string; kind: "list"; body: ListBodyV1 }
  | { title: string; kind: "record"; body: RecordBodyV1 } | { title: string; kind: "health"; body: HealthBodyV1 };
export interface NumbersBodyV1 {
  layout: "kpis" | "table" | "series" | "steps" | "composite";
  currency: string | null; columns: ColumnV1[];
  legs?: { settled: NumbersLegV1; today?: TodayLegV1 };   // required unless layout === "composite"; legs are NEVER summed
  leaders?: LeaderV1[];                                   // leaders per measure; never one winner without revenue
  sections?: SectionV1[]; verdictSource?: string; truncated?: TruncationV1;   // sections nest ONE level only
}
export interface ListRowV1 {
  id: string; title: string; titleUntrusted?: true; status?: StatusWordV1;
  cells: Record<string, CellV1 | TextCellV1>; detail?: { label: string; value: TextCellV1 }[];
  appLink?: AppLinkV1; url?: string; copy?: string; creativeRef?: CreativeRefV1;
  from?: string | null; to?: string | null; at?: IsoTime; who?: string | null;  // log layout; who null = "who: unknown"
}
export interface ListBodyV1 {
  layout: "rows" | "log" | "groups" | "files";
  columns: { key: string; label: string; unit?: UnitV1 }[]; rows: ListRowV1[];
  groups?: { label: string; reason?: string; rows: ListRowV1[] }[];
  total: number | null; shown: number; filterWords?: string; emptyWords?: string;
  omitted?: { count: number; reason: string }; truncated?: TruncationV1;
}
export interface RecordBodyV1 {
  fields: { label: string; value: CellV1 | TextCellV1; unit?: UnitV1 }[]; creativeRef?: CreativeRefV1;
  history?: { at: IsoTime; from: string | null; to: string | null; who: string | null; source?: string }[];
  rule?: { summary: string; channel: string; schedule: string; nextRunAt: IsoTime | null;
    checkEveryMinutes: number | null; desktopRequired: boolean; version: number };
}
export interface DocumentBodyV1 {
  meta: { label: string; value: string }[];
  sections: { heading?: string; text: string; format: "plain" | "markdown" | "code" | "html_stripped"; language?: string; untrusted?: true }[];
  versions?: { id: string; label: string; slot?: string; locale?: string; sectionIndexes: number[] }[];
  truncated?: { shownChars: number; totalChars: number; editable: boolean };
  liveUrl?: string; savedVerbatim?: boolean;
}
/** No image URLs: the terminal shows rows; Cmd+L mounts its gallery by runId (creative.draft frames). */
export interface ImagesBodyV1 {
  runId: string; requested: number; ready: number; failed: number;
  items: { id: string; label: string; status: "queued" | "drawing" | "done" | "failed"; failureWords?: string; width?: number; height?: number }[];
  format: string; aspectRatio: string; model: string; madeWith: "infinite" | "your_codex";
  eta?: { startedAtMs: number; etaMs: number | null };
}
export interface ChangeBodyV1 {
  target: { kind: string; id?: string; label: string };
  rows: { label: string; before?: string | null; after: string | null; reason?: ReasonV1 }[]; // no `before` = "set to"
  effect?: string; warnings: string[];
  staleBefore?: { label: string; ours: string; live: string };
}
export interface LaunchNodeV1 { level: "campaign" | "adset" | "ad"; name: string; fields: { label: string; value: string }[]; status: string; children: LaunchNodeV1[] }
export interface LaunchBodyV1 {
  tree?: LaunchNodeV1[];
  audience?: { count: number | null; basis: string; excluded: { reason: string; count: number }[];
    fromLine?: string; senderVerified?: boolean; senderHold?: string };
  documents?: { id: string; slot: string; subject: string; bodyText: string }[];
  picturesInApp: boolean;
  results?: { name: string; level: string; id?: string; detail?: string; status: "done" | "failed" | "unknown"; error?: string }[];
  counts?: { done: number; failed: number; unknown: number };
}
export interface JobBodyV1 {
  jobId: string; label: string; phase: "queued" | "running" | "held" | "done" | "failed" | "unknown";
  steps: { id: string; label: string; state: "todo" | "now" | "done" | "failed" | "held"; detail?: string; heldUntil?: IsoTime }[];
  progress?: { finished: number; of: number }; startedAt: IsoTime | null; etaMs?: number;
  runsWhere: "this_mac_app_open" | "this_mac" | "cloud"; outlivesTurn: boolean;
  landsAt?: AppLinkV1; noCompletionSignal: boolean; watch?: NextStepV1;   // watch absent when noCompletionSignal
  autoPublish?: boolean;
  command?: { argv: string[]; exitCode: number | null; signal: string | null;
    endedBy: "exit" | "timeout" | "cancelled"; stdoutTail: string; stderrTail: string; truncated: boolean };
  files?: { name: string; path: string; bytes: number | null }[];
}
export interface CompareBodyV1 {
  window: WindowV1;
  arms: { key: string; label: string; n?: number | null; days?: number | null; metrics: Record<string, CellV1> }[];
  metricRows: { key: string; label: string; unit: UnitV1 }[];
  differences: { label: string; against: string; absolute: CellV1; relative: CellV1;
    interval?: { low: number; high: number; level: number }; method: string }[];
  verdict?: { sentence?: string; grade: "insufficient" | "inconclusive" | "supported"; unmet?: string[]; namesWinner: boolean };
  decomposition?: { before: CellV1; after: CellV1; rateEffect: CellV1; mixEffect: CellV1; segments: { label: string; effect: CellV1 }[] };
  sources?: { source: string; total: CellV1; measuredDays: number; withheldDays: number }[];
  series?: { date: string; values: Record<string, CellV1> }[];
}
export interface HealthBodyV1 {
  items: { id: string; name: string; provider?: string; account?: string;
    state: "ok" | "needs_you" | "blocked" | "unknown" | "error" | "not_connected";
    dataThrough?: string | null; lastSuccessAt?: IsoTime | null; blocker?: string; fix?: { label: string; appLink: AppLinkV1 } }[];
  steps?: { id: string; label: string; state: "done" | "needs_you" | "blocked" | "unreadable" }[];
  resume?: { stepId: string; appLink: AppLinkV1 }; lockedBy?: string;
  scopes?: { granted: string[]; missing: string[]; stale: boolean }; sections?: SectionV1[];
}
export interface LinkBodyV1 {
  target: "url" | "app_place" | "local_file"; minted: boolean; opened: boolean;
  url?: string; shortUrl?: string; finalUrl?: string;
  utm?: Partial<Record<"source" | "medium" | "campaign" | "content" | "term", string>>;
  ga4Channel?: string; warnings: string[];
  appPlace?: AppLinkV1 & { selectionCount?: number }; file?: { name: string; path: string; app?: string };
}
export interface QuietBodyV1 { stepLine: string; degraded?: boolean }

export interface AnswerViewBodies {
  numbers: NumbersBodyV1; list: ListBodyV1; record: RecordBodyV1; document: DocumentBodyV1;
  images: ImagesBodyV1; change: ChangeBodyV1; launch: LaunchBodyV1; job: JobBodyV1;
  compare: CompareBodyV1; health: HealthBodyV1; link: LinkBodyV1; quiet: QuietBodyV1;
}
export interface AnswerViewEnvelopeV1<K extends AnswerViewKind = AnswerViewKind> {
  v: 1; kind: K;                       // chosen per RESULT (args/lane may change it), not per tool name
  tool: string;                        // bare operation name (capability_call unwrapped)
  title: string; explain?: string;     // explain: Cmd+L title tooltip / terminal "?"
  state: AnswerViewState; stateReason?: StateReasonV1;
  outcome?: OutcomeV1; retry?: RetryV1; // writes: explicit, never parsed from messages
  asOf: IsoTime | null; provenance?: ProvenanceV1;
  scope: { workspaceName: string; crossWorkspace: boolean };
  cost?: CostV1; caveats: string[];    // server words, printed verbatim
  next?: NextStepV1[]; appLink?: AppLinkV1; untrusted?: true;
  approval?: ApprovalV1; receipt?: ReceiptV1; reconcile?: ReconcileV1;
  body: AnswerViewBodies[K];
}
export type AnswerViewV1 = { [K in AnswerViewKind]: AnswerViewEnvelopeV1<K> }[AnswerViewKind];

// ── frames + bridge wire ──
export interface ToolViewFrameV1 { type: "tool.view"; stage: "tool"; message: string; viewId: string; name: string; view: AnswerViewV1 }
export interface ActionReceiptFrameV1 { type: "action.receipt"; stage: "tool"; message: string; confirmationHandle: string; view: AnswerViewV1 }
/** creative.draft as the bridge forwards it (allowlisted: no brief, no image URLs). */
export interface CreativeDraftFrameV1 {
  type: "creative.draft"; runId: string; status: "running" | "done" | "error"; count: number;
  format: string; aspectRatio: string; quality: string;
  pending?: { startedAtMs: number; etaMs: number | null }[];
  estimatedPerImageUsd?: number; perImageUsd?: number; error?: { code: string; message: string };
}
export type BridgeAcceptV1 = typeof RESULT_VIEW_CAPABILITY | typeof CONFIRM_STREAM_CAPABILITY;
/** Added to POST /v1/turn: `accept`. Added to POST /v1/confirm: `fields`, `stream`. */
export interface TurnRequestAdditionsV1 { accept?: BridgeAcceptV1[] }
export interface ConfirmRequestAdditionsV1 { fields?: Record<string, ApprovalFieldAnswerV1>; stream?: true }
/** Added to every pending actionCall in `done`, and to the /v1/confirm JSON response. */
export interface ViewAdditionsV1 { view?: AnswerViewV1 }
export interface AppOpenRequestV1 { protocolVersion: 1; place: string; params?: Record<string, string> }
