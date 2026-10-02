// The link view (terminal-r4 "Link"): a minted link is ONE line with `c copy`
// beside it (a URL too long for the pane is cut on screen; `c` copies it
// whole), then where it goes, its tags and its channel. Warnings print in
// amber. An app place prints `↗ label`, with `(o)` only when the session can
// open the app; a local file prints its name and path (and `c` copies the
// path). A link not minted yet prints its address muted, with nothing to copy.
import { displayWidth, truncateCells } from "../lib/display-width.js";
import { fitLine, isRecord, paint, viewText, wrapText } from "./primitives.js";
import {
  bodyOf,
  clampIndex,
  countOf,
  formatCount,
  labelColumnWidth,
  labelValueLines,
  nextStepLines,
  nextSteps,
  section,
  stringsOf
} from "./things.js";
import type { KindRender, KindRenderer, ViewRenderCtx } from "./types.js";

const COPY_HINT = "c copy";
const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;

export const renderLink: KindRenderer<"link"> = (view, ctx) => {
  const body = bodyOf(view);
  const width = Math.max(1, Math.floor(ctx.width));
  const steps = nextSteps(view);
  const selected = clampIndex(ctx.selected, steps.length);
  const lines: string[] = [];
  let copyText: string | null = null;

  if (body.target === "app_place") {
    const place = isRecord(body.appPlace) ? body.appPlace : null;
    const label = viewText(place?.label);
    const count = countOf(place?.selectionCount);
    if (label) {
      const text = `↗ ${label}${count !== null && count > 0 ? ` · ${formatCount(count)} selected` : ""}${ctx.caps.open ? " (o)" : ""}`;
      lines.push(paint(fitLine(text, width), "primary", ctx));
    }
  } else if (body.target === "local_file") {
    const file = isRecord(body.file) ? body.file : null;
    const name = viewText(file?.name);
    const path = viewText(file?.path);
    const app = viewText(file?.app);
    if (name) {
      lines.push(paint(fitLine(name, width), "text", ctx, { bold: true }));
    }
    if (path) {
      lines.push(copyLine(path, ctx));
      copyText = path;
    }
    if (app) {
      lines.push(paint(fitLine(`opens in ${app}`, width), "muted", ctx));
    }
  } else {
    const address = viewText(body.shortUrl) || viewText(body.url);
    if (address && body.minted === true) {
      lines.push(copyLine(address, ctx));
      copyText = address;
    } else if (address) {
      lines.push(paint(fitLine(address, width), "muted", ctx));
    }
    const rows = [
      { label: "to", value: viewText(body.finalUrl) },
      ...UTM_KEYS.map((key) => ({ label: key, value: isRecord(body.utm) ? viewText(body.utm[key]) : "" })),
      { label: "channel", value: viewText(body.ga4Channel) }
    ].filter((row) => row.value !== "" && row.value !== address);
    if (rows.length) {
      const labelWidth = labelColumnWidth(rows.map((row) => row.label), width);
      section(lines, rows.flatMap((row) => labelValueLines(row.label, row.value, labelWidth, ctx)));
    }
  }

  const warnings = stringsOf(body.warnings);
  if (warnings.length) {
    section(lines, warnings.flatMap((warning) => wrapText(`! ${warning}`, width).map((line) => paint(line, "warning", ctx))));
  }
  section(lines, nextStepLines(steps, 0, selected, ctx));

  const render: KindRender = {
    detail: lines,
    footnotes: [],
    keys: [],
    okKey: null,
    rowCount: steps.length,
    rowAsks: steps.map((step) => step.ask)
  };
  return copyText ? { ...render, copyText } : render;
};

/** `<text>  c copy` on one line: the text is cut to make room, never wrapped. */
function copyLine(text: string, ctx: ViewRenderCtx): string {
  const width = Math.max(1, Math.floor(ctx.width));
  const room = width - displayWidth(COPY_HINT) - 2;
  if (room < 4) {
    return paint(fitLine(text, width), "primary", ctx);
  }
  const shown = truncateCells(text, room);
  return `${paint(shown, "primary", ctx, { bold: true })}  ${paint(COPY_HINT, "muted", ctx)}`;
}
