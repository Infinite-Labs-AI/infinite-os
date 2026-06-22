import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertLoopbackAppHost } from "../src/index.js";

// P0-G — Daemon loopback-bind startup invariant. The install-wide operator token is
// only safe because the daemon is reachable from localhost only. `isLocalHost` is a
// per-route guard, NOT on the bind, so if `config.appHost` is `0.0.0.0`/`::` the
// operator token becomes LAN-reachable. `assertLoopbackAppHost` is the pure helper
// called BEFORE `app.listen` to FAIL CLOSED on a non-loopback bind host.
describe("assertLoopbackAppHost (P0-G loopback-bind invariant)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("throws daemon_must_bind_loopback for a non-loopback bind host", () => {
    expect(() => assertLoopbackAppHost("0.0.0.0", {})).toThrow(
      /daemon_must_bind_loopback/
    );
  });

  it("throws for the IPv6 any-address (::)", () => {
    expect(() => assertLoopbackAppHost("::", {})).toThrow(
      /daemon_must_bind_loopback/
    );
  });

  it("throws for a routable LAN address", () => {
    expect(() => assertLoopbackAppHost("192.168.1.50", {})).toThrow(
      /daemon_must_bind_loopback/
    );
  });

  it("passes for 127.0.0.1", () => {
    expect(() => assertLoopbackAppHost("127.0.0.1", {})).not.toThrow();
  });

  it("passes for localhost", () => {
    expect(() => assertLoopbackAppHost("localhost", {})).not.toThrow();
  });

  it("passes for ::1", () => {
    expect(() => assertLoopbackAppHost("::1", {})).not.toThrow();
  });

  it("bypasses the assertion when GROWTH_OS_ALLOW_NON_LOOPBACK_BIND=1 (loud opt-out)", () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      expect(() =>
        assertLoopbackAppHost("0.0.0.0", {
          GROWTH_OS_ALLOW_NON_LOOPBACK_BIND: "1"
        })
      ).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    // The opt-out must be LOUD: a warning is emitted so the operator knows the
    // install-wide token is now LAN-reachable.
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).toMatch(/GROWTH_OS_ALLOW_NON_LOOPBACK_BIND/);
  });

  it("does NOT bypass when the opt-out env is unset or not '1'", () => {
    expect(() =>
      assertLoopbackAppHost("0.0.0.0", { GROWTH_OS_ALLOW_NON_LOOPBACK_BIND: "0" })
    ).toThrow(/daemon_must_bind_loopback/);
    expect(() =>
      assertLoopbackAppHost("0.0.0.0", { GROWTH_OS_ALLOW_NON_LOOPBACK_BIND: "" })
    ).toThrow(/daemon_must_bind_loopback/);
  });
});
