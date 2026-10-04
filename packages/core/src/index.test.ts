import { describe, expect, it } from "vitest";

import {
  KNOWN_DEFAULT_ENCRYPTION_KEYS,
  decryptCredentialPayload,
  encryptCredentialPayload,
  generateEncryptionKey,
  infiniteOsVersion,
  isEncryptedCredentialPayload,
  refreshOAuthToken
} from "./index.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body
  } as unknown as Response;
}

describe("core smoke", () => {
  it("exports the Infinite OS version", () => {
    expect(infiniteOsVersion).toBe("0.1.0");
  });

  it("round-trips encrypted credential payloads without storing plaintext", () => {
    const encrypted = encryptCredentialPayload(
      { mode: "live", secretKey: "sk_test_secret" },
      "core-test-encryption-key"
    );

    expect(isEncryptedCredentialPayload(encrypted)).toBe(true);
    expect(encrypted).not.toContain("sk_test_secret");
    expect(decryptCredentialPayload(encrypted, "core-test-encryption-key")).toEqual({
      mode: "live",
      secretKey: "sk_test_secret"
    });
  });

  it("refuses to encrypt under a known default encryption key", () => {
    for (const def of ["change-me-32-byte-minimum-key", "dev-change-me-32-byte-minimum-key"]) {
      expect(() => encryptCredentialPayload({ a: 1 }, def)).toThrow(/known default/i);
    }
  });

  it("still rejects empty or too-short keys with the configuration error", () => {
    expect(() => encryptCredentialPayload({ a: 1 }, "")).toThrow(/must be configured/i);
    expect(() => encryptCredentialPayload({ a: 1 }, "short")).toThrow(/must be configured/i);
  });

  it("generates a 32-byte (64 hex char) random key that is not a known default", () => {
    const key = generateEncryptionKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(KNOWN_DEFAULT_ENCRYPTION_KEYS.has(key)).toBe(false);
    expect(generateEncryptionKey()).not.toBe(key);
  });
});

describe("refreshOAuthToken", () => {
  it("posts a form-encoded refresh grant and returns the rotated token + expiry", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        access_token: "live-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600
      });
    }) as unknown as typeof fetch;

    const before = Date.now();
    const result = await refreshOAuthToken({
      tokenUrl: "https://oauth2.example.com/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "old-refresh-token",
      fetchImpl
    });

    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("live-access-token");
    expect(result?.refreshToken).toBe("rotated-refresh-token");
    expect(result?.expiresAt).toBeDefined();
    expect(new Date(result!.expiresAt!).getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000 - 5000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth2.example.com/token");
    expect(calls[0].init?.method).toBe("POST");
    const body = String(calls[0].init?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh-token");
    expect(body).toContain("client_id=client-id");
    expect(body).toContain("client_secret=client-secret");
  });

  it("keeps the existing refresh token when the provider does not return a new one", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ access_token: "live-access-token", expires_in: 1800 })) as unknown as typeof fetch;

    const result = await refreshOAuthToken({
      tokenUrl: "https://oauth2.example.com/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "old-refresh-token",
      fetchImpl
    });

    expect(result?.accessToken).toBe("live-access-token");
    expect(result?.refreshToken).toBe("old-refresh-token");
  });

  it("returns null when the provider rejects the exchange", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "invalid_grant" }, false)) as unknown as typeof fetch;

    const result = await refreshOAuthToken({
      tokenUrl: "https://oauth2.example.com/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "old-refresh-token",
      fetchImpl
    });

    expect(result).toBeNull();
  });

  it("returns null without calling fetch when required inputs are missing", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({ access_token: "x" });
    }) as unknown as typeof fetch;

    const result = await refreshOAuthToken({
      tokenUrl: "https://oauth2.example.com/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "",
      fetchImpl
    });

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});
