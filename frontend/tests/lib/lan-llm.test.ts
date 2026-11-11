// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeLlm = {
  handlers: ((p: unknown) => void)[];
  closed: boolean;
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
  models: { list: ReturnType<typeof vi.fn> };
  on: (e: string, h: (p: unknown) => void) => FakeLlm;
  close: () => void;
};

const sdk = vi.hoisted(() => ({
  instances: [] as unknown[],
  connect: vi.fn(),
}));
vi.mock("@/lib/mach-llm-sdk", () => ({ MachLLM: { connect: sdk.connect } }));

import {
  LanEngineUnreachableError,
  closeLanLlm,
  ensureLanLlm,
  lanListModels,
  lanStreamChat,
} from "@/lib/lan-llm";

function newFake(): FakeLlm {
  const f: FakeLlm = {
    handlers: [],
    closed: false,
    chat: { completions: { create: vi.fn() } },
    models: { list: vi.fn(async () => ({ data: [{ id: "qwen", label: "Qwen", cached: true }] })) },
    on(_e, h) {
      f.handlers.push(h);
      return f;
    },
    close() {
      f.closed = true;
    },
  };
  sdk.instances.push(f);
  return f;
}

beforeEach(() => {
  closeLanLlm();
  sdk.instances = [];
  sdk.connect.mockReset();
  sdk.connect.mockImplementation(async () => newFake());
});

describe("connection cache", () => {
  it("one engine connection per origin, shared by concurrent and later callers", async () => {
    const [a, b] = await Promise.all([ensureLanLlm("http://engine:3001"), ensureLanLlm("http://engine:3001/")]);
    expect(a).toBe(b);
    expect(await ensureLanLlm("http://engine:3001")).toBe(a);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(sdk.connect.mock.calls[0][0]).toMatchObject({ engineUrl: "http://engine:3001/", timeoutMs: 20_000 });
    await ensureLanLlm("http://other:3001");
    expect(sdk.connect).toHaveBeenCalledTimes(2);
  });

  it("fans engine progress out to subscribers and replays the latest to late ones", async () => {
    const early = vi.fn();
    await ensureLanLlm("http://engine:3001", early);
    const fake = sdk.instances[0] as FakeLlm;
    fake.handlers[0]({ stage: "download", progress: 0.3 });
    expect(early).toHaveBeenCalledWith({ stage: "download", progress: 0.3 });
    const late = vi.fn();
    await ensureLanLlm("http://engine:3001", late);
    expect(late).toHaveBeenCalledWith({ stage: "download", progress: 0.3 }); // replay
    fake.handlers[0]({ stage: "ready", progress: 1 });
    expect(early).toHaveBeenLastCalledWith({ stage: "ready", progress: 1 });
    expect(late).toHaveBeenLastCalledWith({ stage: "ready", progress: 1 });
  });

  it("closeLanLlm drops one or all connections; the next call reconnects", async () => {
    await ensureLanLlm("http://a:1");
    await ensureLanLlm("http://b:1");
    closeLanLlm("http://a:1");
    expect((sdk.instances[0] as FakeLlm).closed).toBe(true);
    expect((sdk.instances[1] as FakeLlm).closed).toBe(false);
    await ensureLanLlm("http://a:1");
    expect(sdk.connect).toHaveBeenCalledTimes(3);
    closeLanLlm();
    expect((sdk.instances[1] as FakeLlm).closed).toBe(true);
  });
});

describe("engine unreachable (e2e chat check 12: dead port)", () => {
  it("throws a recognizable LanEngineUnreachableError that points at the settings", async () => {
    sdk.connect.mockRejectedValue(new Error("Timed out connecting to the LLM engine at http://localhost:3999"));
    const err = (await ensureLanLlm("http://localhost:3999").catch((e: unknown) => e)) as LanEngineUnreachableError;
    expect(err).toBeInstanceOf(LanEngineUnreachableError);
    expect(err.name).toBe("LanEngineUnreachableError");
    expect(err.engineUrl).toBe("http://localhost:3999");
    expect(err.message).toBe(
      "Could not reach the LAN LLM engine at http://localhost:3999 — is it running? Check the engine URL in the chat settings.",
    );
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("a failed handshake is not cached: restoring the URL works on the next call", async () => {
    sdk.connect.mockRejectedValueOnce(new Error("down"));
    await expect(ensureLanLlm("http://engine:3001")).rejects.toBeInstanceOf(LanEngineUnreachableError);
    await expect(ensureLanLlm("http://engine:3001")).resolves.toBeDefined();
  });
});

describe("requests", () => {
  it("lanStreamChat asks for a stream with the caller's signal and returns it", async () => {
    const ac = new AbortController();
    const stream = { controller: new AbortController(), [Symbol.asyncIterator]: async function* () {} };
    await ensureLanLlm("http://engine:3001");
    (sdk.instances[0] as FakeLlm).chat.completions.create.mockResolvedValue(stream);
    const out = await lanStreamChat("http://engine:3001", { messages: [{ role: "user", content: "x" }] }, ac.signal);
    expect(out).toBe(stream);
    expect((sdk.instances[0] as FakeLlm).chat.completions.create).toHaveBeenCalledWith(
      { messages: [{ role: "user", content: "x" }], stream: true },
      { signal: ac.signal },
    );
  });

  it("rejects a non-stream answer", async () => {
    await ensureLanLlm("http://engine:3001");
    (sdk.instances[0] as FakeLlm).chat.completions.create.mockResolvedValue({ id: "plain", choices: [] });
    await expect(lanStreamChat("http://engine:3001", { messages: [] }, new AbortController().signal)).rejects.toThrow(
      /did not return a stream/,
    );
  });

  it("lanListModels returns the engine's live model list (settings modal)", async () => {
    expect(await lanListModels("http://engine:3001")).toEqual([{ id: "qwen", label: "Qwen", cached: true }]);
  });
});
