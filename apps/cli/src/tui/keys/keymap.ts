// One keymap for the interactive session (terminal-r4 "Keys"): one meaning per
// key, everywhere. Pure, so every rule is pinned by a CI-run test; the single
// `useInput` owner in `interactive-session.tsx` only dispatches what this
// resolves. Only one card takes keys at a time, and the key bar shows only what
// works right now.
//
// The approval rule this file exists to hold: on a card ONLY the card's named OK
// key approves and ONLY `n` dismisses (a real "no" that reaches the app). Enter
// and Esc never approve or decline (Esc stops a running turn, nothing else).
import type { Key } from "ink";
import wrapAnsi from "wrap-ansi";

import { terminalText } from "../../desktop/terminal-text.js";

export type FocusKind = "composer" | "card" | "rows" | "document";

export type KeyAction =
  | { type: "ok" } | { type: "dismiss" } | { type: "explain" } | { type: "open" } | { type: "view" }
  | { type: "move"; delta: 1 | -1 } | { type: "enter" } | { type: "tab"; index: number } | { type: "page" }
  | { type: "columns" } | { type: "copy" } | { type: "edit" } | { type: "more" } | { type: "watch" }
  | { type: "retry" } | { type: "switch_pane" } | { type: "stop" } | { type: "none" };

export interface KeyContext {
  focus: FocusKind;
  busy: boolean;
  okKey: string | null;
  caps: { open: boolean; watch: boolean; retry: boolean };
  /** The card's verb for the key bar ("Pause", "Lower to $30/day"). Defaults to "approve". */
  okLabel?: string;
  /** Whether `?` has an explanation to show; the bar offers `?` only when true. */
  explain?: boolean;
  /** What else a card offers right now (the approval renderer says; absent = nothing). */
  card?: CardKeys;
}

/**
 * The card keys beyond OK, `n` and `?` (terminal-r4 "Send to 214 people": `v`
 * shows every email, `1`–`3` switch between them, space pages a long body).
 * Each key works, and is shown, only when its flag is set. None of them ever
 * approves or declines.
 */
export interface CardKeys {
  /** `v` opens the card's documents (and closes them again). */
  view?: boolean;
  /** The documents are open: `v` reads "close". */
  viewOpen?: boolean;
  /** `1`–`9` switch between this many documents. */
  tabs?: number;
  /** What the documents are, for the bar (`1-3 email`, terminal-r4); absent = "switch". */
  tabNoun?: string;
  /** Space pages the open document. */
  page?: boolean;
  /** `c` copies what the card shows. */
  copy?: boolean;
  /** `e` edits in the app. */
  edit?: boolean;
}

export interface KeyHint { key: string; label: string }

/** Keys with one meaning everywhere, so a card's verb can never claim them. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "n", "v", "o", "t", "c", "e", "m", "w", "r", "j", "k", "?", "/", "q"
]);

/** The fallback OK key when the verb has no letter of its own ("Confirm", "Run now"). */
export const DEFAULT_OK_KEY = "y";

/**
 * The card's OK key: the verb's first letter when it is a–z and not reserved,
 * else `y`. "Pause" → p, "Send to 214 people" → s, "Confirm" → y (c is copy).
 */
export function okKeyFor(confirmLabel: string): string {
  const first = terminalText(confirmLabel).charAt(0).toLowerCase();
  if (first >= "a" && first <= "z" && !RESERVED_KEYS.has(first)) {
    return first;
  }
  return DEFAULT_OK_KEY;
}

/** One key press → one action, for the focused surface only. */
export function resolveKey(input: string, key: Key, ctx: KeyContext): KeyAction {
  // Esc only ever stops a running turn. It never approves or declines.
  if (key.escape) {
    return ctx.busy ? { type: "stop" } : { type: "none" };
  }
  // The composer owns typing: no letter, `?` or Enter is a view key there.
  if (ctx.focus === "composer") {
    return { type: "none" };
  }
  // Chords are never view keys (Ctrl-C is handled by the session first).
  if (key.ctrl || key.meta) {
    return { type: "none" };
  }
  if (key.tab) {
    return { type: "switch_pane" };
  }
  if (ctx.focus === "card") {
    // Enter never approves or declines a card.
    if (key.return) {
      return { type: "none" };
    }
  } else {
    if (key.return) return { type: "enter" };
    if (key.downArrow) return { type: "move", delta: 1 };
    if (key.upArrow) return { type: "move", delta: -1 };
    if (key.rightArrow) return { type: "columns" };
  }
  // A single printable key; a pasted burst is never a key press.
  if (Array.from(input).length !== 1) {
    return { type: "none" };
  }
  const k = input.toLowerCase();
  if (k === "?") return { type: "explain" };
  if (k === "o") return ctx.caps.open ? { type: "open" } : { type: "none" };
  if (k === "w") return ctx.caps.watch ? { type: "watch" } : { type: "none" };
  if (k === "r") return ctx.caps.retry ? { type: "retry" } : { type: "none" };

  if (ctx.focus === "card") {
    // ONLY the named OK key approves and ONLY `n` dismisses. The OK key is
    // never a reserved letter or a digit (`okKeyFor`), so v/e/c/1–9/space can
    // never collide with it.
    if (k === "n") return { type: "dismiss" };
    if (ctx.okKey !== null && k === ctx.okKey) return { type: "ok" };
    const card = ctx.card ?? {};
    if (k === "v" && card.view) return { type: "view" };
    if (/^[1-9]$/u.test(k) && Number(k) <= cardTabs(card)) return { type: "tab", index: Number(k) - 1 };
    if (k === " " && card.page) return { type: "page" };
    if (k === "e" && card.edit) return { type: "edit" };
    if (k === "c" && card.copy) return { type: "copy" };
    return { type: "none" };
  }

  if (/^[1-9]$/u.test(k)) return { type: "tab", index: Number(k) - 1 };
  if (k === "c") return { type: "copy" };
  if (k === "m") return { type: "more" };
  if (k === "v") return { type: "view" };
  if (ctx.focus === "rows") {
    if (k === "j") return { type: "move", delta: 1 };
    if (k === "k") return { type: "move", delta: -1 };
  }
  if (ctx.focus === "document" && k === " ") {
    return { type: "page" };
  }
  return { type: "none" };
}

/**
 * The key bar: only what works right now. A card offers its named OK key with
 * the card's own verb, then `n dismiss`, then `o`/`w`/`r` when their capability
 * is present, then `?` when there is an explanation. The composer shows
 * `esc stop` while a turn runs (`busy` means a STOPPABLE turn: Esc resolves to
 * stop exactly then) and no bar when idle. The rows and document hints of a
 * finished turn's views come from `views/focus.ts` (`viewKeyHints`), from the
 * same facts its key resolver uses.
 */
export function keyBarHints(ctx: KeyContext): KeyHint[] {
  if (ctx.focus === "composer") {
    return ctx.busy ? [{ key: "esc", label: "stop" }] : [];
  }
  if (ctx.focus !== "card") {
    return [];
  }
  const hints: KeyHint[] = [];
  const card = ctx.card ?? {};
  if (card.view) hints.push({ key: "v", label: card.viewOpen ? "close" : "view" });
  if (ctx.okKey !== null) {
    hints.push({ key: ctx.okKey, label: ctx.okLabel ?? "approve" });
  }
  hints.push({ key: "n", label: "dismiss" });
  const tabs = cardTabs(card);
  if (tabs > 1) hints.push({ key: `1-${tabs}`, label: card.tabNoun || "switch" });
  if (card.page) hints.push({ key: "space", label: "next page" });
  if (card.edit) hints.push({ key: "e", label: "edit in the app" });
  if (card.copy) hints.push({ key: "c", label: "copy" });
  if (ctx.caps.open) hints.push({ key: "o", label: "open in the app" });
  if (ctx.caps.watch) hints.push({ key: "w", label: "watch" });
  if (ctx.caps.retry) hints.push({ key: "r", label: "retry" });
  if (ctx.explain) hints.push({ key: "?", label: "what it does" });
  return hints;
}

/** How many documents `1`–`9` reach on a card (at most 9). */
function cardTabs(card: CardKeys): number {
  const tabs = typeof card.tabs === "number" && Number.isFinite(card.tabs) ? Math.floor(card.tabs) : 0;
  return Math.max(0, Math.min(9, tabs));
}

/** The bar as one plain line; every label is scrubbed before it reaches the TTY. */
export function formatKeyBar(hints: readonly KeyHint[]): string {
  return hints.map((hint) => `${hint.key} ${terminalText(hint.label)}`).join("   ");
}

/** Rows the bar takes at `width`, wrapped the way Ink's `wrap="wrap"` does. */
export function keyBarRowCount(hints: readonly KeyHint[], width: number): number {
  if (hints.length === 0) {
    return 0;
  }
  return wrapAnsi(formatKeyBar(hints), Math.max(1, width), { trim: false, hard: true }).split("\n").length;
}

/** The structural slice of a pending confirmation the keymap reads. */
export interface PendingCardKeySource {
  summary: string;
  view?: {
    explain?: string;
    approval?: { confirmLabel: string; summary: string | null };
  };
}

/**
 * The key context and `?` text for a pending write card. With an approval view
 * the OK key comes from `approval.confirmLabel`; an old desktop (no view) gets
 * `y Confirm`. `?` shows `approval.summary`, else `view.explain`; without a view
 * it shows the pending summary. Every string is scrubbed here.
 */
export function confirmCardKeys(
  pending: PendingCardKeySource,
  caps: KeyContext["caps"]
): { ctx: KeyContext; explainText: string | null } {
  // A decoded view only vouches for its envelope, so read each field as a
  // string or nothing: an array or object here must degrade, never throw.
  const approval = pending.view?.approval;
  const confirmLabel = stringOrUndefined(approval?.confirmLabel);
  const okLabel = terminalText(confirmLabel ?? "", "Confirm");
  const rawExplain = pending.view
    ? stringOrUndefined(approval?.summary) ?? stringOrUndefined(pending.view.explain) ?? null
    : stringOrUndefined(pending.summary) ?? null;
  const explainText = rawExplain === null ? null : terminalText(rawExplain) || null;
  return {
    ctx: {
      focus: "card",
      busy: false,
      okKey: okKeyFor(okLabel),
      okLabel,
      caps,
      explain: explainText !== null
    },
    explainText
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
