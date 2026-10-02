// The images view (terminal-r4 "Images"): the terminal never draws pictures
// and never prints an image URL. It shows count, cost and progress, one row
// per image (`✓ 1  Explained  4:5`), then the link to where they already are.
// Who pays comes from `cost.whoPays`: made with the user's own plan, it is $0
// to Infinite.
import type { AnswerViewEnvelopeV1, AnswerViewV1, CreativeDraftFrameV1 } from "@infinite-os/types";

import { cutUrls } from "../../desktop/image-url-cut.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { linkWords, paragraphIn } from "./card.js";
import { afterwordLines, isSettledWithoutRunning } from "./outcome.js";
import { formatMoney, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** Each image's mark (r4): ✓ green, a cyan spinner while drawn, a dim dot while queued, ✗ red. */
const ITEM_MARK: Record<string, { glyph: string; token: "green" | "cyan" | "dim" | "red" }> = {
  done: { glyph: "✓", token: "green" },
  drawing: { glyph: "⠋", token: "cyan" },
  queued: { glyph: "·", token: "dim" },
  failed: { glyph: "✗", token: "red" }
};

const RUNNING_STATES = new Set(["working", "applying", "background"]);

export function renderImages(view: AnswerViewEnvelopeV1<"images">, ctx: ViewRenderCtx): KindRender {
  const detail = isSettledWithoutRunning(view) ? afterwordLines(view, ctx) : imagesLines(view, ctx);
  const keys = view.appLink && ctx.caps.open ? [{ key: "o", label: "open" }] : [];
  const items: unknown[] = isRecord(view.body) && Array.isArray(view.body.items) ? view.body.items : [];
  return { detail, footnotes: [], keys, okKey: null, rowCount: items.length };
}

type ImagesViewLike = Pick<AnswerViewV1, "body"> & Partial<Pick<AnswerViewV1, "state" | "cost" | "appLink" | "receipt">>;

/**
 * The images body, cost and link as lines (shared with the approval card), by
 * state (r4 "Make creatives"):
 * - running: `⠋ Making 3 images · ~25 s left` in cyan, then one row per image;
 * - partial: the rows (the shell prints how many landed), then the link;
 * - done with the app's receipt: its sentence in bold green, then the link;
 * - otherwise: `3 of 3 ready · 4:5`, the rows with their ratio, the link, and
 *   what it costs.
 */
export function imagesLines(view: ImagesViewLike, ctx: ViewRenderCtx): string[] {
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  const lines: string[] = [];
  const requested = count(body.requested);
  const ready = count(body.ready);
  const failed = count(body.failed);
  const aspect = imageText(body.aspectRatio);
  const list: unknown[] = Array.isArray(body.items) ? body.items : [];
  const items = list.filter(isRecord);
  const receipt = isRecord(view.receipt) ? viewText(view.receipt.sentence) : "";
  const running = RUNNING_STATES.has(String(view.state));
  const link = linkLines(view.appLink, ctx);

  if (running) {
    lines.push(...paragraphIn(runningWords(body, view.cost, requested, ready + failed), ctx.width, "cyan", ctx));
    if (items.length) lines.push("", ...itemLines(items, "", ctx, true));
    // On Infinite's model they land when made; a Codex run already shows where they go.
    if (link.length && body.madeWith === "your_codex") lines.push("", ...link);
    return lines;
  }
  if (view.state === "partial") {
    lines.push(...itemLines(items, "", ctx));
    if (link.length) lines.push("", ...link);
    return lines;
  }
  if (view.state === "done" && receipt) {
    lines.push(...paragraphIn(`✓ ${imageText(receipt)}`, ctx.width, "gb", ctx));
    if (link.length) lines.push("", ...link);
    return lines;
  }

  const summary = requested > 0 ? `${ready} of ${requested} ready` : "";
  const facts = [failed > 0 ? `${failed} failed` : "", aspect].filter(Boolean).join(" · ");
  if (summary || facts) {
    const head = summary ? paint(summary, "b", ctx) : "";
    const tail = facts ? paint(summary ? `· ${facts}` : facts, "dim", ctx) : "";
    lines.push(...wrapText([head, tail].filter(Boolean).join("  "), ctx.width));
  }
  if (items.length) {
    lines.push(...(lines.length ? [""] : []), ...itemLines(items, aspect, ctx));
  }
  if (link.length) lines.push("", ...link);
  if (items.some((item) => item.status === "done")) {
    lines.push(paint("Pictures can't show in a terminal.", "dim", ctx));
  }
  const cost = costWords(view.cost, body.madeWith, requested, imageText(body.model));
  if (cost) {
    lines.push("", ...paragraphIn(cost, ctx.width, "dim", ctx));
  }
  return lines;
}

/**
 * One row per image: `✓ 1  Explained` (its ratio after, in dim, once ready), a
 * failure's reason after. While they are made, the first queued image says `· next`.
 */
function itemLines(items: readonly Record<string, unknown>[], aspect: string, ctx: ViewRenderCtx, making = false): string[] {
  const labels = items.map((item) => imageText(item.label, "—"));
  const next = making ? items.findIndex((item) => item.status === "queued") : -1;
  const labelCells = Math.min(24, Math.max(12, ...labels.map(displayWidth)));
  const room = Math.max(1, ctx.width - 2);
  return items.flatMap((item, index) => {
    const mark = ITEM_MARK[String(item.status)] ?? { glyph: "?", token: "dim" as const };
    const label = labels[index] ?? "—";
    const failure = item.status === "failed" ? imageText(item.failureWords) : "";
    const after = [aspect, failure ? `· ${failure}` : ""].filter(Boolean).join("  ");
    // r4: `· 3  3 fixes · next`, one space before the dot.
    const shown = index === next ? `${label} · next` : label;
    const name = aspect ? padEndCells(`${index + 1}  ${shown}`, labelCells + 5) : `${index + 1}  ${shown}${after ? "  " : ""}`;
    const glyph = paint(mark.glyph, mark.token, ctx);
    const queued = item.status === "queued";
    if (displayWidth(name) + displayWidth(after) <= room) {
      return [queued
        ? `${glyph} ${paint(`${name}${after}`.trimEnd(), "dim", ctx)}`
        : `${glyph} ${name}${after ? paint(after, "dim", ctx) : ""}`];
    }
    return wrapText(`${name}${after}`, room).map((line, row) => {
      const text = queued ? paint(line, "dim", ctx) : line;
      return row === 0 ? `${glyph} ${text}` : `  ${text}`;
    });
  });
}

/** `⠋ Making 3 images · ~25 s left`, with your own plan: `· $0 to Infinite`. */
function runningWords(body: Record<string, unknown>, cost: unknown, requested: number, finished: number): string {
  const noun = requested === 1 ? "image" : "images";
  const own = body.madeWith === "your_codex";
  const model = imageText(body.model);
  const making = `⠋ Making ${requested > 0 ? `${requested} ` : ""}${noun}${own ? ` with ${model || "your Codex"}` : ""}`;
  const eta = isRecord(body.eta) && typeof body.eta.etaMs === "number" && body.eta.etaMs > 0 ? body.eta.etaMs : null;
  const left = eta !== null && finished < requested ? `~${secondsWords(eta)} left` : "";
  const free = isRecord(cost) && (cost.whoPays === "your_chatgpt_plan" || cost.whoPays === "your_google_key") ? "$0 to Infinite" : "";
  return [making, left, free].filter(Boolean).join(" · ");
}

/** The link to where the images are: cyan and underlined with `↗`, `(o)` when `o` opens it. */
function linkLines(appLink: unknown, ctx: ViewRenderCtx): string[] {
  const label = isRecord(appLink) ? imageText(appLink.label) : "";
  if (!label) {
    return [];
  }
  return [`${linkWords(label, ctx)}${ctx.caps.open ? `  ${paint("(o)", "dim", ctx)}` : ""}`];
}

/**
 * Who pays, from `cost.whoPays`. The user's own plan or key: `$0 to Infinite`.
 * Infinite: `About $0.52 for 3, on <model>` (`About` when estimated). A null
 * amount is never $0: it prints its reason, or nothing.
 */
function costWords(cost: unknown, madeWith: unknown, requested: number, model: string): string {
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
    const amount = formatMoney(cost.usd, "USD");
    const forHowMany = requested > 0 ? ` for ${requested}` : "";
    return `${own}${cost.estimate === true ? "About " : ""}${amount}${forHowMany}, on ${model || "Infinite"}`;
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
