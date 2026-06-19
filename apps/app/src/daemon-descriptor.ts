import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { infiniteOsHome } from "@infinite-os/config";

// The descriptor a freshly-spawned daemon drops so the desktop (or any other
// local client) can discover the live address without guessing the port. When
// the app binds port 0 the OS picks an ephemeral port, so the descriptor is the
// ONLY source of truth for where the daemon actually listens.
//
// SECURITY: tokens NEVER go in here. Discovery only. The operator/read tokens
// stay in the desktop main process and the daemon's own config; the descriptor
// just answers "is a daemon up, and on what URL/pid/version?".
export interface DaemonDescriptor {
  url: string;
  pid: number;
  version: string;
  startedAt: string;
}

const DAEMON_DESCRIPTOR_FILE = "daemon.json";

export function daemonDescriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(infiniteOsHome(env), DAEMON_DESCRIPTOR_FILE);
}

// A Node net AddressInfo, narrowed to the fields we consume. `app.server.address()`
// returns `AddressInfo | string | null`; only the TCP object form carries a port.
export interface BoundAddress {
  address: string;
  port: number;
  family?: string;
}

// Turn the bound socket address into a URL a local client can actually connect
// to. A wildcard bind (0.0.0.0 / :: / empty) is not connectable as a host, so we
// rewrite it to loopback. IPv6 literals get bracketed. The real (possibly
// ephemeral) port from the bound socket is always used, never the requested one.
export function daemonUrlFromAddress(addr: BoundAddress): string {
  const port = addr.port;
  const raw = (addr.address ?? "").trim();
  const isIpv6Family = addr.family === "IPv6" || addr.family === "6" || raw.includes(":");

  let host: string;
  if (raw === "" || raw === "0.0.0.0" || raw === "::" || raw === "::0") {
    host = isIpv6Family && raw !== "0.0.0.0" ? "[::1]" : "127.0.0.1";
  } else if (isIpv6Family && !raw.startsWith("[")) {
    host = `[${raw}]`;
  } else {
    host = raw;
  }

  return `http://${host}:${port}`;
}

// The product version, read from apps/app/package.json (single source of truth).
// Resolves from both the tsx source entry (apps/app/src/index.ts -> ../package.json)
// and the compiled entry (apps/app/dist/src/index.js -> ../../package.json), since
// this package compiles with rootDir "." (dist mirrors the src/ layout). Falls
// back to "0.0.0" so a missing manifest never blocks daemon startup.
export function appVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkgPath = fileURLToPath(new URL(rel, import.meta.url));
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@infinite-os/app" && typeof pkg.version === "string" && pkg.version) {
        return pkg.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}

export function buildDaemonDescriptor(input: {
  address: BoundAddress | string | null;
  pid?: number;
  version?: string;
  startedAt?: string;
}): DaemonDescriptor {
  if (input.address === null || typeof input.address === "string") {
    // A string address is a UNIX domain socket / pipe — the daemon path always
    // binds TCP, so this is a programmer error, not a runtime fallback to mask.
    throw new Error("daemon descriptor requires a bound TCP address (AddressInfo), got " + String(input.address));
  }
  return {
    url: daemonUrlFromAddress(input.address),
    pid: input.pid ?? process.pid,
    version: input.version ?? appVersion(),
    startedAt: input.startedAt ?? new Date().toISOString()
  };
}

// Write the descriptor at ~/.growth-os/daemon.json with 0600 perms. The home dir
// is created 0700 if absent (mirrors the auth/config writers in @infinite-os/config).
export function writeDaemonDescriptor(
  descriptor: DaemonDescriptor,
  env: NodeJS.ProcessEnv = process.env
): { path: string } {
  const home = infiniteOsHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = daemonDescriptorPath(env);
  writeFileSync(path, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path };
}

// Remove the descriptor on shutdown so a stale file never advertises a dead port.
// Best-effort: a missing file is fine, and we never throw out of the close hook.
export function removeDaemonDescriptor(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(daemonDescriptorPath(env), { force: true });
  } catch {
    // Cleanup is best-effort; the next daemon overwrites any leftover anyway.
  }
}

export function readDaemonDescriptor(env: NodeJS.ProcessEnv = process.env): DaemonDescriptor | null {
  try {
    const raw = readFileSync(daemonDescriptorPath(env), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonDescriptor>;
    if (
      typeof parsed.url === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.version === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return { url: parsed.url, pid: parsed.pid, version: parsed.version, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}
