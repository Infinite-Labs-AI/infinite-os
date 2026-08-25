import { describe, expect, it } from "vitest";
import {
  RESERVED_LOCAL_COMMANDS,
  reservedCommandNotice
} from "./reserved-commands.js";

describe("reservedCommandNotice", () => {
  it("intercepts a moved command with local guidance", () => {
    expect(reservedCommandNotice("sources")).toBe("Use: infinite local sources");
  });
  it("returns null for a non-reserved word (so it can become a turn)", () => {
    expect(reservedCommandNotice("summarise")).toBeNull();
  });
  it("carries the remaining arguments into the guidance", () => {
    expect(reservedCommandNotice("setup", ["resume", "r123"])).toBe(
      "Use: infinite local setup resume r123"
    );
    expect(reservedCommandNotice("sync", ["meta", "30_days"])).toBe(
      "Use: infinite local sync meta 30_days"
    );
  });
  it("covers every top-level engine command surfaced by runCommand today", () => {
    const engineCommands = [
      "init",
      "setup",
      "start",
      "up",
      "stop",
      "migrate",
      "logs",
      "status",
      "connect",
      "health",
      "sources",
      "schema",
      "schedules",
      "sync",
      "sync-runs",
      "views",
      "metrics",
      "mcp",
      "tools",
      "recipes",
      "recipe",
      "auth",
      "codex",
      "model",
      "project",
      "meta",
      "explain",
      "saved-report",
      "call"
    ];
    for (const cmd of engineCommands) {
      expect(reservedCommandNotice(cmd), cmd).toBe(`Use: infinite local ${cmd}`);
    }
  });
  it("leaves the product-level commands alone (help/version/app/update/local)", () => {
    // §6.6 routing: help/version are always product-allowed; `app` is the
    // Desktop command; product `update` means DESKTOP updating (handled before
    // reserved interception); `local` is the explicit namespace itself.
    for (const cmd of ["help", "version", "app", "update", "local"]) {
      expect(reservedCommandNotice(cmd), cmd).toBeNull();
    }
  });
  it("exposes the set itself for the entry router", () => {
    expect(RESERVED_LOCAL_COMMANDS.has("sync")).toBe(true);
    expect(RESERVED_LOCAL_COMMANDS.has("update")).toBe(false);
  });
});
