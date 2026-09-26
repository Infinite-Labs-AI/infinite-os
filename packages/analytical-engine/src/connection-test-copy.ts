import { ConnectorError } from "@infinite-os/connectors";
import type { FirstPhaseProvider } from "@infinite-os/runtime";

// Founder-word copy for the connect-time key test (C12). connect_source / reconnect_source test a
// candidate credential BEFORE anything is written; when the provider refuses it, or the check can't
// run, the founder standing in front of the connect form gets ONE plain sentence, never the
// provider's raw JSON body. The error CODE carries the kind of failure so a client can branch
// without parsing words:
//
//   provider_auth_failed         the provider refused this credential (or it lacks a permission).
//                                Fix the credential; retrying it as-is never helps.
//   connection_details_rejected  the provider answered, but not for these details (a wrong project
//                                ID, property or store). Fix the details.
//   connection_test_unavailable  the check could not run right now (network, timeout, rate limit,
//                                provider outage). Nothing was saved; try again.
//
// Anything this module does not recognise is returned untouched: it is the engine's own message
// (already plain, e.g. "Shopify store domain must be a valid *.myshopify.com hostname") or an
// infrastructure failure, and neither is a verdict on the key. Renaming it here would hide a bug.

export const CONNECTION_TEST_UNAVAILABLE = "connection_test_unavailable";
export const CONNECTION_DETAILS_REJECTED = "connection_details_rejected";

interface ProviderWords {
  /** The name the founder knows the provider by. */
  name: string;
  /** What they pasted (or did): "key", "token", "sign-in". */
  credential: string;
  /** What the credential has to be able to read. */
  account: string;
  /** Which form fields to re-check when the provider rejects the details. */
  details: string;
}

const WORDS: Record<FirstPhaseProvider, ProviderWords> = {
  stripe: { name: "Stripe", credential: "key", account: "Stripe account", details: "key" },
  posthog: { name: "PostHog", credential: "key", account: "project", details: "project ID and host" },
  google_analytics_4: { name: "Google", credential: "sign-in", account: "property", details: "property ID" },
  shopify: { name: "Shopify", credential: "token", account: "store", details: "store domain" },
  meta_ads: { name: "Meta", credential: "token", account: "ad account", details: "ad account ID" },
  x: { name: "X", credential: "token", account: "account", details: "username" }
};

// The engine's `requireCredential` names the missing field by its payload key.
const FIELD_LABELS: Record<string, string> = {
  secretKey: "secret key",
  personalApiKey: "personal API key",
  projectId: "project ID",
  propertyId: "property ID",
  accessToken: "access token",
  storeDomain: "store domain",
  adminAccessToken: "Admin API access token",
  bearerToken: "bearer token",
  adAccountId: "ad account ID"
};

// connectors' fetchJson / Meta fetch write "provider <verdict> <status> for <url>[: <body>]".
const PROVIDER_HTTP_STATUS = /^provider (?:auth failed|rate limited|request failed) (\d{3}) for /;
// assertStripeKeyCoversSyncEndpoints: "Stripe restricted key is missing permission(s): A, B. Edit …".
const STRIPE_MISSING_PERMISSIONS = /^Stripe restricted key is missing permissions?: (.+?)\. Edit /;
const MISSING_FIELD = /^([A-Za-z]+) credential is required$/;
const OAUTH_SIGN_IN_GONE = /^oauth token .+ (?:is missing or revoked|has no usable access token)$/;
// Meta ships credential-grade rejections inside a 400 body; the codes match the engine's
// classifySyncFailure taxonomy (connectors: META_OAUTH_TERMINAL_BODY and friends).
const META_TOKEN_DEAD = /"code"\s*:\s*(190|102)\b/;
const META_CODE_100 = /"code"\s*:\s*100\b/;
const META_SUBCODE_33 = /"error_subcode"\s*:\s*33\b/;
const META_MISSING_PERMISSION = /"code"\s*:\s*(10|200|3|294|270)\b/;
// Untyped transport failures (undici, node:net) that mean "the provider was never reached".
const NETWORK_FAILURE = /fetch failed|socket hang up|\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b/;

/** The check could not run in time. Nothing was saved. */
export function connectionTestTimedOut(provider: FirstPhaseProvider): ConnectorError {
  return unreachable(provider);
}

/**
 * Map a failed connect-time key test to the error connect_source should throw: a typed
 * ConnectorError in founder words when the failure is recognised, else the original error.
 */
export function connectionTestFailure(provider: FirstPhaseProvider, error: unknown): unknown {
  const words = WORDS[provider];
  if (!(error instanceof Error)) {
    return error;
  }
  const typed = typedShape(error);
  if (!typed) {
    return isNetworkFailure(error) ? unreachable(provider, error) : error;
  }
  const message = typed.message;
  const status = httpStatus(error);

  if (typed.code === "provider_rate_limited" || status === 429) {
    return unavailable(`${words.name} is busy. Try again in a minute.`, error);
  }

  const stripeMissing = provider === "stripe" ? STRIPE_MISSING_PERMISSIONS.exec(message) : null;
  if (stripeMissing) {
    const permissions = stripeMissing[1].split(", ");
    return refused(
      `This key can't read ${humanList(permissions)}. Create a restricted key with ${permissions.length === 1 ? "it" : "them"}.`,
      error
    );
  }

  if (provider === "meta_ads" && status !== undefined) {
    if (META_TOKEN_DEAD.test(message)) {
      return refused("The token was refused or has expired. Paste a fresh one.", error);
    }
    if (META_CODE_100.test(message) && META_SUBCODE_33.test(message)) {
      return refused(
        "This token can't reach that ad account. Check the account is assigned to it in Business settings.",
        error
      );
    }
    if (META_MISSING_PERMISSION.test(message)) {
      return refused("This token is missing an ads permission. Check its permissions in Business settings.", error);
    }
  }

  if (status === 401) {
    return refused(
      provider === "google_analytics_4"
        ? "Google refused the sign-in. Sign in again."
        : `The ${words.credential} was refused. Check you copied all of it.`,
      error
    );
  }
  if (status === 403) {
    return refused(
      provider === "google_analytics_4"
        ? "This Google account can't read that property. Pick one it can read."
        : `This ${words.credential} can't read that ${words.account}. Check its permissions.`,
      error
    );
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return unavailable(`${words.name} had a problem checking the ${words.credential}. Try again in a minute.`, error);
  }
  if (status !== undefined && status >= 400) {
    return withCause(
      new ConnectorError(CONNECTION_DETAILS_REJECTED, `${words.name} didn't accept these details. Check the ${words.details}.`, false),
      error
    );
  }

  const missingField = MISSING_FIELD.exec(message);
  if (missingField) {
    const label = FIELD_LABELS[missingField[1]];
    return refused(label ? `Fill in the ${label} and try again.` : "Fill in every field and try again.", error);
  }
  if (OAUTH_SIGN_IN_GONE.test(message)) {
    return refused(`The ${words.name} sign-in has expired. Sign in again.`, error);
  }
  return error;
}

function refused(message: string, cause: unknown): ConnectorError {
  return withCause(new ConnectorError("provider_auth_failed", message, false), cause);
}

function unavailable(message: string, cause: unknown): ConnectorError {
  return withCause(new ConnectorError(CONNECTION_TEST_UNAVAILABLE, message, true), cause);
}

function unreachable(provider: FirstPhaseProvider, cause?: unknown): ConnectorError {
  const words = WORDS[provider];
  return unavailable(`Couldn't reach ${words.name} to check the ${words.credential}. Try again in a minute.`, cause);
}

// Keep the provider's own error (raw body included) on `cause` for in-process debugging; only the
// founder-facing `message` is rewritten. The daemon's error envelope never serialises `cause`.
function withCause(error: ConnectorError, cause: unknown): ConnectorError {
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", { value: cause, enumerable: false, configurable: true, writable: true });
  }
  return error;
}

// A typed engine error: ConnectorError, or any Error carrying the same { code, retryable } contract.
function typedShape(error: Error): { code: string; message: string } | null {
  const candidate = error as Error & { code?: unknown; retryable?: unknown };
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean"
    ? { code: candidate.code, message: error.message }
    : null;
}

function httpStatus(error: Error): number | undefined {
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") {
    return status;
  }
  const match = PROVIDER_HTTP_STATUS.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

function isNetworkFailure(error: Error): boolean {
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return NETWORK_FAILURE.test(error.message) || (typeof causeCode === "string" && NETWORK_FAILURE.test(causeCode));
}

function humanList(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
