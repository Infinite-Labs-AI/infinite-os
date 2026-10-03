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
import type { MetaRepeats } from "./meta-fold.js";
import type { AppOpenTarget } from "./open-target.js";

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
  /**
   * `false`: `→` does not act on this view (a live turn's view the keys are not
   * on), so a table names what it hid in words, never `→ to see`. Absent = it
   * acts, unless `scrollback`.
   */
  columnKey?: boolean;
  /** Another view of this finished turn has the keys (R-IOV-3): this one names no key (`m for more`). */
  keysElsewhere?: boolean;
  /**
   * What this view repeats of an earlier view of the same read in its turn
   * (N27, `meta-fold.ts`): those parts are not drawn again, and ONE dim line
   * names them. Set by the turn's layout; absent = the view draws whole.
   */
  repeats?: MetaRepeats;
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
  /**
   * What the bar calls Enter's ask when it is not a fix: a quiet call not sure
   * it happened sends its reconcile step (`check first`). Absent = `fix`.
   */
  fixLabel?: string;
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
  /** The view draws `? what it does` inside itself (a card): the key bar does not repeat it. */
  explainInside?: true;
  /**
   * The place `o` opens in the app (app.open.v1), only when the session can
   * open places (`caps.open`): the one the view marks `(o)`. A kind sets null
   * when it decided there is none here (the shell then adds none).
   */
  openLink?: AppOpenTarget | null;
  /** What the bar calls that place (`o  Open in Library`); the link's own label. */
  openLabel?: string;
  /** What `w` asks as a NEW user turn (a job's watch step), only when the session can watch. */
  watchAsk?: string;
}

/**
 * What a kind renderer returns: its body only. The registry owns the head, the
 * source line, the state reason, the explanation, truncation and caveats, so no
 * kind can drop or reword them.
 */
export type KindRender = Omit<ViewRender, "head" | "source" | "fixAsk" | "quiet"> & {
  /**
   * Lines the shell prints first in the details, right under the head and the
   * source, before the explanation and the state's sentence: what names the
   * view's object when the body draws no object (a settled change's target
   * path, contract revision 3).
   */
  lead?: string[];
  /** The body follows the state's sentence on the next row, with no blank between them (r4 receipts, partial images). */
  joinsReason?: boolean;
  /** The body draws `? what it does` itself (a card), so the shell does not add it. */
  offersExplain?: boolean;
};

export type KindRenderer<K extends AnswerViewKind> = (view: AnswerViewEnvelopeV1<K>, ctx: ViewRenderCtx) => KindRender;
