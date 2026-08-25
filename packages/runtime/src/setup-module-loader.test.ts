import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadSetupModule } from "./setup-module-loader.js";

describe("loadSetupModule", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("builds setup from source when raw ts uses .js specifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-setup-loader-"));
    tempRoots.push(root);

    mkdirSync(join(root, "packages/setup/src"), { recursive: true });
    mkdirSync(join(root, "apps/cli/src"), { recursive: true });
    writeFileSync(
      join(root, "packages/setup/tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            rootDir: ".",
            outDir: "dist",
            declaration: true
          },
          include: ["src/**/*.ts"]
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(join(root, "packages/setup/src/index.ts"), 'export * from "./ssrf.js";\n', "utf8");
    writeFileSync(
      join(root, "packages/setup/src/ssrf.ts"),
      'export const setupLoaderProbe = "source-fallback-ok";\n',
      "utf8"
    );
    writeFileSync(join(root, "apps/cli/src/index.ts"), "// caller\n", "utf8");

    const setup = await loadSetupModule(pathToFileURL(join(root, "apps/cli/src/index.ts")).href);
    expect((setup as { setupLoaderProbe?: string }).setupLoaderProbe).toBe("source-fallback-ok");
  });

  it("prefers built setup artifacts for built callers", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-setup-loader-"));
    tempRoots.push(root);

    mkdirSync(join(root, "packages/setup/dist/src"), { recursive: true });
    mkdirSync(join(root, "packages/setup/src"), { recursive: true });
    mkdirSync(join(root, "apps/cli/dist"), { recursive: true });
    writeFileSync(
      join(root, "packages/setup/dist/src/index.js"),
      'export const setupLoaderProbe = "dist-preferred";\n',
      "utf8"
    );
    writeFileSync(
      join(root, "packages/setup/src/index.ts"),
      'export const setupLoaderProbe = "source";\n',
      "utf8"
    );
    writeFileSync(join(root, "apps/cli/dist/index.js"), "// caller\n", "utf8");

    const setup = await loadSetupModule(pathToFileURL(join(root, "apps/cli/dist/index.js")).href);
    expect((setup as { setupLoaderProbe?: string }).setupLoaderProbe).toBe("dist-preferred");
  });

  it("repairs missing workspace package links before importing built setup providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-setup-loader-"));
    tempRoots.push(root);

    mkdirSync(join(root, "packages/setup/dist/src/providers"), { recursive: true });
    mkdirSync(join(root, "packages/connectors/dist"), { recursive: true });
    mkdirSync(join(root, "apps/cli/dist"), { recursive: true });

    writeFileSync(
      join(root, "packages/setup/package.json"),
      JSON.stringify(
        {
          name: "@infinite-os/setup",
          type: "module",
          exports: {
            ".": "./dist/src/index.js"
          },
          dependencies: {
            "@infinite-os/connectors": "workspace:*"
          }
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(
      join(root, "packages/connectors/package.json"),
      JSON.stringify(
        {
          name: "@infinite-os/connectors",
          type: "module",
          exports: {
            ".": "./dist/index.js"
          }
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(
      join(root, "packages/connectors/dist/index.js"),
      'export const connectorProbe = "workspace-link-ok";\n',
      "utf8"
    );
    writeFileSync(
      join(root, "packages/setup/dist/src/providers/ga4.js"),
      [
        'import { connectorProbe } from "@infinite-os/connectors";',
        "export async function readSetupInterviewFromRun() { return connectorProbe; }",
        "export async function runLiveSetupOnboarding() { return connectorProbe; }",
        "export async function resumeLiveSetupOnboarding() { return connectorProbe; }"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(root, "packages/setup/dist/src/index.js"),
      [
        'export {',
        "  readSetupInterviewFromRun,",
        "  runLiveSetupOnboarding,",
        "  resumeLiveSetupOnboarding",
        '} from "./providers/ga4.js";'
      ].join("\n"),
      "utf8"
    );
    writeFileSync(join(root, "apps/cli/dist/index.js"), "// caller\n", "utf8");

    await expect(loadSetupModule(pathToFileURL(join(root, "apps/cli/dist/index.js")).href)).resolves.toBeTruthy();
    expect(existsSync(join(root, "node_modules/@infinite-os/connectors"))).toBe(true);
  });
});
