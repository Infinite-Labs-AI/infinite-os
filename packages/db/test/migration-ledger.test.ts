import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pgState = vi.hoisted(() => ({
  calls: [] as string[],
  ids: [] as string[],
  failSql: "",
  connected: false,
  closed: false,
}));

vi.mock("pg", () => ({
  default: {
    Client: class {
      async connect() { pgState.connected = true; }
      async end() { pgState.closed = true; }
      async query(sql: string, params?: unknown[]) {
        pgState.calls.push(sql.trim());
        if (sql === pgState.failSql) throw new Error("migration failed");
        if (sql.startsWith("select id from schema_migrations")) {
          const ids = params ? pgState.ids.filter((id) => id === params[0]) : pgState.ids;
          return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
        }
        return { rows: [], rowCount: 0 };
      }
    },
  },
}));

import { runMigrations } from "../src/index.js";

describe("Postgres migration ledger reads under the real migration runner", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "infinite-os-ledger-"));
    vi.stubEnv("GROWTH_OS_MIGRATIONS_DIR", directory);
    pgState.calls = [];
    pgState.ids = [];
    pgState.failSql = "";
    pgState.connected = false;
    pgState.closed = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads all applied IDs once after the lock and skips a current 83-file stack", async () => {
    for (let n = 1; n <= 83; n += 1) {
      const id = `${String(n).padStart(4, "0")}_fixture.sql`;
      writeFileSync(join(directory, id), `select ${n};`);
      pgState.ids.push(id);
    }
    await expect(runMigrations("postgres://fixture.invalid/db")).resolves.toEqual([]);
    const reads = pgState.calls.filter((sql) => sql.startsWith("select id from schema_migrations"));
    expect(reads).toEqual(["select id from schema_migrations"]);
    expect(pgState.calls.findIndex((sql) => sql.includes("pg_advisory_lock")))
      .toBeLessThan(pgState.calls.indexOf(reads[0]!));
    expect(pgState.calls).not.toContain("begin");
    expect(pgState.connected && pgState.closed).toBe(true);
  });

  it("preserves sorted pending migration order and a transaction per file", async () => {
    writeFileSync(join(directory, "0003_last.sql"), "last sql");
    writeFileSync(join(directory, "0001_first.sql"), "first sql");
    writeFileSync(join(directory, "0002_applied.sql"), "old sql");
    pgState.ids = ["0002_applied.sql", "unknown_historical.sql"];
    await expect(runMigrations("postgres://fixture.invalid/db"))
      .resolves.toEqual(["0001_first.sql", "0003_last.sql"]);
    expect(pgState.calls.filter((sql) => ["begin", "commit", "first sql", "last sql", "old sql"].includes(sql)))
      .toEqual(["begin", "first sql", "commit", "begin", "last sql", "commit"]);
  });

  it("rolls back a failed pending file, releases the lock and closes the client", async () => {
    writeFileSync(join(directory, "0001_first.sql"), "first sql");
    writeFileSync(join(directory, "0002_bad.sql"), "bad sql");
    writeFileSync(join(directory, "0003_later.sql"), "later sql");
    pgState.failSql = "bad sql";
    await expect(runMigrations("postgres://fixture.invalid/db")).rejects.toThrow("migration failed");
    expect(pgState.calls.filter((sql) => ["begin", "commit", "rollback"].includes(sql)))
      .toEqual(["begin", "commit", "begin", "rollback"]);
    expect(pgState.calls).not.toContain("later sql");
    expect(pgState.calls.at(-1)).toContain("pg_advisory_unlock");
    expect(pgState.closed).toBe(true);
  });
});
