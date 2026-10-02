import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  desktopSessionOpening,
  helpInventory,
  homeInventoryCommands,
  homeInventoryData,
  homeInventoryProviderLabel,
  isFirstEverRun,
  localSourcesNote,
  productHelpText,
  readLocalSources,
  recordInfiniteWelcomeSeen,
  topBarSources,
  type CliEnv
} from "./index.js";

describe("homeInventoryData", () => {
  it("builds the shared startup inventory with the active desktop workspace", () => {
    const connections = [{ label: "GA4" }] as const;

    const inventory = homeInventoryData("Acme", connections);

    expect(inventory.workspace).toBe("Acme");
    expect(inventory.connections).toEqual(connections);
    expect(inventory.tools.map((tool) => tool.label)).toEqual([
      "connect",
      "sync",
      "generate ads",
      "insights",
      "outreach",
      "query"
    ]);
    expect(inventory.commands).toEqual(homeInventoryCommands());
    expect(inventory.version).toEqual(expect.any(String));
  });

  it("neutralizes terminal controls in workspace and connection labels", () => {
    const inventory = homeInventoryData(
      "Acme\nFORGED\u001b]0;spoof-title\u0007",
      [{ label: "G\u001b[31mA4\u001b[0m\rFORGED" }]
    );

    expect(inventory.workspace).toBe("Acme FORGED");
    expect(inventory.connections).toEqual([{ label: "GA4 FORGED" }]);
  });
});

describe("homeInventoryProviderLabel", () => {
  it("maps known connector providers to short friendly labels", () => {
    expect(homeInventoryProviderLabel("google_analytics_4")).toBe("GA4");
    expect(homeInventoryProviderLabel("meta_ads")).toBe("Facebook");
    expect(homeInventoryProviderLabel("x")).toBe("X");
    expect(homeInventoryProviderLabel("posthog")).toBe("PostHog");
    expect(homeInventoryProviderLabel("shopify")).toBe("Shopify");
    expect(homeInventoryProviderLabel("stripe")).toBe("Stripe");
  });

  it("title-cases an unknown provider id rather than dumping the raw snake_case id", () => {
    expect(homeInventoryProviderLabel("some_new_source")).toBe("Some New Source");
  });

  it("neutralizes terminal controls in unknown provider ids", () => {
    expect(homeInventoryProviderLabel("some\u001b]0;spoof-title\u0007_provider\nFORGED"))
      .toBe("Some Provider FORGED");
  });
});

describe("homeInventoryCommands", () => {
  it("returns the curated subset, every entry a real registry command", () => {
    const commands = homeInventoryCommands();
    expect(commands.length).toBeGreaterThan(0);
    // The most useful front doors are present and curated (not the whole registry).
    const values = commands.map((command) => command.value);
    expect(values).toContain("/connect");
    expect(values).toContain("/sync");
    expect(values).toContain("/help");
    expect(values).toContain("/exit");
    // Curated subset stays short — it must fit on one line on a normal terminal.
    expect(commands.length).toBeLessThanOrEqual(8);
    // Every curated command is a leading-slash command.
    for (const value of values) {
      expect(value.startsWith("/")).toBe(true);
    }
  });
});

describe("the local engine's sources (top bar dots, first-run Connected row)", () => {
  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (url: string) => Promise<void>
  ): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function env(url: string): CliEnv {
    const home = mkdtempSync(join(tmpdir(), "infinite-sources-"));
    return {
      HOME: home,
      GROWTH_OS_HOME: home,
      GROWTH_OS_API_URL: url,
      GROWTH_OS_READ_TOKEN: "test-read-token",
      GROWTH_OS_WORKSPACE_ID: "ws_test",
      GROWTH_OS_READINESS_PROBE_TIMEOUT_MS: "1000"
    } as CliEnv;
  }

  it("reads the connected sources, de-duplicated by provider", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { sources: [
        { provider: "google_analytics_4", status: "connected" },
        { provider: "stripe", status: "degraded" },
        { provider: "x", status: "disconnected" }
      ] } }));
    }, async (url) => {
      const read = await readLocalSources(env(url));
      expect(read).toEqual({ kind: "read", connections: [{ label: "GA4", degraded: false }, { label: "Stripe", degraded: true }] });
      expect(localSourcesNote(read)).toBeUndefined();
    });
  });

  it("a daemon that answers but refuses the read (no token for it, no workspace) is NOT 'daemon not reachable' (eval run 1)", async () => {
    await withServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "unauthorized" } }));
    }, async (url) => {
      const read = await readLocalSources(env(url));
      expect(read).toEqual({ kind: "unreadable" });
      expect(localSourcesNote(read)).toBe("could not read sources");
    });
  });

  it("says 'daemon not reachable' only when no daemon answered", async () => {
    let closedUrl = "";
    await withServer(() => undefined, async (url) => {
      closedUrl = url;
    });
    const read = await readLocalSources(env(closedUrl));
    expect(read).toEqual({ kind: "unreachable" });
    expect(localSourcesNote(read)).toBe("daemon not reachable");
  });

  it("turns read sources into top bar dots, and draws none when they were not read", () => {
    expect(topBarSources([{ label: "GA4" }, { label: "Stripe", degraded: true }])).toEqual([
      { label: "GA4", state: "connected" },
      { label: "Stripe", state: "broken" }
    ]);
    expect(topBarSources(undefined)).toBeUndefined();
  });

  it("carries the reason into the first-run inventory only when the sources were not read", () => {
    expect(homeInventoryData("Acme", undefined, "daemon not reachable").connectionsNote).toBe("daemon not reachable");
    expect(homeInventoryData("Acme", [], "daemon not reachable").connectionsNote).toBeUndefined();
    expect(homeInventoryData("Acme", undefined).connectionsNote).toBeUndefined();
  });
});

describe("infinite --help carries the first-run wordmark, inventory and the App/Terminal block (D4)", () => {
  it("prints the wordmark, the tools and commands, and 'Use Infinite wherever you prefer'", () => {
    const help = productHelpText(helpInventory());
    expect(help).toContain("███████╗");
    expect(help).toContain("the growth engineer's OS");
    expect(help).toMatch(/^Tools {6}connect {2}· {2}sync/mu);
    expect(help).toMatch(/^Commands {3}\/connect/mu);
    expect(help).toContain("Use Infinite wherever you prefer:");
    expect(help).toContain("  APP       Press ⌘L");
    expect(help).toContain("  TERMINAL  You’re already here");
    expect(help).toContain("Same account. Same workspace. Same agent.");
    expect(help).not.toMatch(/trial|infinite local|docker|self-host|local engine/i);
  });
});

describe("the first-ever run (D4: the wordmark, inventory and App/Terminal block show once)", () => {
  it("is the first run until the welcome has been shown once; INFINITE_FORCE_WELCOME replays it", () => {
    const home = mkdtempSync(join(tmpdir(), "infinite-first-run-"));
    const env = { HOME: home, GROWTH_OS_HOME: home } as CliEnv;
    expect(isFirstEverRun(env)).toBe(true);
    recordInfiniteWelcomeSeen(env);
    expect(isFirstEverRun(env)).toBe(false);
    expect(isFirstEverRun({ ...env, INFINITE_FORCE_WELCOME: "1" } as CliEnv)).toBe(true);
  });
});

describe("the Desktop session's opening (D4)", () => {
  it("prints the full hand-off once, records the marker and asks for the inventory; later runs open on the frame", () => {
    const home = mkdtempSync(join(tmpdir(), "infinite-desktop-opening-"));
    const env = { HOME: home, GROWTH_OS_HOME: home } as CliEnv;
    const first = desktopSessionOpening(env, { afterOnboarding: false });
    expect(first.firstRun).toBe(true);
    expect(first.text.startsWith("✓ Infinite Desktop is ready\n\n")).toBe(true);
    expect(first.text).toContain("Use Infinite wherever you prefer:");
    expect(existsSync(join(home, "welcome-seen"))).toBe(true);
    expect(desktopSessionOpening(env, { afterOnboarding: false })).toEqual({ firstRun: false, text: "" });
  });

  it("always confirms Desktop is ready right after onboarding, even when the welcome was already seen", () => {
    const home = mkdtempSync(join(tmpdir(), "infinite-desktop-opening-"));
    const env = { HOME: home, GROWTH_OS_HOME: home } as CliEnv;
    recordInfiniteWelcomeSeen(env);
    expect(desktopSessionOpening(env, { afterOnboarding: true })).toEqual({
      firstRun: false,
      text: "✓ Infinite Desktop is ready\n\n"
    });
  });
});
