// The write card the session draws under the transcript (terminal-r4 "Needs
// your OK"). Purely presentational: every key stays with the single
// `useInput` owner in `interactive-session.tsx`.
//
// - A card the desktop sent as an approval view is drawn by
//   `views/approval.ts`; its lines arrive scrubbed, coloured and laid out.
// - A desktop that sends no view gets the SAME r4 card: an amber box with the
//   app's summary in its top border (never the tool's name: a summary made
//   from it gives way to "Approve this write?"), the already-redacted
//   `confirmationDetails` as field rows, the key chips inside (`y Confirm`
//   on amber, `n dismiss`) and `? what it does` last; `?` opens the summary
//   inside the card.
//
// Every line goes through the ANSI bridge (`AnsiLine`), so the chips'
// backgrounds and the bold labels reach the screen.
import React from "react";

import { terminalText, type InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { confirmCardKeys, keyBarHints } from "../keys/keymap.js";
import { colorEnabled, DEFAULT_THEME, type Theme } from "../theme.js";
import type { ApprovalRender } from "../views/approval.js";
import { cardBody, cardBox, cardWidth, chipRows, fieldRows } from "../views/card.js";
import { wrapText } from "../views/primitives.js";
import { Box } from "./renderer.js";
import { AnsiLine } from "./transcript-app.js";

/** The card's title when the app sent no summary of its own. */
const UNNAMED_WRITE = "Approve this write?";
/** No view, so nothing to open, watch or retry. */
const NO_CAPS = { open: false, watch: false, retry: false } as const;

/** The lines of the r4 card for a pending write that came without an approval view. */
export function fallbackCardLines(
  pending: InSessionConfirmationAction,
  explainText: string | null,
  width: number,
  theme: Theme = DEFAULT_THEME
): string[] {
  const ctx = { color: colorEnabled(theme), theme };
  const keys = confirmCardKeys(pending, NO_CAPS);
  const inner = cardWidth(width) - 4;
  const summary = pending.summaryFromTool ? "" : terminalText(pending.summary);
  const rows = fieldRows(
    pending.confirmationDetails.map((detail) => ({ label: terminalText(detail.label), value: terminalText(detail.value) })),
    inner,
    ctx
  );
  const explain = explainText ? ["", ...wrapText(terminalText(explainText), inner)] : [];
  const chips = chipRows(keyBarHints(keys.ctx).filter((hint) => hint.key !== "?"), keys.ctx.okKey, inner, ctx);
  return cardBox(summary || UNNAMED_WRITE, cardBody([...rows, ...explain], chips, keys.ctx.explain === true, ctx), width, "amber", ctx);
}

/** Rows the card for a pending write without a view takes (the live region reserves them). */
export function fallbackCardRowCount(pending: InSessionConfirmationAction, explainText: string | null, width: number): number {
  return fallbackCardLines(pending, explainText, width).length;
}

/** The head pending write's card: the view's card when there is one, else the r4 card from its details. */
export function ConfirmActionMenu({
  card,
  explainText,
  pending,
  theme,
  width
}: {
  /** The card drawn from its approval view (views/approval.ts), else null (an old desktop). */
  card: ApprovalRender | null;
  /** The scrubbed `?` text when the explanation is open, else null. */
  explainText: string | null;
  pending: InSessionConfirmationAction | null;
  theme: Theme;
  width: number;
}) {
  if (!pending) {
    return null;
  }
  const lines = card ? card.lines : fallbackCardLines(pending, explainText, width, theme);
  // Ink gives an empty <Text> no height: a blank row is drawn as one space, so
  // the card takes exactly `lines.length` rows (the live region reserves them).
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, index) => <AnsiLine key={`card-${index}`} line={line || " "} />)}
    </Box>
  );
}
