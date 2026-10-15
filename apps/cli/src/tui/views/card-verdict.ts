// A card's one-line verdict, for the compact card of the one-column flow (V2,
// `chat-layout.ts` `flow-compact`): the card's head, then this line, until the
// card opens in place.
//
// Like every renderer here it only PRINTS what the view says: a numbers card's
// own totals (never a sum of rows, never across legs), a funnel's first and
// last step as counted (never a %), a job's current step and its own progress,
// a list's own count, a compare's own sentence. With nothing of that kind the
// line is the card's first drawn detail line, as the full card would print it.
import type { AnswerViewV1, UnitV1 } from "@infinite-os/types";

import { stripAnsi } from "../lib/display-width.js";
import { changeCardSummary } from "./change.js";
import { formatValue, isRecord, viewText } from "./primitives.js";
import type { ViewRender } from "./types.js";

const OSC8 = new RegExp(`${String.fromCharCode(27)}\\]8;[^\\u0007${String.fromCharCode(27)}]*(?:\\u0007|${String.fromCharCode(27)}\\\\)`, "gu");

/** Plain words of a drawn line (no colour, no link codes), trimmed. */
function plain(line: string): string {
  return stripAnsi(line.replace(OSC8, "")).trim();
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A measured cell's value as the card prints it, `—` when not measured. */
function cellValue(cell: unknown, unit: UnitV1, currency: string | null): string {
  const value = isRecord(cell) && typeof cell.value === "number" && Number.isFinite(cell.value) ? cell.value : null;
  return value === null ? "—" : formatValue(value, unit, currency);
}

/** A naive plural for a row label (`Ad set` → `ad sets`), else `rows`. */
function rowsWord(count: number, label: string): string {
  const word = viewText(label).toLowerCase();
  if (!word || !/^[a-z][a-z ]*[a-rt-xz]$/u.test(word)) return `${count} ${count === 1 ? "row" : "rows"}`;
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function numbersVerdict(body: Record<string, unknown>): string {
  const legs = isRecord(body.legs) ? body.legs : null;
  const settled = legs && isRecord(legs.settled) ? legs.settled : null;
  if (!settled) return "";
  const currency = typeof body.currency === "string" ? body.currency : null;
  const steps = asArray(settled.steps).filter(isRecord);
  if (body.layout === "steps" && steps.length >= 2) {
    // The funnel's first and last step, as counted: never a rate between them.
    const end = (step: Record<string, unknown>) =>
      `${viewText(step.label)} ${typeof step.count === "number" ? formatValue(step.count, "count", null) : "—"}`;
    return `${end(steps[0]!)} → ${end(steps.at(-1)!)} · ${steps.length} steps`;
  }
  const columns = asArray(body.columns).filter(isRecord);
  const rows = asArray(settled.rows).filter(isRecord);
  const totals = isRecord(settled.totals) ? settled.totals : null;
  // The card's own totals, or its one row: never a sum the card did not print.
  const source = totals ?? (rows.length === 1 && isRecord(rows[0]!.cells) ? rows[0]!.cells : null);
  if (!source) return "";
  const parts = columns
    .filter((column) => column.unit !== "text" && Object.hasOwn(source, viewText(column.key)))
    .slice(0, 3)
    .map((column) => `${viewText(column.label)} ${cellValue(source[viewText(column.key)], (column.unit as UnitV1) ?? "count", currency)}`);
  if (!parts.length) return "";
  const window = isRecord(settled.window) ? viewText(settled.window.label) : "";
  const across = rows.length > 1 ? rowsWord(rows.length, viewText(body.rowLabel)) : "";
  return [...parts, across, window].filter(Boolean).join(" · ");
}

function jobVerdict(body: Record<string, unknown>): string {
  const steps = asArray(body.steps).filter(isRecord);
  const now = steps.find((step) => step.state === "now" || step.state === "held" || step.state === "failed");
  const progress = isRecord(body.progress) && typeof body.progress.finished === "number" && typeof body.progress.of === "number"
    ? `${body.progress.finished} of ${body.progress.of} steps done`
    : "";
  const at = now ? [viewText(now.label), viewText(now.detail)].filter(Boolean).join(" ") : "";
  return [viewText(body.label), at, progress].filter(Boolean).join(" · ");
}

function listVerdict(body: Record<string, unknown>): string {
  const shown = typeof body.shown === "number" ? body.shown : asArray(body.rows).length;
  const total = typeof body.total === "number" ? body.total : null;
  const noun = viewText(body.nameLabel).toLowerCase();
  const count = total !== null && total !== shown ? `${shown} of ${total}` : `${shown}`;
  return [noun ? `${count} · ${noun}` : `${count} ${shown === 1 ? "row" : "rows"}`, viewText(body.filterWords)].filter(Boolean).join(" · ");
}

function recordVerdict(body: Record<string, unknown>): string {
  const currency = typeof body.currency === "string" ? body.currency : null;
  return asArray(body.fields).filter(isRecord).slice(0, 3).map((field) => {
    const value = field.value;
    const words = isRecord(value) && "text" in value ? viewText(value.text) || "—" : cellValue(value, (field.unit as UnitV1) ?? "count", currency);
    return `${viewText(field.label)} ${words}`;
  }).join(" · ");
}

/**
 * The verdict line's words for a card, or "" when the view gives nothing to
 * say in one line and its drawn detail is empty.
 */
export function cardVerdict(view: AnswerViewV1, render: ViewRender): string {
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  let words = "";
  switch (view.kind) {
    case "numbers":
      words = numbersVerdict(body);
      break;
    case "job":
      words = jobVerdict(body);
      break;
    case "list":
      words = listVerdict(body);
      break;
    case "record":
      words = recordVerdict(body);
      break;
    case "change":
      words = changeCardSummary(view);
      break;
    case "compare": {
      const verdict = isRecord(body.verdict) ? body.verdict : null;
      words = viewText(verdict?.sentence);
      break;
    }
    default:
      break;
  }
  if (words) return words;
  return render.detail.map(plain).find(Boolean) ?? "";
}
