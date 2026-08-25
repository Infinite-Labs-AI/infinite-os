import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  daemonDescriptorPath,
  infiniteOsHome,
  removeDaemonDescriptor,
  readDaemonDescriptor,
  type DaemonDescriptor
} from "@infinite-os/config";

// The descriptor type + readers/removers/path moved to @infinite-os/config so BOTH
// the CLI and the desktop can discover the daemon WITHOUT taking a dependency edge
// on @infinite-os/app — the missing edge is exactly why the CLI couldn't read the
// descriptor before (design §1, §7). This module re-exports them so existing
// imports (apps/app/src/index.ts, the app tests) keep compiling, and KEEPS the
// writer side (buildDaemonDescriptor + writeDaemonDescriptor + appVersion) here:
// appVersion() reads apps/app/package.json via import.meta.url, so moving it would
// break its path resolution (§7 caveat).
export {
  daemonDescriptorPath,
  readDaemonDescriptor,
  removeDaemonDescriptor,
  type DaemonDescriptor
};

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
  // Post-listen the OS has assigned a real port; a 0/missing port means address()
  // was read before listen resolved (or on a closed server) — a programmer error,
  // not a runtime fallback to paper over. Advertising :0 would be unconnectable.
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`daemon descriptor got a non-listening port (${String(port)}); read address() AFTER listen resolves`);
  }
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
//
// STAYS in apps/app (not moved to @infinite-os/config): import.meta.url here points
// at apps/app, so the relative package.json resolution only works from this package.
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
  // Identity + convergence fields (PR1 — daemon-discovery §3/§4). Optional so the
  // existing call sites/tests that omit them keep building a valid descriptor.
  nonce?: string;
  databaseId?: string;
  keyId?: string;
}): DaemonDescriptor {
  if (input.address === null || typeof input.address === "string") {
    // A string address is a UNIX domain socket / pipe — the daemon path always
    // binds TCP, so this is a programmer error, not a runtime fallback to mask.
    throw new Error("daemon descriptor requires a bound TCP address (AddressInfo), got " + String(input.address));
  }
  const descriptor: DaemonDescriptor = {
    url: daemonUrlFromAddress(input.address),
    pid: input.pid ?? process.pid,
    version: input.version ?? appVersion(),
    startedAt: input.startedAt ?? new Date().toISOString()
  };
  // Only stamp the identity/convergence fields when supplied — an in-process test
  // caller that omits them produces the legacy 4-field shape.
  if (input.nonce !== undefined) descriptor.nonce = input.nonce;
  if (input.databaseId !== undefined) descriptor.databaseId = input.databaseId;
  if (input.keyId !== undefined) descriptor.keyId = input.keyId;
  return descriptor;
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
  // Atomic publish: write a complete pid-unique temp file in the SAME dir (same
  // filesystem, so rename is atomic + can't cross a device boundary), then rename
  // it over the final path. A concurrent desktop reader sees either the old file
  // or the whole new one — never a half-written/truncated JSON. pid in the temp
  // name keeps two daemons from clobbering each other's in-progress write.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { path };
}
