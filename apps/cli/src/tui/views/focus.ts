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
// - a key that acts before the view is engaged (`j`, `2`) is typed too when
//   the very next key types ("just" stays "just", never "ust");
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
import { changeCardSummary } from "./change.js";
import { compareHasRangeMethod } from "./compare.js";
import { listOpeningRow } from "./list.js";
import { managedApproval } from "./managed.js";
import type { AppOpenTarget } from "./open-target.js";
import { truncatedMoreAsk, turnAsk, viewText } from "./primitives.js";
import { quietStopAsk, renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

export { turnAsk };

/** What a key asks the session to do beyond redrawing. */
export type ViewKeyEffect =
  /** Send this as a NEW user turn (never a direct tool call). */
  | { type: "ask"; text: string }
  /** Page the live region down (a tall turn without a `more` ask). */
  | { type: "page_live" }
  /** Put this (scrubbed) text on the clipboard (`c`: a link, an id, an email). */
  | { type: "copy"; text: string }
  /**
   * Type this into the composer ahead of the key just pressed: a key that
   * acted on the view before it was engaged turned out to start a message
   * (`j` then `u` is "ju…", never "u…").
   */
  | { type: "type"; text: string }
  /**
   * Open this place in the app (`o`, app.open.v1): the desktop's /v1/open with
   * place + params, never a browser and never a URL.
   */
  | { type: "open"; target: AppOpenTarget };

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
  /** What the bar calls that ask (`check first` for a reconcile step); absent = `fix`. */
  fixLabel?: string;
  /** The live region has more lines below (`m` pages it when there is no `more` ask). */
  livePageNext: boolean;
  /** What `c` copies on each selectable row (null = nothing on that row). */
  rowCopies: readonly (string | null)[];
  /** What `c` copies for the whole view, when the selected row has nothing. */
  copy: string | null;
  /** An operation_managed approval: its named OK key sends `ask` as a new user turn. */
  approve: { key: string; label: string; ask: string } | null;
  /** The view is a table of numbers: `j k` moves by row (terminal-r4 `j k row`). */
  table?: boolean;
  /** What the tabs are (`1-3 email`, terminal-r4), when every tab is one kind of thing. */
  tabNoun?: string | null;
  /** The view draws `? what it does` inside itself (a card): `?` is not repeated on the bar. */
  explainInside?: boolean;
  /** The place `o` opens and what the bar calls it (only when the session can open places). */
  open?: { target: AppOpenTarget; label: string } | null;
  /** What `w` asks as a new user turn (a job's watch step; only when the session can watch). */
  watch?: string | null;
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
  /** The view's operation_managed approval was answered (OK) or closed (`n`) here. */
  approvalClosed: boolean;
  /**
   * A printable key that acted on the view while it was not yet engaged (`j`,
   * `2`): if the very next key types, this is typed first. Any other next key
   * clears it.
   */
  typedAhead: string;
  /** Whether the last key acted on the view; false = it goes to the composer. */
  handled: boolean;
  effect: ViewKeyEffect | null;
}

export const NO_VIEW_CAPS: KeyContext["caps"] = { open: false, watch: false, retry: false };

const EMPTY_FACTS: ViewKeyFacts = {
  rowCount: 0, rowAsks: [], tabs: 0, pages: 0, hiddenColumns: 0, explain: false, more: null, fixAsk: null, livePageNext: false,
  rowCopies: [], copy: null, approve: null
};

/**
 * The view the keys act on: the last quiet call that stopped with a step to
 * take (`quietStopAsk`), else the last one that is not quiet (steps only), else
 * the last. A folded lookup (`foldedLookups`) is not drawn, so it never takes
 * the keys; with every view folded, none does (-1).
 */
export function focusedViewIndex(views: readonly AnswerViewV1[], folded: ReadonlySet<number> = NONE_FOLDED): number {
  // A quiet call that stopped with a step to take (`Check first`, its fix) takes the keys first (R-IOV-3).
  for (let index = views.length - 1; index >= 0; index -= 1) {
    if (!folded.has(index) && views[index] && quietStopAsk(views[index]!) !== null) {
      return index;
    }
  }
  let last = -1;
  for (let index = views.length - 1; index >= 0; index -= 1) {
    if (folded.has(index)) {
      continue;
    }
    if (views[index]?.kind !== "quiet") {
      return index;
    }
    if (last < 0) {
      last = index;
    }
  }
  return last;
}

const NONE_FOLDED: ReadonlySet<number> = new Set();

/**
 * The views that are only a lookup of a write card's own target: a list whose
 * every row is the thing a change card in the turn acts on, with nothing more
 * behind it. r4 draws the card alone and the lookup as its Steps row
 * (`checking your campaigns ✓ 1 ad`), so such a list is not drawn while the
 * card is on its turn (waiting, working or answered). `all` is every view of
 * the turn, the cards drawn as details included. A list with any other row,
 * or more than it shows, stays a view.
 *
 * A row is the target by its id when the target has one. A target with no id
 * matches by name only a list of ONE row: two different things under the
 * same name stay visible beside a write (a wrong pick on a write is never hidden).
 */
export function foldedLookups(views: readonly AnswerViewV1[], all: readonly AnswerViewV1[]): ReadonlySet<number> {
  const targets = all.flatMap((view) => {
    if (view.kind !== "change" || !isPlainRecord(view.body) || !isPlainRecord(view.body.target)) return [];
    const { id, label } = view.body.target;
    return [{ id: typeof id === "string" && id ? id : null, label: typeof label === "string" && label ? label : null }];
  });
  const folded = new Set<number>();
  if (!targets.length) return folded;
  views.forEach((view, index) => {
    if (view.kind !== "list" || !isPlainRecord(view.body)) return;
    const body = view.body as Record<string, unknown>;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const groups = Array.isArray(body.groups) ? body.groups : [];
    const more = (typeof body.total === "number" && body.total > rows.length) || isPlainRecord(body.omitted) || isPlainRecord(body.truncated);
    const isTarget = (row: unknown) => isPlainRecord(row) && targets.some((target) =>
      target.id !== null ? row.id === target.id : rows.length === 1 && target.label !== null && row.title === target.label);
    if (rows.length && !groups.length && !more && rows.every(isTarget)) folded.add(index);
  });
  return folded;
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
    explain: viewText(view.explain) !== "" || (managedApproval(view)?.summary ?? "") !== "" || changeCardSummary(view) !== ""
      || compareHasRangeMethod(view),
    more: turnAsk(truncatedMoreAsk(view)),
    fixAsk: turnAsk(render.fixAsk),
    ...(viewText(render.fixLabel) ? { fixLabel: viewText(render.fixLabel) } : {}),
    livePageNext,
    rowCopies: (render.rowCopies ?? []).map((text) => viewText(text) || null),
    copy: viewText(render.copyText) || null,
    approve: approveFact(render.approvalAsk),
    open: render.openLink ? { target: render.openLink, label: viewText(render.openLabel) || "open in the app" } : null,
    watch: turnAsk(render.watchAsk),
    table: view.kind === "numbers",
    tabNoun: view.kind === "document" ? documentTabNoun(view.body) : null,
    ...(render.explainInside ? { explainInside: true } : {})
  };
}

/** The noun a document's tabs share ("Email 1", "Email 2" → "email"); null when they differ or there are none. */
function documentTabNoun(body: unknown): string | null {
  const versions = isPlainRecord(body) && Array.isArray(body.versions) ? body.versions : [];
  const nouns = new Set(
    versions
      .map((version) => (isPlainRecord(version) ? viewText(version.slot) || viewText(version.label) : ""))
      .map((label) => label.replace(/\s*\d+$/u, "").trim().toLowerCase())
  );
  const [noun] = [...nouns];
  return nouns.size === 1 && noun ? noun : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approveFact(value: ViewRender["approvalAsk"]): ViewKeyFacts["approve"] {
  const ask = turnAsk(value?.ask);
  return value && ask && value.key ? { key: value.key, label: viewText(value.label, "Confirm"), ask } : null;
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
    || facts.rowCopies.some((text) => text !== null)
    || facts.approve !== null
    || Boolean(facts.open)
    || Boolean(facts.watch);
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
  caps: KeyContext["caps"] = NO_VIEW_CAPS,
  statusViews: readonly AnswerViewV1[] = []
): ViewFocusState {
  const list = asViewList(views);
  // `statusViews`: the turn's views drawn elsewhere (a card waiting as details), which can fold a lookup.
  const viewIndex = focusedViewIndex(list, foldedLookups(list, [...list, ...statusViews]));
  const view = list[viewIndex];
  const facts = view ? viewKeyFacts(view, renderView(view, defaultFocusCtx(caps))) : EMPTY_FACTS;
  const detailsFocus = view?.kind === "document" ? "document" : "rows";
  return {
    viewIndex,
    focus: hasViewKeys(facts) ? detailsFocus : "composer",
    detailsFocus,
    // A list opens on the row its view names (r4 view-02: the flagged Demo B).
    selected: view ? Math.min(openingRow(view), Math.max(0, facts.rowCount - 1)) : 0,
    tab: 0,
    page: 0,
    explainOpen: false,
    showHiddenColumns: false,
    caps,
    facts,
    engaged: false,
    approvalClosed: false,
    typedAhead: "",
    handled: false,
    effect: null
  };
}

/** The row a view opens on before any key: the one it names (a list's `body.selected`), else the first. */
export function openingRow(view: AnswerViewV1): number {
  return listOpeningRow(view);
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
    caps: state.caps,
    engaged: state.engaged && state.focus !== "composer",
    ...(state.approvalClosed ? { approvalClosed: true } : {})
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
  const base: ViewFocusState = { ...state, facts, typedAhead: "", handled: false, effect: null };
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
  // An operation_managed approval, once the view is engaged: ONLY its named OK
  // key (exact, lowercase) sends the ask as a new user turn, and ONLY `n`
  // closes it here. Unengaged, both are the first letters of a message.
  const approve = state.approvalClosed ? null : facts.approve;
  if (approve && state.engaged && !key.ctrl && !key.meta) {
    if (input === approve.key) {
      return { ...base, approvalClosed: true, handled: true, effect: { type: "ask", text: approve.ask } };
    }
    if (input === "n") {
      return { ...base, approvalClosed: true, handled: true };
    }
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
  if (next.handled) {
    // Before the view is engaged, a printable key that acts (`j`, `2`) may be
    // the first letter of a message: the next key decides.
    return !state.engaged && typesIntoComposer(input, key) ? { ...next, typedAhead: input } : next;
  }
  if (!typesIntoComposer(input, key)) {
    return next;
  }
  // The key starts a message: the composer takes it, after any key that
  // acted just before it ("just", not "ust").
  return {
    ...next,
    focus: "composer",
    engaged: false,
    ...(state.typedAhead ? { effect: { type: "type" as const, text: state.typedAhead } } : {})
  };
}

/**
 * The kind keys (`render.keys`) whose action `applyViewAction` carries out. A
 * kind hint is shown only for these, so the bar never offers a key that types.
 * A lane that adds a reducer case for v/e/o/w/r adds its key here with it.
 * `c` is not a kind key: its hint comes from the facts (`copyTextAt`), so a
 * kind says what to copy (`rowCopies`, `copyText`) and never lists `c` itself.
 */
export const HANDLED_KIND_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * The composer bar's word for `o`, as r4 draws it: `open`, or `open in <place>`
 * when the link names itself that way (flow-images `o open in Library`). Never
 * a link's raw label (`Posts`, `Connect the store`): those read as the place,
 * not the key, and stay on the view's own `(o)` line.
 */
function openBarLabel(label: string): string {
  const named = /^open in\s+(.+)$/iu.exec(label.trim());
  return named ? `open in ${named[1]}` : "open";
}

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
    case "open":
      // Unengaged, `o` is the first letter of a message ("ok…", "open…").
      // Engaged, it asks the app to open the place the view marks `(o)`.
      return state.engaged && facts.open ? handled({ effect: { type: "open", target: facts.open.target } }) : state;
    case "watch":
      // Unengaged, `w` is the first letter of a message ("what…"). Engaged, a
      // job that can say it finished sends its watch step as a new turn.
      return state.engaged && facts.watch ? handled({ effect: { type: "ask", text: facts.watch } }) : state;
    case "switch_pane":
      return { ...state, focus: "composer", engaged: false, handled: true };
    default:
      // ok/dismiss belong to approval cards; retry/edit/view arrive with the
      // renderers and capabilities that give them meaning.
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
    return [tabHint(state, facts)];
  }
  const hints: KeyHint[] = [];
  if (state.engaged && facts.approve && !state.approvalClosed) {
    hints.push({ key: facts.approve.key, label: facts.approve.label, ok: true }, { key: "n", label: "dismiss" });
  }
  if (facts.rowCount > 1) hints.push({ key: "j k", label: facts.table ? "row" : "move" });
  if (state.engaged) {
    if (facts.rowAsks.some((ask) => ask !== null)) {
      hints.push({ key: "enter", label: "open" });
    } else if (facts.fixAsk) {
      hints.push({ key: "enter", label: facts.fixLabel || "fix" });
    }
  }
  if (facts.tabs > 1) hints.push({ key: `1-${Math.min(9, facts.tabs)}`, label: facts.tabNoun || "switch tab" });
  if (facts.pages > 1 && state.page + 1 < facts.pages) hints.push({ key: "space", label: "next page" });
  if (state.showHiddenColumns) {
    hints.push({ key: "→", label: "fewer columns" });
  } else if (facts.hiddenColumns > 0) {
    hints.push({ key: "→", label: "columns" });
  }
  if (state.engaged && (facts.more || facts.livePageNext)) hints.push({ key: "m", label: "more" });
  if (state.engaged && copyTextAt(facts, state.selected)) hints.push({ key: "c", label: "copy" });
  // `o` and `w` from the facts (T12), so the bar and the resolver agree; once engaged, as `m` and `c`.
  // r4 draws them `w watch` then `o open` (view-08-job); the link's own words stay on its in-view line.
  if (state.engaged && facts.watch) hints.push({ key: "w", label: "watch" });
  if (state.engaged && facts.open) hints.push({ key: "o", label: openBarLabel(facts.open.label) });
  hints.push(...kindKeys.filter((hint) => HANDLED_KIND_KEYS.has(hint.key)));
  // `?` is the bar's (run-2 N12), `? hide` while open; a card keeps its own inside it.
  if (facts.explain) {
    hints.push({ key: "?", label: state.explainOpen ? "hide" : "what it does", ...(facts.explainInside ? { chipOnly: true } : {}) });
  }
  hints.push(tabHint(state, facts));
  return hints;
}

/**
 * The bar's `tab` chip. Before the view is engaged, `o`, `w`, `m` and `c` are
 * the first letter of a message (an empty prompt never captures a letter, as
 * in any coding harness), so the resting bar says honestly what tab unlocks:
 * ONE chip naming the first such key the view offers, by priority o > w > m >
 * c (`tab then o open in Meta Ads`), in place of `tab switch side`. Engaged,
 * or with nothing behind the gate, it is `tab switch side`. (TJ-3; r4's
 * goldens draw `o open` at rest: a deliberate deviation for the visual eval.)
 */
function tabHint(state: ViewFocusState, facts: ViewKeyFacts): KeyHint {
  const unlocks = state.engaged && state.focus !== "composer" ? null : gatedKeyHint(state, facts);
  return { key: "tab", label: unlocks ? `then ${unlocks.key} ${unlocks.label}` : "switch side" };
}

/** The first key the engagement gate holds back, by priority o > w > m > c (null = none). */
function gatedKeyHint(state: ViewFocusState, facts: ViewKeyFacts): KeyHint | null {
  if (facts.open) return { key: "o", label: openBarLabel(facts.open.label) };
  if (facts.watch) return { key: "w", label: "watch" };
  if (facts.more || facts.livePageNext) return { key: "m", label: "more" };
  if (copyTextAt(facts, state.selected)) return { key: "c", label: "copy" };
  return null;
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
