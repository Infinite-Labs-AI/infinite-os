import { describe, expect, it } from "vitest";
import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import {
  bridgeFrameToChatEvent,
  createDesktopTurnSource,
  type BridgeFrame,
  type DesktopTurnSourceClient,
  type DesktopTurnSourceInput
} from "./desktop-turn-source.js";

interface FakeClient extends DesktopTurnSourceClient {
  lastTurnBody: { message: string; sessionId?: string };
}

function fakeClient(opts: {
  sessionCapable: boolean;
  frames: BridgeFrame[];
}): FakeClient {
  const client: FakeClient = {
    sessionCapable: opts.sessionCapable,
    lastTurnBody: { message: "" },
    async turn(
      input: DesktopTurnSourceInput,
      onFrame: (frame: BridgeFrame) => void
    ) {
      client.lastTurnBody = {
        message: input.message,
        sessionId: input.sessionId
      };
      for (const frame of opts.frames) onFrame(frame);
      return {};
    }
  };
  return client;
}

describe("createDesktopTurnSource", () => {
  it("passes typed Codex frames through as ChatProgressEvents", async () => {
    const client = fakeClient({
      sessionCapable: true,
      frames: [
        { kind: "progress", data: { type: "tool.start", name: "list_sources" } },
        { kind: "done", data: { sessionId: "s1" }, message: "ok", actionCalls: [] }
      ]
    });
    const events: ChatProgressEvent[] = [];
    const src = createDesktopTurnSource(client);
    const r = await src.runTurn(
      "hi",
      undefined,
      (e) => events.push(e),
      new AbortController().signal
    );
    expect(
      events.find((e) => (e as { type?: string }).type === "tool.start")
    ).toMatchObject({ name: "list_sources" });
    expect(r.sessionId).toBe("s1");
    expect(client.lastTurnBody.sessionId).toBeUndefined(); // first turn: none yet
  });

  it("omits sessionId when the Desktop is not session-capable (silent degrade)", async () => {
    const client = fakeClient({
      sessionCapable: false,
      frames: [{ kind: "done", message: "ok", actionCalls: [] }]
    });
    const src = createDesktopTurnSource(client);
    await src.runTurn(
      "hi",
      "s-prev",
      () => {},
      new AbortController().signal
    );
    expect(client.lastTurnBody.sessionId).toBeUndefined(); // NOT sent, no error
  });

  it("resends the prior sessionId when the Desktop is session-capable", async () => {
    const client = fakeClient({
      sessionCapable: true,
      frames: [{ kind: "done", data: { sessionId: "s2" }, message: "ok", actionCalls: [] }]
    });
    const src = createDesktopTurnSource(client);
    const r = await src.runTurn(
      "again",
      "s2",
      () => {},
      new AbortController().signal
    );
    expect(client.lastTurnBody.sessionId).toBe("s2");
    expect(r.sessionId).toBe("s2");
  });

  it("surfaces redacted pending confirmations from a terminal done frame", async () => {
    const client = fakeClient({
      sessionCapable: true,
      frames: [
        {
          kind: "done",
          message: "queued",
          sessionId: "s3",
          data: { sessionId: "s3", turnId: "turn-1" },
          actionCalls: [
            {
              status: "requires_confirmation",
              confirmationHandle: "h1",
              actionId: "create_link",
              summary: "Set api_key=SUPERSECRET now",
              confirmationDetails: [
                { label: "password", value: "hunter2" },
                { label: "url", value: "https://example.com/p" }
              ]
            }
          ]
        }
      ]
    });
    const src = createDesktopTurnSource(client);
    const r = await src.runTurn(
      "do it",
      undefined,
      () => {},
      new AbortController().signal
    );
    expect(r.sessionId).toBe("s3");
    expect(r.pendingConfirmations).toHaveLength(1);
    const pending = r.pendingConfirmations![0]!;
    expect(pending.turnId).toBe("turn-1");
    expect(pending.confirmationHandle).toBe("h1");
    // Summary secret is redacted (mirrors the one-shot parser).
    expect(pending.summary).toBe("Set api_key=[redacted] now");
    expect(pending.summary).not.toContain("SUPERSECRET");
    // Sensitive-named detail is redacted; a plain URL passes through.
    expect(pending.confirmationDetails).toEqual([
      { label: "password", value: "[redacted]" },
      { label: "url", value: "https://example.com/p" }
    ]);
  });

  it("derives redacted confirmation details from raw action input when none supplied", async () => {
    const client = fakeClient({
      sessionCapable: true,
      frames: [
        {
          kind: "done",
          message: "queued",
          data: { turnId: "turn-2" },
          actionCalls: [
            {
              requiresConfirmation: true,
              confirmationHandle: "h2",
              actionId: "rotate_key",
              input: { token: "abc123", note: "hello" }
            }
          ]
        }
      ]
    });
    const src = createDesktopTurnSource(client);
    const r = await src.runTurn(
      "go",
      undefined,
      () => {},
      new AbortController().signal
    );
    const pending = r.pendingConfirmations![0]!;
    expect(pending.confirmationHandle).toBe("h2");
    // token is a sensitive key → redacted; note is plain.
    expect(pending.confirmationDetails).toContainEqual({
      label: "token",
      value: "[redacted]"
    });
    expect(pending.confirmationDetails).toContainEqual({
      label: "note",
      value: "hello"
    });
  });

  it("omits pendingConfirmations when no action requires confirmation", async () => {
    const client = fakeClient({
      sessionCapable: true,
      frames: [
        {
          kind: "done",
          message: "ok",
          data: { turnId: "turn-3" },
          actionCalls: [{ status: "completed", actionId: "list_sources" }]
        }
      ]
    });
    const src = createDesktopTurnSource(client);
    const r = await src.runTurn(
      "hi",
      undefined,
      () => {},
      new AbortController().signal
    );
    expect(r.pendingConfirmations).toBeUndefined();
  });

  it("throws when a confirmation is pending but the turn carries no turn id", async () => {
    const client = fakeClient({
      sessionCapable: true,
      frames: [
        {
          kind: "done",
          message: "ok",
          data: {},
          actionCalls: [
            {
              status: "requires_confirmation",
              confirmationHandle: "h9",
              actionId: "create_link",
              summary: "Create link"
            }
          ]
        }
      ]
    });
    const src = createDesktopTurnSource(client);
    await expect(
      src.runTurn("do it", undefined, () => {}, new AbortController().signal)
    ).rejects.toThrow(/turn id/i);
  });
});

describe("bridgeFrameToChatEvent", () => {
  it("passes a typed Codex progress event through unchanged (identity)", () => {
    const data = { type: "tool.complete", stage: "tool", name: "run_x" };
    const frame: BridgeFrame = { kind: "progress", data };
    expect(bridgeFrameToChatEvent(frame)).toBe(data);
  });

  it("maps a Claude streamed-text progress frame to message.delta", () => {
    const frame: BridgeFrame = { kind: "progress", data: { delta: "hello" } };
    expect(bridgeFrameToChatEvent(frame)).toMatchObject({
      type: "message.delta",
      stage: "message",
      text: "hello"
    });
  });

  it("maps a Claude tool_result frame to a tool.complete trail event", () => {
    const frame: BridgeFrame = {
      kind: "tool_result",
      data: { name: "list_sources", toolId: "t1" }
    };
    expect(bridgeFrameToChatEvent(frame)).toMatchObject({
      type: "tool.complete",
      stage: "tool",
      name: "list_sources"
    });
  });

  it("maps a Claude action frame to a tool.start trail event", () => {
    const frame: BridgeFrame = {
      kind: "action",
      data: { name: "publish_page", toolId: "t2" }
    };
    expect(bridgeFrameToChatEvent(frame)).toMatchObject({
      type: "tool.start",
      stage: "tool",
      name: "publish_page"
    });
  });

  it("returns null for terminal frames (done/error)", () => {
    expect(bridgeFrameToChatEvent({ kind: "done", sessionId: "s1" })).toBeNull();
    expect(
      bridgeFrameToChatEvent({ kind: "error", message: "boom" })
    ).toBeNull();
  });
});
