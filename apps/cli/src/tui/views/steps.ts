// The Steps strip (terminal-r4 `frame()`, spec §5 "Steps strip"): one row per
// tool call of the turn, under a `─ Steps ───` rule:
//
//   ␣␣<label padded to label_w> <offset><bar ━━━, or ━━╍╍ while running>  <glyph> <result>
//
// - label_w = min(28, W − 34) under 80 cols, else min(28, ⌊0.26·W⌋); the result
//   column is 22 wide; the bar's column takes the rest (gantt_w, at least 4).
// - Each bar sits on the turn's own timeline: it starts at the call's start and
//   is as long as the call ran, scaled to gantt_w (a Gantt chart).
// - The bar is `dim` once done, `red` when it failed, `cyan` otherwise; the
//   glyph takes its tone (✓ green, ▣ amber, ⠋ cyan, ✗ red, ? amber, · dim, ⟳ cyan,
//   ◐ amber, ⧗ amber); the result is `dim`.
// - The label is the app's own words for the call when its frames carry them
//   (`step.words.v1`), else generic words made from the tool's name. Never a
//   raw tool id, and never its JSON arguments.
// - A call that waits for the person's OK is `▣` (amber), never `✓`; with no
//   result of its own it says `waiting for your OK` (`waiting for an answer`
//   when it asked a question instead).
// - Once its card is answered, a row that waited takes its words from the
//   card: a row labelled `waiting for your OK` says what is being done
//   (`pausing 1 ad`), and its result is `running`, then how the card ended
//   (`done`, `dismissed`, `not sent`).
// - A failed (✗) call always says something: its reason, else `failed`.
// - A failed (✗) or unknown (?) call whose reason was cut to the result column
//   prints the whole reason on dim rows under it, indented 4.
import type { AnswerViewState, AnswerViewV1 } from "@infinite-os/types";

import { isDisplayWords, type StepWords } from "../../desktop/step-words.js";
import type { StepStatus, TurnStep } from "../app/turn-store.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { compactPreview, defuseTrailStructure, parseToolTrailResultLine, splitToolDuration } from "../lib/text.js";
import { ansi, type Theme, type ThemeStyle } from "../theme.js";
import type { Msg } from "../types.js";
import { shortOkVerb } from "../keys/keymap.js";
import { viewText, wrapText } from "./primitives.js";
import { isChangedOnProvider, stateHeadFor } from "./states.js";

/** r4's result column. */
const RESULT_WIDTH = 22;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_MS = 80;

/** The glyph and its tone for each status (the bar's tone is separate: see `barTone`). */
const GLYPHS: Readonly<Record<StepStatus, { glyph: string; tone: ThemeStyle }>> = {
  ok: { glyph: "✓", tone: "green" },
  wait: { glyph: "▣", tone: "amber" },
  run: { glyph: "⠋", tone: "cyan" },
  fail: { glyph: "✗", tone: "red" },
  unk: { glyph: "?", tone: "amber" },
  off: { glyph: "·", tone: "dim" },
  bg: { glyph: "⟳", tone: "cyan" },
  part: { glyph: "◐", tone: "amber" },
  old: { glyph: "⧗", tone: "amber" },
  stopped: { glyph: "■", tone: "dim" }
};

/** What a waiting step says when the call gave no result of its own (r4's own step label for it). */
export const WAITING_WORDS = "waiting for your OK";
/** What a step says when it waits for an answer to a question, not for an OK. */
export const WAITING_ANSWER_WORDS = "waiting for an answer";

/** The label column: min(28, W − 34) under 80 cols, else min(28, 26% of W). Never under 4. */
export function stepLabelWidth(width: number): number {
  const total = Math.max(1, Math.floor(width));
  return Math.max(4, total < 80 ? Math.min(28, total - RESULT_WIDTH - 12) : Math.min(28, Math.floor(total * 0.26)));
}

/** The bar column: what is left after the label, the result and the gaps (at least 4). */
export function stepGanttWidth(width: number): number {
  return Math.max(4, Math.floor(width) - stepLabelWidth(width) - RESULT_WIDTH - 6);
}

// ── labels ──

/** A tool name without its MCP server prefix (`mcp__infinite_app__get_report` → `get_report`). */
export function bareToolName(name: string): string {
  const parts = name.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : name;
}

/** Verbs whose -ing form is not the regular one (a doubled consonant, a dropped e). */
const GERUNDS: Readonly<Record<string, string>> = {
  get: "getting", set: "setting", run: "running", put: "putting", stop: "stopping", plan: "planning", ship: "shipping",
  tag: "tagging", log: "logging", map: "mapping", scan: "scanning", pin: "pinning", see: "seeing", be: "being"
};

function gerund(verb: string): string {
  const known = GERUNDS[verb];
  if (known) return known;
  if (verb.endsWith("ing")) return verb;
  if (verb.length > 2 && verb.endsWith("e") && !verb.endsWith("ee")) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

/** Words a step label leads with that read as a verb (the rest stay as written). */
const VERBS = new Set([
  "get", "list", "search", "query", "find", "fetch", "read", "check", "count", "compare", "propose", "create", "update",
  "delete", "pause", "resume", "activate", "send", "draft", "generate", "make", "write", "save", "open", "set", "run",
  "start", "stop", "prepare", "price", "schedule", "publish", "sync", "analyze", "analyse", "describe", "explain",
  "launch", "load", "lookup", "look", "build", "plan", "score", "rank", "summarize", "summarise", "track", "verify",
  "validate", "import", "export", "upload", "download", "connect", "disconnect", "approve", "decline", "estimate"
]);

/** Names a step keeps capitalised once its tool id is lower-cased (terminal-r4: `checking Google Ads`, `waiting for your OK`). */
const PROPER_NOUNS: Readonly<Record<string, string>> = {
  meta: "Meta", ga4: "GA4", posthog: "PostHog", stripe: "Stripe", shopify: "Shopify", ok: "OK", x: "X", i: "I",
  google: "Google", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube",
  linkedin: "LinkedIn", reddit: "Reddit", gsc: "GSC", codex: "Codex", chatgpt: "ChatGPT", cmd: "Cmd"
};

/** `google ads` is one name: Ads keeps its capital after Google. */
function properNouns(words: string[]): string[] {
  return words.map((word, index) => {
    if (word === "ads" && words[index - 1] === "google") return "Ads";
    return PROPER_NOUNS[word] ?? word;
  });
}

/** A label that is already words ("checking Google Ads"), not a tool id: spaces and no underscores. */
function isWords(text: string): boolean {
  return /\s/u.test(text) && !/_/u.test(text);
}

/**
 * A name without anything that follows it as call arguments or JSON
 * (`List Rows("…")`, `run query {"a":1}`, `rows [1,2]`): a label never prints
 * them. Brackets that hold words stay (`making 3 creatives (Codex)`).
 */
function withoutArguments(text: string): string {
  // Cut at the first quote, brace or bracket, with one `(` before it (what
  // `\s*(?:\(\s*)?["{[].*$` removed), without a backtracking regex.
  const at = text.search(/["{[]/u);
  if (at < 0) return text.trim();
  const head = text.slice(0, at).trimEnd();
  return (head.endsWith("(") ? head.slice(0, -1) : head).trim();
}

/** A tool id's words: the MCP prefix off, split (snake, kebab, dots, camelCase), lower case. */
function toolIdWords(text: string): string[] {
  return bareToolName(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.:/-]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * A tool's name as plain words, nothing added: the MCP prefix off, split,
 * lower case (`mcp__app__list_sample_rows` → `list sample rows`). For a
 * sentence that brings its own verb (`drafting list sample rows…`).
 */
export function plainToolWords(name: string): string {
  return toolIdWords(withoutArguments(viewText(name))).join(" ") || "tool";
}

/**
 * A friendly step label, for a call the app sent no words for. A label that
 * is already words stays exactly as written (`checking Google Ads`, `waiting
 * for your OK`). A tool id is humanised: the MCP prefix off, words split
 * (snake, kebab, dots, camelCase), lower case except the names that keep a
 * capital (Google Ads, Meta, GA4, PostHog, Stripe, Shopify, OK, X, I), and a
 * leading verb as its -ing form:
 * `mcp__infinite_app__list_meta_entities` → `listing Meta entities`.
 * Call arguments and JSON after the name are never part of the label.
 */
export function friendlyStepLabel(name: string): string {
  // A name is provider-chosen: it never forges a measured duration (`(9.9s)`) or the trail's ` :: ` separator.
  const text = defuseTrailStructure(withoutArguments(viewText(name)));
  if (!text) return "tool";
  if (isWords(text)) return text;
  const words = toolIdWords(text);
  if (!words.length) return "tool";
  if (VERBS.has(words[0]!)) words[0] = gerund(words[0]!);
  return properNouns(words).join(" ");
}

// ── a call's outcome, from its `tool.complete` frame ──

/** A tool call's status, as the Steps strip draws it, from what the transport reported. */
export function stepStatusOf(status: string | undefined): StepStatus {
  switch (status) {
    case "error":
    case "too_expensive":
      return "fail";
    // Waiting for the person's OK (or their answer): pending, not finished.
    case "requires_confirmation":
    case "needs_clarification":
      return "wait";
    case "unsupported":
    case "not_implemented":
      return "off";
    case "low_coverage":
      return "part";
    case "queued":
      return "bg";
    default:
      return "ok";
  }
}

/** Text the transport sent as a result, when it reads as words: scrubbed, one line, never JSON. */
function resultWords(value: string | undefined): string {
  const text = viewText(value);
  return text && !/^[{[]/u.test(text) ? compactPreview(text, 72) : "";
}

/** What a failed call says when the transport gave no reason that reads as words. */
export const FAILED_WORDS = "failed";

/**
 * Why a call failed, as words. A reason that is already words is used as it
 * is. A JSON error object is never printed, but the short message it carries
 * is (`message`, `error`, `error.message`, `reason`, `detail`), scrubbed like
 * any other words. "" when there is none.
 */
function failureWords(value: string | undefined): string {
  const plain = resultWords(value);
  if (plain || typeof value !== "string") return plain;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "";
  }
  const field = (record: unknown, key: string): unknown =>
    typeof record === "object" && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>)[key] : undefined;
  const nested = field(parsed, "error");
  const said = [field(parsed, "message"), nested, field(nested, "message"), field(parsed, "reason"), field(parsed, "detail")]
    .find((item): item is string => typeof item === "string" && item.trim() !== "");
  return said ? resultWords(said) : "";
}

/**
 * A finished call's status and one-line result. With the app's words
 * (`step.words.v1`) the result is the app's, or nothing when it sent none:
 * the transport's raw summary never stands in for it. A failure with no
 * worded result keeps the transport's reason, so why it failed stays readable;
 * with no reason at all it still says `failed`, never a bare ✗.
 * A call that asked a question (`needs_clarification`) and has no result of
 * its own says it waits for an answer: a question is not an approval.
 */
export function toolOutcome(input: {
  status?: string;
  error?: string;
  summary?: string;
  words?: StepWords | null;
}): { status: StepStatus; result: string } {
  const status = input.error ? "fail" : stepStatusOf(input.status);
  const reason = failureWords(input.error || (status === "fail" ? input.summary : undefined));
  const asked = input.status === "needs_clarification" && status === "wait" ? WAITING_ANSWER_WORDS : "";
  const failed = status === "fail" ? reason || FAILED_WORDS : "";
  if (input.words) {
    return { status, result: input.words.result ?? (status === "fail" ? failed : asked) };
  }
  return { status, result: failed || resultWords(input.summary) || asked };
}

/** A running call's latest progress, when it reads as words (`1 of 3`); "" for JSON, an id, arguments or nothing. */
export function stepProgressWords(preview: string | undefined): string {
  const text = viewText(preview);
  return text && isDisplayWords(text) && !looksLikeArguments(text) ? compactPreview(text, 72) : "";
}

/**
 * Call arguments, not words (run-2 M6: `level=ad, nameContains…`): a
 * `key=value` pair or a camelCase identifier. A person's words have neither.
 */
function looksLikeArguments(text: string): boolean {
  return hasKeyEquals(text) || /\b[a-z]+[A-Z][A-Za-z]*\b/u.test(text);
}

/**
 * A `key=value` pair: an `=` after optional spaces and a run of word or dot
 * characters holding a letter or `_`. A scan back from each `=` (never a
 * backtracking regex: CodeQL js/polynomial-redos); it stops at the previous
 * `=`, so the whole check is linear.
 */
function hasKeyEquals(text: string): boolean {
  for (let at = text.indexOf("="); at !== -1; at = text.indexOf("=", at + 1)) {
    let index = at - 1;
    while (index >= 0 && /\s/u.test(text[index]!)) index -= 1;
    let keyed = false;
    while (index >= 0 && /[\w.]/u.test(text[index]!)) {
      if (/[A-Za-z_]/u.test(text[index]!)) keyed = true;
      index -= 1;
    }
    if (keyed) return true;
  }
  return false;
}

/**
 * A reason written for a developer, never shown to a person (run-2 M6: `Use a
 * half-open UTC day window { start, end } as YYYY-MM-DD…`): code punctuation
 * (braces, brackets, angle brackets, backticks, `=`), a date or time format
 * pattern, a code identifier (snake_case, camelCase, a call `f()`), or an
 * error class or code.
 */
export function isDeveloperText(text: string): boolean {
  return /[{}[\]<>`=\\|]/u.test(text)
    || /\b(?:YYYY|YY|MM|DD|HH|mm|ss)(?:[-/:](?:YYYY|YY|MM|DD|HH|mm|ss))+\b/u.test(text)
    || /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/u.test(text)
    || /\b[a-z]+[A-Z][A-Za-z]*\b/u.test(text)
    || /\w\(\)/u.test(text)
    || /\b(?:[A-Z][a-z]+)?Error\b|\bE[A-Z]{4,}\b|\bundefined\b|\bnull\b|\bNaN\b/u.test(text);
}

/** The base form of a step's leading -ing verb (`checking` → `check`, `making` → `make`, `getting` → `get`); null when none. */
function baseVerb(word: string): string | null {
  const known = Object.entries(GERUNDS).find(([, ing]) => ing === word)?.[0];
  if (known) return known;
  if (!word.endsWith("ing") || word.length < 5) return null;
  const stem = word.slice(0, -3);
  return [stem, `${stem}e`].find((candidate) => VERBS.has(candidate)) ?? null;
}

/**
 * Why a call failed, in words a person reads (run-2 M6): the reason as it is
 * when it is plain words; else what the step could not do, from its own
 * label (`checking subscriptions` → `couldn't check subscriptions`); else
 * `failed`. Never the developer's error.
 */
export function plainFailureReason(reason: string, label: string): string {
  const said = viewText(reason);
  if (said && said !== FAILED_WORDS && !isDeveloperText(said)) return said;
  const [first = "", ...rest] = viewText(label).split(/\s+/u).filter(Boolean);
  const verb = baseVerb(first.toLowerCase());
  return verb && rest.length ? `couldn't ${[verb, ...rest].join(" ")}` : FAILED_WORDS;
}

// ── steps from the trail (when the turn store has none: old transports, the one-shot path) ──

/**
 * Steps from a turn's tool trail lines. The trail carries durations, not start
 * times, so the calls are laid end to end in the order they finished. A stopped
 * call (`■ … · stopped`) keeps its row.
 */
export function stepsFromTrail(messages: readonly Msg[]): TurnStep[] {
  let clock = 0;
  return messages
    .filter((msg) => msg.kind === "trail")
    .flatMap((msg) => msg.tools ?? [])
    .flatMap((line, index): TurnStep[] => {
      const parsed = parseToolTrailResultLine(line);
      if (!parsed) {
        const stopped = /^■ (.*) · stopped$/u.exec(line);
        if (!stopped) return [];
        const label = trailLabel(stopped[1]!);
        return [{ id: `trail_${index}`, name: label, label, status: "stopped", startedAt: clock, endedAt: clock, result: "stopped" }];
      }
      const { label, duration } = splitToolDuration(parsed.call ?? "");
      const seconds = Number(/\(([\d.]+)s\)/u.exec(duration)?.[1] ?? 0);
      const startedAt = clock;
      clock += Number.isFinite(seconds) ? seconds * 1000 : 0;
      const friendly = trailLabel(label);
      return [{
        id: `trail_${index}`, name: friendly, label: friendly,
        status: parsed.mark === "✗" ? "fail" : parsed.mark === "▣" ? "wait" : "ok",
        startedAt, endedAt: clock, result: viewText(parsed.detail)
      }];
    });
}

/**
 * A trail line's call (`List Meta Entities("…")`) as a friendly label: no
 * arguments. The trail capitalises every word of a tool id, so a call whose
 * words are not ALL capitalised was already words (`Waiting for your OK`):
 * it keeps them, only its first letter lowered back. A tool id is humanised;
 * an MCP tool's trail label has lost where its server name ends (`Mcp
 * Infinite App List Meta Entities`), so it starts at the first verb when
 * there is one.
 */
function trailLabel(call: string): string {
  const name = viewText(call).replace(/\("(?:[^"\\]|\\.)*"\)$/u, "").trim();
  if (/\s/u.test(name) && name.split(/\s+/u).some((word) => /^[a-z]/u.test(word))) {
    // The trail capitalised the first letter only: lower it back, unless the word is a name (`Meta`, `GA4`).
    const [first = "", ...rest] = name.split(" ");
    return [PROPER_NOUNS[first.toLowerCase()] ?? `${first.charAt(0).toLowerCase()}${first.slice(1)}`, ...rest].join(" ");
  }
  let words = name.split(/\s+/u).filter(Boolean);
  if (words[0] === "Mcp") {
    const verb = words.findIndex((word, index) => index > 0 && VERBS.has(word.toLowerCase()));
    words = verb > 0 ? words.slice(verb) : words.slice(1);
  }
  return friendlyStepLabel(words.join("_"));
}

// ── statuses from the turn's views ──

/** What a view's state says about the call that made it, when the call itself only said "done". */
const STATE_STATUS: Partial<Record<AnswerViewState, StepStatus>> = {
  partial: "part",
  out_of_date: "old",
  outcome_unknown: "unk",
  background: "bg",
  needs_yes: "wait",
  needs_answer: "wait",
  failed: "fail",
  blocked: "fail",
  hit_limit: "fail",
  no_change: "off",
  not_connected: "off",
  expired: "off",
  cancelled: "off",
  cmdl_only: "off"
};

/**
 * The Steps status a view stands for (needs_yes → ▣, partial → ◐, …); null =
 * the call's own. A write that never left because the thing had changed on
 * the provider is out of date (⧗, r4 `pausing on Meta ⧗ changed`): no
 * transport status says that, the view does.
 */
export function stepStatusForView(view: Pick<AnswerViewV1, "state" | "outcome" | "stateReason">): StepStatus | null {
  if (isChangedOnProvider(view)) return "old";
  if (isOutcomeUnknown(view)) return "unk";
  return STATE_STATUS[view.state] ?? null;
}

/**
 * The view a call drew (matched by bare tool name), when it can be told.
 * Several calls of one tool (`pause these 2`) each follow their own view,
 * paired in order: the turn's nth such call drew the nth view of that tool.
 * That holds only when there are as many such calls as views; with `steps`
 * absent, or the counts apart, there is no telling which view is whose. A
 * failed or stopped call drew none.
 */
function viewDrawnBy(step: TurnStep, views: readonly AnswerViewV1[], steps: readonly TurnStep[]): AnswerViewV1 | undefined {
  if (!canFollowView(step)) return undefined;
  const matches = views.filter((view) => drewView(step, view));
  if (!matches.length) return undefined;
  // The calls that could have drawn these views: a failed or stopped call drew none.
  const calls = steps.filter((other) => canFollowView(other) && matches.some((view) => drewView(other, view)));
  return calls.length === matches.length ? matches[calls.indexOf(step)] : undefined;
}

/**
 * A finished call's status, refined by the view it drew (`viewDrawnBy`): a
 * call whose view is partial is ◐, out of date ⧗, and so on. A call that
 * waits for the person's OK follows its card the same way: working (⠋) once
 * the yes is sent, then done, dismissed (·) or failed. A call with no view,
 * or one whose view cannot be told, keeps its own status.
 */
export function refineStepStatus(
  step: TurnStep,
  views: readonly AnswerViewV1[],
  steps: readonly TurnStep[] = [step]
): StepStatus {
  if (refusedReadView(step, views, steps)) return "off";
  const settled = failedCallSettledBy(step, views, steps);
  if (settled) return settled.status;
  const view = viewDrawnBy(step, views, steps);
  if (!view) return step.status;
  if (step.status === "wait" && (view.state === "applying" || view.state === "working")) return "run";
  return stepStatusForView(view) ?? "ok";
}

/**
 * The states of a read that did not run here for a reason that is not a
 * failure: the source is not connected, or only Cmd+L can do it. The desktop
 * reports such a refused read as a failed call (`status: "error"`), so only
 * its view can say it (TJ-10, r4 flow-numbers-05 `· not connected`).
 */
const REFUSED_READ_STATES: ReadonlySet<string> = new Set(["not_connected", "cmdl_only"]);

/**
 * The one view that stands for a failed call, when it says the read was
 * refused rather than failed (`REFUSED_READ_STATES`): exactly one view of the
 * call's tool and exactly one call of it in the turn, so there is no doubt
 * whose view it is. Else undefined, and the call keeps its own ✗.
 */
function refusedReadView(step: TurnStep, views: readonly AnswerViewV1[], steps: readonly TurnStep[]): AnswerViewV1 | undefined {
  if (step.status !== "fail") return undefined;
  const matches = views.filter((view) => drewView(step, view));
  if (matches.length !== 1 || !REFUSED_READ_STATES.has(matches[0]!.state)) return undefined;
  return steps.filter((other) => drewView(other, matches[0]!)).length === 1 ? matches[0] : undefined;
}

/**
 * The words a refused call says (r4's step rows `✗ not allowed` and `✗ limit`).
 * The host decides the word and sends it as `stateReason.step` (rev 3): it is
 * drawn as sent, never derived from codes. With none sent, a view that hit a
 * limit says `limit`; a blocked one says its head's short words (`needs your
 * OK`), else its plain state word (`blocked`). A blocked view is not always a
 * refusal (an address waiting for the person's OK, a thing that cannot be
 * changed), so `not allowed` is said only when the host said it. A frame
 * carries no refusal code and the transport's own words for a refusal are
 * generic (`didn't go through`), so the view wins. Never parsed out of text.
 */
function refusalWords(view: AnswerViewV1): string | undefined {
  const step = typeof view.stateReason?.step === "string" ? viewText(view.stateReason.step) : "";
  if (step) return step;
  if (view.state === "hit_limit") return LIMIT_STEP_WORDS;
  return view.state === "blocked" ? viewRowWords(view) : undefined;
}

/** What a row says when its view hit a limit and the host sent no word of its own. */
const LIMIT_STEP_WORDS = "limit";

/**
 * The one view that stands for a call: the view it drew (`viewDrawnBy`), else,
 * for a failed call, exactly one view of its tool with exactly one call of it
 * in the turn, so there is no doubt whose view it is.
 */
function viewStandingFor(step: TurnStep, views: readonly AnswerViewV1[], steps: readonly TurnStep[]): AnswerViewV1 | undefined {
  const drawn = viewDrawnBy(step, views, steps);
  if (drawn || step.status !== "fail") return drawn;
  const matches = views.filter((view) => drewView(step, view));
  if (matches.length !== 1) return undefined;
  return steps.filter((other) => drewView(other, matches[0]!)).length === 1 ? matches[0] : undefined;
}

/**
 * Whether a view says no one knows if its write landed: an outcome-unknown
 * state, or a failed one whose outcome is unknown. Never `✗` (failed / not
 * sent): the write may have landed, and a retry could send it twice.
 */
function isOutcomeUnknown(view: Pick<AnswerViewV1, "state" | "outcome">): boolean {
  return view.state === "outcome_unknown" || (view.state === "failed" && view.outcome === "unknown");
}

/**
 * A failed call whose one standing view (`viewStandingFor`) says something
 * other than a failure: the write may have landed (`?`), or there was nothing
 * to change (`·`). The desktop bridge sends an uncertain write as a failed
 * call (`status: "error"` with a "not sure" summary), so only its view can
 * say it was not a failure. Else undefined, and the call keeps its own ✗.
 */
function failedCallSettledBy(
  step: TurnStep,
  views: readonly AnswerViewV1[],
  steps: readonly TurnStep[]
): { view: AnswerViewV1; status: "unk" | "off" } | undefined {
  if (step.status !== "fail") return undefined;
  const view = viewStandingFor(step, views, steps);
  if (!view) return undefined;
  if (isOutcomeUnknown(view)) return { view, status: "unk" };
  return view.state === "no_change" ? { view, status: "off" } : undefined;
}

/** A view's state words for a Steps row: its head's words, and an unknown outcome says it is not sure, whatever its state. */
function viewRowWords(view: AnswerViewV1): string {
  return resultCase(stateHeadFor(isOutcomeUnknown(view) ? { ...view, state: "outcome_unknown" } : view).words);
}

/** The statuses a view refines a finished call to that carry no words of their own: the row says its view's (never a lone mark). */
const VIEW_WORDED: ReadonlySet<StepStatus> = new Set<StepStatus>(["unk", "off", "part", "old"]);

/** What a row that waited says while its card is being applied (r4 `pausing on Meta ⠋ running`). */
const APPLYING_WORDS = "running";

/**
 * What a row that waited for an OK is doing once the OK is given (r4: `waiting
 * for your OK` becomes `pausing on Meta`): what it waited for, when that
 * starts with a verb (`pause 1 ad` → `pausing 1 ad`, `send to 214` → `sending
 * to 214`), else the card's own OK label's verb (`Launch 3 ads` →
 * `launching`). Null when neither names it: the row keeps its label.
 */
function appliedLabel(waitedFor: string, view: AnswerViewV1): string | null {
  const [first = "", ...rest] = waitedFor.split(/\s+/u).filter(Boolean);
  if (VERBS.has(first.toLowerCase())) {
    return [gerund(first.toLowerCase()), ...rest].join(" ");
  }
  const approval = view.approval as { confirmLabel?: unknown } | undefined;
  const okLabel = typeof approval?.confirmLabel === "string" ? viewText(approval.confirmLabel) : "";
  const verb = okLabel ? shortOkVerb(okLabel) : "";
  return verb && VERBS.has(verb) ? gerund(verb) : null;
}

/** A state head's words as a row's result: the first letter lowered, unless the word is a name (`Meta`, `GA4`). */
function resultCase(words: string): string {
  const first = words.split(/\s+/u)[0] ?? "";
  if (!first || PROPER_NOUNS[first.toLowerCase()] === first || first.slice(1) !== first.slice(1).toLowerCase()) {
    return words;
  }
  return `${first.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/** What a row that waited for an OK says once the app proved its card never left. */
export const NOT_SENT_STEP_WORDS = "not sent";

/**
 * The steps once the app refused a card before anything ran (its `notSent`
 * mark, no receipt view): the one call of the card's tool that waited for an
 * OK is `✗ not sent` (S4), so its row never stays `▣` after the receipt line
 * says `✗ Not sent`. Two waiting calls of the tool cannot be told apart, and no
 * waiting call has nothing to settle: the steps stay as they are.
 */
export function settleNotSentStep<S extends readonly TurnStep[]>(steps: S, tool: string): S | TurnStep[] {
  const waiting = steps.filter((step) => step.status === "wait" && drewView(step, { tool }));
  if (waiting.length !== 1) return steps;
  return steps.map((step): TurnStep => (step === waiting[0] ? { ...step, status: "fail", result: NOT_SENT_STEP_WORDS } : step));
}

/** Only a call that finished, or waits for the person, has a view to follow. */
function canFollowView(step: TurnStep): boolean {
  return step.status === "ok" || step.status === "wait";
}

/**
 * Whether the view is of the step's tool. A step read back from the tool trail
 * has lost its tool id: there its friendly label stands for it.
 */
function drewView(step: TurnStep, view: Pick<AnswerViewV1, "tool">): boolean {
  return bareToolName(view.tool) === bareToolName(step.name) || friendlyStepLabel(view.tool) === step.label;
}

// ── drawing ──

export interface StepStripOptions {
  width: number;
  color: boolean;
  theme: Theme;
  /** Now (epoch ms): where a running call's bar ends, and its spinner frame. */
  nowMs?: number;
  /** The turn's views: a finished call's status follows the view it drew. */
  views?: readonly AnswerViewV1[];
}

/** The `─ Steps ───` rule: `line`, with `Steps` in `b`. */
export function stepHeader(width: number, options: { color: boolean; theme: Theme }): string {
  const total = Math.max(1, Math.floor(width));
  const paint = (text: string, tone: ThemeStyle) => (options.color ? ansi(options.theme, tone, text) : text);
  if (total < 8) return paint("─".repeat(total), "line");
  return `${paint("─", "line")} ${paint("Steps", "b")} ${paint("─".repeat(total - 8), "line")}`;
}

/** The Steps strip: the header and one row per call. No calls, no strip. */
export function stepStripLines(steps: readonly TurnStep[], options: StepStripOptions): string[] {
  const rows = stepRowLines(steps, options);
  return rows.length ? [stepHeader(options.width, options), ...rows] : [];
}

/** What one call's row says: its status (after its view), glyph, tone, label and result words. */
function stepRowFacts(step: TurnStep, steps: readonly TurnStep[], options: Pick<StepStripOptions, "views" | "nowMs">) {
  const now = options.nowMs ?? Date.now();
  const view = viewDrawnBy(step, options.views ?? [], steps);
  const status = refineStepStatus(step, options.views ?? [], steps);
  const { glyph, tone } = GLYPHS[status];
  const mark = status === "run" ? SPINNER[Math.floor(Math.max(0, now - step.startedAt) / SPINNER_MS) % SPINNER.length]! : glyph;
  const said = viewText(step.result);
  const refused = refusedReadView(step, options.views ?? [], steps);
  if (refused) {
    // A refused read says what its view says (`· not connected`), never the transport's failure words.
    return { status, mark, tone, label: viewText(step.label), result: resultCase(stateHeadFor(refused).words) };
  }
  const settled = failedCallSettledBy(step, options.views ?? [], steps);
  if (settled) {
    // A failed call whose view says it may have landed, or changed nothing, says what its view says (`? not sure it happened`), never the transport's failure words.
    return { status, mark, tone, label: viewText(step.label), result: viewRowWords(settled.view) };
  }
  if (step.status === "wait" && view && status !== "wait") {
    // The card it waited on has moved on: the row says what is being done, then how the card ended.
    const acted = status !== "off" && viewText(step.label) === WAITING_WORDS ? appliedLabel(said, view) : null;
    return {
      status, mark, tone,
      label: acted ?? viewText(step.label),
      result: status === "run" ? APPLYING_WORDS : viewRowWords(view)
    };
  }
  const standing = viewStandingFor(step, options.views ?? [], steps);
  const refusal = status === "fail" && standing ? refusalWords(standing) : undefined;
  if (refusal) {
    // A refused call says the host's step word for its view (`✗ not allowed`, `✗ limit`, `✗ needs your OK`).
    return { status, mark, tone, label: viewText(step.label), result: refusal };
  }
  // A step still waiting says so (unless its label already does); a failed one says why in plain words.
  const result = status === "fail"
    ? plainFailureReason(said, viewText(step.label))
    : said || (status === "wait" && viewText(step.label) !== WAITING_WORDS
      // A view that asks a question waits for an answer, not for an OK (TJ-10).
      ? (view?.state === "needs_answer" ? WAITING_ANSWER_WORDS : WAITING_WORDS)
      // Never a lone mark: a row its view refined (?, ·, ◐, ⧗) with no words of its own says its view's (`not sure it happened`, `nothing to change`, `4 of 5 days in`).
      : view && VIEW_WORDED.has(status) ? viewRowWords(view) : "");
  return { status, mark, tone, label: viewText(step.label), result };
}

/** The Steps strip's rows, one per call, without the header. */
export function stepRowLines(steps: readonly TurnStep[], options: StepStripOptions): string[] {
  if (!steps.length) return [];
  const width = Math.max(1, Math.floor(options.width));
  const now = options.nowMs ?? Date.now();
  const labelWidth = stepLabelWidth(width);
  const gantt = stepGanttWidth(width);
  const t0 = Math.min(...steps.map((step) => step.startedAt));
  const endOf = (step: TurnStep) => (step.endedAt ?? Math.max(now, step.startedAt));
  const span = Math.max(0.001, Math.max(...steps.map(endOf)) - t0);
  const paint = (text: string, tone: ThemeStyle) => (options.color && text ? ansi(options.theme, tone, text) : text);

  const rows = steps.flatMap((step) => {
    const { status, mark, tone, label: words, result } = stepRowFacts(step, steps, { ...options, nowMs: now });
    const a = Math.round(((step.startedAt - t0) / span) * gantt);
    const b = Math.max(1, Math.round(((endOf(step) - step.startedAt) / span) * gantt));
    const running = status === "run" || status === "bg";
    const bar = (running ? `${"━".repeat(Math.max(1, b - 2))}╍╍` : "━".repeat(b)).slice(0, Math.max(1, gantt - a));
    const barTone: ThemeStyle = status === "ok" ? "dim" : status === "fail" ? "red" : status === "stopped" ? "dim" : "cyan";
    const label = padEndCells(cut(words, labelWidth), labelWidth);
    const segments: (readonly [string, ThemeStyle])[] = [
      [`  ${label} ${" ".repeat(a)}`, "text"],
      [bar, barTone],
      [`${" ".repeat(Math.max(0, gantt - a - bar.length))} `, "text"],
      [mark, tone],
      [result ? ` ${result}` : "", "dim"]
    ];
    return rowWithReason(segments, status, result, width, paint);
  });
  return rows;
}

/**
 * One row, cut to the width. Why a call failed must stay readable: a reason
 * cut short is printed whole on dim rows under the call, indented 4 (ok rows
 * stay one row, as r4).
 */
function rowWithReason(
  segments: readonly (readonly [string, ThemeStyle])[],
  status: StepStatus,
  result: string,
  width: number,
  paint: (text: string, tone: ThemeStyle) => string
): string[] {
  const row = fitSegments(segments, width, paint);
  const cutShort = segments.reduce((sum, [text]) => sum + displayWidth(text), 0) > width;
  if (!result || !cutShort || (status !== "fail" && status !== "unk")) {
    return [row];
  }
  return [row, ...wrapText(result, Math.max(1, width - 4)).map((line) => `    ${paint(line, "dim")}`)];
}

/**
 * The statuses a turn printed into scrollback keeps a row for. The Steps strip
 * belongs to the live turn (D1), but a call that did not end clean must stay
 * readable once its turn is committed: failed (✗), no outcome came back (?),
 * the thing had changed (⧗), or an OK still unanswered (▣).
 */
const UNSETTLED: ReadonlySet<StepStatus> = new Set<StepStatus>(["fail", "unk", "old", "wait"]);

/**
 * The rows a committed turn keeps under its answer: one per call that did not
 * end clean, in call order, as the Steps strip words it but without the bar
 * (`  reading today ✗ not synced yet`). The labels are padded to the longest,
 * so the glyphs sit in one column. Clean calls (✓, ·, ◐, ⟳) are dropped: no
 * header and no rows when every call ended clean.
 */
export function unsettledStepLines(steps: readonly TurnStep[], options: StepStripOptions): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const paint = (text: string, tone: ThemeStyle) => (options.color && text ? ansi(options.theme, tone, text) : text);
  const kept = steps
    .map((step) => stepRowFacts(step, steps, options))
    .filter((facts) => UNSETTLED.has(facts.status));
  const labelWidth = Math.min(stepLabelWidth(width), Math.max(0, ...kept.map((facts) => displayWidth(facts.label))));
  return kept.flatMap(({ status, mark, tone, label, result }) => rowWithReason([
    [`  ${padEndCells(cut(label, labelWidth), labelWidth)} `, "text"],
    [mark, tone],
    [result ? ` ${result}` : "", "dim"]
  ], status, result, width, paint));
}

/** r4 `trunc()` for one string: past the width, cut to width − 1 and `…`. */
function cut(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  for (const char of Array.from(text)) {
    if (displayWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** Paint segments, cutting the first one that does not fit to its room − 1 and `…` (r4 `trunc()`), and dropping the rest. */
function fitSegments(
  segments: readonly (readonly [string, ThemeStyle])[],
  width: number,
  paint: (text: string, tone: ThemeStyle) => string
): string {
  let used = 0;
  let out = "";
  for (const [text, tone] of segments) {
    const size = displayWidth(text);
    if (used + size <= width) {
      out += tone === "text" ? text : paint(text, tone);
      used += size;
      continue;
    }
    const room = width - used;
    if (room > 0) out += tone === "text" ? cut(text, room) : paint(cut(text, room), tone);
    break;
  }
  return out;
}
