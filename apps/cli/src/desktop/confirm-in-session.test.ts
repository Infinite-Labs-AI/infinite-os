import { describe, expect, it, vi } from "vitest";
import { handleInSessionConfirmation } from "./confirm-in-session.js";

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
    expect(out.join("")).toContain("go.infinite.fast/x");
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

  it("declines on n/Enter → does not call confirm", async () => {
    const client = { confirm: vi.fn() };
    await handleInSessionConfirmation(
      {
        confirmationHandle: "h1",
        turnId: "t1",
        summary: "x",
        confirmationDetails: []
      },
      { inputIsTTY: true, outputIsTTY: true, prompt: async () => "", write: () => {} },
      client
    );
    expect(client.confirm).not.toHaveBeenCalled();
  });
});
