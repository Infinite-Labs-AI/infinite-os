import { afterEach } from "vitest";

// Give the worker's event loop one full turn after every test.
//
// Vitest workers report progress to the main process over RPC
// ("onTaskUpdate"), and the reply is only read when the worker's event loop
// reaches its I/O phase. The PGlite suites (real WASM Postgres on a sync
// file system, plus fake `fetch`es that resolve on microtasks) never get
// there: a whole file of them can run as one unbroken microtask chain. On a
// 4-vCPU CI runner, packages/connectors/src/meta-lean-inventory.test.ts ran
// ~75s that way, so the 60s RPC timer fired before the reply was read and
// the run failed with 'Timeout calling "onTaskUpdate"' although every test
// passed. Yielding here caps an unbroken stretch at one test, not one file.
//
// Captured at setup time so a test that fakes timers cannot stall this hook.
const realSetImmediate = globalThis.setImmediate;

afterEach(() => new Promise<void>((resolve) => realSetImmediate(() => resolve())));
