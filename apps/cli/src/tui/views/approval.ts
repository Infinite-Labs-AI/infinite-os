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
//   `safe_resend`, `r` only for a failed, not-sent `retryable` card. A card
//   brought back re-sends exactly the answers the first approve sent
//   (`ctx.sentFields`), never the card's own fresh answers.
import type {
  AnswerViewV1,
  ApprovalFieldAnswerV1,
  ApprovalFieldV1
} from "@infinite-os/types";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { printableImagesView } from "../../desktop/image-url-cut.js";
import { keyBarHints, okKeyFor, type KeyAction, type KeyContext, type KeyHint } from "../keys/keymap.js";
import { displayWidth, truncateCells } from "../lib/display-width.js";
import {
  beforeAfter,
  BOX_ROWS,
  cardBody,
  cardBox,
  cardWidth,
  chipRows,
  DOCUMENT_MAX_WIDTH,
  fieldRows,
  fitPainted,
  paragraphIn,
  type CardTone
} from "./card.js";
import { changeLines, changeNotes, changeRows, labelValueLines, warningLines } from "./change.js";
import { imagesLines } from "./images.js";
import { jobLines } from "./job.js";
import { launchLines, launchWarningLines } from "./launch.js";
import { offersResend, offersRetry, reconcileLines } from "./outcome.js";
import {
  FootnoteBook,
  formatAsOf,
  formatMoney,
  headLine,
  isRecord,
  paint,
  sourceLine,
  viewText,
  wrapText
} from "./primitives.js";
import { stateHeadFor } from "./states.js";
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

/**
 * A head card's opening key state, from its queue entry: a card brought back
 * shows the answers it sent; a card whose answer the app refused shows the
 * app's words (scrubbed) under its field, with no answer kept.
 */
export function cardUiStart(entry: {
  sentFields?: Readonly<Record<string, ApprovalFieldAnswerV1>>;
  fieldError?: string;
} | null | undefined): CardUiState {
  const fieldError = viewText(entry?.fieldError) || null;
  return {
    ...CARD_UI_START,
    ...(entry?.sentFields ? { answers: { ...entry.sentFields } } : {}),
    ...(fieldError ? { fieldError } : {})
  };
}

export interface ApprovalRenderCtx extends ViewRenderCtx {
  ui: CardUiState;
  /** The desktop takes `fields` on confirm (`confirm.fields.v1`). */
  fieldsCapable: boolean;
  /** Body rows per page while a document is open (the session sizes it to the window). */
  pageRows?: number;
  /**
   * The most rows the whole card (head + frame) may take: the window less the
   * composer, the key bar, the drafts and the live region's floor. A card
   * taller than this pages its middle (rows, the kind's object, details)
   * inside the frame, keeping the head, the title and the footer pinned, so
   * Ink's frame never reaches the window height (no fullscreen redraw, the
   * user's scrollback stays). Absent = no limit.
   */
  maxRows?: number;
  /**
   * A card brought back after an unsure approve: the answers that approve
   * sent. OK again and `r` re-send exactly these.
   */
  sentFields?: Readonly<Record<string, ApprovalFieldAnswerV1>>;
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
  /** What `r` re-sends on a retryable card: the answers the first approve sent. */
  resendFields?: Record<string, ApprovalFieldAnswerV1>;
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
 *
 * The look is r4's: the head and source line, then an amber box (green once
 * done) at most 74 wide, its title in the top border, the change as field
 * rows (`status   on → PAUSED`), the key chips inside (the OK key on amber),
 * and `?  what it does` last. With its documents open (`v`), the card gives
 * way to the document: tabs, a ruled body, and the chips under it.
 */
export function approvalRender(given: AnswerViewV1, ctx: ApprovalRenderCtx): ApprovalRender {
  // An images card never prints a URL, in its body or its approval words.
  const view = printableImagesView(given);
  const paneWidth = Math.max(8, Math.floor(ctx.width));
  const width = cardWidth(paneWidth);
  const inner = width - 4;
  const approval: Record<string, unknown> = isRecord(view.approval) ? view.approval : {};
  const ui = ctx.ui;
  const notes = new FootnoteBook();
  const live = LIVE_STATES.has(view.state);
  // A failed, not-sent retryable card is live again at the app (its handle is
  // pending once more), so its `n` is a real decline.
  const retryable = offersRetry(view);

  const confirmLabel = viewText(approval.confirmLabel, "Confirm");
  const fields = readFields(approval.fields);
  const finishInApp = isRecord(approval.finishInApp) ? approval.finishInApp : null;
  const documents = finishInApp ? [] : readDocuments(view);
  const summary = viewText(approval.summary) || viewText(view.explain);
  const detailRows = readRows(approval.detailRows);
  const blockedByUpdate = live && !ctx.fieldsCapable && fields.some((field) => field.required);
  // `o` (and the body's "(o)") only when the desktop opens app links AND the card has one.
  const canOpen = ctx.caps.open && hasAppLink(view, finishInApp);
  const innerCtx: ViewRenderCtx = { ...ctx, width: inner, caps: { ...ctx.caps, open: canOpen } };
  const sentFields = ctx.sentFields && Object.keys(ctx.sentFields).length ? { ...ctx.sentFields } : undefined;

  const ok = cardOk(view, fields, ui.answers, ctx.fieldsCapable, sentFields);
  const fieldPrompt = ok?.type === "ask_field" ? ok.field : undefined;
  const documentOpen = ui.documentOpen && documents.length > 0;
  // `?` shows what the card does: the app's summary, its detail rows, when it expires.
  const explain = summary !== "" || detailRows.length > 0;
  const expires = live ? formatAsOf(approval.expiresAt, ctx.timeZone) : null;
  const docWidth = Math.max(8, Math.min(DOCUMENT_MAX_WIDTH, paneWidth));

  // ── above the card: the head (· viewing while a document is open) and the source ──
  const paneCtx: ViewRenderCtx = { ...ctx, width: paneWidth };
  const head = headLine(view, paneCtx);
  const source = sourceLine(view, paneCtx);
  const prelude = [
    documentOpen ? viewingHead(head, paneWidth, ctx) : head,
    ...(source ? [source] : []),
    ""
  ];

  // ── the body: a pinned top, a middle that pages, and a pinned footer ──
  const top: string[] = [];
  const middle: string[] = [];
  const footer: string[] = [];
  if (documentOpen) {
    const doc = documents[clampIndex(ui.tab, documents.length)]!;
    const parts = documentParts(doc, documents, ui, { ...innerCtx, width: docWidth });
    top.push(...parts.top);
    middle.push(...parts.body);
  } else {
    const effect = viewText(approval.effect);
    const object = cardObject(view, approval, innerCtx, notes);
    if (effect) {
      top.push(...paragraphIn(effect, inner, "dim", ctx), ...(object.length ? [""] : []));
    }
    middle.push(...object);
    if (ui.explainOpen && explain) {
      middle.push("", ...explainLines(summary, detailRows, expires, innerCtx));
    }
    if (finishInApp) {
      const words = viewText(finishInApp.words);
      if (words) footer.push("", ...arrowLines(words, canOpen, inner, ctx));
    }
    if (fields.length) {
      footer.push("", ...fieldLines(fields, ui, innerCtx));
    }
    if (blockedByUpdate) {
      footer.push(...paragraphIn(UPDATE_FOR_FIELDS, inner, "amber", ctx));
    }
  }
  const reason = isRecord(view.stateReason) ? viewText(view.stateReason.words) : "";
  if (!live && reason) {
    // r4 "Still running": the state's glyph, then the app's words, in amber.
    footer.push("", ...paragraphIn(`${stateHeadFor(view).glyph} ${reason}`, documentOpen ? docWidth : inner, "amber", ctx));
  }
  footer.push(...reconcileLines(view, documentOpen ? { ...innerCtx, width: docWidth } : innerCtx));
  if (documentOpen && ui.explainOpen && explain) {
    footer.push("", ...explainLines(summary, detailRows, expires, { ...innerCtx, width: docWidth }));
  }
  if (notes.size) {
    footer.push("", ...notes.lines().flatMap((line) => paragraphIn(line, inner, "dim", ctx)));
  }

  // ── the keys, drawn inside the card; the page chip only once the body pages ──
  const okKey = ok ? okKeyFor(confirmLabel) : null;
  const keysFor = (paging: boolean): { keyCtx: KeyContext; keys: KeyHint[] } => {
    const keyCtx: KeyContext = {
      focus: "card",
      busy: false,
      okKey,
      okLabel: offersResend(view) ? "check again" : okLabelFor(confirmLabel, fields, ui.answers),
      ...(offersResend(view) ? { okVerb: "check again" } : {}),
      caps: { open: canOpen, watch: false, retry: retryable },
      explain,
      card: {
        view: documents.length > 0,
        viewOpen: documentOpen,
        tabs: documentOpen ? documents.length : 0,
        ...(documentOpen ? tabNounOf(documents) : {}),
        page: paging
      }
    };
    const keys: KeyHint[] = ui.fieldEntry
      ? [{ key: "enter", label: "set" }, { key: "esc", label: "cancel" }]
      : keyBarHints(keyCtx);
    return { keyCtx, keys };
  };
  const openLabel = appLinkLabel(view, finishInApp);
  const chromeRows = prelude.length + (documentOpen ? 0 : BOX_ROWS);
  const draw = (paging: boolean) => {
    const { keyCtx, keys } = keysFor(paging);
    const chips = chipRows(
      cardChips(keys, documentOpen, openLabel, ui.fieldEntry ? null : keyCtx.okKey),
      ui.fieldEntry ? null : keyCtx.okKey,
      documentOpen ? docWidth : inner,
      ctx
    );
    const tail = cardBody([], chips, explain && !documentOpen && !ui.fieldEntry, ctx);
    const paged = pageCardBody({
      top,
      middle,
      footer: [...footer, ...tail],
      page: ui.page,
      // An open document pages at the session's page size even when it would fit.
      pageRows: documentOpen ? ctx.pageRows ?? DEFAULT_PAGE_ROWS : undefined,
      maxRows: typeof ctx.maxRows === "number" ? ctx.maxRows - chromeRows : undefined,
      ctx
    });
    return { keyCtx, keys, paged };
  };
  let drawn = draw(false);
  if (drawn.paged.pages > 1) {
    drawn = draw(true);
  }
  const { keyCtx, keys, paged } = drawn;
  const pages = paged.pages;
  const tone: CardTone = view.state === "done" ? "green" : "amber";
  const title = viewText(approval.title) || viewText(view.title);
  const detail = documentOpen
    ? paged.lines.map((line) => fitPainted(line, docWidth))
    : cardBox(title, paged.lines, width, tone, ctx);

  return {
    head: prelude[0]!,
    source: null,
    detail,
    footnotes: [],
    keys,
    okKey: keyCtx.okKey,
    rowCount: 0,
    ...(documentOpen && documents.length > 1 ? { tabs: documents.length } : {}),
    ...(pages > 1 ? { pages } : {}),
    ...(fieldPrompt ? { fieldPrompt } : {}),
    keyCtx,
    lines: [...prelude, ...detail],
    ok,
    dismiss: live || retryable ? "decline" : "close",
    ...(retryable && sentFields ? { resendFields: sentFields } : {})
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
      // `r` exists only on a card where nothing ran for certain (`retryable`),
      // and re-sends the answers the first approve sent.
      if (!render.keyCtx.caps.retry) return { ui, effect: null };
      const fields = render.resendFields;
      return { ui, effect: { type: "confirm", decision: "approve", ...(fields ? { fields: { ...fields } } : {}) } };
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
 * After an approve, the card to bring back: only when its receipt view says a
 * resend is safe (`outcome_unknown` + `safe_resend`, the app dedupes) or
 * nothing ran (`failed` + `retryable`, the handle is pending again). It keeps
 * the original card's approval words; any other outcome stays a receipt line.
 * `result` is the confirm's result or the error it threw (both carry `view`).
 */
export function resendView(original: AnswerViewV1 | undefined, result: unknown): AnswerViewV1 | null {
  const view = isRecord(result) ? decodeAnswerView(result.view) : null;
  if (!view || !(offersResend(view) || offersRetry(view))) {
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
 * positive amount (`30`, `$30/day`, `42.50`) or one of the field's options by
 * its label or value (never by number); a choice is its number or its label;
 * text is any non-empty line.
 */
export function readFieldAnswer(field: ApprovalFieldV1, text: string): ApprovalFieldAnswerV1 | null {
  const raw = viewText(text);
  if (!raw) {
    return null;
  }
  if (field.input === "money_per_day") {
    // An option the host offers beside the amount ("Let Meta split the budget"),
    // by its label or value. Never by number: "1" is $1/day.
    const wanted = raw.toLowerCase();
    const option = fieldOptions(field).find((item) =>
      viewText(item.label).toLowerCase() === wanted || viewText(item.value).toLowerCase() === wanted);
    if (option) {
      return { choice: option.value };
    }
    if (!acceptsAmount(field)) {
      // No readable currency: the host refuses a typed amount, so only an option answers.
      return null;
    }
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
    const options = fieldOptions(field);
    if (/^\d+$/u.test(raw)) {
      const option = options[Number(raw) - 1];
      return option ? { choice: option.value } : null;
    }
    const wanted = raw.toLowerCase();
    const option = options.find((item) =>
      viewText(item.label).toLowerCase() === wanted || viewText(item.value).toLowerCase() === wanted);
    return option ? { choice: option.value } : null;
  }
  return { text: raw.slice(0, 500) };
}

const RECEIPT_DETAIL_STATES = new Set(["partial", "outcome_unknown", "failed"]);
const RECEIPT_DETAIL_KINDS = new Set(["launch", "change", "images"]);

/**
 * Under a receipt line that is not all done (partial, not sure, failed), the
 * kind's own object: a launch's per-item ✓/✗/?, a change's rows, an image
 * set's items. Never the reconcile step (the receipt line prints it) and never
 * an `(o)` (the transcript takes no keys). Empty for any other receipt.
 */
export function receiptDetailLines(result: unknown, ctx: ViewRenderCtx): string[] {
  const view = printableImagesView(isRecord(result) ? decodeAnswerView(result.view) : null);
  if (!view || !RECEIPT_DETAIL_STATES.has(view.state) || !RECEIPT_DETAIL_KINDS.has(view.kind)) {
    return [];
  }
  const width = Math.max(1, Math.floor(ctx.width));
  const bodyCtx: ViewRenderCtx = { ...ctx, width, caps: { ...ctx.caps, open: false } };
  const notes = new FootnoteBook();
  const lines = kindBody(view, bodyCtx, notes);
  if (notes.size) {
    lines.push(...notes.lines().flatMap((line) => wrapText(line, width)).map((line) => paint(line, "muted", bodyCtx)));
  }
  return lines.map((line) => truncateCells(line, width));
}

// ── helpers ──

function cardOk(
  view: AnswerViewV1,
  fields: readonly ApprovalFieldV1[],
  answers: CardUiState["answers"],
  fieldsCapable: boolean,
  sentFields: Record<string, ApprovalFieldAnswerV1> | undefined
): CardOk | null {
  if (offersResend(view)) {
    // OK again re-sends what the first approve sent, never fresh answers: the
    // app's dedupe matches on them.
    return { type: "approve", ...(sentFields ? { fields: { ...sentFields } } : {}) };
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

/**
 * The OK label once a money value is typed: the app's own verb with the
 * typed value beside it ("Create ad set · $30.00/day"). The terminal never
 * rewrites the app's words: a verb that carries its own amount ("Lower to
 * $30/day") could state the wrong amount or direction for the typed value, so
 * it gives way to the generic "approve · $60.00/day".
 */
function okLabelFor(confirmLabel: string, fields: readonly ApprovalFieldV1[], answers: CardUiState["answers"]): string {
  const field = fields.find((item) => item.input === "money_per_day" && answers[item.key] && "text" in answers[item.key]!);
  const answer = field ? answers[field.key] : undefined;
  if (!field || !answer || !("text" in answer)) return confirmLabel;
  const value = fieldValue(field, answer.text);
  return /\d/u.test(confirmLabel) ? `approve · ${value}` : `${confirmLabel} · ${value}`;
}

/** The card has a place in the app to open: its finishInApp link, its own link, or where a job lands. */
function hasAppLink(view: AnswerViewV1, finishInApp: Record<string, unknown> | null): boolean {
  if (finishInApp && isRecord(finishInApp.appLink)) return true;
  if (isRecord(view.appLink)) return true;
  return view.kind === "job" && isRecord(view.body) && isRecord(view.body.landsAt);
}

/** The noun the document tabs share ("Email 1", "Email 2" → `1-2 email`); none when they differ. */
function tabNounOf(documents: readonly CardDocument[]): { tabNoun?: string } {
  const nouns = new Set(documents.map((doc) => doc.slot.replace(/\s*\d+$/u, "").trim().toLowerCase()));
  const [noun] = [...nouns];
  return nouns.size === 1 && noun ? { tabNoun: noun } : {};
}

function fieldLines(fields: readonly ApprovalFieldV1[], ui: CardUiState, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    const answer = ui.answers[field.key];
    const current = field.current === null || field.current === undefined ? "" : fieldValue(field, field.current);
    const value = ui.fieldEntry?.key === field.key
      ? paint(`▸ type ${fieldHint(field).replace(/^Type:? /u, "")}, then Enter`, "cb", ctx)
      : answer
        ? current ? beforeAfter(current, answerValue(field, answer), ctx) : paint(answerValue(field, answer), "b", ctx)
        : current
          ? `now ${current}${field.required ? paint(" · OK asks for a new value", "dim", ctx) : ""}`
          : paint(field.required ? "OK asks for a value" : "optional", "dim", ctx);
    lines.push(...fieldRows([{ label: viewText(field.label, field.key), value }], ctx.width, ctx));
    // A money field's options (the host's own words) under it: typing one answers it.
    if (field.input === "money_per_day" && !answer) {
      for (const option of fieldOptions(field)) {
        lines.push(...paragraphIn(`  or: ${viewText(option.label, viewText(option.value))}`, ctx.width, "dim", ctx));
      }
    }
  }
  if (ui.fieldError) {
    lines.push(...paragraphIn(ui.fieldError, ctx.width, "amber", ctx));
  }
  return lines;
}

function fieldValue(field: ApprovalFieldV1, value: string): string {
  if (field.input === "money_per_day" && /^\d+(?:\.\d+)?$/u.test(value)) {
    return `${formatMoney(Number(value), typeof field.currency === "string" ? field.currency : null)}/day`;
  }
  if (field.input === "choice") {
    return optionLabel(field, value);
  }
  return viewText(value);
}

/** An answer as words: a choice (on any field) is its option's label, never its raw value. */
function answerValue(field: ApprovalFieldV1, answer: ApprovalFieldAnswerV1): string {
  return "choice" in answer ? optionLabel(field, answer.choice) : fieldValue(field, answer.text);
}

function optionLabel(field: ApprovalFieldV1, value: string): string {
  const option = fieldOptions(field).find((item) => item.value === value);
  return viewText(option?.label, viewText(value));
}

/** The field's options with a string value (a decoded view vouches only for its envelope). */
function fieldOptions(field: ApprovalFieldV1): { value: string; label: string }[] {
  const list: unknown[] = Array.isArray(field.options) ? field.options : [];
  return list.filter(isRecord)
    .filter((item): item is Record<string, unknown> & { value: string } => typeof item.value === "string" && item.value !== "")
    .map((item) => ({ value: item.value, label: viewText(item.label) }));
}

/**
 * Whether a typed amount can answer a money field: not when the host sent no
 * currency but offers options (it refuses a typed amount it cannot read, so
 * only an option answers).
 */
function acceptsAmount(field: ApprovalFieldV1): boolean {
  return (typeof field.currency === "string" && field.currency !== "") || fieldOptions(field).length === 0;
}

function fieldHint(field: ApprovalFieldV1): string {
  if (field.input === "money_per_day") {
    const options = fieldOptions(field).map((item) => viewText(item.label, item.value));
    if (!acceptsAmount(field)) return `Type: ${options.join(" or ")}`;
    return options.length
      ? `Type an amount per day, like 30, or: ${options.join(" or ")}`
      : "Type an amount per day, like 30";
  }
  if (field.input === "choice") {
    const list = fieldOptions(field).map((item, index) => `${index + 1} ${viewText(item.label)}`).join(", ");
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

/**
 * The open document (r4 "Viewing the email"): the tabs (the open one in the
 * brand chip, the others dim), then the subject and the body behind a ruled
 * gutter (`│ `), wrapped inside it. The tabs and subject stay put; the body
 * pages.
 */
function documentParts(
  doc: CardDocument,
  documents: readonly CardDocument[],
  ui: CardUiState,
  ctx: ViewRenderCtx
): { top: string[]; body: string[] } {
  const width = Math.max(4, ctx.width);
  const tabs = documents.map((item, index) => {
    const label = ` ${index + 1} ${item.slot || `${index + 1}`} `;
    return index === clampIndex(ui.tab, documents.length) ? paint(label, "inv", ctx) : paint(label, "dim", ctx);
  });
  const tabLine = fitPainted(tabs.join(" "), width);
  // r4 wraps the ruled line, gutter included, inside the document width less two.
  const gutter = (text: string): string[] => text
    ? wrapText(text, Math.max(1, width - 4)).map((line) => `${paint("│", "line", ctx)} ${line}`)
    : [paint("│", "line", ctx)];
  const body = doc.body
    .split(/\r?\n/u)
    .flatMap((line) => gutter(viewText(line)));
  return {
    top: [tabLine, "", ...gutter(`Subject: ${doc.subject || "—"}`), paint("│", "line", ctx)],
    body
  };
}

/**
 * The framed body, paged to fit. The middle pages when an open document asks
 * for a page size (`pageRows`) or the whole card would pass `maxRows`; the
 * top and footer stay on every page, and a muted `page i of n · space` line
 * closes the middle. A footer too tall to pin pages with the middle (and then
 * the top too), so the card never passes the budget while the budget allows
 * one body row.
 */
function pageCardBody(input: {
  top: readonly string[];
  middle: readonly string[];
  footer: readonly string[];
  page: number;
  pageRows: number | undefined;
  maxRows: number | undefined;
  ctx: ViewRenderCtx;
}): { lines: string[]; pages: number } {
  const budget = typeof input.maxRows === "number" && Number.isFinite(input.maxRows)
    ? Math.max(1, Math.floor(input.maxRows))
    : Number.POSITIVE_INFINITY;
  let top = [...input.top];
  let middle = [...input.middle];
  let footer = [...input.footer];
  const whole = top.length + middle.length + footer.length;
  if (input.pageRows === undefined && whole <= budget) {
    return { lines: whole ? [...top, ...middle, ...footer] : [], pages: 1 };
  }
  // One row for the page line.
  let room = budget - top.length - footer.length - 1;
  if (room < 1) {
    middle = [...middle, ...(middle.length ? [""] : []), ...footer];
    footer = [];
    room = budget - top.length - 1;
  }
  if (room < 1) {
    middle = [...top, ...middle];
    top = [];
    room = budget - 1;
  }
  const size = Math.max(1, Math.min(room, Math.floor(input.pageRows ?? room)));
  const pages = Math.max(1, Math.ceil(middle.length / size));
  if (pages === 1) {
    return { lines: [...top, ...middle, ...footer], pages: 1 };
  }
  const page = Math.min(Math.max(0, Math.floor(input.page)), pages - 1);
  return {
    lines: [
      ...top,
      ...middle.slice(page * size, (page + 1) * size),
      paint(`page ${page + 1} of ${pages} · space`, "dim", input.ctx),
      ...footer
    ],
    pages
  };
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

/**
 * What the card shows of its object (r4): a change's rows as `before → after`
 * (its warnings and a stale "before" with them), a launch's tree, a link's
 * fields, a job's steps. A write the app describes only in its own words (a
 * generic change, a send, an image set) shows `approval.rows`. The title
 * already names the target, so the change's target line is not repeated.
 */
function cardObject(view: AnswerViewV1, approval: Record<string, unknown>, ctx: ViewRenderCtx, notes: FootnoteBook): string[] {
  const rows = readRows(approval.rows);
  const appRows = () => fieldRows(rows, ctx.width, ctx);
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  switch (view.kind) {
    case "change": {
      const target = isRecord(body.target) ? body.target : {};
      const changes = changeRows(body, ctx, notes);
      if (target.kind === "pending_write" || !changes.length) {
        return rows.length ? appRows() : changeLines(view.body, ctx, notes);
      }
      return [...fieldRows(changes, ctx.width, ctx), ...changeNotes(body, ctx)];
    }
    case "launch": {
      const tree: unknown[] = Array.isArray(body.tree) ? body.tree : [];
      if (tree.length || !rows.length) {
        return launchLines(view.body, ctx, notes, view.appLink);
      }
      // A send without a tree: the app's rows (subject, to, from, steps); `v` opens the documents.
      return [...appRows(), ...launchWarningLines(view.body, ctx)];
    }
    case "images":
      return rows.length ? appRows() : imagesLines(view, ctx);
    case "job":
      return jobLines(view.body, ctx);
    case "link":
      return linkCardLines(view.body, ctx);
    default:
      return rows.length ? appRows() : [];
  }
}

/** What `?` opens: the app's summary, its detail rows, and when the card expires. */
function explainLines(
  summary: string,
  detailRows: readonly { label: string; value: string }[],
  expires: string | null,
  ctx: ViewRenderCtx
): string[] {
  return [
    ...(summary ? wrapText(summary, ctx.width) : []),
    ...(detailRows.length ? fieldRows(detailRows, ctx.width, ctx) : []),
    ...(expires ? [paint(`expires ${expires}`, "dim", ctx)] : [])
  ];
}

/** `↗ words  (o)`: where the card is finished in the app; `(o)` only when `o` opens it. */
function arrowLines(words: string, canOpen: boolean, width: number, ctx: ViewRenderCtx): string[] {
  const lines = wrapText(words, Math.max(1, width - 2));
  return lines.map((line, index) => {
    const text = index === 0 ? `${paint("↗", "blue", ctx)} ${line}` : `  ${line}`;
    return index === lines.length - 1 && canOpen ? fitPainted(`${text}  ${paint("(o)", "dim", ctx)}`, width) : text;
  });
}

/** The head with ` · viewing` while a document is open, when it fits. */
function viewingHead(head: string, width: number, ctx: ViewRenderCtx): string {
  const viewing = paint(" · viewing", "dim", ctx);
  return displayWidth(head) + displayWidth(viewing) <= width ? `${head}${viewing}` : head;
}

/** The words of the place `o` opens (`open in Meta Ads`), for its chip. */
function appLinkLabel(view: AnswerViewV1, finishInApp: Record<string, unknown> | null): string {
  const link = finishInApp && isRecord(finishInApp.appLink) ? finishInApp.appLink : isRecord(view.appLink) ? view.appLink : null;
  return viewText(link?.label);
}

/**
 * The chips the card draws: every key the bar offers but `?` (it has its own
 * row), `o` named after the place it opens. With a document open the OK key
 * leads, then the document keys, then `n` (r4 "Viewing the email"); `v close`
 * stays in the key bar only, so the chips keep to one row under the page.
 */
function cardChips(keys: readonly KeyHint[], documentOpen: boolean, openLabel: string, okKey: string | null): KeyHint[] {
  const chips = keys
    .filter((hint) => hint.key !== "?")
    .map((hint) => (hint.key === "o" && openLabel ? { ...hint, label: openLabel } : hint));
  if (!documentOpen) {
    return chips;
  }
  const rank = (hint: KeyHint, index: number): number => {
    if (okKey !== null && hint.key === okKey) return 0;
    if (/^1-\d$/u.test(hint.key)) return 1;
    if (hint.key === "n") return 2;
    if (hint.key === "space") return 3;
    return 10 + index;
  };
  return chips
    .filter((hint) => hint.key !== "v")
    .map((hint, index) => ({ hint, rank: rank(hint, index) }))
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.hint);
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.floor(index)));
}
