/**
 * `infinite contacts sync` — the CLI flow (design:
 * docs/superpowers/specs/2026-08-30-contacts-cli-sync-design.md, Phase 2).
 *
 * One pasted command, run in the customer's own repo, connects their existing
 * users to the email brain with explicit field-level consent. The customer's
 * database credentials never leave this machine; the rows reach the workspace
 * through the desktop app's `contacts.import.v1` bridge verb — the desktop is
 * the one holding a cloud session, the CLI never does.
 *
 * Two decision points, exactly: (1) the field manifest + count + destination
 * workspace, (2) the dry-run report. Everything between them is deterministic.
 * NOTHING crosses the bridge before confirm 1's yes (the status.v1 ping that
 * names the workspace carries no contact data); the commit carries the opaque
 * `workspacePin` from the dry-run response so a mid-flow workspace switch
 * refuses with 409 `workspace_changed` instead of importing into the wrong
 * place.
 *
 * All I/O is injected so the two-confirm state machine is testable without a
 * TTY, a Supabase, or a desktop.
 */
import type { DesktopBridgeDescriptor, DesktopStatus } from "../desktop-app-client.js";
import { scanAuthUsers, type AuthScanResult } from "./auth-scan.js";
import {
  detectSupabaseEnv,
  isLocalSupabaseUrl,
  supabaseHost,
  type SupabaseEnvResult
} from "./env-detect.js";
import {
  CONTACTS_IMPORT_CAPABILITY,
  describeImportFailure,
  type BridgeImportResult,
  type ContactsImportRequest
} from "./import-transport.js";
import {
  buildManifest,
  buildRows,
  formatCount,
  manifestWithoutProfileFields,
  maskEmail,
  summarizeRefusals,
  MAX_SYNC_ROWS,
  type ContactsManifest
} from "./manifest.js";
import {
  discoverProfileTable,
  fetchProfileRows,
  fetchSampleProfileRow,
  PROFILE_TABLE_CANDIDATES,
  type ProfileDiscovery
} from "./profile-discovery.js";
import { ContactsSyncError } from "./sync-error.js";

export interface ContactsSyncIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  prompt(question: string): Promise<string>;
  interactive: boolean;
}

export interface ContactsSyncDeps {
  cwd: string;
  io: ContactsSyncIo;
  /** Owner-only bridge descriptor, or null when the desktop is not running. */
  readDescriptor(): DesktopBridgeDescriptor | null;
  /** status.v1 — names the destination workspace for confirm 1. */
  desktopStatus(): Promise<DesktopStatus>;
  /** POST /v1/contacts/import — the ONLY call that carries people. */
  postImport(request: ContactsImportRequest): Promise<BridgeImportResult>;
  /** HTTP to the customer's OWN Supabase (GoTrue admin + PostgREST). */
  fetchImpl?: typeof fetch;
  detectEnv?(): SupabaseEnvResult;
  randomId?(): string;
  now?(): Date;
}

const PROVENANCE_LABELS: Record<string, string> = {
  signups: "product signups",
  customers: "customers",
  other: "something else"
};

function parseProvenanceAnswer(
  answer: string
): { provenance: "signups" | "customers" | "other"; label: string } | undefined {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized.includes("sign")) {
    return { provenance: "signups", label: PROVENANCE_LABELS.signups };
  }
  if (normalized === "2" || normalized.includes("pay") || normalized.includes("customer")) {
    return { provenance: "customers", label: PROVENANCE_LABELS.customers };
  }
  if (
    normalized === "3" ||
    normalized.includes("else") ||
    normalized.includes("other") ||
    normalized === "something"
  ) {
    return { provenance: "other", label: PROVENANCE_LABELS.other };
  }
  return undefined;
}

function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function contactsWord(count: number): string {
  return count === 1 ? "contact" : "contacts";
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function invalidRows(body: Record<string, unknown>): Array<{ reason?: unknown }> {
  const value = body.invalid;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is { reason?: unknown } => typeof entry === "object" && entry !== null
  );
}

function renderManifest(io: ContactsSyncIo, manifest: ContactsManifest): void {
  io.writeOut("");
  io.writeOut("  Here is EXACTLY what Infinite will take, and why:");
  io.writeOut("");
  const labelWidth = Math.max(15, ...manifest.fields.map((field) => field.label.length + 2));
  const sourceWidth = Math.max(26, ...manifest.fields.map((field) => field.source.length + 2));
  for (const field of manifest.fields) {
    io.writeOut(
      `    ${field.label.padEnd(labelWidth)}${field.source.padEnd(sourceWidth)}${field.purpose}`
    );
  }
  io.writeOut("");
  io.writeOut("  Nothing else is read — not password hashes, not tokens, not addresses.");
  for (const note of manifest.notes) {
    io.writeOut(`  ${note}`);
  }
}

function renderScanReport(io: ContactsSyncIo, scan: AuthScanResult): void {
  const droppedParts: string[] = [];
  if (scan.droppedDeleted > 0) droppedParts.push(`${formatCount(scan.droppedDeleted)} deleted`);
  if (scan.droppedBanned > 0) droppedParts.push(`${formatCount(scan.droppedBanned)} banned`);
  if (scan.droppedNoEmail > 0) {
    droppedParts.push(`${formatCount(scan.droppedNoEmail)} without an email address`);
  }
  if (droppedParts.length > 0) {
    io.writeOut(`  Left out: ${droppedParts.join(", ")}.`);
  }
  if (scan.unconfirmedKept > 0) {
    const verb = scan.unconfirmedKept === 1 ? "contact hasn't" : "contacts haven't";
    io.writeOut(
      `  ${formatCount(scan.unconfirmedKept)} ${verb} confirmed their email yet — kept, and counted so you know.`
    );
  }
  if (scan.unreadablePages > 0) {
    const pages = scan.unreadablePages === 1 ? "page" : "pages";
    io.writeOut(
      `  ${formatCount(scan.unreadablePages)} ${pages} of auth.users unreadable — the counts above may be incomplete.`
    );
  }
}

/** Runs the full flow; returns the process exit code. */
export async function runContactsSync(deps: ContactsSyncDeps): Promise<number> {
  const { io } = deps;
  const out = (text: string): void => io.writeOut(text);
  const fail = (text: string): number => {
    io.writeErr(text);
    return 1;
  };
  const randomId = deps.randomId ?? (() => globalThis.crypto.randomUUID());

  // ── Bridge discovery + capability gate, before anything else. ─────────────
  let descriptor: DesktopBridgeDescriptor | null;
  try {
    descriptor = deps.readDescriptor();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!descriptor) {
    return fail("Open the Infinite app first — that's how your contacts reach your workspace.");
  }
  if (!descriptor.capabilities.includes(CONTACTS_IMPORT_CAPABILITY)) {
    return fail("Your Infinite app is too old for contacts sync — update the app first.");
  }
  if (!io.interactive) {
    return fail(
      "infinite contacts sync is interactive — it asks for your consent before anything is sent. Run it in a terminal."
    );
  }

  // ── Env detect: the customer's own Supabase credentials, read locally. ────
  const envResult = (deps.detectEnv ?? (() => detectSupabaseEnv(deps.cwd)))();
  if (!envResult.ok) {
    out(
      `  Checked ${envResult.checkedFiles.join(" and ")} — no Supabase URL + service role key found.`
    );
    out(
      "  Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to this directory's env, or export a CSV"
    );
    out("  from the Supabase dashboard and use Import CSV in the Infinite app instead.");
    return 1;
  }
  const supabaseEnv = envResult.env;
  out(
    `  Reading ${supabaseEnv.sourceFile} … found ${supabaseEnv.urlVariable} + service role key (stays on this machine).`
  );

  // ── Trust rule 9: say which database is being read, out loud. ─────────────
  const host = supabaseHost(supabaseEnv.url);
  out(`  Reading from ${host} — your database; rows stay here until you approve.`);
  if (isLocalSupabaseUrl(supabaseEnv.url)) {
    out(`  ⚠ WARNING: ${host} looks like a LOCAL / staging database, not production.`);
    out("    Make sure this is the database that holds your real users.");
  }

  const supabaseHttp = {
    supabaseUrl: supabaseEnv.url,
    serviceKey: supabaseEnv.serviceKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  };

  // ── Discovery, all local: auth.users census + profiles-ish table. ─────────
  let scan: AuthScanResult;
  try {
    scan = await scanAuthUsers({ ...supabaseHttp, ...(deps.now ? { now: deps.now() } : {}) });
  } catch (error) {
    if (error instanceof ContactsSyncError) return fail(error.message);
    throw error;
  }
  if (scan.totalListed === 0 && scan.unreadablePages > 0) {
    return fail(
      `  auth.users could not be read at all (${formatCount(scan.unreadablePages)} ${
        scan.unreadablePages === 1 ? "page" : "pages"
      } unreadable). Fix the project's auth admin API, or export a CSV from the dashboard instead.`
    );
  }

  let discovery: ProfileDiscovery;
  try {
    discovery = await discoverProfileTable(supabaseHttp);
  } catch (error) {
    if (error instanceof ContactsSyncError) return fail(error.message);
    throw error;
  }

  out(
    `  Looking at your database … found auth.users (${formatCount(scan.totalListed)} ${contactsWord(
      scan.totalListed
    )})${discovery.table ? ` and public.${discovery.table}` : ""}.`
  );
  renderScanReport(io, scan);
  if (scan.kept.length === 0) {
    return fail("  No importable contacts were found in auth.users — nothing to sync.");
  }
  if (scan.kept.length > MAX_SYNC_ROWS) {
    out(
      `  That's ${formatCount(scan.kept.length)} contacts — more than the ${formatCount(MAX_SYNC_ROWS)} one sync can carry.`
    );
    out(
      "  Split by created_at (import your oldest cohort first, then the rest) and re-run."
    );
    return 1;
  }

  // Honest absences for the profiles lane (trust rule 7): the reason a field
  // is missing is stated — never "no plan column found" when the Data API is
  // simply off.
  if (discovery.dataApiOff) {
    out("  Your project's Data API is off — profiles fields skipped.");
  } else if (discovery.keyRejected) {
    out("  Your project's Data API refused the service key — profiles fields skipped.");
  } else if (!discovery.table) {
    out(
      `  No profiles-like table found (tried ${PROFILE_TABLE_CANDIDATES.join(", ")}).`
    );
    const named = (
      await io.prompt(
        "  Type your table's name to read it, or press Enter to continue with auth.users only: "
      )
    ).trim();
    if (named) {
      try {
        const namedDiscovery = await discoverProfileTable(supabaseHttp, [named]);
        if (namedDiscovery.table) {
          discovery = namedDiscovery;
          out(`  Using public.${named}.`);
        } else {
          out(`  Couldn't use "${named}" — continuing with auth.users only.`);
        }
      } catch {
        out(`  Couldn't use "${named}" — continuing with auth.users only.`);
      }
    }
  }

  // ── The field manifest + ONE masked sample row (the consent surface). ─────
  let manifest = buildManifest(discovery);
  const samplePerson = scan.kept[0];
  const sampleProfileRow = await fetchSampleProfileRow(supabaseHttp, discovery, samplePerson.id);
  renderManifest(io, manifest);
  const sampleParts: string[] = [maskEmail(samplePerson.email)];
  if (samplePerson.createdAt) sampleParts.push(`joined ${samplePerson.createdAt.slice(0, 10)}`);
  for (const column of [
    discovery.planColumn,
    discovery.countryColumn,
    discovery.cityColumn
  ]) {
    const value = column ? sampleProfileRow?.[column] : undefined;
    if (value) sampleParts.push(value);
  }
  out(`  Sample (1 row, masked): ${sampleParts.join(" · ")}`);
  out("");

  // ── Named provenance (trust rule 5) — same vocabulary as the import wizard.
  let provenance: { provenance: "signups" | "customers" | "other"; label: string } | undefined;
  for (let attempt = 0; attempt < 3 && !provenance; attempt += 1) {
    const answer = await io.prompt(
      "  Are these contacts product signups, customers, or something else? "
    );
    provenance = parseProvenanceAnswer(answer);
    if (!provenance) out("  Please answer: signups, customers, or other.");
  }
  if (!provenance) {
    return fail("  Couldn't read that answer — re-run and answer signups, customers, or other.");
  }

  // ── Confirm 1 gates transmission. Status.v1 names the workspace; no contact
  //    data has crossed the bridge yet, and none does until this yes. ────────
  let status: DesktopStatus;
  try {
    status = await deps.desktopStatus();
  } catch {
    return fail("The Infinite app bridge didn't answer — is the app still open? Re-run when it is.");
  }
  if (!status.ready) {
    return fail(
      status.error?.message ?? "The Infinite app isn't ready — open it, sign in, and re-run."
    );
  }
  const workspaceName = status.workspace?.name ?? "your workspace";

  out("");
  const confirm1 = await io.prompt(
    `  ▸ Send ${formatCount(scan.kept.length)} ${contactsWord(scan.kept.length)} to workspace "${workspaceName}" as ${provenance.label}? [y/N] `
  );
  if (!isYes(confirm1)) {
    out("  Nothing was sent.");
    return 0;
  }

  // ── Build rows client-side (post-consent read of the allowlisted columns).
  let profileRows: ReadonlyMap<string, Record<string, string>> = new Map();
  const wantsProfileFields = manifest.fields.some((field) => field.from === "profile");
  if (wantsProfileFields) {
    try {
      profileRows = await fetchProfileRows(supabaseHttp, discovery);
    } catch (error) {
      const reason = error instanceof ContactsSyncError ? ` (${error.message})` : "";
      out(
        `  Could not read public.${discovery.table} rows${reason} — profiles fields skipped for this run.`
      );
      manifest = manifestWithoutProfileFields();
    }
  }
  const rows = buildRows(scan.kept, profileRows, manifest);

  // ── ONE dry-run request: the cloud measures, writes nothing. ──────────────
  out("  Measuring (nothing is written yet) …");
  let dryRun: BridgeImportResult;
  try {
    dryRun = await deps.postImport({
      mode: "dry_run",
      provenance: provenance.provenance,
      mapping: manifest.mapping,
      rows,
      requestId: randomId()
    });
  } catch (error) {
    if (error instanceof ContactsSyncError) return fail(error.message);
    throw error;
  }
  if (dryRun.status !== 200 || dryRun.body.ok !== true) {
    return fail(`  ${describeImportFailure(dryRun.status, dryRun.body)}`);
  }
  const workspacePin =
    typeof dryRun.body.workspacePin === "string" && dryRun.body.workspacePin
      ? dryRun.body.workspacePin
      : undefined;
  if (!workspacePin) {
    return fail(
      "  The app's dry-run answer was missing its workspace pin — update the Infinite app and re-run."
    );
  }

  const importable = numberField(dryRun.body, "imported");
  const willMerge = numberField(dryRun.body, "merged");
  const refused = invalidRows(dryRun.body);
  out(
    `  Dry-run says: ${formatCount(importable)} importable (${formatCount(willMerge)} will merge with existing), ${formatCount(refused.length)} refused${refused.length > 0 ? ":" : "."}`
  );
  if (refused.length > 0) {
    out(`    ${summarizeRefusals(refused)}`);
  }

  // ── Confirm 2 commits, pinned to the dry run's workspace. ─────────────────
  const confirm2 = await io.prompt(
    `  Import ${formatCount(importable)} ${contactsWord(importable)} now? [y/N] `
  );
  if (!isYes(confirm2)) {
    out("  Nothing was imported.");
    return 0;
  }

  out("  Importing …");
  let commit: BridgeImportResult;
  try {
    commit = await deps.postImport({
      mode: "commit",
      workspacePin,
      provenance: provenance.provenance,
      mapping: manifest.mapping,
      rows,
      requestId: randomId()
    });
  } catch (error) {
    if (error instanceof ContactsSyncError) return fail(error.message);
    throw error;
  }
  if (commit.status !== 200 || commit.body.ok !== true) {
    return fail(`  ${describeImportFailure(commit.status, commit.body)}`);
  }

  const imported = numberField(commit.body, "imported");
  const merged = numberField(commit.body, "merged");
  const commitRefused = invalidRows(commit.body);
  const keptSuppressed = numberField(commit.body, "kept_suppressed");
  out(
    `  ${formatCount(imported)} imported (${formatCount(merged)} merged with existing), ${formatCount(commitRefused.length)} refused${commitRefused.length > 0 ? ":" : "."}`
  );
  if (commitRefused.length > 0) {
    out(`    ${summarizeRefusals(commitRefused)}`);
  }
  if (keptSuppressed > 0) {
    out(
      `  ${formatCount(keptSuppressed)} previously unsubscribed or suppressed ${contactsWord(keptSuppressed)} stayed that way.`
    );
  }
  out("");
  out("  Done. Unsubscribed or suppressed contacts were NOT resurrected — that is permanent.");
  out("  Re-run this command any time: re-imports merge and never clobber consent.");
  return 0;
}
