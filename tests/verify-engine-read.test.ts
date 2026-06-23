// P0-D — unit coverage for the connect-and-read sanity-check script's CORE logic.
//
// The LIVE run (`npx tsx scripts/verify-engine-read.ts --project <growth-os-proj>`)
// is a SEPARATE, human-gated step: it hits the real growth_os DB and makes a live
// Graph API call against the user's real Meta account. It CANNOT run in CI / here.
//
// This file proves the pure, injectable core (`verifyEngineRead`) WITHOUT any DB or
// network: a mocked `db` (the `connection_credentials` metadata row + the resolver's
// credential read) and a mocked `fetchImpl` (the Graph /insights response). It covers:
//   1. token-source selection (system_user when is_system_user / no oauth link; oauth
//      when the credential is linked to an oauth_tokens row) — exercising WHICHEVER
//      token the resolver actually picks;
//   2. the non-empty assertion (≥1 row with non-zero spend/impressions) — pass, plus
//      fail-on-empty and fail-on-all-zero;
//   3. the no-token-leak guard — the structured report (and anything it prints) never
//      contains the secret access token.
import { beforeAll, describe, expect, it, vi } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";

import {
  verifyEngineRead,
  formatReport,
  EngineReadError,
  type VerifyEngineReadDeps
} from "../scripts/verify-engine-read.js";

const WORKSPACE_ID = "proj_test";
const SOURCE_ID = "src_meta_ads_1";
const AD_ACCOUNT_ID = "act_887743100560299";
const SECRET_TOKEN = "EAAB-super-secret-system-user-token-do-not-leak";

// The resolver decrypts `encrypted_payload` with this key (`requiredEncryptionKey()` reads
// GROWTH_OS_ENCRYPTION_KEY), so the test encrypts its mock payloads with the same key to
// exercise the REAL resolve path (not a stub) end-to-end. ≥16 chars, not a known default.
const TEST_KEY = "p0d-test-encryption-key-32-bytes-long-enough";

beforeAll(() => {
  process.env.GROWTH_OS_ENCRYPTION_KEY = TEST_KEY;
});

interface MetadataRow {
  credential_kind: string;
  is_system_user: boolean;
  oauth_token_id: string | null;
}

// Build a mocked InfiniteOsDb-shaped object good enough for the two reads the core makes:
//   (a) `resolveMetaAdsCredential` -> sourceCredential's `select ... from connection_credentials`
//       (returns credential_kind + encrypted_payload + oauth_token_id), then for an oauth-linked
//       row a follow-up `select ... from oauth_tokens`.
//   (b) the metadata probe -> `is_system_user` / `oauth_token_id` for the same source.
// The encrypted_payload is a plain JSON string here; the real engine encrypts it, but
// `resolveMetaAdsCredential` only parses (the script never decrypts in the test path) — we
// inject the parsed payload by routing through the same shape the resolver expects.
function makeDb(options: {
  metadata: MetadataRow;
  systemUserToken: string;
  oauthToken?: string;
}): { db: VerifyEngineReadDeps["db"]; queries: string[] } {
  const queries: string[] = [];
  // For the system-user path the token lives in the credential payload; for the oauth path
  // the credential payload carries only NON-secret metadata and the token lives in the linked
  // oauth_tokens row (exactly as `sourceCredential` / `resolveLiveOAuthCredential` read it).
  const credentialPayload: Record<string, unknown> = {
    transport: "marketing_api",
    adAccountId: AD_ACCOUNT_ID,
    apiVersion: "v25.0"
  };
  if (!options.metadata.oauth_token_id) {
    credentialPayload.accessToken = options.systemUserToken;
  }
  const encryptedCredential = encryptCredentialPayload(credentialPayload, TEST_KEY);
  const encryptedOauth = encryptCredentialPayload(
    { accessToken: options.oauthToken ?? "" },
    TEST_KEY
  );
  const db: VerifyEngineReadDeps["db"] = {
    async one<T>(sql: string): Promise<T | null> {
      queries.push(sql);
      if (sql.includes("from connection_credentials") && sql.includes("oauth_token_id")) {
        // This select shape feeds BOTH the metadata probe (oauth_token_id/is_system_user)
        // AND the resolver's read (credential_kind + encrypted_payload), so it returns the
        // full row the script needs from a real growth_os connection_credentials row.
        return {
          credential_kind: options.metadata.credential_kind,
          is_system_user: options.metadata.is_system_user,
          oauth_token_id: options.metadata.oauth_token_id,
          encrypted_payload: encryptedCredential
        } as unknown as T;
      }
      if (sql.includes("from oauth_tokens")) {
        return {
          encrypted_payload: encryptedOauth,
          expires_at: null
        } as unknown as T;
      }
      return null;
    }
  };
  return { db, queries };
}

function graphResponse(rows: Array<{ spend?: string; impressions?: string }>): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: rows };
    },
    async text() {
      return JSON.stringify({ data: rows });
    }
  } as unknown as Response;
}

describe("verifyEngineRead (P0-D core)", () => {
  it("picks the system_user token source and passes on a non-empty, non-zero read", async () => {
    const { db } = makeDb({
      metadata: { credential_kind: "marketing_api_access_token", is_system_user: true, oauth_token_id: null },
      systemUserToken: SECRET_TOKEN
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        graphResponse([{ spend: "12.34", impressions: "5000" }])
    );

    const report = await verifyEngineRead({
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID
    });

    expect(report.tokenSource).toBe("system_user");
    expect(report.rowCount).toBeGreaterThanOrEqual(1);
    expect(report.accountId).toBe(AD_ACCOUNT_ID);
    expect(report.ok).toBe(true);

    // The resolver must have actually picked the system-user token (sent as a bearer).
    const init = fetchImpl.mock.calls[0]![1]!;
    const auth = init.headers as Record<string, string>;
    expect(auth.Authorization).toContain(SECRET_TOKEN);
  });

  it("picks the oauth token source when the credential is linked to an oauth_tokens row", async () => {
    const OAUTH_TOKEN = "ya29.oauth-user-token-secret";
    const { db } = makeDb({
      metadata: { credential_kind: "oauth_access_token", is_system_user: false, oauth_token_id: "oauth_1" },
      systemUserToken: SECRET_TOKEN,
      oauthToken: OAUTH_TOKEN
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        graphResponse([{ spend: "1.00", impressions: "10" }])
    );

    const report = await verifyEngineRead({
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID
    });

    expect(report.tokenSource).toBe("oauth");
    // The resolver picked the LIVE oauth token, not the (absent) system-user one.
    const init = fetchImpl.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toContain(OAUTH_TOKEN);
    expect(headers.Authorization).not.toContain(SECRET_TOKEN);
  });

  it("FAILS when the read returns zero rows", async () => {
    const { db } = makeDb({
      metadata: { credential_kind: "marketing_api_access_token", is_system_user: true, oauth_token_id: null },
      systemUserToken: SECRET_TOKEN
    });
    const fetchImpl = vi.fn(async () => graphResponse([]));

    await expect(
      verifyEngineRead({
        db,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        workspaceId: WORKSPACE_ID,
        sourceId: SOURCE_ID
      })
    ).rejects.toBeInstanceOf(EngineReadError);
  });

  it("FAILS when every row has zero spend AND zero impressions", async () => {
    const { db } = makeDb({
      metadata: { credential_kind: "marketing_api_access_token", is_system_user: true, oauth_token_id: null },
      systemUserToken: SECRET_TOKEN
    });
    const fetchImpl = vi.fn(async () =>
      graphResponse([
        { spend: "0", impressions: "0" },
        { spend: "0.00", impressions: "0" }
      ])
    );

    await expect(
      verifyEngineRead({
        db,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        workspaceId: WORKSPACE_ID,
        sourceId: SOURCE_ID
      })
    ).rejects.toBeInstanceOf(EngineReadError);
  });

  it("never leaks the access token in the structured report or its printed form", async () => {
    const { db } = makeDb({
      metadata: { credential_kind: "marketing_api_access_token", is_system_user: true, oauth_token_id: null },
      systemUserToken: SECRET_TOKEN
    });
    const fetchImpl = vi.fn(async () => graphResponse([{ spend: "99.99", impressions: "123456" }]));

    const report = await verifyEngineRead({
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID
    });

    // No field of the structured report carries the secret.
    expect(JSON.stringify(report)).not.toContain(SECRET_TOKEN);
    // The human-facing printout never carries the secret either.
    expect(formatReport(report)).not.toContain(SECRET_TOKEN);
  });
});
