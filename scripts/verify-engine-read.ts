#!/usr/bin/env tsx
// P0-D — connect-and-read sanity check.
//
// Proves the ENGINE'S OWN connector path connects and reads: given a connected
// `growth_os` project, this performs ONE live read from the engine credential —
// resolving the credential exactly the way the production write/read paths do
// (`resolveMetaAdsCredential`, `packages/connectors/src/index.ts:5661`) and issuing a
// Graph `/insights` GET that MIRRORS `fetchAccountInsights` (the same direct-Graph
// transport `testLive` uses, `packages/connectors/src/index.ts:1007-1021`) — exercising
// WHICHEVER token the resolver actually picks (system-user if present, else the linked
// OAuth user token) so the proof matches the production path. It asserts ≥1 row with
// non-zero spend/impressions and PRINTS the token source used. It NEVER prints the token.
//
//   npx tsx scripts/verify-engine-read.ts --project <growth-os-proj> [--source <id>]
//
// ─────────────────────────────────────────────────────────────────────────────────────
// LIVE RUN IS HUMAN-GATED. Running this against the real `growth_os` DB makes a LIVE Graph
// API call against the user's real Meta ad account (`act_887743100560299`). It needs a real
// DATABASE_URL + GROWTH_OS_ENCRYPTION_KEY and network egress to graph.facebook.com. The
// mocked unit test (`tests/verify-engine-read.test.ts`) covers the core logic offline; the
// live run is a SEPARATE, supervised verification step.
// ─────────────────────────────────────────────────────────────────────────────────────
import {
  createInfiniteOsDb,
  findProject,
  type InfiniteOsDb
} from "@infinite-os/db";
import { loadInfiniteOsConfig } from "@infinite-os/config";
import { resolveMetaAdsCredential } from "@infinite-os/connectors";

// The token the resolver ultimately uses — system-user (the credential's own payload token)
// or a linked OAuth user token. This is the production selection: `sourceCredential` follows
// the `oauth_token_id` FK when present, otherwise reads the credential payload directly.
export type TokenSource = "system_user" | "oauth";

// The structured pass report. DELIBERATELY carries NO token field — never the secret.
export interface EngineReadReport {
  ok: true;
  workspaceId: string;
  sourceId: string;
  accountId: string;
  tokenSource: TokenSource;
  rowCount: number;
  // The single largest sample so the human sees real numbers without dumping every row.
  sampleSpend: number;
  sampleImpressions: number;
  datePreset: string;
}

// A failed read (empty / all-zero / HTTP error). Thrown, never returned — so the CLI exits
// non-zero. Its message NEVER includes the token.
export class EngineReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineReadError";
  }
}

// The minimal DB surface the core needs: a single `one()` reader. The script wires the real
// `InfiniteOsDb`; the test injects a mock. (`resolveMetaAdsCredential` also only needs `one`.)
export interface VerifyEngineReadDeps {
  db: Pick<InfiniteOsDb, "one">;
  fetchImpl: typeof fetch;
  workspaceId: string;
  sourceId: string;
  // Window for the read. Defaults to a 30-day lookback so an active account reliably returns
  // non-zero spend/impressions (today/yesterday can legitimately be empty).
  datePreset?: string;
}

// The insights field set + grain for the sanity read. account-level keeps it to ONE row
// regardless of campaign count; spend/impressions are the non-zero signal we assert on.
const READ_FIELDS = "spend,impressions,clicks,account_currency";
const READ_LEVEL = "account";
const DEFAULT_DATE_PRESET = "last_30d";
const DEFAULT_API_VERSION = "v25.0";

interface GraphInsightsRow {
  spend?: string | number | null;
  impressions?: string | number | null;
  account_currency?: string | null;
}

interface GraphInsightsResponse {
  data?: GraphInsightsRow[];
}

// Numeric coercion mirroring the connector's tolerant read (Meta returns numbers as strings).
function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Normalize the `act_`-prefixed account id the same way the engine does (`metaAdsAccountId`):
// strip a leading `act_`, then re-add exactly one so the Graph path is well-formed.
function normalizeAccountId(adAccountId: string): string {
  return `act_${adAccountId.replace(/^act_/i, "")}`;
}

// Read ONLY the non-secret row metadata that determines which token the resolver will pick.
// `oauth_token_id` presence is the production discriminator: `sourceCredential` follows the
// FK to the live oauth_tokens row when set, else uses the credential payload's own token.
// `is_system_user` (migration 0039) is the explicit P0-B2 marker and must agree.
async function readTokenSource(
  db: Pick<InfiniteOsDb, "one">,
  workspaceId: string,
  sourceId: string
): Promise<TokenSource> {
  const row = await db.one<{ oauth_token_id: string | null; is_system_user: boolean | null }>(
    `
      select oauth_token_id, is_system_user
      from connection_credentials
      where workspace_id = $1 and source_id = $2 and revoked_at is null
      order by created_at desc
      limit 1
    `,
    [workspaceId, sourceId]
  );
  if (!row) {
    throw new EngineReadError(`no live credential row for source ${sourceId}`);
  }
  // The resolver picks OAuth when (and only when) the row is linked to a live oauth_tokens row.
  return row.oauth_token_id ? "oauth" : "system_user";
}

// CORE: resolve the credential the way production does, determine the token source, issue ONE
// direct-Graph insights GET with whatever token the resolver picked, and assert a real read.
export async function verifyEngineRead(deps: VerifyEngineReadDeps): Promise<EngineReadReport> {
  const { db, fetchImpl, workspaceId, sourceId } = deps;
  const datePreset = deps.datePreset ?? DEFAULT_DATE_PRESET;

  const tokenSource = await readTokenSource(db, workspaceId, sourceId);

  // Resolve EXACTLY as the write/read paths do — this picks system-user vs OAuth internally.
  const credential = await resolveMetaAdsCredential(db as InfiniteOsDb, { workspaceId, sourceId });
  const adAccountId = credential.adAccountId;
  if (!adAccountId) {
    throw new EngineReadError("resolved credential is missing adAccountId");
  }
  const accessToken = credential.accessToken;
  if (!accessToken) {
    throw new EngineReadError("resolved credential has no usable access token");
  }
  const account = normalizeAccountId(adAccountId);
  const apiVersion = credential.apiVersion ?? DEFAULT_API_VERSION;

  const url = new URL(`https://graph.facebook.com/${apiVersion}/${account}/insights`);
  url.searchParams.set("fields", READ_FIELDS);
  url.searchParams.set("level", READ_LEVEL);
  url.searchParams.set("date_preset", datePreset);
  url.searchParams.set("limit", "1");

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    // The resolved token rides ONLY as the bearer header — never logged, never in the report.
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    // Surface status only — the body could echo back the request, so keep it terse + secret-free.
    throw new EngineReadError(`insights read failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as GraphInsightsResponse;
  const rows = body.data ?? [];
  if (rows.length === 0) {
    throw new EngineReadError(
      `insights read returned ZERO rows for ${account} (${datePreset}) — expected ≥1`
    );
  }

  // The proof requires REAL activity: at least one row with non-zero spend OR impressions.
  let sampleSpend = 0;
  let sampleImpressions = 0;
  let hasActivity = false;
  for (const row of rows) {
    const spend = toNumber(row.spend);
    const impressions = toNumber(row.impressions);
    if (spend > sampleSpend) sampleSpend = spend;
    if (impressions > sampleImpressions) sampleImpressions = impressions;
    if (spend > 0 || impressions > 0) hasActivity = true;
  }
  if (!hasActivity) {
    throw new EngineReadError(
      `insights read returned ${rows.length} row(s) but ALL had zero spend AND zero impressions`
    );
  }

  return {
    ok: true,
    workspaceId,
    sourceId,
    accountId: account,
    tokenSource,
    rowCount: rows.length,
    sampleSpend,
    sampleImpressions,
    datePreset
  };
}

// Human-facing printout. Carries the token SOURCE (system_user/oauth) but NEVER the token.
export function formatReport(report: EngineReadReport): string {
  return [
    "✓ engine connect-and-read PASSED",
    `  workspace:    ${report.workspaceId}`,
    `  source:       ${report.sourceId}`,
    `  account:      ${report.accountId}`,
    `  token source: ${report.tokenSource}`,
    `  window:       ${report.datePreset}`,
    `  rows:         ${report.rowCount}`,
    `  max spend:    ${report.sampleSpend}`,
    `  max impr.:    ${report.sampleImpressions}`
  ].join("\n");
}

// ── CLI wiring (only runs when invoked directly; importing for tests has no side effects) ──

function parseArgs(argv: string[]): { project?: string; source?: string; datePreset?: string } {
  const out: { project?: string; source?: string; datePreset?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") out.project = argv[++i];
    else if (arg === "--source") out.source = argv[++i];
    else if (arg === "--date-preset") out.datePreset = argv[++i];
  }
  return out;
}

// Find the meta_ads source for a workspace (the connected account to read from). When the
// operator passes --source we trust it; otherwise we pick the one connected meta_ads source.
async function resolveMetaSourceId(
  db: Pick<InfiniteOsDb, "one">,
  workspaceId: string,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;
  const row = await db.one<{ id: string }>(
    `
      select id
      from sources
      where workspace_id = $1 and provider = 'meta_ads'
        and status in ('connected', 'degraded')
      order by connected_at desc nulls last
      limit 1
    `,
    [workspaceId]
  );
  if (!row) {
    throw new EngineReadError(`no connected meta_ads source for workspace ${workspaceId}`);
  }
  return row.id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    throw new EngineReadError("usage: verify-engine-read --project <growth-os-proj> [--source <id>]");
  }

  const { databaseUrl } = loadInfiniteOsConfig();
  const db = createInfiniteOsDb(databaseUrl);
  try {
    const project = await findProject(db, args.project);
    if (!project) {
      throw new EngineReadError(`project not found: ${args.project}`);
    }
    const sourceId = await resolveMetaSourceId(db, project.id, args.source);
    const report = await verifyEngineRead({
      db,
      fetchImpl: fetch,
      workspaceId: project.id,
      sourceId,
      datePreset: args.datePreset
    });
    // eslint-disable-next-line no-console
    console.log(formatReport(report));
  } finally {
    await db.close();
  }
}

// Run only as a script, not when imported by the test (which would re-enter main()).
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("verify-engine-read.ts");
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`✗ engine connect-and-read FAILED: ${message}`);
    process.exitCode = 1;
  });
}
