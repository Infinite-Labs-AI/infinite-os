import { describe, expect, it } from "vitest";

import { renderInkInteractiveSessionToString } from "./interactive-session.js";
import { homeInventoryRowCount } from "./home-inventory.js";
import { MIN_BIG_COLUMNS } from "./infinite-wordmark.js";
import { inkTranscriptRowCount } from "./transcript-app.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { R4_SOURCES_OK } from "./__fixtures__/r4-chrome.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
// A fixed tier, so the frame reads the same whatever terminal runs the tests.
const THEME = resolveTheme({ INFINITE_COLOR: "truecolor" }, { isTTY: true });

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

function render(props: Record<string, unknown>, columns = COLUMNS): string {
  return renderInkInteractiveSessionToString(
    { columns, onSubmitLine: async () => ({}), theme: THEME, ...props } as never,
    { columns }
  );
}

/** Rows above the composer the session predicts: the inventory, the live frame and the rule over the composer. */
function predictedComposerRow(columns: number, inventory: Parameters<typeof homeInventoryRowCount>[1] | null): number {
  return (inventory ? homeInventoryRowCount(columns, inventory) : 0)
    + inkTranscriptRowCount({
      bootFrame: true,
      busy: false,
      columns,
      showComposer: false,
      theme: THEME,
      transcript: { messages: [], state: undefined as never },
      nowMs: 5_000
    })
    + 1;
}

describe("the boot frame (D4: terminal-r4's frame, nothing else)", () => {
  it("is the top bar, its rule, an empty answer area, the Steps rule, the composer's rule, the composer and the key bar (boot--c100)", () => {
    const rows = stripAnsi(render({ topBar: { workspace: "Infinite workspace", sources: R4_SOURCES_OK, throughApp: true } }, 100))
      .replace(/\n+$/u, "")
      .split("\n")
      .map((row) => row.trimEnd());

    expect(rows).toEqual([
      " ∞ Infinite   Infinite workspace   ⊘ Shopify ● GA4 ● Stripe ● PostHog ● Google Ads ● Meta",
      "─".repeat(100),
      ...Array.from({ length: 8 }, () => ""),
      `─ Steps ${"─".repeat(92)}`,
      "─".repeat(100),
      "❯ Ask Infinite…",
      // r4's boot key bar, as drawn: `tab switch side`, then `/ commands`.
      " tab  switch side    /  commands"
    ]);
  });

  it("says `through the Infinite app` on the right when the whole top bar fits (boot--c160)", () => {
    const [top] = stripAnsi(render({ topBar: { workspace: "Infinite workspace", sources: R4_SOURCES_OK, throughApp: true } }, 160)).split("\n");
    expect(top?.trimEnd()).toBe(
      ` ∞ Infinite   Infinite workspace   ⊘ Shopify ● GA4 ● Stripe ● PostHog ● Google Ads ● Meta${" ".repeat(46)}through the Infinite app`
    );
  });

  it("shows no wordmark, no inventory and no welcome text after the first run", () => {
    const frame = stripAnsi(render({}));

    expect(frame).not.toContain("███████╗");
    expect(frame).not.toContain("Tools");
    expect(frame).not.toContain("Welcome to Infinite");
    expect(frame).not.toContain("Use Infinite wherever you prefer");
    expect(frame).not.toContain("ready");
    expect(frame).toContain("∞ Infinite");
  });

  it("parks the composer on the predicted row (PR #27 invariant)", () => {
    const lines = stripAnsi(render({})).replace(/\n+$/u, "").split("\n");
    expect(lines.findIndex((line) => line.startsWith("❯"))).toBe(predictedComposerRow(COLUMNS, null));
  });
});

describe("the first-run inventory (D4: the first-ever run only)", () => {
  it("renders the wordmark, Tools/Commands/Connected and welcome above the boot frame", () => {
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
    // …and the inventory sits ABOVE the top bar.
    const lines = frame.split("\n");
    const toolsRow = lines.findIndex((line) => line.includes("Tools"));
    const topBarRow = lines.findIndex((line) => line.startsWith(" ∞ Infinite"));
    expect(toolsRow).toBeGreaterThanOrEqual(0);
    expect(topBarRow).toBeGreaterThan(toolsRow);
  });

  it("keeps the composer-row prediction exact with the inventory present (PR #27 invariant)", () => {
    const lines = stripAnsi(render({ homeInventory: HOME_INVENTORY })).replace(/\n+$/u, "").split("\n");
    expect(lines.findIndex((line) => line.startsWith("❯"))).toBe(predictedComposerRow(COLUMNS, HOME_INVENTORY));
  });

  it.each([MIN_BIG_COLUMNS - 1, MIN_BIG_COLUMNS])(
    "keeps cursor prediction exact at the responsive wordmark boundary (%i columns)",
    (columns) => {
      const lines = stripAnsi(render({ homeInventory: HOME_INVENTORY }, columns))
        .replace(/\n+$/u, "")
        .split("\n");

      expect(lines.findIndex((line) => line.startsWith("❯"))).toBe(predictedComposerRow(columns, HOME_INVENTORY));
    }
  );

  it("keeps the prediction exact when the Connected row is left out", () => {
    const inventory = { ...HOME_INVENTORY, connections: undefined };
    const lines = stripAnsi(render({ homeInventory: inventory })).replace(/\n+$/u, "").split("\n");
    expect(lines.findIndex((line) => line.startsWith("❯"))).toBe(predictedComposerRow(COLUMNS, inventory));
  });

  it("does NOT render the inventory once the transcript has messages (shown once, not per message)", () => {
    const messages: Msg[] = [{ role: "user", text: "hello" }];
    const frame = stripAnsi(render({ homeInventory: HOME_INVENTORY, initialMessages: messages }));

    expect(frame).not.toContain("Tools");
    expect(frame).not.toContain("Welcome to Infinite");
    // The user's message renders instead.
    expect(frame).toContain("hello");
  });

  it("says why the sources could not be read, and never claims a healthy app's daemon is down", () => {
    const local = stripAnsi(render({
      homeInventory: { ...HOME_INVENTORY, connections: undefined, connectionsNote: "daemon not reachable" }
    }));
    expect(local).toContain("Connected");
    expect(local).toContain("daemon not reachable");
    expect(local).not.toContain("✓");

    // Through the app (the cloud session): the sources live in the app, so no Connected row at all.
    const app = stripAnsi(render({ homeInventory: { ...HOME_INVENTORY, connections: undefined } }));
    expect(app).toContain("Tools");
    expect(app).not.toContain("Connected");
    expect(app).not.toContain("daemon not reachable");
  });
});
