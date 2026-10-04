import { describe, expect, it, vi } from "vitest";
import type { AnswerViewV1 } from "@infinite-os/types";
import {
  handleInSessionConfirmation,
  requeueConfirmation,
  type InSessionConfirmationAction
} from "./confirm-in-session.js";

// Synthetic: a change card whose daily budget must be typed.
function budgetView(finishWords?: string): AnswerViewV1 {
  return {
    v: 1, kind: "change", tool: "propose_set_budget", title: "Change daily budget", state: "needs_yes", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { target: { kind: "adset", id: "as_1", label: "Ad set 01" }, rows: [], warnings: [] },
    approval: {
      kind: "card", turnId: "t1", handle: "h1", title: "Change the budget?", summary: null,
      confirmLabel: "Lower to $30/day", dismissLabel: "Dismiss", rows: [],
      fields: [{ key: "adSetBudget", label: "Daily budget", input: "money_per_day", required: true, currency: "USD", current: "40" }],
      ...(finishWords ? { finishInApp: { words: finishWords } } : {})
    }
  } as unknown as AnswerViewV1;
}

describe("handleInSessionConfirmation", () => {
  it("approves → calls confirm → renders the result segment", async () => {
    const out: string[] = [];
    const client = {
      confirm: vi.fn(async () => ({
        ok: true,
        data: { liveUrl: "go.infinite.fast/x" }
      }))
    };
    const io = {
      inputIsTTY: true,
      outputIsTTY: true,
      prompt: async () => "y",
      write: (s: string) => out.push(s)
    };
    await handleInSessionConfirmation(
      {
        confirmationHandle: "h1",
        turnId: "t1",
        summary: "Create link",
        confirmationDetails: []
      },
      io,
      client
    );
    expect(client.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationHandle: "h1", decision: "approve" })
    );
    // A receipt, not JSON: the link still prints, as a plain line.
    expect(out.join("")).toContain("✓ Done\n");
    expect(out.join("")).toContain("go.infinite.fast/x");
    expect(out.join("")).not.toMatch(/[{}"]/);
  });

  it("sanitizes ANSI/control sequences out of the summary in the card and prompt", async () => {
    const out: string[] = [];
    const prompts: string[] = [];
    const client = { confirm: vi.fn() };
    // Summary carries a CSI color sequence, an OSC title-set string (BEL-ended),
    // a raw newline, and a backspace - none may reach the terminal unescaped.
    const hostileSummary =
      "Create \u001b[31mlink\u001b]0;pwn\u0007 now\nline2\u0008x";
    await handleInSessionConfirmation(
      {
        confirmationHandle: "h1",
        turnId: "t1",
        summary: hostileSummary,
        confirmationDetails: []
      },
      {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: async (q: string) => {
          prompts.push(q);
          return "n";
        },
        write: (s: string) => out.push(s)
      },
      client
    );
    const card = out.join("");
    const prompt = prompts.join("");
    // No ESC (0x1b), BEL (0x07), or BS (0x08) survives in either surface.
    for (const text of [card, prompt]) {
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u0007");
      expect(text).not.toContain("\u0008");
    }
    // The card line carries no embedded newline from the summary (only its own
    // trailing "\n"): the injected "\nline2" collapsed to a space.
    const cardLine = card.split("\n")[0];
    expect(cardLine).toContain("Create link");
    expect(cardLine).toContain("line2");
    expect(prompt).toContain("Create link");
  });

  it("bounds an overlong summary in the prompt", async () => {
    const prompts: string[] = [];
    const client = { confirm: vi.fn() };
    await handleInSessionConfirmation(
      {
        confirmationHandle: "h1",
        turnId: "t1",
        summary: "x".repeat(500),
        confirmationDetails: []
      },
      {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: async (q: string) => {
          prompts.push(q);
          return "n";
        },
        write: () => {}
      },
      client
    );
    expect(prompts[0]).toContain("[truncated]");
    // 240-char cap + the `Approve "` / `"? [y/N] ` chrome — nowhere near 500.
    expect(prompts[0]!.length).toBeLessThan(300);
  });

  it.each(["n", "N", "no", "No"])("%j sends a real decline and prints the dismissed line", async (answer) => {
    const out: string[] = [];
    const client = { confirm: vi.fn(async () => ({ ok: true })) };
    await handleInSessionConfirmation(
      { confirmationHandle: "h1", turnId: "t1", summary: "x", confirmationDetails: [] },
      { inputIsTTY: true, outputIsTTY: true, prompt: async () => answer, write: (s: string) => out.push(s) },
      client
    );
    expect(client.confirm).toHaveBeenCalledTimes(1);
    expect(client.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "t1", confirmationHandle: "h1", decision: "decline" })
    );
    expect(out.join("")).toContain("✕ Dismissed — nothing was executed.\n");
    expect(out.join("")).not.toContain("Confirmation declined");
  });

  it.each(["y", "Y", "yes", "YES"])("%j approves", async (answer) => {
    const client = { confirm: vi.fn(async () => ({ ok: true })) };
    await handleInSessionConfirmation(
      { confirmationHandle: "h1", turnId: "t1", summary: "x", confirmationDetails: [] },
      { inputIsTTY: true, outputIsTTY: true, prompt: async () => answer, write: () => {} },
      client
    );
    expect(client.confirm).toHaveBeenCalledWith(expect.objectContaining({ decision: "approve" }));
  });

  it("bare Enter never declines: it re-prompts once, then leaves the card pending", async () => {
    const out: string[] = [];
    const prompts: string[] = [];
    const client = { confirm: vi.fn() };
    const expiresAt = new Date(2026, 9, 1, 9, 30).toISOString();
    await handleInSessionConfirmation(
      {
        confirmationHandle: "h1",
        turnId: "t1",
        summary: "x",
        confirmationDetails: [],
        view: {
          v: 1, kind: "change", tool: "t", title: "Pause", state: "needs_yes", asOf: null,
          scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
          approval: { kind: "card", title: "Pause", summary: null, confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [], expiresAt },
          body: { target: { kind: "ad", label: "Ad 01" }, rows: [], warnings: [] }
        }
      },
      {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: async (q: string) => {
          prompts.push(q);
          return "";
        },
        write: (s: string) => out.push(s)
      },
      client
    );
    expect(prompts).toHaveLength(2);
    expect(client.confirm).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Left for later — expires 09:30\n");
  });

  it("any other answer is not a decline either", async () => {
    const client = { confirm: vi.fn() };
    const out: string[] = [];
    await handleInSessionConfirmation(
      { confirmationHandle: "h1", turnId: "t1", summary: "x", confirmationDetails: [] },
      { inputIsTTY: true, outputIsTTY: true, prompt: async () => "maybe", write: (s: string) => out.push(s) },
      client
    );
    expect(client.confirm).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Left for later — nothing was sent.\n");
  });

  it("a confirm that cannot reach the app says the card stays", async () => {
    const out: string[] = [];
    const client = {
      confirm: vi.fn(async () => {
        throw Object.assign(new Error("Infinite Desktop stopped responding."), { code: "desktop_unreachable" });
      })
    };
    await handleInSessionConfirmation(
      { confirmationHandle: "h1", turnId: "t1", summary: "x", confirmationDetails: [] },
      { inputIsTTY: true, outputIsTTY: true, prompt: async () => "n", write: (s: string) => out.push(s) },
      client
    );
    expect(out.join("")).toContain("✗ Couldn't reach the app — the card stays until it expires.\n");
  });

  it("a card with a required field is never approved here: y leaves it, n declines", async () => {
    for (const [answer, calls] of [["y", 0], ["yes", 0], ["n", 1]] as const) {
      const out: string[] = [];
      const prompts: string[] = [];
      const client = { confirm: vi.fn(async () => ({ ok: true })) };
      await handleInSessionConfirmation(
        { confirmationHandle: "h1", turnId: "t1", summary: "Lower budget", confirmationDetails: [], view: budgetView() },
        { inputIsTTY: true, outputIsTTY: true, prompt: async (q: string) => { prompts.push(q); return answer; }, write: (s: string) => out.push(s) },
        client
      );
      expect(out.join(""), answer).toContain("Answer this in the Infinite app or the chat session");
      expect(prompts.join(""), answer).not.toMatch(/\[y\/n\]/u);
      expect(client.confirm, answer).toHaveBeenCalledTimes(calls);
      if (calls) {
        expect(client.confirm).toHaveBeenCalledWith(expect.objectContaining({ decision: "decline" }));
      }
    }
  });

  it("a required-field card with finishInApp words prints those words instead", async () => {
    const out: string[] = [];
    await handleInSessionConfirmation(
      { confirmationHandle: "h1", turnId: "t1", summary: "x", confirmationDetails: [], view: budgetView("Set the budget in Ads.") },
      { inputIsTTY: true, outputIsTTY: true, prompt: async () => "y", write: (s: string) => out.push(s) },
      { confirm: vi.fn() }
    );
    expect(out.join("")).toContain("Set the budget in Ads.");
  });
});

describe("requeueConfirmation", () => {
  const entry = (handle: string): InSessionConfirmationAction =>
    ({ turnId: "t1", confirmationHandle: handle, summary: handle, confirmationDetails: [] });

  it("a brought-back card goes behind the card the user is on, never ahead of it", () => {
    const queue = [entry("b"), entry("c")];
    expect(requeueConfirmation(queue, entry("a"), "behind_head").map((item) => item.confirmationHandle)).toEqual(["b", "a", "c"]);
    expect(requeueConfirmation([], entry("a"), "behind_head").map((item) => item.confirmationHandle)).toEqual(["a"]);
    // The head object is the same one, so its key state is kept.
    expect(requeueConfirmation(queue, entry("a"), "behind_head")[0]).toBe(queue[0]);
  });

  it("a refused answer puts its card back in front, to fix it now", () => {
    expect(requeueConfirmation([entry("b")], entry("a"), "front").map((item) => item.confirmationHandle)).toEqual(["a", "b"]);
  });
});
