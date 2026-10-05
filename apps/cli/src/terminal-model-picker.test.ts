import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readTerminalModelSelection,
  writeTerminalModelSelection,
  writeInfiniteOsModelSelection
} from "@infinite-os/config";
import {
  createTerminalModelPicker,
  terminalModelStatus
} from "./terminal-model-picker.js";
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);
function env() {
  const dir = mkdtempSync(join(tmpdir(), "picker-save-"));
  dirs.push(dir);
  return { HOME: dir, GROWTH_OS_HOME: dir };
}
it("saves only terminal choice after checking auth and reports env override", async () => {
  const e = {
    ...env(),
    GROWTH_OS_MODEL_PROVIDER: "codex",
    GROWTH_OS_MODEL_NAME: "gpt-5.4"
  };
  writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" }, e);
  const check = vi.fn(async () => true);
  const picker = createTerminalModelPicker(e, check);
  const before = readFileSync(join(e.GROWTH_OS_HOME, "config.yml"), "utf8");
  expect(
    await picker.save({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high"
    })
  ).toContain("environment");
  expect(check).toHaveBeenCalledOnce();
  expect(readTerminalModelSelection(e)?.model).toBe("gpt-6.1-sol");
  expect(readFileSync(join(e.GROWTH_OS_HOME, "config.yml"), "utf8")).toBe(
    before
  );
  expect(terminalModelStatus(e)).toContain("gpt-5.4");
  expect(terminalModelStatus(e)).toContain("gpt-5.5");
});
it("signed-out Claude or failed Codex auth cannot write a choice", async () => {
  const e = env();
  const picker = createTerminalModelPicker(e, async () => false);
  expect(await picker.save({ provider: "codex", model: "gpt-5.5" })).toContain(
    "unchanged"
  );
  expect(
    await picker.save({ provider: "claude", model: "claude-opus-5-5" })
  ).toContain("claude auth login");
  expect(readTerminalModelSelection(e)).toBeUndefined();
});

it("reports a terminal-picked Claude model consistently when the Desktop catalog differs",async()=>{
 const e=env();writeInfiniteOsModelSelection({provider:"codex",model:"gpt-5.5"},e);
 writeTerminalModelSelection({provider:"claude",model:"claude-sonnet-5"},e,[{provider:"claude",id:"claude-sonnet-5",label:"Sonnet 5",efforts:[]}]);
 expect(terminalModelStatus(e)).toContain("claude-sonnet-5");
 const picker=createTerminalModelPicker(e,async()=>false,undefined,async()=>({ready:true}));
 const snapshot=await picker.load();expect(snapshot.current?.model).toBe("claude-sonnet-5");expect(snapshot.warning??"").not.toContain("using the shared default");
});

it("persists an explicit Medium choice for local turns", async () => {
  const e = env();
  const picker = createTerminalModelPicker(e, async () => true, undefined, async () => ({ ready: true }));
  for (const selection of [
    { provider: "codex", model: "gpt-5.5", effort: "medium" },
    { provider: "claude", model: "claude-opus-5-5", effort: "medium" }
  ] as const) {
    await picker.save(selection);
    expect(readTerminalModelSelection(e)).toEqual(selection);
  }
});
