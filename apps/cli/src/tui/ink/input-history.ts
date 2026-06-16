import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { infiniteOsHome } from "@infinite-os/config";

const INPUT_HISTORY_LIMIT = 1000;
const INPUT_HISTORY_FILE = "input-history";

export function inputHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(infiniteOsHome(env), INPUT_HISTORY_FILE);
}

export function loadPersistentInputHistory(
  env: NodeJS.ProcessEnv = process.env,
  limit = INPUT_HISTORY_LIMIT
): string[] {
  const path = inputHistoryPath(env);
  try {
    if (!existsSync(path)) {
      return [];
    }
    return parsePersistentInputHistory(readFileSync(path, "utf8")).slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

export function appendPersistentInputHistory(
  line: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const existing = loadPersistentInputHistory(env);
  if (existing.at(-1) === trimmed) {
    return;
  }

  try {
    const path = inputHistoryPath(env);
    mkdirSync(infiniteOsHome(env), { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const encoded = trimmed
      .split("\n")
      .map((part) => `+${part}`)
      .join("\n");
    appendFileSync(path, `\n# ${timestamp}\n${encoded}\n`, { mode: 0o600 });
  } catch {
    // Input history is convenience state; never break the interactive shell for it.
  }
}

export function parsePersistentInputHistory(raw: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];

  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("+")) {
      current.push(line.slice(1));
    } else if (current.length) {
      entries.push(current.join("\n"));
      current = [];
    }
  }

  if (current.length) {
    entries.push(current.join("\n"));
  }

  return entries;
}
