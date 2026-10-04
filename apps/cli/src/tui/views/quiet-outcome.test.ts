// Wave 3 r1 (TJ-1): a quiet call that did NOT do its thing (not sure it
// happened, blocked, out of budget) says so: its head, its reason, its fix,
// and for outcome_unknown the reconcile step on a key. Never a retry, unless
// the app dedupes a resend (`safe_resend`). Synthetic views only.
import { readFileSync } from "node:fs";

import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { resolveViewKey, viewFocusAfterTurnDone, viewKeyHints } from "./focus.js";
import { renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});

function quiet(raw: Record<string, unknown>): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "quiet", tool: "send_note", title: "Note send", state: "ready", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { stepLine: "Note send", degraded: true }, ...raw
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const text = (render: ViewRender): string => [render.head, render.source ?? "", ...render.detail, ...render.footnotes].join("\n");

const UNKNOWN = quiet({
  state: "outcome_unknown", outcome: "unknown", retry: "check_first",
  stateReason: { code: "transport_unknown", words: "The request did not complete, so it may or may not have gone through." },
  reconcile: { label: "Check first", ask: "Check whether the note went through before trying it again." }
});
const BLOCKED = quiet({
  tool: "list_drafts", title: "Drafts", state: "blocked",
  stateReason: { code: "entitlement_required", words: "This workspace has no active plan, so this is not available here." },
  body: { stepLine: "Drafts", degraded: true }
});
const LIMIT = quiet({
  tool: "queue_draft", title: "Draft", state: "hit_limit",
  stateReason: {
    code: "daily_cap", words: "This workspace has used today's draft. Trying again today will be refused the same way.",
    fix: { label: "See the limits", ask: "what are my limits?" }
  },
  body: { stepLine: "Draft", degraded: true }
});

describe("a quiet view that did not do its thing says so (TJ-1)", () => {
  it("outcome_unknown: head, reason and the reconcile step, never a retry", () => {
    const render = renderView(UNKNOWN, ctx());
    expect(render.quiet).toBeUndefined();
    expect(render.head).toBe("[Note send] ◑ Not sure it happened");
    const out = text(render);
    expect(out).toContain("◑ The request did not complete, so it may or may not have gone through.");
    expect(out).toContain("→ Check first");
    expect(out).not.toMatch(/try again|retry/iu);
    expect(render.okKey).toBeNull();
    expect(render.fixAsk).toBe("Check whether the note went through before trying it again.");
  });

  it("outcome_unknown: the key sends the reconcile ask as a new turn, and the bar names it with the view's words", () => {
    const state = viewFocusAfterTurnDone(UNKNOWN);
    const engaged = resolveViewKey("", state, { tab: true });
    expect(engaged.engaged).toBe(true);
    expect(viewKeyHints(engaged)).toContainEqual({ key: "enter", label: "check first" });
    const pressed = resolveViewKey("", engaged, { return: true });
    expect(pressed.effect).toEqual({ type: "ask", text: "Check whether the note went through before trying it again." });
    // Enter before the view is engaged does nothing (Enter never acts on its own).
    expect(resolveViewKey("", state, { return: true }).effect).toBeNull();
  });

  it("a safe resend keeps its reconcile step too; the quiet view still has no OK key", () => {
    const render = renderView(quiet({ ...UNKNOWN, retry: "safe_resend" } as unknown as Record<string, unknown>), ctx());
    expect(text(render)).toContain("→ Check first");
    expect(render.okKey).toBeNull();
  });

  it("blocked: head and the reason in its words", () => {
    const render = renderView(BLOCKED, ctx());
    expect(render.head).toBe("[Drafts] ⊗ Blocked");
    expect(text(render)).toContain("⊗ This workspace has no active plan, so this is not available here.");
    expect(render.fixAsk).toBeUndefined();
  });

  it("hit_limit: head, reason and its fix line (Enter sends the fix once engaged)", () => {
    const render = renderView(LIMIT, ctx());
    expect(render.head).toBe("[Draft] $ Hit a limit");
    const out = text(render);
    expect(out).toContain("$ This workspace has used today's draft.");
    expect(out).toContain("→ See the limits");
    expect(render.fixAsk).toBe("what are my limits?");
  });

  it("a short reason replaces the head's generic words", () => {
    const render = renderView(quiet({ ...BLOCKED, stateReason: { code: "x", short: "Owners only", words: "Only an owner can do this." } } as unknown as Record<string, unknown>), ctx());
    expect(render.head).toBe("[Drafts] ⊗ Owners only");
  });

  const messages: Msg[] = [{ role: "user", text: "send the note" }, { role: "assistant", text: "I could not tell if it went." }];
  for (const width of [48, 60, 80, 100, 140]) {
    it(`draws in the turn and in scrollback, every line within ${width} columns`, () => {
      for (const view of [UNKNOWN, BLOCKED, LIMIT]) {
        const live = renderLiveTurn({ messages, views: [view], focus: null, width, color: false, theme }).lines;
        const committed = renderCommittedTurn({ messages, views: [view], focus: null, width, color: false, theme });
        for (const lines of [live, committed]) {
          expect(lines.join("\n")).toMatch(/Not sure it happened|Blocked|Hit a limit/u);
          expect(lines.join("\n")).not.toContain("steps only");
          for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(width);
        }
      }
    });
  }

  it("the generic failure view (failed, a developer's reason) still draws nothing of its own (run-2 M6)", () => {
    const failed = quiet({ state: "failed", stateReason: { code: "invalid_input", words: "Use a half-open UTC window" } });
    expect(renderView(failed, ctx()).detail).toEqual([]);
    expect(renderView(failed, ctx()).quiet).toBe(true);
  });
});

describe("the reconcile step is reachable when the turn has other views (R-IOV-3, R-IOV-7a)", () => {
  const FIXTURES = new URL("./__fixtures__/", import.meta.url);
  const listRows = (): AnswerViewV1 =>
    decodeAnswerView(JSON.parse(readFileSync(new URL("list-rows.json", FIXTURES), "utf8")))!;
  const messages: Msg[] = [{ role: "user", text: "look it up, then send the note" }, { role: "assistant", text: "I could not tell if it went." }];

  it("[a list, then a quiet outcome_unknown]: the quiet view takes the keys, Enter sends reconcile.ask", () => {
    const views = [listRows(), UNKNOWN];
    const state = viewFocusAfterTurnDone(views);
    expect(state.viewIndex).toBe(1);
    const engaged = resolveViewKey("", state, { tab: true });
    expect(viewKeyHints(engaged)).toContainEqual({ key: "enter", label: "check first" });
    const pressed = resolveViewKey("", engaged, { return: true });
    expect(pressed.effect).toEqual({ type: "ask", text: "Check whether the note went through before trying it again." });
    const live = renderLiveTurn({ messages, views, focus: engaged, width: 100, color: false, theme }).lines.join("\n");
    expect(live).toContain("→ Check first");
  });

  it("[a list with more rows, then a quiet outcome_unknown]: the list names no m key it no longer has", () => {
    const list = listRows();
    const paged = { ...list, body: { ...(list.body as unknown as Record<string, unknown>), truncated: { shown: 2, total: 3, more: { label: "More", ask: "show all of them" } } } } as unknown as AnswerViewV1;
    const engaged = resolveViewKey("", viewFocusAfterTurnDone([paged, UNKNOWN]), { tab: true });
    const live = renderLiveTurn({ messages, views: [paged, UNKNOWN], focus: engaged, width: 100, color: false, theme }).lines.join("\n");
    expect(live).toMatch(/2 of 3/u);
    expect(live).not.toContain("m for more");
    // Alone, the list keeps its keys and says m.
    const alone = renderLiveTurn({ messages, views: [paged], focus: viewFocusAfterTurnDone(paged), width: 100, color: false, theme }).lines.join("\n");
    expect(alone).toContain("m for more");
  });

  it("[a list, then a quiet view with nothing to ask]: the list keeps the keys", () => {
    const views = [listRows(), BLOCKED];
    expect(viewFocusAfterTurnDone(views).viewIndex).toBe(0);
  });

  it("[a list, then a quiet hit_limit with a fix]: the quiet view takes the keys, Enter sends its fix", () => {
    const views = [listRows(), LIMIT];
    const state = viewFocusAfterTurnDone(views);
    expect(state.viewIndex).toBe(1);
    const pressed = resolveViewKey("", resolveViewKey("", state, { tab: true }), { return: true });
    expect(pressed.effect).toEqual({ type: "ask", text: "what are my limits?" });
  });

  it("outcome_unknown with a fix AND a reconcile: Enter checks first; the fix draws no keyless action line", () => {
    const both = quiet({
      ...UNKNOWN,
      stateReason: { code: "transport_unknown", words: "The request did not complete.", fix: { label: "Reconnect mail", ask: "reconnect my mail" } }
    } as unknown as Record<string, unknown>);
    const render = renderView(both, ctx());
    expect(render.fixAsk).toBe("Check whether the note went through before trying it again.");
    expect(render.fixLabel).toBe("check first");
    const out = text(render);
    expect(out).toContain("→ Check first");
    expect(out).not.toContain("→ Reconnect mail");
    const state = viewFocusAfterTurnDone(both);
    const pressed = resolveViewKey("", resolveViewKey("", state, { tab: true }), { return: true });
    expect(pressed.effect).toEqual({ type: "ask", text: "Check whether the note went through before trying it again." });
  });
});
