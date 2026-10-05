import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runInkInteractiveSession } from "./interactive-session.js";

// Live fake-TTY Ink sessions: skipped on CI like the other interactive-session PTY tests
// (frames do not render on the hosted runners). The picker logic itself is covered on CI by
// terminal-model-picker.test.ts, desktop/model-selection.test.ts and the config tests.
async function type(input: NodeJS.WritableStream, text: string) {
  for (const char of text) {
    input.write(char);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await pause();
  }
  expect(check()).toBe(true);
}
function streams() {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
  Object.assign(input, {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn()
  });
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns: 100, rows: 35 });
  let text = "";
  output.on("data", (chunk) => (text += String(chunk)));
  return { input, output, text: () => text };
}
it.skipIf(process.env.CI === "true")("keeps /model inside Ink, confirms once, and returns to the composer", async () => {
  const io = streams();
  const save = vi.fn(
    async () =>
      "Model set: Sol 6.1, effort medium. Applies from your next message."
  );
  const dispatch = vi.fn(async () => ({ exit: true }));
  const session = runInkInteractiveSession({
    ...io,
    errorOutput: io.output,
    title: "Infinite",
    modelPicker: {
      load: async () => ({
        current: { provider: "codex", model: "gpt-5.5" },
        ready: { codex: true, claude: false }
      }),
      save
    },
    onSubmitLine: dispatch
  });
  try {
    await waitFor(() => io.text().includes("Ask Infinite"));
    await type(io.input, "/model\r");
    await waitFor(() => io.text().includes("Choose a model"));
    expect(dispatch).not.toHaveBeenCalled();
    expect(io.text()).not.toContain("gpt-6.1-sol");
    io.input.write("\u001b[A");
    await pause();
    io.input.write("\r");
    await waitFor(() => io.text().includes("How hard should it think?"));
    expect(io.text()).toContain("Medium   default");
    io.input.write("\r");
    await waitFor(() => io.text().includes("Save and use"));
    expect(save).not.toHaveBeenCalled();
    io.input.write("\r");
    await pause();
    io.input.write("\r");
    await waitFor(() => save.mock.calls.length >= 1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "medium"
    });
    await waitFor(() => io.text().includes("Model set: Sol 6.1"));
    await type(io.input, "/exit\r");
    await session;
  } finally {
    io.input.write("\u0003");
    await pause();
    io.input.write("\u0003");
    await session;
  }
}, 15000);
it.skipIf(process.env.CI === "true")("Escape and Ctrl-C cancel picker without saving or exiting the session", async () => {
  const io = streams();
  const save = vi.fn(async () => "saved");
  const dispatch = vi.fn(async () => ({ exit: true }));
  const session = runInkInteractiveSession({
    ...io,
    errorOutput: io.output,
    title: "Infinite",
    modelPicker: {
      load: async () => ({ ready: { codex: true, claude: false } }),
      save
    },
    onSubmitLine: dispatch
  });
  try {
    await waitFor(() => io.text().includes("Ask Infinite"));
    await type(io.input, "/model\r");
    await waitFor(() => io.text().includes("Choose a model"));
    io.input.write("\u0003");
    await waitFor(() => io.text().includes("Model unchanged."));
    expect(save).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await type(io.input, "/exit\r");
    await session;
  } finally {
    io.input.write("\u0003");
    await pause();
    io.input.write("\u0003");
    await session;
  }
}, 15000);
it.skipIf(process.env.CI === "true")("backs out of effort and confirm without writing", async () => {
  const io = streams();
  const save = vi.fn(async () => "saved");
  const session = runInkInteractiveSession({
    ...io,
    errorOutput: io.output,
    title: "Infinite",
    modelPicker: {
      load: async () => ({
        current: { provider: "codex", model: "gpt-5.5" },
        ready: { codex: true, claude: true }
      }),
      save
    },
    onSubmitLine: async () => ({})
  });
  try {
    await waitFor(() => io.text().includes("Ask Infinite"));
    await type(io.input, "/model\r");
    await waitFor(() => io.text().includes("Choose a model"));
    io.input.write("\r");
    await waitFor(() => io.text().includes("How hard should it think?"));
    io.input.write("\r");
    await waitFor(() => io.text().includes("Save and use"));
    io.input.write("\u001b");
    await pause();
    io.input.write("\u001b");
    await pause();
    io.input.write("\u001b");
    await waitFor(() => io.text().includes("Model unchanged."));
    expect(save).not.toHaveBeenCalled();
    await type(io.input, "/exit\r");
    await session;
  } finally {
    io.input.write("\u0003");
    await pause();
    io.input.write("\u0003");
    await session;
  }
}, 15000);
it.skipIf(process.env.CI === "true")("cancelled in-session sign-in cannot advance or save after a late auth result", async () => {
  const io = streams();
  const save = vi.fn(async () => "saved");
  let finish: (ok: boolean) => void = () => {};
  let signal: AbortSignal | undefined;
  const connectCodex = vi.fn(
    (_status: (text: string) => void, s: AbortSignal) => {
      signal = s;
      return new Promise<boolean>((resolve) => (finish = resolve));
    }
  );
  const session = runInkInteractiveSession({
    ...io,
    errorOutput: io.output,
    title: "Infinite",
    modelPicker: {
      load: async () => ({ ready: { codex: false, claude: false } }),
      save,
      connectCodex
    },
    onSubmitLine: async () => ({})
  });
  try {
    await waitFor(() => io.text().includes("Ask Infinite"));
    await type(io.input, "/model\r");
    await waitFor(() => io.text().includes("Choose a model"));
    io.input.write("\r");
    await waitFor(() => connectCodex.mock.calls.length === 1);
    io.input.write("\u001b");
    await waitFor(() => io.text().includes("Model unchanged."));
    expect(signal?.aborted).toBe(true);
    finish(true);
    await pause();
    expect(save).not.toHaveBeenCalled();
    expect(io.text()).not.toContain("How hard should it think?");
    await type(io.input, "/exit\r");
    await session;
  } finally {
    finish(false);
    io.input.write("\u0003");
    await pause();
    io.input.write("\u0003");
    await session;
  }
}, 15000);
it.skipIf(process.env.CI === "true")("Claude rows are coming soon and selecting one never saves or sends a turn", async () => {
  const io = streams();
  const save = vi.fn(async () => "saved");
  const dispatch = vi.fn(async () => ({}));
  const session = runInkInteractiveSession({
    ...io,
    errorOutput: io.output,
    title: "Infinite",
    modelPicker: {
      load: async () => ({
        current: { provider: "claude", model: "claude-opus-5-5" },
        ready: { codex: true, claude: true }
      }),
      save
    },
    onSubmitLine: dispatch
  });
  try {
    await waitFor(() => io.text().includes("Ask Infinite"));
    await type(io.input, "/model\r");
    await waitFor(() => io.text().includes("coming soon"));
    io.input.write("\r");
    await waitFor(() =>
      io
        .text()
        .includes("Claude in the terminal is coming soon. Nothing changed.")
    );
    expect(save).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(io.text()).not.toContain("How hard should it think?");
    await type(io.input, "/exit\r");
    await session;
  } finally {
    io.input.write("\u0003");
    await pause();
    io.input.write("\u0003");
    await session;
  }
}, 15000);
it.skipIf(process.env.CI === "true")('uses the Desktop catalog, enables Claude, and confirms clearing to Desktop default',async()=>{
 const io=streams();const save=vi.fn(async()=> 'Model set.');const clear=vi.fn(async()=> 'Using Desktop default.');
 const session=runInkInteractiveSession({...io,errorOutput:io.output,title:'Infinite',modelPicker:{load:async()=>({options:[{provider:'codex',id:'',label:'Use Desktop default',efforts:[]},{provider:'claude',id:'claude-opus-4-8',label:'Opus 4.8',efforts:['low','medium','high']}],allowClaude:true,connectInApp:true,ready:{codex:true,claude:true},current:{provider:'codex',model:''}}),save,clear},onSubmitLine:async()=>({})});
 try{
  await waitFor(()=>io.text().includes('Ask Infinite'));await type(io.input,'/model\r');await waitFor(()=>io.text().includes('Use Desktop default'));
  expect(io.text()).not.toContain('coming soon');expect(io.text()).not.toContain('GPT-5.4');
  io.input.write('\u001b[B');await pause();io.input.write('\r');await waitFor(()=>io.text().includes('How hard should it think?'));
  io.input.write('\r');await waitFor(()=>io.text().includes('Save and use'));io.input.write('\r');await waitFor(()=>save.mock.calls.length===1);
  expect(save).toHaveBeenCalledWith({provider:'claude',model:'claude-opus-4-8',effort:'medium'});
  await type(io.input,'/model\r');await pause();io.input.write('\r');await waitFor(()=>io.text().includes('Use Desktop default?'));io.input.write('\r');await waitFor(()=>clear.mock.calls.length===1);
  await type(io.input,'/exit\r');await session;
 }finally{io.input.write('\u0003');await pause();io.input.write('\u0003');await session;}
},15000);

it.skipIf(process.env.CI === "true")("preselects a saved level instead of Medium", async () => {
  const io = streams();
  const save = vi.fn(async () => "Model set.");
  const session = runInkInteractiveSession({ ...io, errorOutput: io.output, title: "Infinite",
    modelPicker: { load: async () => ({ ready: { codex: true, claude: false }, current: { provider: "codex", model: "gpt-5.5", effort: "high" } }), save },
    onSubmitLine: async () => ({}) });
  try {
    await waitFor(() => io.text().includes("Ask Infinite"));
    await type(io.input, "/model\r");
    await waitFor(() => io.text().includes("Choose a model"));
    io.input.write("\r");
    await waitFor(() => io.text().includes("How hard should it think?"));
    io.input.write("\r");
    await waitFor(() => io.text().includes("Save and use"));
    io.input.write("\r");
    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledWith({ provider: "codex", model: "gpt-5.5", effort: "high" });
    await type(io.input, "/exit\r"); await session;
  } finally { io.input.write("\u0003"); await pause(); io.input.write("\u0003"); await session; }
}, 15000);
