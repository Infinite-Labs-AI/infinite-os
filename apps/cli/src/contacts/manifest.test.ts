import { describe, expect, it } from "vitest";
import type { AuthPerson } from "./auth-scan.js";
import {
  buildManifest,
  buildRows,
  formatCount,
  maskEmail,
  summarizeRefusals
} from "./manifest.js";

const FULL_DISCOVERY = {
  dataApiOff: false,
  keyRejected: false,
  table: "profiles",
  joinKey: "user_id",
  lastSeenColumn: "last_seen_at",
  planColumn: "plan",
  countryColumn: "country",
  cityColumn: "city"
};

const AUTH_ONLY_DISCOVERY = { dataApiOff: false, keyRejected: false };

function person(overrides: Partial<AuthPerson> = {}): AuthPerson {
  return {
    id: "u1",
    email: "john@gmail.com",
    createdAt: "2026-03-14T10:00:00Z",
    lastSignInAt: "2026-08-01T10:00:00Z",
    emailConfirmed: true,
    ...overrides
  };
}

describe("buildManifest", () => {
  it("maps every slot the cloud understands, with last-seen in its DEDICATED slot", () => {
    const manifest = buildManifest(FULL_DISCOVERY);
    expect(manifest.mapping).toEqual({
      email: "email",
      joined: "created_at",
      last_seen: "last_seen_at",
      plan: "plan",
      "custom:country": "country",
      "custom:city": "city"
    });
    // last-seen must NEVER ride in custom:*.
    expect(Object.keys(manifest.mapping)).not.toContain("custom:last_seen_at");
    expect(manifest.notes).toEqual([]);
  });

  it("falls back to auth.users.last_sign_in_at when profiles has no last-seen column", () => {
    const manifest = buildManifest(AUTH_ONLY_DISCOVERY);
    expect(manifest.mapping.last_seen).toBe("last_sign_in_at");
    const lastSeen = manifest.fields.find((field) => field.slot === "last_seen");
    expect(lastSeen?.source).toBe("auth.users.last_sign_in_at");
    expect(lastSeen?.from).toBe("auth");
  });

  it("states honest absences when a table WAS read: no plan column → Stripe note, no location → nothing-taken note", () => {
    const manifest = buildManifest({
      dataApiOff: false,
      keyRejected: false,
      table: "profiles",
      joinKey: "id",
      lastSeenColumn: "last_seen_at"
    });
    expect(manifest.mapping.plan).toBeUndefined();
    expect(manifest.notes).toEqual([
      "No plan column found — plan status will come from your Stripe connection instead.",
      "No location column found — we take nothing for location."
    ]);
  });

  it("never claims 'no plan column found' when no table was readable (trust rule 7)", () => {
    const manifest = buildManifest(AUTH_ONLY_DISCOVERY);
    expect(manifest.notes.join("\n")).not.toContain("No plan column found");
    expect(manifest.notes).toEqual([
      "Plan status will come from your Stripe connection instead.",
      "Location: nothing taken."
    ]);
  });

  it("names each field's real source column", () => {
    const manifest = buildManifest({
      ...FULL_DISCOVERY,
      table: "customers",
      planColumn: "subscription_status"
    });
    const plan = manifest.fields.find((field) => field.slot === "plan");
    expect(plan?.source).toBe("customers.subscription_status");
    expect(manifest.mapping.plan).toBe("subscription_status");
  });
});

describe("buildRows", () => {
  it("joins auth people with profile rows; every cell a string, empty when absent", () => {
    const manifest = buildManifest(FULL_DISCOVERY);
    const rows = buildRows(
      [person(), person({ id: "u2", email: "mary@x.co", lastSignInAt: "" })],
      new Map([
        ["u1", { last_seen_at: "2026-08-20", plan: "pro", country: "GB", city: "London" }]
      ]),
      manifest
    );
    expect(rows).toEqual([
      {
        email: "john@gmail.com",
        created_at: "2026-03-14T10:00:00Z",
        last_seen_at: "2026-08-20",
        plan: "pro",
        country: "GB",
        city: "London"
      },
      {
        email: "mary@x.co",
        created_at: "2026-03-14T10:00:00Z",
        last_seen_at: "",
        plan: "",
        country: "",
        city: ""
      }
    ]);
    for (const row of rows) {
      for (const value of Object.values(row)) expect(typeof value).toBe("string");
    }
  });

  it("uses auth last_sign_in_at values when the manifest fell back to auth", () => {
    const manifest = buildManifest(AUTH_ONLY_DISCOVERY);
    const rows = buildRows([person()], new Map(), manifest);
    expect(rows[0].last_sign_in_at).toBe("2026-08-01T10:00:00Z");
    expect(rows[0]).not.toHaveProperty("plan");
  });
});

describe("maskEmail", () => {
  it("masks the local part like j***@gmail.com", () => {
    expect(maskEmail("john@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("j@x.co")).toBe("j***@x.co");
  });
  it("degrades safely on malformed addresses", () => {
    expect(maskEmail("nope")).toBe("***");
    expect(maskEmail("@x.co")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });
});

describe("summarizeRefusals + formatCount", () => {
  it("groups refusals by reason, biggest first", () => {
    expect(
      summarizeRefusals([
        { reason: "invalid email" },
        { reason: "duplicate email" },
        { reason: "invalid email" },
        { reason: "invalid email" }
      ])
    ).toBe("3 × invalid email · 1 × duplicate email");
  });
  it("formats counts with separators", () => {
    expect(formatCount(2014)).toBe("2,014");
    expect(formatCount(8)).toBe("8");
  });
});
