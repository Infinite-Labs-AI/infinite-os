import { expect, it } from "vitest";
import { createInfiniteOsRegistry } from "./index.js";
it("advertises the creative fields needed by every public publishing transport", () => {
  const card = createInfiniteOsRegistry()
    .list()
    .find((card) => card.id === "create_meta_creative");
  const schema = card!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  expect(schema.required).not.toContain("clientToken"); // Shared cloud proposal catalog injects its token later.
  for (const key of [
    "imageUrl",
    "videoUrl",
    "assetFeedSpec",
    "degreesOfFreedomSpec",
    "urlTags",
    "clientToken",
    "launchId"
  ])
    expect(schema.properties).toHaveProperty(key);
});
