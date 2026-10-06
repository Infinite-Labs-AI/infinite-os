import { afterEach, expect, it, vi } from "vitest";
import type { InfiniteOsDb } from "@infinite-os/db";
vi.mock("@infinite-os/analytical-engine", async (original) => ({
  ...(await original<typeof import("@infinite-os/analytical-engine")>()),
  createActionHandlers: () => ({
    create_meta_ad: async () => {
      throw Object.assign(new Error("Meta refused"), {
        code: "meta_provider_rejection",
        retryable: false,
        metaWrite: {
          version: 1,
          phase: "provider_response",
          outcome: "refused",
          providerCode: 100,
          metaMessage: "Readable provider reason",
          privateValue: "do-not-return"
        }
      });
    }
  })
}));
import { createApp } from "../src/index.js";
afterEach(() => vi.unstubAllEnvs());
it("retains bounded write phase and provider words over the local HTTP API", async () => {
  vi.stubEnv("GROWTH_OS_OPERATOR_TOKEN", "operator-test");
  const db = {
    one: async () => ({ exists: 1 }),
    query: async () => []
  } as unknown as InfiniteOsDb;
  const app = createApp({ database: db });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/tools/call",
      headers: {
        authorization: "Bearer operator-test",
        "x-growth-os-workspace": "workspace-test"
      },
      payload: {
        actionId: "create_meta_ad",
        input: {
          adsetId: "123",
          creativeId: "456",
          name: "fixture",
          clientToken: "test-attempt"
        }
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "meta_provider_rejection",
      retryable: false,
      metaMessage: "Readable provider reason",
      metaWrite: {
        phase: "provider_response",
        outcome: "refused",
        providerCode: 100
      }
    });
    expect(response.body).not.toContain("do-not-return");
  } finally {
    await app.close();
  }
});
