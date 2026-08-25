import { describe, expect, it } from "vitest";

import { assertSafePublicUrl, isBlockedIp } from "./ssrf.js";

describe("isBlockedIp", () => {
  it("blocks IPv4 private/reserved/loopback/link-local ranges", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
      "192.0.0.170", "192.0.2.5", "198.18.0.1", "198.51.100.9", "203.0.113.9",
      "240.0.0.1", "255.255.255.255"
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("blocks IPv6 loopback/link-local/unique-local, IPv4-mapped, NAT64, doc, and expanded-unspecified", () => {
    for (const ip of [
      "::1", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "64:ff9b::127.0.0.1", "2001:db8::1", "0:0:0:0:0:0:0:0"
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("allows ordinary public IPs (incl. a public IPv4-mapped address)", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "198.20.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:93.184.216.34"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
});

describe("assertSafePublicUrl", () => {
  const allowResolver = async () => ({ address: "93.184.216.34", family: 4 });
  const blockResolver = async () => ({ address: "127.0.0.1", family: 4 });

  it("rejects non-https URLs", async () => {
    await expect(assertSafePublicUrl("http://example.com", allowResolver)).rejects.toThrow(/https/i);
  });

  it("rejects URLs resolving to a blocked IP", async () => {
    await expect(assertSafePublicUrl("https://internal.local", blockResolver)).rejects.toThrow(/blocked|private/i);
  });

  it("returns the pinned IP for a safe public https URL", async () => {
    await expect(assertSafePublicUrl("https://example.com", allowResolver)).resolves.toEqual({
      url: "https://example.com",
      ip: "93.184.216.34"
    });
  });
});
