// The record view (terminal-r4 "Record"): one thing's fields as `label  value`
// (a null is a dash with a footnote, never 0), its history (`when  from → to ·
// by who`, a null who is `who: unknown`), an alert rule's schedule, and the
// view's next steps as selectable rows (Enter sends the ask as a NEW turn).
// A `creativeRef` is a picture: the terminal never draws one.
import type { CellV1, TextCellV1 } from "@infinite-os/types";

import { cellText, fitLine, formatAsOf, FootnoteBook, isRecord, paint, viewText, wrapText } from "./primitives.js";
import {
  bodyOf,
  changeText,
  clampIndex,
  countOf,
  formatCount,
  labelColumnWidth,
  labelValueLines,
  nextStepLines,
  nextSteps,
  recordsOf,
  section,
  unitOf,
  whoText
} from "./things.js";
import type { KindRenderer, ViewRenderCtx } from "./types.js";

/** Record labels pad to at least this many cells, so the values start where r4's do. */
const RECORD_LABEL_CELLS = 12;

export const renderRecord: KindRenderer<"record"> = (view, ctx) => {
  const body = bodyOf(view);
  const notes = new FootnoteBook();
  const steps = nextSteps(view);
  const selected = clampIndex(ctx.selected, steps.length);
  const lines: string[] = [];

  const fields = recordsOf(body.fields).map((field) => {
    const value = isRecord(field.value) ? (field.value as unknown as CellV1 | TextCellV1) : null;
    const fallback = value && "text" in value ? "text" : "count";
    return { label: viewText(field.label), value: cellText(value, unitOf(field.unit, fallback), null, notes) };
  }).filter((field) => field.label !== "" || field.value !== "");
  // r4 lines the values up in one column, 14 in (labels padded to 12, then two spaces).
  const labelWidth = Math.max(Math.min(RECORD_LABEL_CELLS, Math.floor(ctx.width * 0.4)), labelColumnWidth(fields.map((field) => field.label), ctx.width));
  for (const field of fields) {
    lines.push(...labelValueLines(field.label, field.value, labelWidth, ctx));
  }

  section(lines, historyLines(body.history, ctx));
  section(lines, ruleLines(body.rule, ctx));
  section(lines, nextStepLines(steps, 0, selected, ctx));

  return {
    detail: lines,
    footnotes: notes.lines(),
    keys: [],
    okKey: null,
    rowCount: steps.length,
    rowAsks: steps.map((step) => step.ask)
  };
};

function historyLines(value: unknown, ctx: ViewRenderCtx): string[] {
  const history = recordsOf(value);
  if (!history.length) {
    return [];
  }
  const lines = [paint("History", "b", ctx)];
  for (const entry of history) {
    const when = formatAsOf(entry.at, ctx.timeZone) ?? "";
    const what = [changeText(entry), whoText(entry), viewText(entry.source)].filter(Boolean).join(" · ");
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
