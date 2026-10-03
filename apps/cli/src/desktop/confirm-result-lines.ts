/**
 * What the terminal prints after a write card is answered: a receipt, never
 * JSON. And how a typed answer becomes a decision: only `y`/`yes` approves and
 * only `n`/`no` declines (a real decline that reaches the app). Anything else,
 * bare Enter included, never decides: it re-prompts once and then leaves the
 * card pending until it expires.
 *
 * Words: the receipt sentence comes from the app (the receipt view's
 * `receipt.sentence`, or an older app's `receipt` string) and is printed
 * verbatim after the TTY/bidi scrub. The few words here are generic chrome.
 * Used by the Ink session, the readline loop and the one-shot `infinite app`.
 */

import type { AnswerViewState, OutcomeV1 } from "@infinite-os/types";

import { STATE_HEAD, stateHeadFor, type StateTone } from "../tui/views/states.js";
import { decodeAnswerView } from "./answer-view-decode.js";
import { printableImagesView } from "./image-url-cut.js";
import { boundedTerminalText } from "./terminal-text.js";

export type ConfirmLineTone = "ok" | "warn" | "bad" | "muted";
export interface ConfirmLine {
  tone: ConfirmLineTone;
  text: string;
}
export type ConfirmDecision = "approve" | "decline";

const DISMISSED_SENTENCE = "Dismissed — nothing was executed.";
const UNREACHABLE_LINE = "✗ Couldn't reach the app — the card stays until it expires.";
const MAX_LINE_CHARS = 240;
const CODED_NO_MESSAGE_LINE = "The app couldn't confirm this. Check it before trying again.";

/** The receipt states that take the view head's mark. */
const RECEIPT_STATES = new Set<AnswerViewState>([
  "done", "opened_in_app", "background", "partial", "outcome_unknown", "no_change",
  "cancelled", "expired", "failed", "hit_limit", "blocked"
]);

/** A head tone as a receipt line's tone (a job still running reads as ok). */
const LINE_TONE: Record<StateTone, ConfirmLineTone> = {
  ok: "ok", busy: "ok", ask: "warn", warn: "warn", bad: "bad", muted: "muted", cmdl_only: "muted"
};

/**
 * The receipt line's glyph and tone ARE the view head's (`stateHeadFor`, with
 * its refinements: `◑` unknown, an amber `⧗` for a write not sent because it
 * changed on the provider), so a receipt line never disagrees with its head.
 */
function stateMark(view: { state: AnswerViewState; outcome?: OutcomeV1; stateReason?: unknown }): { glyph: string; tone: ConfirmLineTone } | undefined {
  if (!RECEIPT_STATES.has(view.state)) return undefined;
  const head = stateHeadFor(view);
  return { glyph: head.glyph, tone: LINE_TONE[head.tone] };
}

/** The unknown-outcome glyph, shared with the view head (`◑`). */
const UNKNOWN_GLYPH = STATE_HEAD.outcome_unknown.glyph;

/** Receipt states whose reconcile step the receipt prints (and offers as the next ask). */
const UNSURE_STATES = new Set<AnswerViewState>(["outcome_unknown", "partial"]);

/** Codes that mean the confirm never reached the app (so nothing changed). */
const UNREACHABLE_CODES = new Set([
  "desktop_unreachable",
  "desktop_not_running",
  "desktop_auth_failed"
]);

/**
 * Codes where the confirm may already have landed, so the outcome is unknown.
 * `desktop_turn_detached` is the caller giving up after the POST was likely
 * sent ("Provider work may still continue"), so it must never claim nothing ran.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
  "desktop_confirmation_outcome_unknown",
  "desktop_turn_detached"
]);

/** Neutral link fields an older app returns without a view. */
const LINK_FIELDS = ["liveUrl", "shortUrl", "url"] as const;

/**
 * The receipt lines for a resolved card. Prefers the receipt view's sentence;
 * without one (an older app) it reads neutral fields only.
 */
export function confirmResultLines(result: unknown, decision: ConfirmDecision): ConfirmLine[] {
  const record = isRecord(result) ? result : undefined;
  const fromView = receiptViewLines(record?.view, decision);
  if (fromView) return fromView;

  if (decision === "decline") {
    return [{ tone: "muted", text: `✕ ${DISMISSED_SENTENCE}` }];
  }
  const sentence = receiptSentence(record?.receipt);
  const lines: ConfirmLine[] = [{ tone: "ok", text: `✓ ${sentence ?? "Done"}` }];
  for (const link of linkValues(record)) {
    lines.push({ tone: "muted", text: `  ${link}` });
  }
  return lines;
}

/**
 * The lines for a confirm that threw. Only a listed transport code says the
 * card stays; an uncoded error is a bug (the client codes every real transport
 * failure), so it prints its own message rather than hiding as "unreachable".
 * Any other coded app answer without a view prints under a neutral `!`.
 */
export function confirmErrorLines(error: unknown): ConfirmLine[] {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return [{ tone: "bad", text: UNREACHABLE_LINE }];
  }
  // A streamed confirm (confirm.stream.v1) that ended in an error before any
  // receipt, with a code the app sends when nothing ran: not done, never a
  // receipt (T12). The app's words say why (a value it refused, a card gone).
  if (isRecord(error) && error.nothingRan === true) {
    const why = error instanceof Error ? boundedTerminalText(error.message, MAX_LINE_CHARS) : "";
    return [{ tone: "bad", text: `✗ Not done: ${why || "nothing ran."}` }];
  }
  const fromView = receiptViewLines(isRecord(error) ? error.view : undefined, "approve");
  if (fromView) return fromView;
  const message = error instanceof Error ? boundedTerminalText(error.message, MAX_LINE_CHARS) : "";
  if (code !== undefined && UNKNOWN_OUTCOME_CODES.has(code)) {
    return [{ tone: "warn", text: `${UNKNOWN_GLYPH} ${message || "Not sure it happened."}` }];
  }
  if (code !== undefined) {
    // A coded app answer without a decodable view: an older app (no receipt
    // views) reports uncertain dispatches as plain codes such as
    // `dispatch_uncertain`, and its ledger treats every non-success other than
    // proven not-sent as unknown. ✗ is the Failed / Not sent head, so a bare
    // code gets the neutral warn mark and its message verbatim; only a view's
    // own failed / hit_limit / blocked state earns the ✗/$/⊗ heads.
    return [{ tone: "warn", text: `! ${message || CODED_NO_MESSAGE_LINE}` }];
  }
  return [{ tone: "bad", text: `✗ ${message || "Failed."}` }];
}

/** `y`/`yes` approves, `n`/`no` declines, anything else (bare Enter too) is no answer. */
export function readConfirmAnswer(answer: string): ConfirmDecision | null {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return "approve";
  if (normalized === "n" || normalized === "no") return "decline";
  return null;
}

/**
 * Ask for a decision; a non-answer re-prompts once, and a second non-answer
 * leaves the card pending (the caller sends nothing).
 */
export async function askConfirmDecision(
  ask: (question: string) => Promise<string>,
  question: string
): Promise<ConfirmDecision | "pending"> {
  const first = readConfirmAnswer(await ask(question));
  if (first) return first;
  const second = readConfirmAnswer(await ask("Type y to approve or n to dismiss: "));
  return second ?? "pending";
}

/**
 * Ask on a card that needs a typed value (a required field) the line prompt
 * cannot send: only `n`/`no` declines; anything else, `y` included, leaves it
 * pending. Never approves.
 */
export async function askDismissOnly(
  ask: (question: string) => Promise<string>,
  question: string
): Promise<"decline" | "pending"> {
  return readConfirmAnswer(await ask(question)) === "decline" ? "decline" : "pending";
}

/**
 * The reconcile ask of a receipt that is not sure it happened (`reconcile.ask`,
 * a new user turn), so a caller can offer it as the next step. Null otherwise.
 */
export function receiptNextAsk(result: unknown): string | null {
  const view = printableImagesView(decodeAnswerView(isRecord(result) ? result.view : undefined));
  if (!view || !UNSURE_STATES.has(view.state) || !isRecord(view.reconcile)) return null;
  const ask = view.reconcile.ask;
  return typeof ask === "string" ? boundedTerminalText(ask, MAX_LINE_CHARS) || null : null;
}

/** The line for a card left unanswered: it stays pending until it expires. */
export function leftForLaterLine(expiresAt: string | null | undefined): string {
  const at = expiresAt ? new Date(expiresAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return "Left for later — nothing was sent.";
  }
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `Left for later — expires ${hh}:${mm}`;
}

function receiptViewLines(value: unknown, decision: ConfirmDecision): ConfirmLine[] | null {
  // An images receipt never prints a URL (its sentence, reconcile step or provenance).
  const view = printableImagesView(decodeAnswerView(value));
  const receipt = view?.receipt;
  if (!view || !receipt || typeof receipt.sentence !== "string") return null;
  const sentence = boundedTerminalText(receipt.sentence, MAX_LINE_CHARS);
  if (!sentence) return null;
  const mark =
    decision === "decline"
      ? { glyph: "✕", tone: "muted" as const }
      : stateMark(view) ??
        (receipt.tone === "warn" ? { glyph: "!", tone: "warn" as const } : { glyph: "✓", tone: "ok" as const });
  const lines: ConfirmLine[] = [{ tone: mark.tone, text: `${mark.glyph} ${sentence}` }];
  // Not sure it happened: the app's reconcile step (check first), never "try again".
  if (decision === "approve" && UNSURE_STATES.has(view.state) && isRecord(view.reconcile)
    && typeof view.reconcile.label === "string") {
    const label = boundedTerminalText(view.reconcile.label, MAX_LINE_CHARS);
    if (label) lines.push({ tone: "warn", text: `→ ${label}` });
  }
  if (typeof receipt.provenanceLine === "string") {
    const provenance = boundedTerminalText(receipt.provenanceLine, MAX_LINE_CHARS);
    if (provenance) lines.push({ tone: "muted", text: `  ${provenance}` });
  }
  return lines;
}

function receiptSentence(value: unknown): string | null {
  const raw = typeof value === "string" ? value : isRecord(value) && typeof value.sentence === "string" ? value.sentence : null;
  if (raw === null) return null;
  return boundedTerminalText(raw, MAX_LINE_CHARS) || null;
}

function linkValues(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  const sources = [record, isRecord(record.data) ? record.data : undefined];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const field of LINK_FIELDS) {
      const value = source[field];
      if (typeof value !== "string") continue;
      const text = boundedTerminalText(value, MAX_LINE_CHARS);
      if (text) seen.add(text);
    }
  }
  return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
