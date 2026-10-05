import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readTerminalModelSelection,
  readTerminalModelFile,
  clearTerminalModelSelection,
  resolveTerminalModelSelection,
  writeTerminalModelSelection,
  writeInfiniteOsModelSelection
} from "../src/index.js";
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "terminal-model-"));
  dirs.push(dir);
  return { GROWTH_OS_HOME: dir };
}
afterEach(() =>
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);
it("stores terminal choice privately without changing shared config", () => {
  const env = fixture();
  writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" }, env);
  const shared = readFileSync(join(env.GROWTH_OS_HOME, "config.yml"), "utf8");
  writeTerminalModelSelection(
    { provider: "claude", model: "claude-opus-5-5", effort: "max" },
    env
  );
  expect(readTerminalModelSelection(env)).toEqual({
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "max"
  });
  expect(readFileSync(join(env.GROWTH_OS_HOME, "config.yml"), "utf8")).toBe(
    shared
  );
  expect(
    statSync(join(env.GROWTH_OS_HOME, "terminal-model.yml")).mode & 0o777
  ).toBe(0o600);
});
it("resolves env pair, terminal file, then shared default and removes Default effort", () => {
  const env = fixture();
  writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" }, env);
  expect(resolveTerminalModelSelection(env).source).toBe("shared");
  writeTerminalModelSelection(
    { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    env
  );
  expect(resolveTerminalModelSelection(env)).toMatchObject({
    source: "terminal",
    selection: { model: "gpt-6.1-sol", effort: "xhigh" }
  });
  expect(
    resolveTerminalModelSelection({
      ...env,
      GROWTH_OS_MODEL_PROVIDER: "codex",
      GROWTH_OS_MODEL_NAME: "gpt-5.4"
    })
  ).toEqual({
    source: "env",
    selection: { provider: "codex", model: "gpt-5.4" }
  });
  expect(
    resolveTerminalModelSelection({
      ...env,
      GROWTH_OS_MODEL_PROVIDER: "claude"
    }).source
  ).toBe("terminal");
  writeTerminalModelSelection({ provider: "codex", model: "gpt-6.1-sol" }, env);
  expect(readTerminalModelSelection(env)).not.toHaveProperty("effort");
});
it("drops unsupported saved effort with a warning and rejects invalid writes", () => {
  const env = fixture();
  writeFileSync(
    join(env.GROWTH_OS_HOME, "terminal-model.yml"),
    "provider: codex\nmodel: gpt-5.5\neffort: max\n"
  );
  expect(resolveTerminalModelSelection(env)).toMatchObject({
    warning: expect.stringContaining("effort"),
    selection: { provider: "codex", model: "gpt-5.5" }
  });
  expect(resolveTerminalModelSelection(env).selection).not.toHaveProperty(
    "effort"
  );
  expect(() =>
    writeTerminalModelSelection(
      { provider: "codex", model: "gpt-5.5", effort: "max" },
      env
    )
  ).toThrow();
});

it("resolves a terminal choice without reading an unavailable shared default", () => {
  const env = fixture();
  writeTerminalModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
  mkdirSync(join(env.GROWTH_OS_HOME, "config.yml"));
  expect(resolveTerminalModelSelection(env)).toEqual({
    source: "terminal",
    selection: { provider: "codex", model: "gpt-5.4" }
  });
});
it('stores a Desktop-advertised choice without extending the local catalog, and can clear it',()=>{
 const env=fixture();writeInfiniteOsModelSelection({provider:'codex',model:'gpt-5.5'},env);
 writeTerminalModelSelection({provider:'codex',model:'gpt-5.6-luna',effort:'low'},env,[{provider:'codex',id:'gpt-5.6-luna',label:'Luna',efforts:['low']}]);
 expect(readTerminalModelFile(env)).toEqual({provider:'codex',model:'gpt-5.6-luna',effort:'low'});
 clearTerminalModelSelection(env);expect(readTerminalModelFile(env)).toBeUndefined();
 expect(readFileSync(join(env.GROWTH_OS_HOME,'config.yml'),'utf8')).toContain('gpt-5.5');
});
