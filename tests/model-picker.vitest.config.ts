import { defineConfig, mergeConfig } from "vitest/config";
import config from "../vitest.config.js";
export default mergeConfig(
  config,
  defineConfig({
    resolve: {
      alias: {
        "infinite-tag": new URL(
          "../packages/instrument/src/index.ts",
          import.meta.url
        ).pathname
      }
    }
  })
);
