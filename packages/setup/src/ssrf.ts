import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** True if the IP is in a private, reserved, loopback, link-local, CGNAT, or unique-local range. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return true; // this-net, loopback, private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0 && o[2] === 0) return true; // IANA special 192.0.0.0/24
    if (a === 192 && b === 0 && o[2] === 2) return true; // TEST-NET-1 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
    if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2 198.51.100.0/24
    if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3 203.0.113.0/24
    if (a >= 240) return true; // reserved/future 240.0.0.0/4 + 255.255.255.255 broadcast
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::" || lower === "0:0:0:0:0:0:0:0") return true; // loopback / unspecified
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedIp(mapped[1]); // IPv4-mapped IPv6 (classic SSRF bypass) — re-check embedded v4
    const nat64 = lower.match(/^64:ff9b::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (nat64) return isBlockedIp(nat64[1]); // NAT64 well-known prefix — re-check embedded v4 (e.g. 64:ff9b::127.0.0.1)
    if (lower.startsWith("2001:db8")) return true; // documentation 2001:db8::/32
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    return false;
  }
  return true; // not a literal IP -> treat as blocked at this layer (callers resolve DNS first)
}

export type DnsResolver = (hostname: string) => Promise<{ address: string; family: number }>;

const defaultResolver: DnsResolver = (hostname) => lookup(hostname);

/**
 * Validates a user-supplied site URL before any fetch:
 * https-only, DNS-resolved, and the resolved IP must be public.
 * Returns the pinned IP so the caller can connect to that exact address (defeats DNS rebinding).
 */
export async function assertSafePublicUrl(
  rawUrl: string,
  resolver: DnsResolver = defaultResolver
): Promise<{ url: string; ip: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF: not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("SSRF: only https URLs are allowed");
  }
  const { address } = await resolver(parsed.hostname);
  if (isBlockedIp(address)) {
    throw new Error(`SSRF: host resolves to a blocked/private IP (${address})`);
  }
  return { url: rawUrl, ip: address };
}
