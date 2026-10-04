// Live run 3 (2026-10-03, smoke site shop.examplebrand.com) as an offline fixture (DECISIONS §10).
// `site-6d16d8f/` is the site before the run (the contractor's duplicate GA4 + the agency's Meta TEST pixel);
// `install-f1abea9/` holds the files the wizard's install wrote; `edit.json` is Claude Code's exact jobs-turn
// edit; `wizard/*.json` are the run's own wizard files (home paths scrubbed; every id in them is public).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const RUN3_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "run3")

export function run3File(rel: string): string {
  return readFileSync(join(RUN3_DIR, rel), "utf8")
}

export function run3Json<T = unknown>(rel: string): T {
  return JSON.parse(run3File(rel)) as T
}

/** `app/layout.tsx` after the install (the tree the jobs turn started from). */
export const run3InstalledLayout = (): string => run3File("install-f1abea9/app/layout.tsx")

/** Claude Code's one Edit of the jobs turn: dedupe + the GA4 guard + the Meta guard. */
export function run3EditedLayout(): string {
  const edit = run3Json<{ old_string: string; new_string: string }>("edit.json")
  const before = run3InstalledLayout()
  if (!before.includes(edit.old_string)) throw new Error("run-3 fixture: the edit's old_string is not in the installed layout")
  return before.replace(edit.old_string, edit.new_string)
}
