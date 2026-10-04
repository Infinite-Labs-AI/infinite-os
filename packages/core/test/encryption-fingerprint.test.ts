import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { encryptionKeyFingerprint } from "../src/index.js";

// A realistic (non-default, >=16 char) key. `keyBytes()` in src/index.ts derives the
// live AES-256-GCM key as `createHash("sha256").update(key).digest()`, so the
// fingerprint MUST NOT equal that value or its hex — doing so would publish the
// literal decryption key on the unauthenticated /health endpoint (design §10).
const KEY = "0a9ef53c-not-the-default-encryption-key-32+chars";
const OTHER_KEY = "fc4c1ada-a-completely-different-encryption-key!!";

describe("encryptionKeyFingerprint", () => {
  it("is NOT the literal AES key — never sha256(key) bytes-as-hex (the keyBytes trap)", () => {
    const liveAesKeyHex = createHash("sha256").update(KEY).digest("hex");
    expect(encryptionKeyFingerprint(KEY)).not.toBe(liveAesKeyHex);
    // Also reject the truncated form of that same hash — slicing the unsafe value
    // would still be a prefix of the decryption key.
    expect(encryptionKeyFingerprint(KEY)).not.toBe(liveAesKeyHex.slice(0, 24));
  });

  it("is NOT a bare sha256(key) under any hash flavor", () => {
    expect(encryptionKeyFingerprint(KEY)).not.toBe(createHash("sha256").update(KEY).digest("hex"));
    expect(encryptionKeyFingerprint(KEY)).not.toBe(createHash("sha512").update(KEY).digest("hex"));
  });

  it("equals the domain-separated HMAC keyed BY the secret, truncated to 12 bytes", () => {
    const expected = createHmac("sha256", KEY).update("infinite-os/keyId/v1").digest("hex").slice(0, 24);
    expect(encryptionKeyFingerprint(KEY)).toBe(expected);
    expect(encryptionKeyFingerprint(KEY)).toHaveLength(24);
  });

  it("is deterministic for the same key (convergence across installs)", () => {
    expect(encryptionKeyFingerprint(KEY)).toBe(encryptionKeyFingerprint(KEY));
  });

  it("differs for different keys (detects the silent-orphan key-drift case)", () => {
    expect(encryptionKeyFingerprint(KEY)).not.toBe(encryptionKeyFingerprint(OTHER_KEY));
  });
});
