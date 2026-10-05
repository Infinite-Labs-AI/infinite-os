import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Key } from "ink";
import {
  MODEL_CATALOG,
  type TerminalModelSelection,
  type ModelOption,
  type ModelEffort
} from "@infinite-os/config";
import { Box, Text } from "./renderer.js";
import { themeInkStyle, type Theme } from "../theme.js";
import { truncateCells } from "../lib/display-width.js";

export interface ModelPickerSnapshot {
  options?: readonly ModelOption[];
  allowClaude?: boolean;
  connectInApp?: boolean;
  current?: TerminalModelSelection;
  ready: { codex: boolean; claude: boolean };
  warning?: string;
}
export interface ModelPickerAdapter {
  load(): Promise<ModelPickerSnapshot>;
  save(selection: TerminalModelSelection): Promise<string>;
  clear?(): Promise<string>;
  connectCodex?(
    onStatus: (text: string) => void,
    signal: AbortSignal
  ): Promise<boolean>;
}
type Step = "loading" | "models" | "effort" | "confirm" | "saving" | "auth";
export interface ModelPickerState {
  step: Step;
  index: number;
  modelIndex: number;
  effort?: ModelEffort;
  snapshot: ModelPickerSnapshot;
  authText?: string;
}
const initial = (): ModelPickerState => ({
  step: "loading",
  index: 0,
  modelIndex: 0,
  snapshot: { ready: { codex: false, claude: false } }
});
export function useModelPicker(
  adapter: ModelPickerAdapter | undefined,
  onResult: (text: string) => void
) {
  const [state, setState] = useState<ModelPickerState | null>(null);
  const generation = useRef(0);
  const authAbort = useRef<AbortController | null>(null);
  const pendingAction = useRef<"auth" | "saving" | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      authAbort.current?.abort();
    },
    []
  );
  const close = () => {
    authAbort.current?.abort();
    pendingAction.current = null;
    generation.current++;
    setState(null);
    onResult("Model unchanged.");
  };
  const open = useCallback(() => {
    if (!adapter) return;
    const token = ++generation.current;
    setState(initial());
    void adapter
      .load()
      .then((snapshot) => {
        if (token !== generation.current) return;
        const index = Math.max(
          0,
          (snapshot.options ?? MODEL_CATALOG).findIndex(
            (m) =>
              m.provider === snapshot.current?.provider &&
              m.id === snapshot.current?.model
          )
        );
        setState({ step: "models", index, modelIndex: index, snapshot });
      })
      .catch((error: unknown) => {
        if (token === generation.current) {
          setState(null);
          onResult(
            error instanceof Error
              ? `${error.message} Model unchanged.`
              : "Could not read model settings. Model unchanged."
          );
        }
      });
  }, [adapter, onResult]);
  const handleKey = (input: string, key: Key) => {
    if (!state || !adapter) return;
    const models = state.snapshot.options ?? MODEL_CATALOG;
    if (pendingAction.current === "saving" || state.step === "saving") return;
    if (key.ctrl && input === "c") {
      close();
      return;
    }
    if (key.escape) {
      if (
        state.step === "models" ||
        state.step === "loading" ||
        state.step === "auth" ||
        pendingAction.current === "auth"
      ) {
        close();
        return;
      }
      if (state.step === "effort") {
        setState({ ...state, step: "models", index: state.modelIndex });
        return;
      }
      const model = models[state.modelIndex];
      setState({
        ...state,
        step: model.efforts.length ? "effort" : "models",
        index: model.efforts.length
          ? Math.max(0, model.efforts.indexOf(state.effort!))
          : state.modelIndex
      });
      return;
    }
    if (
      state.step === "loading" ||
      state.step === "auth" ||
      pendingAction.current === "auth"
    )
      return;
    const model = models[state.modelIndex];
    const count =
      state.step === "models"
        ? models.length
        : state.step === "effort"
          ? model.efforts.length
          : 2;
    if (key.upArrow || key.downArrow) {
      setState({
        ...state,
        index: (state.index + (key.upArrow ? -1 : 1) + count) % count
      });
      return;
    }
    if (!key.return) return;
    if (state.step === "models") {
      const chosen = models[state.index];
      const current = state.snapshot.current;
      const savedEffort = current?.model === chosen.id && current.provider === chosen.provider ? current.effort : undefined;
      const effort = savedEffort && chosen.efforts.includes(savedEffort)
        ? savedEffort
        : chosen.efforts.includes("medium") ? "medium" : chosen.efforts[0];

      if (chosen.id === "") {
        setState({
          ...state,
          step: "confirm",
          modelIndex: state.index,
          index: 0,
          effort: undefined
        });
        return;
      }
      if (chosen.provider === "claude" && !state.snapshot.allowClaude) {
        setState(null);
        onResult("Claude in the terminal is coming soon. Nothing changed.");
        return;
      }
      if (!state.snapshot.ready[chosen.provider]) {
        if (chosen.provider === "claude" && !state.snapshot.connectInApp) {
          setState(null);
          onResult(
            "Run claude auth login with your Claude subscription, then try /model again. Nothing changed."
          );
          return;
        }
        if (state.snapshot.connectInApp) {
          setState(null);
          onResult("Connect this provider in the app. Nothing changed.");
          return;
        }
        if (chosen.provider === "codex" && adapter.connectCodex) {
          pendingAction.current = "auth";
          const token = ++generation.current;
          const abort = new AbortController();
          authAbort.current = abort;
          setState({
            ...state,
            step: "auth",
            authText: "Starting Codex sign-in…"
          });
          void adapter
            .connectCodex((text) => {
              if (token === generation.current)
                setState({ ...state, step: "auth", authText: text });
            }, abort.signal)
            .then((ok) => {
              if (token !== generation.current) return;
              pendingAction.current = null;
              if (!ok) {
                setState(null);
                onResult("Sign-in did not finish. Model unchanged.");
                return;
              }
              setState({
                ...state,
                step: chosen.efforts.length ? "effort" : "confirm",
                modelIndex: state.index,
                index: Math.max(0, chosen.efforts.indexOf(effort!)),
                effort,
                snapshot: {
                  ...state.snapshot,
                  ready: { ...state.snapshot.ready, codex: true }
                }
              });
            })
            .catch(() => {
              if (token === generation.current) {
                setState(null);
                pendingAction.current = null;
                onResult("Sign-in did not finish. Model unchanged.");
              }
            });
          return;
        }
        setState(null);
        onResult(
          "Codex sign-in needed. Run /codex login, then try /model again. Model unchanged."
        );
        return;
      }
      setState({
        ...state,
        step: chosen.efforts.length ? "effort" : "confirm",
        modelIndex: state.index,
        index: Math.max(0, chosen.efforts.indexOf(effort!)),
        effort
      });
      return;
    }
    if (state.step === "effort") {
      setState({
        ...state,
        step: "confirm",
        effort: model.efforts[state.index],
        index: 0
      });
      return;
    }
    if (state.index === 1) {
      close();
      return;
    }
    pendingAction.current = "saving";
    const token = ++generation.current;
    setState({ ...state, step: "saving" });
    void (
      model.id === "" && adapter.clear
        ? adapter.clear()
        : adapter.save({
            provider: model.provider,
            model: model.id,
            ...(state.effort ? { effort: state.effort } : {})
          })
    )
      .then((text) => {
        if (token === generation.current) {
          pendingAction.current = null;
          setState(null);
          onResult(text);
        }
      })
      .catch(() => {
        if (token === generation.current) {
          setState(null);
          pendingAction.current = null;
          onResult("Could not save the model. Model unchanged.");
        }
      });
  };
  return { state, open, handleKey };
}
export function modelPickerLines(
  state: ModelPickerState
): Array<{ text: string; selected?: boolean; dim?: boolean }> {
  const models = state.snapshot.options ?? MODEL_CATALOG;
  const model = models[state.modelIndex]!;
  if (state.step === "loading") return [{ text: "Loading model settings…" }];
  if (state.step === "saving") return [{ text: "Saving model…" }];
  if (state.step === "auth")
    return (state.authText ?? "Signing in…")
      .split("\n")
      .map((text) => ({ text }));
  const lines: Array<{ text: string; selected?: boolean; dim?: boolean }> = [];
  if (state.step === "models") {
    lines.push(
      { text: "Choose a model · for your next message" },
      { text: "" }
    );
    models.forEach((m, i) => {
      if (
        m.id &&
        (i === 0 ||
          models[i - 1]?.id === "" ||
          models[i - 1]?.provider !== m.provider)
      )
        lines.push({
          text: `${m.provider.toUpperCase()}${m.provider === "claude" && !state.snapshot.allowClaude ? " · coming soon" : state.snapshot.ready[m.provider] ? "" : state.snapshot.connectInApp ? " · connect in the app" : " · sign-in needed"}`,
          dim: true
        });
      const tags = [
        m.new ? "new" : "",
        m.provider === "claude" && !state.snapshot.allowClaude
          ? "coming soon"
          : "",
        state.snapshot.current?.model === m.id &&
        state.snapshot.current.provider === m.provider
          ? "current"
          : "",
        m.default && m.provider === "codex" ? "default" : ""
      ].filter(Boolean);
      lines.push({
        text: `${i === state.index ? "➜" : " "} ${m.label}${tags.length ? `   ${tags.join(" · ")}` : ""}`,
        selected: i === state.index
      });
    });
  } else if (state.step === "effort") {
    lines.push(
      { text: "How hard should it think?" },
      {
        text: `${model.label} · now: ${state.snapshot.current?.model === model.id ? (state.snapshot.current.effort ?? "medium") : "medium"}`,
        dim: true
      },
      { text: "" }
    );
    model.efforts.forEach((effort, i) => {
      const label = effort === "xhigh" ? "xHigh" : effort[0].toUpperCase() + effort.slice(1);
      lines.push({
        text: `${i === state.index ? "➜" : " "} ${label}${effort === "medium" ? "   default" : ""}`,
        selected: i === state.index
      });
    });
  } else {
    lines.push(
      {
        text:
          model.id === ""
            ? "Use Desktop default?"
            : `Use ${model.provider === "codex" ? "Codex" : "Claude"} · ${model.label} · ${state.effort ?? "Default"}?`
      },
      { text: "Applies from your next message.", dim: true },
      { text: "" }
    );
    ["Save and use", "Cancel"].forEach((label, i) =>
      lines.push({
        text: `${i === state.index ? "➜" : " "} ${label}`,
        selected: i === state.index
      })
    );
  }
  if (state.snapshot.warning)
    lines.push({ text: state.snapshot.warning, dim: true });
  return lines;
}
export function ModelPicker({
  state,
  theme,
  width
}: {
  state: ModelPickerState | null;
  theme: Theme;
  width: number;
}) {
  if (!state) return null;
  return (
    <Box flexDirection="column">
      {modelPickerLines(state).map((line, i) => (
        <Text
          key={i}
          {...themeInkStyle(
            theme,
            line.selected ? "sel" : line.dim ? "dim" : ""
          )}
          bold={line.selected}
        >
          {truncateCells(line.text || " ", width)}
        </Text>
      ))}
    </Box>
  );
}
