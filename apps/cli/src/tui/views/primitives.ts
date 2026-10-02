// Shared drawing primitives for the answer-view renderers: scrubbed text,
// cells (a null is a dash with a footnote, never 0), footnotes, colour, wrap,
// and the shell lines every view gets (head, source, state reason,
// explanation, truncation, caveats). Pure; everything here is generic chrome,
// and every word from a view arrives as data.
import type {
  AnswerViewV1,
  CellV1,
  StatusWordV1,
  TextCellV1,
  UnitV1
} from "@infinite-os/types";
import wrapAnsi from "wrap-ansi";

import { terminalText } from "../../desktop/terminal-text.js";
import { displayWidth, truncateCells } from "../lib/display-width.js";
import type { Tone } from "../style/tokens.js";
import { ansi, ansiSpan, colorEnabled, type AnsiRole, type Theme, type ThemeStyle } from "../theme.js";
import { stateHeadFor, type StateTone } from "./states.js";
import type { ViewRenderCtx } from "./types.js";

/** One line of scrubbed view text: control, escape and bidi characters gone, whitespace collapsed. */
export function viewText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? terminalText(value, fallback) : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

export function superscript(n: number): string {
  return String(Math.max(0, Math.floor(n)))
    .split("")
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)] ?? "")
    .join("");
}

/**
 * Footnotes for one view. A null shown as a dash gets a superscript mark, and
 * its reason prints once below the view. The same words share one mark.
 */
export class FootnoteBook {
  private readonly notes: string[] = [];

  /** The mark for these words (scrubbed); "" when there are no words to note. */
  mark(words: unknown): string {
    const text = viewText(words);
    if (!text) {
      return "";
    }
    let index = this.notes.indexOf(text);
    if (index < 0) {
      this.notes.push(text);
      index = this.notes.length - 1;
    }
    return superscript(index + 1);
  }

  get size(): number {
    return this.notes.length;
  }

  lines(): string[] {
    return this.notes.map((words, index) => `${superscript(index + 1)} ${words}`);
  }
}

/** The dash a null prints as. Never 0: an unknown number is not a zero. */
export const NULL_DASH = "—";

/**
 * One cell as text. Numbers format by unit (money in major units, percent in
 * points). A null prints its reason: in place for `show: "words"` ("New"),
 * otherwise as `—` plus a footnote mark. A null with no reason, or a missing
 * cell, is a bare `—`. All text is scrubbed.
 */
export function cellText(
  cell: CellV1 | TextCellV1 | null | undefined,
  unit: UnitV1,
  currency: string | null,
  notes: FootnoteBook
): string {
  if (!isRecord(cell)) {
    return NULL_DASH;
  }
  if ("value" in cell) {
    const value = cell.value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return formatValue(value, unit, currency);
    }
    return nullText(cell.reason, notes);
  }
  if ("text" in cell && typeof cell.text === "string") {
    return viewText(cell.text);
  }
  return nullText(cell.reason, notes);
}

function nullText(reason: unknown, notes: FootnoteBook): string {
  if (!isRecord(reason)) {
    return NULL_DASH;
  }
  const words = viewText(reason.words);
  if (!words) {
    return NULL_DASH;
  }
  if (reason.show === "words") {
    return words;
  }
  return `${NULL_DASH}${notes.mark(words)}`;
}

const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, build: () => Intl.NumberFormat): Intl.NumberFormat {
  let format = NUMBER_FORMATS.get(key);
  if (!format) {
    format = build();
    NUMBER_FORMATS.set(key, format);
  }
  return format;
}

const plainNumber = (digits: number) =>
  numberFormat(`plain:${digits}`, () => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }));

/** A measured number, by unit. Money is in major units; percent is in points. */
export function formatValue(value: number, unit: UnitV1, currency: string | null): string {
  switch (unit) {
    case "money":
      return formatMoney(value, currency);
    case "percent":
      return `${plainNumber(2).format(value)}%`;
    case "seconds":
      return formatSeconds(value);
    case "count":
    case "ratio":
    case "text":
    default:
      return plainNumber(2).format(value);
  }
}

export function formatMoney(value: number, currency: string | null): string {
  const code = typeof currency === "string" ? viewText(currency).toUpperCase() : "";
  if (/^[A-Z]{3}$/u.test(code)) {
    try {
      return numberFormat(`money:${code}`, () =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: code })
      ).format(value);
    } catch {
      // An unknown ISO code: print the number with the code beside it.
    }
  }
  const amount = numberFormat("money:plain", () =>
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  ).format(value);
  return code ? `${amount} ${code}` : amount;
}

/** `45 s`, `2:03`, `1:02:03`. */
export function formatSeconds(value: number): string {
  const sign = value < 0 ? "-" : "";
  const total = Math.round(Math.abs(value));
  if (total < 60) {
    return `${sign}${total} s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${sign}${minutes}:${seconds}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * A time from a view: `Jan 15` for a date, `Jan 15, 10:40` for an instant (in
 * `timeZone`, else the system zone). Anything unparseable prints scrubbed, as is.
 */
export function formatAsOf(value: unknown, timeZone?: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (date) {
    const month = MONTHS[Number(date[2]) - 1];
    const day = Number(date[3]);
    return month && day >= 1 && day <= 31 ? `${month} ${day}` : viewText(value) || null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return viewText(value) || null;
  }
  const parts = instantParts(ms, timeZone) ?? instantParts(ms, "UTC");
  return parts ? `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute}` : viewText(value) || null;
}

function instantParts(ms: number, timeZone: string | undefined) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return { month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
  } catch {
    return null;
  }
}

/**
 * The theme role for a tone (r4): ok green, ask (needs you) bold amber, warn
 * amber, bad red, busy cyan, muted dim, cmdl_only bold blue.
 */
export function toneRole(tone: StateTone | StatusWordV1["tone"] | Tone): AnsiRole {
  switch (tone) {
    case "ok":
      return "success";
    case "ask":
      return "ask";
    case "warn":
      return "warning";
    case "bad":
      return "error";
    case "busy":
      return "primary";
    case "cmdl_only":
      return "cmdl";
    case "muted":
    default:
      return "muted";
  }
}

/**
 * Paint a span in a role or r4 tokens (and optionally bold or invert it) at
 * the theme's tier, ending it with specific resets (never `0m`), so a span
 * inside a chip leaves the chip's background on. Plain when colour is off.
 */
export function paint(
  text: string,
  role: ThemeStyle,
  ctx: { color: boolean; theme: Theme },
  options: { bold?: boolean; inverse?: boolean } = {}
): string {
  if (!ctx.color || !text) {
    return text;
  }
  if ((!options.bold && !options.inverse) || !colorEnabled(ctx.theme)) {
    return ansi(ctx.theme, role, text);
  }
  const span = ansiSpan(ctx.theme, role);
  const on = `${options.bold ? "\u001b[1m" : ""}${options.inverse ? "\u001b[7m" : ""}`;
  const off = [options.bold ? "22" : "", options.inverse ? "27" : ""].filter(Boolean).join(";");
  return `${span.open}${on}${text}\u001b[${off}m${span.close}`;
}

/** Fit one line to `width` cells (a safety net: renderers lay out to width first). */
export function fitLine(line: string, width: number): string {
  const max = Math.max(1, Math.floor(width));
  return displayWidth(line) <= max ? line : truncateCells(line, max);
}

/** Word-wrap scrubbed text to `width`, hard-breaking words that are too long. */
export function wrapText(text: string, width: number): string[] {
  if (!text) {
    return [];
  }
  return wrapAnsi(text, Math.max(1, Math.floor(width)), { hard: true, trim: true }).split("\n");
}

/** Wrap and colour a paragraph of view words. */
function paragraph(text: string, role: AnsiRole, ctx: ViewRenderCtx): string[] {
  return wrapText(text, ctx.width).map((line) => paint(line, role, ctx));
}

// ── the shell: lines every view gets, whatever its kind ──

/**
 * The head, as r4 draws it: the title as an inverse chip (` Title `), one
 * space, then the state head. Without colour the chip cannot show, so the
 * title prints bare with two spaces before the state. One line.
 */
export function headLine(view: AnswerViewV1, ctx: ViewRenderCtx): string {
  const head = stateHeadFor(view);
  const state = `${head.glyph} ${head.words}`;
  const title = viewText(view.title);
  const width = Math.max(1, Math.floor(ctx.width));
  if (!title) {
    return paint(fitLine(state, width), toneRole(head.tone), ctx);
  }
  const chipPad = ctx.color ? 2 : 0;
  const room = width - displayWidth(state) - 2 - chipPad;
  if (room < 4) {
    return fitLine(`${title}  ${state}`, width);
  }
  const shown = fitLine(title, room);
  const chip = ctx.color ? paint(` ${shown} `, "text", ctx, { bold: true, inverse: true }) : shown;
  return `${chip}${ctx.color ? " " : "  "}${paint(state, toneRole(head.tone), ctx)}`;
}

/** `<provenance.source> · up to <asOf>`, or null when the view says neither. */
export function sourceLine(view: AnswerViewV1, ctx: ViewRenderCtx): string | null {
  const provenance = isRecord(view.provenance) ? view.provenance : null;
  const source = viewText(provenance?.source);
  const asOf = formatAsOf(view.asOf, ctx.timeZone);
  const parts = [source, asOf ? `up to ${asOf}` : ""].filter(Boolean);
  return parts.length ? paint(fitLine(parts.join(" · "), ctx.width), "muted", ctx) : null;
}

/** The explanation, only once `?` opened it. */
export function explainLines(view: AnswerViewV1, ctx: ViewRenderCtx): string[] {
  return ctx.explainOpen ? paragraph(viewText(view.explain), "muted", ctx) : [];
}

/**
 * The state's specifics, in the head's tone, and how to fix it when a key can
 * act on the fix: `o` opens its app link (when the session can open the app),
 * or Enter sends its ask (`fixAskBound`: the view has no row asks). A fix no
 * key can act on is not printed, so it never reads like an action.
 */
export function stateReasonLines(view: AnswerViewV1, ctx: ViewRenderCtx, fixAskBound = false): string[] {
  const reason = isRecord(view.stateReason) ? view.stateReason : null;
  if (!reason) {
    return [];
  }
  const lines = paragraph(viewText(reason.words), toneRole(stateHeadFor(view).tone), ctx);
  const fix = isRecord(reason.fix) ? reason.fix : null;
  const label = viewText(fix?.label);
  const opens = ctx.caps.open && isRecord(fix?.appLink);
  if (label && (opens || (fixAskBound && stateFixAsk(view) !== null))) {
    lines.push(...paragraph(`→ ${label}${opens ? " (o)" : ""}`, "muted", ctx));
  }
  return lines;
}

/** The state's fix ask (a NEW user turn), when the view offers one. */
export function stateFixAsk(view: AnswerViewV1): string | null {
  const reason = isRecord(view.stateReason) ? view.stateReason : null;
  const fix = reason && isRecord(reason.fix) ? reason.fix : null;
  return turnAsk(fix?.ask);
}

/**
 * An ask a view key may send: a NEW user turn, never a command. An ask is
 * host data (part of it can come from tool results), so one that starts with
 * `/` (`/exit`, `/connect …`) is dropped rather than run as a slash command.
 */
export function turnAsk(value: unknown): string | null {
  const text = viewText(value).trim();
  return text && !text.startsWith("/") ? text : null;
}

/** `shown of total · reason · m for more`, for the kinds whose bodies page (numbers, list). */
export function truncationLines(view: AnswerViewV1, ctx: ViewRenderCtx): string[] {
  if (view.kind !== "numbers" && view.kind !== "list") {
    return [];
  }
  const truncated = isRecord(view.body) && isRecord(view.body.truncated) ? view.body.truncated : null;
  if (!truncated || typeof truncated.shown !== "number" || !Number.isFinite(truncated.shown)) {
    return [];
  }
  const count = plainNumber(0);
  const total = typeof truncated.total === "number" && Number.isFinite(truncated.total) ? truncated.total : null;
  const parts = [
    total === null ? `${count.format(truncated.shown)} shown` : `${count.format(truncated.shown)} of ${count.format(total)}`,
    viewText(truncated.reason),
    truncatedMoreAsk(view) ? "m for more" : ""
  ].filter(Boolean);
  return paragraph(parts.join(" · "), "muted", ctx);
}

/** The ask `m` sends for more rows (a NEW user turn), when the view offers one. */
export function truncatedMoreAsk(view: AnswerViewV1): string | null {
  const body = isRecord(view.body) ? view.body : null;
  const truncated = body && isRecord(body.truncated) ? body.truncated : null;
  const more = truncated && isRecord(truncated.more) ? truncated.more : null;
  return viewText(more?.ask) || null;
}

/** The server's caveats, word for word (scrubbed). */
export function caveatLines(view: AnswerViewV1, ctx: ViewRenderCtx): string[] {
  const caveats: unknown[] = Array.isArray(view.caveats) ? view.caveats : [];
  return caveats.flatMap((caveat) => paragraph(viewText(caveat), "muted", ctx));
}
