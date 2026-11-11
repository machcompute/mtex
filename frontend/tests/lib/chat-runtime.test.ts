import type { ChatModelRunResult } from "@assistant-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WireStreamEvent } from "@/lib/chat-wire";
import type { WireMessage } from "@/lib/chat-wire";

const wire = vi.hoisted(() => ({ rounds: [] as unknown[], calls: [] as { messages: WireMessage[] }[] }));
vi.mock("@/lib/chat-wire", async (orig) => {
  const actual = await orig<typeof import("@/lib/chat-wire")>();
  return {
    ...actual,
    streamWireRound: vi.fn(async function* (opts: { messages: WireMessage[] }) {
      wire.calls.push({ messages: JSON.parse(JSON.stringify(opts.messages)) });
      const round = wire.rounds.shift() as WireStreamEvent[] | (() => AsyncGenerator<WireStreamEvent>) | undefined;
      if (!round) throw new Error("no scripted round");
      if (typeof round === "function") yield* round();
      else yield* round;
    }),
  };
});

import { createChatModelAdapter, type ChatRuntimeCtx } from "@/lib/chat-runtime";
import { DEFAULT_CHAT_SETTINGS } from "@/lib/chat-settings";

const text = (t: string): WireStreamEvent[] => [
  { type: "text", text: t },
  { type: "done", finishReason: "stop" },
];
const call = (index: number, id: string | undefined, name: string, args: string): WireStreamEvent => ({
  type: "toolcall",
  index,
  id,
  name,
  args,
});

function makeCtx(over: Partial<ChatRuntimeCtx> = {}): ChatRuntimeCtx & { system: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> } {
  const system = vi.fn(() => "SYSTEM PROMPT");
  const exec = vi.fn(async (_id: string, name: string) => `result of ${name}`);
  return {
    getSettings: () => DEFAULT_CHAT_SETTINGS,
    buildSystemPrompt: system,
    executeTool: exec,
    ...over,
    system,
    exec,
  } as never;
}

async function runAdapter(ctx: ChatRuntimeCtx, signal = new AbortController().signal, messages: unknown[] = [
  { role: "user", content: [{ type: "text", text: "go" }] },
]): Promise<ChatModelRunResult[]> {
  const adapter = createChatModelAdapter(() => ctx);
  const out: ChatModelRunResult[] = [];
  const gen = adapter.run({ messages, abortSignal: signal } as never) as AsyncGenerator<ChatModelRunResult>;
  for await (const r of gen) out.push(r);
  return out;
}

beforeEach(() => {
  wire.rounds = [];
  wire.calls = [];
});

describe("createChatModelAdapter", () => {
  it("returns the generator directly (the runtime checks Symbol.asyncIterator without awaiting)", () => {
    const adapter = createChatModelAdapter(() => makeCtx());
    wire.rounds.push(text("x"));
    const r = adapter.run({ messages: [], abortSignal: new AbortController().signal } as never);
    expect(typeof (r as AsyncGenerator)[Symbol.asyncIterator]).toBe("function");
  });

  it("streams a plain reply cumulatively and prepends a fresh system prompt", async () => {
    wire.rounds.push([{ type: "reasoning", text: "hm" }, { type: "text", text: "Hel" }, { type: "text", text: "lo" }, { type: "done", finishReason: "stop" }]);
    const ctx = makeCtx();
    const out = await runAdapter(ctx);
    const last = out.at(-1)!.content!;
    expect(last).toEqual([
      { type: "reasoning", id: "r0", text: "hm" },
      { type: "text", id: "t0", text: "Hello" },
    ]);
    expect(wire.calls[0].messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(wire.calls[0].messages[1]).toEqual({ role: "user", content: "go" });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it("runs the agentic loop: round → tool execution → next round with the results", async () => {
    wire.rounds.push(
      [call(0, "call_a", "list_", ""), call(0, undefined, "files", "{}"), { type: "done", finishReason: "tool_calls" }],
      text("You have main.tex."),
    );
    const ctx = makeCtx();
    ctx.exec.mockResolvedValue("Main file: main.tex");
    const out = await runAdapter(ctx);
    expect(ctx.exec).toHaveBeenCalledWith("call_a", "list_files", "{}");
    // the second round saw the assistant tool_calls and the tool result
    const second = wire.calls[1].messages;
    expect(second[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_a", function: { name: "list_files", arguments: "{}" } }] });
    expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "call_a", content: "Main file: main.tex" });
    // the system prompt is rebuilt every round
    expect(ctx.system).toHaveBeenCalledTimes(2);
    // the final yield carries both rounds: the tool part (with result) and the answer
    const parts = out.at(-1)!.content! as unknown as { type: string; toolName?: string; result?: string; text?: string }[];
    expect(parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
    expect(parts[0]).toMatchObject({ toolName: "list_files", result: "Main file: main.tex", isError: false });
    expect(parts[1].text).toBe("You have main.tex.");
  });

  it("marks ERROR: results as errors and uses placeholder ids when the model sends none", async () => {
    wire.rounds.push([call(0, undefined, "read_file", '{"path":"x"}')], text("sorry"));
    const ctx = makeCtx();
    ctx.exec.mockResolvedValue('ERROR: no file "x"');
    const out = await runAdapter(ctx);
    expect(ctx.exec.mock.calls[0][0]).toBe("gen0-0");
    const tool = (out.at(-1)!.content as unknown as { type: string; isError?: boolean }[]).find((p) => p.type === "tool-call");
    expect(tool?.isError).toBe(true);
  });

  it("ends a stuck run after 12 tool rounds with a note", async () => {
    for (let i = 0; i < 12; i++) wire.rounds.push([call(0, `c${i}`, "list_files", "{}")]);
    const out = await runAdapter(makeCtx());
    const last = out.at(-1)!.content as unknown as { type: string; text?: string }[];
    expect(last.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("stopped: the model kept calling tools") });
    expect(wire.calls).toHaveLength(12);
  });

  it("says so when the model answers nothing", async () => {
    wire.rounds.push([{ type: "done", finishReason: "stop" }]);
    const out = await runAdapter(makeCtx());
    expect(out.at(-1)!.content).toEqual([{ type: "text", id: "t0-empty", text: "(no response from the model)" }]);
  });

  it("throws an AbortError when aborted before starting or after the stream ends", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runAdapter(makeCtx(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });

    const ac2 = new AbortController();
    wire.rounds.push(async function* () {
      yield { type: "text", text: "x" } as WireStreamEvent;
      ac2.abort(); // the LAN stream ends quietly on abort
    } as never);
    await expect(runAdapter(makeCtx(), ac2.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("Stop while apply_edit blocks: the settled result is yielded BEFORE the abort propagates, so no tool row spins forever (e2e chat #9)", async () => {
    wire.rounds.push([call(0, "e1", "apply_edit", "{}")]);
    const ac = new AbortController();
    const ctx = makeCtx();
    // the tool blocks until the user decides; Stop settles it and aborts the run
    ctx.exec.mockImplementationOnce(async () => {
      ac.abort();
      return "The user stopped the conversation; the edit was not applied.";
    });
    const adapter = createChatModelAdapter(() => ctx);
    const gen = adapter.run({ messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], abortSignal: ac.signal } as never) as AsyncGenerator<ChatModelRunResult>;
    const seen: ChatModelRunResult[] = [];
    let threw: unknown = null;
    try {
      for await (const r of gen) seen.push(r);
    } catch (e) {
      threw = e;
    }
    expect(threw).toMatchObject({ name: "AbortError" });
    const parts = seen.at(-1)!.content as unknown as { toolCallId: string; result?: string }[];
    expect(parts.find((p) => p.toolCallId === "e1")?.result).toContain("not applied");
  });

  it("Stop between tool calls cancels before the next tool runs", async () => {
    wire.rounds.push([call(0, "c1", "compile", "{}"), call(1, "c2", "list_files", "{}")]);
    const ac = new AbortController();
    const ctx = makeCtx();
    ctx.exec.mockImplementationOnce(async () => {
      ac.abort();
      return "built";
    });
    await expect(runAdapter(ctx, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.exec).toHaveBeenCalledTimes(1);
  });

  it("reads settings through the ctx at run time (a settings change reaches the next run)", async () => {
    wire.rounds.push(text("x"));
    const getSettings = vi.fn(() => DEFAULT_CHAT_SETTINGS);
    await runAdapter(makeCtx({ getSettings }));
    expect(getSettings).toHaveBeenCalled();
  });
});
