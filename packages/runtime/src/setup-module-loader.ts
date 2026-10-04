import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SetupModuleApi {
  readSetupInterviewFromRun: (
    db: unknown,
    workspaceId: string,
    runId: string
  ) => Promise<unknown>;
  runLiveSetupOnboarding: (input: {
    db: unknown;
    workspaceId: string;
    interview: unknown;
    actions: { execute(id: string, payload: unknown, ctx: unknown): Promise<unknown> };
    prompt: { ask(question: string, choices?: string[]): Promise<string>; note(message: string): void };
  }) => Promise<unknown>;
  resumeLiveSetupOnboarding: (input: {
    db: unknown;
    workspaceId: string;
    runId: string;
    actions: { execute(id: string, payload: unknown, ctx: unknown): Promise<unknown> };
    prompt: { ask(question: string, choices?: string[]): Promise<string>; note(message: string): void };
  }) => Promise<unknown>;
}

const require = createRequire(import.meta.url);

function ensureBuiltWorkspacePackage(packageRoot: string, distEntryRelative: string): string {
  const distEntry = join(packageRoot, distEntryRelative);
  if (existsSync(distEntry)) {
    return distEntry;
  }

  const tsconfigPath = join(packageRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    throw new Error(`Unable to load the setup module because ${tsconfigPath} does not exist.`);
  }

  const tscBin = require.resolve("typescript/bin/tsc");
  const result = spawnSync(execPath, [tscBin, "-b", tsconfigPath], {
    encoding: "utf8"
  });

  if (result.status !== 0 || !existsSync(distEntry)) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      output
        ? `Unable to build @infinite-os/setup from source:\n${output}`
        : "Unable to build @infinite-os/setup from source."
    );
  }

  return distEntry;
}

function ensureBuiltSetupModule(packageRoot: string): string {
  return ensureBuiltWorkspacePackage(packageRoot, "dist/src/index.js");
}

interface WorkspacePackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  exports?: string | Record<string, string | { import?: string }>;
  main?: string;
}

function ensureWorkspacePackageRuntime(repoRoot: string, packageName: string, seen = new Set<string>()): void {
  if (seen.has(packageName)) {
    return;
  }
  seen.add(packageName);

  const packageDirName = packageName.replace(/^@infinite-os\//u, "");
  const packageRoot = join(repoRoot, "packages", packageDirName);
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return;
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as WorkspacePackageManifest;
  for (const [dependencyName, version] of Object.entries(manifest.dependencies ?? {})) {
    if (dependencyName.startsWith("@infinite-os/") && version.startsWith("workspace:")) {
      ensureWorkspacePackageRuntime(repoRoot, dependencyName, seen);
    }
  }

  const distEntryRelative = resolveWorkspacePackageExport(manifest);
  if (distEntryRelative) {
    ensureBuiltWorkspacePackage(packageRoot, distEntryRelative);
  }

  if (manifest.name) {
    ensureWorkspacePackageSymlink(repoRoot, manifest.name, packageRoot);
  }
}

function resolveWorkspacePackageExport(manifest: WorkspacePackageManifest): string | null {
  if (typeof manifest.exports === "string") {
    return manifest.exports;
  }
  const rootExport = manifest.exports?.["."];
  if (typeof rootExport === "string") {
    return rootExport;
  }
  if (rootExport && typeof rootExport === "object" && typeof rootExport.import === "string") {
    return rootExport.import;
  }
  return typeof manifest.main === "string" ? manifest.main : null;
}

function ensureWorkspacePackageSymlink(repoRoot: string, packageName: string, packageRoot: string): void {
  const [, scope = "", localName = ""] = packageName.match(/^(@[^/]+)\/(.+)$/u) ?? [];
  if (!scope || !localName) {
    return;
  }

  const scopeDir = join(repoRoot, "node_modules", scope);
  const linkPath = join(scopeDir, localName);
  if (existsSync(linkPath)) {
    return;
  }

  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(packageRoot, linkPath, "dir");
}

export async function loadSetupModule(importMetaUrl: string): Promise<SetupModuleApi> {
  const currentFile = fileURLToPath(importMetaUrl);
  let current = dirname(currentFile);
  const prefersBuiltArtifacts = currentFile.endsWith(".js");
  let lastError: unknown;

  for (;;) {
    const distCandidate = join(current, "packages/setup/dist/src/index.js");
    const sourceCandidate = join(current, "packages/setup/src/index.ts");
    const candidates = prefersBuiltArtifacts
      ? [
          { path: distCandidate, kind: "dist" as const },
          { path: sourceCandidate, kind: "source" as const }
        ]
      : [
          { path: sourceCandidate, kind: "source" as const },
          { path: distCandidate, kind: "dist" as const }
        ];

    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) {
        continue;
      }

      try {
        ensureWorkspacePackageRuntime(current, "@infinite-os/setup");
        const modulePath =
          candidate.kind === "source"
            ? ensureBuiltSetupModule(join(current, "packages/setup"))
            : candidate.path;
        return (await import(pathToFileURL(modulePath).href)) as SetupModuleApi;
      } catch (error) {
        lastError = error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to load the setup module.");
}
