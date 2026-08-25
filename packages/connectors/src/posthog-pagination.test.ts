import { describe, expect, it } from "vitest";

import { encryptCredentialPayload } from "@infinite-os/core";
import { type InfiniteOsDb } from "@infinite-os/db";

import { connectorFor, type SyncPlan, type SyncRequest } from "./index.js";

// PostHog extraction is the only place the 900s cloud worker budget can be blown: the old
// extractor issued ONE unbounded `limit 10000` query, so a source with real volume (October:
// ~92k events) could never converge and its cursor never advanced past the empty string.
// These tests drive the REAL extractor against a mock that EVALUATES the emitted HogQL bounds,
// so a missing upper bound or a skipped keyset row is a hard failure, not a silent gap.

const TEST_ENCRYPTION_KEY = "posthog-pagination-test-key";

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
    properties: { $session_id: `session_${uuid}`, $current_url: "/pricing" },
    timestamp,
    ...overrides
  };
}

/**
 * A faithful stand-in for the `events` table. It does NOT parse arbitrary SQL — it extracts the
 * exact literals this extractor is contracted to emit (window bounds, keyset continuation, order,
 * limit) and applies them. A query that omits a bound throws, which is what makes the
 * "upper bound is honored" and "keyset never skips" assertions real rather than textual.
 */
function posthogEventsMock(events: MockEvent[]) {
  const queries: string[] = [];
  const handler = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { query: { query: string } };
    const sql = body.query.query;
    queries.push(sql);
    return new Response(JSON.stringify({ columns: COLUMNS, results: evaluate(sql, events) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  return { queries, handler };
}

const COLUMNS = ["uuid", "event", "distinct_id", "person_id", "properties", "timestamp"];

function requiredLiteral(sql: string, pattern: RegExp): Date {
  const match = sql.match(pattern);
  if (!match) {
    throw new Error(`HogQL query is missing ${pattern.source}:\n${sql}`);
  }
  return new Date(`${match[1].replace(" ", "T")}Z`);
}

function evaluate(sql: string, events: MockEvent[]): unknown[][] {
  if (!/order by timestamp asc, uuid asc/.test(sql)) {
    throw new Error(`HogQL query must order by (timestamp, uuid) for keyset paging:\n${sql}`);
  }
  const lower = requiredLiteral(sql, /timestamp >= toDateTime\('([^']+)'\)/);
  const upper = requiredLiteral(sql, /timestamp < toDateTime\('([^']+)'\)/);
  const keyset = sql.match(
    /\(timestamp > toDateTime\('([^']+)'\) or \(timestamp = toDateTime\('([^']+)'\) and uuid > '([^']+)'\)\)/
  );
  const limitMatch = sql.match(/limit (\d+)/);
  if (!limitMatch) {
    throw new Error(`HogQL query is missing a limit:\n${sql}`);
  }
  const limit = Number(limitMatch[1]);

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
    .slice(0, limit)
    .map((row) => [
      row.uuid,
      row.event,
      row.distinct_id,
      row.person_id,
      JSON.stringify(row.properties),
      row.timestamp
    ]);
}

async function withMockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function credentialDb(payload: Record<string, unknown>): InfiniteOsDb {
  const encrypted = encryptCredentialPayload(
    { mode: "live", projectId: 42, personalApiKey: "ph-key", apiHost: "https://posthog.test", ...payload },
    TEST_ENCRYPTION_KEY
  );
  return {
    async one<T>(sql: string): Promise<T | null> {
      if (sql.includes("connection_credentials")) {
        return {
          credential_kind: "personal_api_key",
          encrypted_payload: encrypted,
          oauth_token_id: null
        } as T;
      }
      return null;
    },
    async query<T>(): Promise<T[]> {
      return [];
    }
  } as unknown as InfiniteOsDb;
}

function posthogRequest(): SyncRequest {
  return {
    workspaceId: "workspace",
    sourceId: "source_posthog",
    provider: "posthog",
    syncRunId: "sync_posthog",
    encryptionKey: TEST_ENCRYPTION_KEY
  };
}

function plan(cursorStart: string | null, cursorEnd: string): SyncPlan {
  return { cursorKey: "posthog_event", cursorStart, cursorEnd, refreshWindowDays: 7, mode: "live" };
}

describe("PostHog bounded keyset extraction", () => {
  it("pages a window with keyset continuation until it is exhausted", async () => {
    // 25 events, one per minute, page size 10 → 3 pages (10 + 10 + 5).
    const events = Array.from({ length: 25 }, (_, i) =>
      event(`evt_${String(i).padStart(2, "0")}`, `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`)
    );
    const mock = posthogEventsMock(events);

    await withMockFetch(mock.handler, async () => {
      const rows = await connectorFor("posthog").extract(
        credentialDb({ pageSize: 10 }),
        posthogRequest(),
        plan("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z")
      );

      expect(rows.map((row) => row.externalId)).toEqual(events.map((e) => `posthog:${e.uuid}`));
      expect(mock.queries).toHaveLength(3);
      // Page 1 carries no continuation; pages 2 and 3 resume from the previous page's last key.
      expect(mock.queries[0]).not.toContain("uuid >");
      expect(mock.queries[1]).toContain("toDateTime('2026-06-01 00:09:00')");
      expect(mock.queries[1]).toContain("uuid > 'evt_09'");
      expect(mock.queries[2]).toContain("toDateTime('2026-06-01 00:19:00')");
      expect(mock.queries[2]).toContain("uuid > 'evt_19'");
    });
  });

  it("never skips events that share a timestamp across a page boundary", async () => {
    // Five events at the SAME instant straddle the page-2 boundary. A timestamp-only cursor
    // (`timestamp > last`) would drop the ones after the boundary uuid; the keyset tie-break
    // must keep every one of them.
    const tied = ["a", "b", "c", "d", "e"].map((suffix) =>
      event(`evt_tie_${suffix}`, "2026-06-01T00:05:00.000Z")
    );
    const events = [
      event("evt_00", "2026-06-01T00:00:00.000Z"),
      event("evt_01", "2026-06-01T00:01:00.000Z"),
      ...tied,
      event("evt_09", "2026-06-01T00:09:00.000Z")
    ];
    const mock = posthogEventsMock(events);

    await withMockFetch(mock.handler, async () => {
      const rows = await connectorFor("posthog").extract(
        credentialDb({ pageSize: 3 }),
        posthogRequest(),
        plan("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z")
      );

      expect(rows.map((row) => row.externalId).sort()).toEqual(
        events.map((e) => `posthog:${e.uuid}`).sort()
      );
    });
  });

  it("never requests or returns events at or after the plan's window end", async () => {
    const events = [
      event("evt_in_1", "2026-06-01T00:00:00.000Z"),
      event("evt_in_2", "2026-06-01T23:59:59.000Z"),
      event("evt_edge", "2026-06-02T00:00:00.000Z"),
      event("evt_after", "2026-06-03T12:00:00.000Z")
    ];
    const mock = posthogEventsMock(events);

    await withMockFetch(mock.handler, async () => {
      const rows = await connectorFor("posthog").extract(
        credentialDb({}),
        posthogRequest(),
        plan("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z")
      );

      expect(rows.map((row) => row.externalId)).toEqual(["posthog:evt_in_1", "posthog:evt_in_2"]);
      for (const query of mock.queries) {
        expect(query).toContain("timestamp < toDateTime('2026-06-02 00:00:00')");
      }
    });
  });

  it("narrows the plan's cursorEnd to the last loaded event when the page cap is hit", async () => {
    // 6 events, page size 2, cap 2 pages → only 4 land. The run must NOT claim the whole window.
    const events = Array.from({ length: 6 }, (_, i) =>
      event(`evt_${i}`, `2026-06-01T00:0${i}:00.000Z`)
    );
    const mock = posthogEventsMock(events);
    const runPlan = plan("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");

    await withMockFetch(mock.handler, async () => {
      const rows = await connectorFor("posthog").extract(
        credentialDb({ pageSize: 2, maxPagesPerRun: 2 }),
        posthogRequest(),
        runPlan
      );

      expect(rows).toHaveLength(4);
      expect(mock.queries).toHaveLength(2);
      expect(runPlan.cursorEnd).toBe("2026-06-01T00:03:00.000Z");
    });
  });

  it("leaves the plan's cursorEnd alone when the window is fully drained", async () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      event(`evt_${i}`, `2026-06-01T00:0${i}:00.000Z`)
    );
    const mock = posthogEventsMock(events);
    const runPlan = plan("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");

    await withMockFetch(mock.handler, async () => {
      const rows = await connectorFor("posthog").extract(
        credentialDb({ pageSize: 10, maxPagesPerRun: 2 }),
        posthogRequest(),
        runPlan
      );

      expect(rows).toHaveLength(3);
      expect(runPlan.cursorEnd).toBe("2026-06-02T00:00:00.000Z");
    });
  });

  it("returns no records and asks once when the window is empty", async () => {
    const mock = posthogEventsMock([]);
    const runPlan = plan("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");

    await withMockFetch(mock.handler, async () => {
      await expect(
        connectorFor("posthog").extract(credentialDb({}), posthogRequest(), runPlan)
      ).resolves.toEqual([]);
      expect(mock.queries).toHaveLength(1);
      expect(runPlan.cursorEnd).toBe("2026-06-02T00:00:00.000Z");
    });
  });
});
