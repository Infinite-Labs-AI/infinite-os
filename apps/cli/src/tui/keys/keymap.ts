// One keymap for the interactive session (terminal-r4 "Keys"): one meaning per
// key, everywhere. Pure, so every rule is pinned by a CI-run test; the single
// `useInput` owner in `interactive-session.tsx` only dispatches what this
// resolves. Only one card takes keys at a time, and the key bar shows only what
// works right now.
//
// The approval rule this file exists to hold: on a card ONLY the card's named OK
// key approves and ONLY `n` dismisses (a real "no" that reaches the app), each
// in lowercase only (a capital letter starts a message). Enter and Esc never
// approve or decline (Esc stops a running turn, nothing else).
import type { Key } from "ink";

import { terminalText } from "../../desktop/terminal-text.js";
import { paintSegments, segmentsWidth, truncSegments, type StyledSegment } from "../lib/styled-segments.js";
import type { Theme } from "../theme.js";

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
  /**
   * The OK key's words in the key bar, when not the first word of `okLabel`
   * ("check again"). The card's own chip keeps `okLabel` whole.
   */
  okVerb?: string;
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
  /**
   * The yes already went out (a still-running card, r4 flow-pause-07): only
   * the OK key ("check again") is offered. `n` still closes the card, but
   * there is nothing left to decline, so the card and the bar never offer it.
   */
  decided?: boolean;
}

export interface KeyHint {
  key: string;
  label: string;
  /** The card's OK key: an amber chip and a bold label (terminal-r4 `PK`), always first among the card's decisions. */
  ok?: boolean;
  /**
   * What the key bar says instead of `label` (terminal-r4: the card's chip
   * reads `p Pause`, `s Send to 214 people`; the bar reads `p pause`, `s send`).
   */
  barLabel?: string;
  /** A key the card shows on its own chips but not in the key bar (r4: an open document's bar is `s send   1-3 email`). */
  chipOnly?: boolean;
}

/**
 * The OK key's words in the key bar (terminal-r4 `PK('p','pause')`): the first
 * word of the card's label, lower case ("Send to 214 people" → "send",
 * "Generate · ~$0.52" → "generate").
 */
export function shortOkVerb(label: string): string {
  const first = terminalText(label).trim().split(/[\s·]+/u)[0] ?? "";
  const word = first.replace(/[^\p{L}\p{N}'-]+$/u, "").toLowerCase();
  return word || "approve";
}

/**
 * The keys the bar ends with (terminal-r4): `tab` switches between the answer
 * and its details, `/` starts a command. `/ commands` is always there; `tab
 * switch side` only while the turn on screen has details to switch to (a view
 * or a card: the right pane from 80 columns, under the answer below that).
 */
export const ALWAYS_KEY_HINTS: readonly KeyHint[] = [
  { key: "tab", label: "switch side" },
  { key: "/", label: "commands" }
];

/** What the bar's closing keys depend on. */
export interface KeyBarOptions {
  /**
   * The turn on screen has a details view or card, so `tab switch side` has a
   * side to switch to. Default true (r4's bar, and the boot frame's, which is
   * r4's frame as drawn). False drops the hint: a plain answer, a turn that
   * went to scrollback.
   */
  sides?: boolean;
}

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
  // On a card a capital letter never decides or acts: it is the start of a
  // message ("Show me the emails first" must not Send). Only the exact
  // lowercase OK key, `n` and `r` decide.
  if (ctx.focus === "card" && input !== input.toLowerCase()) {
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
 * The state's keys for the bar: only what works right now. A card offers its
 * named OK key with the card's own verb, then `n dismiss`, then `o`/`w`/`r`
 * when their capability is present, then `?` when there is an explanation.
 * The composer offers `esc stop` while a turn runs (`busy` means a STOPPABLE
 * turn: Esc resolves to stop exactly then), first and once, and nothing of
 * its own when idle. The rows and document hints of a finished turn's views
 * come from `views/focus.ts` (`viewKeyHints`), from the same facts its key
 * resolver uses. The bar itself ends with `tab switch side` (while the turn
 * has details) and `/ commands` (`keyBarSegments`).
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
  // With its documents open, the bar is the OK key and the documents' own keys
  // (r4 flow-email-02); `v` and `n` still work, and stay on the card's chips.
  const reading = card.viewOpen === true;
  if (card.view) hints.push({ key: "v", label: card.viewOpen ? "close" : "view", ...(reading ? { chipOnly: true } : {}) });
  if (ctx.okKey !== null) {
    const label = ctx.okLabel ?? "approve";
    hints.push({ key: ctx.okKey, label, ok: true, barLabel: terminalText(ctx.okVerb ?? "") || shortOkVerb(label) });
  }
  if (!card.decided) hints.push({ key: "n", label: "dismiss", ...(reading ? { chipOnly: true } : {}) });
  const tabs = cardTabs(card);
  if (tabs > 1) hints.push({ key: `1-${tabs}`, label: card.tabNoun || "switch" });
  if (card.page) hints.push({ key: "space", label: "next page" });
  if (card.edit) hints.push({ key: "e", label: "edit in the app" });
  if (card.copy) hints.push({ key: "c", label: "copy" });
  // The card names its place (`openKeyLabel`, approval.ts); with no name, `open`.
  if (ctx.caps.open) hints.push({ key: "o", label: "open" });
  if (ctx.caps.watch) hints.push({ key: "w", label: "watch" });
  if (ctx.caps.retry) hints.push({ key: "r", label: "retry" });
  // A card says `? what it does` inside itself (r4 `card()`): never on the bar.
  if (ctx.explain) hints.push({ key: "?", label: "what it does", chipOnly: true });
  return hints;
}

/**
 * A card's keys while the card is scrolled off screen (W3L2-M2): no OK key and
 * no `r` (which sends the approve again), so no key approves what the user
 * cannot see. `n` (a real decline) and the card's other keys stay.
 */
export function cardKeysOffScreen(ctx: KeyContext): KeyContext {
  return { ...ctx, okKey: null, caps: { ...ctx.caps, retry: false } };
}

/** A card hint that approves: its OK key, or `r` (sends the approve again). */
export function approvesCard(hint: Pick<KeyHint, "key" | "ok">): boolean {
  return hint.ok === true || hint.key === "r";
}

/** How many documents `1`–`9` reach on a card (at most 9). */
function cardTabs(card: CardKeys): number {
  const tabs = typeof card.tabs === "number" && Number.isFinite(card.tabs) ? Math.floor(card.tabs) : 0;
  return Math.max(0, Math.min(9, tabs));
}

/**
 * The hints the bar draws, in order: the state's own keys (each key once, the
 * first meaning wins, each in its bar words), then `tab switch side` while
 * there is a side to switch to (`options.sides`), then always `/ commands`.
 * A view's `? what it does` is on the bar (run-2 N12); a card's is a chip
 * inside the card (`chipOnly`), never on the bar.
 */
export function keyBarShownHints(hints: readonly KeyHint[], options: KeyBarOptions = {}): KeyHint[] {
  const always = new Set(ALWAYS_KEY_HINTS.map((hint) => hint.key));
  const seen = new Set<string>();
  const shown: KeyHint[] = [];
  for (const hint of hints) {
    if (always.has(hint.key) || seen.has(hint.key) || hint.chipOnly) {
      continue;
    }
    seen.add(hint.key);
    shown.push(hint.barLabel ? { key: hint.key, label: hint.barLabel, ...(hint.ok ? { ok: true } : {}) } : hint);
  }
  // A view's own `tab` words (`tab then o open`, focus.ts TJ-3) replace `switch side`
  // in its place, and show whether or not there is a side: tab engages the view.
  const tabWords = hints.find((hint) => hint.key === "tab" && !hint.chipOnly && hint.label !== TAB_HINT.label);
  return [
    ...shown,
    ...ALWAYS_KEY_HINTS.flatMap((hint) => hint.key !== "tab" ? [hint] : tabWords ? [{ key: "tab", label: tabWords.label }] : options.sides !== false ? [hint] : [])
  ];
}

const TAB_HINT = ALWAYS_KEY_HINTS.find((hint) => hint.key === "tab")!;

/**
 * The bar as styled segments (terminal-r4 `K()` / `PK()`): each key a chip
 * (` k ` on the key grey; the OK key amber, its label bold), one space, the
 * label, three spaces to the next key. Every label is scrubbed before it
 * reaches the TTY. Not cut to a width.
 */
export function keyBarSegments(hints: readonly KeyHint[], options: KeyBarOptions = {}): StyledSegment[] {
  return shownSegments(keyBarShownHints(hints, options));
}

function shownSegments(shown: readonly KeyHint[]): StyledSegment[] {
  return shown.flatMap((hint, index): StyledSegment[] => {
    const key = terminalText(hint.key);
    const label = terminalText(hint.label);
    const gap = index < shown.length - 1 ? "   " : "";
    return hint.ok
      ? [["pk", ` ${key} `], ["", " "], ["b", label], ["", gap]]
      : [["key", ` ${key} `], ["", ` ${label}${gap}`]];
  });
}

/** The state's keys as one plain line, as the bar words them (`p pause   n dismiss`); every label is scrubbed. */
export function formatKeyBar(hints: readonly KeyHint[]): string {
  const always = new Set(ALWAYS_KEY_HINTS.map((hint) => hint.key));
  return keyBarShownHints(hints)
    .filter((hint) => !always.has(hint.key) || hints.some((given) => given.key === hint.key))
    .map((hint) => `${hint.key} ${terminalText(hint.label)}`)
    .join("   ");
}

/**
 * The drawn bar's text with no colour, uncut: chips keep their padding and the
 * bar ends with `tab switch side` (unless `sides` is false) and `/ commands`
 * (` p  Pause    n  dismiss    tab  …`).
 */
export function keyBarText(hints: readonly KeyHint[], options: KeyBarOptions = {}): string {
  return keyBarSegments(hints, options).map(([, text]) => text).join("");
}

/**
 * The key bar, the session's LAST row: one row, cut to `width` with `…` on
 * the key that does not fit (later keys dropped), painted at the theme's tier.
 * When the cut would reach a key the user needs to move on (the OK key, `n`,
 * `o`, `tab`, `esc`, `enter`, `↑ ↓`), lower keys give way first, whole:
 * `/ commands`, then the others from the end of the bar (`fitKeyBar`, S2).
 */
export function keyBarLine(hints: readonly KeyHint[], width: number, theme: Theme, options: KeyBarOptions = {}): string {
  const cells = Math.max(1, Math.floor(width));
  return paintSegments(truncSegments(shownSegments(fitKeyBar(keyBarShownHints(hints, options), cells)), cells), theme);
}

/** The keys that always stay whole on a bar that is too wide (S2): the way on from here. */
const KEPT_BAR_KEYS: ReadonlySet<string> = new Set(["n", "o", "tab", "esc", "enter", "↑ ↓"]);

const keptOnBar = (hint: KeyHint): boolean => hint.ok === true || KEPT_BAR_KEYS.has(hint.key);

/**
 * The shown keys that fit `width` with every kept key whole. A bar whose kept
 * keys already fit is left as it is (only its tail is cut, as r4 draws its
 * c60 bars: `… tab switch side    / comm…`). Otherwise `/ commands` drops
 * first, then the other keys one by one from the end; the kept keys keep
 * their order and are never dropped.
 */
export function fitKeyBar(shown: readonly KeyHint[], width: number): KeyHint[] {
  let kept = [...shown];
  const fits = (hints: readonly KeyHint[]): boolean => {
    const last = hints.reduce((at, hint, index) => keptOnBar(hint) ? index : at, -1);
    // A key after the last kept one needs its 3-space gap whole, or the cut would land in the kept label.
    const gap = last < hints.length - 1 ? 3 : 0;
    return last < 0 || segmentsWidth(shownSegments(hints.slice(0, last + 1))) + gap <= width;
  };
  const order = [
    ...kept.filter((hint) => hint.key === "/"),
    ...kept.filter((hint) => hint.key !== "/" && !keptOnBar(hint)).reverse()
  ];
  for (const drop of order) {
    if (fits(kept)) break;
    kept = kept.filter((hint) => hint !== drop);
  }
  return kept;
}

/** Rows the bar takes: always one (it is cut to the width, never wrapped). */
export function keyBarRowCount(_hints: readonly KeyHint[], _width: number): number {
  return KEY_BAR_ROWS;
}

/** The key bar is one row at every width. */
export const KEY_BAR_ROWS = 1;

/** The structural slice of a pending confirmation the keymap reads. */
export interface PendingCardKeySource {
  summary: string;
  view?: {
    explain?: string;
    approval?: { confirmLabel: string; summary: string | null };
  };
  /** The summary was made from the tool's name: nothing real to explain behind `?`. */
  summaryFromTool?: boolean;
}

/**
 * The key context and `?` text for a pending write card. With an approval view
 * the OK key comes from `approval.confirmLabel`; an old desktop (no view) gets
 * `y Confirm`. `?` shows `approval.summary`, else `view.explain`; without a view
 * it shows the pending summary, unless that was made from the tool's name.
 * Every string is scrubbed here.
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
    : pending.summaryFromTool ? null : stringOrUndefined(pending.summary) ?? null;
  const explainText = rawExplain === null ? null : terminalText(rawExplain) || null;
  return {
    ctx: {
      focus: "card",
      busy: false,
      okKey: okKeyFor(okLabel),
      okLabel,
      okVerb: shortOkVerb(okLabel),
      caps,
      explain: explainText !== null
    },
    explainText
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
