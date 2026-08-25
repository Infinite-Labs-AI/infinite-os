import { randomUUID } from "node:crypto";

import {
  mergeSetupProviderState,
  mergeSetupRunPhaseState,
  readLatestSetupPublicArtifacts,
  upsertWorkspaceSite,
  type InfiniteOsDb,
  type SetupResolvedArtifacts
} from "@infinite-os/db";

import type { SetupRunStore, SetupSiteUpsert } from "./setup-controller.js";
import type {
  ProviderRunState,
  SetupInterview,
  SetupProviderId
} from "./types.js";

type MinimalDb = Pick<InfiniteOsDb, "query" | "one">;

/**
 * An active run whose `updated_at` is older than this is considered abandoned
 * (process died mid-run) and may be reclaimed: marked failed so a fresh run can
 * start instead of deadlocking on `setup_runs_active_unique_idx` forever.
 */
export const SETUP_RUN_STALE_MS = 15 * 60 * 1000;

interface SetupRunRow {
  id: string;
  workspace_id?: string;
  provider?: string | null;
  phase_state?: Record<string, unknown> | null;
  updated_at?: string | Date | null;
}

export interface DbSetupRunStoreOptions {
  /** Staleness threshold in ms; defaults to SETUP_RUN_STALE_MS. */
  staleMs?: number;
  /** Clock injection for tests; defaults to wall-clock. */
  now?: () => Date;
}

export interface SetupRunStateUpdate {
  interview?: SetupInterview;
  selectedProviders?: SetupProviderId[];
  recommendedProviders?: SetupProviderId[];
  provider?: SetupProviderId;
  providerState?: Partial<ProviderRunState>;
  site?: SetupSiteUpsert;
  pendingHandoff?: Record<string, unknown> | null;
  browserProfile?: string | null;
}

export interface DbSetupRunStore extends SetupRunStore {
  recordSetupState(runId: string, update: SetupRunStateUpdate): Promise<void>;
  getResolvedPublicArtifacts(workspaceId: string): Promise<SetupResolvedArtifacts>;
}

/**
 * Resumable run store. Concurrency is guarded by the partial unique index
 * `setup_runs_active_unique_idx` (migration 0019): a second concurrent run for the
 * same (workspace, tool) fails the INSERT and is resolved by resuming the winner.
 */
export function createDbSetupRunStore(db: MinimalDb, options: DbSetupRunStoreOptions = {}): DbSetupRunStore {
  const staleMs = options.staleMs ?? SETUP_RUN_STALE_MS;
  const now = options.now ?? (() => new Date());
  async function activeRun(workspaceId: string, tool: string) {
    return db.one<SetupRunRow>(
      `
        select id, status, provider, phase_state, updated_at
        from setup_runs
        where workspace_id = $1 and tool = $2 and status in ('running','paused_handoff')
        limit 1
      `,
      [workspaceId, tool]
    );
  }
  // Stale = updated_at older than the threshold. A run without a parseable
  // updated_at is treated as in progress (never reclaimed on missing data).
  function isStaleRun(run: SetupRunRow): boolean {
    if (!run.updated_at) return false;
    const updatedAt = new Date(run.updated_at);
    if (Number.isNaN(updatedAt.getTime())) return false;
    return now().getTime() - updatedAt.getTime() > staleMs;
  }
  async function failStaleRun(runId: string) {
    await db.query(
      "update setup_runs set status='failed', pending_handoff=null, finished_at=now(), updated_at=now() where id=$1",
      [runId]
    );
  }
  async function loadRun(runId: string) {
    const run = await db.one<SetupRunRow>(
      "select id, workspace_id, provider, phase_state from setup_runs where id = $1",
      [runId]
    );
    if (!run) {
      throw new Error(`setup run not found: ${runId}`);
    }
    return run;
  }
  return {
    async startOrResume(workspaceId, tool) {
      const existing = await activeRun(workspaceId, tool);
      if (existing) {
        if (!isStaleRun(existing)) {
          await db.query("update setup_runs set status='running', updated_at=now() where id=$1", [existing.id]);
          return { runId: existing.id, resumed: true };
        }
        // The active run is stale (process died mid-run): reclaim it so the
        // partial unique index releases and a fresh run can start.
        await failStaleRun(existing.id);
      }
      const id = `setuprun_${randomUUID()}`;
      const insertFreshRun = () =>
        db.query(
          "insert into setup_runs (id, workspace_id, tool, provider, status) values ($1,$2,$3,$4,'running')",
          [id, workspaceId, tool, tool]
        );
      try {
        await insertFreshRun();
        return { runId: id, resumed: false };
      } catch (error) {
        // Only a unique-violation (23505) means we lost the active-run race; resume the winner.
        // Any other error (connection, permission, etc.) must propagate, not be mistaken for a race.
        if ((error as { code?: string } | null)?.code === "23505") {
          const winner = await activeRun(workspaceId, tool);
          if (winner) {
            if (!isStaleRun(winner)) return { runId: winner.id, resumed: true };
            // The winner itself is stale: reclaim it and retry the insert once.
            await failStaleRun(winner.id);
            await insertFreshRun();
            return { runId: id, resumed: false };
          }
        }
        throw error;
      }
    },
    async recordPhase(runId, verb, result) {
      const run = await loadRun(runId);
      if (run.provider === "ga4" || run.provider === "posthog" || run.provider === "x") {
        await mergeSetupProviderState(db, runId, run.provider, {
          phases: {
            [verb]: result
          }
        });
      } else {
        await mergeSetupRunPhaseState(db, runId, {
          phases: {
            [verb]: result
          }
        });
      }
      await db.query(
        "update setup_runs set pending_handoff = $2::jsonb, updated_at = now() where id = $1",
        [runId, JSON.stringify(result.status === "needs_human" ? (result.handoff ?? { instructions: result.detail }) : null)]
      );
    },
    async finish(runId, status) {
      await db.query(
        `
          update setup_runs
          set
            status = $2,
            pending_handoff = case when $2 = 'paused_handoff' then pending_handoff else null end,
            finished_at = case when $2 = 'paused_handoff' then finished_at else now() end,
            updated_at = now()
          where id = $1
        `,
        [runId, status]
      );
    },
    async recordSetupState(runId, update) {
      await loadRun(runId);
      if (update.site) {
        const site = await upsertWorkspaceSite(db, update.site);
        if (site) {
          await db.query(
            "update setup_runs set site_id = $2, updated_at = now() where id = $1",
            [runId, site.id]
          );
          // Back-fill the GA4 source FK on the upserted primary site. upsertWorkspaceSite
          // (in @infinite-os/db) does not write ga4_source_id, so set it here. The outer
          // guard is what makes this idempotent: a source-less re-run never reaches this
          // UPDATE, so an existing link is never nulled. (ga4SourceId is always a non-empty
          // string here, so the write is unconditional.)
          if (update.site.ga4SourceId) {
            await db.query(
              "update workspace_sites set ga4_source_id = $2, updated_at = now() where id = $1",
              [site.id, update.site.ga4SourceId]
            );
          }
        }
      }
      const phaseStatePatch: Record<string, unknown> = {};
      if (update.interview) {
        phaseStatePatch.interview = update.interview;
      }
      if (update.selectedProviders) {
        phaseStatePatch.selectedProviders = update.selectedProviders;
      }
      if (update.recommendedProviders) {
        phaseStatePatch.recommendedProviders = update.recommendedProviders;
      }
      if (Object.keys(phaseStatePatch).length > 0) {
        await mergeSetupRunPhaseState(db, runId, phaseStatePatch);
      }
      if (update.provider && update.providerState) {
        await mergeSetupProviderState(db, runId, update.provider, update.providerState as Record<string, unknown>);
      }
      if (update.pendingHandoff !== undefined || update.browserProfile !== undefined) {
        await db.query(
          `
            update setup_runs
            set
              pending_handoff = case when $4 then $2::jsonb else pending_handoff end,
              browser_profile = case when $5 then $3 else browser_profile end,
              updated_at = now()
            where id = $1
          `,
          [
            runId,
            JSON.stringify(update.pendingHandoff ?? null),
            update.browserProfile ?? null,
            update.pendingHandoff !== undefined,
            update.browserProfile !== undefined
          ]
        );
      }
    },
    async getResolvedPublicArtifacts(workspaceId) {
      return readLatestSetupPublicArtifacts(db, workspaceId);
    }
  };
}

export interface AbandonedSetupRun {
  id: string;
  tool: string;
}

/**
 * Mark every active setup run for the workspace (optionally scoped to one tool)
 * as failed. Backs `infinite setup reset`: the manual escape hatch when a run
 * is wedged in 'running'/'paused_handoff' and holds the active-run lock.
 */
export async function abandonActiveSetupRuns(
  db: MinimalDb,
  workspaceId: string,
  tool?: string
): Promise<AbandonedSetupRun[]> {
  return db.query<AbandonedSetupRun>(
    `
      update setup_runs
      set status='failed', pending_handoff=null, finished_at=now(), updated_at=now()
      where workspace_id = $1
        and status in ('running','paused_handoff')
        and ($2::text is null or tool = $2)
      returning id, tool
    `,
    [workspaceId, tool ?? null]
  );
}
