/**
 * Supabase env detection for `infinite contacts sync` (design:
 * docs/superpowers/specs/2026-08-30-contacts-cli-sync-design.md).
 *
 * The command runs in the customer's OWN repo, where their Supabase URL and
 * service role key already live in `.env.local` / `.env`. Trust rule 2: the
 * service key is read here, used against THEIR Supabase from THIS machine, and
 * never sent to the bridge, the desktop, or our API — the bridge carries rows,
 * not keys. Nothing in this module ever puts the key into a printable string.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Files checked, in precedence order — `.env.local` wins per variable. */
export const ENV_FILE_NAMES = [".env.local", ".env"] as const;

/** Accepted spellings for the Supabase project URL. */
export const SUPABASE_URL_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const;

/** Accepted spellings for the service role key. */
export const SUPABASE_SERVICE_KEY_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY"
] as const;

export interface SupabaseEnvDetection {
  /** The project URL, trailing slash stripped. */
  url: string;
  /** The service role key — NEVER print, log, or transmit over the bridge. */
  serviceKey: string;
  /** Which accepted spelling supplied the URL (safe to print). */
  urlVariable: string;
  /** Which accepted spelling supplied the key (the NAME only — safe to print). */
  serviceKeyVariable: string;
  /** The env file that supplied the URL (e.g. ".env.local"). */
  sourceFile: string;
  /** Every file name attempted, in order (whether or not it existed). */
  checkedFiles: string[];
}

export type SupabaseEnvResult =
  | { ok: true; env: SupabaseEnvDetection }
  | { ok: false; checkedFiles: string[] };

/**
 * Parse one dotenv-style file body. Deliberately minimal: `KEY=VALUE` lines,
 * optional `export ` prefix, surrounding single/double quotes stripped,
 * `#`-comment and blank lines ignored. No interpolation — a service key is a
 * literal, and guessing at substitution risks mangling it.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

type FileReader = (path: string) => string | undefined;

function defaultFileReader(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Detect `SUPABASE_URL` (or its NEXT_PUBLIC alias) + the service role key in
 * the working directory's `.env.local` then `.env`. Per-variable precedence:
 * a value in `.env.local` beats the same variable in `.env`; the two variables
 * may come from different files. Absence reports which files were checked so
 * the miss message can be honest.
 */
export function detectSupabaseEnv(
  cwd: string,
  readFile: FileReader = defaultFileReader
): SupabaseEnvResult {
  const checkedFiles = [...ENV_FILE_NAMES];
  const parsedByFile: Array<{ file: string; values: Record<string, string> }> = [];
  for (const file of ENV_FILE_NAMES) {
    const content = readFile(join(cwd, file));
    if (content !== undefined) parsedByFile.push({ file, values: parseEnvFile(content) });
  }

  const find = (
    keys: readonly string[]
  ): { value: string; variable: string; file: string } | undefined => {
    for (const { file, values } of parsedByFile) {
      for (const key of keys) {
        const value = values[key]?.trim();
        if (value) return { value, variable: key, file };
      }
    }
    return undefined;
  };

  const url = find(SUPABASE_URL_KEYS);
  const serviceKey = find(SUPABASE_SERVICE_KEY_KEYS);
  if (!url || !serviceKey) {
    return { ok: false, checkedFiles };
  }
  return {
    ok: true,
    env: {
      url: url.value.replace(/\/+$/, ""),
      serviceKey: serviceKey.value,
      urlVariable: url.variable,
      serviceKeyVariable: serviceKey.variable,
      sourceFile: url.file,
      checkedFiles
    }
  };
}

/** The bare host of the Supabase URL — the only part of the URL trust rule 9 prints. */
export function supabaseHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** True when the URL points at a local/loopback address — a staging/dev tell. */
export function isLocalSupabaseUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
