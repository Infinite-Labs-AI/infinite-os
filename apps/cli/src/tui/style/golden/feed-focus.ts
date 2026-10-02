// R3/R4's feed (focus): the key focus a screen is drawn in, when not the
// default — the selected row (`view-02-list` selects Hook B) or a write card
// opened on its documents (`flow-email-02`, `v` pressed). The fixtures carry
// `turn.focus`; the session takes no initial focus yet, so this returns no
// props and those two screens stay on the expected-fail list.
//
// OWNED BY R3 (views) and R4 (cards). The lane that adds a session seam for an
// initial focus maps `turn.focus` to it HERE, not in screen.ts.
import type { InkInteractiveSessionAppProps } from "../../ink/interactive-session.js";
import type { R4ScreenFixture } from "./fixtures.js";

export function focusProps(_fixture: R4ScreenFixture): Partial<InkInteractiveSessionAppProps> {
  return {};
}
