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
// - The label is a friendly name for the call, never a raw tool id or its JSON.
// - A failed (✗) or unknown (?) call whose reason was cut to the result column
//   prints the whole reason on dim rows under it, indented 4.
import type { AnswerViewState, AnswerViewV1 } from "@infinite-os/types";

import type { StepStatus, TurnStep } from "../app/turn-store.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { parseToolTrailResultLine, splitToolDuration } from "../lib/text.js";
import { ansi, type Theme, type ThemeStyle } from "../theme.js";
import type { Msg } from "../types.js";
import { viewText, wrapText } from "./primitives.js";

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
 * A friendly step label. A label that is already words stays exactly as
 * written (`checking Google Ads`, `waiting for your OK`). A tool id is
 * humanised: the MCP prefix off, words split (snake, kebab, dots, camelCase),
 * lower case except the names that keep a capital (Google Ads, Meta, GA4,
 * PostHog, Stripe, Shopify, OK, X, I), and a leading verb as its -ing form:
 * `mcp__infinite_app__list_meta_entities` → `listing Meta entities`.
 */
export function friendlyStepLabel(name: string): string {
  const text = viewText(name).trim();
  if (isWords(text)) return text;
  const words = bareToolName(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.:/-]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (!words.length) return "tool";
  if (VERBS.has(words[0]!)) words[0] = gerund(words[0]!);
  return properNouns(words).join(" ");
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
        id: `trail_${index}`, name: friendly, label: friendly, status: parsed.mark === "✗" ? "fail" : "ok",
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
    return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
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

/** The Steps status a view's state stands for (needs_yes → ▣, partial → ◐, …); null = the call's own. */
export function stepStatusForView(view: Pick<AnswerViewV1, "state">): StepStatus | null {
  return STATE_STATUS[view.state] ?? null;
}

/**
 * A finished call's status, refined by the one view it drew (matched by bare
 * tool name): a call whose view is partial is ◐, out of date ⧗, and so on. A
 * call with no view, or with two views of the same tool, keeps its own status.
 */
export function refineStepStatus(step: TurnStep, views: readonly AnswerViewV1[]): StepStatus {
  if (step.status !== "ok") return step.status;
  const bare = bareToolName(step.name);
  // A step read back from the tool trail has lost its tool id: its friendly label stands for it.
  const matches = views.filter((view) => bareToolName(view.tool) === bare || friendlyStepLabel(view.tool) === step.label);
  return matches.length === 1 ? STATE_STATUS[matches[0]!.state] ?? "ok" : "ok";
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
    const status = refineStepStatus(step, options.views ?? []);
    const a = Math.round(((step.startedAt - t0) / span) * gantt);
    const b = Math.max(1, Math.round(((endOf(step) - step.startedAt) / span) * gantt));
    const running = status === "run" || status === "bg";
    const bar = (running ? `${"━".repeat(Math.max(1, b - 2))}╍╍` : "━".repeat(b)).slice(0, Math.max(1, gantt - a));
    const barTone: ThemeStyle = status === "ok" ? "dim" : status === "fail" ? "red" : status === "stopped" ? "dim" : "cyan";
    const { glyph, tone } = GLYPHS[status];
    const mark = status === "run" ? SPINNER[Math.floor(Math.max(0, now - step.startedAt) / SPINNER_MS) % SPINNER.length]! : glyph;
    const label = padEndCells(cut(viewText(step.label), labelWidth), labelWidth);
    const result = viewText(step.result);
    const segments: (readonly [string, ThemeStyle])[] = [
      [`  ${label} ${" ".repeat(a)}`, "text"],
      [bar, barTone],
      [`${" ".repeat(Math.max(0, gantt - a - bar.length))} `, "text"],
      [mark, tone],
      [result ? ` ${result}` : "", "dim"]
    ];
    const row = fitSegments(segments, width, paint);
    // Why a call failed must stay readable: a reason cut to the result column
    // is printed whole on dim rows under the call (ok rows stay one row, as r4).
    const cutShort = segments.reduce((sum, [text]) => sum + displayWidth(text), 0) > width;
    if (!result || !cutShort || (status !== "fail" && status !== "unk")) {
      return [row];
    }
    return [row, ...wrapText(result, Math.max(1, width - 4)).map((line) => `    ${paint(line, "dim")}`)];
  });
  return rows;
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
