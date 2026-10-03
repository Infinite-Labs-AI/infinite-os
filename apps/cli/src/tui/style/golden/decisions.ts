// Binding restyle decisions (2026-10-02) where they overrule a golden.
// The goldens are r4 as drawn; these are the ONLY edits made to them, each one
// named after its decision, so a lane can see why a golden row reads otherwise.
//
//   LAYOUT  Side by side from 80 cols, as r4's frame() draws it (2026-10-03;
//           the 2026-10-02 reading put the split at 120). The eval-width frames
//           (--c60/--c100/--c160, boot) are r4's own frame() at r4's split, so
//           --c100 is r4's two-pane form at 100 cols (answer 28, details 69) and
//           its body is compared. The region slices are r4 as drawn at 100.
//   D3      r4's exact heads: Cmd+L-only is "⌘ Do this in Cmd+L" (the golden
//           reads "⌘ Cmd+L only").
//   D6      While busy, `esc stop` is the FIRST key-bar hint, shown once.
//   (TAB)   Not a decision any more (round 4): the boot frame's key bar is
//           r4's own, `tab switch side` then `/ commands`, compared as drawn.
//           Only a turn with nothing beside its answer drops `tab switch side`,
//           and r4 draws no such screen, so no golden needs an edit for it.
//   D1, D4, D5 need no golden edit: regions are located independently and the
//           chrome must appear once (D1), the boot goldens are r4's frame only
//           and nothing else may be on screen (D4, `compareFrame` coverage), and
//           body padding rows are never required (D5, tolerance T6).
import type { GoldenFile } from "./compare.js";
import { normalizeCells, type Cell, type SegmentLine } from "./normalize.js";

type Raw = [style: string, text: string][];
const K = (key: string, label: string): Raw => [["key", ` ${key} `], ["", ` ${label}   `]];

/** r4 `trunc()`: the segment that does not fit is cut to k−1 chars + "…"; nothing after it. */
function trunc(line: Raw, width: number): Raw {
  const out: Raw = [];
  let n = 0;
  for (const [style, text] of line) {
    const chars = [...text];
    if (n + chars.length <= width) {
      out.push([style, text]);
      n += chars.length;
      continue;
    }
    const k = width - n;
    if (k > 0) out.push([style, `${chars.slice(0, k - 1).join("")}…`]);
    break;
  }
  return out;
}

const toSegments = (raw: Raw): SegmentLine =>
  normalizeCells(raw.flatMap(([style, text]) => [...text].map((ch): Cell => ({ ch, style }))));

/** D6 key bars: the keys r4 shows on each busy screen, with `esc stop` first. */
const BUSY_KEYS: Readonly<Record<string, readonly [string, string][]>> = {
  "flow-pause-02-working": [],
  "flow-images-02-making-them": [],
  "flow-images-06-with-your-codex": [["o", "open in Library"]],
  "region-keybar-busy": []
};

function d6KeyBar(screen: string, cols: number): SegmentLine | null {
  const keys = BUSY_KEYS[screen];
  if (!keys) return null;
  const raw: Raw = [...K("esc", "stop"), ...keys.flatMap(([k, label]) => K(k, label)), ...K("tab", "switch side"), ...K("/", "commands")];
  return toSegments(trunc(raw, cols));
}

const D3_HEADS: readonly [from: string, to: string][] = [["⌘ Cmd+L only", "⌘ Do this in Cmd+L"]];

/** The golden with the binding decisions applied (a copy; the file on disk is r4 as drawn). */
export function applyDecisions(golden: GoldenFile, screen: string): { golden: GoldenFile; applied: string[] } {
  const applied: string[] = [];
  let lines = golden.lines;
  const keybar = d6KeyBar(screen, golden.cols);
  if (keybar) {
    const at = golden.regions?.keybar?.[0] ?? (golden.view_kind === "region" ? 0 : null);
    if (at !== null && at !== undefined) {
      lines = lines.map((line, index) => (index === at ? keybar : line));
      applied.push("D6 esc stop first");
    }
  }
  // The head is the body's first row when wide and sits under the rule when stacked: replace the head segment wherever it is.
  for (const [from, to] of D3_HEADS) {
    if (!lines.some((line) => line.some((segment) => segment.text === from))) continue;
    lines = lines.map((line) => line.map((segment) => (segment.text === from ? { ...segment, text: to } : segment)));
    applied.push(`D3 ${to}`);
  }
  return { golden: applied.length ? { ...golden, lines } : golden, applied };
}
