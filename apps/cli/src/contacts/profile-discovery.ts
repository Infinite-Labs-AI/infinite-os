/**
 * PostgREST discovery + row reads for `infinite contacts sync`.
 *
 * The profiles-ish table is ENRICHMENT on top of auth.users: last seen, plan,
 * and location live there when the project has them. Discovery probes
 * `{SUPABASE_URL}/rest/v1/{table}?select={col}&limit=1` per candidate — never
 * `SELECT *` (trust rule 1) — and distinguishes a disabled Data API (404/406 on
 * EVERYTHING) from "no plan column found" so the absence message is the true
 * one (trust rule 7).
 *
 * Row reads happen ONLY after confirm 1 (trust rule 3): pre-consent, the whole
 * footprint is these limit-1 probes plus ONE sample row.
 */
import { ContactsSyncError } from "./sync-error.js";

export const PROFILE_TABLE_CANDIDATES = ["profiles", "users", "customers"] as const;
/** `user_id` first: when both exist, `id` is the table's own PK and `user_id` the auth FK. */
export const JOIN_KEY_CANDIDATES = ["user_id", "id"] as const;
export const LAST_SEEN_CANDIDATES = ["last_seen_at", "last_active_at"] as const;
export const PLAN_CANDIDATES = ["plan", "tier", "subscription_status"] as const;
export const COUNTRY_CANDIDATES = ["country"] as const;
export const CITY_CANDIDATES = ["city"] as const;

export interface ProfileDiscovery {
  /** Every probe answered 404/406 — the project's Data API is off. */
  dataApiOff: boolean;
  /** The Data API refused the service key (401/403) — fields skipped, honestly. */
  keyRejected: boolean;
  table?: string;
  joinKey?: string;
  lastSeenColumn?: string;
  planColumn?: string;
  countryColumn?: string;
  cityColumn?: string;
}

type ProbeVerdict = "yes" | "no_column" | "no_table" | "denied" | "error";

export interface ProfileHttpOptions {
  supabaseUrl: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

function restHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    accept: "application/json"
  };
}

function restBase(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
}

async function probeColumn(
  options: ProfileHttpOptions,
  table: string,
  column: string
): Promise<ProbeVerdict> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `${restBase(options.supabaseUrl)}/${encodeURIComponent(table)}?select=${encodeURIComponent(column)}&limit=1`,
      {
        method: "GET",
        headers: restHeaders(options.serviceKey),
        signal: AbortSignal.timeout(30_000)
      }
    );
  } catch {
    return "error";
  }
  if (response.ok) return "yes";
  if (response.status === 400) return "no_column";
  if (response.status === 404 || response.status === 406) return "no_table";
  if (response.status === 401 || response.status === 403) return "denied";
  return "error";
}

/**
 * Probe candidate tables (in order) for a join key to auth.users, then probe
 * the candidate data columns on the first joinable table. First `yes` wins per
 * category. Pass `tables` to probe a user-named table instead of the defaults.
 */
export async function discoverProfileTable(
  options: ProfileHttpOptions,
  tables: readonly string[] = PROFILE_TABLE_CANDIDATES
): Promise<ProfileDiscovery> {
  let sawApiOn = false;
  let sawDenied = false;
  let sawAnyProbe = false;

  const discovery: ProfileDiscovery = { dataApiOff: false, keyRejected: false };

  for (const table of tables) {
    let joinKey: string | undefined;
    let tableMissing = false;
    for (const candidate of JOIN_KEY_CANDIDATES) {
      sawAnyProbe = true;
      const verdict = await probeColumn(options, table, candidate);
      if (verdict === "yes") {
        sawApiOn = true;
        joinKey = candidate;
        break;
      }
      if (verdict === "no_column") {
        sawApiOn = true;
        continue;
      }
      if (verdict === "denied") {
        sawDenied = true;
        tableMissing = true;
        break;
      }
      // no_table / error: nothing else on this table will resolve either.
      tableMissing = true;
      break;
    }
    if (!joinKey) {
      if (tableMissing) continue;
      continue; // table exists but exposes no join key to auth.users — unusable
    }

    discovery.table = table;
    discovery.joinKey = joinKey;
    const firstHit = async (candidates: readonly string[]): Promise<string | undefined> => {
      for (const column of candidates) {
        if ((await probeColumn(options, table, column)) === "yes") return column;
      }
      return undefined;
    };
    discovery.lastSeenColumn = await firstHit(LAST_SEEN_CANDIDATES);
    discovery.planColumn = await firstHit(PLAN_CANDIDATES);
    discovery.countryColumn = await firstHit(COUNTRY_CANDIDATES);
    discovery.cityColumn = await firstHit(CITY_CANDIDATES);
    return discovery;
  }

  discovery.dataApiOff = sawAnyProbe && !sawApiOn && !sawDenied;
  discovery.keyRejected = !sawApiOn && sawDenied;
  return discovery;
}

/** Stringify a PostgREST cell for the wire: every cell a string, "" when absent. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function selectedColumns(discovery: ProfileDiscovery): string[] {
  const columns: string[] = [];
  for (const column of [
    discovery.lastSeenColumn,
    discovery.planColumn,
    discovery.countryColumn,
    discovery.cityColumn
  ]) {
    if (column) columns.push(column);
  }
  return columns;
}

/**
 * ONE masked-sample-row read (trust rule 3): the chosen columns for a single
 * named user. Returns undefined on any failure — the sample degrades, the
 * flow does not.
 */
export async function fetchSampleProfileRow(
  options: ProfileHttpOptions,
  discovery: ProfileDiscovery,
  joinValue: string
): Promise<Record<string, string> | undefined> {
  if (!discovery.table || !discovery.joinKey) return undefined;
  const columns = selectedColumns(discovery);
  if (columns.length === 0) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const select = columns.map((column) => encodeURIComponent(column)).join(",");
  try {
    const response = await fetchImpl(
      `${restBase(options.supabaseUrl)}/${encodeURIComponent(discovery.table)}` +
        `?select=${select}&${encodeURIComponent(discovery.joinKey)}=eq.${encodeURIComponent(joinValue)}&limit=1`,
      {
        method: "GET",
        headers: restHeaders(options.serviceKey),
        signal: AbortSignal.timeout(30_000)
      }
    );
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) return undefined;
    const row = payload[0];
    if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
    const record: Record<string, string> = {};
    for (const column of columns) {
      record[column] = cellText((row as Record<string, unknown>)[column]);
    }
    return record;
  } catch {
    return undefined;
  }
}

const ROWS_PAGE_SIZE = 1000;
const ROWS_MAX_PAGES = 100;

/**
 * Post-confirm-1 row read: ONLY the join key + the chosen columns (explicit
 * allowlist, never `SELECT *`), paged with a stable order. Returns rows keyed
 * by join value for the client-side join to auth.users.
 */
export async function fetchProfileRows(
  options: ProfileHttpOptions,
  discovery: ProfileDiscovery
): Promise<Map<string, Record<string, string>>> {
  const rows = new Map<string, Record<string, string>>();
  if (!discovery.table || !discovery.joinKey) return rows;
  const columns = selectedColumns(discovery);
  if (columns.length === 0) return rows;
  const fetchImpl = options.fetchImpl ?? fetch;
  const select = [discovery.joinKey, ...columns]
    .map((column) => encodeURIComponent(column))
    .join(",");

  for (let page = 0; page < ROWS_MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(
        `${restBase(options.supabaseUrl)}/${encodeURIComponent(discovery.table)}` +
          `?select=${select}&order=${encodeURIComponent(discovery.joinKey)}.asc` +
          `&limit=${ROWS_PAGE_SIZE}&offset=${page * ROWS_PAGE_SIZE}`,
        {
          method: "GET",
          headers: restHeaders(options.serviceKey),
          signal: AbortSignal.timeout(60_000)
        }
      );
    } catch {
      throw new ContactsSyncError(
        "profiles_read_failed",
        `Reading public.${discovery.table} failed part-way — check your connection and re-run.`
      );
    }
    if (!response.ok) {
      throw new ContactsSyncError(
        "profiles_read_failed",
        `Your project refused the public.${discovery.table} read (HTTP ${response.status}).`
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ContactsSyncError(
        "profiles_read_failed",
        `public.${discovery.table} answered with an unreadable body.`
      );
    }
    if (!Array.isArray(payload)) {
      throw new ContactsSyncError(
        "profiles_read_failed",
        `public.${discovery.table} answered with an unexpected shape.`
      );
    }
    for (const raw of payload) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const joinValue = cellText(record[discovery.joinKey]);
      if (!joinValue) continue;
      const row: Record<string, string> = {};
      for (const column of columns) row[column] = cellText(record[column]);
      rows.set(joinValue, row);
    }
    if (payload.length < ROWS_PAGE_SIZE) break;
  }
  return rows;
}
