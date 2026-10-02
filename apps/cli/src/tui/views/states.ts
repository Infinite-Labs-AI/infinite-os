// The terminal's state heads: one glyph and one word per answer-view state.
//
// These are GENERIC chrome. A head prints the state's glyph, then the view's
// `stateReason.short` when it has one ("Changed on Meta", "1 not measured"),
// else the generic words below (terminal-r4, decision D3). The full sentence
// stays in `stateReason.words`. The generic words are the contract's "State
// words" list, shared word for word with Cmd+L's `STATE_CHIP` (1bu-1
// `shared/answer-view-state-words.ts`). The desktop's parity test reads THIS
// file with a regex, so keep each entry on one line, shaped exactly
// `state: { glyph: "…", words: "…", tone: "…" },`.
import type { AnswerViewKind, AnswerViewState, OutcomeV1 } from "@infinite-os/types";

import { terminalText } from "../../desktop/terminal-text.js";

/** ask = needs you (bold amber); cmdl_only = only Cmd+L can do it (bold blue). */
export type StateTone = "ok" | "ask" | "warn" | "bad" | "muted" | "busy" | "cmdl_only";

export interface StateHead {
  glyph: string;
  words: string;
  tone: StateTone;
}

export const STATE_HEAD: Record<AnswerViewState, StateHead> = {
  working: { glyph: "◑", words: "Working", tone: "busy" },
  ready: { glyph: "✓", words: "Ready", tone: "ok" },
  nothing_found: { glyph: "∅", words: "Nothing found", tone: "muted" },
  not_measured: { glyph: "—", words: "Not measured", tone: "muted" },
  partial: { glyph: "◐", words: "Partial", tone: "warn" },
  out_of_date: { glyph: "⧗", words: "Out of date", tone: "warn" },
  not_connected: { glyph: "⊘", words: "Not connected", tone: "warn" },
  blocked: { glyph: "⊗", words: "Blocked", tone: "bad" },
  finish_in_app: { glyph: "↗", words: "Finish in the app", tone: "warn" },
  needs_yes: { glyph: "▣", words: "Needs your OK", tone: "ask" },
  needs_answer: { glyph: "▣", words: "Needs an answer", tone: "ask" },
  applying: { glyph: "◑", words: "Applying", tone: "busy" },
  done: { glyph: "✓", words: "Done", tone: "ok" },
  failed: { glyph: "✗", words: "Failed", tone: "bad" },
  cancelled: { glyph: "✕", words: "Dismissed", tone: "muted" },
  expired: { glyph: "◷", words: "Expired", tone: "muted" },
  outcome_unknown: { glyph: "◑", words: "Not sure it happened", tone: "warn" },
  hit_limit: { glyph: "$", words: "Hit a limit", tone: "warn" },
  background: { glyph: "⟳", words: "Running", tone: "busy" },
  opened_in_app: { glyph: "↗", words: "Opened in the app", tone: "ok" },
  preview: { glyph: "◇", words: "Preview", tone: "muted" },
  no_change: { glyph: "·", words: "Nothing to change", tone: "muted" },
  showing_defaults: { glyph: "◇", words: "Showing defaults", tone: "muted" },
  cmdl_only: { glyph: "⌘", words: "Do this in Cmd+L", tone: "cmdl_only" }
};

/** A failed write that never left (`outcome: "not_sent"`) says so; it is still `failed`. */
const NOT_SENT: StateHead = { glyph: "✗", words: "Not sent", tone: "bad" };

/**
 * Running images draw in place, one braille spinner frame like a running step
 * (r4 "⠋ Working"); a job in the background keeps `⟳ Running`.
 */
const RUNNING_IMAGES: StateHead = { glyph: "⠋", words: "Working", tone: "busy" };

/** The view fields a head reads. */
export interface StateHeadInput {
  state: AnswerViewState;
  outcome?: OutcomeV1;
  kind?: AnswerViewKind;
  stateReason?: unknown;
}

/**
 * The head for one view: the state's glyph and tone, with `stateReason.short`
 * (scrubbed) in place of the generic words when the view gives one. Only
 * `failed` + `outcome: "not_sent"` and running images refine the table; every
 * other state prints its table entry. A state the table does not know (the
 * decoder rejects those) falls back to no claim at all: `ready` would
 * overstate, so it is the muted `preview`.
 */
export function stateHeadFor(view: StateHeadInput): StateHead {
  const base = baseHead(view);
  const short = shortWords(view.stateReason);
  return short ? { ...base, words: short } : base;
}

function baseHead(view: StateHeadInput): StateHead {
  if (view.state === "failed" && view.outcome === "not_sent") {
    return NOT_SENT;
  }
  if (view.kind === "images" && (view.state === "working" || view.state === "background")) {
    return RUNNING_IMAGES;
  }
  return Object.hasOwn(STATE_HEAD, view.state) ? STATE_HEAD[view.state] : STATE_HEAD.preview;
}

function shortWords(reason: unknown): string {
  if (typeof reason !== "object" || reason === null || Array.isArray(reason)) {
    return "";
  }
  const short = (reason as { short?: unknown }).short;
  return typeof short === "string" ? terminalText(short, "").trim() : "";
}
