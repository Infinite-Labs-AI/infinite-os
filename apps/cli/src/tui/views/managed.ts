// An `operation_managed` approval on a tool-result view (the tool asks twice:
// its first call returns a preview, and the user's yes is a NEW user turn,
// `approval.ask`). It never goes through the confirm queue, so the view itself
// draws it: the approval's title and rows (its summary behind `?`), and the
// key bar offers the named OK key and `n` once the view is engaged.
//
// OK sends `approval.ask` as a new user turn, never a confirm; `n` only
// closes it here (nothing is sent: the tool never acts without the ask). An
// ask that is a command (`/…`) offers no OK key at all.
import type { AnswerViewV1 } from "@infinite-os/types";

import { okKeyFor } from "../keys/keymap.js";
import { labelValueLines } from "./change.js";
import { isRecord, paint, turnAsk, viewText, wrapText } from "./primitives.js";
import type { ViewRenderCtx } from "./types.js";

export interface ManagedApproval {
  /** The named OK key (`okKeyFor(confirmLabel)`). */
  key: string;
  label: string;
  /** The new user turn OK sends. */
  ask: string;
  title: string;
  summary: string;
  effect: string;
  rows: { label: string; value: string }[];
}

const LIVE_STATES = new Set(["needs_yes", "needs_answer"]);

/** The view's operation_managed approval while it waits for a yes, else null. */
export function managedApproval(view: AnswerViewV1): ManagedApproval | null {
  const approval = isRecord(view.approval) ? view.approval : null;
  if (!approval || approval.kind !== "operation_managed" || !LIVE_STATES.has(view.state)) {
    return null;
  }
  const ask = turnAsk(approval.ask);
  if (!ask) {
    return null;
  }
  const label = viewText(approval.confirmLabel, "Confirm");
  const rows: unknown[] = Array.isArray(approval.rows) ? approval.rows : [];
  return {
    key: okKeyFor(label),
    label,
    ask,
    title: viewText(approval.title),
    summary: viewText(approval.summary),
    effect: viewText(approval.effect),
    rows: rows.filter(isRecord).map((row) => ({ label: viewText(row.label), value: viewText(row.value) }))
  };
}

/** The approval's lines under the view's body: its title, rows and effect. */
export function managedApprovalLines(approval: ManagedApproval, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [""];
  if (approval.title) {
    lines.push(...wrapText(approval.title, ctx.width).map((line) => paint(line, "warning", ctx, { bold: true })));
  }
  lines.push(...labelValueLines(approval.rows, ctx));
  if (approval.effect) {
    lines.push(...wrapText(approval.effect, ctx.width).map((line) => paint(line, "warning", ctx)));
  }
  return lines.length > 1 ? lines : [];
}

/** The approval's summary, once `?` opened the explanation. */
export function managedSummaryLines(approval: ManagedApproval | null, ctx: ViewRenderCtx): string[] {
  return approval?.summary && ctx.explainOpen
    ? wrapText(approval.summary, ctx.width).map((line) => paint(line, "muted", ctx))
    : [];
}
