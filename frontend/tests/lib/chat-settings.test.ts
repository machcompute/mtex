// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CHAT_SETTINGS_KEY, DEFAULT_CHAT_SETTINGS, loadChatSettings, saveChatSettings } from "@/lib/chat-settings";
import { CHAT_TOOLS } from "@/lib/chat-tools";

describe("chat settings (e2e chat: settings modal persistence)", () => {
  it("defaults to the LAN engine with empty endpoint fields", () => {
    expect(loadChatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(DEFAULT_CHAT_SETTINGS).toMatchObject({ backend: "lan", model: "", endpointUrl: "", apiKey: "", endpointModel: "" });
  });

  it("round-trips a saved endpoint configuration", () => {
    const s = { ...DEFAULT_CHAT_SETTINGS, backend: "endpoint" as const, endpointUrl: "http://h/v1", apiKey: "k", endpointModel: "m", model: "q" };
    saveChatSettings(s);
    expect(loadChatSettings()).toEqual(s);
  });

  it("migrates the removed 'router' backend to 'endpoint'", () => {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ backend: "router", apiKey: "old" }));
    expect(loadChatSettings().backend).toBe("endpoint");
  });

  it("tolerates corrupt and partial values", () => {
    localStorage.setItem(CHAT_SETTINGS_KEY, "{{{");
    expect(loadChatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify("a string"));
    expect(loadChatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ backend: 5, engineUrl: "   ", model: 3, endpointUrl: null, apiKey: {}, endpointModel: [] }));
    expect(loadChatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it("is SSR-safe and best-effort on write", () => {
    vi.stubGlobal("window", undefined);
    expect(loadChatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(() => saveChatSettings(DEFAULT_CHAT_SETTINGS)).not.toThrow();
    vi.unstubAllGlobals();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => saveChatSettings(DEFAULT_CHAT_SETTINGS)).not.toThrow();
  });
});

describe("chat tool definitions", () => {
  it("expose the seven project tools with their required arguments", () => {
    const byName = Object.fromEntries(CHAT_TOOLS.map((t) => [t.function.name, t.function.parameters as { required?: string[] }]));
    expect(Object.keys(byName)).toEqual([
      "list_files",
      "read_file",
      "compile",
      "get_build_log",
      "apply_edit",
      "install_package",
      "search_packages",
    ]);
    expect(byName.read_file.required).toEqual(["path"]);
    expect(byName.apply_edit.required).toEqual(["path", "old", "new"]);
    expect(byName.install_package.required).toEqual(["name"]);
    expect(byName.search_packages.required).toEqual(["query"]);
    expect(CHAT_TOOLS.every((t) => t.type === "function")).toBe(true);
  });
});
