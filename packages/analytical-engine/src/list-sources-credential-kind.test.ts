import { describe, expect, it } from "vitest";
import { type InfiniteOsDb } from "@infinite-os/db";

import { createActionHandlers } from "./index.js";

// list_sources surfaces each source's latest non-revoked credential_kind so clients (the
// desktop) can tell credential kinds apart — e.g. bearer vs oauth — without a second query.
// Migrated from the retired X session-cookie test file (the behavior is credential-agnostic).

const context = {
  workspaceId: "workspace",
  authority: "operator",
  surface: "mcp",
  actorId: "founder",
  sessionId: "session"
} as const;

describe("list_sources credential_kind", () => {
  it("selects credential_kind and surfaces it on each source", async () => {
    let capturedSql = "";
    const db = {
      async query(sql: string) {
        capturedSql = sql;
        if (sql.includes("from sources")) {
          return [
            {
              id: "source_x",
              provider: "x",
              dataset_key: "x",
              connection_name: "X",
              account_external_id: "acct",
              status: "connected",
              sync_mode: "manual",
              connected_at: null,
              last_synced_at: null,
              credential_kind: "bearer_token"
            }
          ];
        }
        return [];
      },
      async one() {
        return null;
      }
    } as unknown as InfiniteOsDb;

    const env = await createActionHandlers(db).list_sources!({}, context);

    // the SELECT reads the latest non-revoked credential kind
    expect(capturedSql).toContain("credential_kind");
    expect(capturedSql).toContain("connection_credentials");
    // and it flows through to the envelope so clients can tell credential kinds apart
    const sources = (env.data as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources[0]).toMatchObject({ id: "source_x", provider: "x", credential_kind: "bearer_token" });
  });
});
