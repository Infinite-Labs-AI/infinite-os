// Produce a SELF-CONTAINED CLI bundle the desktop app ships, so the installed `infinite` command can
// run with no engine checkout / tsx / pnpm install on the machine. This MIRRORS the engine daemon
// bundle (apps/app/scripts/bundle.mjs).
//
//   dist/bundle/infinite.mjs                        ← the whole CLI (entrypoint + @infinite-os/* +
//                                                     ink/react), one file
//   dist/bundle/node_modules/@electric-sql/pglite   ← PGlite (JS + WASM) kept EXTERNAL + side-car'd
//                                                     ONLY IF the CLI graph references it, so its
//                                                     runtime WASM loading still resolves
//
// The desktop stages dist/bundle into resources/cli/ and runs it via the app's own Node:
//   ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/<ProductName> <resourcesPath>/cli/infinite.mjs "$@"
// See the RUNTIME CONTRACT in the CLI auto-install feature. Prereq: the workspace must be built
// (@infinite-os/* resolve to dist/) — run after `pnpm -r build`.
import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBundleProvenance } from "../../app/scripts/bundle-provenance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, ".."); // apps/cli
const repoRoot = join(cliRoot, "..", "..");
const outDir = join(cliRoot, "dist", "bundle");
const cliPath = join(outDir, "infinite.mjs");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(cliRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: cliPath,
  metafile: true,
  // `react-devtools-core` is imported ONLY by upstream ink's devtools.js, itself reached only via a
  // `process.env.DEV === 'true'`-guarded dynamic import. It is not a runtime dep of the shipped CLI,
  // so alias it to a no-op stub — keeping the bundle single-file with nothing to resolve at run time.
  alias: {
    "react-devtools-core": join(here, "react-devtools-core-stub.mjs")
  },
  // PGlite is a ~25MB WASM package; keep it EXTERNAL and (if reachable) ship it as a sidecar
  // node_modules so its runtime WASM loading (relative to its own dist) keeps working. Everything
  // else — including the @infinite-os/ink fork (native-TS yoga, no WASM) and react — is inlined.
  external: ["@electric-sql/pglite"],
  // An ESM bundle of a Node app can still emit require() for CJS-interop deps — provide the shim.
  banner: {
    js: "import { createRequire as ___cr } from 'node:module'; const require = ___cr(import.meta.url);"
  },
  logLevel: "info"
});

// Only side-car PGlite if the CLI graph actually imports it — the CLI is a daemon *client* and may
// never touch the local engine DB. When it does (credential/db paths), the external import must
// resolve at run time. PGlite is a TRANSITIVE dep (of @infinite-os/db), not directly resolvable from
// apps/cli, so locate the real package in the pnpm store.
const referencesPglite =
  Object.keys(result.metafile.inputs).some((f) =>
    /@electric-sql[/+]pglite/.test(f)
  ) ||
  Object.values(result.metafile.outputs).some((o) =>
    (o.imports ?? []).some((imp) => imp.path === "@electric-sql/pglite")
  );

// Ship the migration .sql files NEXT TO the bundle — loadMigrations() reads them at runtime via
// readdirSync (they're not import-able, so esbuild can't inline them). migrationsDir() resolves them
// through its `join(moduleDir, "migrations")` candidate (moduleDir = the bundle dir at runtime). The
// CLI graph DOES reach this: `infinite setup runtime --mode external_postgres|supabase` →
// runRuntimeMigrations → runMigrations → loadMigrations(). Mirror the daemon bundle so that advertised
// subcommand doesn't hard-crash with ENOENT on a machine with no engine checkout.
const migrationsSrc = join(repoRoot, "packages", "db", "migrations");
cpSync(migrationsSrc, join(outDir, "migrations"), { recursive: true });
console.log(
  "   + migrations sidecar (runtime migrations read .sql at run time)"
);

if (referencesPglite) {
  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  const pgliteEntry = readdirSync(pnpmDir).find((d) =>
    d.startsWith("@electric-sql+pglite@")
  );
  if (!pgliteEntry)
    throw new Error("could not locate @electric-sql/pglite in the pnpm store");
  const pgliteRoot = join(
    pnpmDir,
    pgliteEntry,
    "node_modules",
    "@electric-sql",
    "pglite"
  );
  const pgliteDst = join(outDir, "node_modules", "@electric-sql", "pglite");
  mkdirSync(dirname(pgliteDst), { recursive: true });
  cpSync(pgliteRoot, pgliteDst, { recursive: true, dereference: true });
  console.log("   + sidecar @electric-sql/pglite (CLI graph references it)");
} else {
  console.log(
    "   (no PGlite in CLI graph — external marker is inert, no sidecar needed)"
  );
}

// Bind the provenance claim to the exact CLI bytes, same shape and same helper as the daemon
// bundle above. The desktop's stage-cli-bundle.mjs freshness guard READS this stamp (an unstamped
// bundle is treated as stale and hard-fails a local pack), and audit-distributable binds the
// packaged copy to EXPECTED_ENGINE_COMMIT — so the stamp is a required build artifact, not decor.
const engineVersion = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8")
).version;
const provenance = {
  ...createBundleProvenance({ daemonPath: cliPath, appRoot: cliRoot }),
  engineVersion
};
writeFileSync(
  join(outDir, "BUILD_INFO.json"),
  `${JSON.stringify(provenance, null, 2)}\n`
);

console.log(`\n✅ CLI bundle → ${outDir}`);
console.log(
  `   engine ${provenance.engineCommit.slice(0, 9)} → BUILD_INFO.json`
);
console.log(`   entry infinite.mjs (run: node infinite.mjs --help)`);
