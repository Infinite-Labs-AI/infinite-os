// Four neutral sample turns for the one-column chat work (2026-10-15): a plain
// text answer, an ads answer with a card, a funnel answer and a multi-step job.
// Same shape as the r4 screen fixtures (`R4ScreenFixture`), so `renderR4Screen`
// replays them through the REAL interactive session, at any width. They live
// in their own folder so the r4 golden test (which walks `__fixtures__/r4/`)
// never treats them as r4 screens. The data is sample data.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { R4ScreenFixture } from "./fixtures.js";

export const ONE_COLUMN_FIXTURES_DIR = fileURLToPath(new URL("../../views/__fixtures__/one-column/", import.meta.url));

/** The wall clock the sample turns are drawn at (the job started a minute before). */
export const ONE_COLUMN_CLOCK = Date.parse("2026-10-15T10:00:00Z");

export function oneColumnFixtureIds(): string[] {
  return readdirSync(ONE_COLUMN_FIXTURES_DIR).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort();
}

export function loadOneColumnFixture(screen: string): R4ScreenFixture {
  return JSON.parse(readFileSync(`${ONE_COLUMN_FIXTURES_DIR}${screen}.json`, "utf8")) as R4ScreenFixture;
}
