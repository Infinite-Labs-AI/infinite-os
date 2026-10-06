import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptCredentialPayload } from "@infinite-os/core";
import { createSessionContext } from "@infinite-os/runtime";
import type { InfiniteOsDb } from "@infinite-os/db";
import { metaPublishingTracking } from "@infinite-os/connectors";
import { createActionHandlers } from "./index.js";
const key = "a".repeat(64);
const context = createSessionContext({
  workspaceId: "workspace-a",
  sessionId: "session-a",
  actorId: "actor-a",
  authority: "operator",
  surface: "api"
});
function database() {
  const claims = new Map<
    string,
    {
      id: string;
      entity_id: string | null;
      entity?: unknown;
      actor_id?: unknown;
      input_hash?: unknown;
    }
  >();
  let identity: unknown = null,
    cooldown: string | null = null;
  const db = {
    query: vi.fn(async (sql: string, p: unknown[] = []) => {
      if (sql.includes("delete from meta_write_dedup"))
        for (const [token, row] of claims)
          if (row.id === p[0] && !row.entity_id) claims.delete(token);
      if (sql.includes("update meta_write_dedup"))
        for (const row of claims.values())
          if (row.id === p[0]) row.entity_id = String(p[1]);
      if (sql.includes("insert into meta_local_publish_cooldown"))
        cooldown = String(p[1]);
      return [];
    }),
    one: vi.fn(async (sql: string, p: unknown[] = []) => {
      if (sql.includes("join connection_credentials"))
        return {
          provider: "meta_ads",
          source_status: "connected",
          account_external_id: "act_123",
          credential_id: "credential-a",
          credential_updated_at: "2026-01-01T00:00:00.000000Z",
          selected_page_id: "222",
          credential_kind: "api_key",
          oauth_token_id: null,
          encrypted_payload: encryptCredentialPayload(
            {
              mode: "live",
              transport: "marketing_api",
              adAccountId: "123",
              accessToken: "fake-secret"
            },
            key
          )
        };
      if (sql.includes("from sources"))
        return { provider: "meta_ads", account_external_id: "act_123" };
      if (sql.includes("from connection_credentials"))
        return {
          id: "credential-a",
          updated_at: "2026-01-01T00:00:00Z",
          selected_page_id: "222",
          credential_kind: "api_key",
          oauth_token_id: null,
          encrypted_payload: encryptCredentialPayload(
            {
              mode: "live",
              transport: "marketing_api",
              adAccountId: "123",
              accessToken: "fake-secret"
            },
            key
          )
        };
      if (sql.includes("insert into meta_write_dedup")) {
        if (claims.has(String(p[3]))) return null;
        const row = {
          id: String(p[0]),
          entity_id: null,
          entity: p[4],
          actor_id: p[5],
          input_hash: p[6]
        };
        claims.set(String(p[3]), row);
        return row;
      }
      if (sql.includes("from meta_write_dedup"))
        return claims.get(String(p[2])) ?? null;
      if (sql.includes("from meta_local_publish_cooldown"))
        return cooldown ? { throttle_until: cooldown } : null;
      if (sql.includes("select identity_json"))
        return identity ? { identity_json: identity } : null;
      if (sql.includes("insert into meta_local_publish_identity"))
        return { identity_json: null };
      if (sql.includes("update meta_local_publish_identity")) {
        identity = JSON.parse(String(p[7]));
        return { operation_id: p[3] };
      }
      return null;
    })
  } as unknown as InfiniteOsDb;
  return { db, claims };
}
const tracked = () =>
  new Response(
    JSON.stringify({
      id: "555",
      account_id: "123",
      url_tags: metaPublishingTracking({ linkUrl: "https://example.test" }),
      object_story_spec: { link_data: { link: "https://example.test" } }
    })
  );
const ad = {
  sourceId: "source-a",
  adsetId: "444",
  creativeId: "555",
  name: "fixture",
  clientToken: "attempt-a"
};
afterEach(() => vi.unstubAllGlobals());
describe("local Meta action safety", () => {
  it("requires a stable clientToken before a local create", async () => {
    const fetcher = vi.fn(async () => new Response('{"id":"666"}'));
    vi.stubGlobal("fetch", fetcher);
    const { db } = database();
    await expect(
      createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
        { ...ad, clientToken: undefined },
        context
      )
    ).rejects.toMatchObject({ code: "meta_client_token_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fences a lost create response and refuses the same pending token without another POST", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return tracked();
      throw Error("response lost");
    });
    vi.stubGlobal("fetch", fetcher);
    const { db, claims } = database(),
      handler = createActionHandlers(db, {
        encryptionKey: key
      }).create_meta_ad!;
    await expect(handler(ad, context)).rejects.toMatchObject({
      metaWrite: { phase: "dispatch_unknown" }
    });
    expect(claims.size).toBe(1);
    await expect(handler(ad, context)).rejects.toMatchObject({
      code: "meta_mutation_outcome_uncertain"
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("records a throttle cooldown and refuses a fresh attempt before a second POST", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method !== "POST"
        ? tracked()
        : new Response('{"error":{"code":17,"message":"Request limit"}}', {
            status: 400
          })
    );
    vi.stubGlobal("fetch", fetcher);
    const { db } = database(),
      handler = createActionHandlers(db, {
        encryptionKey: key
      }).create_meta_ad!;
    await expect(handler(ad, context)).rejects.toBeDefined();
    await expect(
      handler({ ...ad, clientToken: "attempt-b" }, context)
    ).rejects.toMatchObject({ code: "meta_provider_cooldown" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("resolves identity and supplies default tracking to a raw image creative", async () => {
    let posted: URLSearchParams | undefined;
    const fetcher = vi.fn(async (url: URL | string, init: RequestInit) => {
      if (init.method === "POST") {
        posted = new URLSearchParams(String(init.body));
        return new Response('{"id":"666"}');
      }
      return new Response(
        JSON.stringify(
          String(url).includes("/me/")
            ? { data: [{ id: "222", access_token: "page-secret" }] }
            : {
                id: "222",
                connected_page_backed_instagram_account: { id: "333" }
              }
        )
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const { db } = database();
    await createActionHandlers(db, { encryptionKey: key })
      .create_meta_creative!(
      {
        sourceId: "source-a",
        name: "fixture",
        pageId: "222",
        imageHash: "image-hash",
        linkUrl: "https://example.test/product",
        clientToken: "attempt-a"
      },
      context
    );
    expect(JSON.parse(posted!.get("object_story_spec")!)).toMatchObject({
      instagram_user_id: "333"
    });
    expect(posted!.get("url_tags")).toContain("utm_content={{ad.name}}");
  });
  it("refuses an untagged existing creative before creating an ad", async () => {
    const fetcher = vi.fn(
      async () => new Response('{"id":"555","account_id":"123"}')
    );
    vi.stubGlobal("fetch", fetcher);
    const { db } = database();
    await expect(
      createActionHandlers(db, { encryptionKey: key }).create_meta_ad!(
        ad,
        context
      )
    ).rejects.toMatchObject({
      code: "meta_creative_tracking_unverified",
      metaWrite: { phase: "not_dispatched" }
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      fetcher.mock.calls.every(
        (call) =>
          (call as unknown as [unknown, RequestInit])[1]?.method !== "POST"
      )
    ).toBe(true);
  });
  it("refuses unsupported direct-Graph video before identity reads or writes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { db } = database();
    await expect(
      createActionHandlers(db, { encryptionKey: key }).create_meta_creative!(
        {
          sourceId: "source-a",
          name: "fixture",
          pageId: "222",
          videoUrl: "https://example.test/video.mp4",
          linkUrl: "https://example.test",
          clientToken: "attempt-a"
        },
        context
      )
    ).rejects.toMatchObject({ code: "provider_unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
