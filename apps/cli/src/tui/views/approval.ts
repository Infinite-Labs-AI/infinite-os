// The approval card (terminal-r4 "Needs your OK"): Cmd+L's card, drawn as
// text. Its words are the app's (`approval.title`, `rows`, `confirmLabel`,
// `summary`); the frame, the arrows and the key words are chrome.
//
// The rules this file holds, each pinned by `actions.test.ts`:
// - ONLY the named OK key (the first letter of `confirmLabel`, else `y`)
//   approves, and ONLY `n` dismisses (a real "no" sent to the app). Enter and
//   Esc never do either; `v`, `1`–`9`, space, `e` and `c` never decide.
// - `approval.summary` hides behind `?`.
// - A required field (a daily budget) is asked for before OK sends, and goes
//   out as `fields`. A desktop that cannot take `fields` gets no OK key at all:
//   the card never approves with the frozen value instead of the user's.
// - A send's documents list slot · subject; `v` opens the bodies, `1`–`9`
//   switch, space pages. A withheld body (`finishInApp`) has no `v`.
// - Not sure it happened: the reconcile step shows; OK again only for
//   `safe_resend`, `r` only for `retryable`.
import type {
  AnswerViewV1,
  ApprovalFieldAnswerV1,
  ApprovalFieldV1
} from "@infinite-os/types";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { keyBarHints, okKeyFor, type KeyAction, type KeyContext, type KeyHint } from "../keys/keymap.js";
import { displayWidth, padEndCells, truncateCells } from "../lib/display-width.js";
import { changeLines, labelValueLines, warningLines } from "./change.js";
import { imagesLines } from "./images.js";
import { jobLines } from "./job.js";
import { launchLines } from "./launch.js";
import { offersResend, offersRetry, reconcileLines } from "./outcome.js";
import {
  FootnoteBook,
  formatAsOf,
  formatMoney,
  headLine,
  isRecord,
  paint,
  viewText,
  wrapText
} from "./primitives.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

/** The card's own key state: what is open, which document, which page, and the answers so far. */
export interface CardUiState {
  explainOpen: boolean;
  documentOpen: boolean;
  tab: number;
  page: number;
  answers: Readonly<Record<string, ApprovalFieldAnswerV1>>;
  /** The field being typed (the composer takes the keys until Enter or Esc). */
  fieldEntry: ApprovalFieldV1 | null;
  fieldError: string | null;
}

export const CARD_UI_START: CardUiState = {
  explainOpen: false,
  documentOpen: false,
  tab: 0,
  page: 0,
  answers: {},
  fieldEntry: null,
  fieldError: null
};

export interface ApprovalRenderCtx extends ViewRenderCtx {
  ui: CardUiState;
  /** The desktop takes `fields` on confirm (`confirm.fields.v1`). */
  fieldsCapable: boolean;
  /** Body rows per page while a document is open (the session sizes it to the window). */
  pageRows?: number;
}

/** What the OK key does right now. */
export type CardOk =
  | { type: "approve"; fields?: Record<string, ApprovalFieldAnswerV1> }
  | { type: "ask_field"; field: ApprovalFieldV1 };

export interface ApprovalRender extends ViewRender {
  /** The required field OK asks for next (absent once every one is answered). */
  fieldPrompt?: ApprovalFieldV1;
  /** The card's key context: the session resolves keys with exactly this. */
  keyCtx: KeyContext;
  /** The whole card: the head, then the framed body. */
  lines: string[];
  /** What OK does; null = no OK key (the card can only be dismissed). */
  ok: CardOk | null;
  /** `n` sends a real decline (a live card) or only closes a card already answered. */
  dismiss: "decline" | "close";
}

/** What a card key asks the session to do beyond redrawing. */
export type CardEffect =
  | { type: "confirm"; decision: "approve" | "decline"; fields?: Record<string, ApprovalFieldAnswerV1> }
  | { type: "close" }
  | { type: "open" }
  | { type: "edit" }
  | { type: "copy" };

const DEFAULT_PAGE_ROWS = 12;
const UPDATE_FOR_FIELDS = "Update the Infinite app to set a value here";
const LIVE_STATES = new Set(["needs_yes", "needs_answer"]);

/**
 * Draw the card for an approval view at `ctx.width`, with the card's own key
 * context. Every string from the view is scrubbed; no line is wider than
 * `ctx.width`.
 */
export function approvalRender(view: AnswerViewV1, ctx: ApprovalRenderCtx): ApprovalRender {
  const width = Math.max(8, Math.floor(ctx.width));
  const inner = width - 4;
  const innerCtx: ViewRenderCtx = { ...ctx, width: inner };
  const approval: Record<string, unknown> = isRecord(view.approval) ? view.approval : {};
  const ui = ctx.ui;
  const notes = new FootnoteBook();
  const live = LIVE_STATES.has(view.state);

  const confirmLabel = viewText(approval.confirmLabel, "Confirm");
  const fields = readFields(approval.fields);
  const finishInApp = isRecord(approval.finishInApp) ? approval.finishInApp : null;
  const documents = finishInApp ? [] : readDocuments(view);
  const summary = viewText(approval.summary) || viewText(view.explain);
  const blockedByUpdate = live && !ctx.fieldsCapable && fields.some((field) => field.required);

  const ok = cardOk(view, fields, ui.answers, ctx.fieldsCapable);
  const fieldPrompt = ok?.type === "ask_field" ? ok.field : undefined;
  const documentOpen = ui.documentOpen && documents.length > 0;

  // ── the body ──
  const body: string[] = [];
  let pages = 0;
  if (documentOpen) {
    const doc = documents[clampIndex(ui.tab, documents.length)]!;
    const page = documentPage(doc, documents, ui, innerCtx, ctx.pageRows ?? DEFAULT_PAGE_ROWS);
    body.push(...page.lines);
    pages = page.pages;
  } else {
    const rows = readRows(approval.rows);
    body.push(...labelValueLines(rows, innerCtx));
    const kindLines = kindBody(view, innerCtx, notes);
    if (kindLines.length) {
      if (body.length) body.push("");
      body.push(...kindLines);
    }
    const detailRows = readRows(approval.detailRows);
    if (detailRows.length) {
      body.push("", ...labelValueLines(detailRows, innerCtx));
    }
    const effect = viewText(approval.effect);
    if (effect) {
      body.push(...wrapText(effect, inner).map((line) => paint(line, "warning", ctx)));
    }
    if (finishInApp) {
      const words = viewText(finishInApp.words);
      const link = isRecord(finishInApp.appLink) && ctx.caps.open ? " (o)" : "";
      if (words) body.push("", ...wrapText(`↗ ${words}${link}`, inner).map((line) => paint(line, "primary", ctx)));
    }
    if (fields.length) {
      body.push("", ...fieldLines(fields, ui, innerCtx));
    }
    if (blockedByUpdate) {
      body.push(...wrapText(UPDATE_FOR_FIELDS, inner).map((line) => paint(line, "warning", ctx)));
    }
  }
  const reason = isRecord(view.stateReason) ? viewText(view.stateReason.words) : "";
  if (!live && reason) {
    body.push(...wrapText(reason, inner).map((line) => paint(line, "warning", ctx)));
  }
  body.push(...reconcileLines(view, innerCtx));
  const expires = live ? formatAsOf(approval.expiresAt, ctx.timeZone) : null;
  if (expires && !documentOpen) {
    body.push(paint(`expires ${expires}`, "muted", ctx));
  }
  if (ui.explainOpen && summary) {
    body.push("", ...wrapText(`? ${summary}`, inner).map((line) => paint(line, "muted", ctx)));
  }
  if (notes.size) {
    body.push("", ...notes.lines().flatMap((line) => wrapText(line, inner)).map((line) => paint(line, "muted", ctx)));
  }

  const title = viewText(approval.title) || viewText(view.title);
  const framed = frame(title, body, width, ctx);

  // ── the keys ──
  const keyCtx: KeyContext = {
    focus: "card",
    busy: false,
    okKey: ok ? okKeyFor(confirmLabel) : null,
    okLabel: offersResend(view) ? "check again" : confirmLabel,
    caps: { open: false, watch: false, retry: offersRetry(view) },
    explain: summary !== "",
    card: {
      view: documents.length > 0,
      viewOpen: documentOpen,
      tabs: documentOpen ? documents.length : 0,
      page: documentOpen && pages > 1
    }
  };
  const keys: KeyHint[] = ui.fieldEntry
    ? [{ key: "enter", label: "set" }, { key: "esc", label: "cancel" }]
    : keyBarHints(keyCtx);
  const head = headLine(view, { ...ctx, width });
  return {
    head,
    source: null,
    detail: framed,
    footnotes: [],
    keys,
    okKey: keyCtx.okKey,
    rowCount: 0,
    ...(documentOpen && documents.length > 1 ? { tabs: documents.length } : {}),
    ...(pages > 1 ? { pages } : {}),
    ...(fieldPrompt ? { fieldPrompt } : {}),
    keyCtx,
    lines: [head, ...framed],
    ok,
    dismiss: live ? "decline" : "close"
  };
}

/**
 * One resolved key on the card → the card's next state and what the session
 * does. `ok`/`dismiss`/`retry` are the only actions that ever confirm, and
 * each confirms only what the render offered.
 */
export function cardKeyStep(
  action: KeyAction,
  render: ApprovalRender,
  ui: CardUiState
): { ui: CardUiState; effect: CardEffect | null } {
  switch (action.type) {
    case "ok": {
      const ok = render.ok;
      if (!ok || render.keyCtx.okKey === null) return { ui, effect: null };
      if (ok.type === "ask_field") {
        return { ui: { ...ui, fieldEntry: ok.field, fieldError: null }, effect: null };
      }
      return { ui, effect: { type: "confirm", decision: "approve", ...(ok.fields ? { fields: ok.fields } : {}) } };
    }
    case "dismiss":
      return {
        ui,
        effect: render.dismiss === "decline" ? { type: "confirm", decision: "decline" } : { type: "close" }
      };
    case "retry": {
      // `r` exists only on a card where nothing ran for certain (`retryable`).
      if (!render.keyCtx.caps.retry) return { ui, effect: null };
      const fields = answeredFields(ui.answers);
      return { ui, effect: { type: "confirm", decision: "approve", ...(fields ? { fields } : {}) } };
    }
    case "explain":
      return render.keyCtx.explain ? { ui: { ...ui, explainOpen: !ui.explainOpen }, effect: null } : { ui, effect: null };
    case "view":
      return render.keyCtx.card?.view
        ? { ui: { ...ui, documentOpen: !ui.documentOpen, page: 0 }, effect: null }
        : { ui, effect: null };
    case "tab":
      return render.keyCtx.card?.viewOpen && action.index < (render.keyCtx.card.tabs ?? 0)
        ? { ui: { ...ui, tab: action.index, page: 0 }, effect: null }
        : { ui, effect: null };
    case "page": {
      const pages = render.pages ?? 0;
      return pages > 1 ? { ui: { ...ui, page: (ui.page + 1) % pages }, effect: null } : { ui, effect: null };
    }
    case "open":
    case "edit":
    case "copy":
      return { ui, effect: { type: action.type } };
    default:
      return { ui, effect: null };
  }
}

/**
 * After an approve, the card to bring back when the app is not sure it
 * happened: only when its receipt view says a resend is safe (`safe_resend`,
 * the app dedupes) or nothing ran (`retryable`). It keeps the original card's
 * approval words; any other outcome stays a receipt line.
 */
export function resendView(original: AnswerViewV1 | undefined, result: unknown): AnswerViewV1 | null {
  const view = isRecord(result) ? decodeAnswerView(result.view) : null;
  if (!view || view.state !== "outcome_unknown" || (view.retry !== "safe_resend" && view.retry !== "retryable")) {
    return null;
  }
  const approval = isRecord(view.approval) ? view.approval : original?.approval;
  return isRecord(approval) ? ({ ...view, approval } as AnswerViewV1) : null;
}

/** Enter in a card field: keep a valid answer and close the field, or say what to type. */
export function commitCardField(ui: CardUiState, text: string): { ui: CardUiState; error: string | null } {
  const field = ui.fieldEntry;
  if (!field) {
    return { ui, error: null };
  }
  const answer = readFieldAnswer(field, text);
  if (!answer) {
    const error = fieldHint(field);
    return { ui: { ...ui, fieldError: error }, error };
  }
  return {
    ui: { ...ui, answers: { ...ui.answers, [field.key]: answer }, fieldEntry: null, fieldError: null },
    error: null
  };
}

/** Esc in a card field: close it without an answer (it never declines the card). */
export function cancelCardField(ui: CardUiState): CardUiState {
  return { ...ui, fieldEntry: null, fieldError: null };
}

/**
 * A typed answer for one field, or null when it is not one. Money is a
 * positive amount (`30`, `$30/day`, `42.50`); a choice is its number or its
 * label; text is any non-empty line.
 */
export function readFieldAnswer(field: ApprovalFieldV1, text: string): ApprovalFieldAnswerV1 | null {
  const raw = viewText(text);
  if (!raw) {
    return null;
  }
  if (field.input === "money_per_day") {
    const amount = raw
      .replace(/(?:\/|per)\s*day$/iu, "")
      .replace(/^[A-Z]{3}\s*/u, "")
      .replace(/^[$€£]\s*/u, "")
      .replace(/,/gu, "")
      .trim();
    if (!/^\d+(?:\.\d{1,2})?$/u.test(amount) || Number(amount) <= 0) {
      return null;
    }
    return { text: amount };
  }
  if (field.input === "choice") {
    const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
    if (/^\d+$/u.test(raw)) {
      const option = options[Number(raw) - 1];
      return option && typeof option.value === "string" ? { choice: option.value } : null;
    }
    const wanted = raw.toLowerCase();
    const option = options.find((item) =>
      viewText(item.label).toLowerCase() === wanted || viewText(item.value).toLowerCase() === wanted);
    return option && typeof option.value === "string" ? { choice: option.value } : null;
  }
  return { text: raw.slice(0, 500) };
}

// ── helpers ──

function cardOk(
  view: AnswerViewV1,
  fields: readonly ApprovalFieldV1[],
  answers: CardUiState["answers"],
  fieldsCapable: boolean
): CardOk | null {
  if (offersResend(view)) {
    const sent = answeredFields(answers);
    return { type: "approve", ...(sent ? { fields: sent } : {}) };
  }
  if (!LIVE_STATES.has(view.state)) {
    return null;
  }
  if (!fieldsCapable) {
    // Never approve with the frozen value when the user's answer can't be sent.
    return fields.some((field) => field.required) ? null : { type: "approve" };
  }
  const missing = fields.find((field) => field.required && !answers[field.key]);
  if (missing) {
    return { type: "ask_field", field: missing };
  }
  const sent = answeredFields(
    Object.fromEntries(fields.filter((field) => answers[field.key]).map((field) => [field.key, answers[field.key]!]))
  );
  return { type: "approve", ...(sent ? { fields: sent } : {}) };
}

function answeredFields(answers: CardUiState["answers"]): Record<string, ApprovalFieldAnswerV1> | undefined {
  return Object.keys(answers).length ? { ...answers } : undefined;
}

function fieldLines(fields: readonly ApprovalFieldV1[], ui: CardUiState, ctx: ViewRenderCtx): string[] {
  const rows = fields.map((field) => {
    const answer = ui.answers[field.key];
    const current = field.current === null || field.current === undefined ? "" : fieldValue(field, field.current);
    const value = ui.fieldEntry?.key === field.key
      ? `▸ type ${fieldHint(field).replace(/^Type /u, "")}, then Enter`
      : answer
        ? `${current ? `${current} → ` : ""}${fieldValue(field, "text" in answer ? answer.text : answer.choice)}`
        : current
          ? `now ${current}${field.required ? " · OK asks for a new value" : ""}`
          : field.required ? "OK asks for a value" : "optional";
    return { label: viewText(field.label, field.key), value };
  });
  const lines = labelValueLines(rows, ctx);
  if (ui.fieldError) {
    lines.push(...wrapText(ui.fieldError, ctx.width).map((line) => paint(line, "warning", ctx)));
  }
  return lines;
}

function fieldValue(field: ApprovalFieldV1, value: string): string {
  if (field.input === "money_per_day" && /^\d+(?:\.\d+)?$/u.test(value)) {
    return `${formatMoney(Number(value), typeof field.currency === "string" ? field.currency : null)}/day`;
  }
  if (field.input === "choice") {
    const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
    const option = options.find((item) => item.value === value);
    return viewText(option?.label, viewText(value));
  }
  return viewText(value);
}

function fieldHint(field: ApprovalFieldV1): string {
  if (field.input === "money_per_day") return "Type an amount per day, like 30";
  if (field.input === "choice") {
    const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
    const list = options.map((item, index) => `${index + 1} ${viewText(item.label)}`).join(", ");
    return list ? `Type one of: ${list}` : "Type a choice";
  }
  return "Type a value";
}

function readFields(value: unknown): ApprovalFieldV1[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.filter(isRecord).filter((field) => typeof field.key === "string" && field.key !== "")
    .map((field) => ({ ...field, required: field.required === true }) as unknown as ApprovalFieldV1);
}

function readRows(value: unknown): { label: string; value: string }[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.filter(isRecord).map((row) => ({ label: viewText(row.label), value: viewText(row.value) }));
}

interface CardDocument { slot: string; subject: string; body: string }

function readDocuments(view: AnswerViewV1): CardDocument[] {
  if (view.kind !== "launch" || !isRecord(view.body)) return [];
  const list: unknown[] = Array.isArray(view.body.documents) ? view.body.documents : [];
  return list.filter(isRecord).map((doc) => ({
    slot: viewText(doc.slot),
    subject: viewText(doc.subject),
    body: typeof doc.bodyText === "string" ? doc.bodyText : ""
  }));
}

/** The open document: its tabs, subject and one page of its body. */
function documentPage(
  doc: CardDocument,
  documents: readonly CardDocument[],
  ui: CardUiState,
  ctx: ViewRenderCtx,
  pageRows: number
): { lines: string[]; pages: number } {
  const width = ctx.width;
  const tabs = documents.map((item, index) => {
    const label = ` ${index + 1} ${item.slot || `${index + 1}`} `;
    const selected = index === clampIndex(ui.tab, documents.length);
    if (ctx.color) return paint(label, selected ? "text" : "muted", ctx, { inverse: selected });
    return selected ? `[${label.trim()}]` : label.trim();
  });
  const tabLine = truncateCells(tabs.join(ctx.color ? " " : "  "), width);
  const bodyLines = doc.body
    .split(/\r?\n/u)
    .flatMap((line) => {
      const text = viewText(line);
      return text ? wrapText(text, Math.max(1, width - 2)) : [""];
    })
    .map((line) => paint(line ? `│ ${line}` : "│", "text", ctx));
  const rows = Math.max(1, Math.floor(pageRows));
  const pages = Math.max(1, Math.ceil(bodyLines.length / rows));
  const page = Math.min(Math.max(0, ui.page), pages - 1);
  const lines = [
    tabLine,
    "",
    ...wrapText(`Subject: ${doc.subject || "—"}`, width).map((line) => paint(line, "text", ctx, { bold: true })),
    "",
    ...bodyLines.slice(page * rows, (page + 1) * rows)
  ];
  if (pages > 1) {
    lines.push(paint(`page ${page + 1} of ${pages}`, "muted", ctx));
  }
  return { lines, pages };
}

/** The kind's object inside the card. */
function kindBody(view: AnswerViewV1, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  switch (view.kind) {
    case "change":
      return changeLines(view.body, ctx, notes);
    case "launch":
      return launchLines(view.body, ctx, notes);
    case "images":
      return imagesLines(view, ctx);
    case "job":
      return jobLines(view.body, ctx);
    case "link":
      return linkCardLines(view.body, ctx);
    default:
      return [];
  }
}

/**
 * A link write, read-only (editing UTM fields or the shorten choice stays in
 * Cmd+L for now): the UTM fields, where it points, and its warnings.
 */
function linkCardLines(body: unknown, ctx: ViewRenderCtx): string[] {
  const record = isRecord(body) ? body : {};
  const utm = isRecord(record.utm) ? record.utm : {};
  const rows: { label: string; value: string }[] = (["source", "medium", "campaign", "content", "term"] as const)
    .map((key) => ({ label: key, value: viewText(utm[key]) }))
    .filter((row) => row.value);
  const shortUrl = viewText(record.shortUrl);
  if (shortUrl) rows.push({ label: "short", value: shortUrl });
  return [...labelValueLines(rows, ctx), ...warningLines(record.warnings, ctx)];
}

/** A box with the title in its top border: ┌─ Title ─┐ │ … │ └─┘. */
function frame(title: string, body: readonly string[], width: number, ctx: ViewRenderCtx): string[] {
  const inner = width - 4;
  const shownTitle = title ? truncateCells(title, Math.max(1, width - 6)) : "";
  const titleCells = shownTitle ? displayWidth(shownTitle) + 2 : 0;
  const rule = (text: string) => paint(text, "muted", ctx);
  const top = shownTitle
    ? `${rule("┌─")} ${paint(shownTitle, "text", ctx, { bold: true })} ${rule(`${"─".repeat(Math.max(0, width - 3 - titleCells))}┐`)}`
    : rule(`┌${"─".repeat(width - 2)}┐`);
  const lines = body.length ? body : [""];
  return [
    top,
    ...lines.map((line) => `${rule("│")} ${padEndCells(truncateCells(line, inner), inner)} ${rule("│")}`),
    rule(`└${"─".repeat(width - 2)}┘`)
  ];
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.floor(index)));
}
