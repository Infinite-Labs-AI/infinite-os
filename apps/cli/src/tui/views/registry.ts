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
  turnAsk,
  viewText
} from "./primitives.js";
import { managedApproval, managedApprovalLines, managedSummaryLines } from "./managed.js";
import { appOpenTarget } from "./open-target.js";
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
import { awaitingApp, isSettledWithoutRunning, reconcileAsk, reconcileLines } from "./outcome.js";

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
  if (view.kind === "quiet" && quietSaysWhy(view)) {
    return quietStopRender(view, shellCtx);
  }
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
  const before = [...(body?.lead ?? []), ...explainLines(view, shellCtx), ...managedSummaryLines(managed, shellCtx)];
  // A settled write's afterword ("Nothing ran.") follows its sentence on the next row (r4 receipts).
  // A dismissal still on its way says only that (N22): its sentence waits for the app's answer.
  const withBody = body?.joinsReason || (AFTERWORD_KINDS.has(view.kind) && isSettledWithoutRunning(view))
    ? [...(awaitingApp(view, shellCtx) ? [] : stateReasonLines(view, shellCtx, fixAsk !== null)), ...(body?.detail ?? [])]
    : blankBetween(stateReasonLines(view, shellCtx, fixAsk !== null), body?.detail ?? []);
  // The body's detail ends `withBody`: its selected row moves down by what is drawn above it.
  const bodyAt = before.length + withBody.length - (body?.detail.length ?? 0);
  return {
    head: headLine(body?.headTitle !== undefined ? { ...view, title: body.headTitle } : view, shellCtx),
    source: sourceLine(view, shellCtx),
    detail: [
      ...before,
      ...withBody,
      ...(managed ? managedApprovalLines(managed, shellCtx) : []),
      ...reconcileLines(view, shellCtx),
      ...truncationLines(view, shellCtx),
      // A caveat an earlier read of the same account already printed is not printed again (N27).
      ...caveatLines(shellCtx.repeats?.caveats.length ? withoutCaveats(view, shellCtx.repeats.caveats) : view, shellCtx)
      // A view's `? what it does` is a key on the key bar (`? hide` while open),
      // never a line inside the answer (run-2 N12). A card draws its own inside
      // itself (r4 `card()`), and the bar leaves it there (`explainInside`).
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
    ...(managed ? { approvalAsk: { key: managed.key, label: managed.label, ask: managed.ask } } : {}),
    ...(body?.offersExplain ? { explainInside: true as const } : {}),
    ...openFor(view, body, shellCtx),
    ...(body?.watchAsk ? { watchAsk: body.watchAsk } : {}),
    ...(body?.selectedLines ? { selectedLines: [bodyAt + body.selectedLines[0], body.selectedLines[1]] as const } : {})
  };
}

/**
 * The place `o` opens (T12, app.open.v1), only when the session can open
 * places: the kind's own (a job's landing, a list row's, a health fix), else
 * the state's fix link, else the view's own link. A kind that decided there is
 * none (null) gets none. Never a URL: place and params only. Its label is the
 * link's own (`Open in Meta Ads`), else `open`: never the fix's sentence
 * (live T4: `If it changed in Ads Manager since: …` labelled the key).
 */
function openFor(view: AnswerViewV1, body: KindRender | null, ctx: ViewRenderCtx): { openLink?: AppOpenTargetOf; openLabel?: string } {
  if (!ctx.caps.open) return {};
  if (body && body.openLink !== undefined) {
    return body.openLink ? { openLink: body.openLink, openLabel: body.openLabel || "open" } : {};
  }
  const fix = isRecord(view.stateReason) && isRecord(view.stateReason.fix) ? view.stateReason.fix : null;
  const link = fix && isRecord(fix.appLink) ? fix.appLink : isRecord(view.appLink) ? view.appLink : null;
  const target = appOpenTarget(link);
  if (!target) return {};
  return { openLink: target, openLabel: viewText(link?.label) || "open" };
}

type AppOpenTargetOf = NonNullable<KindRender["openLink"]>;

/**
 * The states in which a quiet call did NOT do its thing for a reason the
 * person must read (TJ-1): not sure it happened, blocked, out of budget, not
 * connected, expired, only in Cmd+L or in the app. Its Steps row alone would
 * lose the reason (and, for `outcome_unknown`, the reconcile step), so the
 * view draws its head and reason like any other view. A plain `failed` stays
 * the app's generic failure view (its reason a developer's, run-2 M6): its
 * Steps row says it.
 */
const QUIET_STOP_STATES: ReadonlySet<string> = new Set([
  "outcome_unknown", "blocked", "hit_limit", "not_connected", "expired", "cmdl_only", "finish_in_app"
]);

/** Whether a quiet view stands for a call that stopped for a reason it must show (`QUIET_STOP_STATES`). */
function quietSaysWhy(view: AnswerViewV1): boolean {
  return QUIET_STOP_STATES.has(view.state) && (isRecord(view.stateReason) || isRecord(view.reconcile));
}

/**
 * A quiet call that stopped (TJ-1, r4 flow-email-04 / flow-images-05): its
 * head (`stateReason.short`, else the state's words), source, the reason's
 * sentence and fix, and for `outcome_unknown` the reconcile step on Enter
 * (`reconcile.ask`, a NEW user turn, named by `reconcile.label`). Never a
 * retry: a quiet view has no OK key, so not even a safe resend offers one.
 */
function quietStopRender(view: AnswerViewV1, ctx: ViewRenderCtx): ViewRender {
  const reconcile = quietReconcileAsk(view);
  // Not sure it happened: checking comes first (R-IOV-7a), so Enter is the
  // reconcile step and the state's fix is not an Enter line of its own.
  const stateFix = reconcile ? null : stateFixAsk(view);
  const fixAsk = reconcile ?? stateFix;
  const label = reconcile && isRecord(view.reconcile) ? viewText(view.reconcile.label) : "";
  return {
    head: headLine(view, ctx),
    source: sourceLine(view, ctx),
    detail: [
      ...explainLines(view, ctx),
      ...stateReasonLines(view, ctx, stateFix !== null),
      ...reconcileLines(view, ctx),
      ...caveatLines(view, ctx)
    ],
    footnotes: [],
    keys: [],
    okKey: null,
    rowCount: 0,
    ...(fixAsk ? { fixAsk } : {}),
    ...(label ? { fixLabel: label.toLowerCase() } : {}),
    ...openFor(view, null, ctx)
  };
}

/** An outcome_unknown quiet view's reconcile ask (a NEW user turn), when it has one. */
function quietReconcileAsk(view: AnswerViewV1): string | null {
  return view.state === "outcome_unknown" ? turnAsk(reconcileAsk(view)) : null;
}

/**
 * The ask Enter sends on a quiet view that stopped (its reconcile step, else
 * its fix), or null. A quiet view with one takes the keys over a plain read in
 * its turn (R-IOV-3): its `→` line names Enter, so Enter must reach it.
 */
export function quietStopAsk(view: AnswerViewV1): string | null {
  if (view.kind !== "quiet" || !quietSaysWhy(view)) return null;
  return quietReconcileAsk(view) ?? stateFixAsk(view);
}

/** The states a quiet view takes when its call failed (the app's failure view), not a quiet read. */
const FAILED_QUIET_STATES: ReadonlySet<string> = new Set(["failed", "blocked", "hit_limit", "outcome_unknown", "not_connected", "expired", "cancelled"]);

/** A quiet view that stands for a failed call: degraded, or in a failure's state. */
function failedQuiet(view: AnswerViewV1): boolean {
  return (isRecord(view.body) && view.body.degraded === true) || FAILED_QUIET_STATES.has(view.state);
}

/** The view without the caveats `printed` (an earlier view in its turn said them). */
function withoutCaveats(view: AnswerViewV1, printed: readonly string[]): AnswerViewV1 {
  const said = new Set(printed);
  return { ...view, caveats: view.caveats.filter((caveat) => !said.has(caveat)) } as AnswerViewV1;
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
