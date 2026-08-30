/**
 * Simulated happy-path run of `infinite contacts sync` against a FAKE Supabase
 * project and a FAKE desktop bridge — no network, no desktop, no credentials.
 *
 * Run: pnpm exec tsx apps/cli/scripts/contacts-sync-demo.ts
 *
 * Exists so the flow's terminal transcript can be eyeballed against the design
 * doc without a live customer database. Not shipped; not imported by the CLI.
 */
import type { DesktopBridgeDescriptor, DesktopStatus } from "../src/desktop-app-client.js";
import { runContactsSync } from "../src/contacts/sync-command.js";

const USERS = Array.from({ length: 2014 }, (_, index) => ({
  id: `u${index}`,
  email: index === 0 ? "john@gmail.com" : `person${index}@example.com`,
  created_at: index === 0 ? "2026-03-14T09:30:00Z" : "2026-05-01T09:30:00Z",
  last_sign_in_at: "2026-08-01T10:00:00Z",
  email_confirmed_at: index % 40 === 0 ? null : "2026-05-01T10:00:00Z"
}));

const PROFILES = {
  table: "profiles",
  columns: ["user_id", "last_seen_at", "plan", "country"],
  rows: USERS.map((user, index) => ({
    user_id: user.id,
    last_seen_at: "2026-08-20T00:00:00Z",
    plan: index % 3 === 0 ? "pro" : "free",
    country: "GB"
  }))
};

const fetchImpl = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/auth/v1/admin/users") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "1000");
    return new Response(
      JSON.stringify({ users: USERS.slice((page - 1) * perPage, page * perPage) }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-total-count": String(USERS.length)
        }
      }
    );
  }
  const match = /^\/rest\/v1\/([^/?]+)$/.exec(url.pathname);
  if (match) {
    if (decodeURIComponent(match[1]) !== PROFILES.table) {
      return new Response("Not Found", { status: 404 });
    }
    const select = (url.searchParams.get("select") ?? "").split(",").filter(Boolean);
    if (select.some((column) => !PROFILES.columns.includes(column))) {
      return new Response(JSON.stringify({ code: "42703" }), { status: 400 });
    }
    let rows = PROFILES.rows as Array<Record<string, unknown>>;
    for (const [key, value] of url.searchParams.entries()) {
      if (["select", "limit", "offset", "order"].includes(key)) continue;
      if (value.startsWith("eq.")) {
        rows = rows.filter((row) => String(row[key]) === value.slice(3));
      }
    }
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? String(rows.length));
    const body = rows.slice(offset, offset + limit).map((row) => {
      const projected: Record<string, unknown> = {};
      for (const column of select) projected[column] = row[column];
      return projected;
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const descriptor: DesktopBridgeDescriptor = {
  schemaVersion: 1,
  service: "infinite-desktop-cmdl",
  protocol: { min: 1, max: 1 },
  capabilities: ["status.v1", "turn.ndjson.v1", "confirm.v1", "contacts.import.v1"],
  url: "http://127.0.0.1:5555",
  pid: 1,
  bootId: "demo",
  desktopVersion: "0.3.14",
  runtime: { variant: "prod", stateLabel: "PROD" },
  token: "demo-token",
  startedAt: new Date().toISOString()
};

const status: DesktopStatus = {
  service: "infinite-desktop-cmdl",
  bootId: "demo",
  protocol: { min: 1, max: 1 },
  capabilities: descriptor.capabilities,
  ready: true,
  contextRevision: "rev-1",
  workspace: { name: "Infinite Site" }
};

const answers = ["product signups", "y", "y"];

const code = await runContactsSync({
  cwd: "/demo",
  io: {
    interactive: true,
    writeOut: (text) => console.log(text),
    writeErr: (text) => console.error(text),
    prompt: async (question) => {
      const answer = answers.shift() ?? "";
      console.log(`${question}${answer}`);
      return answer;
    }
  },
  readDescriptor: () => descriptor,
  desktopStatus: async () => status,
  postImport: async (request) => {
    if (request.mode === "dry_run") {
      return {
        status: 200,
        body: {
          ok: true,
          imported: 2006,
          merged: 312,
          invalid: [
            ...Array.from({ length: 6 }, (_, index) => ({
              row: index + 2,
              reason: "invalid email"
            })),
            { row: 9, reason: "duplicate email" },
            { row: 10, reason: "duplicate email" }
          ],
          kept_suppressed: 0,
          dry_run: true,
          workspacePin: "9f2ab3c4d5e6f7a8"
        }
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        imported: 2006,
        merged: 312,
        invalid: [
          ...Array.from({ length: 6 }, (_, index) => ({
            row: index + 2,
            reason: "invalid email"
          })),
          { row: 9, reason: "duplicate email" },
          { row: 10, reason: "duplicate email" }
        ],
        kept_suppressed: 4
      }
    };
  },
  fetchImpl,
  detectEnv: () => ({
    ok: true,
    env: {
      url: "https://xyzcompany.supabase.co",
      serviceKey: "demo-service-key-never-printed",
      urlVariable: "SUPABASE_URL",
      serviceKeyVariable: "SUPABASE_SERVICE_ROLE_KEY",
      sourceFile: ".env.local",
      checkedFiles: [".env.local", ".env"]
    }
  })
});
process.exitCode = code;
