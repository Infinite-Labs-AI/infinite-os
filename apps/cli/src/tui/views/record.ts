// The record view (terminal-r4 "Record"): one thing's fields as `label  value`
// (a null is a dash with a footnote, never 0), its history (`when  from → to ·
// by who`, a null who is `who: unknown`), an alert rule's schedule, and the
// view's next steps as selectable rows (Enter sends the ask as a NEW turn).
// A `creativeRef` is a picture: the terminal never draws one. The thing's own
// `status` (rev 3) leads its name line, drawn the way a list row's status is.
import type { CellV1, StatusWordV1, TextCellV1 } from "@infinite-os/types";

import { displayWidth } from "../lib/display-width.js";
import { cellText, fitLine, formatAsOf, FootnoteBook, isRecord, paint, toneRole, viewText, wrapText } from "./primitives.js";
import {
  bodyOf,
  changeText,
  clampIndex,
  countOf,
  formatCount,
  labelColumnWidth,
  labelValueLines,
  nextSteps,
  recordsOf,
  rowLine,
  section,
  unitOf,
  whoText
} from "./things.js";
import type { KindRenderer, ViewRenderCtx } from "./types.js";

/** Record labels pad to at least this many cells, so the values start where r4's do. */
const RECORD_LABEL_CELLS = 12;
/** The name never gets narrower than this beside the status; narrower, the status takes its own line. */
const MIN_NAME_CELLS = 12;
const GAP = "  ";
const STATUS_TONES: ReadonlySet<string> = new Set<StatusWordV1["tone"]>(["ok", "warn", "bad", "muted"]);

export const renderRecord: KindRenderer<"record"> = (view, ctx) => {
  const body = bodyOf(view);
  const notes = new FootnoteBook();
  const steps = nextSteps(view);
  const selected = clampIndex(ctx.selected, steps.length);
  const lines: string[] = [];

  // r4: the thing's full name in bold first (`Ad “Demo B · sample copy”`), when the view gives it,
  // after its own status (`● Paused  `, rev 3) in the status tone.
  const head = headLines(viewText(body.title), statusWord(body.status), ctx);
  if (head.length) {
    lines.push(...head, "");
  }
  const currency = typeof body.currency === "string" ? body.currency : null;
  const fields = recordsOf(body.fields).map((field) => {
    const value = isRecord(field.value) ? (field.value as unknown as CellV1 | TextCellV1) : null;
    const fallback = value && "text" in value ? "text" : "count";
    return { label: viewText(field.label), value: cellText(value, unitOf(field.unit, fallback), currency, notes) };
  }).filter((field) => field.label !== "" || field.value !== "");
  // r4 lines the values up in one column, 14 in (labels padded to 12, then two spaces).
  const labelWidth = Math.max(Math.min(RECORD_LABEL_CELLS, Math.floor(ctx.width * 0.4)), labelColumnWidth(fields.map((field) => field.label), ctx.width));
  for (const field of fields) {
    lines.push(...labelValueLines(field.label, field.value, labelWidth, ctx));
  }

  section(lines, historyLines(body.history, ctx));
  section(lines, ruleLines(body.rule, ctx));
  section(lines, nextLines(steps, selected, ctx));

  return {
    detail: lines,
    footnotes: notes.lines(),
    keys: [],
    okKey: null,
    rowCount: steps.length,
    rowAsks: steps.map((step) => step.ask)
  };
};

/** The record's own status (rev 3), when it has a word and one of the contract's tones. */
function statusWord(value: unknown): { word: string; tone: StatusWordV1["tone"] } | null {
  if (!isRecord(value) || typeof value.tone !== "string" || !STATUS_TONES.has(value.tone)) return null;
  const word = viewText(value.word);
  return word ? { word, tone: value.tone as StatusWordV1["tone"] } : null;
}

/**
 * The name line: `● Paused  Ad “Demo B”`, the status word in its tone (as a
 * list row draws it) and the name in bold, wrapped under itself. Too narrow
 * for both, the status takes its own line above the name.
 */
function headLines(title: string, status: ReturnType<typeof statusWord>, ctx: ViewRenderCtx): string[] {
  const bold = (line: string) => paint(line, "b", ctx);
  if (!status) {
    return wrapText(title, ctx.width).map(bold);
  }
  const chip = `● ${status.word}`;
  const shown = paint(fitLine(chip, ctx.width), toneRole(status.tone), ctx);
  const indent = displayWidth(chip) + GAP.length;
  if (!title) {
    return [shown];
  }
  if (ctx.width - indent < MIN_NAME_CELLS) {
    return [shown, ...wrapText(title, ctx.width).map(bold)];
  }
  return wrapText(title, ctx.width - indent).map((line, index) => (index === 0 ? `${shown}${GAP}${bold(line)}` : `${" ".repeat(indent)}${bold(line)}`));
}

/**
 * r4 `Next: pause it`: each next step after a dim `Next:`. Once the user
 * engages the view, the selected one is a row on the selection (Enter sends
 * its ask as a NEW turn).
 */
function nextLines(steps: ReturnType<typeof nextSteps>, selected: number, ctx: ViewRenderCtx): string[] {
  return steps.map((step, index) => (ctx.engaged
    ? rowLine([{ text: "Next: ", style: "muted" }, { text: step.label, style: index === selected ? "b" : "text" }], index === selected, ctx)
    : fitLine(`${paint("Next:", "muted", ctx)} ${step.label}`, ctx.width)));
}

/** What a history entry did, in r4's words: `created and turned on`, `on → paused`. */
function historyWhat(entry: Record<string, unknown>): string {
  const has = (key: string) => key in entry && entry[key] !== undefined;
  const from = viewText(entry.from);
  const to = viewText(entry.to);
  if (has("from") && !from && to) {
    return /^(on|off)$/iu.test(to) ? `created and turned ${to}` : `created as ${to}`;
  }
  return changeText(entry);
}

function historyLines(value: unknown, ctx: ViewRenderCtx): string[] {
  const history = recordsOf(value);
  if (!history.length) {
    return [];
  }
  const lines = [paint("History", "b", ctx)];
  for (const entry of history) {
    // r4 `Sep 24 09:12`: the time without the comma.
    const when = (formatAsOf(entry.at, ctx.timeZone) ?? "").replace(/, (\d{2}:\d{2})$/u, " $1");
    const source = viewText(entry.source);
    const who = whoText(entry);
    // r4 `by Robin (in the app)`: where it was done follows who did it.
    const by = who && source ? `${who} (${source})` : who || source;
    const what = [historyWhat(entry), by].filter(Boolean).join(" · ");
    const text = [when ? paint(when, "muted", ctx) : "", what].filter(Boolean).join("  ");
    lines.push(fitLine(text, ctx.width));
  }
  return lines;
}

/** An alert or reminder rule: its words verbatim, its schedule, and when it next runs. */
function ruleLines(value: unknown, ctx: ViewRenderCtx): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const every = countOf(value.checkEveryMinutes);
  const version = countOf(value.version);
  const rows = [
    { label: "Rule", value: viewText(value.summary) },
    { label: "Channel", value: viewText(value.channel) },
    { label: "Schedule", value: viewText(value.schedule) },
    { label: "Next run", value: value.nextRunAt === null ? "—" : formatAsOf(value.nextRunAt, ctx.timeZone) ?? "" },
    { label: "Checks every", value: every !== null && every > 0 ? `${formatCount(every)} min` : "" },
    { label: "Version", value: version !== null ? formatCount(version) : "" }
  ].filter((row) => row.value !== "");
  const labelWidth = labelColumnWidth(rows.map((row) => row.label), ctx.width);
  const lines = rows.flatMap((row) => labelValueLines(row.label, row.value, labelWidth, ctx));
  if (value.desktopRequired === true) {
    lines.push(...wrapText("Runs only while the app is open on this computer.", ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  return lines;
}
