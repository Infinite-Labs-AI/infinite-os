// Types for the terminal's answer-view renderers (terminal-r4): one renderer per
// view kind, behind one registry (`registry.ts`), laid out by `layout.ts`.
//
// A renderer DRAWS the view it is given and never derives new facts from it: no
// totals across nulls, no % between steps, no sums across legs, no winner the
// view did not name. Every string from a view is scrubbed before it reaches the
// TTY (`viewText` / `cellText` in `primitives.ts`), and no picture or image URL
// is ever drawn.
import type { AnswerViewEnvelopeV1, AnswerViewKind } from "@infinite-os/types";

import type { KeyContext, KeyHint } from "../keys/keymap.js";
import type { Theme } from "../theme.js";

export interface ViewRenderCtx {
  /** The columns the view may use (the details pane, or the full width when stacked). */
  width: number;
  color: boolean;
  theme: Theme;
  /** The selected row (j/k), the tab (1–9), the page (space), for the focused view. */
  selected: number;
  tab: number;
  page: number;
  /** `?` was pressed: show `view.explain` (the terminal cannot hover). */
  explainOpen: boolean;
  /** `→` was pressed: show the columns a narrow table dropped. */
  showHiddenColumns: boolean;
  caps: KeyContext["caps"];
  /** IANA zone for times (`asOf`); the system zone when absent. Tests pin it. */
  timeZone?: string;
  /**
   * The user has engaged the focused view (tab, or a view key that acted):
   * only then do `m`, Enter and `c` act, so only then does a body offer them
   * (`c copy`). Absent = not engaged (the transcript takes no keys).
   */
  engaged?: boolean;
  /** The view's operation_managed approval was answered or closed here: it is no longer drawn. */
  approvalClosed?: boolean;
  /**
   * The most rows this view may take, when known: a document pages by width ×
   * rows. `renderLiveTurn` starts from the live region's budget and lowers it
   * until the whole turn fits.
   */
  rows?: number;
  /**
   * The view is printed once into scrollback, where no key acts: it names no
   * key (`m for more`, a document's tab keys) and `layout.ts` draws what a key
   * would have shown (dropped columns, every tab).
   */
  scrollback?: boolean;
}

/** One view, drawn. `layout.ts` stacks head, source, detail, then footnotes. */
export interface ViewRender {
  head: string;
  source: string | null;
  detail: string[];
  footnotes: string[];
  /** Key hints only this kind offers (e.g. `c copy`); the shell adds the generic ones. */
  keys: KeyHint[];
  /** The card's named OK key (approvals only); null everywhere else. */
  okKey: string | null;
  /** Rows j/k can select. */
  rowCount: number;
  /**
   * What each selectable row asks when Enter is pressed on it (a NEW user turn,
   * never a tool call). Absent or null for a row: Enter does nothing there.
   */
  rowAsks?: readonly (string | null)[];
  /** Tabs 1–9 switch between (document versions, the emails in a send). */
  tabs?: number;
  /** Pages space moves through (a long document). */
  pages?: number;
  /** Columns the table dropped at this width (`→` shows them). */
  hiddenColumns?: number;
  /**
   * The state's fix ask (`stateReason.fix.ask`) Enter sends as a NEW user turn.
   * Set by the shell only when no row has an ask of its own.
   */
  fixAsk?: string;
  /** What `c` copies on each selectable row (a row's `copy`, else its URL); null = nothing. */
  rowCopies?: readonly (string | null)[];
  /** What `c` copies for the view as a whole (a minted link); used when the row has nothing. */
  copyText?: string;
  /**
   * An operation_managed approval waiting on this view: its named OK key sends
   * `ask` as a NEW user turn (never a confirm). Absent once closed.
   */
  approvalAsk?: { key: string; label: string; ask: string };
  /**
   * A quiet view (a playbook read, a capability check): only its step line, with
   * no head or source. The layout prints it with the Steps, never in the details
   * pane, so it never splits or squeezes the answer.
   */
  quiet?: true;
}

/**
 * What a kind renderer returns: its body only. The registry owns the head, the
 * source line, the state reason, the explanation, truncation and caveats, so no
 * kind can drop or reword them.
 */
export type KindRender = Omit<ViewRender, "head" | "source" | "fixAsk" | "quiet"> & {
  /** The body follows the state's sentence on the next row, with no blank between them (r4 receipts, partial images). */
  joinsReason?: boolean;
  /** The body draws `? what it does` itself (a card), so the shell does not add it. */
  offersExplain?: boolean;
};

export type KindRenderer<K extends AnswerViewKind> = (view: AnswerViewEnvelopeV1<K>, ctx: ViewRenderCtx) => KindRender;
