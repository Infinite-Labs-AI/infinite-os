import { describe, expect, it } from "vitest";

import {
  askConfirmDecision,
  confirmErrorLines,
  confirmResultLines,
  askDismissOnly,
  leftForLaterLine,
  readConfirmAnswer,
  receiptNextAsk
} from "./confirm-result-lines.js";

// Synthetic data only: infinite-os is public.
function receiptView(state: string, sentence: string, tone: "ok" | "warn" = "ok", extra: Record<string, unknown> = {}) {
  return {
    v: 1, kind: "change", tool: "propose_pause_meta_entity", title: "t", state, asOf: null,
    scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
    receipt: { sentence, tone, revertible: true, ...extra },
    body: { target: { kind: "ad", label: "Hook B" }, rows: [], warnings: [] }
  };
}

describe("confirmResultLines", () => {
  it("never prints JSON", () => {
    const lines = confirmResultLines({ ok: true, status: "PAUSED", runId: "r1" }, "approve");
    expect(lines.map((l) => l.text).join("\n")).not.toMatch(/[{}"]/);
    expect(lines[0]).toEqual({ tone: "ok", text: "✓ Done" });
  });

  it("prints the server's receipt sentence verbatim (scrubbed)", () => {
    expect(confirmResultLines({ ok: true, receipt: "Campaign is live — 214 enrolled\u001b[2J" }, "approve")[0]!.text)
      .toBe("✓ Campaign is live — 214 enrolled");
  });

  it("declines say nothing ran", () => {
    expect(confirmResultLines({ ok: true }, "decline")[0]).toEqual({ tone: "muted", text: "✕ Dismissed — nothing was executed." });
  });

  it("prefers the receipt view's sentence", () => {
    const view = { v: 1, kind: "change", tool: "propose_pause_meta_entity", title: "t", state: "done", asOf: null,
      scope: { workspaceName: "W", crossWorkspace: false }, caveats: [], receipt: { sentence: "Paused ad “Hook B”", tone: "ok", revertible: true },
      body: { target: { kind: "ad", label: "Hook B" }, rows: [], warnings: [] } };
    expect(confirmResultLines({ ok: true, view }, "approve")[0]!.text).toBe("✓ Paused ad “Hook B”");
  });

  it("a decline with a receipt view prints the view's sentence, muted", () => {
    const view = receiptView("cancelled", "Dismissed — nothing was executed.");
    expect(confirmResultLines({ ok: true, view }, "decline")).toEqual([
      { tone: "muted", text: "✕ Dismissed — nothing was executed." }
    ]);
  });

  it("a receipt view's state picks the glyph, and its provenance line follows", () => {
    const view = receiptView("outcome_unknown", "Sent, but the reply was lost", "warn", { provenanceLine: "via the app‮" });
    expect(confirmResultLines({ ok: true, view }, "approve")).toEqual([
      { tone: "warn", text: "◑ Sent, but the reply was lost" },
      { tone: "muted", text: "  via the app" }
    ]);
    expect(confirmResultLines({ ok: true, view: receiptView("partial", "2 of 3 done", "warn") }, "approve")[0])
      .toEqual({ tone: "warn", text: "◐ 2 of 3 done" });
    // The receipt's glyph and tone are the view head's (STATE_HEAD): a spending cap is amber, never red.
    expect(confirmResultLines({ ok: true, view: receiptView("hit_limit", "Hit the $5 cap", "warn") }, "approve")[0])
      .toEqual({ tone: "warn", text: "$ Hit the $5 cap" });
  });

  it("an undecodable view falls back to the neutral fields", () => {
    expect(confirmResultLines({ ok: true, view: { v: 2 }, receipt: "Saved" }, "approve")[0]!.text).toBe("✓ Saved");
  });

  it("an old desktop's link fields still print, as plain lines", () => {
    const lines = confirmResultLines({ ok: true, data: { liveUrl: "example.test/x" } }, "approve");
    expect(lines).toEqual([
      { tone: "ok", text: "✓ Done" },
      { tone: "muted", text: "  example.test/x" }
    ]);
  });

  it("a missing result is a plain done or dismissed", () => {
    expect(confirmResultLines(undefined, "approve")).toEqual([{ tone: "ok", text: "✓ Done" }]);
    expect(confirmResultLines(undefined, "decline")).toEqual([{ tone: "muted", text: "✕ Dismissed — nothing was executed." }]);
  });

  it("outcome_unknown prints its reconcile step, never retry words", () => {
    const view = {
      ...receiptView("outcome_unknown", "Not sure it happened", "warn"),
      outcome: "unknown",
      retry: "check_first",
      reconcile: { label: "Check first\u001b[2J", ask: "did the pause of Hook B land?" }
    };
    const lines = confirmResultLines({ ok: false, view }, "approve");
    expect(lines).toEqual([
      { tone: "warn", text: "◑ Not sure it happened" },
      { tone: "warn", text: "→ Check first" }
    ]);
    const words = lines.map((line) => line.text).join("\n");
    expect(words).not.toMatch(/retry|try again/iu);
    // The thrown path (a failed resolution carries the view) prints the same step.
    expect(confirmErrorLines(Object.assign(new Error("x"), { code: "dispatch_uncertain", view }))).toEqual(lines);
    expect(receiptNextAsk({ ok: false, view })).toBe("did the pause of Hook B land?");
    expect(receiptNextAsk({ ok: true, view: receiptView("done", "Paused") })).toBeNull();
    expect(receiptNextAsk(undefined)).toBeNull();
  });
});

describe("confirmErrorLines", () => {
  it("a transport failure says the card stays", () => {
    const unreachable = Object.assign(new Error("Infinite Desktop stopped responding."), { code: "desktop_unreachable" });
    expect(confirmErrorLines(unreachable)).toEqual([
      { tone: "bad", text: "✗ Couldn't reach the app — the card stays until it expires." }
    ]);
  });

  it("an uncoded error is a bug, not a transport failure: it prints its own message", () => {
    expect(confirmErrorLines(new TypeError("fetch failed"))).toEqual([{ tone: "bad", text: "✗ fetch failed" }]);
    expect(confirmErrorLines(new Error(""))).toEqual([{ tone: "bad", text: "✗ Failed." }]);
  });

  it("a failure that carries a receipt view prints its sentence", () => {
    const expired = Object.assign(new Error("expired"), { code: "confirmation_expired", view: receiptView("expired", "This card expired", "warn") });
    expect(confirmErrorLines(expired)).toEqual([{ tone: "muted", text: "◷ This card expired" }]);
  });

  it("an unknown outcome never says the card stays", () => {
    const unknown = Object.assign(new Error("Desktop may have resolved this confirmation.\u001b[2J"), {
      code: "desktop_confirmation_outcome_unknown"
    });
    expect(confirmErrorLines(unknown)).toEqual([
      { tone: "warn", text: "◑ Desktop may have resolved this confirmation." }
    ]);
  });

  it("a detached confirm is an unknown outcome too, never 'the card stays'", () => {
    const detached = Object.assign(new Error("Stopped waiting for Infinite Desktop. Provider work may still continue."), {
      code: "desktop_turn_detached"
    });
    expect(confirmErrorLines(detached)).toEqual([
      { tone: "warn", text: "◑ Stopped waiting for Infinite Desktop. Provider work may still continue." }
    ]);
    const bare = Object.assign(new Error(""), { code: "desktop_turn_detached" });
    expect(confirmErrorLines(bare)).toEqual([{ tone: "warn", text: "◑ Not sure it happened." }]);
  });

  it("any other coded app answer prints its message, scrubbed, under a neutral warn mark", () => {
    const rejected = Object.assign(new Error("Write rejected\nFORGED\u001b]0;t\u0007"), { code: "write_rejected" });
    expect(confirmErrorLines(rejected)).toEqual([{ tone: "warn", text: "! Write rejected FORGED" }]);
  });

  it("an older app's uncertain dispatch (no view) never prints the Failed glyph", () => {
    const message = "Infinite already started this change and couldn't confirm the result. Check it before trying again.";
    const uncertain = Object.assign(new Error(message), { code: "dispatch_uncertain" });
    const lines = confirmErrorLines(uncertain);
    expect(lines).toEqual([{ tone: "warn", text: `! ${message}` }]);
    expect(lines[0]!.text.startsWith("✗")).toBe(false);
  });

  it("a coded app answer with no message still avoids the Failed glyph", () => {
    const bare = Object.assign(new Error(""), { code: "dispatch_uncertain" });
    expect(confirmErrorLines(bare)).toEqual([
      { tone: "warn", text: "! The app couldn't confirm this. Check it before trying again." }
    ]);
  });

  it("a failed receipt view keeps the Failed glyph", () => {
    const failed = Object.assign(new Error("failed"), { code: "write_failed", view: receiptView("failed", "Meta rejected the change") });
    expect(confirmErrorLines(failed)).toEqual([{ tone: "bad", text: "✗ Meta rejected the change" }]);
  });
});

describe("typed answers (readline and one-shot)", () => {
  it("a card that needs a typed value can only be dismissed: y never approves", async () => {
    expect(await askDismissOnly(async () => "n", "q")).toBe("decline");
    expect(await askDismissOnly(async () => "NO ", "q")).toBe("decline");
    expect(await askDismissOnly(async () => "y", "q")).toBe("pending");
    expect(await askDismissOnly(async () => "yes", "q")).toBe("pending");
    expect(await askDismissOnly(async () => "", "q")).toBe("pending");
  });

  it.each([["y", "approve"], ["Y", "approve"], ["yes", "approve"], [" YES ", "approve"],
    ["n", "decline"], ["N", "decline"], ["no", "decline"], ["No ", "decline"],
    ["", null], ["ok", null], ["nah", null], ["yep", null]] as const)("%j → %s", (answer, decision) =>
    expect(readConfirmAnswer(answer)).toBe(decision));

  it("bare Enter re-prompts once, then an n declines", async () => {
    const asked: string[] = [];
    const answers = ["", "n"];
    const decision = await askConfirmDecision(async (q) => { asked.push(q); return answers.shift()!; }, "Approve? [y/n] ");
    expect(decision).toBe("decline");
    expect(asked).toHaveLength(2);
  });

  it("two non-answers leave the card pending", async () => {
    const asked: string[] = [];
    const decision = await askConfirmDecision(async (q) => { asked.push(q); return ""; }, "Approve? [y/n] ");
    expect(decision).toBe("pending");
    expect(asked).toHaveLength(2);
  });

  it("y on the first ask approves without a second ask", async () => {
    const asked: string[] = [];
    expect(await askConfirmDecision(async (q) => { asked.push(q); return "yes"; }, "Approve? [y/n] ")).toBe("approve");
    expect(asked).toHaveLength(1);
  });

  it("left for later names the expiry time when known", () => {
    const at = new Date(2026, 9, 1, 14, 5);
    expect(leftForLaterLine(at.toISOString())).toBe("Left for later — expires 14:05");
    expect(leftForLaterLine(undefined)).toBe("Left for later — nothing was sent.");
    expect(leftForLaterLine("not a date")).toBe("Left for later — nothing was sent.");
  });
});
