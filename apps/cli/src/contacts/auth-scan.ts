/**
 * GoTrue admin discovery for `infinite contacts sync` — page `auth.users`
 * ENTIRELY locally (the customer's own Supabase, their own service key, this
 * machine) and run the exclusion pass.
 *
 * Trust rules in force here:
 *  - rule 1 (explicit allowlist): only the named fields of each user record
 *    are ever KEPT (id, email, created_at, last_sign_in_at, email_confirmed_at
 *    plus the exclusion inputs). Raw records are dropped on the spot and never
 *    surface in output or errors.
 *  - rule 8 (exclusion pass): soft-deleted, banned, and no-email users are
 *    dropped AND counted; unconfirmed emails are counted but KEPT.
 *  - unreadable pages are counted, never silently skipped — projects with
 *    hand-inserted auth rows can crash a naive `listUsers` scan page by page,
 *    and an undercount presented as complete is the failure mode to avoid.
 */
import { ContactsSyncError } from "./sync-error.js";

const DEFAULT_PER_PAGE = 1000;
const DEFAULT_MAX_PAGES = 1000;
/** With no total-count header, stop after this many CONSECUTIVE unreadable pages. */
const MAX_CONSECUTIVE_UNREADABLE_WITHOUT_TOTAL = 2;

/** One kept person, reduced to exactly the fields the manifest can use. */
export interface AuthPerson {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string;
  emailConfirmed: boolean;
}

export interface ExclusionReport {
  kept: AuthPerson[];
  droppedDeleted: number;
  droppedBanned: number;
  droppedNoEmail: number;
  /** Unconfirmed emails are KEPT — this count is printed as its own line. */
  unconfirmedKept: number;
}

export interface AuthScanResult extends ExclusionReport {
  /** Raw user records returned by GoTrue across all readable pages. */
  totalListed: number;
  /** Pages that errored (HTTP failure, network failure, or unparseable body). */
  unreadablePages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * The exclusion pass (trust rule 8), pure so it is directly testable:
 * drop + count soft-deleted (`deleted_at` set), banned (`banned_until` in the
 * future), and no-email users; count-but-keep unconfirmed emails
 * (`email_confirmed_at` null). Check order matters for honest counts — a
 * deleted user with no email counts once, as deleted.
 */
export function applyExclusionPass(rawUsers: unknown[], now: Date = new Date()): ExclusionReport {
  const report: ExclusionReport = {
    kept: [],
    droppedDeleted: 0,
    droppedBanned: 0,
    droppedNoEmail: 0,
    unconfirmedKept: 0
  };
  for (const raw of rawUsers) {
    if (!isRecord(raw)) continue;
    const deletedAt = stringField(raw, "deleted_at");
    if (deletedAt) {
      report.droppedDeleted += 1;
      continue;
    }
    const bannedUntil = stringField(raw, "banned_until");
    if (bannedUntil) {
      const until = Date.parse(bannedUntil);
      if (Number.isFinite(until) && until > now.getTime()) {
        report.droppedBanned += 1;
        continue;
      }
    }
    const email = stringField(raw, "email").trim();
    if (!email) {
      report.droppedNoEmail += 1;
      continue;
    }
    const emailConfirmed = Boolean(stringField(raw, "email_confirmed_at"));
    if (!emailConfirmed) report.unconfirmedKept += 1;
    report.kept.push({
      id: stringField(raw, "id"),
      email,
      createdAt: stringField(raw, "created_at"),
      lastSignInAt: stringField(raw, "last_sign_in_at"),
      emailConfirmed
    });
  }
  return report;
}

export interface AuthScanOptions {
  supabaseUrl: string;
  /** Stays in these request headers and nowhere else — never in errors or output. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
  perPage?: number;
  maxPages?: number;
  now?: Date;
}

/**
 * Page `GET {SUPABASE_URL}/auth/v1/admin/users?page=N&per_page=…` with
 * apikey + Authorization headers. Per-page errors are tolerated and COUNTED
 * (`unreadablePages`); the caller reports "N pages unreadable" rather than a
 * silent undercount. A rejected key on the first page throws — that is a
 * whole-scan failure, not a page hiccup.
 */
export async function scanAuthUsers(options: AuthScanOptions): Promise<AuthScanResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const now = options.now ?? new Date();
  const base = options.supabaseUrl.replace(/\/+$/, "");

  const rawUsers: unknown[] = [];
  let unreadablePages = 0;
  let consecutiveUnreadable = 0;
  let totalPages: number | undefined;

  for (let page = 1; page <= maxPages; page += 1) {
    let response: Response | undefined;
    try {
      response = await fetchImpl(
        `${base}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
        {
          method: "GET",
          headers: {
            apikey: options.serviceKey,
            authorization: `Bearer ${options.serviceKey}`,
            accept: "application/json"
          },
          signal: AbortSignal.timeout(30_000)
        }
      );
    } catch {
      response = undefined;
    }

    if (response && (response.status === 401 || response.status === 403) && page === 1) {
      throw new ContactsSyncError(
        "auth_admin_rejected",
        "Your Supabase project refused the service role key for the auth admin API. " +
          "Check that the key in your env file is the service_role key (not the anon key)."
      );
    }

    let pageUsers: unknown[] | undefined;
    if (response?.ok) {
      try {
        const payload: unknown = await response.json();
        if (Array.isArray(payload)) {
          pageUsers = payload;
        } else if (isRecord(payload) && Array.isArray(payload.users)) {
          pageUsers = payload.users;
        }
      } catch {
        pageUsers = undefined;
      }
    }

    if (totalPages === undefined && response) {
      const totalHeader = response.headers.get("x-total-count");
      if (totalHeader && /^\d+$/.test(totalHeader)) {
        totalPages = Math.max(1, Math.ceil(Number(totalHeader) / perPage));
      }
    }

    if (pageUsers === undefined) {
      unreadablePages += 1;
      consecutiveUnreadable += 1;
      if (totalPages !== undefined) {
        if (page >= totalPages) break;
        continue;
      }
      // No total to walk toward: stop after a bounded run of dead pages so a
      // fully broken admin API cannot loop forever. The count is reported.
      if (consecutiveUnreadable >= MAX_CONSECUTIVE_UNREADABLE_WITHOUT_TOTAL) break;
      continue;
    }

    consecutiveUnreadable = 0;
    rawUsers.push(...pageUsers);
    if (totalPages !== undefined) {
      if (page >= totalPages) break;
    } else if (pageUsers.length < perPage) {
      break;
    }
  }

  const exclusion = applyExclusionPass(rawUsers, now);
  return {
    ...exclusion,
    totalListed: rawUsers.length,
    unreadablePages
  };
}
