import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createApp } from "../src/index.js";
import {
  buildDaemonDescriptor,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
  type BoundAddress
} from "../src/daemon-descriptor.js";

// End-to-end proof of the C2 keystone: bind a real Fastify socket on an ephemeral
// port (port 0), capture the OS-assigned port via app.server.address(), write the
// descriptor exactly the way the production listen block does, confirm its shape on
// disk, then close the app and confirm the onClose hook removed it. No DB required.
describe("daemon descriptor over the real listen path", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "growth-os-daemon-listen-"));
    env = { ...process.env, GROWTH_OS_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes daemon.json with the bound port on listen and removes it on close", async () => {
    const app = createApp();
    // Mirror the production block: register the cleanup hook BEFORE listen (Fastify
    // v5 forbids addHook once listening), then bind port 0 so the OS assigns an
    // ephemeral port — precisely the case config.appPort=0 must support.
    app.addHook("onClose", async () => {
      removeDaemonDescriptor(env);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const bound = app.server.address() as AddressInfo;
      expect(bound).toBeTruthy();
      expect(typeof bound).toBe("object");
      expect(bound.port).toBeGreaterThan(0);

      const descriptor = buildDaemonDescriptor({ address: bound as BoundAddress | string | null });
      const { path } = writeDaemonDescriptor(descriptor, env);

      // Descriptor exists with the right shape, the live (ephemeral) port, and no token.
      expect(path).toBe(join(home, "daemon.json"));
      expect(existsSync(path)).toBe(true);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.url).toBe(`http://127.0.0.1:${bound.port}`);
      expect(onDisk.pid).toBe(process.pid);
      expect(typeof onDisk.version).toBe("string");
      expect(Number.isNaN(Date.parse(onDisk.startedAt))).toBe(false);
      expect(onDisk).not.toHaveProperty("token");

      // The server is genuinely listening on the advertised port.
      const res = await fetch(`${onDisk.url}/health`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: "ok" });
    } finally {
      await app.close();
    }

    // onClose removed the descriptor so nothing advertises the now-dead port.
    expect(existsSync(join(home, "daemon.json"))).toBe(false);
  });
});
