import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  databaseFingerprint,
  invalidateResolvedDaemonEndpoint,
  probeDaemonIdentity,
  resolveDaemonEndpoint,
  type DaemonDescriptor
} from "../src/daemon-endpoint.js";

// A tiny fetch double: maps `${base}/health` -> a Response (or throws to simulate a
// network error). Anything not in the map gets a connection-refused-style throw.
function makeFetch(
  routes: Record<string, { status?: number; body?: unknown } | "refused" | "timeout">
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url];
    if (!route || route === "refused") {
      const err = new Error("connect ECONNREFUSED") as Error & { code?: string };
      err.code = "ECONNREFUSED";
      throw err;
    }
    if (route === "timeout") {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "TimeoutError";
      throw err;
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

const DAEMON_BODY = {
  status: "ok",
  service: "growth-os-app",
  runtime: "app-api-mcp",
  pid: 4242,
  version: "0.1.0",
  nonce: "boot-nonce-abc"
};

describe("databaseFingerprint", () => {
  it("strips the password — two URLs differing ONLY in password hash equal", () => {
    const a = "postgres://growth_os:hunter2@127.0.0.1:5432/growth_os";
    const b = "postgres://growth_os:correct-horse@127.0.0.1:5432/growth_os";
    expect(databaseFingerprint(a)).toBe(databaseFingerprint(b));
  });

  it("never contains the password as a substring", () => {
    const fp = databaseFingerprint("postgres://u:SUPERSECRETPW@127.0.0.1:5432/db");
    expect(fp).not.toContain("SUPERSECRETPW");
    expect(fp).toHaveLength(24);
  });

  it("normalizes localhost <-> 127.0.0.1 and applies the default 5432 port", () => {
    const explicit = "postgres://u:p@127.0.0.1:5432/db";
    const aliasHost = "postgres://u:p@localhost:5432/db";
    const defaultPort = "postgres://u:p@127.0.0.1/db";
    expect(databaseFingerprint(aliasHost)).toBe(databaseFingerprint(explicit));
    expect(databaseFingerprint(defaultPort)).toBe(databaseFingerprint(explicit));
  });

  it("distinguishes different databases (user / host / port / dbname)", () => {
    const base = "postgres://u:p@127.0.0.1:5432/db";
    expect(databaseFingerprint("postgres://other:p@127.0.0.1:5432/db")).not.toBe(databaseFingerprint(base));
    expect(databaseFingerprint("postgres://u:p@10.0.0.1:5432/db")).not.toBe(databaseFingerprint(base));
    expect(databaseFingerprint("postgres://u:p@127.0.0.1:6543/db")).not.toBe(databaseFingerprint(base));
    expect(databaseFingerprint("postgres://u:p@127.0.0.1:5432/other")).not.toBe(databaseFingerprint(base));
  });

  it("hashes a pglite data-dir path (no password component to strip)", () => {
    const fp = databaseFingerprint("pglite:///Users/me/.growth-os/pglite");
    expect(fp).toHaveLength(24);
    // Equivalent path spellings converge.
    expect(databaseFingerprint("/Users/me/.growth-os/pglite")).toBe(fp);
  });
});

describe("probeDaemonIdentity", () => {
  it("accepts a body whose service is growth-os-app", async () => {
    const fetchImpl = makeFetch({ "http://127.0.0.1:9/health": { body: DAEMON_BODY } });
    const id = await probeDaemonIdentity("http://127.0.0.1:9", { fetchImpl });
    expect(id?.service).toBe("growth-os-app");
    expect(id?.pid).toBe(4242);
  });

  it("rejects a foreign server (service !== growth-os-app)", async () => {
    const fetchImpl = makeFetch({
      "http://127.0.0.1:9/health": { body: { service: "next-dev", status: "ok" } }
    });
    expect(await probeDaemonIdentity("http://127.0.0.1:9", { fetchImpl })).toBeNull();
  });

  it("returns null on a network error / non-2xx (never throws)", async () => {
    const refused = makeFetch({ "http://127.0.0.1:9/health": "refused" });
    expect(await probeDaemonIdentity("http://127.0.0.1:9", { fetchImpl: refused })).toBeNull();
    const notFound = makeFetch({ "http://127.0.0.1:9/health": { status: 404, body: DAEMON_BODY } });
    expect(await probeDaemonIdentity("http://127.0.0.1:9", { fetchImpl: notFound })).toBeNull();
  });
});

describe("resolveDaemonEndpoint", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "growth-os-resolve-"));
    invalidateResolvedDaemonEndpoint();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    invalidateResolvedDaemonEndpoint();
    vi.restoreAllMocks();
  });

  function writeDescriptor(descriptor: DaemonDescriptor): void {
    writeFileSync(join(home, "daemon.json"), JSON.stringify(descriptor), { mode: 0o600 });
  }

  it("honors GROWTH_OS_API_URL override when it identity-probes as the daemon", async () => {
    const env = { GROWTH_OS_HOME: home, GROWTH_OS_API_URL: "http://127.0.0.1:7777" } as NodeJS.ProcessEnv;
    const fetchImpl = makeFetch({ "http://127.0.0.1:7777/health": { body: DAEMON_BODY } });
    const resolved = await resolveDaemonEndpoint(env, { fetchImpl });
    expect(resolved).toEqual({ url: "http://127.0.0.1:7777" });
  });

  it("accepts a valid descriptor: alive pid + matching pid + matching nonce", async () => {
    writeDescriptor({
      url: "http://127.0.0.1:63577",
      pid: 4242,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      nonce: "boot-nonce-abc"
    });
    vi.spyOn(process, "kill").mockReturnValue(true);
    const env = { GROWTH_OS_HOME: home } as NodeJS.ProcessEnv;
    const fetchImpl = makeFetch({ "http://127.0.0.1:63577/health": { body: DAEMON_BODY } });
    const resolved = await resolveDaemonEndpoint(env, { fetchImpl });
    expect(resolved).toEqual({ url: "http://127.0.0.1:63577" });
  });

  it("skips a descriptor whose pid is dead (ESRCH), then falls through to configBaseUrl", async () => {
    writeDescriptor({
      url: "http://127.0.0.1:63577",
      pid: 999999,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      nonce: "boot-nonce-abc"
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH") as Error & { code: string };
      err.code = "ESRCH";
      throw err;
    });
    const env = { GROWTH_OS_HOME: home } as NodeJS.ProcessEnv;
    // The dead descriptor must NOT be probed; configBaseUrl (default 127.0.0.1:3000)
    // answers as the daemon.
    const fetchImpl = makeFetch({
      "http://127.0.0.1:63577/health": { body: DAEMON_BODY },
      "http://127.0.0.1:3000/health": { body: DAEMON_BODY }
    });
    const resolved = await resolveDaemonEndpoint(env, { fetchImpl });
    expect(resolved).toEqual({ url: "http://127.0.0.1:3000" });
  });

  it("skips a descriptor on a pid/nonce mismatch (recycled pid / stale descriptor)", async () => {
    writeDescriptor({
      url: "http://127.0.0.1:63577",
      pid: 4242,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      nonce: "STALE-nonce"
    });
    vi.spyOn(process, "kill").mockReturnValue(true);
    const env = { GROWTH_OS_HOME: home } as NodeJS.ProcessEnv;
    // /health returns a DIFFERENT nonce -> the descriptor is stale -> reject, and
    // there is no configBaseUrl daemon -> null.
    const fetchImpl = makeFetch({
      "http://127.0.0.1:63577/health": { body: { ...DAEMON_BODY, nonce: "live-nonce" } },
      "http://127.0.0.1:3000/health": "refused"
    });
    const resolved = await resolveDaemonEndpoint(env, { fetchImpl });
    expect(resolved).toBeNull();
  });

  it("rejects a foreign server on configBaseUrl (service !== growth-os-app) -> null", async () => {
    const env = { GROWTH_OS_HOME: home } as NodeJS.ProcessEnv;
    const fetchImpl = makeFetch({
      "http://127.0.0.1:3000/health": { body: { service: "next-dev", status: "ok" } }
    });
    const resolved = await resolveDaemonEndpoint(env, { fetchImpl });
    expect(resolved).toBeNull();
  });
});
