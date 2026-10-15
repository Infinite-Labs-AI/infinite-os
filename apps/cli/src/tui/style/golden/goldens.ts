// Loads the synthetic r4 goldens copied into `__goldens__/` (never the product
// goldens: infinite-os is public). Regenerate the copy with the private
// `spec/terminal/tools/export-synthetic-goldens.mjs <this worktree>`.
//
// The one-column default (River, 2026-10-15, V1) re-drew every frame golden
// whose screen it changed from the CLI's own one-column renderer, the approved
// design since (`drawn_by` on the file): r4 draws only the two-column layout,
// which is now drawn on request. A re-export from r4 must keep those frames.
// Re-draw them from this repo when the CLI's drawing changes on purpose:
//   pnpm exec tsx --tsconfig tests/model-picker.tsconfig.json apps/cli/scripts/redraw-goldens.mts <id>... [--write]
// (`--drawn` takes every drawn_by frame). What r4 draws there that the CLI does
// not yet (the T12 app links and follow-up keys) is kept in `known-gaps.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { GoldenFile } from "./compare.js";

export const GOLDENS_DIR = fileURLToPath(new URL("./__goldens__/", import.meta.url));

/** Files in `__goldens__/` that are not goldens. */
const NOT_GOLDENS = new Set(["index.json", "palette.json", "expected-fail.json"]);

export function goldenIds(): string[] {
  return readdirSync(GOLDENS_DIR)
    .filter((file) => file.endsWith(".json") && !NOT_GOLDENS.has(file))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

export function loadGolden(id: string): GoldenFile {
  return JSON.parse(readFileSync(`${GOLDENS_DIR}${id}.json`, "utf8")) as GoldenFile;
}

/** `view-06-change--c100` → `{ screen: "view-06-change", cols: 100 }`; a region or other id keeps its golden cols. */
export function screenOf(id: string, golden: GoldenFile): { screen: string; cols: number } {
  const match = /^(.*)--c(\d+)$/u.exec(id);
  return match ? { screen: match[1]!, cols: Number(match[2]) } : { screen: id, cols: golden.cols };
}
