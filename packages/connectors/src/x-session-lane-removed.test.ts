import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: the X session-cookie ("burner account") scraping lane was RETIRED 2026-08-24.
// X reads/posts flow through the server-side SocialData proxy on the shared account;
// the engine keeps ONLY the X API v2 bearer-token lane. This test greps the tree so the
// lane cannot quietly grow back: no twitter-cli spawn, no auth_token/ct0 cookie handling,
// no X_SESSION_BACKEND_ENABLED kill-switch, no "burner X account" reconnect copy.
const FORBIDDEN_TOKENS = [
  "burner X account",
  "refreshXSessionCt0",
  "X_SESSION_BACKEND_ENABLED",
  "x_session_cookies",
  "runTwitterCli",
  "twitterCliChildEnv",
  "scrubTwitterCliError",
  "reconcileErroredXSessionSources",
  "search_x_session",
  "searchXSessionSource"
] as const;

const GUARD_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(GUARD_FILE, "../../../..");
const SCAN_ROOTS = ["packages", "apps"].map((dir) => join(REPO_ROOT, dir));
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "fixtures"]);
const SCAN_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(fullPath));
      continue;
    }
    if (SCAN_EXTENSIONS.some((extension) => entry.endsWith(extension)) && fullPath !== GUARD_FILE) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("X session-cookie lane stays removed", () => {
  it("no packages/apps source file mentions the retired session-cookie lane", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(root)) {
        const content = readFileSync(file, "utf8");
        for (const token of FORBIDDEN_TOKENS) {
          if (content.includes(token)) {
            offenders.push(`${file.slice(REPO_ROOT.length + 1)} contains "${token}"`);
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
