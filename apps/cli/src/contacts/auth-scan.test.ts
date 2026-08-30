import { describe, expect, it, vi } from "vitest";
import { applyExclusionPass, scanAuthUsers } from "./auth-scan.js";
import { ContactsSyncError } from "./sync-error.js";

const NOW = new Date("2026-08-30T12:00:00Z");

function user(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "u1",
    email: "john@gmail.com",
    created_at: "2026-03-14T10:00:00Z",
    last_sign_in_at: "2026-08-01T10:00:00Z",
    email_confirmed_at: "2026-03-14T10:05:00Z",
    ...overrides
  };
}

describe("applyExclusionPass (trust rule 8)", () => {
  it("drops and counts soft-deleted, banned, and no-email users", () => {
    const report = applyExclusionPass(
      [
        user({ id: "keep" }),
        user({ id: "gone", deleted_at: "2026-01-01T00:00:00Z" }),
        user({ id: "banned", banned_until: "2027-01-01T00:00:00Z" }),
        user({ id: "noemail", email: "" })
      ],
      NOW
    );
    expect(report.kept.map((person) => person.id)).toEqual(["keep"]);
    expect(report.droppedDeleted).toBe(1);
    expect(report.droppedBanned).toBe(1);
    expect(report.droppedNoEmail).toBe(1);
  });

  it("keeps a user whose ban has already expired", () => {
    const report = applyExclusionPass([user({ banned_until: "2026-01-01T00:00:00Z" })], NOW);
    expect(report.kept).toHaveLength(1);
    expect(report.droppedBanned).toBe(0);
  });

  it("counts unconfirmed emails but KEEPS them", () => {
    const report = applyExclusionPass(
      [user(), user({ id: "u2", email: "mary@x.co", email_confirmed_at: null })],
      NOW
    );
    expect(report.kept).toHaveLength(2);
    expect(report.unconfirmedKept).toBe(1);
  });

  it("a deleted no-email user counts once, as deleted", () => {
    const report = applyExclusionPass(
      [user({ email: "", deleted_at: "2026-01-01T00:00:00Z" })],
      NOW
    );
    expect(report.droppedDeleted).toBe(1);
    expect(report.droppedNoEmail).toBe(0);
  });

  it("reduces kept users to exactly the allowlisted fields", () => {
    const report = applyExclusionPass(
      [user({ encrypted_password: "hash-never-kept", raw_user_meta_data: { a: 1 } })],
      NOW
    );
    expect(report.kept[0]).toEqual({
      id: "u1",
      email: "john@gmail.com",
      createdAt: "2026-03-14T10:00:00Z",
      lastSignInAt: "2026-08-01T10:00:00Z",
      emailConfirmed: true
    });
  });
});

describe("scanAuthUsers paging", () => {
  it("pages with x-total-count and tolerates an unreadable page (counted, never silent)", async () => {
    const pages: Record<string, { status: number; users?: unknown[] }> = {
      "1": { status: 200, users: [user({ id: "a", email: "a@x.co" }), user({ id: "b", email: "b@x.co" })] },
      "2": { status: 500 },
      "3": { status: 200, users: [user({ id: "c", email: "c@x.co" })] }
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page") ?? "1";
      const entry = pages[page] ?? { status: 200, users: [] };
      return new Response(JSON.stringify({ users: entry.users ?? [] }), {
        status: entry.status,
        headers: { "content-type": "application/json", "x-total-count": "5" }
      });
    }) as unknown as typeof fetch;

    const result = await scanAuthUsers({
      supabaseUrl: "https://abc.supabase.co",
      serviceKey: "sk-secret",
      fetchImpl,
      perPage: 2,
      now: NOW
    });
    expect(result.kept.map((person) => person.id)).toEqual(["a", "b", "c"]);
    expect(result.unreadablePages).toBe(1);
    expect(result.totalListed).toBe(3);
    // The key travels in headers only — never in the URL.
    for (const call of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).not.toContain("sk-secret");
    }
  });

  it("without a total header, stops after a short page", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page");
      const users =
        page === "1"
          ? [user({ id: "a", email: "a@x.co" }), user({ id: "b", email: "b@x.co" })]
          : [user({ id: "c", email: "c@x.co" })];
      return new Response(JSON.stringify({ users }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const result = await scanAuthUsers({
      supabaseUrl: "https://abc.supabase.co",
      serviceKey: "sk",
      fetchImpl,
      perPage: 2,
      now: NOW
    });
    expect(result.totalListed).toBe(3);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("throws a typed error when the service key is rejected on page 1", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 401 })
    ) as unknown as typeof fetch;
    await expect(
      scanAuthUsers({
        supabaseUrl: "https://abc.supabase.co",
        serviceKey: "sk-secret",
        fetchImpl,
        now: NOW
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ContactsSyncError);
      expect((error as ContactsSyncError).code).toBe("auth_admin_rejected");
      // The rejection message must never carry the key itself.
      expect((error as ContactsSyncError).message).not.toContain("sk-secret");
      return true;
    });
  });

  it("without a total header, a run of dead pages ends the scan with the count reported", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 500 })
    ) as unknown as typeof fetch;
    const result = await scanAuthUsers({
      supabaseUrl: "https://abc.supabase.co",
      serviceKey: "sk",
      fetchImpl,
      perPage: 2,
      now: NOW
    });
    expect(result.totalListed).toBe(0);
    expect(result.unreadablePages).toBe(2);
  });
});
