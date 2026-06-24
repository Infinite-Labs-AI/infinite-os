import { describe, expect, it } from "vitest";

import {
  CredentialDecryptError,
  decryptCredentialPayload,
  encryptCredentialPayload
} from "../src/index.js";

// Realistic, non-default keys (>=16 chars). Values are illustrative test strings only.
const KEY_A = "key-a-not-a-default-encryption-key-aaaaaaaa";
const KEY_B = "key-b-completely-different-encryption-key-bb";

describe("decryptCredentialPayload — key mismatch handling", () => {
  it("round-trips when the same key is used", () => {
    const blob = encryptCredentialPayload({ token: "abc", n: 1 }, KEY_A);
    expect(decryptCredentialPayload(blob, KEY_A)).toEqual({ token: "abc", n: 1 });
  });

  it("throws a TYPED CredentialDecryptError (not the opaque node crypto error) on a wrong key", () => {
    const blob = encryptCredentialPayload({ token: "abc" }, KEY_A);
    let caught: unknown;
    try {
      decryptCredentialPayload(blob, KEY_B);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CredentialDecryptError);
    expect((caught as Error).name).toBe("CredentialDecryptError");
    // actionable message; must NOT surface the raw "Unsupported state or unable to authenticate data"
    expect((caught as Error).message).toMatch(/reconnect this source/);
    expect((caught as Error).message).not.toMatch(/Unsupported state/);
  });
});
