import { describe, expect, it } from "vitest";

import { renderInkInteractiveSessionToString } from "./interactive-session.js";
import { homeInventoryRowCount } from "./home-inventory.js";
import { inkTranscriptRowCount } from "./transcript-app.js";
import { DEFAULT_THEME } from "../theme.js";
import type { Msg } from "../types.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const HOME_INVENTORY = {
  tools: [
    { label: "connect" },
    { label: "sync" },
    { label: "generate ads" },
    { label: "insights" }
  ],
  commands: [
    { value: "/connect" },
    { value: "/sync" },
    { value: "/help" },
    { value: "/exit" }
  ],
  connections: [{ label: "X" }, { label: "Facebook" }, { label: "GA4", degraded: true }],
  version: "0.1.1",
  workspace: "Acme"
} as const;

const COLUMNS = 88;

function render(props: Record<string, unknown>): string {
  return renderInkInteractiveSessionToString(
    { columns: COLUMNS, onSubmitLine: async () => ({}), title: "Infinite TUI", ...props } as never,
    { columns: COLUMNS }
  );
}

describe("interactive session home inventory", () => {
  it("renders the wordmark, Tools/Commands/Connected and welcome on the empty home screen", () => {
    const frame = stripAnsi(render({ homeInventory: HOME_INVENTORY }));

    // Reused big INFINITE wordmark (not re-hand-drawn).
    expect(frame).toContain("███████╗");
    expect(frame).toContain("the growth engineer's OS");
    expect(frame).toContain("v0.1.1");
    expect(frame).toContain("workspace: Acme");
    // The capability inventory.
    expect(frame).toContain("Tools");
    expect(frame).toContain("generate ads");
    expect(frame).toContain("Commands");
    expect(frame).toContain("/connect");
    expect(frame).toContain("Connected");
    expect(frame).toContain("Facebook");
    expect(frame).toContain("Welcome to Infinite");
    // …and the inventory sits ABOVE the transcript's top rule.
    const lines = frame.split("\n");
    const toolsRow = lines.findIndex((line) => line.includes("Tools"));
    const ruleRow = lines.findIndex((line) => line.includes("∞ Infinite TUI"));
    expect(toolsRow).toBeGreaterThanOrEqual(0);
    expect(ruleRow).toBeGreaterThan(toolsRow);
  });

  it("keeps the composer-row prediction exact with the inventory present (PR #27 invariant)", () => {
    // The session computes composerRow = homeInventoryRows + inkTranscriptRowCount(showComposer:false).
    // The rendered composer (❯) must land on exactly that row, or the native cursor parks off.
    const predicted =
      homeInventoryRowCount(COLUMNS) +
      inkTranscriptRowCount({
        busy: false,
        columns: COLUMNS,
        homeBanner: true,
        showComposer: false,
        status: ["ready"],
        theme: DEFAULT_THEME,
        title: "Infinite TUI",
        transcript: { messages: [], state: undefined as never },
        nowMs: 5_000
      });

    const lines = stripAnsi(render({ homeInventory: HOME_INVENTORY })).replace(/\n+$/, "").split("\n");
    const composerIndex = lines.findIndex((line) => line.startsWith("❯"));

    expect(composerIndex).toBe(predicted);
  });

  it("does NOT render the inventory once the transcript has messages (shown once, not per message)", () => {
    const messages: Msg[] = [{ role: "user", text: "hello" }];
    const frame = stripAnsi(render({ homeInventory: HOME_INVENTORY, initialMessages: messages }));

    expect(frame).not.toContain("Tools");
    expect(frame).not.toContain("Welcome to Infinite");
    // The user's message renders instead.
    expect(frame).toContain("hello");
  });

  it("degrades gracefully when the connected-sources fetch was unavailable", () => {
    const frame = stripAnsi(render({ homeInventory: { ...HOME_INVENTORY, connections: undefined } }));

    // Still renders the inventory — with a muted note instead of the live line.
    expect(frame).toContain("Tools");
    expect(frame).toContain("Connected");
    expect(frame).toContain("daemon not reachable");
    expect(frame).not.toContain("✓");
  });

  it("falls back to the bare rocket banner when no inventory is supplied", () => {
    const frame = stripAnsi(render({}));

    expect(frame).not.toContain("Tools");
    expect(frame).not.toContain("Welcome to Infinite");
    // The pre-existing home rocket banner still renders.
    expect(frame).toContain("∞ Infinite");
  });
});
