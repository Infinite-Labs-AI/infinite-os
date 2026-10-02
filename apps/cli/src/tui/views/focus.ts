// Keys on the latest turn's views (terminal-r4 "Keys"). Pure, so every rule is
// pinned by a CI-run test; the session's single `useInput` owner only calls
// `resolveViewKey` and carries out the effect it returns.
//
// The latest finished turn keeps its views live and focused until the next
// line is submitted (then it commits to scrollback with them). While the
// composer is empty, a key the focused view USES acts on it (j/k move, 1–9
// switch tabs, space pages, → shows dropped columns, ? opens the explanation).
// Any other printable key types: it moves focus to the composer, where every
// key types, until tab brings the view keys back. So a key is never eaten by a
// view that has no use for it:
// - a capital letter always types ("Make me…" never becomes `m`);
// - a move that moves nothing types (`k` on the first row starts "keep going");
// - until the user ENGAGES the view (j/k, 1–9, space, →, ? acted, or tab), the
//   keys that would send or page (`m`, Enter) type or stay with the composer,
//   and ↑/↓ stay the composer's history recall.
// Approvals are not views here: the card's own keymap (named OK key, `n`)
// handles them, and Enter/Esc never approve or decline anything.
import type { AnswerViewV1 } from "@infinite-os/types";
import type { Key } from "ink";

import { printableImagesView } from "../../desktop/image-url-cut.js";
import { resolveKey, type FocusKind, type KeyAction, type KeyContext, type KeyHint } from "../keys/keymap.js";
import { DEFAULT_THEME, type Theme } from "../theme.js";
import { truncatedMoreAsk, turnAsk, viewText } from "./primitives.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

export { turnAsk };

/** What a key asks the session to do beyond redrawing. */
export type ViewKeyEffect =
  /** Send this as a NEW user turn (never a direct tool call). */
  | { type: "ask"; text: string }
  /** Page the live region down (a tall turn without a `more` ask). */
  | { type: "page_live" }
  /** Put this (scrubbed) text on the clipboard (`c`: a link, an id, an email). */
  | { type: "copy"; text: string };

/** What the focused view offers right now (from its current render). */
export interface ViewKeyFacts {
  rowCount: number;
  rowAsks: readonly (string | null)[];
  tabs: number;
  pages: number;
  hiddenColumns: number;
  explain: boolean;
  /** The ask `m` sends, when the view is truncated and says how to get more. */
  more: string | null;
  /** The state's fix ask Enter sends (only when no row has an ask of its own). */
  fixAsk: string | null;
  /** The live region has more lines below (`m` pages it when there is no `more` ask). */
  livePageNext: boolean;
  /** What `c` copies on each selectable row (null = nothing on that row). */
  rowCopies: readonly (string | null)[];
  /** What `c` copies for the whole view, when the selected row has nothing. */
  copy: string | null;
}

export interface ViewFocusState {
  /** Index into the turn's views of the one the keys act on (-1 = none). */
  viewIndex: number;
  /** "composer" while the user types; otherwise the view's own focus. */
  focus: FocusKind;
  detailsFocus: "rows" | "document";
  selected: number;
  tab: number;
  page: number;
  explainOpen: boolean;
  showHiddenColumns: boolean;
  caps: KeyContext["caps"];
  facts: ViewKeyFacts;
  /**
   * The user has acted on the view (a view key that did something, or tab).
   * Until then `m` and Enter never send or page, and ↑/↓ recall history.
   */
  engaged: boolean;
  /** Whether the last key acted on the view; false = it goes to the composer. */
  handled: boolean;
  effect: ViewKeyEffect | null;
}

export const NO_VIEW_CAPS: KeyContext["caps"] = { open: false, watch: false, retry: false };

const EMPTY_FACTS: ViewKeyFacts = {
  rowCount: 0, rowAsks: [], tabs: 0, pages: 0, hiddenColumns: 0, explain: false, more: null, fixAsk: null, livePageNext: false,
  rowCopies: [], copy: null
};

/** The view the keys act on: the last one that is not quiet (steps only), else the last. */
export function focusedViewIndex(views: readonly AnswerViewV1[]): number {
  for (let index = views.length - 1; index >= 0; index -= 1) {
    if (views[index]?.kind !== "quiet") {
      return index;
    }
  }
  return views.length - 1;
}

/** Facts for the focused view, read from its current render (width-dependent, e.g. dropped columns). */
export function viewKeyFacts(given: AnswerViewV1 | undefined, render: ViewRender, livePageNext = false): ViewKeyFacts {
  if (!given) {
    return { ...EMPTY_FACTS, livePageNext };
  }
  const view = printableImagesView(given);
  return {
    rowCount: count(render.rowCount),
    rowAsks: (render.rowAsks ?? []).map((ask) => turnAsk(ask)),
    tabs: count(render.tabs),
    pages: count(render.pages),
    hiddenColumns: count(render.hiddenColumns),
    explain: viewText(view.explain) !== "",
    more: turnAsk(truncatedMoreAsk(view)),
    fixAsk: turnAsk(render.fixAsk),
    livePageNext,
    rowCopies: (render.rowCopies ?? []).map((text) => viewText(text) || null),
    copy: viewText(render.copyText) || null
  };
}

/** Whether the view has any key of its own (otherwise focus starts in the composer). */
export function hasViewKeys(facts: ViewKeyFacts): boolean {
  return facts.rowCount > 1
    || facts.rowAsks.some((ask) => ask !== null)
    || facts.tabs > 1
    || facts.pages > 1
    || facts.hiddenColumns > 0
    || facts.explain
    || facts.more !== null
    || facts.fixAsk !== null
    || facts.copy !== null
    || facts.rowCopies.some((text) => text !== null);
}

/** What `c` copies at this selection: the row's own text, else the view's. */
export function copyTextAt(facts: ViewKeyFacts, selected: number): string | null {
  return facts.rowCopies[selected] ?? facts.copy;
}

/**
 * The focus a finished turn opens with: its views stay live, and the focused
 * view takes the keys it uses (the composer takes them when it uses none).
 */
export function viewFocusAfterTurnDone(
  views: AnswerViewV1 | readonly AnswerViewV1[],
  caps: KeyContext["caps"] = NO_VIEW_CAPS
): ViewFocusState {
  const list = asViewList(views);
  const viewIndex = focusedViewIndex(list);
  const view = list[viewIndex];
  const facts = view ? viewKeyFacts(view, renderView(view, defaultFocusCtx(caps))) : EMPTY_FACTS;
  const detailsFocus = view?.kind === "document" ? "document" : "rows";
  return {
    viewIndex,
    focus: hasViewKeys(facts) ? detailsFocus : "composer",
    detailsFocus,
    selected: 0,
    tab: 0,
    page: 0,
    explainOpen: false,
    showHiddenColumns: false,
    caps,
    facts,
    engaged: false,
    handled: false,
    effect: null
  };
}

/** The render context for the focused view, carrying its selection, tab, page and toggles. */
export function focusedViewCtx(
  state: ViewFocusState,
  base: { width: number; color: boolean; theme: Theme; timeZone?: string; rows?: number }
): ViewRenderCtx {
  return {
    ...base,
    selected: state.selected,
    tab: state.tab,
    page: state.page,
    explainOpen: state.explainOpen,
    showHiddenColumns: state.showHiddenColumns,
    caps: state.caps
  };
}

/**
 * One key press on the latest turn's views. `facts` is what the focused view
 * offers at the current width (defaults to what it offered when the turn
 * finished). Returns the next state; `handled: false` means the key goes on to
 * the composer (a printable one also moves focus there).
 */
export function resolveViewKey(
  input: string,
  state: ViewFocusState,
  key: Partial<Key> = {},
  facts: ViewKeyFacts = state.facts
): ViewFocusState {
  const base: ViewFocusState = { ...state, facts, handled: false, effect: null };
  if (state.focus === "composer" || state.viewIndex < 0) {
    if (key.tab && !key.shift && state.viewIndex >= 0 && hasViewKeys(facts)) {
      return { ...base, focus: state.detailsFocus, engaged: true, handled: true };
    }
    return base;
  }
  // A capital letter is the start of a message (the keymap folds case, so
  // `M` would otherwise ask for more and `K` would move).
  if (/^[A-Z]$/u.test(input) && !key.ctrl && !key.meta) {
    return { ...base, focus: "composer", engaged: false };
  }
  // Before the view is engaged, tab engages it (the keys stay with the view)
  // and ↑/↓ stay the composer's history recall.
  if (!state.engaged) {
    if (key.tab && !key.ctrl && !key.meta) {
      return { ...base, engaged: true, handled: true };
    }
    if (key.upArrow || key.downArrow) {
      return base;
    }
  }
  const action = resolveKey(input, asKey(key), { focus: state.focus, busy: false, okKey: null, caps: state.caps });
  const next = applyViewAction(action, base, facts);
  if (next.handled || !typesIntoComposer(input, key)) {
    return next;
  }
  return { ...next, focus: "composer", engaged: false };
}

/**
 * The kind keys (`render.keys`) whose action `applyViewAction` carries out. A
 * kind hint is shown only for these, so the bar never offers a key that types.
 * A lane that adds a reducer case for v/e/o/w/r adds its key here with it.
 * `c` is not a kind key: its hint comes from the facts (`copyTextAt`), so a
 * kind says what to copy (`rowCopies`, `copyText`) and never lists `c` itself.
 */
export const HANDLED_KIND_KEYS: ReadonlySet<string> = new Set<string>();

function applyViewAction(action: KeyAction, state: ViewFocusState, facts: ViewKeyFacts): ViewFocusState {
  // Every key that acts engages the view.
  const handled = (patch: Partial<ViewFocusState>): ViewFocusState => ({ ...state, engaged: true, ...patch, handled: true });
  switch (action.type) {
    case "move": {
      if (facts.rowCount <= 1) {
        return state;
      }
      const selected = clamp(state.selected + action.delta, 0, facts.rowCount - 1);
      // A move that moves nothing types (`k` on the first row starts "keep…").
      return selected === state.selected ? state : handled({ selected });
    }
    case "enter": {
      if (!state.engaged) {
        return state;
      }
      const ask = facts.rowAsks[state.selected] ?? facts.fixAsk;
      return ask ? handled({ effect: { type: "ask", text: ask } }) : state;
    }
    case "tab":
      return facts.tabs > 1 && action.index < facts.tabs ? handled({ tab: action.index, page: 0 }) : state;
    case "page":
      return facts.pages > 1 && state.page + 1 < facts.pages ? handled({ page: state.page + 1 }) : state;
    case "columns":
      return facts.hiddenColumns > 0 || state.showHiddenColumns
        ? handled({ showHiddenColumns: !state.showHiddenColumns })
        : state;
    case "more":
      // Unengaged, `m` is the first letter of a message ("more…", "make…").
      if (!state.engaged) {
        return state;
      }
      if (facts.more) {
        return handled({ effect: { type: "ask", text: facts.more } });
      }
      return facts.livePageNext ? handled({ effect: { type: "page_live" } }) : state;
    case "explain":
      return facts.explain ? handled({ explainOpen: !state.explainOpen }) : state;
    case "copy": {
      // Unengaged, `c` is the first letter of a message ("change…", "can…").
      if (!state.engaged) {
        return state;
      }
      const text = copyTextAt(facts, state.selected);
      return text ? handled({ effect: { type: "copy", text } }) : state;
    }
    case "switch_pane":
      return { ...state, focus: "composer", engaged: false, handled: true };
    default:
      // ok/dismiss belong to approval cards; open/watch/retry/edit/view
      // arrive with the renderers and capabilities that give them meaning.
      return state;
  }
}

/**
 * The key bar for the latest turn's views: only what works right now. The
 * generic keys come from the facts (so the bar and `resolveViewKey` agree by
 * construction), then the kind's own hints (only those the resolver acts on),
 * then `?` and `tab`. `m` and Enter show only once the view is engaged.
 */
export function viewKeyHints(
  state: ViewFocusState,
  facts: ViewKeyFacts = state.facts,
  kindKeys: readonly KeyHint[] = []
): KeyHint[] {
  if (state.viewIndex < 0 || !hasViewKeys(facts)) {
    return [];
  }
  if (state.focus === "composer") {
    return [{ key: "tab", label: "switch side" }];
  }
  const hints: KeyHint[] = [];
  if (facts.rowCount > 1) hints.push({ key: "j k", label: "move" });
  if (state.engaged) {
    if (facts.rowAsks.some((ask) => ask !== null)) {
      hints.push({ key: "enter", label: "open" });
    } else if (facts.fixAsk) {
      hints.push({ key: "enter", label: "fix" });
    }
  }
  if (facts.tabs > 1) hints.push({ key: `1-${Math.min(9, facts.tabs)}`, label: "switch tab" });
  if (facts.pages > 1 && state.page + 1 < facts.pages) hints.push({ key: "space", label: "next page" });
  if (state.showHiddenColumns) {
    hints.push({ key: "→", label: "fewer columns" });
  } else if (facts.hiddenColumns > 0) {
    hints.push({ key: "→", label: "columns" });
  }
  if (state.engaged && (facts.more || facts.livePageNext)) hints.push({ key: "m", label: "more" });
  if (state.engaged && copyTextAt(facts, state.selected)) hints.push({ key: "c", label: "copy" });
  hints.push(...kindKeys.filter((hint) => HANDLED_KIND_KEYS.has(hint.key)));
  if (facts.explain) hints.push({ key: "?", label: "what it does" });
  hints.push({ key: "tab", label: "switch side" });
  return hints;
}

function defaultFocusCtx(caps: KeyContext["caps"]): ViewRenderCtx {
  return {
    width: 80,
    color: false,
    theme: DEFAULT_THEME,
    selected: 0,
    tab: 0,
    page: 0,
    explainOpen: false,
    showHiddenColumns: false,
    caps
  };
}

function asViewList(views: AnswerViewV1 | readonly AnswerViewV1[]): readonly AnswerViewV1[] {
  return Array.isArray(views) ? (views as readonly AnswerViewV1[]) : [views as AnswerViewV1];
}

/** A key press that would type into the composer (space only pages, so it does not count). */
function typesIntoComposer(input: string, key: Partial<Key>): boolean {
  if (!input || input === " " || key.ctrl || key.meta || key.return || key.tab || key.escape) {
    return false;
  }
  return !/^[\u0000-\u001f\u007f]/u.test(input);
}

function asKey(key: Partial<Key>): Key {
  return key as Key;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
