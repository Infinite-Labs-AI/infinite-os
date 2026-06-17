import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildConnectPicker,
  connectorSetupDefinition,
  connectProviderPicker,
  reconnectExistingConnector,
  type CliEnv,
  type ExistingConnection
} from "./index.js";

const fakeEnv: CliEnv = { GROWTH_OS_API_URL: "http://127.0.0.1:3000" };

describe("buildConnectPicker", () => {
  it("returns only the new-account option when there are no existing connections", () => {
    const plan = buildConnectPicker([]);
    expect(plan.options).toEqual(["➕ Connect a new account"]);
    expect(plan.actions).toEqual([{ kind: "new" }]);
    expect(plan.defaultIndex).toBe(0);
  });

  it("lists a connected account plus the new-account option", () => {
    const existing: ExistingConnection[] = [
      { id: "src_1", connectionName: "Acme", accountExternalId: "act_123", status: "connected" }
    ];
    const plan = buildConnectPicker(existing);
    expect(plan.options).toHaveLength(2);
    expect(plan.actions).toEqual([{ kind: "reconnect", sourceId: "src_1" }, { kind: "new" }]);
    expect(plan.defaultIndex).toBe(0);
    expect(plan.options[0]).toContain("act_123");
    expect(plan.options[0]).toContain("[connected]");
  });

  it("defaults to the first broken connection", () => {
    const existing: ExistingConnection[] = [
      { id: "src_1", connectionName: "A", status: "connected" },
      { id: "src_2", connectionName: "B", status: "error" },
      { id: "src_3", connectionName: "C", status: "connected" }
    ];
    const plan = buildConnectPicker(existing);
    expect(plan.defaultIndex).toBe(1);
  });

  it("uses (unnamed) when the connection name is missing", () => {
    const existing: ExistingConnection[] = [{ id: "src_1", status: "connected" }];
    const plan = buildConnectPicker(existing);
    expect(plan.options[0]).toContain("(unnamed)");
  });
});

describe("connectorSetupDefinition aliases", () => {
  it("canonicalizes provider aliases", () => {
    expect(connectorSetupDefinition("meta")?.provider).toBe("meta_ads");
    expect(connectorSetupDefinition("twitter")?.provider).toBe("x");
    expect(connectorSetupDefinition("ga4")?.provider).toBe("google_analytics_4");
  });

  it("returns undefined for unknown providers", () => {
    expect(connectorSetupDefinition("nope")).toBeUndefined();
  });
});

describe("connectProviderPicker wiring", () => {
  const definition = connectorSetupDefinition("x")!;

  it("reconnects the selected existing connection", async () => {
    const reconnect = vi.fn().mockResolvedValue({ ok: true });
    const runNew = vi.fn().mockResolvedValue({ ok: true });
    await connectProviderPicker(definition, fakeEnv, {
      listExisting: async () => [{ id: "src_1", connectionName: "A", status: "connected" }],
      select: async () => 0,
      runNew,
      reconnect
    });
    expect(reconnect).toHaveBeenCalledWith("src_1", fakeEnv);
    expect(runNew).not.toHaveBeenCalled();
  });

  it("runs the new-connection flow when the new slot is selected", async () => {
    const reconnect = vi.fn().mockResolvedValue({ ok: true });
    const runNew = vi.fn().mockResolvedValue({ ok: true });
    await connectProviderPicker(definition, fakeEnv, {
      listExisting: async () => [{ id: "src_1", connectionName: "A", status: "connected" }],
      select: async () => 1,
      runNew,
      reconnect
    });
    expect(runNew).toHaveBeenCalledWith(definition, fakeEnv);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("goes straight to the new-connection flow when nothing exists", async () => {
    const select = vi.fn();
    const runNew = vi.fn().mockResolvedValue({ ok: true });
    await connectProviderPicker(definition, fakeEnv, {
      listExisting: async () => [],
      select,
      runNew
    });
    expect(runNew).toHaveBeenCalledWith(definition, fakeEnv);
    expect(select).not.toHaveBeenCalled();
  });
});

// FIX 3 — the interactive "Reconnect" picker must prompt for + test with the NEW
// credential; it must NEVER pre-authenticate with the stored (possibly dead) old
// token. The bug: selecting "Reconnect <dead account>" POSTed an EMPTY body, so
// the server re-authenticated with the stored token and failed before the operator
// could ever supply a working one. These mocked tests assert the NEW credential is
// submitted to the reconnect route (so the server tests with the new token).
describe("reconnectExistingConnector (FIX 3 — never pre-auth with the stored token)", () => {
  const tokenDefinition = connectorSetupDefinition("x")!;
  const oauthDefinition = connectorSetupDefinition("ga4")!;

  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubReconnectApi(connectionTestOk = true): {
    calls: Array<{ url: string; method: string; auth?: string; body: Record<string, unknown> }>;
  } {
    const state: {
      calls: Array<{ url: string; method: string; auth?: string; body: Record<string, unknown> }>;
    } = { calls: [] };
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      state.calls.push({
        url: href,
        method: (init?.method ?? "GET").toUpperCase(),
        auth: headers.Authorization,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      });
      // The reconnect handler tests the NEW credential and returns its verdict.
      return new Response(
        JSON.stringify({
          ok: true,
          actionId: "reconnect_source",
          status: "ok",
          authority: "operator",
          data: { sourceId: "src_dead", status: "connected", connectionTest: { ok: connectionTestOk } }
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    return state;
  }

  const reconnectEnv: CliEnv = {
    GROWTH_OS_API_URL: "http://127.0.0.1:3000",
    GROWTH_OS_OPERATOR_TOKEN: "operator-secret"
  } as CliEnv;

  it("submits the NEW credential to /sources/:id/reconnect (NOT an empty body)", async () => {
    const api = stubReconnectApi();
    // The operator enters a brand-new token; the stored one is never read.
    const resolveCredential = vi.fn(async () => ({ mode: "live", apiKey: "fresh-token-123" }));
    const result = (await reconnectExistingConnector(tokenDefinition, "src_dead", reconnectEnv, {
      resolveCredential
    })) as { ok: boolean; reconnected?: boolean; sourceId?: string };

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.reconnected).toBe(true);
    expect(result.sourceId).toBe("src_dead");

    const call = api.calls.find((c) => c.url.includes("/sources/src_dead/reconnect"));
    expect(call).toBeDefined();
    expect(call?.method).toBe("POST");
    // The NEW credential is in the body — this is what makes the server test the
    // new token. An EMPTY body (the bug) would re-auth with the stored token.
    expect(call?.body.credentialPayload).toMatchObject({ apiKey: "fresh-token-123" });
    expect(call?.body.credentialKind).toBeTruthy();
    expect(Object.keys(call?.body ?? {})).not.toHaveLength(0);
    // Operator token attached by apiRequest.
    expect(call?.auth).toBe("Bearer operator-secret");
  });

  it("reconnect succeeds with a new token even when the STORED credential is invalid", async () => {
    // The connection test passes because the server tests the NEW token (in the
    // body), proving we never pre-authenticate with the dead stored credential.
    const api = stubReconnectApi(true);
    const resolveCredential = vi.fn(async () => ({ mode: "live", apiKey: "working-token" }));
    const result = (await reconnectExistingConnector(tokenDefinition, "src_dead", reconnectEnv, {
      resolveCredential
    })) as { ok: boolean; result?: { data?: { connectionTest?: { ok?: boolean } } } };
    expect(result.ok).toBe(true);
    expect(result.result?.data?.connectionTest?.ok).toBe(true);
    // Exactly one reconnect POST carrying the new credential; no other auth call.
    const reconnectCalls = api.calls.filter((c) => c.url.includes("/reconnect"));
    expect(reconnectCalls).toHaveLength(1);
    expect(reconnectCalls[0]?.body.credentialPayload).toMatchObject({ apiKey: "working-token" });
  });

  it("returns needs-input (no POST) when the operator supplies no new credential", async () => {
    const api = stubReconnectApi();
    const resolveCredential = vi.fn(async () => null);
    const result = (await reconnectExistingConnector(tokenDefinition, "src_dead", reconnectEnv, {
      resolveCredential
    })) as { ok?: boolean };
    expect(result.ok).not.toBe(true);
    expect(api.calls.filter((c) => c.url.includes("/reconnect"))).toHaveLength(0);
  });

  it("OAuth providers re-run the browser OAuth flow (fresh token), not the token-payload path", async () => {
    const api = stubReconnectApi();
    const runOAuth = vi.fn(async () => ({ ok: true, section: "connectors" }));
    const resolveCredential = vi.fn();
    await reconnectExistingConnector(oauthDefinition, "src_ga4", reconnectEnv, {
      runOAuth,
      resolveCredential
    });
    expect(runOAuth).toHaveBeenCalledWith(oauthDefinition, reconnectEnv);
    // The token-payload reconnect route is never hit for OAuth providers.
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(api.calls.filter((c) => c.url.includes("/reconnect"))).toHaveLength(0);
  });

  it("connectProviderPicker's DEFAULT reconnect dep routes to reconnectExistingConnector (not an empty POST)", async () => {
    const api = stubReconnectApi();
    // No `reconnect` dep injected → exercise the real default. We still inject
    // `listExisting`/`select` to pick the existing connection deterministically,
    // and force the credential via a non-interactive resolve seam is not exposed
    // here, so the default resolver will return null without a TTY — asserting
    // the default path reaches the reconnect helper (needs-input), NOT an empty
    // reconnect POST against the stored token.
    const result = (await connectProviderPicker(tokenDefinition, reconnectEnv, {
      listExisting: async () => [{ id: "src_dead", connectionName: "Dead", status: "error" }],
      select: async () => 0
    })) as { ok?: boolean };
    // The default (non-interactive, no flags) resolver yields no credential, so we
    // land on needs-input — crucially we did NOT fire an empty reconnect POST that
    // would have re-authenticated with the dead stored token.
    expect(api.calls.filter((c) => c.url.includes("/reconnect"))).toHaveLength(0);
    expect(result.ok).not.toBe(true);
  });
});
