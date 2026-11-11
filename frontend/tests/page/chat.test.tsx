// The chat pane with the REAL drawer, assistant-ui runtime and agentic loop,
// talking to (a) an OpenAI-compatible endpoint through a fetch stub and (b) the LAN
// engine through a mocked engine client (e2e: chat.cjs checks 1-13).
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lan = vi.hoisted(() => ({
  lanStreamChat: vi.fn(),
  lanListModels: vi.fn(),
  lanEngineDefaultModel: vi.fn(),
  lanPreloadModel: vi.fn(),
}));
vi.mock("@/lib/lan-llm", async (orig) => {
  const actual = await orig<typeof import("@/lib/lan-llm")>();
  // Every request goes through the strict engine-validation fake first (the
  // real engine rejects e.g. a last message that is not user/tool).
  const { validateWireRequest } = await import("../support/fake-engine");
  const validated = (...args: Parameters<typeof actual.lanStreamChat>) => {
    validateWireRequest(args[1].messages);
    return lan.lanStreamChat(...args);
  };
  return { ...actual, lanStreamChat: validated, lanListModels: lan.lanListModels, lanEngineDefaultModel: lan.lanEngineDefaultModel, lanPreloadModel: lan.lanPreloadModel, closeLanLlm: vi.fn() };
});

import { CHAT_SETTINGS_KEY, DEFAULT_CHAT_SETTINGS, type ChatSettings } from "@/lib/chat-settings";
import { LanEngineUnreachableError } from "@/lib/lan-llm";
import { FakeBusyTex } from "../support/fake-busytex";
import { click, openFile, q, qa, rail } from "../support/page-actions";
import { FakeSelection, monacoState } from "../support/stubs/monaco";
import { act, advance, deferred, mountEditor, railActive, settle } from "../support/page-utils";
import { ctan } from "../support/stubs/ctan";
import { validateWireRequest } from "../support/fake-engine";

const MAIN = "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}\n";
const seed = { name: "chat", mainPath: "main.tex", files: { "main.tex": MAIN, "refs.bib": "@book{k}" } };

const endpointSettings = (over: Partial<ChatSettings> = {}): ChatSettings => ({
  ...DEFAULT_CHAT_SETTINGS,
  backend: "endpoint",
  endpointUrl: "http://mock.local:9000/v1",
  apiKey: "sk-test-key",
  endpointModel: "gpt-mock",
  ...over,
});
const applySettings = (s: ChatSettings) => localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(s));

// --- an OpenAI-compatible endpoint stub ------------------------------------------
type Capture = { url: string; headers: Record<string, string>; body: { model?: string; stream: boolean; messages: { role: string; content: string }[]; tools: unknown[] } };
let wireCaptures: Capture[] = [];
let scripted: (() => Response)[] = [];

const sse = (...events: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const textReply = (t: string) => () => sse({ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
// OpenAI-style: the first fragment carries id + name with empty arguments, the arguments follow.
const toolReply = (id: string, name: string, args: unknown) => () =>
  sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  );

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() }));
  FakeBusyTex.autoReady = false;
  wireCaptures = [];
  scripted = [];
  lan.lanStreamChat.mockReset();
  lan.lanListModels.mockReset();
  lan.lanEngineDefaultModel.mockReset();
  lan.lanEngineDefaultModel.mockResolvedValue(null);
  lan.lanPreloadModel.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/chat/completions")) validateWireRequest(JSON.parse(String(init?.body ?? "{}")).messages);
      wireCaptures.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
      const next = scripted.shift();
      if (!next) throw new Error(`no scripted endpoint reply for ${url}`);
      return next();
    }),
  );
});

// --- UI drivers ----------------------------------------------------------------------
const input = () => q<HTMLTextAreaElement>("[data-chat-input]")!;
async function send(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await settle();
  await click(q("[data-chat-send]"), "send");
  await advance(50);
}
const roles = () => qa("[data-chat-role]").map((e) => e.dataset.chatRole);
const assistantText = () => qa('[data-chat-role="assistant"]').map((e) => e.textContent).join("\n");
const toolRows = () => qa('[data-chat-role="tool"]').map((e) => e.textContent ?? "");
const bodyOf = (i: number) => wireCaptures[i].body;
const system = (i: number) => bodyOf(i).messages[0].content;

describe("endpoint backend (chat check 12)", () => {
  it("the rail carries Files/Search/Chat/Log; Chat opens the pane with an input and a send button", async () => {
    applySettings(endpointSettings());
    await mountEditor(seed);
    await rail("chat");
    expect(railActive()).toEqual(["chat"]);
    expect(input()).not.toBeNull();
    expect(q("[data-chat-send]")).not.toBeNull();
    expect(document.body.textContent).toContain("Ask about the document you are editing");
  });

  it("streams the reply into the thread; the page calls the endpoint DIRECTLY with the user's Bearer key, model and stream:true (never /api/chat)", async () => {
    applySettings(endpointSettings());
    scripted.push(textReply("pong"));
    await mountEditor(seed);
    await rail("chat");
    await send("ping");
    expect(roles()).toEqual(["user", "assistant"]);
    expect(assistantText()).toContain("pong");
    expect(qa('[data-chat-role="user"]')[0].textContent).toContain("ping");
    expect(wireCaptures).toHaveLength(1);
    const c = wireCaptures[0];
    expect(c.url).toBe("http://mock.local:9000/v1/chat/completions");
    expect(c.url).not.toContain("/api/chat");
    expect(c.headers.authorization).toBe("Bearer sk-test-key");
    expect(c.body).toMatchObject({ model: "gpt-mock", stream: true });
    expect(c.body.messages.at(-1)).toEqual({ role: "user", content: "ping" });
    expect(c.body.tools).toHaveLength(7);
    expect(q("[data-chat-error]")).toBeNull();
  });

  it("the system prompt carries the active file, and the cursor line/column (read at send time)", async () => {
    applySettings(endpointSettings());
    scripted.push(textReply("ok"));
    await mountEditor(seed);
    monacoState.selection = new FakeSelection(3, 7, 3, 7);
    await rail("chat");
    await send("where am I?");
    const sys = system(0);
    expect(sys).toContain('The user is editing "main.tex" in the editor right now:');
    expect(sys).toContain('<file path="main.tex">\n' + MAIN);
    expect(sys).toContain('The cursor in "main.tex" is at line 3, column 7.');
  });

  it("a selection is quoted with its line range so 'fix this' has a target", async () => {
    applySettings(endpointSettings());
    scripted.push(textReply("ok"));
    await mountEditor(seed);
    monacoState.selection = new FakeSelection(3, 1, 3, 6); // "Hello"
    await rail("chat");
    await send("fix this");
    expect(system(0)).toContain('The user\'s selection in "main.tex", lines 3-3:\n<selection>\nHello\n</selection>');
  });

  it("with a binary file active the prompt says so; with a stale cursor on a closed model nothing is quoted", async () => {
    applySettings(endpointSettings());
    scripted.push(textReply("ok"));
    await mountEditor({ ...seed, files: { ...seed.files, "pic.png": new Uint8Array([137, 80, 78, 71, 255]) } as never, openPaths: ["main.tex", "pic.png"], activePath: "pic.png" });
    await rail("chat");
    await send("hi");
    expect(system(0)).toContain("(binary file)");
    expect(system(0)).not.toContain("The cursor in");
  });

  it("the system prompt is rebuilt every round (an accepted edit changes the file the model sees next)", async () => {
    applySettings(endpointSettings());
    scripted.push(toolReply("e1", "apply_edit", { path: "main.tex", old: "Hello world", new: "Hello EDITED" }), textReply("Done."));
    await mountEditor(seed);
    await rail("chat");
    await send("edit it");
    await click(q("[data-chat-edit-accept]"), "accept");
    await advance(50);
    expect(system(0)).toContain("Hello world");
    expect(system(1)).toContain("Hello EDITED");
    expect(system(1)).not.toContain("Hello world");
  });
});

describe("agentic tools (chat checks 6-9)", () => {
  async function chatWith(replies: (() => Response)[]) {
    applySettings(endpointSettings());
    scripted.push(...replies);
    await mountEditor(seed);
    await rail("chat");
  }

  it("list_files runs and its result shows in a tool row; the next round sees it", async () => {
    await chatWith([toolReply("c1", "list_files", {}), textReply("You have two files.")]);
    await send("list my files");
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0]).toContain("list_files");
    expect(toolRows()[0]).toContain("Main file: main.tex");
    expect(toolRows()[0]).toContain("refs.bib");
    expect(assistantText()).toContain("You have two files.");
    const toolMsg = bodyOf(1).messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("Main file: main.tex");
  });

  it("read_file returns text, marks binaries, and reports a missing file as an ERROR the model can react to", async () => {
    await chatWith([toolReply("c1", "read_file", { path: "refs.bib" }), toolReply("c2", "read_file", { path: "nope.tex" }), textReply("ok")]);
    await send("read");
    expect(toolRows()[0]).toContain("@book{k}");
    expect(toolRows()[1]).toContain('ERROR: no file "nope.tex"');
    expect(toolRows()[1]).toContain("main.tex, refs.bib");
  });

  it("compile builds through the page and reports the outcome with a log tail", async () => {
    FakeBusyTex.autoReady = true;
    FakeBusyTex.handler = async () => ({ pdf: new Uint8Array([1]), log: "This is XeTeX\n(./main.aux)", synctex: null, buildState: null });
    await chatWith([toolReply("c1", "compile", {}), textReply("Built.")]);
    act(() => FakeBusyTex.instances[0].emitReady());
    await settle();
    await send("compile");
    await advance(500);
    expect(toolRows()[0]).toMatch(/Compilation succeeded in \d+ ms\./);
    expect(toolRows()[0]).toContain("(./main.aux)");
  });

  it("get_build_log reads the last build's log; with no build yet it says so", async () => {
    await chatWith([toolReply("c1", "get_build_log", {}), textReply("ok")]);
    await send("log?");
    expect(toolRows()[0]).toContain("(no build has completed yet)");
  });

  it("search_packages and install_package use the CTAN store; install restarts the engine through the shared notice path", async () => {
    ctan.searchPackages.mockResolvedValue([
      { name: "tikz-cd", installed: false, shortdesc: "commutative diagrams" },
      { name: "pgf", installed: true, shortdesc: "graphics" },
    ]);
    ctan.installWithDependencies.mockResolvedValue({ package: { name: "pgf" }, installedDependencies: ["xcolor"], unresolved: ["weird"] });
    await chatWith([toolReply("c1", "search_packages", { query: "tikz" }), toolReply("c2", "install_package", { name: "pgf" }), toolReply("c3", "install_package", { name: "../evil" }), textReply("done")]);
    await send("get tikz");
    expect(toolRows()[0]).toBe("Tool · search_packages" + "tikz-cd — commutative diagrams\npgf (installed) — graphics");
    expect(toolRows()[1]).toContain('Installed "pgf" (pulled in: xcolor) — could not auto-install: weird. The package is available on the next compile.');
    expect(toolRows()[2]).toContain('ERROR: "../evil" is not a valid package name');
    expect(document.querySelector("[data-notice]")!.textContent).toContain("the engine restarts with the next compile");
    expect(FakeBusyTex.instances[0].disposed).toBe(true);
  });

  it("an unknown tool and malformed arguments are reported as ERRORs, not exceptions", async () => {
    await chatWith([
      toolReply("c1", "format_disk", {}),
      () =>
        sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "read_file", arguments: "" } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{not json" } }] }, finish_reason: null }] },
        ),
      textReply("ok"),
    ]);
    await send("x");
    expect(toolRows()[0]).toContain('ERROR: unknown tool "format_disk".');
    expect(toolRows()[1]).toContain("ERROR: the tool arguments were not valid JSON");
  });

  it("apply_edit: the pending card shows old/new; ACCEPT lands the edit in the editor and the card goes away (check 7)", async () => {
    await chatWith([toolReply("e1", "apply_edit", { path: "main.tex", old: "Hello world", new: "Hello CHAT EDIT" }), textReply("Edited.")]);
    await send("change the greeting");
    const card = q("[data-chat-pending-edit]")!;
    expect(card.textContent).toContain("main.tex:3");
    expect(card.textContent).toContain("- Hello world");
    expect(card.textContent).toContain("+ Hello CHAT EDIT");
    expect(q("[data-chat-edit-accept]")).not.toBeNull();
    // still waiting: the tool row spins with the waiting hint
    expect(document.body.textContent).toContain("Waiting for your decision on the edit…");
    await click(q("[data-chat-edit-accept]"));
    await advance(50);
    expect(q("[data-chat-pending-edit]")).toBeNull();
    expect(monacoState.model()!.value).toContain("Hello CHAT EDIT");
    expect(monacoState.undoStops).toBe(1); // one undo step for the whole change
    expect(toolRows()[0]).toContain("The user ACCEPTED the edit; it was applied to main.tex.");
    expect(assistantText()).toContain("Edited.");
  });

  it("apply_edit: REJECT leaves the file unchanged and records the rejection as the tool result (check 8)", async () => {
    await chatWith([toolReply("e1", "apply_edit", { path: "main.tex", old: "Hello world", new: "NOPE" }), textReply("Understood.")]);
    await send("change it");
    await click(q("[data-chat-edit-reject]"));
    await advance(50);
    expect(q("[data-chat-pending-edit]")).toBeNull();
    expect(monacoState.model()!.value).toBe(MAIN);
    expect(toolRows()[0]).toContain("The user REJECTED the edit; main.tex is unchanged.");
  });

  it("an accept whose target text changed meanwhile applies nothing and says so", async () => {
    await chatWith([toolReply("e1", "apply_edit", { path: "main.tex", old: "Hello world", new: "X" }), textReply("ok")]);
    await send("change it");
    await act(async () => monacoState.type(MAIN.replace("Hello world", "Changed by hand")));
    await settle();
    await click(q("[data-chat-edit-accept]"));
    await advance(50);
    expect(monacoState.model()!.value).not.toContain("X\n");
    expect(toolRows()[0]).toContain("changed in the meantime and the edit could not be applied");
  });

  it.each([
    [{ path: "nope.tex", old: "a", new: "b" }, 'ERROR: no file "nope.tex" in the project.'],
    [{ path: "main.tex", old: "", new: "b" }, 'ERROR: "old" must not be empty.'],
    [{ path: "main.tex", old: "absent text", new: "b" }, 'ERROR: the text given as "old" was not found in "main.tex".'],
    [{ path: "main.tex", old: "e", new: "b" }, 'occurs'],
  ])("apply_edit validation %#: %j", async (args, expected) => {
    await chatWith([toolReply("e1", "apply_edit", args), textReply("ok")]);
    await send("x");
    expect(q("[data-chat-pending-edit]")).toBeNull();
    expect(toolRows()[0]).toContain(expected);
  });

  it("apply_edit refuses binary files", async () => {
    applySettings(endpointSettings());
    scripted.push(toolReply("e1", "apply_edit", { path: "pic.png", old: "a", new: "b" }), textReply("ok"));
    await mountEditor({ ...seed, files: { ...seed.files, "pic.png": new Uint8Array([137, 80, 78, 71, 255]) } as never });
    await rail("chat");
    await send("x");
    expect(toolRows()[0]).toContain('"pic.png" is a binary file; apply_edit works on text files only.');
  });

  it("Stop while the loop blocks on an approval: card gone, run cancelled with no error box, the user's message kept, file unchanged, send button back (check 9)", async () => {
    await chatWith([toolReply("e1", "apply_edit", { path: "main.tex", old: "Hello world", new: "NEVER" })]);
    await send("change it");
    expect(q("[data-chat-pending-edit]")).not.toBeNull();
    await click(q("[data-chat-stop]"), "stop");
    await advance(50);
    expect(q("[data-chat-pending-edit]")).toBeNull();
    expect(q("[data-chat-stop]")).toBeNull();
    expect(q("[data-chat-send]")).not.toBeNull(); // the send button is back
    expect(q("[data-chat-error]")).toBeNull();
    expect(qa('[data-chat-role="user"]')[0].textContent).toContain("change it");
    expect(monacoState.model()!.value).toBe(MAIN);
  });

  // KNOWN GAP, found while porting e2e check 9 (which the old suite SKIPs on hosts without
  // real WebGPU, so it never ran there): chat-runtime yields the settled tool results just
  // before it throws AbortError, but assistant-ui's local runtime drops any update that
  // arrives after the abort signal fired, so the tool row keeps its "Waiting for your
  // decision" spinner after Stop. `it.fails` pins the CURRENT behavior and turns red the
  // moment the app is fixed — at which point drop the `.fails`.
  it.fails("the stopped edit's tool row settles with the 'not applied' result instead of spinning (check 9, currently not met)", async () => {
    await chatWith([toolReply("e1", "apply_edit", { path: "main.tex", old: "Hello world", new: "NEVER" })]);
    await send("change it");
    await click(q("[data-chat-stop]"), "stop");
    await advance(50);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0]).toContain("The user stopped the conversation; the edit was not applied.");
  });

  it("Clear empties the conversation; the Log pane still shows the build log (check 10)", async () => {
    FakeBusyTex.autoReady = true;
    FakeBusyTex.handler = async () => ({ pdf: new Uint8Array([1]), log: "THE BUILD LOG", synctex: null, buildState: null });
    applySettings(endpointSettings());
    scripted.push(textReply("pong"));
    await mountEditor(seed);
    await advance(10);
    await rail("chat");
    await send("ping");
    expect(roles().length).toBeGreaterThan(0);
    await click(q("[data-chat-clear]"));
    await advance(10);
    expect(roles()).toEqual([]);
    await rail("log");
    expect(q("pre")!.textContent).toContain("THE BUILD LOG");
  });

  it("the chat keeps running while another pane is shown (the drawer stays mounted)", async () => {
    await chatWith([textReply("still here")]);
    await send("hi");
    await rail("search");
    await rail("chat");
    expect(assistantText()).toContain("still here");
  });
});

describe("endpoint errors", () => {
  it("an HTTP failure shows in the error box (no settings link for the endpoint backend)", async () => {
    applySettings(endpointSettings());
    scripted.push(() => new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 }));
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    expect(q("[data-chat-error]")!.textContent).toContain("invalid api key");
    expect(q("[data-chat-error]")!.textContent).not.toContain("Open chat settings");
  });

  it("no endpoint address configured: tells the user to open the chat settings", async () => {
    applySettings(endpointSettings({ endpointUrl: "" }));
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    expect(q("[data-chat-error]")!.textContent).toContain("No endpoint address set");
  });
});

describe("LAN backend (chat checks 3, 5, 11-13)", () => {
  const stream = (chunks: unknown[]) => ({
    completion: null,
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });
  const say = (t: string) => stream([{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);

  it("sends the prompt over the engine client (no HTTP): the cursor line is on the wire and /api/chat is never hit", async () => {
    lan.lanStreamChat.mockResolvedValue(say("hello from the engine"));
    await mountEditor(seed);
    monacoState.selection = new FakeSelection(3, 3, 3, 3);
    await rail("chat");
    await send("hi");
    expect(assistantText()).toContain("hello from the engine");
    const [url, params] = lan.lanStreamChat.mock.calls[0];
    expect(url).toBe("http://localhost:3001");
    expect(params.messages[0].content).toContain('The cursor in "main.tex" is at line 3, column 3.');
    expect(params.messages[0].content).toContain("<file path=\"main.tex\">");
    expect(params.stream).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); // the deleted /api/chat route is never hit
  });

  it("a dead engine shows the graceful error box with a link to the chat settings (check 12)", async () => {
    lan.lanStreamChat.mockRejectedValue(new LanEngineUnreachableError("http://localhost:3999", new Error("Timed out")));
    lan.lanListModels.mockRejectedValue(new LanEngineUnreachableError("http://localhost:3999", new Error("Timed out")));
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    const box = q("[data-chat-error]")!;
    expect(box.textContent).toContain("Could not reach the LAN LLM engine at http://localhost:3999");
    expect(box.textContent).toContain("Open chat settings");
    expect(box.textContent).not.toContain("Timed out connecting"); // not the raw SDK message
    await click(box.querySelector("button"));
    await advance(10);
    expect(q('[data-modal="chat-settings"]')).not.toBeNull();
    expect(q('[data-modal="chat-settings"]')!.textContent).toContain("Could not reach the LAN LLM engine");
  });

  it("the settings modal lists the engine's models live, and a model pick commits with Save (check 11)", async () => {
    lan.lanListModels.mockResolvedValue([
      { object: "model", id: "qwen3-27b", label: "Qwen3 27B", modalities: ["text"], maxContext: 32768, cached: true },
      { object: "model", id: "tiny", label: "Tiny", modalities: ["text"], maxContext: 4096, cached: false },
    ]);
    await mountEditor(seed);
    await rail("chat");
    await click(q('button[title^="Chat settings"]'));
    await advance(10);
    const modal = q('[data-modal="chat-settings"]')!;
    expect(modal.textContent).toContain("Engine reachable — 2 models listed.");
    const sel = modal.querySelector("select")!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Engine default", "Qwen3 27B — qwen3-27b (cached)", "Tiny — tiny"]);
    const save = [...modal.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(true); // nothing to save yet
    fireEvent.change(sel, { target: { value: "qwen3-27b" } });
    await settle();
    expect(save.disabled).toBe(false);
    await click(save);
    expect(JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY)!).model).toBe("qwen3-27b");
    lan.lanStreamChat.mockResolvedValue(say("ok"));
    await click(q('[data-modal="chat-settings"] button[title="Close"]'));
    await send("hi");
    expect(lan.lanStreamChat.mock.calls[0][1].model).toBe("qwen3-27b");
  });

  it("switching to the API endpoint in the settings persists and the next message goes straight to it", async () => {
    lan.lanListModels.mockResolvedValue([]);
    await mountEditor(seed);
    await rail("chat");
    await click(q('button[title^="Chat settings"]'));
    await advance(10);
    const modal = () => q('[data-modal="chat-settings"]')!;
    await click([...modal().querySelectorAll("button")].find((b) => b.textContent === "API endpoint")!);
    const [addr, key, model] = [...modal().querySelectorAll("input")];
    fireEvent.change(addr, { target: { value: "http://mock.local:9000/v1" } });
    fireEvent.change(key, { target: { value: "sk-typed" } });
    fireEvent.change(model, { target: { value: "gpt-mock" } });
    await settle();
    await click([...modal().querySelectorAll("button")].find((b) => b.textContent === "Save")!);
    expect(JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY)!)).toMatchObject({ backend: "endpoint", endpointUrl: "http://mock.local:9000/v1", apiKey: "sk-typed", endpointModel: "gpt-mock" });
    await click(modal().querySelector('button[title="Close"]'));
    scripted.push(textReply("via endpoint"));
    await send("hi");
    expect(wireCaptures[0].headers.authorization).toBe("Bearer sk-typed");
    expect(assistantText()).toContain("via endpoint");
    expect(lan.lanStreamChat).not.toHaveBeenCalled();
  });

  it("restoring the engine URL makes chat work again (check 13)", async () => {
    lan.lanStreamChat.mockRejectedValueOnce(new LanEngineUnreachableError("http://localhost:3001", new Error("down")));
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    expect(q("[data-chat-error]")).not.toBeNull();
    lan.lanStreamChat.mockResolvedValue(say("back online"));
    await send("again");
    expect(assistantText()).toContain("back online");
    expect(q("[data-chat-error]")).toBeNull();
    void openFile;
  });
});

describe("LAN model load / download indicator", () => {
  type Ev = { stage: string; message: string; progress: number | null };
  const ev = (stage: string, progress: number | null, message = `${stage} message`): Ev => ({ stage, message, progress });
  const reply = (chunks: unknown[]) => ({
    completion: null,
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });
  const sayChunks = (t: string) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];

  // A LAN send that blocks in the "engine is loading" phase until released;
  // `emit` plays engine progress events into the subscription the chat passed.
  function gatedEngine() {
    const gate = deferred<void>();
    let onProgress: ((p: Ev) => void) | undefined;
    lan.lanStreamChat.mockImplementation(async (_u: string, _p: unknown, signal: AbortSignal, cb?: (p: Ev) => void) => {
      onProgress = cb;
      // like the real engine request, a Stop rejects the pending load with an AbortError
      await Promise.race([
        gate.promise,
        new Promise<never>((_, rej) =>
          signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        ),
      ]);
      return reply(sayChunks("model says hi"));
    });
    return {
      emit: async (p: Ev) => {
        await act(async () => onProgress!(p));
      },
      release: async () => {
        gate.resolve();
        await advance(50);
      },
    };
  }
  const row = () => q("[data-chat-engine-progress]");
  const part = (n: string) => q(`[data-chat-engine-progress] [data-engine-progress="${n}"]`);
  const sendOnly = async (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    await settle();
    await click(q("[data-chat-send]"), "send");
    await advance(50);
  };

  it("shows nothing for a send that never reports progress", async () => {
    lan.lanStreamChat.mockResolvedValue(reply(sayChunks("quick")));
    await mountEditor(seed);
    await rail("chat");
    expect(row()).toBeNull();
    await send("hi");
    expect(assistantText()).toContain("quick");
    expect(row()).toBeNull();
  });

  it("shows the stage label and a % bar while the model downloads, updating on every event", async () => {
    const engine = gatedEngine();
    await mountEditor(seed);
    await rail("chat");
    await sendOnly("hi");
    expect(row()).toBeNull(); // nothing yet: the engine has not reported

    await engine.emit(ev("download", 0.25, "Downloading qwen3-27b.gguf"));
    expect(row()).not.toBeNull();
    expect(row()!.getAttribute("data-stage")).toBe("download");
    expect(part("label")!.textContent).toBe("Downloading model…");
    expect(part("message")!.textContent).toBe("Downloading qwen3-27b.gguf");
    expect(part("pct")!.textContent).toBe("25%");
    const bar = part("bar")!;
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.hasAttribute("data-indeterminate")).toBe(false);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("25%");

    await engine.emit(ev("download", 0.5, "Downloading qwen3-27b.gguf"));
    expect(part("pct")!.textContent).toBe("50%");
    expect((part("bar")!.firstElementChild as HTMLElement).style.width).toBe("50%");

    // the stage moves on: label follows
    await engine.emit(ev("quantize", 0.9, "Quantizing"));
    expect(row()!.getAttribute("data-stage")).toBe("quantize");
    expect(part("label")!.textContent).toBe("Preparing model weights…");
    expect(part("pct")!.textContent).toBe("90%");
    await engine.release();
  });

  it("is indeterminate with an elapsed clock when progress is null, and keeps counting across a long download", async () => {
    const engine = gatedEngine();
    await mountEditor(seed);
    await rail("chat");
    await sendOnly("hi");
    await engine.emit(ev("gpu", null, "Requesting a GPU adapter"));
    expect(part("label")!.textContent).toBe("Initializing GPU…");
    expect(part("pct")).toBeNull();
    expect(part("bar")!.hasAttribute("data-indeterminate")).toBe(true);
    expect(part("bar")!.hasAttribute("aria-valuenow")).toBe(false);
    expect(part("elapsed")!.textContent).toBe("0s");

    await advance(5_000);
    expect(part("elapsed")!.textContent).toBe("5s");

    // a ten-minute download: the row is still there, still ticking, and the elapsed
    // clock runs from the FIRST event of the load, not from the latest one
    await engine.emit(ev("download", 0.01));
    await advance(10 * 60_000);
    await engine.emit(ev("download", 0.97));
    expect(row()).not.toBeNull();
    expect(part("pct")!.textContent).toBe("97%");
    expect(part("elapsed")!.textContent).toBe("10m 05s");
    await engine.release();
  });

  it("clears when the reply starts streaming (the ready event too) and ignores late events", async () => {
    const engine = gatedEngine();
    await mountEditor(seed);
    await rail("chat");
    await sendOnly("hi");
    await engine.emit(ev("download", 0.99));
    expect(row()).not.toBeNull();
    await engine.emit(ev("ready", 1, "Model ready"));
    expect(row()).toBeNull(); // "ready" alone removes it (the reply has not even started)
    await engine.emit(ev("prefill", null));
    expect(row()).not.toBeNull(); // still the same run, still waiting on the engine
    await engine.release();
    expect(assistantText()).toContain("model says hi");
    expect(row()).toBeNull(); // the reply streamed
    await engine.emit(ev("download", 0.3)); // a stale event from the long-lived connection
    expect(row()).toBeNull();
  });

  it("goes away when the engine fails, and when the user stops the run", async () => {
    // failure
    lan.lanStreamChat.mockImplementation(async (_u: string, _p: unknown, _s: AbortSignal, cb?: (p: Ev) => void) => {
      cb!(ev("download", 0.4));
      throw new LanEngineUnreachableError("http://localhost:3001", new Error("gone"));
    });
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    expect(q("[data-chat-error]")).not.toBeNull();
    expect(row()).toBeNull();

    // stop mid-download
    const engine = gatedEngine();
    await sendOnly("again");
    await engine.emit(ev("download", 0.1));
    expect(row()).not.toBeNull();
    await click(q("[data-chat-stop]"), "stop");
    await advance(50);
    expect(row()).toBeNull();
    await engine.release();
  });
});

describe("chat settings: local-model install warning + Start download", () => {
  type Ev = { stage: string; message: string; progress: number | null };
  const ev = (stage: string, progress: number | null, message = `${stage} message`): Ev => ({ stage, message, progress });
  const QWEN = "Qwen/Qwen3.5-4B";
  const model = (id: string, label: string, cached: boolean | null) => ({ object: "model", id, label, modalities: ["text"], maxContext: 65536, cached });
  const modal = () => q('[data-modal="chat-settings"]')!;
  const warning = () => modal().querySelector("[data-chat-model-download]");
  const startBtn = () => modal().querySelector<HTMLButtonElement>('button[data-action="start-model-download"]');
  const modalRow = () => modal().querySelector("[data-chat-engine-progress]");
  const part = (n: string) => modal().querySelector(`[data-engine-progress="${n}"]`);
  async function openSettings() {
    await mountEditor(seed);
    await rail("chat");
    await click(q('button[title^="Chat settings"]'));
    await advance(10);
  }

  // The engine preheat, held until released; `emit` plays progress into the modal.
  function gatedPreload() {
    const gate = deferred<void>();
    let onProgress: ((p: Ev) => void) | undefined;
    lan.lanPreloadModel.mockImplementation(async (_u: string, _m: string | undefined, cb: (p: Ev) => void) => {
      onProgress = cb;
      await gate.promise;
    });
    return {
      emit: async (p: Ev) => {
        await act(async () => onProgress!(p));
      },
      finish: async () => {
        gate.resolve();
        await advance(50);
      },
      fail: async (e: Error) => {
        gate.reject(e);
        await advance(50);
      },
    };
  }

  it("warns that the chat installs a local model (with its size) while the selected model is not cached, and offers Start download", async () => {
    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", false), model("google/gemma-4-E2B", "Gemma 4 E2B", true)]);
    lan.lanEngineDefaultModel.mockResolvedValue(QWEN); // "Engine default" → Qwen
    await openSettings();
    const w = warning()!;
    expect(w).not.toBeNull();
    expect(w.textContent).toContain("installs a local model in your browser");
    expect(w.textContent).toContain("about 2.7 GB");
    expect(w.textContent).toContain("Hugging Face");
    expect(startBtn()!.textContent).toBe("Start download (2.7 GB)");
    expect(modalRow()).toBeNull();

    // the warning follows the picker: a cached model has none, an uncached one has its own size
    const sel = modal().querySelector("select")!;
    fireEvent.change(sel, { target: { value: "google/gemma-4-E2B" } });
    await settle();
    expect(warning()).toBeNull();
    expect(startBtn()).toBeNull();
  });

  it("shows no warning or button for a cached default model, an unknown cache state, or an unreachable engine", async () => {
    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", true)]);
    lan.lanEngineDefaultModel.mockResolvedValue(QWEN);
    await openSettings();
    expect(modal().textContent).toContain("Engine reachable — 1 model listed.");
    expect(warning()).toBeNull();
    expect(startBtn()).toBeNull();
    await click(modal().querySelector('button[title="Close"]'));

    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", null)]);
    await click(q('button[title^="Chat settings"]'));
    await advance(10);
    expect(warning()).toBeNull(); // cached: null = the engine could not tell
    await click(modal().querySelector('button[title="Close"]'));

    lan.lanListModels.mockRejectedValue(new LanEngineUnreachableError("http://localhost:3001", new Error("down")));
    await click(q('button[title^="Chat settings"]'));
    await advance(10);
    expect(modal().textContent).toContain("Could not reach the LAN LLM engine");
    expect(warning()).toBeNull();
    expect(startBtn()).toBeNull();
  });

  it("Start download connects through the engine client, shows the progress row while it runs, and clears warning + button when the model is cached", async () => {
    lan.lanListModels.mockResolvedValueOnce([model(QWEN, "Qwen 3.5 4B", false)]);
    lan.lanEngineDefaultModel.mockResolvedValue(QWEN);
    const engine = gatedPreload();
    await openSettings();
    // once loaded, the refreshed listing says cached
    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", true)]);

    await click(startBtn());
    expect(lan.lanPreloadModel).toHaveBeenCalledTimes(1);
    expect(lan.lanPreloadModel.mock.calls[0][0]).toBe(DEFAULT_CHAT_SETTINGS.engineUrl);
    expect(lan.lanPreloadModel.mock.calls[0][1]).toBe(QWEN);
    expect(startBtn()).toBeNull(); // no double start while it runs
    expect(warning()).not.toBeNull(); // the warning stays visible during the download
    expect(modalRow()).toBeNull(); // nothing reported yet…
    expect(modal().textContent).toContain("Starting the download…");

    await engine.emit(ev("download", 0.45, "Downloading GGUF 1/1: 1.20 / 2.67 GB (40 MB/s)"));
    expect(modalRow()!.getAttribute("data-stage")).toBe("download");
    expect(part("label")!.textContent).toBe("Downloading model…");
    expect(part("pct")!.textContent).toBe("45%");
    expect(part("message")!.textContent).toBe("Downloading GGUF 1/1: 1.20 / 2.67 GB (40 MB/s)"); // byte counts straight from the engine

    await engine.emit(ev("pipelines", null, "Building pipelines"));
    expect(part("label")!.textContent).toBe("Compiling GPU pipelines…");
    expect(part("pct")).toBeNull();
    await engine.emit(ev("ready", 1, "Qwen 3.5 4B ready."));
    expect(modalRow()).toBeNull(); // "ready" clears the indicator

    await engine.finish();
    expect(lan.lanListModels).toHaveBeenCalledTimes(2); // the listing was refreshed…
    expect(warning()).toBeNull(); // …the cached flag flipped: warning + button are gone
    expect(startBtn()).toBeNull();
    expect(modalRow()).toBeNull();
    expect([...modal().querySelector("select")!.options].map((o) => o.textContent)).toContain("Qwen 3.5 4B — Qwen/Qwen3.5-4B (cached)");
  });

  it("preheats the model picked in the dropdown, not the engine default", async () => {
    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", true), model("google/gemma-4-E4B", "Gemma 4 E4B", false)]);
    lan.lanEngineDefaultModel.mockResolvedValue(QWEN);
    gatedPreload();
    await openSettings();
    expect(warning()).toBeNull();
    fireEvent.change(modal().querySelector("select")!, { target: { value: "google/gemma-4-E4B" } });
    await settle();
    expect(warning()!.textContent).toContain("about 5.6 GB");
    await click(startBtn());
    expect(lan.lanPreloadModel.mock.calls[0][1]).toBe("google/gemma-4-E4B");
  });

  it("an unreachable engine during the download shows the graceful engine message and brings the button back", async () => {
    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", false)]);
    lan.lanEngineDefaultModel.mockResolvedValue(QWEN);
    const engine = gatedPreload();
    await openSettings();
    await click(startBtn());
    await engine.emit(ev("download", 0.2));
    expect(modalRow()).not.toBeNull();
    await engine.fail(new LanEngineUnreachableError("http://localhost:3001", new Error("Timed out")));
    const err = modal().querySelector("[data-chat-model-download-error]")!;
    expect(err.textContent).toContain("Could not reach the LAN LLM engine at http://localhost:3001");
    expect(err.textContent).not.toContain("Timed out connecting");
    expect(modalRow()).toBeNull(); // the indicator is gone
    expect(warning()).not.toBeNull(); // still not installed
    expect(startBtn()).not.toBeNull(); // retry
    expect(lan.lanListModels).toHaveBeenCalledTimes(1); // no refresh on failure
  });

  it("any other engine failure (e.g. no WebGPU) is shown the same way and a retry clears it", async () => {
    lan.lanListModels.mockResolvedValue([model(QWEN, "Qwen 3.5 4B", false)]);
    lan.lanEngineDefaultModel.mockResolvedValue(QWEN);
    lan.lanPreloadModel.mockRejectedValueOnce(new Error("WebGPU is not available in this browser"));
    await openSettings();
    await click(startBtn());
    await advance(10);
    expect(modal().querySelector("[data-chat-model-download-error]")!.textContent).toContain("WebGPU is not available");
    lan.lanPreloadModel.mockImplementation(() => new Promise(() => {})); // second try hangs
    await click(startBtn());
    expect(modal().querySelector("[data-chat-model-download-error]")).toBeNull();
    expect(modal().textContent).toContain("Starting the download…");
  });
});

// Regression: turn 2 of a conversation failed on the LAN engine with 'the last
// message must have role "user" or "tool"' because the thread was mapped to the
// wire as [user, user, assistant]. Every request in this file is validated by
// the strict engine fake (tests/support/fake-engine.ts), these pin the shapes.
describe("multi-turn conversations against a validating engine", () => {
  const stream = (chunks: unknown[]) => ({ completion: null, controller: new AbortController(), async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } });
  const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
  const wireOf = (i: number) => (lan.lanStreamChat.mock.calls[i][1].messages as { role: string; content: string }[]).map((m) => [m.role, m.content] as const).slice(1); // minus the system prompt

  it("LAN, reasoning + text reply then a second user message: the request ends with the user message, in thread order", async () => {
    const replies = [
      [delta({ reasoning_content: "The user greets me." }), delta({ content: "Hello! How can I assist you with your thesis today?" }), delta({}, "stop")],
      [delta({ reasoning_content: "Small talk." }), delta({ content: "Doing well, thanks." }), delta({}, "stop")],
      [delta({ content: "Third." }), delta({}, "stop")],
    ];
    lan.lanStreamChat.mockImplementation(async () => stream(replies.shift()!));
    await mountEditor(seed);
    await rail("chat");
    await send("Hi");
    await send("how are you?");
    expect(q("[data-chat-error]")).toBeNull();
    expect(assistantText()).toContain("Doing well, thanks.");
    expect(wireOf(1)).toEqual([["user", "Hi"], ["assistant", "Hello! How can I assist you with your thesis today?"], ["user", "how are you?"]]); // reasoning never goes back
    await send("and now?");
    expect(q("[data-chat-error]")).toBeNull();
    expect(wireOf(2).map(([r]) => r)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("endpoint backend: the same two-turn conversation", async () => {
    applySettings(endpointSettings());
    scripted.push(textReply("first answer"), textReply("second answer"));
    await mountEditor(seed);
    await rail("chat");
    await send("one");
    await send("two");
    expect(q("[data-chat-error]")).toBeNull();
    expect(bodyOf(1).messages.slice(1)).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "two" },
    ]);
  });

  it("a tool turn followed by a second user message keeps assistant(tool_calls) → tool → assistant → user in order", async () => {
    applySettings(endpointSettings());
    scripted.push(toolReply("c1", "list_files", {}), textReply("You have two files."), textReply("Sure."));
    await mountEditor(seed);
    await rail("chat");
    await send("what files?");
    await send("thanks");
    expect(q("[data-chat-error]")).toBeNull();
    const last = bodyOf(2).messages.slice(1) as { role: string; content: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    expect(last.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(last[1].tool_calls![0].id).toBe("c1");
    expect(last[2].tool_call_id).toBe("c1");
    expect(last[3].content).toBe("You have two files.");
    expect(last[4].content).toBe("thanks");
  });
});

describe("LAN request-shape errors", () => {
  it("an engine validation error is shown without pointing at the engine connection (the engine is reachable)", async () => {
    lan.lanStreamChat.mockRejectedValue(new Error('the last message must have role "user" or "tool"'));
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    const box = q("[data-chat-error]")!;
    expect(box.textContent).toContain('the last message must have role "user" or "tool"');
    expect(box.textContent).not.toContain("Open chat settings");
    expect(box.textContent).not.toContain("engine connection");
  });

  it("other engine failures keep the settings link", async () => {
    lan.lanStreamChat.mockRejectedValue(new Error("WebGPU is not available"));
    await mountEditor(seed);
    await rail("chat");
    await send("hi");
    expect(q("[data-chat-error]")!.textContent).toContain("Open chat settings");
  });
});
