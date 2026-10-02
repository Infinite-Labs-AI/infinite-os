import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import {
  RESERVED_KEYS,
  confirmCardKeys,
  formatKeyBar,
  keyBarHints,
  keyBarRowCount,
  okKeyFor,
  resolveKey,
  type KeyContext,
  type PendingCardKeySource
} from "./keymap.js";

const NO_CAPS = { open: false, watch: false, retry: false } as const;
const card = (over: Partial<KeyContext> = {}): KeyContext =>
  ({ focus: "card", busy: false, okKey: "p", caps: NO_CAPS, ...over });

describe("okKeyFor", () => {
  it.each([["Pause", "p"], ["Send to 214 people", "s"], ["Generate · ~$0.52", "g"], ["Launch 3 ads", "l"],
    ["Activate", "a"], ["Lower to $30/day", "l"], ["Confirm", "y"], ["Run now", "y"]])("%s → %s", (label, k) =>
    expect(okKeyFor(label)).toBe(k));

  it("falls back to y for an empty, non-letter or reserved first character", () => {
    expect(okKeyFor("")).toBe("y");
    expect(okKeyFor("  ")).toBe("y");
    expect(okKeyFor("$30/day")).toBe("y");
    expect(okKeyFor("“Quoted”")).toBe("y");
    expect(okKeyFor("Édit")).toBe("y");
    expect(okKeyFor("Not now")).toBe("y");
    expect(okKeyFor("View")).toBe("y");
    expect(okKeyFor("? help")).toBe("y");
  });

  it("reserves the shared view keys", () => {
    expect([...RESERVED_KEYS].sort()).toEqual(["/", "?", "c", "e", "j", "k", "m", "n", "o", "q", "r", "t", "v", "w"]);
  });
});

describe("resolveKey on a card", () => {
  it("on a card only the named key approves; enter and esc do nothing", () => {
    const ctx = { focus: "card", busy: false, okKey: "p", caps: { open: false, watch: false, retry: false } } as const;
    expect(resolveKey("p", {} as Key, ctx)).toEqual({ type: "ok" });
    expect(resolveKey("y", {} as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("", { return: true } as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("", { escape: true } as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("n", {} as Key, ctx)).toEqual({ type: "dismiss" });
    expect(resolveKey("?", {} as Key, ctx)).toEqual({ type: "explain" });
  });

  it("enter and esc never approve or decline, even when y is the OK key", () => {
    const ctx = card({ okKey: "y" });
    expect(resolveKey("y", {} as Key, ctx)).toEqual({ type: "ok" });
    expect(resolveKey("\r", { return: true } as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("", { escape: true } as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey(" ", {} as Key, ctx)).toEqual({ type: "none" });
  });

  it("a capital letter never decides (it starts a message: \"Show me…\"); ctrl and meta chords never approve", () => {
    for (const okKey of ["p", "s", "l"]) {
      const upper = okKey.toUpperCase();
      expect(resolveKey(upper, { shift: true } as Key, card({ okKey }))).toEqual({ type: "none" });
      expect(resolveKey(upper, {} as Key, card({ okKey }))).toEqual({ type: "none" });
      expect(resolveKey(okKey, {} as Key, card({ okKey }))).toEqual({ type: "ok" });
    }
    expect(resolveKey("S", { shift: true } as Key, card({ okKey: "s" }))).toEqual({ type: "none" });
    expect(resolveKey("P", { shift: true } as Key, card())).toEqual({ type: "none" });
    expect(resolveKey("N", { shift: true } as Key, card())).toEqual({ type: "none" });
    const retryable = card({ caps: { open: true, watch: true, retry: true } });
    expect(resolveKey("R", { shift: true } as Key, retryable)).toEqual({ type: "none" });
    expect(resolveKey("O", { shift: true } as Key, retryable)).toEqual({ type: "none" });
    expect(resolveKey("r", {} as Key, retryable)).toEqual({ type: "retry" });
    expect(resolveKey("p", { ctrl: true } as Key, card())).toEqual({ type: "none" });
    expect(resolveKey("p", { meta: true } as Key, card())).toEqual({ type: "none" });
    expect(resolveKey("n", { ctrl: true } as Key, card())).toEqual({ type: "none" });
  });

  it("a pasted burst never approves", () => {
    expect(resolveKey("pp", {} as Key, card())).toEqual({ type: "none" });
    expect(resolveKey("nope", {} as Key, card())).toEqual({ type: "none" });
  });

  it("a card with no OK key can only be dismissed", () => {
    expect(resolveKey("y", {} as Key, card({ okKey: null }))).toEqual({ type: "none" });
    expect(resolveKey("n", {} as Key, card({ okKey: null }))).toEqual({ type: "dismiss" });
  });

  it("o, w and r work only with their capability", () => {
    expect(resolveKey("o", {} as Key, card())).toEqual({ type: "none" });
    expect(resolveKey("w", {} as Key, card())).toEqual({ type: "none" });
    expect(resolveKey("r", {} as Key, card())).toEqual({ type: "none" });
    const all = card({ caps: { open: true, watch: true, retry: true } });
    expect(resolveKey("o", {} as Key, all)).toEqual({ type: "open" });
    expect(resolveKey("w", {} as Key, all)).toEqual({ type: "watch" });
    expect(resolveKey("r", {} as Key, all)).toEqual({ type: "retry" });
  });

  it("v, 1–9, space, e and c act on a card only when the card offers them", () => {
    const plain = card();
    for (const input of ["v", "1", "3", " ", "e", "c"]) {
      expect(resolveKey(input, {} as Key, plain), input).toEqual({ type: "none" });
    }
    const send = card({ okKey: "s", card: { view: true, viewOpen: true, tabs: 3, page: true, copy: true, edit: true } });
    expect(resolveKey("v", {} as Key, send)).toEqual({ type: "view" });
    expect(resolveKey("1", {} as Key, send)).toEqual({ type: "tab", index: 0 });
    expect(resolveKey("3", {} as Key, send)).toEqual({ type: "tab", index: 2 });
    expect(resolveKey("4", {} as Key, send)).toEqual({ type: "none" });
    expect(resolveKey("0", {} as Key, send)).toEqual({ type: "none" });
    expect(resolveKey(" ", {} as Key, send)).toEqual({ type: "page" });
    expect(resolveKey("e", {} as Key, send)).toEqual({ type: "edit" });
    expect(resolveKey("c", {} as Key, send)).toEqual({ type: "copy" });
  });

  it("the widened card keys never approve or decline: only the OK key and n do", () => {
    const send = card({ okKey: "s", card: { view: true, viewOpen: true, tabs: 9, page: true, copy: true, edit: true } });
    const decisions = new Map<string, string>();
    for (const input of ["s", "n", "y", "v", "e", "c", " ", "1", "9", "p", "j", "k", "m", "q"]) {
      const type = resolveKey(input, {} as Key, send).type;
      if (type === "ok" || type === "dismiss") decisions.set(input, type);
    }
    expect([...decisions]).toEqual([["s", "ok"], ["n", "dismiss"]]);
    expect(resolveKey("\r", { return: true } as Key, send)).toEqual({ type: "none" });
    expect(resolveKey("", { escape: true } as Key, send)).toEqual({ type: "none" });
    // A reserved verb letter can never become the OK key, so v/e/c keep their meaning.
    expect(okKeyFor("View")).toBe("y");
    expect(okKeyFor("Edit")).toBe("y");
    expect(okKeyFor("Copy")).toBe("y");
  });

  it("esc stops a running turn, and is still never a decline", () => {
    expect(resolveKey("", { escape: true } as Key, card({ busy: true }))).toEqual({ type: "stop" });
  });
});

describe("resolveKey elsewhere", () => {
  it("the composer owns typing: letters, ? and enter are not view keys", () => {
    const ctx: KeyContext = { focus: "composer", busy: false, okKey: null, caps: NO_CAPS };
    for (const input of ["p", "n", "y", "?", "o", "j", "1", " "]) {
      expect(resolveKey(input, {} as Key, ctx)).toEqual({ type: "none" });
    }
    expect(resolveKey("", { return: true } as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("", { escape: true } as Key, { ...ctx, busy: true })).toEqual({ type: "stop" });
  });

  it("rows move with j/k and arrows, open with enter, switch tabs with 1–9", () => {
    const ctx: KeyContext = { focus: "rows", busy: false, okKey: null, caps: NO_CAPS };
    expect(resolveKey("j", {} as Key, ctx)).toEqual({ type: "move", delta: 1 });
    expect(resolveKey("", { downArrow: true } as Key, ctx)).toEqual({ type: "move", delta: 1 });
    expect(resolveKey("k", {} as Key, ctx)).toEqual({ type: "move", delta: -1 });
    expect(resolveKey("", { upArrow: true } as Key, ctx)).toEqual({ type: "move", delta: -1 });
    expect(resolveKey("", { return: true } as Key, ctx)).toEqual({ type: "enter" });
    expect(resolveKey("3", {} as Key, ctx)).toEqual({ type: "tab", index: 2 });
    expect(resolveKey("", { rightArrow: true } as Key, ctx)).toEqual({ type: "columns" });
    expect(resolveKey("m", {} as Key, ctx)).toEqual({ type: "more" });
    expect(resolveKey("c", {} as Key, ctx)).toEqual({ type: "copy" });
    expect(resolveKey("", { tab: true } as Key, ctx)).toEqual({ type: "switch_pane" });
    // A rows view never approves anything.
    expect(resolveKey("y", {} as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("n", {} as Key, ctx)).toEqual({ type: "none" });
  });

  it("documents page with space and switch tabs with 1–9", () => {
    const ctx: KeyContext = { focus: "document", busy: false, okKey: null, caps: NO_CAPS };
    expect(resolveKey(" ", {} as Key, ctx)).toEqual({ type: "page" });
    expect(resolveKey("1", {} as Key, ctx)).toEqual({ type: "tab", index: 0 });
    expect(resolveKey("0", {} as Key, ctx)).toEqual({ type: "none" });
    expect(resolveKey("?", {} as Key, ctx)).toEqual({ type: "explain" });
  });
});

describe("keyBarHints", () => {
  it("hides keys whose capability is missing", () =>
    expect(keyBarHints({ focus: "card", busy: false, okKey: "p", caps: { open: false, watch: false, retry: false } })
      .map((h) => h.key)).not.toContain("o"));

  it("a card shows its named OK key with the card's verb, then n dismiss", () => {
    expect(keyBarHints(card({ okLabel: "Pause" }))).toEqual([
      { key: "p", label: "Pause" },
      { key: "n", label: "dismiss" }
    ]);
  });

  it("shows ? only when there is an explanation, and o/w/r only with their capability", () => {
    const hints = keyBarHints(card({ okLabel: "Pause", explain: true, caps: { open: true, watch: true, retry: true } }));
    expect(hints.map((h) => h.key)).toEqual(["p", "n", "o", "w", "r", "?"]);
  });

  it("never offers keys that resolve to nothing", () => {
    const contexts: KeyContext[] = [
      card({ okLabel: "Pause", explain: true }),
      card({ okKey: null }),
      card({ caps: { open: true, watch: true, retry: true }, explain: true }),
      card({ okKey: "s", card: { view: true } }),
      card({ okKey: "s", card: { view: true, viewOpen: true, tabs: 3, page: true, copy: true, edit: true } }),
      { focus: "composer", busy: true, okKey: null, caps: NO_CAPS }
    ];
    for (const ctx of contexts) {
      for (const hint of keyBarHints(ctx)) {
        const key = hint.key === "esc" ? { escape: true } : {};
        const input = hint.key === "esc" ? "" : hint.key === "space" ? " " : hint.key.split("-")[0]!;
        expect(resolveKey(input, key as Key, ctx).type, `${ctx.focus} ${hint.key}`).not.toBe("none");
      }
    }
  });

  it("a send card offers v view before its OK key; an open document offers its tabs and pages", () => {
    expect(formatKeyBar(keyBarHints(card({ okKey: "s", okLabel: "Send to 200 people", card: { view: true } }))))
      .toBe("v view   s Send to 200 people   n dismiss");
    expect(formatKeyBar(keyBarHints(card({
      okKey: "s", okLabel: "Send to 200 people", card: { view: true, viewOpen: true, tabs: 3, page: true }
    })))).toBe("v close   s Send to 200 people   n dismiss   1-3 switch   space next page");
    // terminal-r4 names what the tabs are: `1-3 email`.
    expect(formatKeyBar(keyBarHints(card({
      okKey: "s", okLabel: "Send to 200 people", card: { view: true, viewOpen: true, tabs: 3, tabNoun: "email" }
    })))).toBe("v close   s Send to 200 people   n dismiss   1-3 email");
  });

  it("e and c show only when the card says they work", () => {
    expect(keyBarHints(card()).map((h) => h.key)).not.toContain("e");
    expect(keyBarHints(card()).map((h) => h.key)).not.toContain("c");
    const keys = keyBarHints(card({ okKey: "y", okLabel: "Confirm", card: { edit: true, copy: true } }));
    expect(keys).toEqual([
      { key: "y", label: "Confirm" },
      { key: "n", label: "dismiss" },
      { key: "e", label: "edit in the app" },
      { key: "c", label: "copy" }
    ]);
  });

  it("a running turn shows esc stop, the one key that works in the composer then", () => {
    expect(keyBarHints({ focus: "composer", busy: true, okKey: null, caps: NO_CAPS }))
      .toEqual([{ key: "esc", label: "stop" }]);
    expect(formatKeyBar(keyBarHints({ focus: "composer", busy: true, okKey: null, caps: NO_CAPS })))
      .toBe("esc stop");
  });

  it("the idle composer shows no bar", () => {
    expect(keyBarHints({ focus: "composer", busy: false, okKey: null, caps: NO_CAPS })).toEqual([]);
  });

  it("formats, scrubs and counts the bar rows at the given width", () => {
    const hints = keyBarHints(card({ okLabel: "Pause\u001b[2J‮", explain: true }));
    const line = formatKeyBar(hints);
    expect(line).toBe("p Pause   n dismiss   ? what it does");
    expect(keyBarRowCount(hints, 80)).toBe(1);
    expect(keyBarRowCount([], 80)).toBe(0);
    expect(keyBarRowCount(hints, 10)).toBeGreaterThan(1);
  });
});

describe("confirmCardKeys", () => {
  it("an old desktop (no view) gets y Confirm, and ? shows the pending summary", () => {
    const keys = confirmCardKeys({ summary: "Publish landing page" }, NO_CAPS);
    expect(keys.ctx).toMatchObject({ focus: "card", okKey: "y", okLabel: "Confirm", explain: true });
    expect(keys.explainText).toBe("Publish landing page");
  });

  it("a view names the OK key from approval.confirmLabel and explains with approval.summary", () => {
    const keys = confirmCardKeys({
      summary: "Pause ad",
      view: { explain: "Why", approval: { confirmLabel: "Lower to $30/day", summary: "Saves $10 a day." } }
    }, NO_CAPS);
    expect(keys.ctx.okKey).toBe("l");
    expect(keys.ctx.okLabel).toBe("Lower to $30/day");
    expect(keys.explainText).toBe("Saves $10 a day.");
  });

  it("falls back to view.explain, and scrubs control characters", () => {
    const keys = confirmCardKeys({
      summary: "Pause ad",
      view: { explain: "Stops\u001b]8;;x\u0007 spend", approval: { confirmLabel: "Pause\u001b[31m", summary: null } }
    }, NO_CAPS);
    expect(keys.ctx.okLabel).toBe("Pause");
    expect(keys.explainText).toBe("Stops spend");
  });

  it.each([
    ["an array approval.summary", { approval: { confirmLabel: ["Pause"], summary: ["x"] } }],
    ["an array confirmLabel", { approval: { confirmLabel: ["Pause"], summary: null } }],
    ["a length-carrying explain object", { explain: { length: 2 } }],
    ["a length-carrying summary object", { approval: { confirmLabel: { length: 5 }, summary: { length: 3 } } }]
  ])("a malformed view (%s) falls back to y Confirm without throwing", (_label, view) => {
    const keys = confirmCardKeys(
      { summary: "Pause ad", view: view as unknown as PendingCardKeySource["view"] },
      NO_CAPS
    );
    expect(keys.ctx).toMatchObject({ focus: "card", okKey: "y", okLabel: "Confirm", explain: false });
    expect(keys.explainText).toBeNull();
  });

  it("a view with nothing to explain hides ?", () => {
    const keys = confirmCardKeys({ summary: "Pause ad", view: { approval: { confirmLabel: "Pause", summary: null } } }, NO_CAPS);
    expect(keys.explainText).toBeNull();
    expect(keys.ctx.explain).toBe(false);
  });
});
