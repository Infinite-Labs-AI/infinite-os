import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { resetStuckSyncingSourcesOnBoot } from "./index.js";

// End-to-end proof of the boot-time stuck-'syncing' sweep against a REAL (WASM
// Postgres) PGlite data dir — the desktop backend where the wedge actually bites.
// The chunked batch loader durably commits status='syncing' in its OPEN
// transaction; a daemon killed mid-load leaves it there forever, and the desktop
// scheduler only auto-syncs 'connected' sources. The sweep must reset exactly the
// 'syncing' sources back to 'connected' and touch NOTHING else.

describe("resetStuckSyncingSourcesOnBoot (real PGlite)", () => {
  let dataDir: string;
  let db: InfiniteOsDb;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-syncing-sweep-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);

    // Seed one workspace with three sources in the three states the sweep must
    // discriminate. connectSource creates them 'connected'; flip two directly.
    await db.connectSource({
      workspaceId: "ws_sweep",
      provider: "google_analytics_4",
      connectionName: "GA4 wedged",
      accountExternalId: "acct_wedged"
    });
    await db.connectSource({
      workspaceId: "ws_sweep",
      provider: "posthog",
      connectionName: "PostHog healthy",
      accountExternalId: "acct_healthy"
    });
    await db.connectSource({
      workspaceId: "ws_sweep",
      provider: "stripe",
      connectionName: "Stripe failed",
      accountExternalId: "acct_failed"
    });
    // The wedge: a daemon killed mid-load left this source 'syncing' with a
    // last_synced_at from its previous successful sync.
    await db.query(
      `update sources set status = 'syncing', last_synced_at = '2026-07-01T00:00:00Z'
        where account_external_id = 'acct_wedged'`
    );
    // A genuinely FAILED load: marked 'error' by the loader — must NOT be revived.
    await db.query("update sources set status = 'error' where account_external_id = 'acct_failed'");
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("resets a wedged 'syncing' source to 'connected' (boot recovery), leaving last_synced_at untouched", async () => {
    const result = await resetStuckSyncingSourcesOnBoot(db);
    expect(result.reset).toBe(1); // exactly the wedged source

    const rows = await db.query<{ account_external_id: string; status: string; last_synced_at: string | null }>(
      `select account_external_id, status, last_synced_at
         from sources
        where workspace_id = 'ws_sweep'
        order by account_external_id`
    );
    const byAccount = Object.fromEntries(rows.map((r) => [r.account_external_id, r]));

    // The wedged source is back in scheduler rotation…
    expect(byAccount.acct_wedged?.status).toBe("connected");
    // …with its sync history preserved (the sweep is a status repair, not a sync).
    expect(new Date(byAccount.acct_wedged?.last_synced_at ?? "").toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );

    // 'error' means human recovery — never auto-revived by the sweep.
    expect(byAccount.acct_failed?.status).toBe("error");
    // Healthy sources untouched.
    expect(byAccount.acct_healthy?.status).toBe("connected");
  });

  it("is idempotent: a second boot sweep resets nothing", async () => {
    const again = await resetStuckSyncingSourcesOnBoot(db);
    expect(again.reset).toBe(0);
  });
});
