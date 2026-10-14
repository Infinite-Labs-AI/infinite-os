/**
 * Answer view contract. One typed, cleaned description of one tool result or one pending write,
 * sent by an app host to any renderer. Renderers draw it and never derive new facts from it:
 * no totals across nulls, no % between steps, no sums across legs. Words are DATA in the frame.
 * Key rule: no key may end in "token", contain "credential", or equal a host-private key.
 */
// ---- contract body (vendored verbatim into 1bu-1; edit only in infinite-os) ----
export const ANSWER_VIEW_CONTRACT_REVISION = 6 as const;   // rev 6: the verdict-first card (AnswerViewEnvelopeV1.card); VerdictV1, AgeV1, DeltaV1, BenchmarkV1, QuietLineV1, LaneV1, RankChangeV1, PostV1, CardActionV1; ReasonV1.show "hide"; CellV1.delta/.benchmark; ColumnV1.polarity/.definition/.lane/.bar; row card extras; SectionV1.head; StepV1.lane/.rate/.note/.drop/.verdict/.definition; NumbersBodyV1.lanes/.rankBy/.endToEnd; ListBodyV1.rankBy/.sections; CreativeRefV1.reader/.ratio; DocumentBodyV1.post/.context; ChangeBodyV1.target extras (incl. group)/.context; rev 5: NumbersRowV1.creativeRef; NumbersBodyV1.face; rev 4: ImagesBodyV1.drawRunIds; rev 3: ChangeBodyV1.target.creativeRef + .path; ListBodyV1.nameLabel; RecordBodyV1.status; LeaderV1.detail; AnswerViewEnvelopeV1.scope.account; StateReasonV1.step
export const RESULT_VIEW_CAPABILITY = "result.view.v1" as const;
export const CONFIRM_FIELDS_CAPABILITY = "confirm.fields.v1" as const;
export const CONFIRM_STREAM_CAPABILITY = "confirm.stream.v1" as const;
export const APP_OPEN_CAPABILITY = "app.open.v1" as const;
export const ANSWER_VIEW_LIMITS = {
  maxRows: 200, maxCellChars: 500, maxTextChars: 2_000, maxDocumentChars: 64_000, maxFrameBytes: 262_144,
  // A change target's parents; rev 3. A part longer than maxTargetPathPartChars is cut to it, ending in "…";
  // more than maxTargetPathParts parts (or any part not a string, or empty once cleaned) withholds the whole path.
  maxTargetPathParts: 4, maxTargetPathPartChars: 120,
  // Short host words; rev 3: ListBodyV1.nameLabel, RecordBodyV1.status.word, LeaderV1.detail, StateReasonV1.step. A longer string is cut to
  // maxShortTextChars, ending in "…"; a value not a string, or empty once cleaned, is withheld (the field is dropped);
  // a status whose tone is not one of StatusWordV1's tones is withheld.
  maxShortTextChars: 80,
  // The host's account handles; rev 3: AnswerViewEnvelopeV1.scope.account. Each part matches ARCHIVE_ASSET_ID_PATTERN's
  // character rule and is at most maxHostHandleChars; a part that is bad or missing withholds the whole slot, never half.
  maxHostHandleChars: 128,
  // rev 6: short words (maxShortTextChars) = verdict words, head source/window/chip, quiet line, lane label, rankBy, step note,
  // drop words, action label, pictureWord, group words. Lines (maxCardLineChars, cut with "…") = foot, row note, definition, verdict why,
  // benchmark label/basis, delta anchorLabel. A ruleId follows ARCHIVE_ASSET_ID_PATTERN's character rule.
  // maxCardRows bounds list/table rows only; series legs and funnel steps are exempt (the host cuts and sets TruncationV1).
  maxCardLineChars: 160, maxCardActions: 2, maxGroupPictures: 3, maxCardLogos: 4, maxCardRows: 10,
} as const;
/** rev 3: a CreativeRefV1.archiveAssetId is an archive id: letters, digits and `_ . : -`, at most 128; no '/', never a URL or path.
 *  It never starts with a URL scheme (http, https, javascript, data, mailto, file, blob, vbscript, ftp; any case) and a ':'.
 *  Each letter is spelled in both cases, not with the `i` flag: under `iu` the letter class would also admit U+017F and U+212A. */
export const ARCHIVE_ASSET_ID_PATTERN =
  /^(?![Hh][Tt][Tt][Pp][Ss]?:|[Jj][Aa][Vv][Aa][Ss][Cc][Rr][Ii][Pp][Tt]:|[Dd][Aa][Tt][Aa]:|[Mm][Aa][Ii][Ll][Tt][Oo]:|[Ff][Ii][Ll][Ee]:|[Bb][Ll][Oo][Bb]:|[Vv][Bb][Ss][Cc][Rr][Ii][Pp][Tt]:|[Ff][Tt][Pp]:)[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

/** rev 6: a channel or source a card may name by its logo (16 px, its own colours); never the card's identity. The terminal prints the name. */
export const CHANNEL_LOGOS = [
  "meta", "instagram", "reddit", "youtube", "google_ads", "google", "x", "tiktok", "linkedin",
  "stripe", "posthog", "ga4", "shopify", "email", "site",
] as const;
export type ChannelLogoV1 = (typeof CHANNEL_LOGOS)[number];

/** rev 6: good = green ✓, bad = red ↓, warn = amber ! (needs your OK, over a limit), neutral = no colour (◔ age, ‖ off),
 *  accent = brand ink ▶ for a fact about others. Colour is never the only signal. */
export const VERDICT_TONES = ["good", "bad", "warn", "neutral", "accent"] as const;
export type VerdictToneV1 = (typeof VERDICT_TONES)[number];
/** rev 6: a delta's or benchmark's tone, decided by the HOST from the column's polarity and the direction. */
export type ChangeToneV1 = "good" | "bad" | "flat";

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
/** Why a value is null. show "dash" = "—" + footnote (not measured); "words" = print words in place ("New").
 *  show "hide" (rev 6) = draw nothing: a column, tile or measure whose every value hides is absent from the card. The reason
 *  stays in the view for the text and the model. */
export interface ReasonV1 { code: string; words: string; show?: "dash" | "words" | "hide" }
/** A host place. `place`/`params` are opaque host strings; `url` is a host-minted deep link (optional; never sent over the bridge). */
export interface AppLinkV1 { place: string; label: string; params?: Record<string, string>; url?: string }
/** The message a client sends as a NEW user turn. Clients never call tools directly. */
export interface NextStepV1 { label: string; ask: string }
/** short: the head's words in place of the generic state words ("Changed on Meta", "1 not measured"); words: the full sentence. */
export interface StateReasonV1 {
  code: string; words: string; short?: string; fix?: { label: string; appLink?: AppLinkV1; ask?: string };
  step?: string;  // the Steps row's short word for this state, in host words ("not allowed", "limit"); drawn verbatim, never derived from codes; bounds as maxShortTextChars; rev 3
}
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

// ── card words (rev 6) ──
/** rev 6: a judgement from the host's FIXED rules, never a renderer's. ruleId is never drawn (tests, MCP _meta). mark picks the
 *  neutral glyph: "age" ◔, "off" ‖ or "none" (Unproven, Few results); ignored for other tones. why = the rule in one plain
 *  line (expand, ⓘ, text). */
export interface VerdictV1 { words: string; tone: VerdictToneV1; ruleId: string; why?: string; mark?: "age" | "off" | "none" }
/** rev 6: how long the thing has run (settled account days since first delivery, inclusive) and the HOST's gate. tooYoung =
 *  its verdict, if any, is neutral, and no benchmark or delta on it carries a tone. censored = it may be older (storedFrom). */
export interface AgeV1 { days: number; since: string; tooYoung: boolean; censored?: true }
/** rev 6: change against a named earlier period, computed by the host. value null needs its reason. */
export interface DeltaV1 { value: number | null; unit: "percent" | "same"; anchorLabel: string; tone: ChangeToneV1; reason?: ReasonV1 }
/** rev 6: what a value is judged against. basis = how the host got it. kind goal exists only when the owner set one. */
export interface BenchmarkV1 { value: number; kind: "usual" | "best" | "worst" | "goal"; label: string; basis: string; tone: ChangeToneV1 }
/** rev 6: a thing with nothing to show draws as ONE line ("Paused · last spent Oct 9"): no zeros, no table. */
export interface QuietLineV1 { code: string; words: string }
/** rev 6: where a measure is counted. A rate never crosses two lanes. */
export interface LaneV1 { key: string; label: string; logo?: ChannelLogoV1 }
export interface RankChangeV1 { dir: "up" | "down" | "same" | "new"; by?: number }

/** rev 6: a card action (≤ maxCardActions on the card, at most one primary; a row carries at most one secondary, shown in its
 *  expand). confirm/dismiss exist only with `approval`. next sends NextStepV1.ask as a new turn. open goes to an app place (a
 *  mount without the app opens the https link). copy copies `text` verbatim. expand = fullscreen where offered, else open folds. */
export type CardActionV1 = { role: "primary" | "secondary" } & (
  | { do: "confirm" } | { do: "dismiss" }
  | { do: "next"; label: string; step: NextStepV1 }
  | { do: "open"; label: string; appLink: AppLinkV1 }
  | { do: "copy"; label: string; text: string }
  | { do: "expand"; label: string }
);

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
/** rev 6: what a verdict-first card shows on a row beyond its numbers. All host words. The terminal prints verdict, quietLine, age. */
export interface RowCardExtrasV1 {
  rawName?: string;            // the code when label/title is the human part; expand only
  rank?: number;               // the host's order under the body's rankBy; never a renderer sort
  rankChange?: RankChangeV1;
  age?: AgeV1;
  verdict?: VerdictV1;         // the row's chip; when present it wins over `status` (status moves to the expand)
  quietLine?: QuietLineV1;     // the row draws as this one line, does not tap, and its cells are not drawn
  logo?: ChannelLogoV1;        // the row's picture when it is a channel, not an object
  note?: string;               // one sentence on expand
  pictureWord?: string;        // the word an empty picture box shows ("Video", "Ad group")
  group?: { count: number; words: string; pictures?: CreativeRefV1[] };   // the host folded `count` things into this row; words = the host's words for them ("15 ads", "4 videos")
  emphasis?: true;             // the host's marked row (the day the title names); at most one per body
  labelled?: true;             // a series row whose day label is drawn (host's choice, T4); the renderer never decides it
  action?: CardActionV1;       // one secondary action inside the expand ("Clone this ad", "Open on the desktop")
}

/** A picture by reference only (Cmd+L's CreativeThumb reads our archive by id), never a URL. reader: which archive holds it
 *  (Cmd+L picks its reader by it; the MCP picture tool too). ratio: the fixed box it is drawn in (cover). The terminal ignores
 *  it. rev 6: reader, ratio. */
export interface CreativeRefV1 {
  archiveAssetId: string;      // an archive id (ARCHIVE_ASSET_ID_PATTERN): never a URL or path; rev 3
  reader?: "meta_archive" | "reddit_ads" | "youtube" | "competitor";   // rev 6
  ratio?: "1:1" | "4:5" | "9:16" | "16:9" | "1.91:1";                  // rev 6
}
/** tone "bad": the host flags this value as the one to look at ("0 trials"); renderers draw it in the warn colour. rev 2 */
export interface CellV1 {
  value: number | null; reason?: ReasonV1; untrusted?: true; tone?: "bad";   // money in MAJOR units; percent in points
  delta?: DeltaV1;             // rev 6
  benchmark?: BenchmarkV1;     // rev 6
}
export interface TextCellV1 { text: string | null; reason?: ReasonV1; untrusted?: true; tone?: "bad" }
export interface WindowV1 { from: string; to: string; tz: string; label: string }          // YYYY-MM-DD
export type UnitV1 = "money" | "count" | "percent" | "ratio" | "seconds" | "text";
export interface ColumnV1 {
  key: string; label: string; unit: UnitV1; factGroup: string;   // never combine across factGroups
  polarity?: "up_good" | "down_good" | "neutral";  // rev 6
  definition?: string;                             // rev 6
  lane?: string;                                   // a key of the body's lanes; rev 6
  bar?: true;                                      // a bar behind each row's value, scaled to the largest drawn value (geometry; prints nothing); rev 6
}
export type CoverageStatusV1 = "measured" | "partial" | "zero" | "not_measured" | "not_synced"
  | "not_broken_down" | "not_verified" | "unknown_at_this_level";
export interface CoverageV1 { requestedDays: number; measuredDays: number; days: { date: string; status: CoverageStatusV1 }[] }
export interface NumbersRowV1 extends RowCardExtrasV1 {
  id: string; label: string; untrusted?: true; status?: StatusWordV1; cells: Record<string, CellV1 | TextCellV1>;
  creativeRef?: CreativeRefV1;   // the row's picture (an ad's creative, a video's still), by archive reference (never a URL); Cmd+L draws it before the row's name; the terminal ignores it; rev 5
  face?: string[];             // this row's own face, overriding the body's (Meta "link clicks", YouTube "clicks"); rev 6
}
/** ofPrevious: may print "127 of 176" (both measured, same lane). rate (rev 6): the HOST's percent of the previous step, same
 *  lane only, never computed by a renderer. Bar width may be scaled from counts (geometry). */
export interface StepV1 {
  key: string; label: string; count: number | null; reason?: ReasonV1; countingSince?: string; ofPrevious?: true;
  lane?: string; rate?: number; note?: string;
  drop?: { words: string; tone: "bad" | "neutral" };
  verdict?: VerdictV1; definition?: string;        // rev 6
}
/** settled = the leg that excludes today when a today leg exists; `final` false if its window still holds unsettled days. */
export interface NumbersLegV1 {
  window: WindowV1; final: boolean; asOf: IsoTime | null; rows: NumbersRowV1[];
  totals?: Record<string, CellV1>; coverage?: CoverageV1; steps?: StepV1[];
}
export interface TodayLegV1 extends NumbersLegV1 {
  final: false; asOf: IsoTime;
  refresh?: { status: "fresh" | "still_running" | "held" | "failed" | "skipped"; retryAt?: IsoTime };
}
export interface LeaderV1 {
  measure: { key: string; label: string }; rowId: string; rowLabel: string; value: CellV1;
  detail?: string;  // one short context line from the host, drawn under the leader's name ("$12.34 spent", "5 of 40 impressions"); words are data, never computed by a renderer; rev 3
}
/** rev 6: a section drawn as one row that taps open; folded = drawn closed. */
export interface SectionHeadV1 { logo?: ChannelLogoV1; verdict?: VerdictV1; quietLine?: QuietLineV1; age?: AgeV1; face?: string[]; folded?: true }
export type SectionV1 = (
  | { title: string; kind: "numbers"; body: NumbersBodyV1 } | { title: string; kind: "list"; body: ListBodyV1 }
  | { title: string; kind: "record"; body: RecordBodyV1 } | { title: string; kind: "health"; body: HealthBodyV1 }
) & { head?: SectionHeadV1 };                             // head: rev 6
export interface NumbersBodyV1 {
  layout: "kpis" | "table" | "series" | "steps" | "composite";
  currency: string | null; columns: ColumnV1[];
  rowLabel?: string;                                      // the row-label column's header ("Campaign"); rev 2
  face?: string[];                                        // the row face: column keys a compact row shows, in order (the question's ask); the rest stay on the row's hover; Cmd+L draws it, the terminal ignores it; rev 5
  legs?: { settled: NumbersLegV1; today?: TodayLegV1 };   // required unless layout === "composite"; legs are NEVER summed
  leaders?: LeaderV1[];                                   // leaders per measure; never one winner without revenue
  sections?: SectionV1[]; verdictSource?: string; truncated?: TruncationV1;   // sections nest ONE level only
  lanes?: LaneV1[]; rankBy?: string;                                        // rev 6
  endToEnd?: { value: number; fromKey: string; toKey: string; words: string }; // the HOST's start-to-finish %, one lane; rev 6
}
export interface ListRowV1 extends RowCardExtrasV1 {
  id: string; title: string; titleUntrusted?: true; status?: StatusWordV1;
  cells: Record<string, CellV1 | TextCellV1>; detail?: { label: string; value: TextCellV1 }[];
  appLink?: AppLinkV1; url?: string; copy?: string; creativeRef?: CreativeRefV1;
  from?: string | null; to?: string | null; at?: IsoTime; who?: string | null;  // log layout; who null = "who: unknown"
}
export interface ListBodyV1 {
  layout: "rows" | "log" | "groups" | "files";
  nameLabel?: string;  // the row-name column's header ("Ad", "Ad set", "Campaign"); rev 3
  currency?: string | null;                               // money cells' currency; rev 2
  selected?: string;                                      // the row id the list opens on (the one the answer is about); rev 2
  columns: { key: string; label: string; unit?: UnitV1 }[]; rows: ListRowV1[];
  groups?: { label: string; reason?: string; rows: ListRowV1[] }[];
  total: number | null; shown: number; filterWords?: string; emptyWords?: string;
  omitted?: { count: number; reason: string }; truncated?: TruncationV1;
  rankBy?: string; sections?: SectionV1[];                // sections nest ONE level only; rev 6
}
export interface RecordBodyV1 {
  title?: string; currency?: string | null;               // the thing's full name ("Ad “Demo B · sample copy”"); money's currency; rev 2
  status?: StatusWordV1;  // the thing's own status for the head chip ("Active" ok, "Paused" muted); rev 3
  fields: { label: string; value: CellV1 | TextCellV1; unit?: UnitV1 }[]; creativeRef?: CreativeRefV1;
  history?: { at: IsoTime; from: string | null; to: string | null; who: string | null; source?: string }[];
  rule?: { summary: string; channel: string; schedule: string; nextRunAt: IsoTime | null;
    checkEveryMinutes: number | null; desktopRequired: boolean; version: number };
}
/** rev 6: a social post as it will read. chars and overflowAt are counted by the network's own rule, by the host. */
export interface PostV1 {
  network: "x" | "linkedin" | "threads" | "instagram";
  author: { name: string; handle: string; picture?: CreativeRefV1 };
  chars: number; limit: { max: number; basis: string }; overflowAt?: number;  // overflowAt: a UTF-16 index into the text
}
export interface DocumentBodyV1 {
  meta: { label: string; value: string }[];
  sections: { heading?: string; text: string; format: "plain" | "markdown" | "code" | "html_stripped"; language?: string; untrusted?: true }[];
  versions?: { id: string; label: string; slot?: string; locale?: string; sectionIndexes: number[] }[];
  truncated?: { shownChars: number; totalChars: number; editable: boolean };
  liveUrl?: string; savedVerbatim?: boolean;
  post?: PostV1; context?: SectionV1[];                   // rev 6
}
/** No image URLs: the terminal shows rows; Cmd+L mounts its gallery by runId (creative.draft frames). */
export interface ImagesBodyV1 {
  runId: string; requested: number; ready: number; failed: number;
  items: { id: string; label: string; status: "queued" | "drawing" | "done" | "failed"; failureWords?: string; width?: number; height?: number }[];
  format: string; aspectRatio: string; model: string; madeWith: "infinite" | "your_codex";
  eta?: { startedAtMs: number; etaMs: number | null };
  drawRunIds?: string[];           // a run made of other runs (a clone: one draw per source): their ids, which the chat gallery's frames carry; host-only; the terminal ignores it; rev 4
}
export interface ChangeBodyV1 {
  target: {
    kind: string; id?: string; label: string;
    creativeRef?: CreativeRefV1;   // the target's picture, by archive reference (never a URL); the terminal ignores it; rev 3
    path?: string[];               // the target's parents, outermost first (["Campaign", "Ad set"]); bounds in ANSWER_VIEW_LIMITS; rev 3
    rawName?: string; age?: AgeV1; verdict?: VerdictV1; pictureWord?: string;
    group?: { count: number; words: string; pictures?: CreativeRefV1[] };   // rev 6 extras; group = a parent's children (≤ maxGroupPictures); words as on a row ("15 ads")
  };
  rows: { label: string; before?: string | null; after: string | null; reason?: ReasonV1 }[]; // no `before` = "set to"
  effect?: string; warnings: string[];
  staleBefore?: { label: string; ours: string; live: string };
  context?: SectionV1[];       // rev 6
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
  armLabel?: string;                                      // the arm column's header ("Version"); rev 2
  arms: { key: string; label: string; n?: number | null; days?: number | null; metrics: Record<string, CellV1>;
    interval?: { metric: string; low: number; high: number; level: number } }[];   // the arm's likely range for `metric`; rev 2
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

/** rev 6: present = drawn as ONE verdict-first card: head → verdict → (figure) → title (+ explain as ⓘ) → proof → ≤5 rows (+
 *  Show N more) → sections → foot → actions. Words are host data. The terminal prints verdict, figure and foot. */
export interface CardFaceV1 {
  head: { source: string; logos?: ChannelLogoV1[]; window?: string; chip?: { words: string; tone: VerdictToneV1 } };
  verdict?: VerdictV1;
  figure?: { value: CellV1 | TextCellV1; unit: UnitV1; currency?: string | null; words: string; delta?: DeltaV1; benchmark?: BenchmarkV1 };
  proof: "object" | "funnel" | "days" | "shares" | "figure" | "tiles" | "rows";
  foot?: string;
  actions?: CardActionV1[];
}

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
  scope: {
    workspaceName: string; crossWorkspace: boolean;
    account?: { project: string; source: string };   // the host's opaque handles for the workspace and the connected source the numbers came from, so a redraw or re-read of an OLD answer uses its own account, never the one selected now; each part matches ARCHIVE_ASSET_ID_PATTERN's character rule, at most maxHostHandleChars (128); a bad or missing part withholds the whole slot; host-only; the terminal ignores it; a public bridge may drop it; rev 3
  };
  cost?: CostV1; caveats: string[];    // server words, printed verbatim
  next?: NextStepV1[]; appLink?: AppLinkV1; untrusted?: true;
  approval?: ApprovalV1; receipt?: ReceiptV1; reconcile?: ReconcileV1;
  body: AnswerViewBodies[K];
  card?: CardFaceV1;                   // rev 6: present = drawn as a verdict-first card; absent = drawn as before
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
