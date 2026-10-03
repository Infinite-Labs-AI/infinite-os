import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopAppClientError,
  createDesktopAppClient,
  readDesktopBridgeDescriptor,
  resolveLiveBridge,
  runDesktopAppCommand,
  type DesktopBridgeDescriptor
} from "./desktop-app-client.js";
import { confirmErrorLines } from "./desktop/confirm-result-lines.js";
import {
  CONFIRM_FIELDS_CAPABILITY,
  GENERAL_MARKETING_PROFILE,
  INTERACTIVE_WORKSPACE_CAPABILITY,
  RESULT_VIEW_CAPABILITY,
} from "@infinite-os/types";

const SERVICE = "infinite-desktop-cmdl";
const CONFIRM_IDEMPOTENCY_CAPABILITY = "confirm.idempotency.v1";
const CAPABILITIES = [
  "status.v1",
  "turn.ndjson.v1",
  "confirm.v1",
  CONFIRM_IDEMPOTENCY_CAPABILITY
];

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    service: SERVICE,
    protocol: { min: 1, max: 1 },
    capabilities: CAPABILITIES,
    url: "http://127.0.0.1:54321",
    pid: 12345,
    bootId: "boot-test-123456",
    desktopVersion: "0.2.39",
    runtime: { variant: "dev", stateLabel: "DEV2" },
    token: "owner-only-bearer-token",
    startedAt: "2026-07-30T12:00:00.000Z",
    ...overrides
  };
}

function createBridgeHome(value = descriptor()) {
  const root = mkdtempSync(join(tmpdir(), "infinite-desktop-client-"));
  const bridgeDirectory = join(root, "desktop-cmdl");
  const descriptorPath = join(bridgeDirectory, "bridge.json");
  mkdirSync(bridgeDirectory, { mode: 0o700 });
  writeFileSync(descriptorPath, JSON.stringify(value), { mode: 0o600 });
  chmodSync(bridgeDirectory, 0o700);
  chmodSync(descriptorPath, 0o600);
  return {
    root,
    descriptorPath,
    env: { GROWTH_OS_HOME: root, HOME: join(root, "wrong-home") }
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function ndjsonResponse(lines: string[], chunks?: number[]): Response {
  const encoded = new TextEncoder().encode(lines.join("\n"));
  const splits = chunks ?? [encoded.byteLength];
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = splits.shift();
      if (size === undefined) {
        controller.close();
        return;
      }
      const end = Math.min(offset + size, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
      if (offset >= encoded.byteLength) {
        controller.close();
      }
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    service: SERVICE,
    bootId: "boot-test-123456",
    protocol: { min: 1, max: 1 },
    capabilities: CAPABILITIES,
    ready: true,
    contextRevision: "context-1",
    provider: { id: "codex", model: "gpt-5.6" },
    workspace: { name: "Acme" },
    ...overrides
  };
}

function hasUnsafeTerminalControl(
  value: string,
  allowLineFeed = false
): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowLineFeed && code === 0x0a) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop bridge discovery", () => {
  it("reads only the descriptor under the effective GROWTH_OS_HOME", () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);

    const result = readDesktopBridgeDescriptor(fixture.env);

    expect(result.url).toBe("http://127.0.0.1:54321");
    expect(result.bootId).toBe("boot-test-123456");
    expect(result.token).toBe("owner-only-bearer-token");
  });

  it("rejects symlink and non-regular descriptors", () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const realPath = join(fixture.root, "real-descriptor.json");
    writeFileSync(realPath, JSON.stringify(descriptor()), { mode: 0o600 });
    rmSync(fixture.descriptorPath);
    symlinkSync(realPath, fixture.descriptorPath);

    expect(() => readDesktopBridgeDescriptor(fixture.env)).toThrowError(
      expect.objectContaining({ code: "desktop_descriptor_unsafe" })
    );

    rmSync(fixture.descriptorPath);
    mkdirSync(fixture.descriptorPath);
    expect(lstatSync(fixture.descriptorPath).isDirectory()).toBe(true);
    expect(() => readDesktopBridgeDescriptor(fixture.env)).toThrowError(
      expect.objectContaining({ code: "desktop_descriptor_unsafe" })
    );
  });

  it("rejects owner-unsafe descriptor and parent permissions", () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);

    chmodSync(fixture.descriptorPath, 0o644);
    expect(() => readDesktopBridgeDescriptor(fixture.env)).toThrowError(
      expect.objectContaining({ code: "desktop_descriptor_unsafe" })
    );

    chmodSync(fixture.descriptorPath, 0o600);
    chmodSync(join(fixture.root, "desktop-cmdl"), 0o755);
    expect(() => readDesktopBridgeDescriptor(fixture.env)).toThrowError(
      expect.objectContaining({ code: "desktop_descriptor_unsafe" })
    );
  });

  it.each([
    [{ service: "foreign-service" }, "desktop_descriptor_invalid"],
    [{ schemaVersion: 2 }, "desktop_protocol_incompatible"],
    [{ protocol: { min: 2, max: 3 } }, "desktop_protocol_incompatible"],
    [{ url: "https://127.0.0.1:54321" }, "desktop_descriptor_invalid"],
    [{ url: "http://example.com:54321" }, "desktop_descriptor_invalid"],
    [{ token: "" }, "desktop_descriptor_invalid"],
    [
      { capabilities: ["status.v1", "turn.ndjson.v1"] },
      "desktop_protocol_incompatible"
    ]
  ])("rejects malformed or incompatible descriptors: %j", (override, code) => {
    const fixture = createBridgeHome(descriptor(override));
    roots.push(fixture.root);
    expect(() => readDesktopBridgeDescriptor(fixture.env)).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it("reports a typed not-running error without reading another home", () => {
    const root = mkdtempSync(join(tmpdir(), "infinite-desktop-missing-"));
    roots.push(root);
    expect(() =>
      readDesktopBridgeDescriptor({
        GROWTH_OS_HOME: root,
        HOME: "/definitely/not/the-runtime"
      })
    ).toThrowError(expect.objectContaining({ code: "desktop_not_running" }));
  });
});

describe("desktop bridge HTTP client", () => {
  it("negotiates interactive workspace metadata and sends it on a supported turn", async () => {
    const capabilities = [...CAPABILITIES, INTERACTIVE_WORKSPACE_CAPABILITY];
    const fixture = createBridgeHome(descriptor({ capabilities }));
    roots.push(fixture.root);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/status")) {
        return jsonResponse(status({
          capabilities,
          interactive: {
            supportedProfiles: [GENERAL_MARKETING_PROFILE],
            availableFeatures: ["workspace.app-tools.v1"],
            workspaceAccess: "metadata-only",
          },
        }));
      }
      const body = JSON.parse(String(init?.body));
      expect(body.interactive).toEqual({
        profile: GENERAL_MARKETING_PROFILE,
        cwd: "/Users/example/project",
      });
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "interactive-turn",
          sequence: 1,
          kind: "done",
          data: { message: "ok", actionCalls: [] },
        }),
      ]);
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "interactive-turn",
    });

    await client.status();
    expect(client.interactiveWorkspace).toMatchObject({
      supportedProfiles: [GENERAL_MARKETING_PROFILE],
      workspaceAccess: "metadata-only",
    });
    await expect(client.turn({
      message: "hello",
      expectedContextRevision: "context-1",
      interactive: {
        profile: GENERAL_MARKETING_PROFILE,
        cwd: "/Users/example/project",
      },
    })).resolves.toMatchObject({ message: "ok" });
  });

  it("fails an explicit interactive request when descriptor/status negotiation is absent", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const fetchImpl = vi.fn(async () => jsonResponse(status())) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });
    await client.status();

    await expect(client.turn({
      message: "hello",
      expectedContextRevision: "context-1",
      interactive: { profile: GENERAL_MARKETING_PROFILE },
    })).rejects.toMatchObject({ code: "interactive_capability_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails an explicit profile missing from negotiated Desktop status", async () => {
    const capabilities = [...CAPABILITIES, INTERACTIVE_WORKSPACE_CAPABILITY];
    const fixture = createBridgeHome(descriptor({ capabilities }));
    roots.push(fixture.root);
    const fetchImpl = vi.fn(async () => jsonResponse(status({
      capabilities,
      interactive: {
        supportedProfiles: [],
        availableFeatures: [],
        workspaceAccess: "metadata-only",
      },
    }))) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });
    await client.status();

    await expect(client.turn({
      message: "hello",
      expectedContextRevision: "context-1",
      interactive: { profile: GENERAL_MARKETING_PROFILE },
    })).rejects.toMatchObject({ code: "interactive_profile_unsupported" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["desktop_signed_out", "Infinite Desktop is signed out."],
    ["subscription_required", "An active subscription is required."],
  ])("preserves a not-ready %s response without requiring interactive metadata", async (code, message) => {
    const capabilities = [...CAPABILITIES, INTERACTIVE_WORKSPACE_CAPABILITY];
    const fixture = createBridgeHome(descriptor({ capabilities }));
    roots.push(fixture.root);
    const fetchImpl = vi.fn(async () => jsonResponse(status({
      capabilities,
      ready: false,
      error: { code, message },
      interactive: undefined,
    }))) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });

    await expect(client.status()).resolves.toMatchObject({
      ready: false,
      error: { code, message },
    });
    expect(client.interactiveWorkspace).toBeUndefined();
  });

  it("clears previously negotiated interactive state when Desktop becomes not ready", async () => {
    const capabilities = [...CAPABILITIES, INTERACTIVE_WORKSPACE_CAPABILITY];
    const fixture = createBridgeHome(descriptor({ capabilities }));
    roots.push(fixture.root);
    let ready = true;
    const fetchImpl = vi.fn(async () => jsonResponse(status({
      capabilities,
      ready,
      ...(ready
        ? {
            interactive: {
              supportedProfiles: [GENERAL_MARKETING_PROFILE],
              availableFeatures: [],
              workspaceAccess: "metadata-only",
            },
          }
        : {
            error: {
              code: "desktop_signed_out",
              message: "Infinite Desktop is signed out.",
            },
          }),
    }))) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });

    await client.status();
    expect(client.interactiveWorkspace).toBeDefined();
    ready = false;
    await client.status();
    expect(client.interactiveWorkspace).toBeUndefined();
  });

  it("authenticates status and validates desktop identity and boot", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("http://127.0.0.1:54321/v1/status");
        expect(init?.headers).toMatchObject({
          authorization: "Bearer owner-only-bearer-token",
          accept: "application/json"
        });
        return jsonResponse(status());
      }
    ) as typeof fetch;

    const client = createDesktopAppClient(fixture.env, { fetchImpl });
    await expect(client.status()).resolves.toMatchObject({
      ready: true,
      contextRevision: "context-1",
      provider: { id: "codex" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails a status request promptly when a stale listener never sends headers", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const fetchImpl = vi.fn(
      async () => new Promise<Response>(() => {})
    ) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      requestTimeoutMs: 10
    });

    await expect(client.status()).rejects.toMatchObject({
      code: "desktop_unreachable"
    });
  });

  it("bounds turn setup without imposing a deadline on an accepted stream", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const fetchImpl = vi.fn(
      async () => new Promise<Response>(() => {})
    ) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "request-timeout",
      requestTimeoutMs: 10
    });

    await expect(
      client.turn({
        message: "show opportunities",
        expectedContextRevision: "context-1"
      })
    ).rejects.toMatchObject({ code: "desktop_unreachable" });
  });

  it.each([
    [status({ service: "other" }), "desktop_identity_mismatch"],
    [status({ bootId: "stale-boot" }), "desktop_identity_mismatch"],
    [status({ protocol: { min: 2, max: 2 } }), "desktop_protocol_incompatible"],
    [status({ contextRevision: "" }), "desktop_response_invalid"]
  ])("fails closed on an invalid status response", async (response, code) => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () => jsonResponse(response)) as typeof fetch
    });

    await expect(client.status()).rejects.toMatchObject({ code });
  });

  it("parses partial NDJSON chunks and emits ordered progress before the terminal result", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const lines = [
      JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        sequence: 1,
        kind: "progress",
        data: { type: "status.update", message: "Reading sources" }
      }),
      JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        sequence: 2,
        kind: "progress",
        data: { type: "message.delta", text: "Half " }
      }),
      JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        sequence: 3,
        kind: "done",
        data: { turnId: "turn-1", message: "Half done.", actionCalls: [] }
      })
    ];
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          protocolVersion: 1,
          requestId: "request-1",
          message: "show opportunities",
          expectedContextRevision: "context-1"
        });
        return ndjsonResponse(lines, [7, 19, 2, 41, 1, 1000]);
      }
    ) as typeof fetch;
    const progress: unknown[] = [];
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "request-1"
    });

    const result = await client.turn(
      { message: "show opportunities", expectedContextRevision: "context-1" },
      (frame) => progress.push(frame.data)
    );

    expect(progress).toEqual([
      { type: "status.update", message: "Reading sources" },
      { type: "message.delta", text: "Half " }
    ]);
    expect(result).toMatchObject({
      turnId: "turn-1",
      message: "Half done.",
      actionCalls: []
    });
  });

  it.each([
    [
      [
        {
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 2,
          kind: "done",
          data: { message: "x" }
        }
      ],
      "desktop_stream_sequence"
    ],
    [
      [
        {
          protocolVersion: 1,
          requestId: "wrong",
          sequence: 1,
          kind: "done",
          data: { message: "x" }
        }
      ],
      "desktop_stream_request_mismatch"
    ],
    [
      [
        {
          protocolVersion: 2,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: { message: "x" }
        }
      ],
      "desktop_protocol_incompatible"
    ],
    [
      [
        {
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: { message: "x" }
        },
        {
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 2,
          kind: "progress",
          data: {}
        }
      ],
      "desktop_stream_trailing_frame"
    ],
    [
      [
        {
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "progress",
          data: {}
        }
      ],
      "desktop_stream_missing_terminal"
    ],
    [
      [
        {
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: { message: "x" }
        },
        {
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 2,
          kind: "error",
          data: { code: "x", message: "x" }
        }
      ],
      "desktop_stream_trailing_frame"
    ]
  ])(
    "rejects malformed, out-of-order, or non-terminal streams",
    async (frames, code) => {
      const fixture = createBridgeHome();
      roots.push(fixture.root);
      const client = createDesktopAppClient(fixture.env, {
        randomId: () => "request-1",
        fetchImpl: (async () =>
          ndjsonResponse(
            frames.map((frame) => JSON.stringify(frame))
          )) as typeof fetch
      });

      await expect(
        client.turn({ message: "test", expectedContextRevision: "context-1" })
      ).rejects.toMatchObject({
        code
      });
    }
  );

  it("surfaces a typed terminal error without converting it to a done result", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const client = createDesktopAppClient(fixture.env, {
      randomId: () => "request-1",
      fetchImpl: (async () =>
        ndjsonResponse([
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 1,
            kind: "error",
            data: { code: "stale_turn_context", message: "Workspace changed." }
          })
        ])) as typeof fetch
    });

    await expect(
      client.turn({ message: "test", expectedContextRevision: "context-1" })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "stale_turn_context",
        message: "Workspace changed."
      })
    );
  });

  it("preserves a successful confirmation envelope when its data is an execution result", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const requests: RequestInit[] = [];
    const client = createDesktopAppClient(fixture.env, {
      randomId: () => "confirm-request-1",
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit
      ) => {
        requests.push(init ?? {});
        return jsonResponse({ ok: true, data: { created: true } });
      }) as typeof fetch
    });

    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
    ).resolves.toEqual({ ok: true, data: { created: true } });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      protocolVersion: 1,
      requestId: "confirm-request-1",
      turnId: "turn-1",
      confirmationHandle: "opaque-confirm-1",
      decision: "approve"
    });
    expect(new Headers(requests[0]?.headers).get("x-request-id")).toBe(
      "confirm-request-1"
    );
  });

  it("retries confirmation once with the identical request after a response-loss transport failure", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const confirmationRequests: Array<{
      url: string;
      body: string;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/status")) return jsonResponse(status());
        confirmationRequests.push({
          url,
          body: String(init?.body),
          headers: Object.fromEntries(new Headers(init?.headers))
        });
        if (confirmationRequests.length === 1) {
          throw new TypeError("response connection dropped");
        }
        return jsonResponse({ ok: true, decision: "approve" });
      }
    ) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "confirm-request-retry"
    });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
    ).resolves.toEqual({ ok: true, decision: "approve" });

    expect(confirmationRequests).toHaveLength(2);
    expect(confirmationRequests[1]).toEqual(confirmationRequests[0]);
    expect(JSON.parse(confirmationRequests[0]!.body)).toEqual({
      protocolVersion: 1,
      requestId: "confirm-request-retry",
      turnId: "turn-1",
      confirmationHandle: "opaque-confirm-1",
      decision: "approve"
    });
  });

  it("retries confirmation once when the response body is interrupted after headers", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const confirmationRequests: Array<{
      body: string;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/v1/status")) return jsonResponse(status());
        confirmationRequests.push({
          body: String(init?.body),
          headers: Object.fromEntries(new Headers(init?.headers))
        });
        if (confirmationRequests.length === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('{"ok":true,"decision":')
                );
                controller.error(new TypeError("response body terminated"));
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
        return jsonResponse({ ok: true, decision: "approve" });
      }
    ) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "confirm-request-body-retry"
    });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
    ).resolves.toEqual({ ok: true, decision: "approve" });

    expect(confirmationRequests).toHaveLength(2);
    expect(confirmationRequests[1]).toEqual(confirmationRequests[0]);
  });

  it("preserves idempotent confirmation semantics when a stale listener never responds", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    let confirmationAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) {
        return jsonResponse(status());
      }
      confirmationAttempts += 1;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "confirm-request-timeout",
      requestTimeoutMs: 10
    });
    await client.status();

    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-timeout",
        decision: "approve"
      })
    ).rejects.toMatchObject({
      code: "desktop_confirmation_outcome_unknown"
    });
    expect(confirmationAttempts).toBe(2);
  });

  it("reports an unknown outcome when a legacy Desktop loses the confirmation response body", async () => {
    const legacyCapabilities = ["status.v1", "turn.ndjson.v1", "confirm.v1"];
    const fixture = createBridgeHome(
      descriptor({ capabilities: legacyCapabilities })
    );
    roots.push(fixture.root);
    let confirmationAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) {
        return jsonResponse(status({ capabilities: legacyCapabilities }));
      }
      confirmationAttempts += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":true'));
            controller.error(new TypeError("response body terminated"));
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-legacy",
        confirmationHandle: "opaque-confirm-legacy",
        decision: "approve"
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "desktop_confirmation_outcome_unknown"
      })
    );
    expect(confirmationAttempts).toBe(1);
  });

  it("reports an unknown outcome without replaying against a legacy protocol-v1 Desktop", async () => {
    const legacyCapabilities = ["status.v1", "turn.ndjson.v1", "confirm.v1"];
    const fixture = createBridgeHome(
      descriptor({ capabilities: legacyCapabilities })
    );
    roots.push(fixture.root);
    let confirmationAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) {
        return jsonResponse(status({ capabilities: legacyCapabilities }));
      }
      confirmationAttempts += 1;
      throw new TypeError("response connection dropped");
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "legacy-confirm-request"
    });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-legacy",
        confirmationHandle: "opaque-confirm-legacy",
        decision: "approve"
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "desktop_confirmation_outcome_unknown",
        message: expect.stringContaining("may have resolved")
      })
    );
    expect(confirmationAttempts).toBe(1);
  });

  it("reports an unknown outcome after the single replay also loses its response", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    let confirmationAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      confirmationAttempts += 1;
      throw new TypeError("response connection dropped");
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "confirm-request-exhausted"
    });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "desktop_confirmation_outcome_unknown"
      })
    );
    expect(confirmationAttempts).toBe(2);
  });

  it("revokes confirmation replay safety before refreshing Desktop status", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    let statusAttempts = 0;
    let confirmationAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) {
        statusAttempts += 1;
        if (statusAttempts === 1) return jsonResponse(status());
        throw new TypeError("status response connection dropped");
      }
      confirmationAttempts += 1;
      if (confirmationAttempts === 1) {
        throw new TypeError("confirmation response connection dropped");
      }
      return jsonResponse({ ok: true, decision: "approve" });
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });

    await client.status();
    await expect(client.status()).rejects.toEqual(
      expect.objectContaining({ code: "desktop_unreachable" })
    );
    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "desktop_confirmation_outcome_unknown"
      })
    );
    expect(confirmationAttempts).toBe(1);
  });

  it.each(["AbortError", "TimeoutError"])(
    "does not retry a confirmation after a user-requested %s",
    async (errorName) => {
      const fixture = createBridgeHome();
      roots.push(fixture.root);
      const controller = new AbortController();
      let confirmationAttempts = 0;
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/v1/status")) return jsonResponse(status());
        confirmationAttempts += 1;
        throw controller.signal.reason;
      }) as typeof fetch;
      const client = createDesktopAppClient(fixture.env, { fetchImpl });

      await client.status();
      controller.abort(new DOMException("stop confirmation", errorName));
      await expect(
        client.confirm({
          turnId: "turn-1",
          confirmationHandle: "opaque-confirm-1",
          decision: "approve",
          signal: controller.signal
        })
      ).rejects.toEqual(
        expect.objectContaining({ code: "desktop_turn_detached" })
      );
      expect(confirmationAttempts).toBe(1);
    }
  );

  it.each([
    [
      "HTTP",
      () =>
        jsonResponse(
          {
            error: {
              code: "confirmation_decision_conflict",
              message:
                "A different decision already resolved this confirmation."
            }
          },
          409
        ),
      "confirmation_decision_conflict"
    ],
    [
      "protocol",
      () =>
        jsonResponse({
          ok: false,
          error: {
            code: "confirmation_rejected",
            message: "Desktop rejected the confirmation."
          }
        }),
      "confirmation_rejected"
    ]
  ])(
    "does not retry a structured confirmation %s failure",
    async (_kind, response, code) => {
      const fixture = createBridgeHome();
      roots.push(fixture.root);
      let confirmationAttempts = 0;
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/v1/status")) return jsonResponse(status());
        confirmationAttempts += 1;
        return response();
      }) as typeof fetch;
      const client = createDesktopAppClient(fixture.env, { fetchImpl });

      await client.status();
      await expect(
        client.confirm({
          turnId: "turn-1",
          confirmationHandle: "opaque-confirm-1",
          decision: "approve"
        })
      ).rejects.toEqual(expect.objectContaining({ code }));
      expect(confirmationAttempts).toBe(1);
    }
  );

  it("does not retry after receiving a malformed confirmation response", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    let confirmationAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      confirmationAttempts += 1;
      return new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
    ).rejects.toEqual(
      expect.objectContaining({ code: "desktop_response_invalid" })
    );
    expect(confirmationAttempts).toBe(1);
  });

  it("rejects blank NDJSON records instead of silently skipping malformed frames", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const client = createDesktopAppClient(fixture.env, {
      randomId: () => "request-1",
      fetchImpl: (async () =>
        ndjsonResponse([
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 1,
            kind: "done",
            data: { message: "Done.", actionCalls: [] }
          }),
          "",
          ""
        ])) as typeof fetch
    });

    await expect(
      client.turn({ message: "test", expectedContextRevision: "context-1" })
    ).rejects.toMatchObject({
      code: "desktop_stream_invalid"
    });
  });
});

// Synthetic receipt view written from the contract (open-core: no real data).
function receiptView(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: "change",
    tool: "pause_entity",
    title: "Pause",
    state: "done",
    asOf: null,
    scope: { workspaceName: "Example Co", crossWorkspace: false },
    caveats: [],
    receipt: { sentence: "Paused ad “Hook B”", tone: "ok", revertible: true },
    body: { target: { kind: "ad", label: "Hook B" }, rows: [], warnings: [] },
    ...overrides
  };
}

describe("answer view negotiation (result.view.v1, confirm.fields.v1)", () => {
  const VIEW_CAPABILITIES = [
    ...CAPABILITIES,
    RESULT_VIEW_CAPABILITY,
    CONFIRM_FIELDS_CAPABILITY
  ];

  function turnBodies(capabilities: {
    descriptor: string[];
    status: string[];
  }) {
    const fixture = createBridgeHome(
      descriptor({ capabilities: capabilities.descriptor })
    );
    roots.push(fixture.root);
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/v1/status")) {
          return jsonResponse(status({ capabilities: capabilities.status }));
        }
        bodies.push(JSON.parse(String(init?.body)));
        return ndjsonResponse([
          JSON.stringify({
            protocolVersion: 1,
            requestId: "view-turn",
            sequence: 1,
            kind: "done",
            data: { turnId: "turn-1", message: "ok", actionCalls: [] }
          })
        ]);
      }
    ) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "view-turn"
    });
    return { client, bodies };
  }

  it("never sends accept to a desktop that does not advertise result.view.v1", async () => {
    const { client, bodies } = turnBodies({
      descriptor: CAPABILITIES,
      status: CAPABILITIES
    });
    await client.status();
    expect(client.viewsCapable).toBe(false);
    expect(client.confirmFieldsCapable).toBe(false);

    await client.turn({ message: "hi", expectedContextRevision: "context-1" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("accept");
  });

  it.each([
    ["only the descriptor", VIEW_CAPABILITIES, CAPABILITIES, false],
    ["only the status", CAPABILITIES, VIEW_CAPABILITIES, false],
    ["both descriptor and status", VIEW_CAPABILITIES, VIEW_CAPABILITIES, true]
  ])(
    "sends accept only when %s advertise result.view.v1",
    async (_label, descriptorCapabilities, statusCapabilities, capable) => {
      const { client, bodies } = turnBodies({
        descriptor: descriptorCapabilities,
        status: statusCapabilities
      });
      await client.status();
      expect(client.viewsCapable).toBe(capable);
      expect(client.confirmFieldsCapable).toBe(capable);

      await client.turn({ message: "hi", expectedContextRevision: "context-1" });

      if (capable) {
        expect(bodies[0]?.accept).toEqual([RESULT_VIEW_CAPABILITY]);
      } else {
        expect(bodies[0]).not.toHaveProperty("accept");
      }
    }
  );

  it("revokes view and fields capabilities when a later status stops advertising them", async () => {
    const fixture = createBridgeHome(
      descriptor({ capabilities: VIEW_CAPABILITIES })
    );
    roots.push(fixture.root);
    const statuses = [VIEW_CAPABILITIES, CAPABILITIES];
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () =>
        jsonResponse(
          status({ capabilities: statuses.shift() ?? CAPABILITIES })
        )) as typeof fetch
    });

    await client.status();
    expect(client.viewsCapable).toBe(true);
    expect(client.confirmFieldsCapable).toBe(true);
    await client.status();
    expect(client.viewsCapable).toBe(false);
    expect(client.confirmFieldsCapable).toBe(false);
  });

  it("refuses confirm fields on a desktop without confirm.fields.v1 and sends nothing", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/v1/status")) return jsonResponse(status());
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl });

    await client.status();
    await expect(
      client.confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve",
        fields: { adSetBudget: { text: "30" } }
      })
    ).rejects.toMatchObject({
      name: "DesktopAppClientError",
      code: "desktop_update_required"
    });
    expect(requests.some((url) => url.endsWith("/v1/confirm"))).toBe(false);
  });

  it("forwards confirm fields to a desktop that advertises confirm.fields.v1", async () => {
    const fixture = createBridgeHome(
      descriptor({ capabilities: VIEW_CAPABILITIES })
    );
    roots.push(fixture.root);
    const confirmBodies: unknown[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/v1/status")) {
          return jsonResponse(status({ capabilities: VIEW_CAPABILITIES }));
        }
        confirmBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true });
      }
    ) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl,
      randomId: () => "confirm-fields"
    });

    await client.status();
    await client.confirm({
      turnId: "turn-1",
      confirmationHandle: "opaque-confirm-1",
      decision: "approve",
      fields: {
        adSetBudget: { text: "30" },
        split: { choice: "meta_split" }
      }
    });

    expect(confirmBodies).toEqual([
      {
        protocolVersion: 1,
        requestId: "confirm-fields",
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve",
        fields: {
          adSetBudget: { text: "30" },
          split: { choice: "meta_split" }
        }
      }
    ]);
  });

  it("returns the raw /v1/confirm JSON with the view decoded in place (no wrapper)", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const view = receiptView();
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () =>
        jsonResponse({
          ok: true,
          receipt: "Paused ad “Hook B”",
          runId: "run-1",
          view
        })) as typeof fetch
    });

    const result = await client.confirm({
      turnId: "turn-1",
      confirmationHandle: "opaque-confirm-1",
      decision: "approve"
    });

    expect(result).toEqual({
      ok: true,
      receipt: "Paused ad “Hook B”",
      runId: "run-1",
      view
    });
    expect(result).not.toHaveProperty("raw");
    expect(result.view?.receipt?.sentence).toBe("Paused ad “Hook B”");
  });

  it("turns an undecodable confirm view into undefined and keeps the rest of the JSON", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () =>
        jsonResponse({
          ok: true,
          receipt: "Done",
          view: receiptView({ kind: "carousel" })
        })) as typeof fetch
    });

    const result = await client.confirm({
      turnId: "turn-1",
      confirmationHandle: "opaque-confirm-1",
      decision: "decline"
    });

    expect(result.view).toBeUndefined();
    expect(result).toEqual({ ok: true, receipt: "Done" });
    expect(result).not.toHaveProperty("raw");
  });

  // A failed resolution (expired card, nothing sent, not sure it happened) still
  // rejects with its typed code, and carries the receipt view so the terminal can
  // print the same receipt Cmd+L shows instead of a transport error.
  it("rejects a failed /v1/confirm answer with its typed code and the decoded receipt view", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const expired = receiptView({
      state: "expired",
      receipt: { sentence: "This card expired.", tone: "warn", revertible: false }
    });
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () =>
        jsonResponse({
          ok: false,
          code: "confirmation_not_found",
          message: "This confirmation expired.",
          view: expired
        })) as typeof fetch
    });

    const failure = await client
      .confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DesktopAppClientError);
    expect(failure).toMatchObject({
      code: "confirmation_not_found",
      view: expired
    });
  });

  it("rejects a nested execution failure with the decoded outcome_unknown view and its reconcile", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const unknown = receiptView({
      state: "outcome_unknown",
      outcome: "unknown",
      retry: "check_first",
      reconcile: { label: "Check what happened", ask: "Did the pause go through?" }
    });
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () =>
        jsonResponse({
          ok: true,
          result: { ok: false, code: "cloud_unreachable", message: "Lost the line." },
          view: unknown
        })) as typeof fetch
    });

    const failure = await client
      .confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "cloud_unreachable", view: unknown });
    expect((failure as DesktopAppClientError).view?.reconcile?.ask).toBe(
      "Did the pause go through?"
    );
  });

  it("leaves the error's view undefined when a failed answer's view does not decode", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () =>
        jsonResponse({
          ok: false,
          code: "confirmation_not_found",
          message: "This confirmation expired.",
          view: receiptView({ state: "melted" })
        })) as typeof fetch
    });

    const failure = await client
      .confirm({
        turnId: "turn-1",
        confirmationHandle: "opaque-confirm-1",
        decision: "approve"
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "confirmation_not_found" });
    expect((failure as DesktopAppClientError).view).toBeUndefined();
  });
});

describe("step words and connection dots (step.words.v1, status.connections.v1)", () => {
  const STEP_WORDS = "step.words.v1";
  const CONNECTIONS = "status.connections.v1";

  function harness(capabilities: { descriptor: string[]; status: string[] }, statusExtra: Record<string, unknown> = {}) {
    const fixture = createBridgeHome(descriptor({ capabilities: capabilities.descriptor }));
    roots.push(fixture.root);
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/status")) {
        return jsonResponse(status({ capabilities: capabilities.status, ...statusExtra }));
      }
      bodies.push(JSON.parse(String(init?.body)));
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "words-turn",
          sequence: 1,
          kind: "done",
          data: { turnId: "turn-1", message: "ok", actionCalls: [] }
        })
      ]);
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl, randomId: () => "words-turn" });
    return { client, bodies };
  }

  const CONNECTION_ROWS = [
    { name: "Catalog", status: "broken" },
    { name: "Orders", status: "connected" },
    { name: "Ad Network", status: "off" }
  ];

  it("an old desktop is asked for nothing and its status has no connections", async () => {
    const { client, bodies } = harness({ descriptor: CAPABILITIES, status: CAPABILITIES }, { connections: CONNECTION_ROWS });
    const desktopStatus = await client.status();
    expect(client.stepWordsCapable).toBe(false);
    expect(desktopStatus).not.toHaveProperty("connections");

    await client.turn({ message: "hi", expectedContextRevision: "context-1" });

    expect(bodies[0]).not.toHaveProperty("accept");
  });

  it.each([
    ["only the descriptor", [...CAPABILITIES, STEP_WORDS], CAPABILITIES, false],
    ["only the status", CAPABILITIES, [...CAPABILITIES, STEP_WORDS], false],
    ["both descriptor and status", [...CAPABILITIES, STEP_WORDS], [...CAPABILITIES, STEP_WORDS], true]
  ])("asks for step words only when %s advertise step.words.v1", async (_label, descriptorCapabilities, statusCapabilities, capable) => {
    const { client, bodies } = harness({ descriptor: descriptorCapabilities, status: statusCapabilities });
    await client.status();
    expect(client.stepWordsCapable).toBe(capable);

    await client.turn({ message: "hi", expectedContextRevision: "context-1" });

    if (capable) {
      expect(bodies[0]?.accept).toEqual([STEP_WORDS]);
    } else {
      expect(bodies[0]).not.toHaveProperty("accept");
    }
  });

  it("asks for views and step words together, views first", async () => {
    const both = [...CAPABILITIES, RESULT_VIEW_CAPABILITY, STEP_WORDS];
    const { client, bodies } = harness({ descriptor: both, status: both });
    await client.status();

    await client.turn({ message: "hi", expectedContextRevision: "context-1" });

    expect(bodies[0]?.accept).toEqual([RESULT_VIEW_CAPABILITY, STEP_WORDS]);
  });

  it("stops asking for step words when a later status stops advertising them", async () => {
    const capable = [...CAPABILITIES, STEP_WORDS];
    const fixture = createBridgeHome(descriptor({ capabilities: capable }));
    roots.push(fixture.root);
    const statuses = [capable, CAPABILITIES];
    const client = createDesktopAppClient(fixture.env, {
      fetchImpl: (async () => jsonResponse(status({ capabilities: statuses.shift() ?? CAPABILITIES }))) as typeof fetch
    });

    await client.status();
    expect(client.stepWordsCapable).toBe(true);
    await client.status();
    expect(client.stepWordsCapable).toBe(false);
  });

  it.each([
    ["only the descriptor", [...CAPABILITIES, CONNECTIONS], CAPABILITIES, false],
    ["only the status", CAPABILITIES, [...CAPABILITIES, CONNECTIONS], false],
    ["both descriptor and status", [...CAPABILITIES, CONNECTIONS], [...CAPABILITIES, CONNECTIONS], true]
  ])("reads connections only when %s advertise status.connections.v1", async (_label, descriptorCapabilities, statusCapabilities, capable) => {
    const { client } = harness({ descriptor: descriptorCapabilities, status: statusCapabilities }, { connections: CONNECTION_ROWS });

    const desktopStatus = await client.status();

    if (capable) {
      expect(desktopStatus.connections).toEqual(CONNECTION_ROWS);
    } else {
      expect(desktopStatus).not.toHaveProperty("connections");
    }
  });

  it("the one-shot command prints each step in words, never the raw tool id", async () => {
    const RAW = "mcp__sample_app__list_sample_rows";
    const frame = (sequence: number, data: Record<string, unknown>) =>
      JSON.stringify({ protocolVersion: 1, requestId: "request-1", sequence, kind: "progress", data });
    const run = async (capabilities: string[]) => {
      const fixture = createBridgeHome(descriptor({ capabilities }));
      roots.push(fixture.root);
      const stderr: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/v1/status")) return jsonResponse(status({ capabilities }));
        return ndjsonResponse([
          frame(1, { type: "tool.start", stage: "tool", message: RAW, toolId: "c1", name: RAW, context: '{"level":"row"}', words: { label: "checking the catalog" } }),
          frame(2, { type: "tool.complete", stage: "tool", message: RAW, toolId: "c1", name: RAW, status: "ok", words: { label: "checking the catalog", result: "3 rows" } }),
          frame(3, { type: "tool.complete", stage: "tool", message: RAW, toolId: "c2", name: "mcp__sample_app__propose_pause_sample_item", status: "requires_confirmation" }),
          JSON.stringify({ protocolVersion: 1, requestId: "request-1", sequence: 4, kind: "done", data: { turnId: "turn-1", message: "Done.", actionCalls: [] } })
        ]);
      }) as typeof fetch;
      await runDesktopAppCommand(["how", "are", "the", "rows"], fixture.env, {
        fetchImpl,
        randomId: () => "request-1",
        io: { inputIsTTY: false, outputIsTTY: false, writeOut: () => undefined, writeErr: (text) => stderr.push(text) }
      });
      return stderr.join("");
    };

    const worded = await run([...CAPABILITIES, STEP_WORDS]);
    expect(worded).toBe("checking the catalog\nchecking the catalog ✓ 3 rows\nproposing pause sample item ▣ waiting for your OK\n");

    // An old desktop never negotiated words: generic words from the tool's name, and still no raw id.
    const plain = await run(CAPABILITIES);
    expect(plain).toBe("listing sample rows\nlisting sample rows ✓\nproposing pause sample item ▣ waiting for your OK\n");
    expect(`${worded}${plain}`).not.toMatch(/mcp__|sample_app|level/u);
  });

  it("a capable desktop that sends no connections, or a broken list, still gives a status", async () => {
    const capable = [...CAPABILITIES, CONNECTIONS];
    const absent = harness({ descriptor: capable, status: capable });
    expect(await absent.client.status()).not.toHaveProperty("connections");

    const broken = harness({ descriptor: capable, status: capable }, {
      connections: [{ name: "robin@example.test", status: "connected" }, { name: "Orders", status: "nope" }, { name: "Catalog", status: "connected" }]
    });
    expect((await broken.client.status()).connections).toEqual([{ name: "Catalog", status: "connected" }]);
  });
});

describe("infinite app command", () => {
  it("prints no progress line for a tool.view frame", async () => {
    const capabilities = [...CAPABILITIES, RESULT_VIEW_CAPABILITY];
    const fixture = createBridgeHome(descriptor({ capabilities }));
    roots.push(fixture.root);
    const stderr: string[] = [];
    const turnBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/v1/status")) {
          return jsonResponse(status({ capabilities }));
        }
        turnBodies.push(JSON.parse(String(init?.body)));
        return ndjsonResponse([
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 1,
            kind: "progress",
            data: {
              type: "tool.view",
              stage: "tool",
              message: "View title line",
              viewId: "view-1",
              name: "pause_entity",
              view: receiptView()
            }
          }),
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 2,
            kind: "progress",
            data: { type: "status.update", message: "Checking analytics" }
          }),
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 3,
            kind: "done",
            data: { turnId: "turn-1", message: "Done.", actionCalls: [] }
          })
        ]);
      }
    ) as typeof fetch;

    await runDesktopAppCommand(["pause", "it"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: () => undefined,
        writeErr: (text) => stderr.push(text)
      }
    });

    expect(turnBodies[0]?.accept).toEqual([RESULT_VIEW_CAPABILITY]);
    expect(stderr.join("")).toContain("Checking analytics");
    expect(stderr.join("")).not.toContain("View title line");
  });

  it("prints deterministic status without exposing descriptor credentials", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];

    await runDesktopAppCommand(["status"], fixture.env, {
      fetchImpl: (async () => jsonResponse(status())) as typeof fetch,
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    expect(rendered).toContain("Desktop Cmd+L: ready");
    expect(rendered).toContain("Provider: codex (gpt-5.6)");
    expect(rendered).toContain("Workspace: Acme");
    expect(rendered).not.toContain("owner-only-bearer-token");
  });

  it("neutralizes terminal controls in status fields", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];

    await runDesktopAppCommand(["status"], fixture.env, {
      fetchImpl: (async () =>
        jsonResponse(
          status({
            ready: false,
            provider: {
              id: "co\u001b[31mdex\u001b[0m",
              model: "gpt\u009b31m-5\u009b0m"
            },
            workspace: { name: "Acme\nFORGED" },
            error: {
              code: "desktop_not_ready",
              message: "Wait\rFORGED\u001b]0;spoof-title\u0007"
            }
          })
        )) as typeof fetch,
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    expect(rendered).toBe(
      [
        "Desktop Cmd+L: not ready",
        "Provider: codex (gpt-5)",
        "Workspace: Acme FORGED",
        "Blocker: Wait FORGED",
        ""
      ].join("\n")
    );
    expect(hasUnsafeTerminalControl(rendered, true)).toBe(false);
    expect(rendered).not.toContain("spoof-title");
  });

  it("renders progress and final answer, then leaves confirmations pending when noninteractive", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "progress",
          data: { type: "status.update", message: "Checking analytics" }
        }),
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 2,
          kind: "done",
          data: {
            turnId: "turn-1",
            message: "One opportunity.",
            actionCalls: [
              {
                actionId: "publish_page",
                status: "requires_confirmation",
                requiresConfirmation: true,
                confirmationHandle: "opaque-confirm-1",
                summary: "Publish the page"
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["show", "opportunities"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: (text) => stderr.push(text)
      }
    });

    expect(stdout.join("")).toContain("One opportunity.");
    expect(stdout.join("")).toContain("Pending confirmation: Publish the page");
    expect(stdout.join("")).toContain("not executed");
    expect(stderr.join("")).toContain("Checking analytics");
    expect(requests).toHaveLength(2);
    expect(requests.some((url) => url.endsWith("/v1/confirm"))).toBe(false);
  });

  it("renders Desktop-supplied deterministic confirmation details before the prompt", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: {
            turnId: "turn-1",
            message: "Campaign is ready.",
            actionCalls: [
              {
                actionId: "create_meta_campaign",
                status: "requires_confirmation",
                confirmationHandle: "opaque-confirm-1",
                summary: "Create the campaign api_key=summary-secret",
                confirmationDetails: [
                  { label: "Budget", value: "$500/day" },
                  { label: "Destination", value: "https://example.test/launch" }
                ],
                input: { apiToken: "must-not-use-fallback" }
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["create", "campaign"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    expect(rendered).toContain(
      [
        "Pending confirmation: Create the campaign api_key=[redacted]",
        "  Budget: $500/day",
        "  Destination: https://example.test/launch"
      ].join("\n")
    );
    expect(rendered).not.toContain("apiToken");
    expect(rendered).not.toContain("must-not-use-fallback");
    expect(rendered).not.toContain("summary-secret");
  });

  it("preserves multiline answer formatting while stripping terminal controls", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: {
            message: "# Result\n\n- One\n- \u001b[31mTwo\u001b[0m",
            actionCalls: []
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["show", "result"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    expect(stdout.join("")).toBe("# Result\n\n- One\n- Two\n");
  });

  it("renders a bounded deterministic generic input fallback with recursive secret redaction", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const longValue = "x".repeat(500);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: {
            turnId: "turn-1",
            message: "Campaign is ready.",
            actionCalls: [
              {
                actionId: "create_campaign",
                status: "requires_confirmation",
                confirmationHandle: "opaque-confirm-1",
                summary: "Create the campaign",
                input: {
                  note: "Bearer bearer-secret-value",
                  longValue,
                  campaign: {
                    destination:
                      "https://example.test/launch?token=query-secret-value",
                    legacyDestination:
                      "https://legacy-user:legacy-pass@example.test:99999/path",
                    budget: 500
                  },
                  apiToken: "raw-secret-value"
                }
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["create", "campaign"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    expect(rendered).toContain("  apiToken: [redacted]\n");
    expect(rendered).toContain("  campaign.budget: 500\n");
    expect(rendered).toContain("  note: Bearer [redacted]\n");
    expect(rendered).toContain("[truncated]");
    expect(rendered.indexOf("apiToken")).toBeLessThan(
      rendered.indexOf("campaign.budget")
    );
    expect(rendered.indexOf("campaign.budget")).toBeLessThan(
      rendered.indexOf("longValue")
    );
    expect(rendered.indexOf("longValue")).toBeLessThan(
      rendered.indexOf("note")
    );
    expect(rendered).not.toContain("raw-secret-value");
    expect(rendered).not.toContain("query-secret-value");
    expect(rendered).not.toContain("bearer-secret-value");
    expect(rendered).not.toContain("legacy-user");
    expect(rendered).not.toContain("legacy-pass");
    expect(rendered).not.toContain(longValue);
  });

  it("redacts URI userinfo and sensitive query values anywhere in confirmation text", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: {
            turnId: "turn-1",
            message: "Review the connection targets.",
            actionCalls: [
              {
                actionId: "publish_connections",
                status: "requires_confirmation",
                confirmationHandle: "opaque-confirm-1",
                summary:
                  "Deploy via https://alice:summary-pass@example.test/path?token=summary-query&view=full; reject https://malformed-user:malformed-pass@example.test:99999/path, https://query-user:query-pass?x@example.test/path, https:slash-user:slash-pass?x@example.test/path, and https:port-user:port-pass@example.test:99999/path.",
                confirmationDetails: [
                  {
                    label: "Access key",
                    value: "raw-access-key-secret"
                  },
                  {
                    label: "Mirror",
                    value:
                      "Use https://bob%40work:detail-pass@mirror.example.test/a?api_key=detail-query&mode=safe"
                  },
                  {
                    label: "Database",
                    value:
                      "postgresql://db-user:db-pass@db.example.test:5432/app?sslmode=require&password=db-query"
                  },
                  {
                    label: "Cache",
                    value:
                      "redis://cache-user:cache-pass@cache.example.test:6379/0?client_secret=cache-query"
                  },
                  {
                    label: "Callback",
                    value:
                      "myapp://callback#code=oauth-code-secret&state=public-state"
                  },
                  {
                    label: "Signed",
                    value:
                      "https://downloads.example.test/file#X-Amz-Signature=aws-signature-secret&mode=read"
                  },
                  {
                    label: "Public",
                    value:
                      "Docs https://example.test/guide?view=full and ssh://host.example.test/path"
                  },
                  {
                    label: "Malformed",
                    value:
                      "Reject https://bracket-user:bracket-pass@[::1/path)."
                  },
                  {
                    label: "Encoded query",
                    value:
                      "https://example.test/path?access_token%3Dabc123"
                  },
                  {
                    label: "Prefixed malformed",
                    value:
                      "_https://prefix-user:prefix-pass@example.test and 1https://digit-user:digit-pass@example.test"
                  },
                  {
                    label: "Malformed encoding",
                    value:
                      "https://example.test/path?to%ZZken=malformed-encoding-secret"
                  }
                ]
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["review", "connections"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    expect(rendered).toContain(
      "https://[redacted]@example.test/path?token=[redacted]&view=full"
    );
    expect(rendered).toContain(
      "https://[redacted]@mirror.example.test/a?api_key=[redacted]&mode=safe"
    );
    expect(rendered).toContain(
      "postgresql://[redacted]@db.example.test:5432/app?sslmode=require&password=[redacted]"
    );
    expect(rendered).toContain(
      "redis://[redacted]@cache.example.test:6379/0?client_secret=[redacted]"
    );
    expect(rendered).toContain("Access key: [redacted]");
    expect(rendered).toContain(
      "myapp://callback#code=[redacted]&state=public-state"
    );
    expect(rendered).toContain(
      "https://downloads.example.test/file#X-Amz-Signature=[redacted]&mode=read"
    );
    expect(rendered).toContain(
      "Public: Docs https://example.test/guide?view=full and ssh://host.example.test/path"
    );
    for (const secret of [
      "alice",
      "summary-pass",
      "summary-query",
      "bob%40work",
      "detail-pass",
      "detail-query",
      "db-user",
      "db-pass",
      "db-query",
      "cache-user",
      "cache-pass",
      "cache-query",
      "raw-access-key-secret",
      "oauth-code-secret",
      "aws-signature-secret",
      "malformed-user",
      "malformed-pass",
      "bracket-user",
      "bracket-pass",
      "query-user",
      "query-pass",
      "slash-user",
      "slash-pass",
      "port-user",
      "port-pass",
      "abc123",
      "prefix-user",
      "prefix-pass",
      "digit-user",
      "digit-pass",
      "malformed-encoding-secret"
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("fails closed on control-obfuscated credential URIs without swallowing public multiline text", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: {
            turnId: "turn-1",
            message: "Review the connection targets.",
            actionCalls: [
              {
                actionId: "publish_connections",
                status: "requires_confirmation",
                confirmationHandle: "opaque-confirm-1",
                summary: "Review these targets.",
                confirmationDetails: [
                  { label: "Userinfo", value: "https://alice:\u0001userinfo-secret@example.test/path" },
                  { label: "Query", value: "https://example.test/path?to\u0001ken=query-secret" },
                  { label: "Scheme", value: "https\u0001://alice:scheme-secret@example.test/path" },
                  { label: "Delimiter", value: "https:\u0001/\u0001/alice:delimiter-secret@example.test/path" },
                  { label: "Normalized query", value: "https:example.test/path?access_token%3Dnormalized-query-secret" },
                  { label: "Normalized fragment", value: "https:example.test/path#refresh_token%3Dnormalized-fragment-secret" },
                  { label: "Control query", value: "https:\u0001example.test/path?access_token%3Dcontrol-query-secret" },
                  { label: "Unicode", value: "https://query-user:\u2028query-pass?x@example.test/path" },
                  { label: "Triple slash", value: "https:///alice:triple-secret@example.test/path" },
                  { label: "Backslash", value: "https:\\\\alice:backslash-secret@example.test/path" },
                  { label: "Slashless", value: "https:alice:slashless-secret@example.test/path" },
                  { label: "Public", value: "Use\nhttps://public.example.test/path\nBudget: $500" }
                ]
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["review", "connections"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    for (const label of [
      "Userinfo",
      "Query",
      "Scheme",
      "Delimiter",
      "Normalized query",
      "Normalized fragment",
      "Control query",
      "Unicode",
      "Triple slash",
      "Backslash",
      "Slashless"
    ]) {
      expect(rendered).toContain(`${label}: [redacted]`);
    }
    expect(rendered).toContain(
      "Public: Use https://public.example.test/path Budget: $500"
    );
    for (const secret of [
      "userinfo-secret",
      "query-secret",
      "scheme-secret",
      "delimiter-secret",
      "normalized-query-secret",
      "normalized-fragment-secret",
      "control-query-secret",
      "query-user",
      "query-pass",
      "triple-secret",
      "backslash-secret",
      "slashless-secret"
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("redacts a multiline public URL with a sensitive param in place, not the whole confirm value", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/status")) return jsonResponse(status());
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "done",
          data: {
            turnId: "turn-1",
            message: "Review the release.",
            actionCalls: [
              {
                actionId: "publish_release",
                status: "requires_confirmation",
                confirmationHandle: "opaque-confirm-1",
                summary: "Review the release.",
                confirmationDetails: [
                  {
                    label: "Release note",
                    value:
                      "Deploy to:\nhttps://api.example.test/v1?token=render-secret\nRegion: us"
                  }
                ]
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["publish", "release"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      io: {
        inputIsTTY: false,
        outputIsTTY: false,
        writeOut: (text) => stdout.push(text),
        writeErr: () => undefined
      }
    });

    const rendered = stdout.join("");
    // A multiline PUBLIC url carrying a sensitive-named query param is redacted IN PLACE, not blanked
    // wholesale — the confirm card still has to show the user what they are approving.
    expect(rendered).toContain(
      "Release note: Deploy to: https://api.example.test/v1?token=[redacted] Region: us"
    );
    expect(rendered).not.toContain("render-secret");
  });

  it("neutralizes final, progress, summary, detail, and prompt-facing terminal text", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prompted: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/status")) return jsonResponse(status());
      if (url.endsWith("/v1/confirm")) {
        return jsonResponse({ ok: true, data: { created: true } });
      }
      return ndjsonResponse([
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 1,
          kind: "progress",
          data: {
            type: "status.update",
            message: "Checking\u001b[2J\nFORGED\u001b]0;progress-title\u0007"
          }
        }),
        JSON.stringify({
          protocolVersion: 1,
          requestId: "request-1",
          sequence: 2,
          kind: "done",
          data: {
            turnId: "turn-1",
            message:
              "Answer\u001b[31m safe\u001b[0m\nFORGED\u001b]0;answer-title\u0007",
            actionCalls: [
              {
                actionId: "publish_page",
                status: "requires_confirmation",
                confirmationHandle: "opaque-confirm-1",
                summary: "Publish\u001b[2J\nFORGED",
                confirmationDetails: [
                  {
                    label: "Bud\tget\u001b]0;label-title\u0007",
                    value: "$500\r\nFORGED\u009b2J"
                  }
                ]
              }
            ]
          }
        })
      ]);
    }) as typeof fetch;

    await runDesktopAppCommand(["publish", "it"], fixture.env, {
      fetchImpl,
      randomId: () => "request-1",
      promptConfirmation: async (action) => {
        prompted.push(action);
        return "approve";
      },
      io: {
        inputIsTTY: true,
        outputIsTTY: true,
        writeOut: (text) => stdout.push(text),
        writeErr: (text) => stderr.push(text)
      }
    });

    const renderedOut = stdout.join("");
    const renderedErr = stderr.join("");
    expect(renderedOut).toBe(
      [
        "Answer safe",
        "FORGED",
        "Pending confirmation: Publish FORGED",
        "  Bud get: $500 FORGED",
        "✓ Done",
        ""
      ].join("\n")
    );
    expect(renderedErr).toBe("Checking FORGED\n");
    expect(prompted).toEqual([
      expect.objectContaining({
        summary: "Publish FORGED",
        confirmationDetails: [{ label: "Bud get", value: "$500 FORGED" }]
      })
    ]);
    expect(hasUnsafeTerminalControl(renderedOut, true)).toBe(false);
    expect(hasUnsafeTerminalControl(renderedErr, true)).toBe(false);
    expect(hasUnsafeTerminalControl(JSON.stringify(prompted))).toBe(false);
    expect(`${renderedOut}${renderedErr}`).not.toContain("title");
  });

  it.each(["approve", "decline"] as const)(
    "sends an interactive %s decision with the originating turn and opaque handle",
    async (decision) => {
      const fixture = createBridgeHome();
      roots.push(fixture.root);
      const confirmBodies: unknown[] = [];
      const stdout: string[] = [];
      const fetchImpl = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/v1/status")) return jsonResponse(status());
          if (url.endsWith("/v1/confirm")) {
            confirmBodies.push(JSON.parse(String(init?.body)));
            return jsonResponse({ ok: true, decision });
          }
          return ndjsonResponse([
            JSON.stringify({
              protocolVersion: 1,
              requestId: "request-1",
              sequence: 1,
              kind: "done",
              data: {
                turnId: "turn-1",
                message: "Ready.",
                actionCalls: [
                  {
                    actionId: "publish_page",
                    status: "requires_confirmation",
                    requiresConfirmation: true,
                    confirmationHandle: "opaque-confirm-1",
                    summary: "Publish the page"
                  }
                ]
              }
            })
          ]);
        }
      ) as typeof fetch;

      await runDesktopAppCommand(["publish", "it"], fixture.env, {
        fetchImpl,
        randomId: () => "request-1",
        promptConfirmation: async () => decision,
        io: {
          inputIsTTY: true,
          outputIsTTY: true,
          writeOut: (text) => stdout.push(text),
          writeErr: () => undefined
        }
      });

      expect(confirmBodies).toEqual([
        {
          protocolVersion: 1,
          requestId: "request-1",
          turnId: "turn-1",
          confirmationHandle: "opaque-confirm-1",
          decision
        }
      ]);
      expect(stdout.join("")).toContain(
        decision === "approve" ? "✓ Done\n" : "✕ Dismissed — nothing was executed.\n"
      );
    }
  );

  describe("typed answers on the one-shot prompt", () => {
    const expiresAt = new Date(2026, 9, 1, 16, 45).toISOString();
    function oneShotFetch(confirmBodies: unknown[], approvalExtra: Record<string, unknown> = {}) {
      return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/status")) return jsonResponse(status());
        if (url.endsWith("/v1/confirm")) {
          const body = JSON.parse(String(init?.body)) as { decision: string };
          confirmBodies.push(body);
          return jsonResponse({ ok: true, decision: body.decision });
        }
        return ndjsonResponse([
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 1,
            kind: "done",
            data: {
              turnId: "turn-1",
              message: "Ready.",
              actionCalls: [
                {
                  actionId: "pause_ad",
                  status: "requires_confirmation",
                  confirmationHandle: "opaque-confirm-1",
                  summary: "Pause Ad 01",
                  view: {
                    v: 1, kind: "change", tool: "pause_ad", title: "Pause", state: "needs_yes", asOf: null,
                    scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
                    approval: { kind: "card", title: "Pause", summary: null, confirmLabel: "Pause",
                      dismissLabel: "Dismiss", rows: [], expiresAt, ...approvalExtra },
                    body: { target: { kind: "ad", label: "Ad 01" }, rows: [], warnings: [] }
                  }
                }
              ]
            }
          })
        ]);
      }) as typeof fetch;
    }

    async function runWithAnswers(answers: string[], approvalExtra: Record<string, unknown> = {}) {
      const fixture = createBridgeHome();
      roots.push(fixture.root);
      const confirmBodies: unknown[] = [];
      const stdout: string[] = [];
      const asked: string[] = [];
      await runDesktopAppCommand(["pause", "it"], fixture.env, {
        fetchImpl: oneShotFetch(confirmBodies, approvalExtra),
        randomId: () => "request-1",
        promptAnswer: async (question) => {
          asked.push(question);
          return answers.shift() ?? "";
        },
        io: {
          inputIsTTY: true,
          outputIsTTY: true,
          writeOut: (text) => stdout.push(text),
          writeErr: () => undefined
        }
      });
      return { confirmBodies, stdout: stdout.join(""), asked };
    }

    it.each([
      ["n", "decline"],
      ["no", "decline"],
      ["y", "approve"],
      ["yes", "approve"]
    ] as const)("%j sends decision %s", async (answer, decision) => {
      const run = await runWithAnswers([answer]);
      expect(run.confirmBodies).toEqual([expect.objectContaining({ decision })]);
      expect(run.asked).toHaveLength(1);
    });

    it("bare Enter re-prompts once; a second non-answer leaves the card pending and sends nothing", async () => {
      const run = await runWithAnswers(["", ""]);
      expect(run.asked).toHaveLength(2);
      expect(run.confirmBodies).toEqual([]);
      expect(run.stdout).toContain("Left for later — expires 16:45\n");
      expect(run.stdout).not.toContain("Dismissed");
    });

    it("bare Enter then n is a real decline", async () => {
      const run = await runWithAnswers(["", "n"]);
      expect(run.confirmBodies).toEqual([expect.objectContaining({ decision: "decline" })]);
      expect(run.stdout).toContain("✕ Dismissed — nothing was executed.\n");
    });

    it("a card with a required field is never approved here: y sends nothing, n declines", async () => {
      const fields = [{ key: "adSetBudget", label: "Daily budget", input: "money_per_day", required: true, currency: "USD", current: "40" }];
      const yes = await runWithAnswers(["y"], { fields });
      expect(yes.confirmBodies).toEqual([]);
      expect(yes.stdout).toContain("Answer this in the Infinite app or the chat session");
      expect(yes.asked.join("")).not.toContain("[y/n]");
      const no = await runWithAnswers(["n"], { fields });
      expect(no.confirmBodies).toEqual([expect.objectContaining({ decision: "decline" })]);
      // An optional field does not block a plain yes.
      const optional = await runWithAnswers(["y"], { fields: [{ ...fields[0], required: false }] });
      expect(optional.confirmBodies).toEqual([expect.objectContaining({ decision: "approve" })]);
    });
  });

  it.each(["data", "result", "envelope"] as const)(
    "reports a nested execution failure under %s without printing an approval",
    async (container) => {
      const fixture = createBridgeHome();
      roots.push(fixture.root);
      const stdout: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/v1/status")) return jsonResponse(status());
        if (url.endsWith("/v1/confirm")) {
          return jsonResponse({
            ok: true,
            [container]: {
              ok: false,
              code: "write_rejected",
              message: "Write rejected\nFORGED\u001b]0;failure-title\u0007"
            }
          });
        }
        return ndjsonResponse([
          JSON.stringify({
            protocolVersion: 1,
            requestId: "request-1",
            sequence: 1,
            kind: "done",
            data: {
              turnId: "turn-1",
              message: "Ready.",
              actionCalls: [
                {
                  actionId: "publish_page",
                  status: "requires_confirmation",
                  confirmationHandle: "opaque-confirm-1",
                  summary: "Publish the page"
                }
              ]
            }
          })
        ]);
      }) as typeof fetch;

      await expect(
        runDesktopAppCommand(["publish", "it"], fixture.env, {
          fetchImpl,
          randomId: () => "request-1",
          promptConfirmation: async () => "approve",
          io: {
            inputIsTTY: true,
            outputIsTTY: true,
            writeOut: (text) => stdout.push(text),
            writeErr: () => undefined
          }
        })
      ).rejects.toEqual(
        expect.objectContaining({
          code: "write_rejected",
          message: "Write rejected FORGED"
        })
      );
      expect(stdout.join("")).not.toContain("Confirmation approved");
      expect(stdout.join("")).not.toContain("executed");
      expect(stdout.join("")).not.toContain("failure-title");
    }
  );

  it("rejects an empty message without contacting Desktop", async () => {
    const fixture = createBridgeHome();
    roots.push(fixture.root);
    const fetchImpl = vi.fn();

    await expect(
      runDesktopAppCommand([], fixture.env, {
        fetchImpl: fetchImpl as typeof fetch
      })
    ).rejects.toEqual(expect.objectContaining({ code: "desktop_app_usage" }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps typed client errors distinguishable from generic failures", () => {
    const error = new DesktopAppClientError(
      "desktop_not_running",
      "Desktop is not running."
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("desktop_not_running");
  });
});

describe("resolveLiveBridge", () => {
  it("returns a NEW client when bootId changed (Desktop restarted)", () => {
    let boot = "boot-resolve-A";
    const read = () =>
      descriptor({ bootId: boot }) as unknown as DesktopBridgeDescriptor;
    const first = resolveLiveBridge({}, { readDescriptor: read });
    boot = "boot-resolve-B";
    const second = resolveLiveBridge({}, { readDescriptor: read });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.client).not.toBe(first!.client);
    expect(second!.descriptor.bootId).toBe("boot-resolve-B");
  });

  it("reuses the cached client while bootId is unchanged", () => {
    const read = () =>
      descriptor({ bootId: "boot-resolve-same" }) as unknown as DesktopBridgeDescriptor;
    const first = resolveLiveBridge({}, { readDescriptor: read });
    const second = resolveLiveBridge({}, { readDescriptor: read });
    expect(second!.client).toBe(first!.client);
  });

  it("returns null when no descriptor is present", () => {
    expect(resolveLiveBridge({}, { readDescriptor: () => null })).toBeNull();
  });

  it("reads the real descriptor from the effective home by default", () => {
    const fixture = createBridgeHome(
      descriptor({ bootId: "boot-resolve-real" })
    );
    roots.push(fixture.root);
    const resolved = resolveLiveBridge(fixture.env);
    expect(resolved).not.toBeNull();
    expect(resolved!.descriptor.bootId).toBe("boot-resolve-real");
  });

  it("maps a missing descriptor (desktop not running) to null, not a throw", () => {
    const root = mkdtempSync(join(tmpdir(), "infinite-desktop-client-"));
    roots.push(root);
    expect(
      resolveLiveBridge({ GROWTH_OS_HOME: root, HOME: root })
    ).toBeNull();
  });

  it("still surfaces a tampered/unsafe descriptor as a typed error", () => {
    const fixture = createBridgeHome(
      descriptor({ bootId: "boot-resolve-unsafe" })
    );
    roots.push(fixture.root);
    chmodSync(fixture.descriptorPath, 0o644); // group/world readable → unsafe
    expect(() => resolveLiveBridge(fixture.env)).toThrowError(
      expect.objectContaining({ code: "desktop_descriptor_unsafe" })
    );
  });
});

// T12 (P3.3): `o` opens app places through /v1/open (app.open.v1), and a yes
// on a card streams its receipt, then the agent's follow-up, in the same turn
// (confirm.stream.v1). Synthetic data only.
describe("app.open.v1 and confirm.stream.v1 (T12)", () => {
  const OPEN_CAPABILITY = "app.open.v1";
  const STREAM_CAPABILITY = "confirm.stream.v1";
  const ALL = [...CAPABILITIES, RESULT_VIEW_CAPABILITY, CONFIRM_FIELDS_CAPABILITY, OPEN_CAPABILITY, STREAM_CAPABILITY];

  function frame(sequence: number, kind: string, data: unknown, requestId = "stream-1") {
    return JSON.stringify({ protocolVersion: 1, requestId, sequence, kind, data });
  }

  function receiptFrame(sequence: number, result: Record<string, unknown> = { ok: true, receipt: "Paused ad “Hook B”" }) {
    return frame(sequence, "progress", {
      type: "action.receipt",
      stage: "tool",
      message: "",
      confirmationHandle: "opaque-confirm-1",
      view: receiptView(),
      result
    });
  }

  function harness(options: {
    descriptor?: string[];
    status?: string[];
    respond?: (path: string, body: Record<string, unknown>) => Response;
  } = {}) {
    const fixture = createBridgeHome(descriptor({ capabilities: options.descriptor ?? ALL }));
    roots.push(fixture.root);
    const calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/status") return jsonResponse(status({ capabilities: options.status ?? ALL }));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return options.respond?.(path, body) ?? jsonResponse({ ok: true });
    }) as typeof fetch;
    const client = createDesktopAppClient(fixture.env, { fetchImpl, randomId: () => "stream-1" });
    return { client, calls };
  }

  it.each([
    ["only the descriptor", ALL, CAPABILITIES, false],
    ["only the status", CAPABILITIES, ALL, false],
    ["both descriptor and status", ALL, ALL, true]
  ])("negotiates app.open.v1 and confirm.stream.v1 only when %s advertise them", async (_label, descriptorCaps, statusCaps, capable) => {
    const { client } = harness({ descriptor: descriptorCaps, status: statusCaps });
    expect(client.appOpenCapable).toBe(false);
    expect(client.confirmStreamCapable).toBe(false);
    await client.status();
    expect(client.appOpenCapable).toBe(capable);
    expect(client.confirmStreamCapable).toBe(capable);
  });

  it("opens a place with { protocolVersion: 1, place, params } and never sends or reads a url", async () => {
    const { client, calls } = harness({
      respond: () => jsonResponse({ protocolVersion: 1, requestId: "stream-1", ok: true, status: "opened" })
    });
    await client.status();
    const opened = await client.openPlace({
      protocolVersion: 1,
      place: "creative.library",
      params: { tab: "saved" },
      // A url on the link is never forwarded (the bridge strips it; the CLI never reads it).
      ...({ url: "infinite://open/v1?place=elsewhere" } as Record<string, string>)
    });
    expect(opened).toEqual({ ok: true, status: "opened" });
    expect(calls).toEqual([
      expect.objectContaining({
        path: "/v1/open",
        body: { protocolVersion: 1, requestId: "stream-1", place: "creative.library", params: { tab: "saved" } }
      })
    ]);
    expect(JSON.stringify(calls)).not.toContain("infinite://");
  });

  it("a place with no params opens with place alone", async () => {
    const { client, calls } = harness({
      respond: () => jsonResponse({ protocolVersion: 1, requestId: "stream-1", ok: false, status: "wrong_workspace" })
    });
    await client.status();
    expect(await client.openPlace({ protocolVersion: 1, place: "ads.meta" })).toEqual({ ok: false, status: "wrong_workspace" });
    expect(calls[0]?.body).toEqual({ protocolVersion: 1, requestId: "stream-1", place: "ads.meta" });
  });

  it("refuses to open on a desktop without app.open.v1 and sends nothing", async () => {
    const { client, calls } = harness({ descriptor: CAPABILITIES, status: CAPABILITIES });
    await client.status();
    await expect(client.openPlace({ protocolVersion: 1, place: "ads.meta" })).rejects.toMatchObject({
      code: "desktop_update_required"
    });
    expect(calls).toEqual([]);
  });

  it("reads an unknown open status as unavailable, never as opened", async () => {
    const { client } = harness({
      respond: () => jsonResponse({ protocolVersion: 1, requestId: "stream-1", ok: true, status: "teleported" })
    });
    await client.status();
    expect(await client.openPlace({ protocolVersion: 1, place: "ads.meta" })).toEqual({ ok: false, status: "unavailable" });
  });

  it("without confirm.stream.v1 a confirm stays one JSON call, exactly as before", async () => {
    const without = ALL.filter((capability) => capability !== STREAM_CAPABILITY);
    const { client, calls } = harness({ descriptor: without, status: without, respond: () => jsonResponse({ ok: true, view: receiptView() }) });
    await client.status();
    const onReceipt = vi.fn();
    const result = await client.confirm({
      turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true, onReceipt
    });
    expect(calls[0]?.body).toEqual({
      protocolVersion: 1, requestId: "stream-1", turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve"
    });
    expect(calls[0]?.headers.accept).toBe("application/json");
    expect(result).toEqual({ ok: true, view: receiptView() });
    expect(result).not.toHaveProperty("followUp");
    expect(onReceipt).not.toHaveBeenCalled();
  });

  it("a streamed confirm hands the receipt over first, then the follow-up's frames, then its answer", async () => {
    const order: string[] = [];
    const { client, calls } = harness({
      respond: () => ndjsonResponse([
        receiptFrame(1),
        frame(2, "progress", { type: "message.delta", stage: "message", message: "It", text: "It" }),
        frame(3, "done", { turnId: "turn-2", message: "It stopped spending. Want the ad set paused too?", actionCalls: [] })
      ])
    });
    await client.status();
    const result = await client.confirm({
      turnId: "turn-1",
      confirmationHandle: "opaque-confirm-1",
      decision: "approve",
      stream: true,
      onReceipt: (receipt) => order.push(`receipt:${String(receipt.receipt)}:${receipt.view?.state}`),
      onProgress: (progress) => order.push(`progress:${progress.sequence}`)
    });
    expect(calls[0]?.body).toEqual({
      protocolVersion: 1, requestId: "stream-1", turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true
    });
    expect(calls[0]?.headers.accept).toBe("application/x-ndjson");
    expect(order).toEqual(["receipt:Paused ad “Hook B”:done", "progress:2"]);
    expect(result).toMatchObject({ ok: true, receipt: "Paused ad “Hook B”", view: receiptView() });
    expect(result.followUp).toEqual({ turnId: "turn-2", message: "It stopped spending. Want the ad set paused too?", actionCalls: [] });
    expect(result).not.toHaveProperty("followUpError");
  });

  it("streams only a card that carried a view: without views negotiated it confirms plainly", async () => {
    const noViews = ALL.filter((capability) => capability !== RESULT_VIEW_CAPABILITY);
    const { client, calls } = harness({ descriptor: noViews, status: noViews });
    await client.status();
    await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true });
    expect(calls[0]?.body).not.toHaveProperty("stream");
  });

  it.each(["field_invalid", "receipt_view_unavailable"])(
    "a streamed %s error with no receipt rejects as not done, never as a receipt",
    async (code) => {
      const { client } = harness({
        respond: () => ndjsonResponse([frame(1, "error", { code, message: "That budget must be at least 1." })])
      });
      await client.status();
      const onReceipt = vi.fn();
      const error = await client.confirm({
        turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true, onReceipt
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "DesktopAppClientError", code, message: "That budget must be at least 1.", nothingRan: true });
      expect((error as DesktopAppClientError).view).toBeUndefined();
      expect(onReceipt).not.toHaveBeenCalled();
    }
  );

  it.each([
    "dispatch_uncertain",
    "meta_api_error",
    "ledger_unreachable",
    "some_new_ledger_code",
    // The app trusts these as not-sent only with a pre-send mark the stream frame does not carry.
    "invalid_request",
    "budget_choice_required",
    "daemon_timeout"
  ])(
    "a streamed %s error with no receipt never claims nothing ran: only proven not-sent codes do",
    async (code) => {
      const { client } = harness({
        respond: () => ndjsonResponse([
          frame(1, "error", { code, message: "Infinite already started this change and couldn't confirm the result." })
        ])
      });
      await client.status();
      const error = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "DesktopAppClientError", code });
      expect((error as { nothingRan?: boolean }).nothingRan).toBeUndefined();
      const lines = confirmErrorLines(error);
      expect(lines[0]?.text).not.toMatch(/Not done|✗/);
      expect(lines[0]?.text).toContain("Infinite already started this change");
    }
  );

  // P33-S1: the code alone never proves nothing ran; the app's pre-send mark (notSent) does.
  const APP_NOT_SENT_CODES = [
    "confirmation_not_found",
    "confirmation_expired",
    "confirmation_spent",
    "stale_turn_context",
    "desktop_not_ready",
    "recovery_pending",
    "unsafe_tool_blocked",
    "local_provider_busy",
    "daemon_timeout",
    "invalid_request",
    "budget_choice_required"
  ];

  it.each(APP_NOT_SENT_CODES)("a streamed %s error WITHOUT the app's notSent mark is unsure, never 'nothing ran'", async (code) => {
    const { client } = harness({
      respond: () => ndjsonResponse([frame(1, "error", { code, message: "Check it in the app before trying again." })])
    });
    await client.status();
    const error = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    expect((error as { nothingRan?: boolean }).nothingRan).toBeUndefined();
    expect(confirmErrorLines(error)[0]?.text).not.toMatch(/Not done|✗/u);
  });

  it.each(APP_NOT_SENT_CODES)("a streamed %s error WITH the app's notSent mark is a proven not-sent refusal: nothing ran", async (code) => {
    const { client } = harness({
      respond: () => ndjsonResponse([frame(1, "error", { code, message: "Nothing was executed.", notSent: true })])
    });
    await client.status();
    const error = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, nothingRan: true });
  });

  it("the mark counts only as a literal true (a string or 1 is unsure)", async () => {
    for (const notSent of ["true", 1, null]) {
      const { client } = harness({
        respond: () => ndjsonResponse([frame(1, "error", { code: "stale_turn_context", message: "Workspace changed.", notSent })])
      });
      await client.status();
      const error = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true })
        .catch((caught: unknown) => caught);
      expect((error as { nothingRan?: boolean }).nothingRan).toBeUndefined();
    }
  });

  it("an error with no receipt the bridge cannot vouch for (receipt_unavailable) never says nothing ran", async () => {
    const { client } = harness({
      respond: () => ndjsonResponse([frame(1, "error", { code: "receipt_unavailable", message: "Check it in the app before trying again." })])
    });
    await client.status();
    const error = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "receipt_unavailable" });
    expect((error as { nothingRan?: boolean }).nothingRan).toBeUndefined();
  });

  it("an error after the receipt keeps the receipt done and adds the follow-up's error", async () => {
    const { client } = harness({
      respond: () => ndjsonResponse([
        receiptFrame(1),
        frame(2, "error", { code: "turn_failed", message: "The follow-up could not finish." })
      ])
    });
    await client.status();
    const result = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true });
    expect(result).toMatchObject({ ok: true, view: { state: "done" } });
    expect(result.followUpError).toEqual({ code: "turn_failed", message: "The follow-up could not finish." });
    expect(result).not.toHaveProperty("followUp");
  });

  it("a stream lost before its receipt is an unknown outcome; lost after it, the receipt stands", async () => {
    const before = harness({ respond: () => ndjsonResponse([]) });
    await before.client.status();
    await expect(before.client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true }))
      .rejects.toMatchObject({ code: "desktop_confirmation_outcome_unknown" });

    const after = harness({ respond: () => ndjsonResponse([receiptFrame(1)]) });
    await after.client.status();
    const result = await after.client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true });
    expect(result).toMatchObject({ ok: true, view: { state: "done" } });
    expect(result.followUpError?.code).toBe("desktop_stream_missing_terminal");
  });

  it("a streamed decline's receipt carries the app's lines, as a plain decline does", async () => {
    const { client } = harness({
      respond: () => ndjsonResponse([
        receiptFrame(1, { ok: true, declined: true, askedCaption: "Ready.", dismissedCaption: "Okay, left it running." }),
        frame(2, "done", { turnId: "turn-1", message: "", actionCalls: [] })
      ])
    });
    await client.status();
    const result = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "decline", stream: true });
    expect(result).toMatchObject({ ok: true, declined: true, askedCaption: "Ready.", dismissedCaption: "Okay, left it running." });
  });

  it("a receipt whose result failed rejects with its code and view after the stream ends", async () => {
    const expired = receiptView({ state: "expired", receipt: { sentence: "This card expired.", tone: "warn", revertible: false } });
    const { client } = harness({
      respond: () => ndjsonResponse([
        frame(1, "progress", { type: "action.receipt", stage: "tool", message: "", confirmationHandle: "opaque-confirm-1", view: expired, result: { ok: false, code: "confirmation_not_found", message: "Expired." } }),
        frame(2, "done", { turnId: "turn-1", message: "", actionCalls: [] })
      ])
    });
    await client.status();
    const error = await client.confirm({ turnId: "turn-1", confirmationHandle: "opaque-confirm-1", decision: "approve", stream: true })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "confirmation_not_found", view: { state: "expired" } });
    expect((error as { nothingRan?: boolean }).nothingRan).toBeUndefined();
  });
});
