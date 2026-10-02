// The images view (terminal-r4 "Images"): the terminal never draws pictures
// and never prints an image URL. It shows count, cost and progress, one row
// per image (`✓ 1  Explained  4:5`), then the link to where they already are.
// Who pays comes from `cost.whoPays`: made with the user's own plan, it is $0
// to Infinite.
import type { AnswerViewEnvelopeV1, CreativeDraftFrameV1 } from "@infinite-os/types";

import { cutUrls } from "../../desktop/image-url-cut.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { formatMoney, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

const ITEM_MARK: Record<string, { glyph: string; role: "success" | "primary" | "muted" | "error" }> = {
  done: { glyph: "✓", role: "success" },
  drawing: { glyph: "◑", role: "primary" },
  queued: { glyph: "·", role: "muted" },
  failed: { glyph: "✗", role: "error" }
};

export function renderImages(view: AnswerViewEnvelopeV1<"images">, ctx: ViewRenderCtx): KindRender {
  const detail = imagesLines(view, ctx);
  const keys = view.appLink && ctx.caps.open ? [{ key: "o", label: "open" }] : [];
  const items: unknown[] = isRecord(view.body) && Array.isArray(view.body.items) ? view.body.items : [];
  return { detail, footnotes: [], keys, okKey: null, rowCount: items.length };
}

/** The images body, cost and link as lines (shared with the approval card). */
export function imagesLines(view: { body: unknown; cost?: unknown; appLink?: unknown }, ctx: ViewRenderCtx): string[] {
  const body = isRecord(view.body) ? view.body : {};
  const lines: string[] = [];
  const requested = count(body.requested);
  const ready = count(body.ready);
  const failed = count(body.failed);
  const aspect = imageText(body.aspectRatio);
  const summary = [
    requested > 0 ? `${ready} of ${requested} ready` : "",
    failed > 0 ? `${failed} failed` : "",
    aspect,
    imageText(body.model)
  ].filter(Boolean).join(" · ");
  if (summary) {
    lines.push(...wrapText(summary, ctx.width).map((line) => paint(line, "text", ctx, { bold: true })));
  }
  const eta = isRecord(body.eta) && typeof body.eta.etaMs === "number" && body.eta.etaMs > 0 ? body.eta.etaMs : null;
  if (eta !== null && ready + failed < requested) {
    lines.push(paint(`about ${secondsWords(eta)} left`, "muted", ctx));
  }

  const items = (Array.isArray(body.items) ? body.items : []).filter(isRecord);
  const labels = items.map((item) => imageText(item.label, "—"));
  const labelCells = Math.min(24, Math.max(0, ...labels.map(displayWidth)));
  items.forEach((item, index) => {
    const mark = ITEM_MARK[String(item.status)] ?? { glyph: "?", role: "muted" as const };
    const failure = item.status === "failed" ? imageText(item.failureWords) : "";
    const words = `${index + 1}  ${padEndCells(labels[index] ?? "—", labelCells)}  ${aspect}`.trimEnd()
      + (failure ? ` · ${failure}` : "");
    const wrapped = wrapText(words, Math.max(1, ctx.width - 2));
    wrapped.forEach((line, row) => {
      lines.push(row === 0 ? `${paint(mark.glyph, mark.role, ctx)} ${line}` : `  ${line}`);
    });
  });

  const cost = costWords(view.cost, body.madeWith);
  if (cost) {
    lines.push(...wrapText(cost, ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  const link = isRecord(view.appLink) ? imageText(view.appLink.label) : "";
  if (link) {
    lines.push(...wrapText(`↗ ${link}${ctx.caps.open ? " (o)" : ""}`, ctx.width).map((line) => paint(line, "primary", ctx)));
  }
  if (items.some((item) => item.status === "done")) {
    lines.push(paint("Pictures show in the app.", "muted", ctx));
  }
  return lines;
}

/**
 * Who pays, from `cost.whoPays`. The user's own plan or key: `$0 to Infinite`.
 * Infinite: the amount (`~` when estimated). A null amount is never $0: it
 * prints its reason, or nothing.
 */
function costWords(cost: unknown, madeWith: unknown): string {
  if (!isRecord(cost)) {
    return "";
  }
  const own = madeWith === "your_codex" ? "with your Codex · " : "";
  if (cost.whoPays === "your_chatgpt_plan" || cost.whoPays === "your_google_key") {
    return `${own}$0 to Infinite`;
  }
  if (cost.whoPays !== "infinite") {
    return "";
  }
  if (typeof cost.usd === "number" && Number.isFinite(cost.usd)) {
    return `${own}${cost.estimate === true ? "~" : ""}${formatMoney(cost.usd, "USD")} on Infinite`;
  }
  const reason = isRecord(cost.reason) ? viewText(cost.reason.words) : "";
  return reason ? `${own}cost: ${reason}` : "";
}

/**
 * The line a `creative.draft` frame prints while images are made (Codex or
 * Infinite): `Drawing 3 images · ~25 s`. With `nowMs` the time is what is
 * left; without it, the estimate. Done and error frames say so.
 */
export function creativeDraftLine(frame: CreativeDraftFrameV1, nowMs?: number): string {
  const n = count(frame.count);
  const noun = n === 1 ? "image" : "images";
  if (frame.status === "done") {
    return `✓ ${n} ${noun} ready`;
  }
  if (frame.status === "error") {
    // A provider error can name an image URL: it is cut like any image text.
    return `✗ ${imageText(frame.error?.message, "Couldn't make the images.")}`;
  }
  const pending = Array.isArray(frame.pending) ? frame.pending.filter(isRecord) : [];
  const left = pending
    .map((item) => {
      const eta = typeof item.etaMs === "number" && Number.isFinite(item.etaMs) ? item.etaMs : null;
      if (eta === null) return null;
      const started = typeof item.startedAtMs === "number" && Number.isFinite(item.startedAtMs) ? item.startedAtMs : null;
      return nowMs !== undefined && started !== null ? started + eta - nowMs : eta;
    })
    .filter((ms): ms is number => ms !== null);
  const remaining = left.length ? Math.max(...left) : null;
  return remaining !== null && remaining > 0
    ? `Drawing ${n} ${noun} · ~${secondsWords(remaining)}`
    : `Drawing ${n} ${noun}`;
}

function secondsWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** Scrubbed image text with anything URL-shaped cut out. */
function imageText(value: unknown, fallback = ""): string {
  const text = cutUrls(viewText(value));
  return text || fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
