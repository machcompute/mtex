// @vitest-environment jsdom
// The vendored MachLLM SDK, exercised over jsdom's real iframe + postMessage
// plumbing: the page <-> engine wire protocol that the old browser suite
// sniffed from a live engine, here driven by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachLLM } from "@/lib/mach-llm-sdk";

const ORIGIN = "http://engine.test:3001";
const NS = "mach-llm";

type Posted = { msg: Record<string, unknown>; origin: string };

function iframeOf(): HTMLIFrameElement {
  return document.querySelector("iframe") as HTMLIFrameElement;
}

/** Deliver an engine→page message as if from the engine's frame. */
function fromEngine(iframe: HTMLIFrameElement, data: unknown, origin = ORIGIN) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: iframe.contentWindow }));
}

async function connect(opts: { timeoutMs?: number; onProgress?: (p: never) => void } = {}) {
  const p = MachLLM.connect({ engineUrl: ORIGIN + "/", ...opts });
  const iframe = iframeOf();
  const posted: Posted[] = [];
  (iframe.contentWindow as Window).postMessage = ((msg: Record<string, unknown>, origin: string) => {
    posted.push({ msg, origin });
  }) as never;
  fromEngine(iframe, { ns: NS, type: "ready" });
  const llm = await p;
  return { llm, iframe, posted };
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("connect", () => {
  it("mounts a hidden webgpu iframe at the engine URL and resolves on the ready handshake", async () => {
    const p = MachLLM.connect({ engineUrl: ORIGIN + "/" });
    const iframe = iframeOf();
    expect(iframe.getAttribute("allow")).toBe("webgpu");
    expect(iframe.getAttribute("aria-hidden")).toBe("true");
    expect(iframe.style.display).toBe("none");
    expect(iframe.src).toBe(ORIGIN + "/");
    fromEngine(iframe, { ns: NS, type: "ready" });
    await expect(p).resolves.toBeInstanceOf(MachLLM);
  });

  it("ignores a ready from another origin, then times out with an engine-down error", async () => {
    vi.useFakeTimers();
    const p = MachLLM.connect({ engineUrl: ORIGIN + "/", timeoutMs: 5000 });
    const caught = p.catch((e: Error) => e);
    fromEngine(iframeOf(), { ns: NS, type: "ready" }, "http://evil.test");
    await vi.advanceTimersByTimeAsync(5000);
    const err = (await caught) as Error;
    expect(err.message).toBe(`Timed out connecting to the LLM engine at ${ORIGIN}`);
    expect(document.querySelector("iframe")).toBeNull(); // the dead frame is removed
  });
});

describe("requests over the wire", () => {
  it("lists models: posts models.list to the engine origin and resolves with the result", async () => {
    const { llm, iframe, posted } = await connect();
    const p = llm.models.list();
    expect(posted).toHaveLength(1);
    expect(posted[0].origin).toBe(ORIGIN);
    expect(posted[0].msg).toMatchObject({ ns: NS, method: "models.list" });
    const id = posted[0].msg.id as string;
    fromEngine(iframe, { ns: NS, id, type: "result", data: { object: "list", data: [{ id: "qwen", label: "Qwen" }] } });
    expect((await p).data[0].id).toBe("qwen");
  });

  it("streams a completion: chunks in order, progress events to handlers, then the final completion", async () => {
    const { llm, iframe, posted } = await connect();
    const progress = vi.fn();
    llm.on("progress", progress);
    const stream = (await llm.chat.completions.create({ messages: [{ role: "user", content: "hi" }], stream: true })) as AsyncIterable<unknown> & { completion: unknown };
    expect(posted[0].msg).toMatchObject({ method: "chat.completions.create", params: { messages: [{ role: "user", content: "hi" }] } });
    expect((posted[0].msg.params as Record<string, unknown>).stream).toBeUndefined(); // stripped on the wire
    const id = posted[0].msg.id as string;

    const got: unknown[] = [];
    const reader = (async () => {
      for await (const c of stream) got.push(c);
    })();
    fromEngine(iframe, { ns: NS, id, type: "chunk", data: { event: "progress", progress: { stage: "download", progress: 0.5 } } });
    fromEngine(iframe, { ns: NS, id, type: "chunk", data: { event: "chunk", chunk: { n: 1 } } });
    fromEngine(iframe, { ns: NS, id, type: "chunk", data: { event: "chunk", chunk: { n: 2 } } });
    fromEngine(iframe, { ns: NS, id, type: "result", data: { id: "done", choices: [] } });
    await reader;
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
    expect(progress).toHaveBeenCalledWith({ stage: "download", progress: 0.5 });
    expect(stream.completion).toEqual({ id: "done", choices: [] });
  });

  it("a non-stream create resolves with the completion", async () => {
    const { llm, iframe, posted } = await connect();
    const p = llm.chat.completions.create({ messages: [] });
    fromEngine(iframe, { ns: NS, id: posted[0].msg.id, type: "result", data: { id: "c" } });
    expect(await p).toEqual({ id: "c" });
  });

  it("propagates an engine error (message + code) into the stream's read loop", async () => {
    const { llm, iframe, posted } = await connect();
    const stream = (await llm.chat.completions.create({ messages: [], stream: true })) as AsyncIterable<unknown>;
    const reader = (async () => {
      for await (const c of stream) void c;
    })();
    const caught = reader.catch((e: Error & { code?: string }) => e);
    fromEngine(iframe, { ns: NS, id: posted[0].msg.id, type: "error", data: { message: "model failed", code: "E_MODEL" } });
    const e = (await caught) as Error & { code?: string };
    expect(e.message).toBe("model failed");
    expect(e.code).toBe("E_MODEL");
  });

  it("Stop: abort rejects the read loop client-side immediately and still posts the abort to the engine", async () => {
    const { llm, iframe, posted } = await connect();
    const ac = new AbortController();
    const stream = (await llm.chat.completions.create({ messages: [], stream: true }, { signal: ac.signal })) as AsyncIterable<unknown>;
    const id = posted[0].msg.id as string;
    const reader = (async () => {
      for await (const c of stream) void c;
    })();
    const caught = reader.catch((e: Error) => e);
    ac.abort();
    expect(((await caught) as Error).name).toBe("AbortError");
    expect(posted[1].msg).toMatchObject({ method: "abort", params: { targetId: id } });
    // a late engine answer for the dropped id is ignored
    expect(() => fromEngine(iframe, { ns: NS, id, type: "result", data: {} })).not.toThrow();
  });

  it("ignores messages from foreign sources, other namespaces and unknown ids", async () => {
    const { llm, iframe, posted } = await connect();
    const p = llm.models.list();
    const id = posted[0].msg.id as string;
    window.dispatchEvent(new MessageEvent("message", { data: { ns: NS, id, type: "result", data: "spoof" }, origin: ORIGIN, source: window }));
    fromEngine(iframe, { ns: "other", id, type: "result", data: "x" });
    fromEngine(iframe, { ns: NS, id: "nope", type: "result", data: "x" });
    fromEngine(iframe, { ns: NS, id, type: "result", data: "real" });
    expect(await p).toBe("real");
  });

  it("close() removes the frame and rejects in-flight requests", async () => {
    const { llm } = await connect();
    const p = llm.models.list();
    const caught = p.catch((e: Error) => e);
    llm.close();
    expect(((await caught) as Error).message).toBe("MachLLM connection is closed");
    expect(document.querySelector("iframe")).toBeNull();
    await expect(llm.models.list()).rejects.toThrow(/closed/);
  });
});
