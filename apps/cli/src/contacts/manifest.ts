/**
 * The field manifest + row building for `infinite contacts sync`.
 *
 * The manifest is the CONSENT SURFACE (trust rules 1 and 4): every field
 * printed names its source column and what it unlocks, and only those columns
 * are ever read or sent. Absences are stated, never inferred (trust rule 7).
 *
 * The wire mapping mirrors the cloud importer's slots exactly
 * (`parseContactRecords` in 1bu-1's csv-parser): `email` (required), `joined`
 * (→ arrival date), `plan`, `last_seen` (the DEDICATED slot — last-seen never
 * rides in `custom:*`), plus `custom:country` / `custom:city` for location.
 */
import type { AuthPerson } from "./auth-scan.js";
import type { ProfileDiscovery } from "./profile-discovery.js";

/** The cloud route refuses more; the CLI refuses FIRST with split guidance. */
export const MAX_SYNC_ROWS = 25_000;

export interface ManifestField {
  /** The wire mapping slot this field lands in. */
  slot: "email" | "joined" | "last_seen" | "plan" | "custom:country" | "custom:city";
  /** The printed manifest label ("email", "joined", "last seen", …). */
  label: string;
  /** The printed source ("auth.users.email", "profiles.plan", …). */
  source: string;
  /** The column name used as the row key AND the mapping value. */
  rowKey: string;
  /** What the field unlocks — stated out loud (trust rule 4). */
  purpose: string;
  from: "auth" | "profile";
}

export interface ContactsManifest {
  fields: ManifestField[];
  /** The wire mapping: slot → row column name. */
  mapping: Record<string, string>;
  /** Honest-absence lines to print under the manifest (trust rule 7). */
  notes: string[];
}

/**
 * Build the manifest from discovery. Email + joined always come from
 * auth.users; last seen prefers the profiles column and falls back to
 * auth.users.last_sign_in_at (a legitimate source when profiles has nothing);
 * plan and location appear only when a real column exists.
 */
export function buildManifest(discovery: ProfileDiscovery): ContactsManifest {
  const fields: ManifestField[] = [];
  const notes: string[] = [];
  const table = discovery.table;

  fields.push({
    slot: "email",
    label: "email",
    source: "auth.users.email",
    rowKey: "email",
    purpose: "who they are (required)",
    from: "auth"
  });
  fields.push({
    slot: "joined",
    label: "joined",
    source: "auth.users.created_at",
    rowKey: "created_at",
    purpose: 'arrived-at → "never came back"',
    from: "auth"
  });

  if (table && discovery.lastSeenColumn) {
    fields.push({
      slot: "last_seen",
      label: "last seen",
      source: `${table}.${discovery.lastSeenColumn}`,
      rowKey: discovery.lastSeenColumn,
      purpose: '→ "went quiet"',
      from: "profile"
    });
  } else {
    fields.push({
      slot: "last_seen",
      label: "last seen",
      source: "auth.users.last_sign_in_at",
      rowKey: "last_sign_in_at",
      purpose: '→ "went quiet"',
      from: "auth"
    });
  }

  if (table && discovery.planColumn) {
    fields.push({
      slot: "plan",
      label: "plan",
      source: `${table}.${discovery.planColumn}`,
      rowKey: discovery.planColumn,
      purpose: "free vs paid → different campaigns",
      from: "profile"
    });
  } else if (table) {
    // "No plan column found" is only claimed when we actually LOOKED at a
    // table's columns — a disabled Data API or missing table says that
    // instead (trust rule 7's exact trap).
    notes.push(
      "No plan column found — plan status will come from your Stripe connection instead."
    );
  } else {
    notes.push("Plan status will come from your Stripe connection instead.");
  }

  if (table && discovery.countryColumn) {
    fields.push({
      slot: "custom:country",
      label: "country",
      source: `${table}.${discovery.countryColumn}`,
      rowKey: discovery.countryColumn,
      purpose: "send windows, personalisation",
      from: "profile"
    });
  }
  if (table && discovery.cityColumn) {
    fields.push({
      slot: "custom:city",
      label: "city",
      source: `${table}.${discovery.cityColumn}`,
      rowKey: discovery.cityColumn,
      purpose: "personalisation",
      from: "profile"
    });
  }
  if (table && !discovery.countryColumn && !discovery.cityColumn) {
    notes.push("No location column found — we take nothing for location.");
  } else if (!table) {
    notes.push("Location: nothing taken.");
  }

  const mapping: Record<string, string> = {};
  for (const field of fields) mapping[field.slot] = field.rowKey;
  return { fields, mapping, notes };
}

/**
 * Strip the profile-sourced fields from a manifest (used when the post-consent
 * profiles read fails): auth fields stay, last seen falls back to
 * auth.users.last_sign_in_at. Taking LESS than was consented to is always
 * allowed; taking more never is.
 */
export function manifestWithoutProfileFields(): ContactsManifest {
  return buildManifest({ dataApiOff: false, keyRejected: false });
}

const AUTH_ROW_VALUES: Record<string, (person: AuthPerson) => string> = {
  email: (person) => person.email,
  created_at: (person) => person.createdAt,
  last_sign_in_at: (person) => person.lastSignInAt
};

/**
 * Build the wire rows: one flat Record<string,string> per person, auth fields
 * joined with the profiles row on the join key, every value a string, empty
 * string when absent.
 */
export function buildRows(
  people: AuthPerson[],
  profileRowsByJoinValue: ReadonlyMap<string, Record<string, string>>,
  manifest: ContactsManifest
): Array<Record<string, string>> {
  return people.map((person) => {
    const profileRow = profileRowsByJoinValue.get(person.id);
    const row: Record<string, string> = {};
    for (const field of manifest.fields) {
      if (field.from === "auth") {
        row[field.rowKey] = AUTH_ROW_VALUES[field.rowKey]?.(person) ?? "";
      } else {
        row[field.rowKey] = profileRow?.[field.rowKey] ?? "";
      }
    }
    return row;
  });
}

/** Mask an email's local part for the single sample row: `j***@gmail.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.charAt(0)}***@${domain}`;
}

/** "2,014" — count formatting matching the design transcript. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Aggregate refused rows by reason: "6 × invalid email · 2 × duplicate email". */
export function summarizeRefusals(invalid: Array<{ reason?: unknown }>): string {
  const counts = new Map<string, number>();
  for (const entry of invalid) {
    const reason =
      typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : "other";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => `${formatCount(count)} × ${reason}`)
    .join(" · ");
}
