import { describe, expect, it } from "vitest";
import { ConnectorError } from "@infinite-os/connectors";
import type { FirstPhaseProvider } from "@infinite-os/runtime";

import { connectionTestFailure, connectionTestTimedOut } from "./connection-test-copy.js";

// The connect-time key test speaks to a founder standing in front of a form. Every provider verdict
// becomes { code, message } in plain words — never the provider's raw JSON body. The CODE says what
// kind of failure it is (refused key / couldn't check right now / wrong details), so a client can
// branch without parsing the message.

const auth = (status: number, body: string) =>
  new ConnectorError("provider_auth_failed", `provider auth failed ${status} for https://provider.test/x: ${body}`, false);
const apiError = (status: number, body: string) =>
  new ConnectorError("provider_api_error", `provider request failed ${status} for https://provider.test/x: ${body}`, true, undefined, status);
const rateLimited = (body: string) =>
  new ConnectorError("provider_rate_limited", `provider rate limited 429 for https://provider.test/x: ${body}`, true);
const metaBody = (code: number, extra = "") =>
  `{"error":{"message":"(#${code}) Graph says no","type":"OAuthException","code":${code}${extra},"fbtrace_id":"trace"}}`;

type Row = {
  name: string;
  provider: FirstPhaseProvider;
  error: unknown;
  code: string;
  message: string;
  retryable: boolean;
};

const table: Row[] = [
  {
    name: "Stripe key missing one permission",
    provider: "stripe",
    error: new ConnectorError(
      "provider_auth_failed",
      "Stripe restricted key is missing permission: Events: Read. Edit the key in the Stripe Dashboard "
      + "(Developers → API keys) and grant Events, Customers, Invoices and Subscriptions: Read.",
      false
    ),
    code: "provider_auth_failed",
    message: "This key can't read Events: Read. Create a restricted key with it.",
    retryable: false
  },
  {
    name: "Stripe key missing two permissions",
    provider: "stripe",
    error: new ConnectorError(
      "provider_auth_failed",
      "Stripe restricted key is missing permissions: Events: Read, Invoices: Read. Edit the key in the "
      + "Stripe Dashboard (Developers → API keys) and grant Events, Customers, Invoices and Subscriptions: Read.",
      false
    ),
    code: "provider_auth_failed",
    message: "This key can't read Events: Read and Invoices: Read. Create a restricted key with them.",
    retryable: false
  },
  {
    name: "Stripe 401",
    provider: "stripe",
    error: auth(401, '{"error":{"message":"Invalid API Key provided: rk_****","type":"invalid_request_error"}}'),
    code: "provider_auth_failed",
    message: "The key was refused. Check you copied all of it.",
    retryable: false
  },
  {
    name: "Stripe rate limit",
    provider: "stripe",
    error: rateLimited('{"error":{"message":"Too many requests"}}'),
    code: "connection_test_unavailable",
    message: "Stripe is busy. Try again in a minute.",
    retryable: true
  },
  {
    name: "Stripe 5xx",
    provider: "stripe",
    error: apiError(503, '{"error":{"message":"upstream"}}'),
    code: "connection_test_unavailable",
    message: "Stripe had a problem checking the key. Try again in a minute.",
    retryable: true
  },
  {
    name: "PostHog 401",
    provider: "posthog",
    error: auth(401, '{"type":"authentication_error","detail":"Invalid personal API key."}'),
    code: "provider_auth_failed",
    message: "The key was refused. Check you copied all of it.",
    retryable: false
  },
  {
    name: "PostHog 403 (key lacks the scope or project)",
    provider: "posthog",
    error: auth(403, '{"type":"authentication_error","detail":"API key missing required scope \'query:read\'"}'),
    code: "provider_auth_failed",
    message: "This key can't read that project. Check its permissions.",
    retryable: false
  },
  {
    name: "PostHog 404 (wrong project id)",
    provider: "posthog",
    error: apiError(404, '{"type":"invalid_request","detail":"Not found."}'),
    code: "connection_details_rejected",
    message: "PostHog didn't accept these details. Check the project ID and host.",
    retryable: false
  },
  {
    name: "PostHog network failure",
    provider: "posthog",
    error: new TypeError("fetch failed"),
    code: "connection_test_unavailable",
    message: "Couldn't reach PostHog to check the key. Try again in a minute.",
    retryable: true
  },
  {
    name: "GA4 401 (sign-in refused)",
    provider: "google_analytics_4",
    error: auth(401, '{"error":{"code":401,"status":"UNAUTHENTICATED"}}'),
    code: "provider_auth_failed",
    message: "Google refused the sign-in. Sign in again.",
    retryable: false
  },
  {
    name: "GA4 403 (account can't read the property)",
    provider: "google_analytics_4",
    error: auth(403, '{"error":{"code":403,"status":"PERMISSION_DENIED"}}'),
    code: "provider_auth_failed",
    message: "This Google account can't read that property. Pick one it can read.",
    retryable: false
  },
  {
    name: "GA4 400 (bad property id)",
    provider: "google_analytics_4",
    error: apiError(400, '{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'),
    code: "connection_details_rejected",
    message: "Google didn't accept these details. Check the property ID.",
    retryable: false
  },
  {
    name: "GA4 OAuth token revoked",
    provider: "google_analytics_4",
    error: new ConnectorError("provider_auth_failed", "oauth token tok_1 for candidate_1 is missing or revoked", false),
    code: "provider_auth_failed",
    message: "The Google sign-in has expired. Sign in again.",
    retryable: false
  },
  {
    name: "Shopify 401",
    provider: "shopify",
    error: auth(401, '{"errors":"[API] Invalid API key or access token (unrecognized login or wrong password)"}'),
    code: "provider_auth_failed",
    message: "The token was refused. Check you copied all of it.",
    retryable: false
  },
  {
    name: "Shopify 404 (wrong store)",
    provider: "shopify",
    error: apiError(404, '{"errors":"Not Found"}'),
    code: "connection_details_rejected",
    message: "Shopify didn't accept these details. Check the store domain.",
    retryable: false
  },
  {
    name: "Shopify missing field",
    provider: "shopify",
    error: new ConnectorError("provider_auth_failed", "adminAccessToken credential is required", false),
    code: "provider_auth_failed",
    message: "Fill in the Admin API access token and try again.",
    retryable: false
  },
  {
    name: "Meta expired token (400 + OAuthException 190)",
    provider: "meta_ads",
    error: apiError(400, metaBody(190)),
    code: "provider_auth_failed",
    message: "The token was refused or has expired. Paste a fresh one.",
    retryable: false
  },
  {
    name: "Meta account not assigned (code 100 + subcode 33)",
    provider: "meta_ads",
    error: apiError(400, metaBody(100, ',"error_subcode":33')),
    code: "provider_auth_failed",
    message: "This token can't reach that ad account. Check the account is assigned to it in Business settings.",
    retryable: false
  },
  {
    name: "Meta missing permission (code 200)",
    provider: "meta_ads",
    error: apiError(400, metaBody(200)),
    code: "provider_auth_failed",
    message: "This token is missing an ads permission. Check its permissions in Business settings.",
    retryable: false
  },
  {
    name: "Meta throttle",
    provider: "meta_ads",
    error: new ConnectorError("provider_rate_limited", "Meta Ads provider rate limited; retry after the recorded cooldown", true),
    code: "connection_test_unavailable",
    message: "Meta is busy. Try again in a minute.",
    retryable: true
  }
];

describe("connectionTestFailure: founder-word copy for a refused or unchecked key", () => {
  it.each(table)("$name", ({ provider, error, code, message, retryable }) => {
    const mapped = connectionTestFailure(provider, error);
    expect(mapped).toBeInstanceOf(ConnectorError);
    expect(mapped).toMatchObject({ code, message, retryable });
  });

  it("never lets raw provider JSON reach the message", () => {
    for (const row of table) {
      const mapped = connectionTestFailure(row.provider, row.error) as Error;
      expect(mapped.message).not.toMatch(/[{}]/);
      expect(mapped.message).not.toMatch(/https?:\/\//);
    }
  });

  it("passes an unrecognised engine error through untouched (it is not a verdict on the key)", () => {
    const own = new ConnectorError("provider_auth_failed", "Shopify store domain must be a valid *.myshopify.com hostname", false);
    expect(connectionTestFailure("shopify", own)).toBe(own);
    const infra = new Error("connection terminated unexpectedly");
    expect(connectionTestFailure("stripe", infra)).toBe(infra);
  });

  it("names a timed-out check as unavailable, not refused", () => {
    expect(connectionTestTimedOut("posthog")).toMatchObject({
      code: "connection_test_unavailable",
      message: "Couldn't reach PostHog to check the key. Try again in a minute.",
      retryable: true
    });
  });
});
