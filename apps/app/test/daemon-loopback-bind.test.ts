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

  it("passes for the FULL 127.0.0.0/8 loopback range, not just 127.0.0.1", () => {
    // The whole 127/8 block is loopback (RFC 5735). 127.0.0.2 and 127.255.255.254 bind
    // loopback-only just like 127.0.0.1 — the assertion must accept the entire range.
    expect(() => assertLoopbackAppHost("127.0.0.2", {})).not.toThrow();
    expect(() => assertLoopbackAppHost("127.255.255.254", {})).not.toThrow();
    expect(() => assertLoopbackAppHost("127.1.2.3", {})).not.toThrow();
  });

  it("passes for IPv4-mapped IPv6 loopback (::ffff:127.x.x.x)", () => {
    expect(() => assertLoopbackAppHost("::ffff:127.0.0.1", {})).not.toThrow();
    expect(() => assertLoopbackAppHost("::ffff:127.0.0.2", {})).not.toThrow();
  });

  it("trims surrounding whitespace and is case-insensitive before matching", () => {
    expect(() => assertLoopbackAppHost(" 127.0.0.1 ", {})).not.toThrow();
    expect(() => assertLoopbackAppHost("  ::1 ", {})).not.toThrow();
    expect(() => assertLoopbackAppHost("LocalHost", {})).not.toThrow();
  });

  it("throws for a routable 128.0.0.1 (just outside the 127/8 loopback block)", () => {
    expect(() => assertLoopbackAppHost("128.0.0.1", {})).toThrow(
      /daemon_must_bind_loopback/
    );
  });

  it("throws for a private-range 10.0.0.1", () => {
    expect(() => assertLoopbackAppHost("10.0.0.1", {})).toThrow(
      /daemon_must_bind_loopback/
    );
  });

  it("rejects malformed dotted-quads that merely start with 127", () => {
    // "127" alone, or octets out of the 0-255 range, are NOT valid 127/8 literals.
    expect(() => assertLoopbackAppHost("127.0.0.256", {})).toThrow(
      /daemon_must_bind_loopback/
    );
    expect(() => assertLoopbackAppHost("127.0.0", {})).toThrow(
      /daemon_must_bind_loopback/
    );
    expect(() => assertLoopbackAppHost("1270.0.0.1", {})).toThrow(
      /daemon_must_bind_loopback/
    );
  });

  it("error message names a loopback LITERAL allowlist, not DNS resolution", () => {
    // It is a literal allowlist — NOT a resolver. The wording must not claim it
    // "resolves" anything (no DNS lookup happens).
    expect(() => assertLoopbackAppHost("192.168.1.50", {})).toThrow(
      /is not a recognized loopback literal/
    );
    try {
      assertLoopbackAppHost("192.168.1.50", {});
    } catch (err) {
      expect((err as Error).message).not.toMatch(/resolve to a loopback address/);
    }
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
