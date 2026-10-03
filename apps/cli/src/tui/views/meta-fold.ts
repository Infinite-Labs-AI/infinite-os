// Two level reads of one ad account in one turn (N27, terminal half). A level
// read (campaigns, ad sets, ads) carries the ACCOUNT's numbers beside its own
// rows: the settled totals, funnel and day strip, today's leg, by day, the
// prior period. Two such reads over one window repeat those parts, so the later
// view draws only what is its own and ONE dim line names what it folded.
//
// This is a port of the app's rule (1bu-1 shared/meta-chat-view-shapes.ts,
// `metaViewRepeats` and `metaRepeatLine`): the CLI cannot import it, so the
// rule and the line's words are kept the same here, value for value. A part
// folds only when it is EQUAL (deep value equality, keys holding undefined
// ignored); a part read at another instant draws again. Pure.
import type { AnswerViewV1 } from "@infinite-os/types";

import { isRecord, viewText } from "./primitives.js";

/** The one tool whose level reads fold. */
export const META_PERFORMANCE_TOOL = "get_meta_performance";

/** A section's slot: its machine shape (a numbers section, its layout and column keys in order). */
const SECTION_SHAPES: ReadonlyArray<{ slot: string; layout: string; keys: readonly string[] }> = [
  { slot: "days", layout: "series", keys: ["date", "spend", "impressions", "clicks", "linkClicks", "ctrLink", "registrations", "trials"] },
  { slot: "prior", layout: "kpis", keys: ["spend", "impressions", "linkClicks", "ctrLink", "cpcLink", "cpm", "registrations", "trials", "purchases", "purchaseValue", "roas"] },
  { slot: "ourSignups", layout: "table", keys: ["registrations", "appSignups"] },
  { slot: "stripeTrials", layout: "kpis", keys: ["stripeNewTrials"] },
  { slot: "entityDays", layout: "series", keys: ["entity", "date", "spend", "impressions", "linkClicks", "registrations", "trials", "leads"] }
];

/** What a later view repeats of an earlier one. `sections` are indexes into the LATER view's sections. */
export interface MetaRepeats {
  /** The settled leg's totals, funnel steps and day strip equal the earlier view's. */
  settledSummary: boolean;
  /** Today's leg (window, as-of, totals and rows) equals the earlier view's. */
  today: boolean;
  /** The later view's sections equal to the earlier view's section in the same slot, in its order. */
  sections: number[];
  /** The caveats both views carry, in the later view's order. */
  caveats: string[];
}

type Rec = Record<string, unknown>;

function performanceBody(view: AnswerViewV1 | null | undefined): Rec | null {
  if (!view || view.kind !== "numbers" || view.tool !== META_PERFORMANCE_TOOL || !isRecord(view.body)) return null;
  const legs = view.body.legs;
  return isRecord(legs) && isRecord(legs.settled) ? (view.body as Rec) : null;
}

/** The slot a section fills, by its shape, or null. */
function slotOf(section: unknown): string | null {
  if (!isRecord(section) || section.kind !== "numbers" || !isRecord(section.body)) return null;
  const body = section.body;
  const columns: unknown[] = Array.isArray(body.columns) ? body.columns : [];
  for (const shape of SECTION_SHAPES) {
    if (body.layout === shape.layout && columns.length === shape.keys.length
      && columns.every((column, index) => isRecord(column) && column.key === shape.keys[index])) {
      return shape.slot;
    }
  }
  return null;
}

/** Deep value equality; a key holding undefined counts as absent. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const list = b as unknown[];
    return a.length === list.length && a.every((item, index) => sameValue(item, list[index]));
  }
  const left = a as Rec;
  const right = b as Rec;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const other = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === other.length && keys.every((key) => sameValue(left[key], right[key]));
}

/**
 * What `later` repeats of `earlier`, or null when they are not the same read
 * (another tool, workspace, or settled window {from, to, tz} plus `final`).
 */
export function metaViewRepeats(earlier: AnswerViewV1 | null | undefined, later: AnswerViewV1 | null | undefined): MetaRepeats | null {
  const before = performanceBody(earlier);
  const after = performanceBody(later);
  if (!before || !after || !earlier || !later) return null;
  if (!sameValue(earlier.scope, later.scope)) return null;
  const beforeLegs = before.legs as Rec;
  const afterLegs = after.legs as Rec;
  const settledBefore = beforeLegs.settled as Rec;
  const settledAfter = afterLegs.settled as Rec;
  const window = (leg: Rec) => {
    const w = isRecord(leg.window) ? leg.window : {};
    return { from: w.from, to: w.to, tz: w.tz, final: leg.final };
  };
  if (!sameValue(window(settledBefore), window(settledAfter))) return null;
  const summary = (leg: Rec) => ({ totals: leg.totals, steps: leg.steps, coverage: leg.coverage });
  const earlierSections = new Map<string, unknown>();
  for (const section of Array.isArray(before.sections) ? before.sections : []) {
    const slot = slotOf(section);
    if (slot) earlierSections.set(slot, section);
  }
  const sections: number[] = [];
  (Array.isArray(after.sections) ? after.sections : []).forEach((section, index) => {
    const slot = slotOf(section);
    if (slot && sameValue(earlierSections.get(slot), section)) sections.push(index);
  });
  const earlierCaveats = new Set(earlier.caveats);
  return {
    settledSummary: sameValue(summary(settledBefore), summary(settledAfter)),
    today: isRecord(beforeLegs.today) && sameValue(beforeLegs.today, afterLegs.today),
    sections,
    caveats: later.caveats.filter((caveat) => earlierCaveats.has(caveat))
  };
}

/**
 * The ONE dim line drawn in place of what folded, worded as the app words it:
 * `Same as above: ` and, joined by ` · `, the coverage (`6 of 6 days in`, or
 * `totals` for a leg with none) when the settled summary folded, today's
 * window label when today folded, each folded section's title in the later
 * view's order, and `notes` when a caveat was already printed. Null when
 * nothing folded.
 */
export function metaRepeatLine(later: AnswerViewV1 | null | undefined, repeats: MetaRepeats): string | null {
  const body = performanceBody(later);
  if (!body) return null;
  const legs = body.legs as Rec;
  const parts: string[] = [];
  if (repeats.settledSummary) {
    const coverage = (legs.settled as Rec).coverage;
    parts.push(isRecord(coverage) ? `${String(coverage.measuredDays)} of ${String(coverage.requestedDays)} days in` : "totals");
  }
  if (repeats.today && isRecord(legs.today) && isRecord(legs.today.window)) parts.push(viewText(legs.today.window.label));
  const sections: unknown[] = Array.isArray(body.sections) ? body.sections : [];
  for (const index of repeats.sections) {
    const section = sections[index];
    if (isRecord(section) && viewText(section.title)) parts.push(viewText(section.title));
  }
  if (repeats.caveats.length > 0) parts.push("notes");
  return parts.length > 0 ? `Same as above: ${parts.join(" · ")}` : null;
}

/** What each view of a turn folds (N27): for each, the repeats of the latest earlier view of the same tool, or null. */
export function turnRepeats(views: readonly AnswerViewV1[]): (MetaRepeats | null)[] {
  return views.map((view, index) => {
    if (!performanceBody(view)) return null;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      if (views[earlier]!.tool === view.tool && views[earlier]!.kind === view.kind) {
        const repeats = metaViewRepeats(views[earlier], view);
        return repeats && metaRepeatLine(view, repeats) !== null ? repeats : null;
      }
    }
    return null;
  });
}
