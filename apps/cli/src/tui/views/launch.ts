// The launch view (terminal-r4 "Launch"): new things go out. The terminal
// shows the tree (Campaign / └ Ad set / └ Ads), who it reaches, the documents
// a send carries (slot · subject; `v` on the card opens the bodies), and after
// the fact what landed: ✓ done, ✗ failed, ? not sure. Pictures never draw here;
// a launch with pictures says they stay in the app.
//
// r4's look: level words plain and names bold white in one column, `NEW` in
// bold green before what the launch creates, `↗` in blue for what stays in
// the app; once done, the app's receipt sentence in bold green; once settled
// without running, only the afterword (`outcome.ts`).
import type { AnswerViewEnvelopeV1, AnswerViewV1 } from "@infinite-os/types";

import { chipRows, paragraphIn } from "./card.js";
import { labelValueLines, warningLines } from "./change.js";
import { afterwordLines, isSettledWithoutRunning } from "./outcome.js";
import { cellText, FootnoteBook, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** Tree depth drawn; deeper levels are cut (the contract has three levels). */
const MAX_TREE_DEPTH = 4;
const LEVEL_WORDS: Record<string, { one: string; many: string }> = {
  campaign: { one: "Campaign", many: "Campaigns" },
  adset: { one: "Ad set", many: "Ad sets" },
  ad: { one: "Ad", many: "Ads" }
};

export function renderLaunch(view: AnswerViewEnvelopeV1<"launch">, ctx: ViewRenderCtx): KindRender {
  const notes = new FootnoteBook();
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  const results: unknown[] = Array.isArray(body.results) ? body.results : [];
  return {
    detail: launchViewLines(view, ctx, notes),
    footnotes: notes.lines(),
    keys: [],
    okKey: null,
    rowCount: results.length
  };
}

function launchViewLines(view: AnswerViewV1, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  if (isSettledWithoutRunning(view)) {
    return afterwordLines(view, ctx);
  }
  const receipt = isRecord(view.receipt) ? view.receipt : null;
  const sentence = viewText(receipt?.sentence);
  if (view.state === "done" && sentence) {
    // r4 "Done": the app's receipt, word for word, in bold green; then what landed.
    const body = isRecord(view.body) ? view.body : {};
    const link = isRecord(view.appLink) ? view.appLink : null;
    const chips = ctx.caps.open && link
      ? chipRows([{ key: "o", label: viewText(link.label, "open in the app") }], null, ctx.width, ctx)
      : [];
    return [
      ...paragraphIn(`✓ ${sentence}`, ctx.width, "gb", ctx),
      ...resultLines(body, ctx),
      ...(chips.length ? ["", ...chips] : [])
    ];
  }
  return launchLines(view.body, ctx, notes, view.appLink);
}

/**
 * The launch body as lines (shared with the approval card). `appLink` is the
 * view's: with pictures in the app, `↗` says where they are and `(o)` opens it.
 */
export function launchLines(body: unknown, ctx: ViewRenderCtx, notes: FootnoteBook, appLink?: unknown): string[] {
  const record = isRecord(body) ? body : {};
  const lines: string[] = [];

  const tree: unknown[] = Array.isArray(record.tree) ? record.tree : [];
  lines.push(...treeLines(tree, 0, ctx));

  const audience = isRecord(record.audience) ? record.audience : null;
  if (audience) {
    lines.push(...audienceLines(audience, ctx, notes));
  }

  lines.push(...documentListLines(record.documents, ctx));

  if (record.picturesInApp === true) {
    const opens = ctx.caps.open && isRecord(appLink);
    if (lines.length) lines.push("");
    lines.push(`${paint("↗", "blue", ctx)} Pictures show in the app.${opens ? `  ${paint("(o)", "dim", ctx)}` : ""}`);
  }

  lines.push(...resultLines(record, ctx));
  return lines;
}

/** What landed, one line each (`✓ name`, `✗ name · why`, `? name`), then the counts in dim. */
function resultLines(record: Record<string, unknown>, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [];
  const results: unknown[] = Array.isArray(record.results) ? record.results : [];
  for (const result of results.filter(isRecord)) {
    const mark = result.status === "done" ? { glyph: "✓", token: "green" as const }
      : result.status === "failed" ? { glyph: "✗", token: "red" as const }
        : { glyph: "?", token: "amber" as const };
    const extra = viewText(result.status === "failed" ? result.error : result.detail);
    const wrapped = wrapText(`${viewText(result.name, "—")}${extra ? ` · ${extra}` : ""}`, Math.max(1, ctx.width - 2));
    wrapped.forEach((line, index) => {
      lines.push(index === 0 ? `${paint(mark.glyph, mark.token, ctx)} ${line}` : `  ${line}`);
    });
  }
  const counts = isRecord(record.counts) ? record.counts : null;
  if (counts) {
    const parts = [
      countWords(counts.done, "done"),
      countWords(counts.failed, "failed"),
      countWords(counts.unknown, "not sure")
    ].filter(Boolean);
    if (parts.length) {
      lines.push(paint(parts.join(" · "), "dim", ctx));
    }
  }
  return lines;
}

/** `1  Email 1 · Subject` per document (the card's list before `v` opens them). */
export function documentListLines(documents: unknown, ctx: ViewRenderCtx): string[] {
  const list: unknown[] = Array.isArray(documents) ? documents : [];
  return list.filter(isRecord).flatMap((doc, index) => {
    const words = [viewText(doc.slot), viewText(doc.subject)].filter(Boolean).join(" · ");
    return wrapText(`${index + 1}  ${words || "—"}`, ctx.width);
  });
}

function audienceLines(audience: Record<string, unknown>, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  // A null count was not counted; it is never 0 people.
  const count = typeof audience.count === "number" && Number.isFinite(audience.count)
    ? `${cellText({ value: audience.count }, "count", null, notes)} people`
    : "not counted";
  const basis = viewText(audience.basis);
  const rows = [{ label: "to", value: [count, basis].filter(Boolean).join(" · ") }];
  const excluded: unknown[] = Array.isArray(audience.excluded) ? audience.excluded : [];
  for (const item of excluded.filter(isRecord)) {
    if (typeof item.count === "number" && Number.isFinite(item.count)) {
      rows.push({ label: "", value: `${item.count} left out · ${viewText(item.reason, "—")}` });
    }
  }
  const from = viewText(audience.fromLine);
  if (from) {
    rows.push({ label: "from", value: from });
  }
  return [...labelValueLines(rows, ctx), ...senderLines(audience, ctx)];
}

function senderLines(audience: Record<string, unknown>, ctx: ViewRenderCtx): string[] {
  return audience.senderVerified === false || viewText(audience.senderHold)
    ? warningLines([viewText(audience.senderHold, "The sender is not verified yet.")], ctx)
    : [];
}

/**
 * What a send card must say even when it shows the app's own rows instead of
 * the audience: a sender that is not verified yet, or is held.
 */
export function launchWarningLines(body: unknown, ctx: ViewRenderCtx): string[] {
  const record = isRecord(body) ? body : {};
  return isRecord(record.audience) ? senderLines(record.audience, ctx) : [];
}

function treeLines(nodes: readonly unknown[], depth: number, ctx: ViewRenderCtx): string[] {
  if (depth >= MAX_TREE_DEPTH) {
    return [];
  }
  const lines: string[] = [];
  const records = nodes.filter(isRecord);
  // Leaf siblings of one level fold onto one line: "└ Ads   Hook A · Hook B".
  const leaves = records.filter((node) => !hasChildren(node));
  const foldable = leaves.length > 1 && leaves.length === records.length
    && leaves.every((node) => node.level === leaves[0]?.level);
  const prefix = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
  if (foldable) {
    const words = LEVEL_WORDS[String(leaves[0]?.level)]?.many ?? "Items";
    const allNew = leaves.every(isNew);
    const names = leaves.map((node) => `${!allNew && isNew(node) ? "NEW " : ""}${viewText(node.name, "—")}`).join(" · ");
    lines.push(...nodeLine(prefix, words, names, allNew, ctx));
    return lines;
  }
  for (const node of records) {
    const words = LEVEL_WORDS[String(node.level)]?.one ?? "Item";
    lines.push(...nodeLine(prefix, words, viewText(node.name, "—"), isNew(node), ctx));
    const fields: unknown[] = Array.isArray(node.fields) ? node.fields : [];
    const indent = " ".repeat(prefix.length + 2);
    for (const field of fields.filter(isRecord)) {
      const text = `${viewText(field.label)}  ${viewText(field.value)}`.trim();
      if (text) {
        lines.push(...wrapText(text, Math.max(1, ctx.width - indent.length)).map((line) => `${indent}${paint(line, "dim", ctx)}`));
      }
    }
    lines.push(...treeLines(Array.isArray(node.children) ? node.children : [], depth + 1, ctx));
  }
  return lines;
}

function nodeLine(prefix: string, level: string, name: string, created: boolean, ctx: ViewRenderCtx): string[] {
  // The level words pad to one column ("Ad set" is the longest), as r4 draws.
  const head = `${prefix}${level.padEnd(Math.max(level.length + 2, "Ad set".length))}`;
  const mark = created ? "NEW " : "";
  const room = Math.max(1, ctx.width - head.length - mark.length);
  const names = wrapText(name, room);
  return names.map((line, index) => index === 0
    ? `${head}${mark ? paint(mark, "gb", ctx) : ""}${paint(line, "b", ctx)}`
    : `${" ".repeat(head.length + mark.length)}${paint(line, "b", ctx)}`);
}

function hasChildren(node: Record<string, unknown>): boolean {
  return Array.isArray(node.children) && node.children.length > 0;
}

/** A node this launch creates (`status: "new"`). */
function isNew(node: Record<string, unknown>): boolean {
  return node.status === "new";
}

function countWords(value: unknown, words: string): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${value} ${words}` : "";
}
