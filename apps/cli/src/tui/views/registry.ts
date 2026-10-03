// The answer-view registry: one renderer per kind (12 kinds), wrapped in one
// shell. The shell owns what every view shows the same way: the head (title +
// state word), the source line, the explanation behind `?`, the state reason,
// truncation and the server's caveats. A kind renderer draws only its body.
//
// A kind with no renderer yet prints only the head and the state reason. A
// renderer that throws on a malformed body (a decoded view vouches only for
// its envelope) degrades to the same, plus one muted line, and never takes
// the session down.
import type { AnswerViewKind, AnswerViewV1 } from "@infinite-os/types";

import { printableImagesView } from "../../desktop/image-url-cut.js";

import {
  caveatLines,
  explainLines,
  headLine,
  isRecord,
  paint,
  sourceLine,
  stateFixAsk,
  stateReasonLines,
  truncationLines,
  viewText
} from "./primitives.js";
import { explainChip } from "./card.js";
import { managedApproval, managedApprovalLines, managedSummaryLines } from "./managed.js";
import type { KindRender, KindRenderer, ViewRender, ViewRenderCtx } from "./types.js";

// ── kind renderers ──
// Each lane adds its imports and entries in its own block below, so lanes that
// run in parallel never edit the same lines.
// T9 (measures): numbers, compare, health
import { renderCompare } from "./compare.js";
import { renderHealth } from "./health.js";
import { renderNumbers } from "./numbers.js";

// T10 (things): list, record, document, link, quiet
import { renderDocument } from "./document.js";
import { renderLink } from "./link.js";
import { renderList } from "./list.js";
import { renderQuiet } from "./quiet.js";
import { renderRecord } from "./record.js";

// T11 (actions): change, launch, images, job
import { renderChange } from "./change.js";
import { renderImages } from "./images.js";
import { renderJob } from "./job.js";
import { renderLaunch } from "./launch.js";
import { isSettledWithoutRunning, reconcileLines } from "./outcome.js";

type KindRendererMap = { [K in AnswerViewKind]?: KindRenderer<K> };

const KIND_RENDERERS: KindRendererMap = {
  // T9 (measures)
  numbers: renderNumbers,
  compare: renderCompare,
  health: renderHealth,

  // T10 (things)
  list: renderList,
  record: renderRecord,
  document: renderDocument,
  link: renderLink,
  quiet: renderQuiet,

  // T11 (actions)
  change: renderChange,
  launch: renderLaunch,
  images: renderImages,
  job: renderJob
};

/** Whether this kind draws a body yet (until then only its head and state reason print). */
export function hasKindRenderer(kind: AnswerViewKind): boolean {
  return KIND_RENDERERS[kind] !== undefined;
}

/** One view, drawn at `ctx.width`: the shell around the kind's body. */
export function renderView(given: AnswerViewV1, ctx: ViewRenderCtx): ViewRender {
  // An images view never prints a URL, in its body or its shell.
  const view = printableImagesView(given);
  const shellCtx: ViewRenderCtx = { ...ctx, width: Math.max(1, Math.floor(ctx.width)) };
  const body = renderKindBody(view, shellCtx);
  if (view.kind === "quiet") {
    // A quiet call that failed (the app's generic failure view: its title is
    // the tool's name, its reason a developer's error) draws nothing of its
    // own: its Steps row says it, with one plain reason (run-2 M6). In
    // scrollback, where no Steps strip goes with it, a quiet view prints
    // nothing either (no literal `steps only`).
    if (shellCtx.scrollback || failedQuiet(view)) {
      return { head: "", source: null, detail: [], footnotes: [], keys: [], okKey: null, rowCount: 0, quiet: true };
    }
    // Steps only (r4 view-12): the details pane under a dim `steps only` head,
    // an empty source row, then its line. No title, source, explanation, state
    // reason, truncation or caveats.
    return {
      head: paint("steps only", "dim", shellCtx), source: "", detail: body?.detail ?? [], footnotes: [], keys: [], okKey: null, rowCount: 0, quiet: true
    };
  }
  // Enter sends the state's fix ask only when no row has an ask of its own.
  const fixAsk = (body?.rowAsks ?? []).some((ask) => viewText(ask) !== "") ? null : stateFixAsk(view);
  // A tool that asks twice: its approval waits on this view (never the confirm queue).
  const managed = ctx.approvalClosed ? null : managedApproval(view);
  return {
    head: headLine(view, shellCtx),
    source: sourceLine(view, shellCtx),
    detail: [
      ...explainLines(view, shellCtx),
      ...managedSummaryLines(managed, shellCtx),
      // A settled write's afterword ("Nothing ran.") follows its sentence on the next row (r4 receipts).
      ...(body?.joinsReason || (AFTERWORD_KINDS.has(view.kind) && isSettledWithoutRunning(view))
        ? [...stateReasonLines(view, shellCtx, fixAsk !== null), ...(body?.detail ?? [])]
        : blankBetween(stateReasonLines(view, shellCtx, fixAsk !== null), body?.detail ?? [])),
      ...(managed ? managedApprovalLines(managed, shellCtx) : []),
      ...reconcileLines(view, shellCtx),
      ...truncationLines(view, shellCtx),
      ...caveatLines(view, shellCtx),
      // `?` lives inside the view, never on the key bar (r4: every `? what it does` is in the thing it explains).
      ...(!body?.offersExplain && (viewText(view.explain) !== "" || (managed?.summary ?? "") !== "") ? ["", explainChip(shellCtx)] : [])
    ],
    footnotes: body?.footnotes ?? [],
    keys: body?.keys ?? [],
    okKey: body?.okKey ?? null,
    rowCount: body ? body.rowCount : structuralRowCount(view),
    ...(body?.rowAsks ? { rowAsks: body.rowAsks } : {}),
    ...(body?.tabs ? { tabs: body.tabs } : {}),
    ...(body?.pages ? { pages: body.pages } : {}),
    ...(body?.hiddenColumns ? { hiddenColumns: body.hiddenColumns } : {}),
    ...(body?.rowCopies ? { rowCopies: body.rowCopies } : {}),
    ...(body?.copyText ? { copyText: body.copyText } : {}),
    ...(fixAsk ? { fixAsk } : {}),
    ...(managed ? { approvalAsk: { key: managed.key, label: managed.label, ask: managed.ask } } : {})
  };
}

/** The states a quiet view takes when its call failed (the app's failure view), not a quiet read. */
const FAILED_QUIET_STATES: ReadonlySet<string> = new Set(["failed", "blocked", "hit_limit", "outcome_unknown", "not_connected", "expired", "cancelled"]);

/** A quiet view that stands for a failed call: degraded, or in a failure's state. */
function failedQuiet(view: AnswerViewV1): boolean {
  return (isRecord(view.body) && view.body.degraded === true) || FAILED_QUIET_STATES.has(view.state);
}

/** The kinds whose settled receipts draw only an afterword under the state's sentence (outcome.ts). */
const AFTERWORD_KINDS: ReadonlySet<string> = new Set(["change", "launch", "images", "job"]);

/** Two blocks, a blank row between them when both have lines (r4 sets a state's sentence apart from the body). */
function blankBetween(first: readonly string[], second: readonly string[]): string[] {
  return first.length && second.length ? [...first, "", ...second] : [...first, ...second];
}

function renderKindBody(view: AnswerViewV1, ctx: ViewRenderCtx): KindRender | null {
  const renderer = KIND_RENDERERS[view.kind] as KindRenderer<AnswerViewKind> | undefined;
  if (!renderer) {
    return null;
  }
  try {
    return renderer(view, ctx);
  } catch {
    return {
      detail: [paint("· this view could not be drawn", "muted", ctx)],
      footnotes: [],
      keys: [],
      okKey: null,
      rowCount: 0
    };
  }
}

/**
 * The rows j/k can select, read from the body's own shape. Used until the
 * kind's renderer says (its `rowCount` wins).
 */
export function structuralRowCount(view: AnswerViewV1): number {
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  switch (view.kind) {
    case "list": {
      const groups: unknown[] = Array.isArray(body.groups) ? body.groups : [];
      return lengthOf(body.rows) + groups.reduce<number>((sum, group) => sum + (isRecord(group) ? lengthOf(group.rows) : 0), 0);
    }
    case "numbers": {
      const legs = isRecord(body.legs) ? body.legs : null;
      return legs && isRecord(legs.settled) ? lengthOf(legs.settled.rows) : 0;
    }
    case "health":
      return lengthOf(body.items);
    case "compare":
      return lengthOf(body.arms);
    default:
      return 0;
  }
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
