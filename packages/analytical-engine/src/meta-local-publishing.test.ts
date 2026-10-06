import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInfiniteOsDb } from "@infinite-os/db";
import { readFileSync } from "node:fs";
import { createSessionContext } from "@infinite-os/runtime";
import type { InfiniteOsDb } from "@infinite-os/db";
import * as local from "./meta-local-publishing.js";
let db: InfiniteOsDb;
const context = createSessionContext({
  workspaceId: "workspace-a",
  sessionId: "session-a",
  actorId: "operator-a",
  authority: "operator",
  surface: "api"
});
const credential = {
  mode: "live" as const,
  transport: "marketing_api" as const,
  adAccountId: "123",
  accessToken: "test-token"
};
const first = {
  pageId: "222",
  instagramUserId: "333",
  kind: "page_backed" as const
};
beforeEach(async () => {
  db = createInfiniteOsDb("memory://");
  await db.query("create table meta_write_dedup(id text primary key)");
  await db.query(
    "create table integration_audit_log(status text,details jsonb,created_at timestamptz)"
  );
  const sql = readFileSync(
    "packages/db/migrations/0084_meta_local_publishing.sql",
    "utf8"
  ).replace(/^--.*$/gm, "");
  const [tables, block] = sql.split("do $$");
  for (const statement of tables.split(";"))
    if (statement.trim()) await db.query(statement);
  if (block) await db.query("do $$" + block);
});
afterEach(async () => {
  await db.close();
});
describe("local publishing persistence", () => {
  it("shares identity only for one launch, credential, Page and actor; persists across helper instances", async () => {
    const verify = vi.fn(async () => first),
      now = () => new Date("2026-01-01T00:00:00Z");
    const input = {
      db,
      context,
      sourceId: "source-a",
      credential,
      pageId: "222",
      operationId: "launch-a",
      credentialVersion: "credential-v1"
    };
    await local.resolveLocalMetaIdentity(input, { verify, now });
    await local.resolveLocalMetaIdentity(input, { verify, now });
    expect(verify).toHaveBeenCalledOnce();
    await local.resolveLocalMetaIdentity(
      { ...input, operationId: "launch-b" },
      { verify, now }
    );
    expect(verify).toHaveBeenCalledTimes(2);
    await local.resolveLocalMetaIdentity(
      { ...input, context: { ...context, actorId: "other" } },
      { verify, now }
    );
    expect(verify).toHaveBeenCalledTimes(3);
    await local.resolveLocalMetaIdentity(
      { ...input, credentialVersion: "credential-v2" },
      { verify, now }
    );
    expect(verify).toHaveBeenCalledTimes(4);
    await local.resolveLocalMetaIdentity(
      {
        ...input,
        credential: { ...credential, accessToken: "rotated-test-token" }
      },
      { verify, now }
    );
    expect(verify).toHaveBeenCalledTimes(5);
  });
  it("pins Page-only across refresh and rejects explicit mismatches", async () => {
    const input = {
      db,
      context,
      sourceId: "source-a",
      credential,
      pageId: "222",
      operationId: "launch-a",
      credentialVersion: "credential-v1"
    };
    await local.resolveLocalMetaIdentity(input, {
      verify: async () => ({
        ...first,
        instagramUserId: null,
        kind: "page_only"
      }),
      now: () => new Date("2026-01-01T00:00:00Z")
    });
    await expect(
      local.resolveLocalMetaIdentity(input, {
        verify: async () => first,
        now: () => new Date("2026-01-01T00:11:00Z")
      })
    ).rejects.toMatchObject({ code: "meta_identity_changed" });
    await expect(
      local.resolveLocalMetaIdentity(input, {
        verify: async () => first,
        now: () => new Date("2026-01-01T00:12:00Z")
      })
    ).rejects.toMatchObject({ code: "meta_identity_changed" });
  });
  it("records provider throttles even when an upload leaves the mutation uncertain", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await local.recordLocalMetaCooldown(
      db,
      "123",
      {
        metaWrite: {
          version: 1,
          phase: "dispatch_unknown",
          outcome: "unknown",
          providerCode: 17
        }
      },
      now
    );
    await expect(
      local.assertLocalMetaCooldown(db, "123", now)
    ).rejects.toMatchObject({ code: "meta_provider_cooldown" });
  });
  it("persists cooldown across workspaces for the same account, isolates another account, then expires", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await local.recordLocalMetaCooldown(
      db,
      "act_123",
      {
        metaWrite: {
          version: 1,
          phase: "provider_response",
          outcome: "throttled"
        }
      },
      now
    );
    await expect(
      local.assertLocalMetaCooldown(db, "123", now)
    ).rejects.toMatchObject({ code: "meta_provider_cooldown" });
    await expect(
      local.assertLocalMetaCooldown(db, "456", now)
    ).resolves.toBeUndefined();
    await expect(
      local.assertLocalMetaCooldown(
        db,
        "123",
        new Date(now.getTime() + 2700000)
      )
    ).resolves.toBeUndefined();
  });
});

it("refuses a cached identity whose kind is an array", async () => {
  const input = {
    db,
    context,
    sourceId: "source-a",
    credential,
    pageId: "222",
    operationId: "launch-a",
    credentialVersion: "v1"
  };
  const verify = vi.fn(async () => first),
    now = () => new Date("2026-01-01T00:00:00Z");
  await local.resolveLocalMetaIdentity(input, { verify, now });
  await db.query(
    `update meta_local_publish_identity set identity_json=jsonb_set(identity_json,'{kind}','["business"]'::jsonb)`
  );
  await expect(
    local.resolveLocalMetaIdentity(input, { verify, now })
  ).rejects.toMatchObject({ code: "meta_identity_unavailable" });
  expect(verify).toHaveBeenCalledOnce();
});
