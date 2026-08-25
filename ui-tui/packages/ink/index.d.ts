// Flat consumer-facing type facade for @infinite-os/ink.
//
// The real implementation is the bundled renderer (dist/ink-bundle.js, built
// from src/entry-exports.ts). These loose declarations exist so workspace
// consumers (e.g. @infinite-os/cli) can import @infinite-os/ink and swap it in behind
// a flag WITHOUT tsc traversing the renderer's internal TS/TSX source under a
// foreign tsconfig. Precise prop typing is handled by the consuming adapter,
// which casts this backend to the stock `ink` module surface.
import type { FC, ReactElement, ReactNode } from "react";

export const Box: FC<Record<string, unknown>>;
export const Text: FC<Record<string, unknown>>;
export const Newline: FC<Record<string, unknown>>;
export const Spacer: FC<Record<string, unknown>>;
export const Link: FC<Record<string, unknown>>;
export const ScrollBox: FC<Record<string, unknown>>;
export const AlternateScreen: FC<Record<string, unknown>>;
export const RawAnsi: FC<Record<string, unknown>>;
export const NoSelect: FC<Record<string, unknown>>;
export const Ansi: FC<Record<string, unknown>>;
export const TextInput: FC<Record<string, unknown>>;
export const UncontrolledTextInput: FC<Record<string, unknown>>;

export function render(node: ReactNode, options?: unknown): unknown;
export function renderSync(node: ReactNode, options?: unknown): unknown;
export function createRoot(options?: unknown): unknown;
export function renderToString(node: ReactElement, width: number): string;

export const useApp: () => { exit: (error?: Error) => void };
export const useInput: (handler: (input: string, key: Record<string, boolean>) => void, options?: { isActive?: boolean }) => void;
export const useStdin: () => unknown;
export const useStdout: () => { stdout?: NodeJS.WriteStream; write: (data: string) => void };
export const useStderr: () => unknown;
export const useDeclaredCursor: (args: { line: number; column: number; active: boolean }) => (element: unknown) => void;
export const useTerminalFocus: () => boolean;
export const useTerminalViewport: () => unknown;

export const stringWidth: (value: string) => number;
export function measureElement(node: unknown): { width: number; height: number };

export type Instance = {
  rerender: (node: ReactNode) => void;
  unmount: (error?: Error | number | null) => void;
  waitUntilExit: () => Promise<void>;
  cleanup?: () => void;
  clear?: () => void;
};
export type RenderOptions = Record<string, unknown>;
export type Root = unknown;
