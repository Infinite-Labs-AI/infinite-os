// Ink renderer adapter.
//
// Centralizes the Ink surface used by the TUI so the underlying renderer can
// be swapped without touching every component. By default it re-exports the
// stock `ink` renderer (unchanged behavior). When INFINITE_INK_RENDERER is set
// to "infinite" (legacy aliases "hermes"/"hermes-ink" still accepted), it routes
// to the vendored @infinite-os/ink renderer — a custom Ink fork with native
// cursor handling, cell-level diffing, and frame-paced animation — adapting the
// few APIs whose shapes differ.
//
// The vendored backend is wired and verified to render headlessly, but the
// composer's native cursor parking still uses a no-op shim on this path
// (stock `useCursor` -> vendored `useDeclaredCursor` is a component-level port,
// tracked separately). Until that lands, run the vendored backend with:
//   INFINITE_INK_RENDERER=infinite
//
// `Static` (finished turns printed once into terminal scrollback) is the same
// kind of gap: the vendored renderer has no `<Static>`, so its backend gets a shim
// that renders the items IN FLOW, every frame. That keeps the session rendering,
// but on the vendored path committed turns stay in the live frame and the old
// "tall frame loses scrollback" problem remains until `Static` is ported.
import React from "react";
import * as inkStock from "ink";
import * as infiniteInk from "@infinite-os/ink";

import { guardResizeReflow } from "./reflow-guard.js";
import { resolveInkRenderer, type CliInkRenderer } from "./renderer-choice.js";

export { resolveInkRenderer, type CliInkRenderer } from "./renderer-choice.js";

type InkModule = typeof inkStock;

function stripStockOnlyOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) {
    return {};
  }
  // @infinite-os/ink RenderOptions has no maxFps; it paces frames internally.
  const { maxFps: _maxFps, ...rest } = options;
  return rest;
}

function buildInfiniteBackend(): InkModule {
  const infinite = infiniteInk as unknown as Record<string, unknown>;
  const backend = {
    ...infinite,
    // Stock ink `render` returns an Instance with `rerender`. @infinite-os/ink's
    // default `render` returns a Root (`.render`), while `renderSync` returns
    // the Instance shape the reporter relies on — so map to renderSync.
    render: (node: unknown, options?: Record<string, unknown>) =>
      (infinite.renderSync as (n: unknown, o: unknown) => unknown)(node, stripStockOnlyOptions(options)),
    renderToString: (node: unknown, options?: { columns?: number; width?: number }) =>
      (infinite.renderToString as (n: unknown, width: number) => string)(node, options?.columns ?? options?.width ?? 88),
    // Stock `useCursor` returns { setCursorPosition }. The vendored renderer
    // parks the cursor declaratively via useDeclaredCursor instead, so this
    // shim keeps the composer compiling and non-crashing; native parking on
    // the vendored backend is a follow-up port of the composer component.
    useCursor: () => ({ setCursorPosition: (_position?: unknown) => {} }),
    // No <Static> in the vendored renderer: draw the items in flow (see header).
    Static: <T,>({ items, children, style }: inkStock.StaticProps<T>) =>
      React.createElement(
        infinite.Box as React.ElementType,
        { flexDirection: "column", ...(style as Record<string, unknown> | undefined) },
        items.map((item, index) => children(item, index))
      )
  };
  return backend as unknown as InkModule;
}

const activeRenderer = resolveInkRenderer();
const backend: InkModule = activeRenderer === "infinite" ? buildInfiniteBackend() : inkStock;

/**
 * Stock Ink draws to a terminal through the resize-reflow guard, so a window
 * that narrows never leaves torn rows of the old frame (eval M2; see
 * `reflow-guard.ts`). The vendored renderer diffs cells and redraws itself.
 */
const stockRender: typeof inkStock.render = (node, options) => {
  const stream = typeof (options as NodeJS.WriteStream | undefined)?.write === "function";
  const given: inkStock.RenderOptions = stream ? { stdout: options as NodeJS.WriteStream } : { ...(options as inkStock.RenderOptions | undefined) };
  return inkStock.render(node, { ...given, stdout: guardResizeReflow(given.stdout ?? process.stdout) });
};

export const activeInkRenderer: CliInkRenderer = activeRenderer;

// Explicit `typeof inkStock.*` annotations keep the emitted declarations
// referencing `ink` directly rather than expanding to its transitive deps
// (ansi-styles / cli-boxes / type-fest), which would not be portable.
export const Box: typeof inkStock.Box = backend.Box;
export const Text: typeof inkStock.Text = backend.Text;
export const render: typeof inkStock.render = activeRenderer === "infinite" ? backend.render : stockRender;
export const renderToString: typeof inkStock.renderToString = backend.renderToString;
export const useApp: typeof inkStock.useApp = backend.useApp;
export const useInput: typeof inkStock.useInput = backend.useInput;
export const useStdin: typeof inkStock.useStdin = backend.useStdin;
export const useStdout: typeof inkStock.useStdout = backend.useStdout;
export const useCursor: typeof inkStock.useCursor = backend.useCursor;
export const Static: typeof inkStock.Static = backend.Static;
export type Instance = inkStock.Instance;
