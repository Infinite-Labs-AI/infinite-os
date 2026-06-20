// Produce a SELF-CONTAINED daemon bundle the desktop installer ships, so the app can spawn the
// daemon with no engine checkout / tsx / pnpm install on the machine.
//
//   dist/bundle/daemon.mjs                         ← the whole daemon (entrypoint + @infinite-os/* +
//                                                     fastify), one file
//   dist/bundle/node_modules/@electric-sql/pglite  ← PGlite (JS + WASM) kept EXTERNAL + side-car'd,
//                                                     so its runtime WASM loading still resolves
//
// The desktop spawns `node dist/bundle/daemon.mjs` (via Electron's bundled Node) — see the desktop's
// daemon-runtime. Prereq: the workspace must be built (@infinite-os/* resolve to dist/) — run after
// `pnpm -r build`.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, ".."); // apps/app
const outDir = join(appRoot, "dist", "bundle");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(appRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(outDir, "daemon.mjs"),
  // PGlite is a ~25MB WASM package; keep it EXTERNAL and ship it as a sidecar node_modules so its
  // runtime WASM loading (relative to its own dist) keeps working. Everything else is inlined.
  external: ["@electric-sql/pglite"],
  // An ESM bundle of a Node app can still emit require() for CJS-interop deps — provide the shim.
  banner: {
    js: "import { createRequire as ___cr } from 'node:module'; const require = ___cr(import.meta.url);",
  },
  logLevel: "info",
});

// Side-car the PGlite package (JS + WASM) next to the bundle so the external import resolves at run
// time. PGlite is a TRANSITIVE dep (of @infinite-os/db), not directly resolvable from apps/app, so
// locate the real package in the pnpm store.
const pnpmDir = join(appRoot, "..", "..", "node_modules", ".pnpm");
const pgliteEntry = readdirSync(pnpmDir).find((d) => d.startsWith("@electric-sql+pglite@"));
if (!pgliteEntry) throw new Error("could not locate @electric-sql/pglite in the pnpm store");
const pgliteRoot = join(pnpmDir, pgliteEntry, "node_modules", "@electric-sql", "pglite");
const pgliteDst = join(outDir, "node_modules", "@electric-sql", "pglite");
mkdirSync(dirname(pgliteDst), { recursive: true });
cpSync(pgliteRoot, pgliteDst, { recursive: true, dereference: true });

// Ship the migration .sql files NEXT TO the bundle — loadMigrations reads them at runtime via
// readdirSync (they're not import-able, so esbuild can't inline them). migrationsDir() finds them
// through its `join(moduleDir, "migrations")` candidate (moduleDir = the bundle dir at runtime).
const migrationsSrc = join(appRoot, "..", "..", "packages", "db", "migrations");
cpSync(migrationsSrc, join(outDir, "migrations"), { recursive: true });

console.log(`\n✅ daemon bundle → ${outDir}`);
