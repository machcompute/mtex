// The first-run default package sweep as the editor shows it (e2e: defaults.cjs).
// The sweep itself (18 containers, marker, no resurrection) is unit-tested in
// tests/lib/ctan-store.test.ts; here: progress bar, completion notice, restart.
import { beforeEach, describe, expect, it } from "vitest";
import type { CompileResult } from "@/lib/busytex";
import { FakeBusyTex } from "../support/fake-busytex";
import { q } from "../support/page-actions";
import { act, advance, deferred, mountEditor, noticeText, settle, statusText } from "../support/page-utils";
import { ctan } from "../support/stubs/ctan";

beforeEach(() => {
  FakeBusyTex.autoReady = false;
  window.history.replaceState({}, "", "/editor");
});

const seed = { name: "t", mainPath: "", files: { "refs.bib": "x" } }; // nothing to compile

describe("default package sweep", () => {
  it("starts on mount and shows the install progress bar in the status slot", async () => {
    const d = deferred<string[]>();
    let report!: (n: string, done: number, total: number) => void;
    ctan.ensureDefaults.mockImplementation((p) => {
      report = p!;
      return d.promise;
    });
    await mountEditor(seed);
    expect(ctan.ensureDefaults).toHaveBeenCalledTimes(1);
    act(() => report("fontspec", 2, 18));
    await settle();
    const bar = q('header span[title^="Installing"]')!;
    expect(bar.getAttribute("title")).toBe("Installing default packages 3/18…");
    expect(document.body.textContent).toContain("11%"); // 2/18
    act(() => report("xcolor", 17, 18));
    await settle();
    expect(document.body.textContent).toContain("94%");
    await act(async () => d.resolve([]));
  });

  it("on completion: notice, engine restart for the next compile, and the install line hands back to Ready", async () => {
    const d = deferred<string[]>();
    let report!: (n: string, done: number, total: number) => void;
    ctan.ensureDefaults.mockImplementation((p) => {
      report = p!;
      return d.promise;
    });
    await mountEditor(seed);
    act(() => report("fontspec", 0, 18));
    await settle();
    expect(statusText()).toBe("");
    await act(async () => d.resolve(Array.from({ length: 18 }, (_, i) => `p${i}`)));
    await settle();
    expect(noticeText()).toBe("Installed 18 default LaTeX packages — the engine restarts with the next compile");
    expect(FakeBusyTex.instances[0].disposed).toBe(true);
    expect(statusText()).toBe("Ready.");
  });

  it("nothing installed (store already seeded): no notice, no restart", async () => {
    ctan.ensureDefaults.mockResolvedValue([]);
    await mountEditor(seed);
    await advance(10);
    expect(noticeText()).toBe("");
    expect(FakeBusyTex.instances[0].disposed).toBe(false);
  });

  it("a failed sweep (network blip) is swallowed: the app carries on and the next load retries", async () => {
    ctan.ensureDefaults.mockRejectedValue(new Error("offline"));
    await mountEditor(seed);
    await advance(10);
    expect(noticeText()).toBe("");
    expect(statusText()).toBe("Ready.");
  });

  it("?noDefaults=1 skips the sweep entirely (the clean-store switch)", async () => {
    window.history.replaceState({}, "", "/editor?noDefaults=1");
    await mountEditor(seed);
    expect(ctan.ensureDefaults).not.toHaveBeenCalled();
  });

  it("an active compile keeps its own status line and a visible error is not replaced by install progress", async () => {
    FakeBusyTex.autoReady = true;
    const slow = deferred<CompileResult>();
    FakeBusyTex.handler = () => slow.promise;
    let report!: (n: string, done: number, total: number) => void;
    ctan.ensureDefaults.mockImplementation((p) => {
      report = p!;
      return new Promise(() => {});
    });
    await mountEditor({ name: "t", files: { "main.tex": "x" } });
    await advance(10);
    expect(statusText()).toMatch(/^Compiling/);
    act(() => report("fontspec", 0, 18));
    await settle();
    expect(statusText()).toMatch(/^Compiling/);
    await act(async () => slow.resolve({ pdf: null, log: "! error", synctex: null, buildState: null }));
    await settle();
    expect(statusText()).toBe("Compilation failed — see log");
    act(() => report("xcolor", 1, 18));
    await settle();
    expect(statusText()).toBe("Compilation failed — see log"); // the failure stays visible
  });

  it("a restart requested while a build runs is deferred until the build finishes", async () => {
    FakeBusyTex.autoReady = true;
    const slow = deferred<CompileResult>();
    FakeBusyTex.handler = () => slow.promise;
    const sweep = deferred<string[]>();
    ctan.ensureDefaults.mockReturnValue(sweep.promise);
    await mountEditor({ name: "t", files: { "main.tex": "x" } });
    await advance(10);
    await act(async () => sweep.resolve(["fontspec"]));
    await settle();
    expect(FakeBusyTex.instances[0].disposed).toBe(false); // a compile in flight is never torn down
    await act(async () => slow.resolve({ pdf: new Uint8Array([1]), log: "", synctex: null, buildState: null }));
    await settle();
    expect(FakeBusyTex.instances[0].disposed).toBe(true);
  });
});
