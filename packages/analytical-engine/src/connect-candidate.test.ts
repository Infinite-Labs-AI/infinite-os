import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { createActionHandlers } from "./index.js";

// C12: the engine tests a key BEFORE it saves the source. A key the provider refuses, or a check
// that can't run right now, must leave NOTHING behind — no source, credential, schedule or audit
// row — so no surface can show a broken connection the user never finished making. A reconnect
// with a bad key must leave the working credential exactly as it was.
//
// Real PGlite (the desktop's engine backend) so "writes nothing" is proven against the real
// db.connectSource, not a mock that could forget a table. fetch is the only fake.

const KEY = "connect-candidate-test-encryption-key";
const WS = "ws_candidate";

const context = {
  workspaceId: WS,
  authority: "operator",
  surface: "api",
  actorId: "operator",
  sessionId: "session"
} as const;

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// One provider per row: the credential a user would paste, what the provider says to a GOOD key,
// and the words a refused key must produce.
const PROVIDERS = [
  {
    provider: "stripe",
    goodPayload: { mode: "live", secretKey: "stripe-good-key" },
    badPayload: { mode: "live", secretKey: "stripe-refused-key" },
    goodResponse: () => json({ data: [] }),
    refusedMessage: "The key was refused. Check you copied all of it.",
    unavailableMessage: "Couldn't reach Stripe to check the key. Try again in a minute."
  },
  {
    provider: "posthog",
    goodPayload: { mode: "live", projectId: "42", personalApiKey: "posthog-good-key", apiHost: "https://posthog.test" },
    badPayload: { mode: "live", projectId: "42", personalApiKey: "posthog-refused-key", apiHost: "https://posthog.test" },
    goodResponse: () => json({ results: [[1]], columns: ["ok"] }),
    refusedMessage: "The key was refused. Check you copied all of it.",
    unavailableMessage: "Couldn't reach PostHog to check the key. Try again in a minute."
  },
  {
    provider: "google_analytics_4",
    goodPayload: { mode: "live", propertyId: "123456", accessToken: "ga4-good-token" },
    badPayload: { mode: "live", propertyId: "123456", accessToken: "ga4-refused-token" },
    goodResponse: () => json({ rows: [] }),
    refusedMessage: "Google refused the sign-in. Sign in again.",
    unavailableMessage: "Couldn't reach Google to check the sign-in. Try again in a minute."
  },
  {
    provider: "shopify",
    goodPayload: { mode: "live", storeDomain: "candidate-test.myshopify.com", adminAccessToken: "shopify-good-token" },
    badPayload: { mode: "live", storeDomain: "candidate-test.myshopify.com", adminAccessToken: "shopify-refused-token" },
    goodResponse: () => json({ data: { shop: { myshopifyDomain: "candidate-test.myshopify.com" } } }),
    refusedMessage: "The token was refused. Check you copied all of it.",
    unavailableMessage: "Couldn't reach Shopify to check the token. Try again in a minute."
  }
] as const;

// Did this request carry the refused credential? Each provider puts it somewhere different.
function carriesRefusedCredential(init?: RequestInit): boolean {
  const headers = new Headers(init?.headers);
  const auth = headers.get("Authorization") ?? "";
  const basic = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
  const shopify = headers.get("X-Shopify-Access-Token") ?? "";
  return [auth, basic, shopify].some((value) => value.includes("refused"));
}

async function rowCounts(db: InfiniteOsDb): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["sources", "connection_credentials", "sync_schedules", "integration_audit_log"]) {
    const row = await db.one<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1`, [WS]);
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

const NOTHING = { sources: 0, connection_credentials: 0, sync_schedules: 0, integration_audit_log: 0 };

describe("connect_source / reconnect_source test the key BEFORE saving (real PGlite)", () => {
  let dataDir: string;
  let db: InfiniteOsDb;
  let onFetch: FetchHandler;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-connect-candidate-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
    await db.ensureWorkspace(WS);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Children before parents (FKs), scoped to this workspace only.
    for (const table of ["integration_audit_log", "sync_schedules", "connection_credentials", "sources"]) {
      await db.query(`delete from ${table} where workspace_id = $1`, [WS]);
    }
    onFetch = () => {
      throw new Error("unexpected provider call");
    };
    vi.stubGlobal("fetch", vi.fn((input: unknown, init?: RequestInit) => Promise.resolve(onFetch(String(input), init))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe.each(PROVIDERS)("$provider", (row) => {
    const connectInput = (payload: Record<string, unknown>) => ({
      provider: row.provider,
      connectionName: `${row.provider} candidate`,
      credentialPayload: payload
    });

    it("a key the provider refuses writes NOTHING and says so in plain words", async () => {
      onFetch = (_url, init) => (carriesRefusedCredential(init) ? json({ error: "refused" }, 401) : row.goodResponse());
      const handlers = createActionHandlers(db, { encryptionKey: KEY });

      await expect(handlers.connect_source?.(connectInput(row.badPayload), context)).rejects.toMatchObject({
        code: "provider_auth_failed",
        message: row.refusedMessage,
        retryable: false
      });
      expect(await rowCounts(db)).toEqual(NOTHING);
    });

    it("a check that can't run right now writes NOTHING and is typed connection_test_unavailable", async () => {
      onFetch = () => {
        throw new TypeError("fetch failed");
      };
      const handlers = createActionHandlers(db, { encryptionKey: KEY });

      await expect(handlers.connect_source?.(connectInput(row.goodPayload), context)).rejects.toMatchObject({
        code: "connection_test_unavailable",
        message: row.unavailableMessage,
        retryable: true
      });
      expect(await rowCounts(db)).toEqual(NOTHING);
    });

    it("a good key still writes the source and reports the passing test", async () => {
      onFetch = () => row.goodResponse();
      const handlers = createActionHandlers(db, { encryptionKey: KEY });

      const result = await handlers.connect_source?.(connectInput(row.goodPayload), context);

      expect(result?.data).toMatchObject({
        source: { provider: row.provider, status: "connected" },
        connectionTest: { ok: true, mode: "live", provider: row.provider }
      });
      expect(await rowCounts(db)).toMatchObject({ sources: 1, connection_credentials: 1 });
    });

    it("a reconnect with a refused key leaves the working credential and status untouched", async () => {
      onFetch = (_url, init) => (carriesRefusedCredential(init) ? json({ error: "refused" }, 401) : row.goodResponse());
      const handlers = createActionHandlers(db, { encryptionKey: KEY });
      const connected = await handlers.connect_source?.(connectInput(row.goodPayload), context);
      const sourceId = String((connected?.data as { source: { id: string } }).source.id);
      const before = await db.query<{ id: string; encrypted_payload: string }>(
        "select id, encrypted_payload from connection_credentials where source_id = $1 and revoked_at is null",
        [sourceId]
      );

      await expect(
        handlers.reconnect_source?.({ sourceId, credentialPayload: row.badPayload }, context)
      ).rejects.toMatchObject({ code: "provider_auth_failed", message: row.refusedMessage });

      const after = await db.query<{ id: string; encrypted_payload: string }>(
        "select id, encrypted_payload from connection_credentials where source_id = $1 and revoked_at is null",
        [sourceId]
      );
      expect(after).toEqual(before);
      expect(decryptCredentialPayload(after[0]!.encrypted_payload, KEY)).toEqual(row.goodPayload);
      const status = await db.one<{ status: string }>("select status from sources where id = $1", [sourceId]);
      expect(status?.status).toBe("connected");
    });

    it("a reconnect whose check can't run leaves the working credential and status untouched", async () => {
      onFetch = () => row.goodResponse();
      const handlers = createActionHandlers(db, { encryptionKey: KEY });
      const connected = await handlers.connect_source?.(connectInput(row.goodPayload), context);
      const sourceId = String((connected?.data as { source: { id: string } }).source.id);
      const before = await db.query("select id, encrypted_payload from connection_credentials where source_id = $1 and revoked_at is null", [sourceId]);
      onFetch = () => {
        throw new TypeError("fetch failed");
      };

      await expect(
        handlers.reconnect_source?.({ sourceId, credentialPayload: row.badPayload }, context)
      ).rejects.toMatchObject({ code: "connection_test_unavailable" });

      const after = await db.query("select id, encrypted_payload from connection_credentials where source_id = $1 and revoked_at is null", [sourceId]);
      expect(after).toEqual(before);
      const status = await db.one<{ status: string }>("select status from sources where id = $1", [sourceId]);
      expect(status?.status).toBe("connected");
    });
  });
});
