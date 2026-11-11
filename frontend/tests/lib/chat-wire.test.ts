import type { ThreadMessage } from "@assistant-ui/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lan = vi.hoisted(() => ({
  lanStreamChat: vi.fn(),
}));
vi.mock("@/lib/lan-llm", () => lan);

import { streamWireRound, toWireMessages, type WireStreamEvent } from "@/lib/chat-wire";
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "@/lib/chat-settings";

const msg = (m: unknown) => m as ThreadMessage;
const user = (text: string) => msg({ role: "user", content: [{ type: "text", text }] });
const assistant = (...content: unknown[]) => msg({ role: "assistant", content });

describe("toWireMessages", () => {
  it("skips system messages and concatenates a user message's text parts", () => {
    const out = toWireMessages([
      msg({ role: "system", content: [{ type: "text", text: "ignored" }] }),
      msg({
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "image", image: "x" },
          { type: "text", text: "world" },
        ],
      }),
    ]);
    expect(out).toEqual([{ role: "user", content: "Hello world" }]);
  });

  it("flushes an assistant message's tool calls followed by one tool message per call", () => {
    const out = toWireMessages([
      user("list my files"),
      assistant(
        { type: "reasoning", text: "thinking (never sent back)" },
        { type: "text", text: "Looking." },
        { type: "tool-call", toolCallId: "c1", toolName: "list_files", args: {}, result: "Main file: main.tex" },
        { type: "tool-call", toolCallId: "c2", toolName: "read_file", args: { path: "main.tex" } },
      ),
    ]);
    expect(out).toEqual([
      { role: "user", content: "list my files" },
      {
        role: "assistant",
        content: "Looking.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"main.tex"}' } },
        ],
      },
      // c2 has no result yet: no tool message for it
      { role: "tool", tool_call_id: "c1", content: "Main file: main.tex" },
    ]);
  });

  it("a text part after pending tool calls starts a new assistant message", () => {
    const out = toWireMessages([
      assistant(
        { type: "tool-call", toolCallId: "c1", toolName: "compile", args: {}, result: "ok" },
        { type: "text", text: "Done." },
      ),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(out[2]).toEqual({ role: "assistant", content: "Done." });
  });

  it("caps oversize tool results", () => {
    const out = toWireMessages([
      assistant({ type: "tool-call", toolCallId: "c1", toolName: "get_build_log", args: {}, result: "x".repeat(60_000) }),
    ]);
    expect((out[1] as { content: string }).content).toHaveLength(16_000);
  });
});

async function collect(gen: AsyncGenerator<WireStreamEvent>): Promise<WireStreamEvent[]> {
  const out: WireStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** An SSE response whose body arrives in exactly the given chunks. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) =>
  ev({ choices: [{ delta: d, finish_reason: finish }] });

const endpoint = (over: Partial<ChatSettings> = {}): ChatSettings => ({
  ...DEFAULT_CHAT_SETTINGS,
  backend: "endpoint",
  endpointUrl: "http://mock.local:9000/v1",
  apiKey: "sk-test-key",
  endpointModel: "gpt-mock",
  ...over,
});

const run = (settings: ChatSettings, signal = new AbortController().signal) =>
  streamWireRound({
    settings,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function" }],
    signal,
  });

describe("endpoint backend (e2e chat check 12: direct SSE, Bearer key)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => sseResponse([delta({ content: "pong" }, "stop"), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("calls {base}/chat/completions directly with the Bearer key, the model, the tools and stream:true", async () => {
    const events = await collect(run(endpoint()));
    expect(events).toEqual([
      { type: "text", text: "pong" },
      { type: "done", finishReason: "stop" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mock.local:9000/v1/chat/completions");
    expect(url).not.toContain("/api/chat"); // the deleted proxy route is never hit
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-mock", stream: true, tools: [{ type: "function" }] });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("omits the auth header with no key and the model when none is configured", async () => {
    await collect(run(endpoint({ apiKey: "", endpointModel: "" })));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).not.toHaveProperty("model");
  });

  it.each([
    ["http://h/v1", "http://h/v1/chat/completions"],
    ["http://h/v1/", "http://h/v1/chat/completions"],
    ["  http://h/v1//  ", "http://h/v1/chat/completions"],
    ["http://h/v1/chat/completions", "http://h/v1/chat/completions"],
  ])("normalizes the address %j", async (raw, expected) => {
    await collect(run(endpoint({ endpointUrl: raw })));
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
  });

  it("refuses to run with no address, without touching the network", async () => {
    await expect(collect(run(endpoint({ endpointUrl: "  " })))).rejects.toThrow(/No endpoint address set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses SSE split anywhere across network chunks, with CRLF, comments and junk lines", async () => {
    const full =
      delta({ reasoning_content: "hm" }) +
      ": keep-alive comment\r\n" +
      "garbage line\n" +
      "data: {not json}\n" +
      delta({ content: "Hel" }) +
      delta({ content: "lo" }, "stop") +
      "data: [DONE]\n\n";
    // cut the stream at awkward byte offsets
    const cuts = [7, 23, 60, 61, 120, full.length];
    const chunks: string[] = [];
    let at = 0;
    for (const c of cuts) {
      chunks.push(full.slice(at, c));
      at = c;
    }
    fetchMock.mockImplementation(async () => sseResponse(chunks));
    const events = await collect(run(endpoint()));
    expect(events).toEqual([
      { type: "reasoning", text: "hm" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("accumulates tool-call fragments per index and yields them as they arrive", async () => {
    fetchMock.mockImplementation(async () =>
      sseResponse([
        delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_2", function: { name: "compile", arguments: "{}" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"main.tex"}' } }] }, "tool_calls"),
        delta({ tool_calls: [{ index: 0 }] }), // no fragment: ignored
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(run(endpoint()));
    expect(events).toEqual([
      { type: "toolcall", index: 0, id: "call_1", name: "read_", args: "" },
      { type: "toolcall", index: 0, id: undefined, name: "file", args: '{"pa' },
      { type: "toolcall", index: 1, id: "call_2", name: "compile", args: "{}" },
      { type: "toolcall", index: 0, id: undefined, name: undefined, args: 'th":"main.tex"}' },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });

  it("turns an HTTP error into a readable failure (JSON error text, else the status)", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }));
    await expect(collect(run(endpoint()))).rejects.toThrow("bad key");
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 502 }));
    await expect(collect(run(endpoint()))).rejects.toThrow("HTTP 502");
  });

  it("passes the abort signal to fetch so Stop cancels the request", async () => {
    const ac = new AbortController();
    await collect(run(endpoint(), ac.signal));
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ac.signal);
  });
});

describe("LAN backend", () => {
  const settings = (over: Partial<ChatSettings> = {}): ChatSettings => ({ ...DEFAULT_CHAT_SETTINGS, backend: "lan", ...over });
  const streamOf = (chunks: unknown[], completion: unknown = null) => ({
    completion,
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });

  it("streams text/reasoning/tool-call deltas and the finish reason from the engine", async () => {
    lan.lanStreamChat.mockResolvedValue(
      streamOf([
        { choices: [{ delta: { reasoning_content: "think" }, finish_reason: null }] },
        { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
        { choices: [] }, // no choice: skipped
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "list_files", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const progress = vi.fn();
    const ac = new AbortController();
    const events = await collect(
      streamWireRound({
        settings: settings({ engineUrl: "http://engine:3001", model: "qwen" }),
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: ac.signal,
        onEngineProgress: progress,
      }),
    );
    expect(events).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "Hi" },
      { type: "toolcall", index: 0, id: "t", name: "list_files", args: "{}" },
      { type: "done", finishReason: "tool_calls" },
    ]);
    const [url, params, signal, onProgress] = lan.lanStreamChat.mock.calls[0];
    expect(url).toBe("http://engine:3001");
    expect(params).toMatchObject({ model: "qwen", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(signal).toBe(ac.signal);
    expect(onProgress).toBe(progress);
  });

  it("omits the model when unset and falls back to the completion's finish reason", async () => {
    lan.lanStreamChat.mockResolvedValue(
      streamOf([{ choices: [{ delta: { content: "x" }, finish_reason: null }] }], {
        choices: [{ finish_reason: "stop" }],
      }),
    );
    const events = await collect(run(settings()));
    expect(lan.lanStreamChat.mock.calls.at(-1)![1]).not.toHaveProperty("model");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("never touches fetch / the deleted /api/chat route", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    lan.lanStreamChat.mockResolvedValue(streamOf([]));
    await collect(run(settings()));
    expect(f).not.toHaveBeenCalled();
  });

  it("propagates an unreachable engine", async () => {
    lan.lanStreamChat.mockRejectedValue(new Error("Could not reach the LAN LLM engine"));
    await expect(collect(run(settings()))).rejects.toThrow(/Could not reach/);
  });
});
