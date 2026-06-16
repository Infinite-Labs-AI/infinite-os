import { describe, expect, it, vi } from "vitest";

import {
  buildConnectPicker,
  connectorSetupDefinition,
  connectProviderPicker,
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
