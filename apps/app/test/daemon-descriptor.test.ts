import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDaemonDescriptor,
  daemonDescriptorPath,
  daemonUrlFromAddress,
  readDaemonDescriptor,
  removeDaemonDescriptor,
  validateAdvertisedUrl,
  writeDaemonDescriptor
} from "../src/daemon-descriptor.js";

describe("daemon descriptor", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "growth-os-daemon-"));
    env = { GROWTH_OS_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves the descriptor path under the machine home", () => {
    expect(daemonDescriptorPath(env)).toBe(join(home, "daemon.json"));
  });

  describe("daemonUrlFromAddress", () => {
    it("rewrites a wildcard IPv4 bind to loopback", () => {
      expect(daemonUrlFromAddress({ address: "0.0.0.0", port: 3000, family: "IPv4" })).toBe(
        "http://127.0.0.1:3000"
      );
    });

    it("rewrites a wildcard IPv6 bind to bracketed loopback", () => {
      expect(daemonUrlFromAddress({ address: "::", port: 8080, family: "IPv6" })).toBe(
        "http://[::1]:8080"
      );
    });

    it("preserves a concrete IPv4 loopback host", () => {
      expect(daemonUrlFromAddress({ address: "127.0.0.1", port: 4321, family: "IPv4" })).toBe(
        "http://127.0.0.1:4321"
      );
    });

    it("brackets a concrete IPv6 literal", () => {
      expect(daemonUrlFromAddress({ address: "::1", port: 5555, family: "IPv6" })).toBe(
        "http://[::1]:5555"
      );
    });

    it("uses the bound (ephemeral) port, not the requested one", () => {
      // port 0 -> OS assigns 54123; the descriptor must carry the assigned port.
      expect(daemonUrlFromAddress({ address: "127.0.0.1", port: 54123 })).toBe(
        "http://127.0.0.1:54123"
      );
    });

    it("throws on a non-listening port (0 / negative / NaN) rather than advertising :0", () => {
      // address() read before listen resolved would carry port 0 — fail loud, do not
      // publish an unconnectable URL.
      expect(() => daemonUrlFromAddress({ address: "127.0.0.1", port: 0 })).toThrow(/non-listening port/);
      expect(() => daemonUrlFromAddress({ address: "127.0.0.1", port: -1 })).toThrow(/non-listening port/);
      expect(() => daemonUrlFromAddress({ address: "127.0.0.1", port: NaN })).toThrow(/non-listening port/);
    });
  });

  describe("buildDaemonDescriptor", () => {
    it("builds the full shape with url/pid/version/startedAt", () => {
      const descriptor = buildDaemonDescriptor({
        address: { address: "0.0.0.0", port: 3000, family: "IPv4" },
        pid: 4242,
        version: "1.2.3",
        startedAt: "2026-06-19T00:00:00.000Z"
      });
      expect(descriptor).toEqual({
        url: "http://127.0.0.1:3000",
        pid: 4242,
        version: "1.2.3",
        startedAt: "2026-06-19T00:00:00.000Z"
      });
    });

    it("defaults pid to process.pid and startedAt to an iso timestamp", () => {
      const before = Date.now();
      const descriptor = buildDaemonDescriptor({
        address: { address: "127.0.0.1", port: 3000 }
      });
      expect(descriptor.pid).toBe(process.pid);
      expect(typeof descriptor.version).toBe("string");
      expect(Number.isNaN(Date.parse(descriptor.startedAt))).toBe(false);
      expect(Date.parse(descriptor.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    });

    it("throws on a non-TCP (string / null) address instead of masking it", () => {
      expect(() => buildDaemonDescriptor({ address: null })).toThrow(/bound TCP address/);
      expect(() => buildDaemonDescriptor({ address: "/tmp/sock" })).toThrow(/bound TCP address/);
    });

    describe("GROWTH_OS_ADVERTISED_URL override", () => {
      it("uses the advertised URL from env instead of the bound address", () => {
        const descriptor = buildDaemonDescriptor(
          {
            address: { address: "0.0.0.0", port: 3000, family: "IPv4" },
            pid: 1,
            version: "1.0.0",
            startedAt: "2026-06-19T00:00:00.000Z"
          },
          { GROWTH_OS_ADVERTISED_URL: "http://127.0.0.1:3000" }
        );
        expect(descriptor.url).toBe("http://127.0.0.1:3000");
      });

      it("uses the advertisedUrl input option when env var is not set", () => {
        const descriptor = buildDaemonDescriptor(
          {
            address: { address: "0.0.0.0", port: 9999, family: "IPv4" },
            advertisedUrl: "http://localhost:3000",
            pid: 1,
            version: "1.0.0",
            startedAt: "2026-06-19T00:00:00.000Z"
          },
          {}
        );
        expect(descriptor.url).toBe("http://localhost:3000");
      });

      it("env var takes precedence over input.advertisedUrl", () => {
        const descriptor = buildDaemonDescriptor(
          {
            address: { address: "0.0.0.0", port: 9999, family: "IPv4" },
            advertisedUrl: "http://localhost:9999",
            pid: 1,
            version: "1.0.0",
            startedAt: "2026-06-19T00:00:00.000Z"
          },
          { GROWTH_OS_ADVERTISED_URL: "http://127.0.0.1:3000" }
        );
        expect(descriptor.url).toBe("http://127.0.0.1:3000");
      });

      it("falls back to bound address when no advertised url is provided", () => {
        const descriptor = buildDaemonDescriptor(
          {
            address: { address: "0.0.0.0", port: 3000, family: "IPv4" },
            pid: 1,
            version: "1.0.0",
            startedAt: "2026-06-19T00:00:00.000Z"
          },
          {}
        );
        expect(descriptor.url).toBe("http://127.0.0.1:3000");
      });
    });
  });

  describe("validateAdvertisedUrl", () => {
    it("accepts loopback http URLs", () => {
      expect(() => validateAdvertisedUrl("http://127.0.0.1:3000")).not.toThrow();
      expect(() => validateAdvertisedUrl("http://localhost:3000")).not.toThrow();
      expect(() => validateAdvertisedUrl("http://[::1]:3000")).not.toThrow();
    });

    it("accepts https loopback URLs", () => {
      expect(() => validateAdvertisedUrl("https://127.0.0.1:3000")).not.toThrow();
    });

    it("rejects a non-loopback host", () => {
      expect(() => validateAdvertisedUrl("http://192.168.1.1:3000")).toThrow(/loopback/);
      expect(() => validateAdvertisedUrl("http://0.0.0.0:3000")).toThrow(/loopback/);
      expect(() => validateAdvertisedUrl("http://example.com:3000")).toThrow(/loopback/);
    });

    it("rejects non-http protocols", () => {
      expect(() => validateAdvertisedUrl("ftp://127.0.0.1:3000")).toThrow(/http/);
      expect(() => validateAdvertisedUrl("ws://127.0.0.1:3000")).toThrow(/http/);
    });

    it("rejects a malformed URL", () => {
      expect(() => validateAdvertisedUrl("not-a-url")).toThrow(/valid URL/);
    });

    it("throws loud on non-loopback so a docker host.docker.internal value never silently slips through", () => {
      expect(() => validateAdvertisedUrl("http://host.docker.internal:3000")).toThrow(/loopback/);
    });
  });

  describe("write/read/remove round-trip", () => {
    it("writes the descriptor 0600 and reads it back", () => {
      const descriptor = buildDaemonDescriptor({
        address: { address: "0.0.0.0", port: 3000, family: "IPv4" },
        pid: 99,
        version: "9.9.9",
        startedAt: "2026-06-19T01:02:03.000Z"
      });
      const { path } = writeDaemonDescriptor(descriptor, env);
      expect(path).toBe(join(home, "daemon.json"));
      expect(existsSync(path)).toBe(true);

      // 0600 perms (owner read/write only). Mask off the file-type bits.
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);

      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk).toEqual(descriptor);
      expect(onDisk).not.toHaveProperty("token");

      expect(readDaemonDescriptor(env)).toEqual(descriptor);
    });

    it("publishes atomically — leaves no .tmp sibling and overwrites cleanly", () => {
      const first = buildDaemonDescriptor({ address: { address: "127.0.0.1", port: 3000 }, version: "1.0.0" });
      writeDaemonDescriptor(first, env);
      // The temp file used for the atomic rename must not survive the write.
      expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);

      // A second write (daemon restart on a new port) replaces the file wholesale —
      // a reader sees the old or the new descriptor, never a mix — and still no temp.
      const second = buildDaemonDescriptor({ address: { address: "127.0.0.1", port: 4000 }, version: "2.0.0" });
      writeDaemonDescriptor(second, env);
      expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(readDaemonDescriptor(env)).toEqual(second);
      expect(statSync(join(home, "daemon.json")).mode & 0o777).toBe(0o600);
    });

    it("removes the descriptor so a stale file never points at a dead port", () => {
      const descriptor = buildDaemonDescriptor({ address: { address: "127.0.0.1", port: 3000 } });
      const { path } = writeDaemonDescriptor(descriptor, env);
      expect(existsSync(path)).toBe(true);

      removeDaemonDescriptor(env);
      expect(existsSync(path)).toBe(false);
      expect(readDaemonDescriptor(env)).toBeNull();
    });

    it("remove is a no-op when no descriptor exists", () => {
      expect(() => removeDaemonDescriptor(env)).not.toThrow();
    });
  });
});
