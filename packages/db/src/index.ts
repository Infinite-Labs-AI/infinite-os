import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool, type PoolClient, type QueryResultRow } from "pg";

export const dbBoot = true;

export interface Migration {
  id: string;
  sql: string;
}

export function migrationsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "migrations"),
    join(moduleDir, "..", "..", "migrations")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function loadMigrations(directory = migrationsDir()): Migration[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      id: file,
      sql: readFileSync(join(directory, file), "utf8")
    }));
}

export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const applied: string[] = [];
    for (const migration of loadMigrations()) {
      const existing = await client.query(
        "select id from schema_migrations where id = $1",
        [migration.id]
      );
      if (existing.rowCount) {
        continue;
      }
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (id) values ($1)", [
          migration.id
        ]);
        await client.query("commit");
        applied.push(migration.id);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

export type FirstPhaseProvider =
  | "google_analytics_4"
  | "posthog"
  | "stripe"
  | "x"
  | "shopify"
  | "meta_ads";
export type JobType =
  | "source_sync"
  | "source_backfill"
  | "materialized_view_refresh"
  | "saved_report_run"
  | "saved_report_export";

export interface InfiniteOsDb {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null>;
  close(): Promise<void>;
  ensureWorkspace(workspaceId: string, name?: string): Promise<void>;
  ensureFirstPhaseDatasets(workspaceId: string): Promise<void>;
  connectSource(input: ConnectSourceInput): Promise<Record<string, unknown>>;
  updateSourceStatus(
    sourceId: string,
    status: string,
    lastSyncedAt?: string
  ): Promise<void>;
  createJob(input: CreateJobInput): Promise<Record<string, unknown>>;
  claimNextJob(
    workerId: string,
    leaseSeconds?: number
  ): Promise<Record<string, unknown> | null>;
  completeJob(
    jobId: string,
    status: "succeeded" | "failed",
    error?: string
  ): Promise<void>;
  withTransaction<T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T>;
}

export interface ConnectSourceInput {
  workspaceId: string;
  provider: FirstPhaseProvider;
  connectionName: string;
  accountExternalId?: string;
  credentialKind?: string;
  encryptedPayload?: string;
  // When set, the credential row is linked to a live oauth_tokens row instead of storing the
  // OAuth token inside encrypted_payload (which only holds non-secret metadata in that case).
  oauthTokenId?: string;
  actorType?: string;
}

export interface CreateJobInput {
  workspaceId: string;
  jobType: JobType;
  payload: Record<string, unknown>;
}

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceSiteUpsertInput {
  workspaceId: string;
  url?: string;
  repoPath?: string;
  appDir?: string;
  framework?: string;
  businessType?: string;
}

export interface SetupResolvedArtifacts {
  ga4: {
    measurementId: string | null;
    propertyId: string | null;
  };
  posthog: {
    projectId: string | null;
    projectKey: string | null;
    apiHost: string | null;
  };
  x: {
    pixelId: string | null;
    eventTagIds: Record<string, string> | null;
  };
}

export async function createProject(
  db: Pick<InfiniteOsDb, "one">,
  name: string
): Promise<ProjectRow> {
  const id = `proj_${randomBytes(8).toString("hex")}`;
  // Plain INSERT — the primary key is the existence check. NEVER `on conflict`
  // (that is ensureWorkspace's upsert and would clobber an existing project's name).
  const row = await db.one<ProjectRow>(
    `
      insert into workspaces (id, name)
      values ($1, $2)
      returning id, name, created_at as "createdAt"
    `,
    [id, name]
  );
  if (!row) {
    throw new Error(`createProject: insert returned no row for ${id}`);
  }
  return row;
}

export async function listProjects(db: Pick<InfiniteOsDb, "query">): Promise<ProjectRow[]> {
  return db.query<ProjectRow>(
    `select id, name, created_at as "createdAt" from workspaces order by created_at`
  );
}

export async function findProject(
  db: Pick<InfiniteOsDb, "one">,
  idOrName: string
): Promise<ProjectRow | null> {
  return db.one<ProjectRow>(
    `
      select id, name, created_at as "createdAt"
      from workspaces
      where id = $1 or name = $2
      order by created_at asc
      limit 1
    `,
    [idOrName, idOrName]
  );
}

type JsonRecord = Record<string, unknown>;
type SetupProviderId = "ga4" | "posthog" | "x";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeJsonRecords(base: JsonRecord, patch: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...base };
  for (const [key, nextValue] of Object.entries(patch)) {
    if (nextValue === undefined) {
      continue;
    }
    const currentValue = merged[key];
    if (isRecord(currentValue) && isRecord(nextValue)) {
      merged[key] = mergeJsonRecords(currentValue, nextValue);
      continue;
    }
    merged[key] = nextValue;
  }
  return merged;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string" && entry[1].trim().length > 0;
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

function providerArtifactsFromPhaseState(
  phaseState: JsonRecord | null | undefined,
  provider: SetupProviderId
): JsonRecord {
  if (!isRecord(phaseState)) {
    return {};
  }
  const providers = isRecord(phaseState.providers) ? phaseState.providers : {};
  const providerState = isRecord(providers[provider]) ? providers[provider] : {};
  return isRecord(providerState.publicArtifacts) ? providerState.publicArtifacts : {};
}

function applyLegacyResolvedIds(target: SetupResolvedArtifacts, phaseState: JsonRecord | null | undefined): void {
  if (!isRecord(phaseState) || !isRecord(phaseState.ids)) {
    return;
  }
  const ids = phaseState.ids;
  target.ga4.measurementId ??= asString(ids.ga4MeasurementId);
  target.posthog.projectKey ??= asString(ids.posthogProjectKey);
  target.posthog.apiHost ??= asString(ids.posthogHost);
  target.x.pixelId ??= asString(ids.xPixelId);
}

export async function upsertWorkspaceSite(
  db: Pick<InfiniteOsDb, "one">,
  input: WorkspaceSiteUpsertInput
): Promise<{ id: string } | null> {
  const existing = await db.one<{ id: string }>(
    `
      select id
      from workspace_sites
      where workspace_id = $1 and is_primary = true
      limit 1
    `,
    [input.workspaceId]
  );
  if (existing) {
    return db.one<{ id: string }>(
      `
        update workspace_sites
        set
          url = coalesce($2, url),
          repo_path = coalesce($3, repo_path),
          app_dir = coalesce($4, app_dir),
          framework = coalesce($5, framework),
          business_type = coalesce($6, business_type),
          updated_at = now()
        where id = $1
        returning id
      `,
      [
        existing.id,
        input.url ?? null,
        input.repoPath ?? null,
        input.appDir ?? null,
        input.framework ?? null,
        input.businessType ?? null
      ]
    );
  }
  if (!input.url) {
    return null;
  }
  const id = `site_${randomUUID()}`;
  return db.one<{ id: string }>(
    `
      insert into workspace_sites (
        id, workspace_id, url, repo_path, app_dir, framework, business_type, is_primary
      )
      values ($1, $2, $3, $4, $5, $6, $7, true)
      returning id
    `,
    [
      id,
      input.workspaceId,
      input.url,
      input.repoPath ?? null,
      input.appDir ?? null,
      input.framework ?? null,
      input.businessType ?? null
    ]
  );
}

export async function mergeSetupRunPhaseState(
  db: Pick<InfiniteOsDb, "one" | "query">,
  runId: string,
  patch: JsonRecord
): Promise<JsonRecord> {
  const existing = await db.one<{ phase_state: JsonRecord | null }>(
    "select phase_state from setup_runs where id = $1",
    [runId]
  );
  const currentPhaseState = isRecord(existing?.phase_state) ? existing.phase_state : {};
  const nextPhaseState = mergeJsonRecords(currentPhaseState, patch);
  await db.query(
    "update setup_runs set phase_state = $2::jsonb, updated_at = now() where id = $1",
    [runId, nextPhaseState]
  );
  return nextPhaseState;
}

export async function mergeSetupProviderState(
  db: Pick<InfiniteOsDb, "one" | "query">,
  runId: string,
  provider: SetupProviderId,
  state: JsonRecord
): Promise<void> {
  await mergeSetupRunPhaseState(db, runId, {
    providers: {
      [provider]: state
    }
  });
}

export async function readLatestSetupPublicArtifacts(
  db: Pick<InfiniteOsDb, "query">,
  workspaceId: string
): Promise<SetupResolvedArtifacts> {
  const rows = await db.query<{ phase_state: JsonRecord | null }>(
    `
      select phase_state
      from setup_runs
      where workspace_id = $1
      order by updated_at desc, created_at desc
    `,
    [workspaceId]
  );
  const resolved: SetupResolvedArtifacts = {
    ga4: { measurementId: null, propertyId: null },
    posthog: { projectId: null, projectKey: null, apiHost: null },
    x: { pixelId: null, eventTagIds: null }
  };

  for (const row of rows) {
    const phaseState = isRecord(row.phase_state) ? row.phase_state : {};
    const ga4Artifacts = providerArtifactsFromPhaseState(phaseState, "ga4");
    resolved.ga4.measurementId ??= asString(ga4Artifacts.measurementId);
    resolved.ga4.propertyId ??= asString(ga4Artifacts.propertyId);

    const posthogArtifacts = providerArtifactsFromPhaseState(phaseState, "posthog");
    resolved.posthog.projectId ??= asString(posthogArtifacts.projectId);
    resolved.posthog.projectKey ??= asString(posthogArtifacts.projectKey);
    resolved.posthog.apiHost ??= asString(posthogArtifacts.apiHost);

    const xArtifacts = providerArtifactsFromPhaseState(phaseState, "x");
    resolved.x.pixelId ??= asString(xArtifacts.pixelId);
    resolved.x.eventTagIds ??= asStringRecord(xArtifacts.eventTagIds);

    applyLegacyResolvedIds(resolved, phaseState);
  }

  return resolved;
}

export function createInfiniteOsDb(databaseUrl: string): InfiniteOsDb {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return wrapPool(pool, () => pool.end());
}

function wrapPool(
  client: Pool | PoolClient,
  closeFn: () => Promise<void>
): InfiniteOsDb {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ) {
      const result = await client.query<T>(sql, params);
      return [...result.rows];
    },
    async one<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ) {
      const result = await client.query<T>(sql, params);
      return (result.rows[0] as T | undefined) ?? null;
    },
    close: closeFn,
    ensureWorkspace: (workspaceId, name) =>
      ensureWorkspace(client, workspaceId, name),
    ensureFirstPhaseDatasets: (workspaceId) =>
      ensureFirstPhaseDatasets(client, workspaceId),
    connectSource: (input) => connectSource(client, input),
    updateSourceStatus: (sourceId, status, lastSyncedAt) =>
      updateSourceStatus(client, sourceId, status, lastSyncedAt),
    createJob: (input) => createJob(client, input),
    claimNextJob: (workerId, leaseSeconds) =>
      claimNextJob(client, workerId, leaseSeconds),
    completeJob: (jobId, status, error) =>
      completeJob(client, jobId, status, error),
    async withTransaction<T>(fn: (tx: InfiniteOsDb) => Promise<T>): Promise<T> {
      if (typeof (client as Pool).connect !== "function") {
        await client.query("begin");
        try {
          const value = await fn(wrapPool(client, async () => undefined));
          await client.query("commit");
          return value;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
      const txClient = await (client as Pool).connect();
      try {
        await txClient.query("begin");
        const value = await fn(
          wrapPool(txClient as PoolClient, async () => undefined)
        );
        await txClient.query("commit");
        return value;
      } catch (error) {
        await txClient.query("rollback");
        throw error;
      } finally {
        txClient.release();
      }
    }
  };
}

async function ensureWorkspace(
  client: Pool | PoolClient,
  workspaceId: string,
  name = "Default workspace"
): Promise<void> {
  // Create-if-absent ONLY. `do nothing` (not `do update set name`) so that an
  // idempotent ensure (e.g. connectSource) never clobbers a project's user-set
  // name back to the default. Renaming is an explicit operation, not a side
  // effect of touching the workspace.
  await client.query(
    `
      insert into workspaces (id, name)
      values ($1, $2)
      on conflict (id) do nothing
    `,
    [workspaceId, name]
  );
}

async function ensureFirstPhaseDatasets(
  client: Pool | PoolClient,
  workspaceId: string
): Promise<void> {
  await client.query(
    `
      insert into datasets (id, workspace_id, key, label)
      values
        ($1, $3, 'web', 'Web analytics'),
        ($2, $3, 'billing', 'Billing')
      on conflict (workspace_id, key) do update set label = excluded.label
    `,
    [`${workspaceId}:web`, `${workspaceId}:billing`, workspaceId]
  );
}

async function connectSource(
  client: Pool | PoolClient,
  input: ConnectSourceInput
): Promise<Record<string, unknown>> {
  assertFirstPhaseProvider(input.provider);
  await ensureWorkspace(client, input.workspaceId);
  await ensureFirstPhaseDatasets(client, input.workspaceId);
  const datasetKey = input.provider === "stripe" ? "billing" : "web";
  const dataset = await client.query<{ id: string }>(
    "select id from datasets where workspace_id = $1 and key = $2",
    [input.workspaceId, datasetKey]
  );
  const sourceId = `src_${randomUUID()}`;
  const accountExternalId = input.accountExternalId ?? input.connectionName;
  const source = await client.query(
    `
      insert into sources (
        id, workspace_id, dataset_id, provider, connection_name, account_external_id,
        status, sync_mode, connected_at
      )
      values ($1, $2, $3, $4, $5, $6, 'connected', 'incremental', now())
      on conflict (workspace_id, provider, account_external_id)
      do update set
        connection_name = excluded.connection_name,
        status = 'connected',
        connected_at = now()
      returning id, workspace_id, provider, connection_name, account_external_id, status
    `,
    [
      sourceId,
      input.workspaceId,
      dataset.rows[0]?.id,
      input.provider,
      input.connectionName,
      accountExternalId
    ]
  );
  const row = source.rows[0];
  await client.query(
    `
      insert into connection_credentials (
        id, workspace_id, source_id, credential_kind, encrypted_payload, oauth_token_id
      )
      values ($1, $2, $3, $4, $5, $6)
    `,
    [
      `cred_${randomUUID()}`,
      input.workspaceId,
      row.id,
      input.credentialKind ?? "fixture",
      input.encryptedPayload ?? "fixture-encrypted",
      input.oauthTokenId ?? null
    ]
  );
  await client.query(
    `
      insert into sync_schedules (
        id, workspace_id, source_id, schedule_kind, interval_minutes, sync_mode,
        refresh_window_days, stale_after_minutes, status, next_run_at
      )
      values ($1, $2, $3, 'manual_only', null, 'incremental', null, 1440, 'active', null)
      on conflict (source_id) do nothing
    `,
    [`sched_${randomUUID()}`, input.workspaceId, row.id]
  );
  await client.query(
    `
      insert into integration_audit_log (id, workspace_id, source_id, actor_type, action, status)
      values ($1, $2, $3, $4, 'connect_source', 'succeeded')
    `,
    [
      `audit_${randomUUID()}`,
      input.workspaceId,
      row.id,
      input.actorType ?? "operator"
    ]
  );
  return row;
}

async function updateSourceStatus(
  client: Pool | PoolClient,
  sourceId: string,
  status: string,
  lastSyncedAt?: string
): Promise<void> {
  await client.query(
    `
      update sources
      set status = $2, last_synced_at = coalesce($3::timestamptz, last_synced_at)
      where id = $1
    `,
    [sourceId, status, lastSyncedAt ?? null]
  );
}

async function createJob(
  client: Pool | PoolClient,
  input: CreateJobInput
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `
      insert into job_runs (id, workspace_id, job_type, payload, status)
      values ($1, $2, $3, $4::jsonb, 'queued')
      returning *
    `,
    [
      `job_${randomUUID()}`,
      input.workspaceId,
      input.jobType,
      JSON.stringify(input.payload)
    ]
  );
  return result.rows[0];
}

async function claimNextJob(
  client: Pool | PoolClient,
  workerId: string,
  leaseSeconds = 60
): Promise<Record<string, unknown> | null> {
  const result = await client.query(
    `
      with candidate as (
        select id
        from job_runs
        where status = 'queued'
        order by created_at asc
        for update skip locked
        limit 1
      )
      update job_runs
      set status = 'running', started_at = now(), attempt_count = attempt_count + 1
      where id in (select id from candidate)
      returning *
    `
  );
  const job = result.rows[0];
  if (!job) {
    return null;
  }
  await client.query(
    `
      insert into job_locks (id, job_run_id, worker_id, locked_until)
      values ($1, $2, $3, now() + ($4::text || ' seconds')::interval)
    `,
    [`lock_${randomUUID()}`, job.id, workerId, leaseSeconds]
  );
  return job;
}

async function completeJob(
  client: Pool | PoolClient,
  jobId: string,
  status: "succeeded" | "failed",
  error?: string
): Promise<void> {
  await client.query(
    `
      update job_runs
      set status = $2, finished_at = now(), error = $3
      where id = $1
    `,
    [jobId, status, error ?? null]
  );
}

export function assertFirstPhaseProvider(
  provider: string
): asserts provider is FirstPhaseProvider {
  if (
    ![
      "google_analytics_4",
      "posthog",
      "stripe",
      "x",
      "shopify",
      "meta_ads"
    ].includes(provider)
  ) {
    throw new Error(`provider_not_in_first_phase:${provider}`);
  }
}
