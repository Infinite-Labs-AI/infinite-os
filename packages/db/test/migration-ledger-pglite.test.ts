import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { runPgliteMigrations } from "../src/pglite-adapter.js";

afterEach(() => vi.restoreAllMocks());

describe("embedded migration ledger snapshot (real PGlite)", () => {
  it("reads once per boot and applies only pending files in the given order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "infinite-os-ledger-pglite-"));
    const url = `pglite://${directory}`;
    const create = PGlite.create.bind(PGlite);
    const ledgerReads: Array<() => string[]> = [];
    vi.spyOn(PGlite, "create").mockImplementation(async (...args) => {
      const db = await create(...args);
      const queries = vi.spyOn(db, "query");
      ledgerReads.push(() => queries.mock.calls.map(([sql]) => sql)
        .filter((sql) => sql.startsWith("select id from schema_migrations")));
      return db;
    });
    const first = { id: "9001_first.sql", sql: "create table ledger_test (n int); insert into ledger_test values (1);" };
    const second = { id: "9002_second.sql", sql: "insert into ledger_test select max(n)+1 from ledger_test;" };
    const third = { id: "9003_third.sql", sql: "insert into ledger_test select max(n)+1 from ledger_test;" };
    try {
      expect(await runPgliteMigrations(url, [first])).toEqual([first.id]);
      expect(await runPgliteMigrations(url, [first, second, third])).toEqual([second.id, third.id]);
      expect(ledgerReads.at(-1)!()).toEqual(["select id from schema_migrations"]);
      expect(await runPgliteMigrations(url, [first, second, third])).toEqual([]);
      expect(ledgerReads.at(-1)!()).toEqual(["select id from schema_migrations"]);
      const db = await create(directory);
      try {
        expect((await db.query<{ n: number }>("select n from ledger_test order by n")).rows)
          .toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      } finally {
        await db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not reapply a duplicate ID newly committed during this boot", async () => {
    const migration = { id: "9001_duplicate.sql", sql: "create table duplicate_id (n int);" };
    expect(await runPgliteMigrations("memory://", [migration, migration])).toEqual([migration.id]);
  }, 30_000);
});
