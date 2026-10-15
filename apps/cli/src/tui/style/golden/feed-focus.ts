// R3/R4's feed (focus): the key focus a screen is drawn in, when not the
// default — a write card opened on its documents (`flow-email-02`, `v`
// pressed). The fixtures carry `turn.focus`; the session opens in it through
// `initialFocus`. A list's opening row is NOT fed here: the view names it
// (`body.selected`, view-02 opens on Hook B), so the live session and the
// goldens open on the same row by construction.
//
// OWNED BY R3 (views) and R4 (cards). The lane that adds a session seam for an
// initial focus maps `turn.focus` to it HERE, not in screen.ts.
import type { InkInteractiveSessionAppProps } from "../../ink/interactive-session.js";
import type { R4ScreenFixture } from "./fixtures.js";

export function focusProps(fixture: R4ScreenFixture): Partial<InkInteractiveSessionAppProps> {
  return fixture.turn?.focus?.viewOpen ? { initialFocus: { documentOpen: true } } : {};
}
