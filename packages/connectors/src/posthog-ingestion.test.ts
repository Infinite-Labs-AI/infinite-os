import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { encryptCredentialPayload } from "@infinite-os/core";
import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { connectorFor, type SyncRequest } from "./index.js";

// End-to-end PostHog ingestion against a REAL (WASM Postgres) PGlite data dir — the same backend
// the desktop runs. Two behaviours the mock-db unit tests structurally cannot prove:
//   * the page cap's narrowed plan.cursorEnd actually reaches the generic CLOSE (cursor write,
//     source last_synced_at) AND posthogCloseSuccess's rollup window, and a FOLLOW-UP run resumes
//     from it and loses nothing (customer October's exact failure, in miniature);
//   * the bulk truth writer lands byte-identical rows to the per-row upsert loop it replaces,
//     including how many events fold onto one person / session / distinct_id.

const TEST_ENCRYPTION_KEY = "posthog-ingestion-pglite-test-key";

interface MockEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  person_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

function event(uuid: string, timestamp: string, overrides: Partial<MockEvent> = {}): MockEvent {
  return {
    uuid,
    event: "$pageview",
    distinct_id: `anon_${uuid}`,
    person_id: `person_${uuid}`,
    properties: { $session_id: `session_${uuid}`, $current_url: "/pricing", email: `${uuid}@example.com` },
    timestamp,
    ...overrides
  };
}

const COLUMNS = ["uuid", "event", "distinct_id", "person_id", "properties", "timestamp"];

function requiredLiteral(sql: string, pattern: RegExp): Date {
  const match = sql.match(pattern);
  if (!match) throw new Error(`HogQL query is missing ${pattern.source}:\n${sql}`);
  return new Date(`${match[1].replace(" ", "T")}Z`);
}

// The same literal-evaluating `events` stand-in as posthog-pagination.test.ts (deliberately
// duplicated rather than shared through a src module, which the package build would ship).
function evaluate(sql: string, events: MockEvent[]): unknown[][] {
  const lower = requiredLiteral(sql, /timestamp >= toDateTime\('([^']+)'\)/);
  const upper = requiredLiteral(sql, /timestamp < toDateTime\('([^']+)'\)/);
  const keyset = sql.match(
    /\(timestamp > toDateTime\('([^']+)'\) or \(timestamp = toDateTime\('([^']+)'\) and uuid > '([^']+)'\)\)/
  );
  const limitMatch = sql.match(/limit (\d+)/);
  if (!limitMatch) throw new Error(`HogQL query is missing a limit:\n${sql}`);

  const matched = events.filter((candidate) => {
    const ts = new Date(candidate.timestamp);
    if (ts < lower || ts >= upper) return false;
    if (!keyset) return true;
    const boundary = new Date(`${keyset[1].replace(" ", "T")}Z`);
    return ts > boundary || (ts.getTime() === boundary.getTime() && candidate.uuid > keyset[3]);
  });
  matched.sort((a, b) =>
    a.timestamp === b.timestamp ? a.uuid.localeCompare(b.uuid) : a.timestamp.localeCompare(b.timestamp)
  );
  return matched
    .slice(0, Number(limitMatch[1]))
    .map((row) => [
      row.uuid,
      row.event,
      row.distinct_id,
      row.person_id,
      JSON.stringify(row.properties),
      row.timestamp
    ]);
}

async function withPostHogFetch<T>(events: MockEvent[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: { query: string } };
    // sync() runs testConnection before extracting; that probe is not an events query.
    const payload = /select 1 as ok/.test(body.query.query)
      ? { results: [{ ok: 1 }] }
      : { columns: COLUMNS, results: evaluate(body.query.query, events) };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Delegating InfiniteOsDb that counts every statement issued, transactions included. */
function countingDb(inner: InfiniteOsDb, counter: { statements: number }): InfiniteOsDb {
  return {
    query: (sql, params) => {
      counter.statements += 1;
      return inner.query(sql, params);
    },
    one: (sql, params) => {
      counter.statements += 1;
      return inner.one(sql, params);
    },
    close: () => inner.close(),
    ensureWorkspace: (workspaceId, name) => inner.ensureWorkspace(workspaceId, name),
    ensureFirstPhaseDatasets: (workspaceId) => inner.ensureFirstPhaseDatasets(workspaceId),
    connectSource: (input) => inner.connectSource(input),
    updateSourceStatus: (sourceId, status, lastSyncedAt) =>
      inner.updateSourceStatus(sourceId, status, lastSyncedAt),
    createJob: (input) => inner.createJob(input),
    claimNextJob: (workerId, leaseSeconds) => inner.claimNextJob(workerId, leaseSeconds),
    completeJob: (jobId, status, error) => inner.completeJob(jobId, status, error),
    withTransaction: (fn) => inner.withTransaction((tx) => fn(countingDb(tx, counter)))
  } as InfiniteOsDb;
}

describe("PostHog ingestion against real PGlite", () => {
  let dataDir: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-posthog-ingestion-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedPostHogSource(
    workspaceId: string,
    sourceId: string,
    tuning: Record<string, unknown> = {}
  ): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.ensureWorkspace(workspaceId, workspaceId);
      await tx.ensureFirstPhaseDatasets(workspaceId);
    });
    const datasets = await db.query<{ id: string }>(
      "select id from datasets where workspace_id = $1 and key = 'web'",
      [workspaceId]
    );
    await db.query(
      `insert into sources (id, workspace_id, dataset_id, provider, connection_name, account_external_id, status)
       values ($1, $2, $3, 'posthog', 'conn', $1, 'connected')`,
      [sourceId, workspaceId, datasets[0]?.id]
    );
    await db.query(
      `insert into connection_credentials
        (id, workspace_id, source_id, credential_kind, encrypted_payload)
       values ($1,$2,$3,'personal_api_key',$4)`,
      [
        `cred_${randomUUID()}`,
        workspaceId,
        sourceId,
        encryptCredentialPayload(
          {
            mode: "live",
            projectId: 42,
            personalApiKey: "ph-key",
            apiHost: "https://posthog.test",
            ...tuning
          },
          TEST_ENCRYPTION_KEY
        )
      ]
    );
  }

  function posthogRequest(
    workspaceId: string,
    sourceId: string,
    window: { windowSince?: string; windowUntil?: string } = {}
  ): SyncRequest {
    return {
      workspaceId,
      sourceId,
      provider: "posthog",
      syncRunId: `run_${randomUUID()}`,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ...window
    };
  }

  async function cursorValue(sourceId: string): Promise<string | null> {
    const rows = await db.query<{ cursor_value: string }>(
      "select cursor_value from sync_cursors where source_id = $1 and cursor_key = 'posthog_event'",
      [sourceId]
    );
    return rows[0]?.cursor_value ?? null;
  }

  async function truthEventIds(sourceId: string): Promise<string[]> {
    const rows = await db.query<{ event_id: string }>(
      "select event_id from posthog_event_truth where source_id = $1 order by occurred_at, event_id",
      [sourceId]
    );
    return rows.map((row) => row.event_id);
  }

  async function rollupByDay(sourceId: string): Promise<Array<{ day: string; events: number }>> {
    const rows = await db.query<{ day: string; events: string }>(
      `select occurred_on::text as day, sum(event_count)::text as events
         from posthog_event_daily where source_id = $1 group by 1 order by 1`,
      [sourceId]
    );
    return rows.map((row) => ({ day: row.day, events: Number(row.events) }));
  }

  // ── (d) the page cap must never claim more window than it loaded ────────────────────────────
  it("advances the cursor only to the last loaded event when the page cap is hit, then resumes", async () => {
    const workspaceId = "ws_ph_cap";
    const sourceId = "src_ph_cap";
    await seedPostHogSource(workspaceId, sourceId, { pageSize: 2, maxPagesPerRun: 2 });
    const events = [
      event("evt_0", "2026-06-01T00:00:00.000Z"),
      event("evt_1", "2026-06-01T00:01:00.000Z"),
      event("evt_2", "2026-06-02T00:00:00.000Z"),
      event("evt_3", "2026-06-02T00:01:00.000Z"),
      event("evt_4", "2026-06-03T00:00:00.000Z"),
      event("evt_5", "2026-06-03T00:01:00.000Z")
    ];

    // Run 1: 2 pages x 2 rows = the cap, with two events still unread.
    const first = await withPostHogFetch(events, () =>
      connectorFor("posthog").sync(
        db,
        posthogRequest(workspaceId, sourceId, { windowSince: "2026-06-01T00:00:00.000Z" })
      )
    );

    expect(first.recordsLoaded).toBe(4);
    // NOT "now" (the requested window end) — the last event this run actually loaded.
    expect(first.cursorValue).toBe("2026-06-02T00:01:00.000Z");
    expect(await cursorValue(sourceId)).toBe("2026-06-02T00:01:00.000Z");
    expect(await truthEventIds(sourceId)).toEqual(["evt_0", "evt_1", "evt_2", "evt_3"]);
    // The rollup hook refreshed exactly the covered span — no day 3 row is invented.
    expect(await rollupByDay(sourceId)).toEqual([
      { day: "2026-06-01", events: 2 },
      { day: "2026-06-02", events: 2 }
    ]);
    const sourceAfterFirst = await db.query<{ status: string; last_synced_at: Date | string }>(
      "select status, last_synced_at from sources where id = $1",
      [sourceId]
    );
    expect(sourceAfterFirst[0]?.status).toBe("connected");
    expect(new Date(sourceAfterFirst[0]?.last_synced_at ?? "").toISOString()).toBe(
      "2026-06-02T00:01:00.000Z"
    );

    // Run 2 resumes from the stored cursor and drains the rest — nothing lost, nothing doubled.
    const second = await withPostHogFetch(events, () =>
      connectorFor("posthog").sync(db, posthogRequest(workspaceId, sourceId))
    );

    expect(second.recordsLoaded).toBe(3); // evt_3 is re-read at the inclusive boundary, then upserted
    expect(await truthEventIds(sourceId)).toEqual([
      "evt_0",
      "evt_1",
      "evt_2",
      "evt_3",
      "evt_4",
      "evt_5"
    ]);
    expect(await rollupByDay(sourceId)).toEqual([
      { day: "2026-06-01", events: 2 },
      { day: "2026-06-02", events: 2 },
      { day: "2026-06-03", events: 2 }
    ]);
    expect(new Date(String(await cursorValue(sourceId))).getTime()).toBeGreaterThan(
      new Date("2026-06-03T00:01:00.000Z").getTime()
    );
  }, 60_000);

  // ── (f) small sources must behave EXACTLY as before ─────────────────────────────────────────
  it("completes a small source end to end with the cursor at the window end", async () => {
    const workspaceId = "ws_ph_small";
    const sourceId = "src_ph_small";
    await seedPostHogSource(workspaceId, sourceId);
    const events = [
      event("small_0", "2026-06-01T00:00:00.000Z"),
      event("small_1", "2026-06-01T06:00:00.000Z"),
      event("small_2", "2026-06-01T12:00:00.000Z")
    ];

    const result = await withPostHogFetch(events, () =>
      connectorFor("posthog").sync(
        db,
        posthogRequest(workspaceId, sourceId, {
          windowSince: "2026-06-01T00:00:00.000Z",
          windowUntil: "2026-06-02T00:00:00.000Z"
        })
      )
    );

    expect(result).toMatchObject({
      recordsExtracted: 3,
      recordsLoaded: 3,
      cursorKey: "posthog_event",
      cursorValue: "2026-06-02T00:00:00.000Z"
    });
    expect(await cursorValue(sourceId)).toBe("2026-06-02T00:00:00.000Z");
    expect(await truthEventIds(sourceId)).toEqual(["small_0", "small_1", "small_2"]);
    expect(await rollupByDay(sourceId)).toEqual([{ day: "2026-06-01", events: 3 }]);
    const source = await db.query<{ status: string }>("select status from sources where id = $1", [
      sourceId
    ]);
    expect(source[0]?.status).toBe("connected");
  }, 60_000);

  // ── (e) bulk truth writes ───────────────────────────────────────────────────────────────────
  it("costs effectively no statements per additional event in a chunk", async () => {
    const smallCounter = { statements: 0 };
    const largeCounter = { statements: 0 };

    await seedPostHogSource("ws_ph_bulk_small", "src_ph_bulk_small");
    await withPostHogFetch(
      Array.from({ length: 20 }, (_, i) =>
        event(`bulk_s_${String(i).padStart(3, "0")}`, `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`)
      ),
      () =>
        connectorFor("posthog").sync(
          countingDb(db, smallCounter),
          posthogRequest("ws_ph_bulk_small", "src_ph_bulk_small", {
            windowSince: "2026-06-01T00:00:00.000Z",
            windowUntil: "2026-06-02T00:00:00.000Z"
          })
        )
    );

    await seedPostHogSource("ws_ph_bulk_large", "src_ph_bulk_large");
    await withPostHogFetch(
      Array.from({ length: 400 }, (_, i) =>
        event(
          `bulk_l_${String(i).padStart(3, "0")}`,
          new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 60_000).toISOString()
        )
      ),
      () =>
        connectorFor("posthog").sync(
          countingDb(db, largeCounter),
          posthogRequest("ws_ph_bulk_large", "src_ph_bulk_large", {
            windowSince: "2026-06-01T00:00:00.000Z",
            windowUntil: "2026-06-02T00:00:00.000Z"
          })
        )
    );

    expect(await truthEventIds("src_ph_bulk_large")).toHaveLength(400);
    // 20 events and 400 events both land in ONE SYNC_BATCH_CHUNK_SIZE chunk, so the only thing
    // that differs is how the truth writer scales. The per-row writer spent EIGHT statements per
    // event (four upserts + four lineage rows) — that is what made a 92k-event source impossible
    // inside the 900s worker. A bulk writer's marginal cost per event must round to nothing.
    const marginalStatementsPerEvent = (largeCounter.statements - smallCounter.statements) / 380;
    expect(marginalStatementsPerEvent).toBeLessThan(0.05);
  }, 120_000);

  it("folds many events onto one person, session, and distinct id exactly like the per-row writer", async () => {
    const workspaceId = "ws_ph_fold";
    const sourceId = "src_ph_fold";
    await seedPostHogSource(workspaceId, sourceId);
    // Three events, one person, one session, one distinct id, ordered in time. The per-row loop
    // kept the FIRST row's insert-only columns and let the LAST row win every updatable one.
    const shared = {
      distinct_id: "anon_shared",
      person_id: "person_shared"
    };
    const events = [
      event("fold_0", "2026-07-01T00:00:00.000Z", {
        ...shared,
        properties: { $session_id: "session_shared", $current_url: "/first", email: "first@example.com" }
      }),
      event("fold_1", "2026-07-01T00:10:00.000Z", {
        ...shared,
        properties: { $session_id: "session_shared", $current_url: "/second", email: "second@example.com" }
      }),
      event("fold_2", "2026-07-01T00:20:00.000Z", {
        ...shared,
        properties: { $session_id: "session_shared", $current_url: "/third", email: "third@example.com" }
      })
    ];

    await withPostHogFetch(events, () =>
      connectorFor("posthog").sync(
        db,
        posthogRequest(workspaceId, sourceId, {
          windowSince: "2026-07-01T00:00:00.000Z",
          windowUntil: "2026-07-02T00:00:00.000Z"
        })
      )
    );

    const persons = await db.query<{ person_id: string; email: string; created_at_source: Date | string; raw_record_id: string; properties: Record<string, unknown> }>(
      "select person_id, email, created_at_source, raw_record_id, properties from posthog_person_current where source_id = $1",
      [sourceId]
    );
    expect(persons).toHaveLength(1);
    // LAST row wins the updatable columns…
    expect(persons[0]?.email).toBe("third@example.com");
    expect(persons[0]?.properties).toMatchObject({ email: "third@example.com" });
    // …while the insert-only columns keep the FIRST row's values.
    expect(new Date(persons[0]?.created_at_source ?? "").toISOString()).toBe("2026-07-01T00:00:00.000Z");

    const sessions = await db.query<{
      session_id: string;
      started_at: Date | string;
      ended_at: Date | string;
      landing_page: string;
    }>(
      "select session_id, started_at, ended_at, landing_page from posthog_session_fact where source_id = $1",
      [sourceId]
    );
    expect(sessions).toHaveLength(1);
    expect(new Date(sessions[0]?.started_at ?? "").toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(new Date(sessions[0]?.ended_at ?? "").toISOString()).toBe("2026-07-01T00:20:00.000Z");
    expect(sessions[0]?.landing_page).toBe("/first");

    const distinctIds = await db.query<{ distinct_id: string; person_id: string }>(
      "select distinct_id, person_id from posthog_person_distinct_ids where source_id = $1",
      [sourceId]
    );
    expect(distinctIds).toEqual([{ distinct_id: "anon_shared", person_id: "person_shared" }]);

    // One lineage row per (table, business key, raw record) — four tables x three events, minus
    // the two person/session/distinct rows that reuse the SAME business key under a new raw id.
    const lineage = await db.query<{ provider_table: string; n: string }>(
      `select provider_table, count(*)::text as n from record_lineage
        where workspace_id = $1 and provider = 'posthog' group by 1 order by 1`,
      [workspaceId]
    );
    expect(lineage).toEqual([
      { provider_table: "posthog_event_truth", n: "3" },
      { provider_table: "posthog_person_current", n: "3" },
      { provider_table: "posthog_person_distinct_ids", n: "3" },
      { provider_table: "posthog_session_fact", n: "3" }
    ]);
  }, 60_000);

  it("re-points raw_record_id and refreshes properties when the same events are synced again", async () => {
    const workspaceId = "ws_ph_resync";
    const sourceId = "src_ph_resync";
    await seedPostHogSource(workspaceId, sourceId);
    const first = [
      event("resync_0", "2026-07-05T00:00:00.000Z", {
        properties: { $session_id: "session_resync", $current_url: "/v1", email: "v1@example.com" }
      })
    ];
    const second = [
      event("resync_0", "2026-07-05T00:00:00.000Z", {
        properties: { $session_id: "session_resync", $current_url: "/v2", email: "v2@example.com" }
      })
    ];
    const window = {
      windowSince: "2026-07-05T00:00:00.000Z",
      windowUntil: "2026-07-06T00:00:00.000Z"
    };

    await withPostHogFetch(first, () =>
      connectorFor("posthog").sync(db, posthogRequest(workspaceId, sourceId, window))
    );
    const beforeRows = await db.query<{ raw_record_id: string; properties: Record<string, unknown> }>(
      "select raw_record_id, properties from posthog_event_truth where source_id = $1",
      [sourceId]
    );

    await withPostHogFetch(second, () =>
      connectorFor("posthog").sync(db, posthogRequest(workspaceId, sourceId, window))
    );
    const afterRows = await db.query<{ raw_record_id: string; properties: Record<string, unknown> }>(
      "select raw_record_id, properties from posthog_event_truth where source_id = $1",
      [sourceId]
    );

    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.properties).toMatchObject({ $current_url: "/v2" });
    expect(afterRows[0]?.raw_record_id).not.toBe(beforeRows[0]?.raw_record_id);
  }, 60_000);

  it("writes every row when a chunk does not divide evenly into the write chunk size", async () => {
    const workspaceId = "ws_ph_remainder";
    const sourceId = "src_ph_remainder";
    await seedPostHogSource(workspaceId, sourceId);
    // 501 events: one full 500-row write chunk plus a 1-row remainder.
    const events = Array.from({ length: 501 }, (_, i) =>
      event(
        `rem_${String(i).padStart(4, "0")}`,
        new Date(Date.parse("2026-07-10T00:00:00.000Z") + i * 1_000).toISOString()
      )
    );

    const result = await withPostHogFetch(events, () =>
      connectorFor("posthog").sync(
        db,
        posthogRequest(workspaceId, sourceId, {
          windowSince: "2026-07-10T00:00:00.000Z",
          windowUntil: "2026-07-11T00:00:00.000Z"
        })
      )
    );

    expect(result.recordsLoaded).toBe(501);
    expect(await truthEventIds(sourceId)).toHaveLength(501);
    const sessions = await db.query<{ n: string }>(
      "select count(*)::text as n from posthog_session_fact where source_id = $1",
      [sourceId]
    );
    expect(sessions[0]?.n).toBe("501");
  }, 120_000);
});
