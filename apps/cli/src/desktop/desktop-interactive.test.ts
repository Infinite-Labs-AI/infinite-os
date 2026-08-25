import { describe, expect, it, vi } from "vitest";
import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import type {
  DesktopAppClient,
  DesktopStatus
} from "../desktop-app-client.js";
import {
  adaptDesktopClientToTurnSource,
  createDesktopSessionTurnRunner,
  runDesktopInteractive,
  type DesktopInteractiveIo
} from "./desktop-interactive.js";
import type { DesktopTurnSource } from "./desktop-turn-source.js";

const env = {} as NodeJS.ProcessEnv;
const io: DesktopInteractiveIo = { writeOut: () => {}, writeErr: () => {} };

interface TurnSpec {
  sessionId?: string;
  emit?: ChatProgressEvent[];
}

interface FakeTurnSource extends DesktopTurnSource {
  calls: Array<{ message: string; sessionId?: string }>;
}

/** A turn-source stub that records each call and replays scripted events/outcomes. */
function fakeTurnSource(returns: TurnSpec[]): FakeTurnSource {
  const calls: FakeTurnSource["calls"] = [];
  return {
    calls,
    async runTurn(message, sessionId, onEvent, _signal) {
      calls.push({ message, sessionId });
      const spec = returns[calls.length - 1] ?? {};
      for (const event of spec.emit ?? []) onEvent(event);
      return spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {};
    }
  };
}

describe("runDesktopInteractive", () => {
  it("holds one session across turns and renders through turnController", async () => {
    const src = fakeTurnSource([{ sessionId: "s1" }, { sessionId: "s1" }]);
    const rec: any[] = [];
    const tc = { recordProgressEvent: (e: any) => rec.push(e) /*...*/ };
    const loop = runDesktopInteractive(env, io, {
      turnSource: src,
      turnController: tc,
      lines: ["hi", "again"]
    });
    await loop;
    expect(src.calls[1].sessionId).toBe("s1"); // 2nd turn resends the 1st's session
  });

  it("feeds each turn's events to turnController.recordProgressEvent", async () => {
    const event: ChatProgressEvent = {
      type: "tool.start",
      stage: "tool",
      message: "list_sources",
      toolId: "t1",
      name: "list_sources",
      context: ""
    };
    const src = fakeTurnSource([{ sessionId: "s1", emit: [event] }]);
    const rec: ChatProgressEvent[] = [];
    await runDesktopInteractive(env, io, {
      turnSource: src,
      turnController: { recordProgressEvent: (e) => rec.push(e) },
      lines: ["hi"]
    });
    expect(rec).toEqual([event]);
  });

  it("/exit stops the loop before later lines run", async () => {
    const src = fakeTurnSource([{ sessionId: "s1" }]);
    await runDesktopInteractive(env, io, {
      turnSource: src,
      turnController: { recordProgressEvent: () => {} },
      lines: ["hi", "/exit", "never"]
    });
    expect(src.calls.map((c) => c.message)).toEqual(["hi"]); // "never" never dispatched
  });

  it("/help prints help and does not open a turn", async () => {
    const src = fakeTurnSource([]);
    const out: string[] = [];
    await runDesktopInteractive(
      env,
      { writeOut: (t) => out.push(t), writeErr: () => {} },
      {
        turnSource: src,
        turnController: { recordProgressEvent: () => {} },
        lines: ["/help"]
      }
    );
    expect(src.calls).toHaveLength(0);
    expect(out.join("")).toMatch(/\/exit/);
  });

  it("resolves a requires_confirmation action in-session via the confirmation seam", async () => {
    const src: DesktopTurnSource = {
      async runTurn() {
        return {
          sessionId: "s1",
          pendingConfirmations: [
            {
              turnId: "t1",
              confirmationHandle: "h1",
              summary: "Create link",
              confirmationDetails: []
            }
          ]
        };
      }
    } as unknown as DesktopTurnSource;
    const confirm = vi.fn(async () => ({ ok: true }));
    await runDesktopInteractive(env, io, {
      turnSource: src,
      turnController: { recordProgressEvent: () => {} },
      confirmation: {
        io: {
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: async () => "y",
          write: () => {}
        },
        client: { confirm }
      },
      lines: ["do it"]
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationHandle: "h1", decision: "approve" })
    );
  });

  it("does not invoke the confirmation seam when a turn has no pending confirmations", async () => {
    const src = fakeTurnSource([{ sessionId: "s1" }]);
    const confirm = vi.fn(async () => ({ ok: true }));
    await runDesktopInteractive(env, io, {
      turnSource: src,
      turnController: { recordProgressEvent: () => {} },
      confirmation: {
        io: {
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: async () => "y",
          write: () => {}
        },
        client: { confirm }
      },
      lines: ["hi"]
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not resend a sessionId the Desktop never issued", async () => {
    // Incapable Desktop → turn-source returns no sessionId; the loop must not
    // fabricate one for the next turn (single-turn degrade, not a stale resend).
    const src = fakeTurnSource([{}, {}]);
    await runDesktopInteractive(env, io, {
      turnSource: src,
      turnController: { recordProgressEvent: () => {} },
      lines: ["hi", "again"]
    });
    expect(src.calls[0].sessionId).toBeUndefined();
    expect(src.calls[1].sessionId).toBeUndefined();
  });
});

describe("adaptDesktopClientToTurnSource", () => {
  it("maps real progress frames to bridge progress frames", async () => {
    const progressData = { type: "message.delta", delta: "hello" };
    const turn = vi.fn(
      async (
        _input: unknown,
        onProgress: (frame: { data: unknown }) => void
      ) => {
        onProgress({ data: progressData });
        return { message: "done", actionCalls: [], sessionId: "s9" };
      }
    );
    const client = { sessionCapable: true, turn } as any;
    const adapter = adaptDesktopClientToTurnSource(client, "rev-1");

    const frames: unknown[] = [];
    const outcome = await adapter.turn(
      { message: "hi", sessionId: "prev", signal: new AbortController().signal },
      (frame) => frames.push(frame)
    );

    // The real client is called with the injected contextRevision + sessionId.
    expect(turn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "hi",
        expectedContextRevision: "rev-1",
        sessionId: "prev"
      }),
      expect.any(Function)
    );
    // The streamed progress frame is forwarded as a bridge `progress` frame.
    expect(frames[0]).toMatchObject({ kind: "progress", data: progressData });
    // The terminal outcome (session id) is surfaced for the next turn.
    expect((outcome as { sessionId?: string }).sessionId).toBe("s9");
  });

  it("delegates sessionCapable to the real client", () => {
    const adapter = adaptDesktopClientToTurnSource(
      { sessionCapable: false, turn: vi.fn() } as any,
      "rev-1"
    );
    expect(adapter.sessionCapable).toBe(false);
  });
});

// ── createDesktopSessionTurnRunner (per-turn revalidation, Task 2.4) ─────────

interface StatusSpec {
  rev: string;
  workspace?: { id?: string; name: string };
  provider?: { id: string; model?: string };
  ready?: boolean;
  error?: { code: string; message: string };
}

function statusFor(spec: StatusSpec): DesktopStatus {
  return {
    service: "infinite-desktop-cmdl",
    bootId: "boot-1",
    protocol: { min: 1, max: 1 },
    capabilities: ["status.v1", "turn.ndjson.v1", "confirm.v1"],
    ready: spec.ready ?? true,
    contextRevision: spec.rev,
    provider: spec.provider ?? { id: "codex", model: "gpt-5.6" },
    workspace: spec.workspace ?? { id: "ws-1", name: "Acme" },
    ...(spec.error ? { error: spec.error } : {})
  } as DesktopStatus;
}

/** One status per turn, holding the last. */
function statusSeq(specs: StatusSpec[]): () => DesktopStatus {
  let n = 0;
  return () => statusFor(specs[Math.min(n++, specs.length - 1)]!);
}

function statusOk(): () => DesktopStatus {
  return () => statusFor({ rev: "rev-1" });
}

interface MakeTurnSourceOptions {
  onSend?: (message: string) => void;
  bootIds?: string[];
  resolveNull?: boolean;
}

/**
 * Build the revalidating runner over a fake client: scripted `/v1/status`
 * results, a `turn` that records what was SENT (message + sessionId) and
 * issues a fresh `session-N` per accepted turn.
 */
function makeTurnSource(
  nextStatus: () => DesktopStatus,
  options: MakeTurnSourceOptions = {}
) {
  const sentSessions: Array<string | undefined> = [];
  let turns = 0;
  let resolves = 0;
  const client = {
    sessionCapable: true,
    async status() {
      return nextStatus();
    },
    async turn(input: { message: string; sessionId?: string }) {
      sentSessions.push(input.sessionId);
      options.onSend?.(input.message);
      turns += 1;
      return {
        message: "ok",
        actionCalls: [],
        sessionId: `session-${turns}`
      };
    },
    async confirm() {
      return { ok: true };
    }
  } as unknown as DesktopAppClient;
  const runner = createDesktopSessionTurnRunner({
    resolveBridge: () => {
      if (options.resolveNull) return null;
      const bootId =
        options.bootIds?.[Math.min(resolves, options.bootIds.length - 1)] ??
        "boot-1";
      resolves += 1;
      return { descriptor: { bootId }, client };
    }
  });
  return Object.assign(runner, { sentSessions });
}

describe("createDesktopSessionTurnRunner", () => {
  it("clears sessionId when contextRevision changes between turns", async () => {
    const src = makeTurnSource(statusSeq([{ rev: "1" }, { rev: "2" }]));
    await src.turn("a");
    const before = src.sessionId();
    await src.turn("b");
    expect(src.sessionId()).not.toBe(before); // reset on rev change
    // The reset happened BEFORE the send: turn b carried no stale session.
    expect(src.sentSessions).toEqual([undefined, undefined]);
  });

  it("threads the session forward when nothing changed", async () => {
    const src = makeTurnSource(statusOk());
    await src.turn("a");
    await src.turn("b");
    expect(src.sentSessions).toEqual([undefined, "session-1"]);
  });

  it("clears sessionId when the bootId changes (Desktop restarted)", async () => {
    const src = makeTurnSource(statusOk(), { bootIds: ["boot-A", "boot-B"] });
    await src.turn("a");
    await src.turn("b");
    expect(src.sentSessions).toEqual([undefined, undefined]);
  });

  it("clears sessionId when the operated workspace changes", async () => {
    const src = makeTurnSource(
      statusSeq([
        { rev: "1", workspace: { id: "ws-1", name: "Acme" } },
        { rev: "1", workspace: { id: "ws-2", name: "Bravo" } }
      ])
    );
    await src.turn("a");
    await src.turn("b");
    expect(src.sentSessions).toEqual([undefined, undefined]);
  });

  it("clears sessionId when the provider/model changes", async () => {
    const src = makeTurnSource(
      statusSeq([
        { rev: "1", provider: { id: "codex", model: "gpt-5.6" } },
        { rev: "1", provider: { id: "claude", model: "fable" } }
      ])
    );
    await src.turn("a");
    await src.turn("b");
    expect(src.sentSessions).toEqual([undefined, undefined]);
  });

  it("never auto-replays a failed turn", async () => {
    const sent: string[] = [];
    const src = makeTurnSource(statusOk(), {
      onSend: (m) => {
        sent.push(m);
        throw new Error("drop");
      }
    });
    await src.turn("x").catch(() => {});
    expect(sent).toEqual(["x"]); // exactly once, no retry
  });

  it("accepts a user-initiated resend after a failure (still one send per call)", async () => {
    const sent: string[] = [];
    let fail = true;
    const src = makeTurnSource(statusOk(), {
      onSend: (m) => {
        sent.push(m);
        if (fail) {
          fail = false;
          throw new Error("drop");
        }
      }
    });
    await src.turn("x").catch(() => {});
    await src.turn("x"); // the USER retyped it — allowed
    expect(sent).toEqual(["x", "x"]);
  });

  it("returns busy on a concurrent turn", async () => {
    const src = makeTurnSource(statusOk());
    const p = src.turn("slow");
    await expect(src.turn("second")).resolves.toMatchObject({ busy: true });
    await p;
    // The busy call never reached the client.
    expect(src.sentSessions).toHaveLength(1);
  });

  it("surfaces the precise not-ready state without sending the turn", async () => {
    const src = makeTurnSource(
      statusSeq([
        {
          rev: "1",
          ready: false,
          error: { code: "subscription_required", message: "Subscription required." }
        }
      ])
    );
    await expect(src.turn("x")).rejects.toMatchObject({
      code: "subscription_required"
    });
    expect(src.sentSessions).toHaveLength(0);
  });

  it("throws desktop_not_running when no live bridge resolves", async () => {
    const src = makeTurnSource(statusOk(), { resolveNull: true });
    await expect(src.turn("x")).rejects.toMatchObject({
      code: "desktop_not_running"
    });
  });

  it("clears the busy flag after a failed turn so the next line still runs", async () => {
    let failFirst = true;
    const src = makeTurnSource(statusOk(), {
      onSend: () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("drop");
        }
      }
    });
    await src.turn("a").catch(() => {});
    await expect(src.turn("b")).resolves.not.toMatchObject({ busy: true });
  });

  it("delegates confirm to the client that ran the last turn", async () => {
    const src = makeTurnSource(statusOk());
    await src.turn("a");
    await expect(
      src.confirm({
        turnId: "t1",
        confirmationHandle: "h1",
        decision: "approve"
      })
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a confirm before any turn ran", async () => {
    const src = makeTurnSource(statusOk());
    await expect(
      src.confirm({
        turnId: "t1",
        confirmationHandle: "h1",
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "desktop_confirmation_invalid" });
  });
});
