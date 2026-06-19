import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@infinite-os/analytical-engine": new URL(
        "./packages/analytical-engine/src/index.ts",
        import.meta.url
      ).pathname,
      "@infinite-os/config": new URL("./packages/config/src/index.ts", import.meta.url)
        .pathname,
      "@infinite-os/connectors": new URL(
        "./packages/connectors/src/index.ts",
        import.meta.url
      ).pathname,
      "@infinite-os/core": new URL("./packages/core/src/index.ts", import.meta.url)
        .pathname,
      "@infinite-os/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      "@infinite-os/llm-controller": new URL(
        "./packages/llm-controller/src/index.ts",
        import.meta.url
      ).pathname,
      "@infinite-os/metadata": new URL(
        "./packages/metadata/src/index.ts",
        import.meta.url
      ).pathname,
      "@infinite-os/runtime": new URL(
        "./packages/runtime/src/index.ts",
        import.meta.url
      ).pathname,
      "@infinite-os/types": new URL(
        "./packages/types/src/index.ts",
        import.meta.url
      ).pathname
    }
  },
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"]
  }
});
