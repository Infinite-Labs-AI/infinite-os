import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export const infiniteOsVersion = "0.1.0";

export const JOURNEY_ENTITY_TYPES = [
  "campaign",
  "content_item",
  "event_item",
  "channel",
  "page",
  "product",
  "behavior"
] as const;

export type JourneyEntityType = (typeof JOURNEY_ENTITY_TYPES)[number];

// resolve_entity can name finer Meta grains (adset/ad) that journeys deliberately CANNOT.
// Derived FROM JOURNEY_ENTITY_TYPES so the journey vocabulary stays a strict subset: the
// journey-plan schema + assertAllowedJourneyEntityTypes keep reading JOURNEY_ENTITY_TYPES and
// thus keep REJECTING adset/ad, while only resolve_entity widens to this superset. (Slice 1b §7.)
export const RESOLVABLE_ENTITY_TYPES = [
  ...JOURNEY_ENTITY_TYPES,
  "adset",
  "ad"
] as const;

export type ResolvableEntityType = (typeof RESOLVABLE_ENTITY_TYPES)[number];

const CREDENTIAL_ENVELOPE_PREFIX = "growth-os:v1:";

export const KNOWN_DEFAULT_ENCRYPTION_KEYS = new Set([
  "change-me-32-byte-minimum-key",
  "dev-change-me-32-byte-minimum-key"
]);

export function encryptCredentialPayload(payload: unknown, encryptionKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(encryptionKey), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CREDENTIAL_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify({
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    })
  ).toString("base64")}`;
}

/**
 * Thrown when a stored credential cannot be decrypted with the configured encryption key — i.e. the
 * AES-256-GCM auth tag fails to verify (Node's raw error is the opaque "Unsupported state or unable
 * to authenticate data"). This almost always means `GROWTH_OS_ENCRYPTION_KEY` differs from the key
 * the credential was encrypted with (the key was rotated, or a different `.growth-os/.env` is in
 * effect than the one used at connect time). It is NOT a transient/provider error: retrying never
 * helps — the credential must be re-stored under the current key (reconnect the source). Callers map
 * this to a typed, non-retryable failure so it surfaces as actionable instead of an opaque crash.
 */
export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

export function decryptCredentialPayload<T = Record<string, unknown>>(
  encryptedPayload: string,
  encryptionKey: string
): T {
  if (!encryptedPayload.startsWith(CREDENTIAL_ENVELOPE_PREFIX)) {
    throw new Error("credential payload is not a Infinite OS encrypted envelope");
  }
  const envelope = JSON.parse(
    Buffer.from(encryptedPayload.slice(CREDENTIAL_ENVELOPE_PREFIX.length), "base64").toString("utf8")
  ) as { alg: string; iv: string; tag: string; ciphertext: string };
  if (envelope.alg !== "aes-256-gcm") {
    throw new Error(`unsupported credential envelope algorithm: ${envelope.alg}`);
  }
  // keyBytes() is OUTSIDE the try so its specific "key not configured / is a default" errors keep
  // propagating as-is; only an actual decrypt (auth-tag) failure becomes a CredentialDecryptError.
  const key = keyBytes(encryptionKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    // Any failure past keyBytes() — an auth-tag mismatch (the common case: a different
    // GROWTH_OS_ENCRYPTION_KEY than the one used to encrypt) or a corrupt/garbled envelope — means
    // this stored credential can't be recovered with the current config. Both resolve the same way.
    throw new CredentialDecryptError(
      "credential could not be decrypted: the configured encryption key does not match the key it " +
        "was encrypted with (or the stored payload is corrupt) — reconnect this source to re-store " +
        "the credential under the current key"
    );
  }
}

export function isEncryptedCredentialPayload(value: string): boolean {
  return value.startsWith(CREDENTIAL_ENVELOPE_PREFIX);
}

function keyBytes(encryptionKey: string): Buffer {
  if (!encryptionKey || encryptionKey.length < 16) {
    throw new Error("GROWTH_OS_ENCRYPTION_KEY must be configured before storing credentials");
  }
  if (KNOWN_DEFAULT_ENCRYPTION_KEYS.has(encryptionKey)) {
    throw new Error(
      "GROWTH_OS_ENCRYPTION_KEY is set to a known default — generate a random key before storing credentials"
    );
  }
  return createHash("sha256").update(encryptionKey).digest();
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

// Domain-separation label for the convergence keyId. A FIXED public label is
// domain separation, not entropy — it makes the fingerprint reproducible across
// installs that share the secret (so convergence comparison works) while keeping
// it non-invertible without the secret (HMAC keyed BY the secret).
const KEY_ID_LABEL = "infinite-os/keyId/v1";

// Bytes of the truncated keyId, 12 bytes = 96 bits = 24 hex chars. Enough to make
// collisions across distinct keys negligible while keeping the published surface small.
const KEY_ID_HEX_LENGTH = 24;

/**
 * Non-secret convergence fingerprint of the encryption key, published in /health
 * and the daemon descriptor so a CLI can ASSERT it shares the desktop's key before
 * trusting credentials encrypted under it.
 *
 * SECURITY (verified — see daemon-discovery-design §10): this MUST be an HMAC keyed
 * BY the secret under a fixed public label, NOT a bare hash of the secret. The live
 * AES-256-GCM key IS `createHash("sha256").update(encryptionKey).digest()` (keyBytes
 * above), so publishing `sha256(key)` would publish the literal decryption key. The
 * HMAC construction is non-invertible without the key, yet deterministic for the same
 * key — exactly the convergence property. Truncated to 96 bits.
 */
export function encryptionKeyFingerprint(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey)
    .update(KEY_ID_LABEL)
    .digest("hex")
    .slice(0, KEY_ID_HEX_LENGTH);
}

export interface RefreshOAuthTokenInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export interface RefreshedOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/**
 * Exchange an OAuth refresh token for a fresh access token at the provider's token
 * endpoint. Provider-generic: the caller supplies the token URL (Google, etc.) and the
 * app credentials. Returns null when the exchange cannot be performed or the provider
 * rejects it, so callers can fall back without throwing.
 */
export async function refreshOAuthToken(
  input: RefreshOAuthTokenInput
): Promise<RefreshedOAuthToken | null> {
  if (!input.tokenUrl || !input.clientId || !input.clientSecret || !input.refreshToken) {
    return null;
  }
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret
    }).toString()
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return null;
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
  if (!accessToken) {
    return null;
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  const rotatedRefreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token
      ? payload.refresh_token
      : input.refreshToken;
  return { accessToken, refreshToken: rotatedRefreshToken, expiresAt };
}
