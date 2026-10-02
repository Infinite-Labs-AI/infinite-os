// The compare view (terminal-r4 "Compare"): versions side by side, then each
// difference with its likely range.
//
// The verdict is the server's: its line comes only from `verdict.sentence`,
// and the terminal never marks an arm, whatever `namesWinner` says (the
// sentence names the winner when there is one). The grade is not printed as
// words: without a sentence there is no verdict line at all.
import type { UnitV1 } from "@infinite-os/types";

import { displayWidth } from "../lib/display-width.js";
import {
  asList,
  asRecord,
  asUnit,
  cellTableLines,
  drawCell,
  finite,
  pairLines,
  windowDates,
  type CellTableColumn,
  type MeasureDraw,
  type TableCell
} from "./numbers.js";
import { FootnoteBook, formatAsOf, formatValue, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, KindRenderer, ViewRenderCtx } from "./types.js";

const GRADE_GLYPHS: Record<string, { glyph: string; role: "success" | "warning" }> = {
  supported: { glyph: "✓", role: "success" },
  inconclusive: { glyph: "◌", role: "warning" },
  insufficient: { glyph: "◌", role: "warning" }
};

interface MetricRow {
  key: string;
  label: string;
  unit: UnitV1;
}

/** `-1.5% to +3.5% (95%)`: the interval in the difference's unit, then its level. */
function rangeText(interval: unknown, unit: UnitV1): string {
  const range = asRecord(interval);
  const low = finite(range.low);
  const high = finite(range.high);
  if (low === null || high === null) {
    return "";
  }
  const signed = (value: number) => `${value > 0 ? "+" : ""}${formatValue(value, unit, null)}`;
  const level = finite(range.level);
  const levelText = level === null ? "" : ` (${formatValue(level <= 1 ? level * 100 : level, "percent", null)})`;
  return `${signed(low)} to ${signed(high)}${levelText}`;
}

/** The unit of a difference: the metric its label names, else a plain number. */
function differenceUnit(label: string, metrics: readonly MetricRow[]): UnitV1 {
  const name = label.toLowerCase();
  const match = metrics.find((metric) => metric.label.toLowerCase() === name || metric.key.toLowerCase() === name);
  return match?.unit ?? "ratio";
}

function compareBodyLines(body: Record<string, unknown>, ctx: ViewRenderCtx, draw: MeasureDraw): string[] {
  const blocks: string[][] = [];
  const window = asRecord(body.window);
  const windowLine = [viewText(window.label), windowDates(window) ?? ""].filter(Boolean).join(" · ");
  if (windowLine) {
    blocks.push(wrapText(windowLine, ctx.width).map((line) => paint(line, "muted", ctx)));
  }

  const metrics: MetricRow[] = asList(body.metricRows).filter(isRecord).map((row) => ({
    key: typeof row.key === "string" ? row.key : "",
    label: viewText(row.label),
    unit: asUnit(row.unit)
  }));
  const arms = asList(body.arms).filter(isRecord);
  const armLabel = (key: unknown) => {
    const arm = arms.find((entry) => entry.key === key);
    return arm ? viewText(arm.label) : viewText(key);
  };

  if (arms.length) {
    const withN = arms.some((arm) => finite(arm.n) !== null);
    const withDays = arms.some((arm) => finite(arm.days) !== null);
    // Sample size and days go first when the pane is narrow; the metrics stay.
    const columns: CellTableColumn[] = [
      ...(withN ? [{ label: "n", unit: "count" as const, dropPriority: 5 }] : []),
      ...(withDays ? [{ label: "Days", unit: "count" as const, dropPriority: 4 }] : []),
      ...metrics.map((metric) => ({ label: metric.label, unit: metric.unit }))
    ];
    blocks.push(cellTableLines({
      columns,
      rows: arms.map((arm) => ({
        label: viewText(arm.label),
        cells: [
          ...(withN ? [{ value: finite(arm.n) }] : []),
          ...(withDays ? [{ value: finite(arm.days) }] : []),
          ...metrics.map((metric) => asRecord(arm.metrics)[metric.key] as TableCell)
        ]
      })),
      currency: null
    }, ctx, draw));
  }

  const differences = asList(body.differences).filter(isRecord);
  if (differences.length) {
    const withRange = differences.some((difference) => isRecord(difference.interval));
    // The likely range never drops: it is the point of the view.
    const columns: CellTableColumn[] = [
      { label: "vs", unit: "text", dropPriority: 3 },
      { label: "Change", unit: "ratio", signed: true, dropPriority: 1 },
      { label: "Relative", unit: "percent", signed: true, dropPriority: 2 },
      ...(withRange ? [{ label: "Likely range", unit: "text" as const, dropPriority: 0 }] : [])
    ];
    const rows = differences.map((difference) => {
      const label = viewText(difference.label);
      const unit = differenceUnit(label, metrics);
      return {
        label,
        cells: [
          armLabel(difference.against),
          difference.absolute as TableCell,
          difference.relative as TableCell,
          ...(withRange ? [rangeText(difference.interval, unit)] : [])
        ],
        units: [undefined, unit]
      };
    });
    const methods = [...new Set(differences.map((difference) => viewText(difference.method)).filter(Boolean))];
    blocks.push([
      ...cellTableLines({ columns, rows, currency: null }, ctx, draw),
      ...(methods.length ? wrapText(`Range method: ${methods.join(", ")}`, ctx.width).map((line) => paint(line, "muted", ctx)) : [])
    ]);
  }

  const verdict = isRecord(body.verdict) ? body.verdict : null;
  if (verdict) {
    const sentence = viewText(verdict.sentence);
    const grade = typeof verdict.grade === "string" && Object.hasOwn(GRADE_GLYPHS, verdict.grade) ? GRADE_GLYPHS[verdict.grade]! : GRADE_GLYPHS.inconclusive!;
    const wrapped = sentence ? wrapText(`${grade.glyph} ${sentence}`, ctx.width) : [];
    const lines = wrapped.map((line, index) =>
      index === 0 ? `${paint(grade.glyph, grade.role, ctx)}${paint(line.slice(grade.glyph.length), "b", ctx)}` : paint(line, "b", ctx));
    const unmet = asList(verdict.unmet).map((entry) => viewText(entry)).filter(Boolean);
    // r4: the first unmet condition rides the verdict's last line, dim (`◌ No winner yet  · Day 6 of 14`), when it fits.
    const lastPlain = wrapped[wrapped.length - 1];
    if (lastPlain !== undefined && unmet.length && displayWidth(lastPlain) + 4 + displayWidth(unmet[0]!) <= ctx.width) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${paint(`  · ${unmet.shift()!}`, "muted", ctx)}`;
    }
    lines.push(...unmet.flatMap((line) => wrapText(line, ctx.width).map((part) => paint(part, "muted", ctx))));
    blocks.push(lines);
  }

  const decomposition = isRecord(body.decomposition) ? body.decomposition : null;
  if (decomposition) {
    const plain = { label: "", unit: "ratio" as const };
    const value = (cell: unknown) => drawCell(cell as TableCell, plain, null, draw.notes);
    blocks.push(pairLines([
      { label: "Before", value: value(decomposition.before) },
      { label: "After", value: value(decomposition.after) },
      { label: "Rate effect", value: value(decomposition.rateEffect) },
      { label: "Mix effect", value: value(decomposition.mixEffect) },
      ...asList(decomposition.segments).filter(isRecord).map((segment) => ({ label: viewText(segment.label), value: value(segment.effect) }))
    ], ctx));
  }

  const sources = asList(body.sources).filter(isRecord);
  if (sources.length) {
    blocks.push(sources.flatMap((source) => {
      const measured = finite(source.measuredDays);
      const withheld = finite(source.withheldDays);
      const text = [
        viewText(source.source),
        drawCell(source.total as TableCell, { label: "", unit: "ratio" }, null, draw.notes),
        measured === null ? "" : `${formatValue(measured, "count", null)} days measured`,
        withheld ? `${formatValue(withheld, "count", null)} withheld` : ""
      ].filter(Boolean).join(" · ");
      return wrapText(text, ctx.width);
    }));
  }

  const series = asList(body.series).filter(isRecord);
  if (series.length) {
    const keys: string[] = [];
    for (const point of series) for (const key of Object.keys(asRecord(point.values))) if (!keys.includes(key)) keys.push(key);
    const columns: CellTableColumn[] = keys.map((key) => {
      const metric = metrics.find((entry) => entry.key === key);
      const arm = arms.find((entry) => entry.key === key);
      return { label: arm ? viewText(arm.label) : metric?.label ?? viewText(key), unit: metric?.unit ?? "ratio" };
    });
    blocks.push(cellTableLines({
      columns,
      rows: series.map((point) => ({
        label: formatAsOf(point.date) ?? "",
        cells: keys.map((key) => asRecord(point.values)[key] as TableCell)
      })),
      currency: null
    }, ctx, draw));
  }

  return blocks.filter((block) => block.length).flatMap((block, index) => (index > 0 ? ["", ...block] : block));
}

export const renderCompare: KindRenderer<"compare"> = (view, ctx): KindRender => {
  const draw: MeasureDraw = { notes: new FootnoteBook(), hidden: 0 };
  const detail = compareBodyLines(asRecord(view.body), ctx, draw);
  return {
    detail,
    footnotes: draw.notes.lines().flatMap((line) => wrapText(line, ctx.width).map((part) => paint(part, "muted", ctx))),
    keys: [],
    okKey: null,
    rowCount: 0,
    ...(draw.hidden ? { hiddenColumns: draw.hidden } : {})
  };
};
