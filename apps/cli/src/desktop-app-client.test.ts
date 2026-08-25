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

describe("infinite app command", () => {
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
        "Confirmation approved: Publish FORGED",
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
        `Confirmation ${decision === "approve" ? "approved" : "declined"}: Publish the page`
      );
    }
  );

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
