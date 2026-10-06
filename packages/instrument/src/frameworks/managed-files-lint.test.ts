import { createRequire } from "node:module"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import ts from "typescript"

import type { InstallPlan } from "../types.js"
import { vercelLaneModuleSource, vercelMiddlewareSource } from "../server-lane/targets/vercel-any.js"
import { buildCreatedMiddlewareSource, buildServerLaneModuleSource } from "../server-lane/runtime-source.js"
import { buildAnalyticsModuleSource, buildClientComponentSource } from "./managed-files.js"

const require = createRequire(import.meta.url)
const { LegacyESLint } = require("eslint/use-at-your-own-risk") as {
  LegacyESLint: new (options: object) => { lintText(source: string, options: { filePath: string }): Promise<Array<{ messages: Array<{ ruleId: string | null; message: string; line: number }> }>> }
}

describe("the Next files the installer writes", () => {
  it("pass Next core-web-vitals and both unused-variable rules as emitted", async () => {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
    const lint = new LegacyESLint({
      cwd: packageRoot,
      useEslintrc: false,
      overrideConfig: {
        extends: ["next/core-web-vitals"],
        plugins: ["@typescript-eslint"],
        rules: { "no-unused-vars": "error", "@typescript-eslint/no-unused-vars": "error" }
      },
      resolvePluginsRelativeTo: packageRoot,
      ignore: false
    })
    const module = buildAnalyticsModuleSource({ instructions: [{ path: "lib/infinite-analytics.ts", action: "create", helpers: true, description: "helpers", snippet: "window.infiniteTrack = function () { return true; }" }] } as InstallPlan)
    const emitted = [
      ["lib/infinite-analytics.ts", module],
      ["lib/infinite-analytics-client.tsx", buildClientComponentSource()],
      ["lib/infinite-server-lane.ts", vercelLaneModuleSource({ productionHosts: ["example.com"] })],
      ["middleware.ts", vercelMiddlewareSource({ productionHosts: ["example.com"] })],
      ["lib/infinite-server-lane-next.ts", buildServerLaneModuleSource()],
      ["middleware.ts", buildCreatedMiddlewareSource({ moduleImportPath: "./lib/infinite-server-lane" })]
    ] as const
    for (const [file, source] of emitted) {
      const results = await lint.lintText(source, { filePath: join(packageRoot, file) })
      expect(results.flatMap((result) => result.messages.map((message) => `${file}:${message.line} ${message.ruleId}: ${message.message}`))).toEqual([])
    }
    const dir = mkdtempSync(join(tmpdir(), "infinite-emitted-typecheck-"))
    try {
      const path = join(dir, "infinite-analytics.ts")
      writeFileSync(path, module)
      const program = ts.createProgram([path], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], skipLibCheck: true })
      expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
