import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInfiniteOsDb, type InfiniteOsDb } from "@infinite-os/db";
import { encryptCredentialPayload } from "@infinite-os/core";
import { createSessionContext } from "@infinite-os/runtime";
import { metaPublishingTracking } from "@infinite-os/connectors";
import { createActionHandlers } from "./index.js";
import { readFileSync } from "node:fs";
let db: InfiniteOsDb;
const tracked = () =>
  new Response(
    JSON.stringify({
      id: "333",
      account_id: "123",
      url_tags: metaPublishingTracking({ linkUrl: "https://example.test" }),
      object_story_spec: { link_data: { link: "https://example.test" } }
    })
  );
const key = "a".repeat(64),
  context = createSessionContext({
    workspaceId: "ws-test",
    actorId: "operator-test",
    sessionId: "session-test",
    surface: "api",
    authority: "operator"
  });
beforeEach(async () => {
  db = createInfiniteOsDb("memory://");
  const statements = [
    "create table workspaces(id text primary key)",
    "create table sources(id text primary key,workspace_id text,provider text,account_external_id text,status text,connected_at timestamptz default now())",
    "create table connection_credentials(id text primary key,workspace_id text,source_id text,credential_kind text,encrypted_payload text,oauth_token_id text,revoked_at timestamptz,expires_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),selected_page_id text)",
    "create table oauth_tokens(id text primary key,workspace_id text,provider text,source_id text,encrypted_payload text,expires_at timestamptz,last_rotated_at timestamptz,created_at timestamptz default now(),revoked_at timestamptz)",
    "create table integration_audit_log(id text primary key,workspace_id text,source_id text,actor_type text,action text,status text,details jsonb,created_at timestamptz default now())"
  ];
  for (const sql of statements) await db.query(sql);
  for (const name of [
    "0028_meta_write_dedup.sql",
    "0084_meta_local_publishing.sql"
  ]) {
    const raw = readFileSync(`packages/db/migrations/${name}`, "utf8").replace(
      /^\s*--.*$/gm,
      ""
    );
    const [tables, block] = raw.split("do $$");
    for (const sql of tables.split(";"))
      if (sql.trim())
        await db.query(sql).catch((error) => {
          throw new Error("Setup statement: " + sql, { cause: error });
        });
    if (block) await db.query("do $$" + block);
  }
  await db.query("insert into workspaces values('ws-test')");
  await db.query(
    "insert into sources(id,workspace_id,provider,account_external_id,status) values('source-test','ws-test','meta_ads','123','connected')"
  );
  await db.query(
    "insert into connection_credentials(id,workspace_id,source_id,credential_kind,encrypted_payload) values('credential-test','ws-test','source-test','api_key',$1)",
    [
      encryptCredentialPayload(
        {
          mode: "live",
          transport: "marketing_api",
          adAccountId: "123",
          accessToken: "fake-token"
        },
        key
      )
    ]
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.close();
});
const input = {
  sourceId: "source-test",
  adsetId: "222",
  creativeId: "333",
  name: "fixture",
  clientToken: "attempt-test"
};
it("retains an uncertain create and its database fence across handler instances", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return tracked();
    throw Error("lost response");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).rejects.toMatchObject({ metaWrite: { phase: "dispatch_unknown" } });
  expect(await db.one("select entity_id from meta_write_dedup")).toEqual({
    entity_id: null
  });
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).rejects.toMatchObject({ code: "meta_mutation_outcome_uncertain" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("releases only a definite refused create so an explicit retry can proceed", async () => {
  const post = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"error":{"code":100,"message":"invalid parameter"}}', {
        status: 400
      })
    )
    .mockResolvedValueOnce(new Response('{"id":"444"}'));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method !== "POST" ? tracked() : post()
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).rejects.toMatchObject({
    metaWrite: { phase: "provider_response", outcome: "refused" }
  });
  expect(await db.one("select entity_id from meta_write_dedup")).toBeNull();
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).resolves.toMatchObject({ data: { id: "444" } });
  expect(post).toHaveBeenCalledTimes(2);
});

it("preserves the provider diagnostic and holds retries from its audit when the cooldown insert fails", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method !== "POST"
      ? tracked()
      : new Response('{"error":{"code":17,"message":"Request limit"}}', {
          status: 400
        })
  );
  vi.stubGlobal("fetch", fetcher);
  const broken = {
    ...db,
    query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes("insert into meta_local_publish_cooldown"))
        throw Error("test persistence failure");
      return db.query<T>(sql, params);
    }
  };
  await expect(
    createActionHandlers(broken, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).rejects.toMatchObject({
    message: expect.stringContaining("Request limit"),
    metaWrite: { providerCode: 17 }
  });
  expect(
    await db.one(
      "select details->'meta_write'->>'providerCode' as code from integration_audit_log where status='failed'"
    )
  ).toEqual({ code: "17" });
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      { ...input, clientToken: "another-attempt" },
      context
    )
  ).rejects.toMatchObject({ code: "meta_provider_cooldown" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reuses only same-actor same-launch creative tracking proof without a verification GET", async () => {
  await db.query("update connection_credentials set selected_page_id='222'");
  const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) => {
    if (init?.method === "POST")
      return new Response(
        JSON.stringify({
          id: String(url).endsWith("/adcreatives") ? "333" : "444"
        })
      );
    if (String(url).includes("/me/"))
      return new Response('{"data":[{"id":"222","access_token":"page-test"}]}');
    if (String(url).includes("/222?")) return new Response('{"id":"222"}');
    return tracked();
  });
  vi.stubGlobal("fetch", fetcher);
  await createActionHandlers(db, { encryptionKey: key }).create_meta_creative!(
    {
      sourceId: "source-test",
      name: "fixture",
      pageId: "222",
      imageHash: "hash-test",
      linkUrl: "https://example.test",
      clientToken: "creative-attempt",
      launchId: "launch-a"
    },
    context
  );
  await createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
    { ...input, launchId: "launch-a" },
    context
  );
  expect(
    fetcher.mock.calls.filter((call) => String(call[0]).includes("/333?"))
  ).toHaveLength(0);
  await createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
    { ...input, clientToken: "another-ad", launchId: "launch-a" },
    { ...context, actorId: "another-operator" }
  );
  expect(
    fetcher.mock.calls.filter((call) => String(call[0]).includes("/333?"))
  ).toHaveLength(1);
});

it("binds local retry tokens to entity, actor and immutable input before returning a previous ID", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST" ? new Response('{"id":"444"}') : tracked()
  );
  vi.stubGlobal("fetch", fetcher);
  const handlers = createActionHandlers(db, { encryptionKey: key });
  await handlers.create_meta_ad!(input, context);
  await expect(handlers.create_meta_ad!(input, context)).resolves.toMatchObject(
    { data: { id: "444", deduped: true } }
  );
  for (const [action, next, actor] of [
    [
      "create_meta_campaign",
      {
        sourceId: "source-test",
        name: "fixture",
        objective: "OUTCOME_TRAFFIC",
        clientToken: input.clientToken
      },
      context
    ],
    ["create_meta_ad", { ...input, creativeId: "999" }, context],
    ["create_meta_ad", input, { ...context, actorId: "another-operator" }]
  ] as const)
    await expect(handlers[action]!(next, actor)).rejects.toMatchObject({
      code: "meta_client_token_conflict"
    });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("refuses a legacy resolved token without identity proof", async () => {
  await db.query(
    "insert into meta_write_dedup(id,workspace_id,source_id,client_token,entity_id,entity) values('legacy','ws-test','source-test','legacy-token','444','ad')"
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      { ...input, clientToken: "legacy-token" },
      context
    )
  ).rejects.toMatchObject({ code: "meta_client_token_conflict" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("retains a typed identity-read throttle hold from the audit when the primary cooldown insert fails", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response('{"error":{"code":17,"message":"Request limit"}}', {
        status: 400
      })
  );
  vi.stubGlobal("fetch", fetcher);
  const broken = {
    ...db,
    query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes("insert into meta_local_publish_cooldown"))
        throw Error("test persistence failure");
      return db.query<T>(sql, params);
    }
  };
  const creative = {
    sourceId: "source-test",
    pageId: "222",
    name: "fixture",
    imageHash: "hash",
    linkUrl: "https://example.test",
    clientToken: "identity-attempt"
  };
  await expect(
    createActionHandlers(broken, { encryptionKey: key }).create_meta_creative!(
      creative,
      context
    )
  ).rejects.toMatchObject({
    code: "provider_rate_limited",
    metaWrite: { phase: "not_dispatched" }
  });
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_creative!(
      { ...creative, clientToken: "next-attempt" },
      context
    )
  ).rejects.toMatchObject({ code: "meta_provider_cooldown" });
  expect(fetcher).toHaveBeenCalledOnce();
});
it("refuses a credential account mismatch before any provider request", async () => {
  await db.query("update connection_credentials set encrypted_payload=$1", [
    encryptCredentialPayload(
      {
        mode: "live",
        transport: "marketing_api",
        adAccountId: "999",
        accessToken: "fake-token"
      },
      key
    )
  ]);
  const fetcher = vi.fn(async () => new Response('{"id":"444"}'));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_campaign!(
      {
        sourceId: "source-test",
        name: "fixture",
        objective: "OUTCOME_TRAFFIC",
        clientToken: "account-attempt"
      },
      context
    )
  ).rejects.toMatchObject({
    code: "provider_auth_failed",
    metaWrite: { phase: "not_dispatched" }
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses one authoritative credential snapshot even if the row rotates after it is read", async () => {
  await db.query("update connection_credentials set selected_page_id='222'");
  let credentialReads = 0,
    rotated = false;
  const racing = {
    ...db,
    one: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> => {
      const row = await db.one<T>(sql, params);
      if (sql.includes("connection_credentials")) credentialReads++;
      if (!rotated && sql.includes("encrypted_payload")) {
        rotated = true;
        await db.query(
          "update connection_credentials set encrypted_payload=$1,selected_page_id='999',updated_at=updated_at+interval '1 microsecond'",
          [
            encryptCredentialPayload(
              {
                mode: "live",
                transport: "marketing_api",
                adAccountId: "123",
                accessToken: "new-token"
              },
              key
            )
          ]
        );
      }
      return row;
    }
  };
  const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response('{"id":"444"}')
      : new Response(
          JSON.stringify(
            String(url).includes("/me/")
              ? { data: [{ id: "222", access_token: "page-test" }] }
              : { id: "222" }
          )
        )
  );
  vi.stubGlobal("fetch", fetcher);
  await createActionHandlers(racing, { encryptionKey: key })
    .create_meta_creative!(
    {
      sourceId: "source-test",
      name: "fixture",
      imageHash: "hash",
      linkUrl: "https://example.test",
      clientToken: "snapshot-attempt",
      launchId: "snapshot-launch"
    },
    context
  );
  expect(credentialReads).toBe(1);
  expect(
    (fetcher.mock.calls[0][1]!.headers as Record<string, string>).authorization
  ).toBe("Bearer fake-token");
});

it("publishes from an active linked OAuth snapshot without a token-refresh request", async () => {
  await db.query(
    "insert into oauth_tokens(id,workspace_id,provider,source_id,encrypted_payload,expires_at) values('oauth-test','ws-test','meta_ads','source-test',$1,now()+interval '1 hour')",
    [encryptCredentialPayload({ accessToken: "oauth-test-token" }, key)]
  );
  await db.query(
    "update connection_credentials set oauth_token_id='oauth-test'"
  );
  const fetcher = vi.fn(async () => new Response('{"id":"444"}'));
  vi.stubGlobal("fetch", fetcher);
  await createActionHandlers(db, { encryptionKey: key }).create_meta_campaign!(
    {
      sourceId: "source-test",
      name: "fixture",
      objective: "OUTCOME_TRAFFIC",
      clientToken: "oauth-attempt"
    },
    context
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(
    (fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers
  ).toMatchObject({ Authorization: "Bearer oauth-test-token" });
});
it("never returns an old-account success receipt after source retarget or revocation", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST" ? new Response('{"id":"444"}') : tracked()
  );
  vi.stubGlobal("fetch", fetcher);
  await createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
    input,
    context
  );
  await db.query("update sources set account_external_id='999'");
  await db.query(
    "update connection_credentials set encrypted_payload=$1,updated_at=updated_at+interval '1 microsecond'",
    [
      encryptCredentialPayload(
        {
          mode: "live",
          transport: "marketing_api",
          adAccountId: "999",
          accessToken: "new-account-token"
        },
        key
      )
    ]
  );
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).rejects.toMatchObject({ code: "meta_client_token_conflict" });
  await db.query("update connection_credentials set revoked_at=now()");
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
      input,
      context
    )
  ).rejects.toMatchObject({ code: "credential_binding_changed" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("resolves the sole active source while its history sync is running", async () => {
  await db.query("update sources set status='syncing'");
  const fetcher = vi.fn(
    async () => new Response('{"id":"444","status":"PAUSED"}')
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createActionHandlers(db, { encryptionKey: key }).create_meta_campaign!(
      {
        name: "fixture",
        objective: "OUTCOME_TRAFFIC",
        clientToken: "syncing-attempt"
      },
      context
    )
  ).resolves.toMatchObject({ data: { id: "444" } });
  expect(fetcher).toHaveBeenCalledOnce();
});
