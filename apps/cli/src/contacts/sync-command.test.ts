import { describe, expect, it, vi } from "vitest";
import type { DesktopBridgeDescriptor, DesktopStatus } from "../desktop-app-client.js";
import type { SupabaseEnvResult } from "./env-detect.js";
import type { BridgeImportResult, ContactsImportRequest } from "./import-transport.js";
import { describeImportFailure } from "./import-transport.js";
import { runContactsSync, type ContactsSyncDeps, type ContactsSyncIo } from "./sync-command.js";

const SERVICE_KEY = "sk-secret-value";

function descriptor(capabilities: string[]): DesktopBridgeDescriptor {
  return {
    schemaVersion: 1,
    service: "infinite-desktop-cmdl",
    protocol: { min: 1, max: 1 },
    capabilities,
    url: "http://127.0.0.1:5555",
    pid: 123,
    bootId: "boot-1",
    desktopVersion: "0.3.14",
    runtime: { variant: "prod", stateLabel: "PROD" },
    token: "bridge-token",
    startedAt: "2026-08-30T00:00:00.000Z"
  };
}

const CAPABLE = descriptor([
  "status.v1",
  "turn.ndjson.v1",
  "confirm.v1",
  "contacts.import.v1"
]);
const TOO_OLD = descriptor(["status.v1", "turn.ndjson.v1", "confirm.v1"]);

function readyStatus(workspaceName = "Infinite Site"): DesktopStatus {
  return {
    service: "infinite-desktop-cmdl",
    bootId: "boot-1",
    protocol: { min: 1, max: 1 },
    capabilities: CAPABLE.capabilities,
    ready: true,
    contextRevision: "rev-1",
    workspace: { name: workspaceName }
  };
}

interface FakeIo {
  io: ContactsSyncIo;
  outLines: string[];
  errLines: string[];
  prompts: string[];
}

function makeIo(answers: string[], interactive = true): FakeIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const prompts: string[] = [];
  const queue = [...answers];
  return {
    io: {
      interactive,
      writeOut: (text) => outLines.push(text),
      writeErr: (text) => errLines.push(text),
      prompt: async (question) => {
        prompts.push(question);
        return queue.shift() ?? "";
      }
    },
    outLines,
    errLines,
    prompts
  };
}

interface SupabaseConfig {
  users: Array<Record<string, unknown>>;
  profiles?: { table: string; columns: string[]; rows: Array<Record<string, unknown>> };
}

/** Route GoTrue admin paging + PostgREST probes/reads for the fake project. */
function fakeSupabaseFetch(config: SupabaseConfig): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/admin/users") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "1000");
      const users = config.users.slice((page - 1) * perPage, page * perPage);
      return new Response(JSON.stringify({ users }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-total-count": String(config.users.length)
        }
      });
    }
    const match = /^\/rest\/v1\/([^/?]+)$/.exec(url.pathname);
    if (match) {
      const table = config.profiles;
      if (!table || decodeURIComponent(match[1]) !== table.table) {
        return new Response("Not Found", { status: 404 });
      }
      const select = (url.searchParams.get("select") ?? "").split(",").filter(Boolean);
      if (select.some((column) => !table.columns.includes(column))) {
        return new Response(JSON.stringify({ code: "42703" }), { status: 400 });
      }
      let rows = table.rows;
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
  }) as unknown as typeof fetch;
}

const DEFAULT_SUPABASE: SupabaseConfig = {
  users: [
    {
      id: "u1",
      email: "john@gmail.com",
      created_at: "2026-03-14T10:00:00Z",
      last_sign_in_at: "2026-08-01T10:00:00Z",
      email_confirmed_at: "2026-03-14T10:05:00Z"
    },
    {
      id: "u2",
      email: "mary@x.co",
      created_at: "2026-04-01T10:00:00Z",
      last_sign_in_at: "2026-08-02T10:00:00Z",
      email_confirmed_at: null
    }
  ],
  profiles: {
    table: "profiles",
    columns: ["user_id", "last_seen_at", "plan", "country"],
    rows: [{ user_id: "u1", last_seen_at: "2026-08-20T00:00:00Z", plan: "pro", country: "GB" }]
  }
};

const DRY_RUN_OK: BridgeImportResult = {
  status: 200,
  body: {
    ok: true,
    imported: 2,
    merged: 1,
    invalid: [],
    kept_suppressed: 0,
    dry_run: true,
    workspacePin: "pin-abc123"
  }
};

const COMMIT_OK: BridgeImportResult = {
  status: 200,
  body: { ok: true, imported: 2, merged: 1, invalid: [], kept_suppressed: 1 }
};

interface HarnessOverrides {
  answers?: string[];
  interactive?: boolean;
  bridgeDescriptor?: DesktopBridgeDescriptor | null;
  status?: DesktopStatus | (() => Promise<DesktopStatus>);
  supabase?: SupabaseConfig;
  postImportResults?: BridgeImportResult[];
  envOk?: boolean;
  envUrl?: string;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const fake = makeIo(
    overrides.answers ?? ["product signups", "y", "y"],
    overrides.interactive ?? true
  );
  const fetchImpl = fakeSupabaseFetch(overrides.supabase ?? DEFAULT_SUPABASE);
  const results = [...(overrides.postImportResults ?? [DRY_RUN_OK, COMMIT_OK])];
  const postImport = vi.fn(async (_request: ContactsImportRequest) => {
    const next = results.shift();
    if (!next) throw new Error("unexpected postImport call");
    return next;
  });
  const desktopStatus = vi.fn(async () => {
    const status = overrides.status ?? readyStatus();
    return typeof status === "function" ? status() : status;
  });
  const detectEnv = vi.fn(
    (): SupabaseEnvResult =>
      overrides.envOk === false
        ? { ok: false, checkedFiles: [".env.local", ".env"] }
        : {
            ok: true,
            env: {
              url: overrides.envUrl ?? "https://abc.supabase.co",
              serviceKey: SERVICE_KEY,
              urlVariable: "SUPABASE_URL",
              serviceKeyVariable: "SUPABASE_SERVICE_ROLE_KEY",
              sourceFile: ".env.local",
              checkedFiles: [".env.local", ".env"]
            }
          }
  );
  const deps: ContactsSyncDeps = {
    cwd: "/repo",
    io: fake.io,
    readDescriptor: () =>
      overrides.bridgeDescriptor === undefined ? CAPABLE : overrides.bridgeDescriptor,
    desktopStatus,
    postImport,
    fetchImpl,
    detectEnv,
    randomId: () => "req-1"
  };
  return { deps, fake, postImport, desktopStatus, detectEnv, fetchImpl };
}

function allOutput(fake: FakeIo): string {
  return [...fake.outLines, ...fake.errLines, ...fake.prompts].join("\n");
}

describe("capability gate", () => {
  it("refuses an app without contacts.import.v1 — nothing else runs", async () => {
    const harness = makeHarness({ bridgeDescriptor: TOO_OLD });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    expect(harness.fake.errLines.join("\n")).toContain(
      "Your Infinite app is too old for contacts sync — update the app first."
    );
    expect(harness.postImport).not.toHaveBeenCalled();
    expect(harness.desktopStatus).not.toHaveBeenCalled();
    expect(harness.detectEnv).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("names the desktop when it is not running at all", async () => {
    const harness = makeHarness({ bridgeDescriptor: null });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    expect(harness.fake.errLines.join("\n")).toContain(
      "Open the Infinite app first — that's how your contacts reach your workspace."
    );
    expect(harness.postImport).not.toHaveBeenCalled();
  });
});

describe("env detection", () => {
  it("says which files were checked and offers the CSV path when env is missing", async () => {
    const harness = makeHarness({ envOk: false });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    const output = harness.fake.outLines.join("\n");
    expect(output).toContain("Checked .env.local and .env");
    expect(output).toContain("export a CSV");
    expect(harness.postImport).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the Supabase host being read (trust rule 9)", async () => {
    const harness = makeHarness();
    await runContactsSync(harness.deps);
    expect(harness.fake.outLines.join("\n")).toContain("Reading from abc.supabase.co");
  });

  it("warns loudly when the URL looks like a local/staging database", async () => {
    const harness = makeHarness({
      envUrl: "http://127.0.0.1:54321",
      supabase: { users: DEFAULT_SUPABASE.users }
    });
    await runContactsSync(harness.deps);
    const output = harness.fake.outLines.join("\n");
    expect(output).toContain("WARNING");
    expect(output).toContain("LOCAL / staging database");
  });
});

describe("the two-confirm state machine", () => {
  it("happy path: dry_run then commit, with the pin from the dry-run response", async () => {
    const harness = makeHarness();
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(0);
    expect(harness.postImport).toHaveBeenCalledTimes(2);

    const dryRun = harness.postImport.mock.calls[0][0];
    expect(dryRun.mode).toBe("dry_run");
    expect(dryRun.provenance).toBe("signups");
    expect(dryRun.workspacePin).toBeUndefined();
    expect(dryRun.mapping).toEqual({
      email: "email",
      joined: "created_at",
      last_seen: "last_seen_at",
      plan: "plan",
      "custom:country": "country"
    });
    expect(dryRun.rows).toEqual([
      {
        email: "john@gmail.com",
        created_at: "2026-03-14T10:00:00Z",
        last_seen_at: "2026-08-20T00:00:00Z",
        plan: "pro",
        country: "GB"
      },
      {
        email: "mary@x.co",
        created_at: "2026-04-01T10:00:00Z",
        last_seen_at: "",
        plan: "",
        country: ""
      }
    ]);
    for (const row of dryRun.rows) {
      for (const value of Object.values(row)) expect(typeof value).toBe("string");
    }

    const commit = harness.postImport.mock.calls[1][0];
    expect(commit.mode).toBe("commit");
    expect(commit.workspacePin).toBe("pin-abc123");
    expect(commit.rows).toEqual(dryRun.rows);
    expect(commit.mapping).toEqual(dryRun.mapping);
    expect(commit.provenance).toBe("signups");

    const output = harness.fake.outLines.join("\n");
    expect(output).toContain(
      "Done. Unsubscribed or suppressed contacts were NOT resurrected — that is permanent."
    );
    expect(output).toContain(
      "Re-run this command any time: re-imports merge and never clobber consent."
    );
    // The unconfirmed-but-kept count is its own line.
    expect(output).toContain("1 contact hasn't confirmed their email yet");
  });

  it("confirm 1 gates transmission: a decline sends NOTHING over the bridge", async () => {
    const harness = makeHarness({ answers: ["product signups", "n"] });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(0);
    expect(harness.postImport).not.toHaveBeenCalled();
    expect(harness.fake.outLines.join("\n")).toContain("Nothing was sent.");
  });

  it("nothing crosses the bridge before confirm 1 is answered", async () => {
    const callsAtPrompt: Array<{ prompt: string; importCalls: number }> = [];
    const harness = makeHarness();
    const originalPrompt = harness.fake.io.prompt;
    harness.fake.io.prompt = async (question) => {
      callsAtPrompt.push({
        prompt: question,
        importCalls: harness.postImport.mock.calls.length
      });
      return originalPrompt(question);
    };
    await runContactsSync(harness.deps);
    // At confirm 1 (and every prompt before it) ZERO imports have been posted;
    // by confirm 2 exactly the single dry run has.
    const confirm1 = callsAtPrompt.find((entry) => entry.prompt.includes("Send 2 contacts"));
    expect(confirm1).toBeDefined();
    expect(confirm1?.importCalls).toBe(0);
    for (const entry of callsAtPrompt) {
      if (!entry.prompt.includes("Import 2 contacts now?")) {
        expect(entry.importCalls).toBe(0);
      }
    }
    const confirm2 = callsAtPrompt.find((entry) => entry.prompt.includes("Import 2 contacts now?"));
    expect(confirm2?.importCalls).toBe(1);
  });

  it("confirm 2 gates the commit: a decline stops after the single dry run", async () => {
    const harness = makeHarness({ answers: ["signups", "y", "n"] });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(0);
    expect(harness.postImport).toHaveBeenCalledTimes(1);
    expect(harness.postImport.mock.calls[0][0].mode).toBe("dry_run");
    expect(harness.fake.outLines.join("\n")).toContain("Nothing was imported.");
  });

  it("names the destination workspace from status.v1 in confirm 1", async () => {
    const harness = makeHarness({ status: readyStatus("October") });
    await runContactsSync(harness.deps);
    const confirm = harness.fake.prompts.find((prompt) => prompt.includes("Send 2 contacts"));
    expect(confirm).toContain('to workspace "October" as product signups?');
  });

  it("maps the provenance answers to the wire vocabulary", async () => {
    const harness = makeHarness({ answers: ["customers", "y", "y"] });
    await runContactsSync(harness.deps);
    expect(harness.postImport.mock.calls[0][0].provenance).toBe("customers");
  });

  it("renders the dry-run report honestly, refusal reasons included", async () => {
    const harness = makeHarness({
      postImportResults: [
        {
          status: 200,
          body: {
            ok: true,
            imported: 1,
            merged: 0,
            invalid: [{ row: 3, reason: "invalid email" }],
            dry_run: true,
            workspacePin: "pin-x"
          }
        }
      ],
      answers: ["signups", "y", "n"]
    });
    await runContactsSync(harness.deps);
    const output = harness.fake.outLines.join("\n");
    expect(output).toContain("1 importable (0 will merge with existing), 1 refused:");
    expect(output).toContain("1 × invalid email");
  });
});

describe("caps and failures", () => {
  it("refuses more than 25,000 people with split-by-created_at guidance", async () => {
    const users = Array.from({ length: 25_001 }, (_, index) => ({
      id: `u${index}`,
      email: `person${index}@x.co`,
      created_at: "2026-01-01T00:00:00Z",
      last_sign_in_at: "",
      email_confirmed_at: "2026-01-01T00:00:00Z"
    }));
    const harness = makeHarness({ supabase: { users } });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    const output = harness.fake.outLines.join("\n");
    expect(output).toContain("25,001 contacts — more than the 25,000 one sync can carry");
    expect(output).toContain("Split by created_at");
    expect(harness.postImport).not.toHaveBeenCalled();
  });

  it("renders 409 workspace_changed as a re-run-from-scratch instruction", async () => {
    const harness = makeHarness({
      postImportResults: [
        DRY_RUN_OK,
        {
          status: 409,
          body: {
            error: "workspace_changed",
            message: "The app's active workspace changed since the dry run."
          }
        }
      ]
    });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    expect(harness.fake.errLines.join("\n")).toContain("Re-run `infinite contacts sync`");
  });

  it("renders the pinned 503 messages by exact code", () => {
    expect(
      describeImportFailure(503, { error: "capability_unavailable" })
    ).toContain("Update the Infinite app first");
    expect(describeImportFailure(503, { error: "cloud_unavailable" })).toContain(
      "Open the Infinite app and sign in"
    );
    expect(describeImportFailure(503, { error: "email_lifecycle_disabled" })).toBe(
      "Lifecycle email isn't switched on for this deployment yet."
    );
    expect(describeImportFailure(503, { error: "no_linked_workspace" })).toContain(
      "no linked workspace"
    );
    expect(describeImportFailure(413, {})).toContain("Split by created_at");
    expect(describeImportFailure(401, {})).toContain("bridge credentials");
    expect(describeImportFailure(502, {})).toContain("could not reach the workspace import service");
    // Cloud-shaped error objects (ok:false, error:{code,message}) resolve the same codes.
    expect(
      describeImportFailure(503, {
        ok: false,
        error: { code: "email_lifecycle_disabled", message: "off" }
      })
    ).toBe("Lifecycle email isn't switched on for this deployment yet.");
  });

  it("surfaces a 503 dry-run failure and stops before any commit", async () => {
    const harness = makeHarness({
      postImportResults: [
        { status: 503, body: { error: "email_lifecycle_disabled", message: "off" } }
      ]
    });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    expect(harness.postImport).toHaveBeenCalledTimes(1);
    expect(harness.fake.errLines.join("\n")).toContain(
      "Lifecycle email isn't switched on for this deployment yet."
    );
  });

  it("refuses a dry-run response without a workspace pin", async () => {
    const harness = makeHarness({
      postImportResults: [
        { status: 200, body: { ok: true, imported: 2, merged: 0, invalid: [] } }
      ]
    });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    expect(harness.fake.errLines.join("\n")).toContain("missing its workspace pin");
  });

  it("refuses to run without an interactive terminal", async () => {
    const harness = makeHarness({ interactive: false });
    const code = await runContactsSync(harness.deps);
    expect(code).toBe(1);
    expect(harness.fake.errLines.join("\n")).toContain("interactive");
    expect(harness.postImport).not.toHaveBeenCalled();
  });
});

describe("honest absences + hygiene", () => {
  it("says the Data API is off — never 'no plan column found' — when PostgREST is disabled", async () => {
    const harness = makeHarness({
      supabase: { users: DEFAULT_SUPABASE.users },
      answers: ["signups", "y", "y"]
    });
    await runContactsSync(harness.deps);
    const output = harness.fake.outLines.join("\n");
    expect(output).toContain("Data API is off — profiles fields skipped");
    expect(output).not.toContain("No plan column found");
    // Auth fallback still supplies last-seen.
    expect(harness.postImport.mock.calls[0][0].mapping.last_seen).toBe("last_sign_in_at");
  });

  it("masks exactly one sample row and never prints another address in the plan output", async () => {
    const harness = makeHarness();
    await runContactsSync(harness.deps);
    const output = allOutput(harness.fake);
    expect(output).toContain("Sample (1 row, masked): j***@gmail.com · joined 2026-03-14 · pro · GB");
    expect(output).not.toContain("john@gmail.com");
    expect(output).not.toContain("mary@x.co");
  });

  it("never lets the service key reach output or a request URL", async () => {
    const harness = makeHarness();
    await runContactsSync(harness.deps);
    expect(allOutput(harness.fake)).not.toContain(SERVICE_KEY);
    const fetchMock = harness.fetchImpl as unknown as ReturnType<typeof vi.fn>;
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(SERVICE_KEY);
    }
  });

});
