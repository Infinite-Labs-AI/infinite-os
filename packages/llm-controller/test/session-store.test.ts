import { describe, expect, it } from "vitest";

import { createSessionStore, type SessionStoreDb } from "../src/session-store.js";

// Records every SQL + params the store issues so we can assert the workspace scoping
// the P0-A money-safety keystone requires: the confirm-path lookup/update MUST be
// scoped by workspace_id ($2), and recordActionCall MUST persist workspace_id.
function makeRecordingDb(oneResult: Record<string, unknown> | null = null): {
  db: SessionStoreDb;
  queries: Array<{ sql: string; params: unknown[] }>;
  ones: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const ones: Array<{ sql: string; params: unknown[] }> = [];
  const db: SessionStoreDb = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return [];
    },
    async one(sql, params = []) {
      ones.push({ sql, params });
      return oneResult as never;
    }
  };
  return { db, queries, ones };
}

describe("session-store workspace pinning (P0-A)", () => {
  it("recordActionCall persists workspace_id on the chat_action_calls row", async () => {
    const { db, queries } = makeRecordingDb();
    const store = createSessionStore(db);
    await store.recordActionCall({
      sessionId: "sess_a",
      actionId: "create_meta_campaign",
      authority: "operator",
      input: { sourceId: "src_1" },
      status: "requires_confirmation",
      requiresConfirmation: true,
      confirmationId: "confirm_abc",
      inputHash: "hash_abc",
      workspaceId: "ws_a"
    });
    const insert = queries.find((q) => /insert\s+into\s+chat_action_calls/i.test(q.sql));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/workspace_id/);
    // workspaceId must be in the bound params (not dropped).
    expect(insert!.params).toContain("ws_a");
  });

  it("getPendingActionCall scopes the SELECT by workspace_id ($2) and returns the bound workspace", async () => {
    const { db, ones } = makeRecordingDb({
      id: "call_1",
      sessionId: "sess_a",
      actionId: "create_meta_campaign",
      input: { sourceId: "src_1" },
      inputHash: "hash_abc",
      workspaceId: "ws_a"
    });
    const store = createSessionStore(db);
    const pending = await store.getPendingActionCall!("confirm_abc", "ws_a");
    expect(pending?.workspaceId).toBe("ws_a");
    const select = ones[0];
    expect(select.sql).toMatch(/workspace_id\s*=\s*\$2/);
    expect(select.sql).toMatch(/workspace_id\s+as\s+"workspaceId"/i);
    expect(select.params).toEqual(["confirm_abc", "ws_a"]);
  });

  it("confirmActionCall scopes the UPDATE by workspace_id ($4) so a collision cannot mark another workspace's row", async () => {
    const { db, queries } = makeRecordingDb();
    const store = createSessionStore(db);
    await store.confirmActionCall!({
      confirmationId: "confirm_abc",
      outputEnvelope: { ok: true },
      status: "ok",
      workspaceId: "ws_a"
    });
    const update = queries.find((q) => /update\s+chat_action_calls/i.test(q.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/workspace_id\s*=\s*\$4/);
    expect(update!.params).toContain("ws_a");
  });
});
