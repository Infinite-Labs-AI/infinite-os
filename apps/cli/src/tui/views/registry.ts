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

import {
  caveatLines,
  explainLines,
  headLine,
  isRecord,
  paint,
  sourceLine,
  stateReasonLines,
  truncationLines
} from "./primitives.js";
import type { KindRender, KindRenderer, ViewRender, ViewRenderCtx } from "./types.js";

// ── kind renderers ──
// Each lane adds its imports and entries in its own block below, so lanes that
// run in parallel never edit the same lines.
// T9 (measures): numbers, compare, health

// T10 (things): list, record, document, link, quiet

// T11 (actions): change, launch, images, job

type KindRendererMap = { [K in AnswerViewKind]?: KindRenderer<K> };

const KIND_RENDERERS: KindRendererMap = {
  // T9 (measures)

  // T10 (things)

  // T11 (actions)

};

/** Whether this kind draws a body yet (until then only its head and state reason print). */
export function hasKindRenderer(kind: AnswerViewKind): boolean {
  return KIND_RENDERERS[kind] !== undefined;
}

/** One view, drawn at `ctx.width`: the shell around the kind's body. */
export function renderView(view: AnswerViewV1, ctx: ViewRenderCtx): ViewRender {
  const shellCtx: ViewRenderCtx = { ...ctx, width: Math.max(1, Math.floor(ctx.width)) };
  const body = renderKindBody(view, shellCtx);
  return {
    head: headLine(view, shellCtx),
    source: sourceLine(view, shellCtx),
    detail: [
      ...explainLines(view, shellCtx),
      ...stateReasonLines(view, shellCtx),
      ...(body?.detail ?? []),
      ...truncationLines(view, shellCtx),
      ...caveatLines(view, shellCtx)
    ],
    footnotes: body?.footnotes ?? [],
    keys: body?.keys ?? [],
    okKey: body?.okKey ?? null,
    rowCount: body ? body.rowCount : structuralRowCount(view),
    ...(body?.rowAsks ? { rowAsks: body.rowAsks } : {}),
    ...(body?.tabs ? { tabs: body.tabs } : {}),
    ...(body?.pages ? { pages: body.pages } : {}),
    ...(body?.hiddenColumns ? { hiddenColumns: body.hiddenColumns } : {})
  };
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
