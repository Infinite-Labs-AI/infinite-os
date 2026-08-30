import { describe, expect, it, vi } from "vitest";
import {
  discoverProfileTable,
  fetchProfileRows,
  fetchSampleProfileRow
} from "./profile-discovery.js";

interface FakeTable {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/** Serve PostgREST probes + reads for a set of fake tables. */
function fakeRest(tables: Record<string, FakeTable>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const match = /^\/rest\/v1\/([^/?]+)$/.exec(url.pathname);
    if (!match) return new Response("{}", { status: 500 });
    const table = tables[decodeURIComponent(match[1])];
    if (!table) return new Response("[]", { status: 404 });
    const select = (url.searchParams.get("select") ?? "").split(",").filter(Boolean);
    if (select.some((column) => !table.columns.includes(column))) {
      return new Response(JSON.stringify({ code: "42703" }), { status: 400 });
    }
    let rows = table.rows;
    for (const [key, value] of url.searchParams.entries()) {
      if (["select", "limit", "offset", "order"].includes(key)) continue;
      if (value.startsWith("eq.")) {
        const wanted = value.slice(3);
        rows = rows.filter((row) => String(row[key]) === wanted);
      }
    }
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? String(rows.length));
    const page = rows.slice(offset, offset + limit).map((row) => {
      const projected: Record<string, unknown> = {};
      for (const column of select) projected[column] = row[column];
      return projected;
    });
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

const HTTP = (fetchImpl: typeof fetch) => ({
  supabaseUrl: "https://abc.supabase.co",
  serviceKey: "sk-secret",
  fetchImpl
});

describe("discoverProfileTable", () => {
  it("prefers user_id over id as the join key when both exist", async () => {
    const fetchImpl = fakeRest({
      profiles: { columns: ["id", "user_id", "plan"], rows: [] }
    });
    const discovery = await discoverProfileTable(HTTP(fetchImpl));
    expect(discovery.table).toBe("profiles");
    expect(discovery.joinKey).toBe("user_id");
  });

  it("falls back to id when user_id is absent", async () => {
    const fetchImpl = fakeRest({ profiles: { columns: ["id"], rows: [] } });
    const discovery = await discoverProfileTable(HTTP(fetchImpl));
    expect(discovery.joinKey).toBe("id");
  });

  it("ranks last-seen and plan candidates in the pinned order", async () => {
    const fetchImpl = fakeRest({
      profiles: {
        columns: ["id", "last_seen_at", "last_active_at", "tier", "subscription_status"],
        rows: []
      }
    });
    const discovery = await discoverProfileTable(HTTP(fetchImpl));
    expect(discovery.lastSeenColumn).toBe("last_seen_at");
    // No `plan` column → `tier` outranks `subscription_status`.
    expect(discovery.planColumn).toBe("tier");
  });

  it("takes country and city together when both exist, country-only otherwise", async () => {
    const both = await discoverProfileTable(
      HTTP(fakeRest({ profiles: { columns: ["id", "country", "city"], rows: [] } }))
    );
    expect(both.countryColumn).toBe("country");
    expect(both.cityColumn).toBe("city");
    const countryOnly = await discoverProfileTable(
      HTTP(fakeRest({ profiles: { columns: ["id", "country"], rows: [] } }))
    );
    expect(countryOnly.countryColumn).toBe("country");
    expect(countryOnly.cityColumn).toBeUndefined();
  });

  it("moves down the table candidate list when profiles is missing", async () => {
    const fetchImpl = fakeRest({ customers: { columns: ["user_id", "plan"], rows: [] } });
    const discovery = await discoverProfileTable(HTTP(fetchImpl));
    expect(discovery.table).toBe("customers");
    expect(discovery.planColumn).toBe("plan");
  });

  it("reports the Data API as off when EVERYTHING answers 404 — never 'no plan column'", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 })
    ) as unknown as typeof fetch;
    const discovery = await discoverProfileTable(HTTP(fetchImpl));
    expect(discovery.dataApiOff).toBe(true);
    expect(discovery.table).toBeUndefined();
  });

  it("reports a rejected key distinctly from a disabled API", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 401 })
    ) as unknown as typeof fetch;
    const discovery = await discoverProfileTable(HTTP(fetchImpl));
    expect(discovery.keyRejected).toBe(true);
    expect(discovery.dataApiOff).toBe(false);
  });

  it("probes a user-named table when asked", async () => {
    const fetchImpl = fakeRest({ members: { columns: ["user_id", "plan"], rows: [] } });
    const discovery = await discoverProfileTable(HTTP(fetchImpl), ["members"]);
    expect(discovery.table).toBe("members");
  });
});

describe("fetchProfileRows", () => {
  it("selects ONLY the join key + chosen columns and keys rows by join value, stringified", async () => {
    const fetchImpl = fakeRest({
      profiles: {
        columns: ["user_id", "last_seen_at", "plan", "country", "secret_notes"],
        rows: [
          { user_id: "u1", last_seen_at: "2026-08-20", plan: "pro", country: "GB", secret_notes: "x" },
          { user_id: "u2", last_seen_at: null, plan: 3, country: "", secret_notes: "y" }
        ]
      }
    });
    const rows = await fetchProfileRows(HTTP(fetchImpl), {
      dataApiOff: false,
      keyRejected: false,
      table: "profiles",
      joinKey: "user_id",
      lastSeenColumn: "last_seen_at",
      planColumn: "plan",
      countryColumn: "country"
    });
    expect(rows.get("u1")).toEqual({ last_seen_at: "2026-08-20", plan: "pro", country: "GB" });
    expect(rows.get("u2")).toEqual({ last_seen_at: "", plan: "3", country: "" });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      expect(String(call[0])).not.toContain("secret_notes");
      expect(String(call[0])).not.toContain("*");
    }
  });
});

describe("fetchSampleProfileRow", () => {
  it("reads ONE named row and degrades to undefined on failure", async () => {
    const fetchImpl = fakeRest({
      profiles: {
        columns: ["user_id", "plan"],
        rows: [{ user_id: "u1", plan: "pro" }]
      }
    });
    const discovery = {
      dataApiOff: false,
      keyRejected: false,
      table: "profiles",
      joinKey: "user_id",
      planColumn: "plan"
    };
    expect(await fetchSampleProfileRow(HTTP(fetchImpl), discovery, "u1")).toEqual({
      plan: "pro"
    });
    expect(await fetchSampleProfileRow(HTTP(fetchImpl), discovery, "missing")).toBeUndefined();
    const broken = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchSampleProfileRow(HTTP(broken), discovery, "u1")).toBeUndefined();
  });
});
