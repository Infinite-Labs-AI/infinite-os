import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptCredentialPayload } from "@infinite-os/core";
import type { InfiniteOsDb } from "@infinite-os/db";
import {
  ConnectorError,
  getStripeCatalogProduct,
  listStripeCatalogProducts,
} from "./index.js";

const KEY = "stripe-catalog-test-key-that-is-at-least-32-bytes";

function catalogDb(options: {
  workspaceId?: string;
  sourceId?: string;
  credentialId?: string;
  credentialUpdatedAt?: string;
  sourceStatus?: string;
  sourceRows?: Array<Record<string, unknown>>;
  observedSql?: string[];
} = {}): InfiniteOsDb {
  const workspaceId = options.workspaceId ?? "ws_catalog";
  const sourceId = options.sourceId ?? "src_stripe";
  const encrypted = encryptCredentialPayload({
    mode: "live",
    secretKey: "rk_test_customer",
    apiBaseUrl: "https://stripe.test",
  }, KEY);
  const one: InfiniteOsDb["one"] = async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
    if (sql.includes("from sources s") && sql.includes("connection_credentials")) {
      if (params?.[0] !== workspaceId || (params?.[1] && params[1] !== sourceId)) return null;
      return {
        source_id: sourceId,
        source_status: options.sourceStatus ?? "connected",
        credential_id: options.credentialId ?? "cred_1",
        credential_updated_at: options.credentialUpdatedAt ?? "2026-09-29T12:00:00.000000Z",
      } as unknown as T;
    }
    if (sql.includes("from connection_credentials")) {
      return {
        credential_kind: "api_key",
        encrypted_payload: encrypted,
        oauth_token_id: null,
      } as unknown as T;
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const query: InfiniteOsDb["query"] = async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
    options.observedSql?.push(sql);
    if (sql.includes("from sources s") && sql.includes("connection_credentials")) {
      if (options.sourceRows) return options.sourceRows as T[];
      if (params?.[0] !== workspaceId || (params?.[1] && params[1] !== sourceId)) return [];
      return [{
        source_id: sourceId,
        source_status: options.sourceStatus ?? "connected",
        credential_id: options.credentialId ?? "cred_1",
        credential_updated_at: options.credentialUpdatedAt ?? "2026-09-29T12:00:00.000000Z",
      }] as unknown as T[];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return { one, query } as unknown as InfiniteOsDb;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Stripe live product catalog", () => {
  it("lists one bounded product page with expanded default prices and returns only safe catalog facts", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      data: [{
        id: "prod_gold",
        active: true,
        name: "Gold",
        description: "For growing teams",
        images: ["https://cdn.example/gold.png"],
        url: "https://example.test/gold",
        metadata: { private_note: "must not cross" },
        default_price: {
          id: "price_monthly",
          active: true,
          currency: "isk",
          unit_amount: 1900,
          unit_amount_decimal: "1900",
          type: "recurring",
          recurring: { interval: "month", interval_count: 2, usage_type: "licensed" },
          billing_scheme: "per_unit",
          custom_unit_amount: null,
          tiers_mode: null,
        },
      }],
      has_more: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listStripeCatalogProducts(catalogDb(), {
      workspaceId: "ws_catalog",
      encryptionKey: KEY,
      limit: 999,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe("/v1/products");
    expect(url.searchParams.get("active")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("30");
    expect(url.searchParams.getAll("expand[]")).toEqual(["data.default_price"]);
    expect(String((init as RequestInit).headers)).not.toContain("rk_test_customer");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      sourceId: "src_stripe",
      products: [{
        id: "prod_gold",
        active: true,
        name: "Gold",
        description: "For growing teams",
        images: ["https://cdn.example/gold.png"],
        url: "https://example.test/gold",
        defaultPrice: {
          id: "price_monthly",
          active: true,
          currency: "isk",
          unitAmount: 1900,
          unitAmountDecimal: "1900",
          type: "recurring",
          recurring: { interval: "month", intervalCount: 2, usageType: "licensed" },
          billingScheme: "per_unit",
          customUnitAmount: false,
          tiersMode: null,
        },
      }],
      hasMore: true,
      nextCursor: "prod_gold",
      searchEventuallyConsistent: false,
    });
    expect(JSON.stringify(result)).not.toContain("private_note");
  });

  it("uses one bounded search request with an opaque search cursor", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      data: [{ id: "prod_search", active: true, name: "Gold", description: null, images: [], url: null, default_price: null }],
      has_more: true,
      next_page: "page_live_2",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listStripeCatalogProducts(catalogDb({ workspaceId: "ws_search" }), {
      workspaceId: "ws_search",
      encryptionKey: KEY,
      query: `gold \"team\"`,
      cursor: "page_live_1",
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/products/search");
    expect(url.searchParams.get("limit")).toBe("30");
    expect(url.searchParams.get("page")).toBe("page_live_1");
    expect(url.searchParams.get("query")).toBe(`active:\"true\" AND name~\"gold \\\"team\\\"\"`);
    expect(result.nextCursor).toBe("page_live_2");
    expect(result.searchEventuallyConsistent).toBe(true);
  });

  it("retrieves one exact product and one capped active-price page without inventing free prices", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
      const url = new URL(String(rawUrl));
      if (url.pathname === "/v1/products/prod_exact") {
        return jsonResponse({
          id: "prod_exact", active: true, name: "Enterprise", description: null,
          images: ["https://cdn.example/enterprise.png"], url: null,
          default_price: "price_tiered",
        });
      }
      if (url.pathname === "/v1/prices") {
        return jsonResponse({
          data: [{
            id: "price_tiered", active: true, currency: "usd", unit_amount: null,
            unit_amount_decimal: null, type: "recurring",
            recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
            billing_scheme: "tiered", custom_unit_amount: null, tiers_mode: "graduated",
          }],
          has_more: true,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getStripeCatalogProduct(catalogDb({ workspaceId: "ws_exact" }), {
      workspaceId: "ws_exact",
      encryptionKey: KEY,
      productId: "prod_exact",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pricesUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(pricesUrl.searchParams.get("product")).toBe("prod_exact");
    expect(pricesUrl.searchParams.get("active")).toBe("true");
    expect(pricesUrl.searchParams.get("limit")).toBe("100");
    expect(result.pricesTruncated).toBe(true);
    expect(result.prices[0]).toMatchObject({
      id: "price_tiered",
      unitAmount: null,
      unitAmountDecimal: null,
      billingScheme: "tiered",
      tiersMode: "graduated",
      recurring: { interval: "year", intervalCount: 1 },
    });
  });

  it("coalesces identical live pages while one provider request is in flight", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      await held;
      return jsonResponse({ data: [], has_more: false });
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = catalogDb({ workspaceId: "ws_coalesce" });
    const input = { workspaceId: "ws_coalesce", encryptionKey: KEY };

    const first = listStripeCatalogProducts(db, input);
    const second = listStripeCatalogProducts(db, input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces missing Products or Prices permission as catalog-unavailable, never not-connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: {
        code: "more_permissions_required",
        message: "Enabling Products Read ('product_read') permissions on this key would allow this request to continue.",
      },
    }, 403)));

    await expect(listStripeCatalogProducts(catalogDb({ workspaceId: "ws_permission" }), {
      workspaceId: "ws_permission",
      encryptionKey: KEY,
    })).rejects.toMatchObject({
      code: "stripe_catalog_permissions_required",
      retryable: false,
      message: expect.stringContaining("Products: Read and Prices: Read"),
    });
  });

  it("refuses a Stripe source outside the workspace before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listStripeCatalogProducts(catalogDb(), {
      workspaceId: "ws_catalog",
      sourceId: "src_foreign",
      encryptionKey: KEY,
    })).rejects.toMatchObject({ code: "stripe_source_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("orders usable sources before the row cap and keeps a syncing source readable", async () => {
    const observedSql: string[] = [];
    const db = catalogDb({
      workspaceId: "ws_source_order",
      observedSql,
      sourceRows: [
        { source_id: "src_syncing", source_status: "syncing", credential_id: "cred_live", credential_updated_at: "2026-09-29T12:00:00Z" },
        { source_id: "src_error", source_status: "error", credential_id: "cred_error", credential_updated_at: "2026-09-29T13:00:00Z" },
        { source_id: "src_revoked", source_status: "revoked", credential_id: null, credential_updated_at: null },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [], has_more: false })));

    await expect(listStripeCatalogProducts(db, {
      workspaceId: "ws_source_order",
      encryptionKey: KEY,
    })).resolves.toMatchObject({ sourceId: "src_syncing" });
    expect(observedSql[0]).toMatch(/source_usable[\s\S]*order by source_usable desc/i);
    expect(observedSql[0]).toContain("'syncing'");
  });

  it("still refuses ambiguity when unhealthy rows accompany two usable sources", async () => {
    const db = catalogDb({
      workspaceId: "ws_ambiguous",
      sourceRows: [
        { source_id: "src_error", source_status: "error", credential_id: "cred_error", credential_updated_at: "2026-09-29T14:00:00Z" },
        { source_id: "src_a", source_status: "connected", credential_id: "cred_a", credential_updated_at: "2026-09-29T13:00:00Z" },
        { source_id: "src_b", source_status: "degraded", credential_id: "cred_b", credential_updated_at: "2026-09-29T12:00:00Z" },
      ],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listStripeCatalogProducts(db, {
      workspaceId: "ws_ambiguous",
      encryptionKey: KEY,
    })).rejects.toMatchObject({ code: "stripe_source_ambiguous" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed exact product ids before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getStripeCatalogProduct(catalogDb({ workspaceId: "ws_bad_id" }), {
      workspaceId: "ws_bad_id",
      encryptionKey: KEY,
      productId: "../../../customers",
    })).rejects.toBeInstanceOf(ConnectorError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
