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

import type { AnswerViewState } from "@infinite-os/types";

import { decodeAnswerView } from "./answer-view-decode.js";
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

/** Glyph and tone for the receipt view's state (the shared state words' glyphs). */
const STATE_MARK: Partial<Record<AnswerViewState, { glyph: string; tone: ConfirmLineTone }>> = {
  done: { glyph: "✓", tone: "ok" },
  opened_in_app: { glyph: "↗", tone: "ok" },
  background: { glyph: "⟳", tone: "ok" },
  partial: { glyph: "◐", tone: "warn" },
  outcome_unknown: { glyph: "?", tone: "warn" },
  no_change: { glyph: "·", tone: "muted" },
  cancelled: { glyph: "✕", tone: "muted" },
  expired: { glyph: "◷", tone: "muted" },
  failed: { glyph: "✗", tone: "bad" },
  hit_limit: { glyph: "$", tone: "bad" },
  blocked: { glyph: "⊗", tone: "bad" }
};

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
  const fromView = receiptViewLines(isRecord(error) ? error.view : undefined, "approve");
  if (fromView) return fromView;
  const message = error instanceof Error ? boundedTerminalText(error.message, MAX_LINE_CHARS) : "";
  if (code !== undefined && UNKNOWN_OUTCOME_CODES.has(code)) {
    return [{ tone: "warn", text: `? ${message || "Not sure it happened."}` }];
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
  const view = decodeAnswerView(value);
  const receipt = view?.receipt;
  if (!view || !receipt || typeof receipt.sentence !== "string") return null;
  const sentence = boundedTerminalText(receipt.sentence, MAX_LINE_CHARS);
  if (!sentence) return null;
  const mark =
    decision === "decline"
      ? { glyph: "✕", tone: "muted" as const }
      : STATE_MARK[view.state] ??
        (receipt.tone === "warn" ? { glyph: "!", tone: "warn" as const } : { glyph: "✓", tone: "ok" as const });
  const lines: ConfirmLine[] = [{ tone: mark.tone, text: `${mark.glyph} ${sentence}` }];
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
