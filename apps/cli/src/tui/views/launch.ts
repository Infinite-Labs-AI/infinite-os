// The launch view (terminal-r4 "Launch"): new things go out. The terminal
// shows the tree (Campaign / └ Ad set / └ Ads), who it reaches, the documents
// a send carries (slot · subject; `v` on the card opens the bodies), and after
// the fact what landed: ✓ done, ✗ failed, ? not sure. Pictures never draw here;
// a launch with pictures says they stay in the app.
import type { AnswerViewEnvelopeV1 } from "@infinite-os/types";

import { labelValueLines, warningLines } from "./change.js";
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
    detail: launchLines(view.body, ctx, notes),
    footnotes: notes.lines(),
    keys: [],
    okKey: null,
    rowCount: results.length
  };
}

/** The launch body as lines (shared with the approval card). */
export function launchLines(body: unknown, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
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
    lines.push(paint("Pictures show in the app.", "muted", ctx));
  }

  const results: unknown[] = Array.isArray(record.results) ? record.results : [];
  for (const result of results.filter(isRecord)) {
    const mark = result.status === "done" ? { glyph: "✓", role: "success" as const }
      : result.status === "failed" ? { glyph: "✗", role: "error" as const }
        : { glyph: "?", role: "warning" as const };
    const extra = viewText(result.status === "failed" ? result.error : result.detail);
    const words = `${mark.glyph} ${viewText(result.name, "—")}${extra ? ` · ${extra}` : ""}`;
    lines.push(...wrapText(words, ctx.width).map((line, index) => index === 0 ? paint(line, mark.role, ctx) : line));
  }
  const counts = isRecord(record.counts) ? record.counts : null;
  if (counts) {
    const parts = [
      countWords(counts.done, "done"),
      countWords(counts.failed, "failed"),
      countWords(counts.unknown, "not sure")
    ].filter(Boolean);
    if (parts.length) {
      lines.push(paint(parts.join(" · "), "muted", ctx));
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
  const lines = labelValueLines(rows, ctx);
  if (audience.senderVerified === false || viewText(audience.senderHold)) {
    lines.push(...warningLines([viewText(audience.senderHold, "The sender is not verified yet.")], ctx));
  }
  return lines;
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
    lines.push(...nodeLine(prefix, words, leaves.map((node) => viewText(node.name, "—")).join(" · "), ctx));
    return lines;
  }
  for (const node of records) {
    const words = LEVEL_WORDS[String(node.level)]?.one ?? "Item";
    lines.push(...nodeLine(prefix, words, viewText(node.name, "—"), ctx));
    const fields: unknown[] = Array.isArray(node.fields) ? node.fields : [];
    const indent = " ".repeat(prefix.length + 2);
    for (const field of fields.filter(isRecord)) {
      const text = `${viewText(field.label)}  ${viewText(field.value)}`.trim();
      if (text) {
        lines.push(...wrapText(text, Math.max(1, ctx.width - indent.length)).map((line) => paint(`${indent}${line}`, "muted", ctx)));
      }
    }
    lines.push(...treeLines(Array.isArray(node.children) ? node.children : [], depth + 1, ctx));
  }
  return lines;
}

function nodeLine(prefix: string, level: string, name: string, ctx: ViewRenderCtx): string[] {
  // The level words pad to one column ("Ad set" is the longest), as r4 draws.
  const head = `${prefix}${level.padEnd(Math.max(level.length + 2, "Ad set".length))}`;
  const room = Math.max(1, ctx.width - head.length);
  const names = wrapText(name, room);
  return names.map((line, index) => index === 0
    ? `${paint(head, "muted", ctx)}${paint(line, "text", ctx, { bold: true })}`
    : `${" ".repeat(head.length)}${paint(line, "text", ctx, { bold: true })}`);
}

function hasChildren(node: Record<string, unknown>): boolean {
  return Array.isArray(node.children) && node.children.length > 0;
}

function countWords(value: unknown, words: string): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${value} ${words}` : "";
}
