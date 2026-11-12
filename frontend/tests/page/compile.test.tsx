// Compile flow, auto-recompile, failure handling and PDF/source sync
// (e2e: regression.cjs, fixes.cjs #2 #3 #6 #7 #8 #9 #14a #16 #17 #20, layout history/stats).
import { describe, expect, it } from "vitest";
import type { CompileResult } from "@/lib/busytex";
import { FakeBusyTex, fakePdfFor, type CompileCall } from "../support/fake-busytex";
import { autoButton, click, compileButton, dividerArrow, gotoPdfButton, q, rail, tab, typeInEditor } from "../support/page-actions";
import {
  act,
  activeTab,
  advance,
  deferred,
  mountEditor,
  openTabs,
  railActive,
  settle,
  statusText,
} from "../support/page-utils";
import { monacoState } from "../support/stubs/monaco";
import { pdfState } from "../support/stubs/pdf-viewer";
import { ABS, glyph, synctexDoc } from "../support/synctex-builder";

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const result = (over: Partial<CompileResult> = {}): CompileResult => ({ pdf: new Uint8Array([37, 80, 68, 70]), log: "ok", synctex: null, buildState: null, ...over });

describe("open-time compile (regression: auto-compiled on open)", () => {
  it("the default project compiles by itself once files and engine are ready", async () => {
    await mountEditor();
    await advance(10);
    expect(statusText()).toMatch(/^Compiled in \d+ ms$/);
    expect(FakeBusyTex.calls).toHaveLength(1);
    expect(Object.keys(FakeBusyTex.calls[0].files).sort()).toEqual(["main.tex", "refs.bib"]);
    expect(pdfState.text()).toContain("%PDF-FAKE main.tex");
    expect(FakeBusyTex.instances).toHaveLength(1);
  });

  it("the log pane shows the build log of the last compile (bibtex output etc.)", async () => {
    FakeBusyTex.handler = async () => result({ log: "This is XeTeX\nbibtex8 main\nThe style file: plain.bst\n(./main.bbl)" });
    await mountEditor();
    await advance(10);
    await rail("log");
    expect(q("pre")!.textContent).toContain("(./main.bbl)");
    expect(q("pre")!.textContent).toContain("bibtex8 main");
  });

  it("a project without a main .tex stays idle: the open-time compile never fires", async () => {
    await mountEditor({ name: "bib only", mainPath: "", files: { "refs.bib": "@book{x}" } });
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(0);
    expect(statusText()).toBe("Ready.");
  });

  it("the engine becoming ready is what releases a waiting open-time compile", async () => {
    FakeBusyTex.autoReady = false;
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    expect(FakeBusyTex.calls).toHaveLength(0);
    act(() => FakeBusyTex.instances[0].emitReady());
    await settle();
    expect(FakeBusyTex.calls).toHaveLength(1);
  });
});

describe("auto recompile (#20, #7)", () => {
  it("recompiles 1.2 s after the last keystroke (debounced), only when the engine is ready", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("v1") } });
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(1);
    await typeInEditor(doc("v2"));
    await advance(600);
    await typeInEditor(doc("v3")); // another keystroke restarts the debounce
    await advance(1100);
    expect(FakeBusyTex.calls).toHaveLength(1);
    await advance(200);
    expect(FakeBusyTex.calls).toHaveLength(2);
    expect(String(FakeBusyTex.calls[1].files["main.tex"])).toContain("v3");
    expect(pdfState.text()).toContain("v3");
  });

  it("no compile fires after turning auto recompile off, even with a pending timer (#20)", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("v1") } });
    await advance(10);
    await typeInEditor(doc("v2"));
    await click(autoButton()); // off — must cancel the pending recompile
    await advance(3000);
    expect(FakeBusyTex.calls).toHaveLength(1);
    expect(autoButton()!.title).toMatch(/Auto recompile: off/);
    // manual recompile still works, with the typed content
    await click(compileButton());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(2);
    expect(String(FakeBusyTex.calls[1].files["main.tex"])).toContain("v2");
  });

  it("an edit during a running build is queued and recompiled afterwards: the final PDF has it (#7)", async () => {
    const first = deferred<CompileResult>();
    let n = 0;
    FakeBusyTex.handler = (call: CompileCall) => {
      n++;
      return n === 1 ? first.promise : result({ pdf: fakePdfFor(call), log: `build ${n}` });
    };
    await mountEditor({ name: "t", files: { "main.tex": doc("MARK-OLD") } });
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(1); // build 1 is in flight
    expect(statusText()).toMatch(/^Compiling/);
    await typeInEditor(doc("MARK-NEW"));
    await advance(1300); // the debounce fires mid-build: queued, not started
    expect(FakeBusyTex.calls).toHaveLength(1);
    await act(async () => first.resolve(result({ pdf: fakePdfFor(FakeBusyTex.calls[0]), log: "build 1" })));
    await advance(10); // the finishing build requeues itself through setTimeout(0)
    expect(FakeBusyTex.calls).toHaveLength(2);
    expect(String(FakeBusyTex.calls[1].files["main.tex"])).toContain("MARK-NEW");
    expect(pdfState.text()).toContain("MARK-NEW");
    expect(statusText()).toMatch(/^Compiled in/);
  });

  it("the Compile button is disabled while a build runs", async () => {
    const d = deferred<CompileResult>();
    FakeBusyTex.handler = () => d.promise;
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    expect(compileButton()!.disabled).toBe(true);
    await act(async () => d.resolve(result()));
    await settle();
    expect(compileButton()!.disabled).toBe(false);
  });

  it("the keyboard command (Ctrl/Cmd+Enter) compiles", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    const cmd = monacoState.commands[0];
    expect(cmd.keybinding).toBe(2048 | 3);
    await typeInEditor(doc("changed")); // unchanged inputs would be answered from the build cache
    act(() => cmd.handler());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(2);
  });
});

describe("status line", () => {
  it("shows the engine's streamed lines while loading, then Ready after the preload", async () => {
    FakeBusyTex.autoReady = false;
    await mountEditor({ name: "t", mainPath: "", files: { "refs.bib": "x" } });
    act(() => FakeBusyTex.instances[0].emitLog("Loading texlive-basic"));
    await settle();
    expect(statusText()).toBe("Loading engine… Loading texlive-basic");
    act(() => FakeBusyTex.instances[0].emitReady());
    await settle();
    expect(statusText()).toBe("Ready.");
  });

  it("a data-download print line becomes a progress bar (determinate with a total), never a log line", async () => {
    FakeBusyTex.autoReady = false;
    await mountEditor({ name: "t", mainPath: "", files: { "refs.bib": "x" } });
    act(() => FakeBusyTex.instances[0].emitLog("Loading texlive-basic"));
    act(() => FakeBusyTex.instances[0].emitLog("Downloading data... (30/120)"));
    await settle();
    const bar = document.querySelector("header [title]") as HTMLElement | null;
    expect(document.body.textContent).toContain("25%");
    expect(bar).not.toBeNull();
    await rail("log");
    expect(q("pre")!.textContent).not.toContain("Downloading data");
  });

  it("a worker/asset failure outside a compile is reported, not left on 'Loading engine…' (#3)", async () => {
    FakeBusyTex.autoReady = false;
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    act(() => FakeBusyTex.instances[0].emitError("texlive-basic.data failed to load"));
    await settle();
    expect(statusText()).toBe("Engine failed to load — see log");
    expect(railActive()).toEqual(["files"]);
  });

  it("the next compile after a failed engine load recreates the worker and succeeds (#2/#3)", async () => {
    FakeBusyTex.autoReady = false;
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    act(() => FakeBusyTex.instances[0].emitError("boom"));
    await settle();
    // the compile button isn't gated on readiness: the compiler re-inits itself
    await click(compileButton());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(1);
    expect(FakeBusyTex.instances[0].initCount).toBeGreaterThanOrEqual(2); // compile() re-inits the dead worker
    expect(statusText()).toMatch(/^Compiled in/);
  });
});

describe("failed builds", () => {
  it("a failed build keeps the previous PDF on screen, flags the status, opens the log pane and records history", async () => {
    let n = 0;
    FakeBusyTex.handler = (call: CompileCall) => {
      n++;
      return n === 1 ? result({ pdf: fakePdfFor(call) }) : result({ pdf: null, log: "! Undefined control sequence." });
    };
    await mountEditor({ name: "t", files: { "main.tex": doc("GOOD") } });
    await advance(10);
    const before = pdfState.text();
    expect(before).toContain("GOOD");
    await typeInEditor(doc("\\broken"));
    await click(compileButton());
    await advance(10);
    expect(statusText()).toBe("Compilation failed — see log");
    expect(railActive()).toEqual(["log"]);
    expect(pdfState.text()).toBe(before); // the previous PDF stays
    expect(q("pre")!.textContent).toContain("Undefined control sequence");
    // an empty PDF counts as a failure too (a zero-length array is truthy)
    FakeBusyTex.handler = () => result({ pdf: new Uint8Array(0), log: "empty" });
    await click(compileButton());
    await advance(10);
    expect(statusText()).toBe("Compilation failed — see log");
  });

  it("an exception from the engine surfaces its message and opens the log", async () => {
    FakeBusyTex.handler = () => {
      throw new Error("worker exploded");
    };
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    expect(statusText()).toBe("worker exploded");
    expect(railActive()).toEqual(["log"]);
  });

  it("each build is recorded in the compile history popover (newest first, ok/failed)", async () => {
    let n = 0;
    FakeBusyTex.handler = () => result({ pdf: ++n === 2 ? null : new Uint8Array([1]) });
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    await typeInEditor(doc("x2")); // a different input set: no cache hit
    await click(compileButton());
    await advance(10);
    await click(document.querySelector('button[title="Compile history"]'));
    const items = [...document.querySelectorAll('[data-popover-root="history"] li')].map((li) => li.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Compilation failed — see log");
    expect(items[1]).toMatch(/^Compiled in \d+ ms/);
    // an outside click closes the popover; Clear empties it
    await click(document.body);
    expect(document.querySelector('[data-popover-root="history"] li')).toBeNull();
    await click(document.querySelector('button[title="Compile history"]'));
    await click(document.querySelector('button[title="Clear the history"]'));
    expect(document.body.textContent).toContain("No compiles yet this session.");
  });

  it("the history is capped at 50 entries", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    for (let i = 0; i < 52; i++) {
      await typeInEditor(doc(`edit ${i}`)); // distinct inputs: every build runs the engine
      await click(compileButton());
      await advance(1);
    }
    expect(FakeBusyTex.calls.length).toBeGreaterThan(52);
    await click(document.querySelector('button[title="Compile history"]'));
    expect(document.querySelectorAll('[data-popover-root="history"] li')).toHaveLength(50);
  });
});

describe("PDF <-> source navigation (#6 #16, synctex)", () => {
  const files = {
    "main.tex": "\\documentclass{article}\n\\begin{document}\nMAIN LINE\n\\input{a/inner}\n\\input{inner}\n\\end{document}\n",
    "a/inner.tex": "line one\nNESTEDMARK\n",
    "inner.tex": "FLATMARK\n",
  };
  const synctex = () =>
    synctexDoc({ 1: `${ABS}main.tex`, 2: `${ABS}a/inner.tex`, 3: `${ABS}inner.tex`, 4: `${ABS}main.bbl` }, [
      glyph(1, 3, 72, 100),
      glyph(2, 2, 72, 150),
      glyph(3, 1, 72, 200),
      glyph(4, 7, 72, 250),
    ]);

  async function openWithSync() {
    FakeBusyTex.handler = (call) => result({ pdf: fakePdfFor(call), synctex: synctex() });
    await mountEditor({ name: "t", mainPath: "main.tex", files });
    await advance(10);
  }
  const clickPdf = async (page: number, x: number, y: number) => {
    await act(async () => pdfState.props!.onPageClick!(page, x, y));
    await settle();
  };

  it("a click on text from a nested \\input opens that file as a tab at its line (#6)", async () => {
    await openWithSync();
    await clickPdf(1, 80, 150);
    expect(activeTab()).toBe("a/inner.tex");
    expect(openTabs()).toContain("a/inner.tex");
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).toBe("line one\nNESTEDMARK\n"); // its own content (#16)
    expect(monacoState.reveals.at(-1)).toBe(2);
    expect(monacoState.selection.startLineNumber).toBe(2); // line selected for a click jump
  });

  it("a flat file is told apart from a same-named nested one (#6)", async () => {
    await openWithSync();
    await clickPdf(1, 80, 200);
    expect(activeTab()).toBe("inner.tex");
    expect(monacoState.reveals.at(-1)).toBe(1);
  });

  it("a click in the already-open file just reveals the line", async () => {
    await openWithSync();
    await clickPdf(1, 80, 100);
    expect(activeTab()).toBe("main.tex");
    expect(monacoState.reveals.at(-1)).toBe(3);
  });

  it("text that came from the .bbl lands on the \\bibliography line of the main file, else line 1", async () => {
    FakeBusyTex.handler = (call) => result({ pdf: fakePdfFor(call), synctex: synctex() });
    await mountEditor({
      name: "t",
      mainPath: "main.tex",
      files: { ...files, "main.tex": "\\documentclass{article}\n\\begin{document}\nx\n\\bibliography{refs}\n\\end{document}\n" },
    });
    await advance(10);
    await clickPdf(1, 80, 250);
    expect(monacoState.reveals.at(-1)).toBe(4);
  });

  it("Go to PDF jumps the viewer to the line under the editor cursor", async () => {
    await openWithSync();
    expect(gotoPdfButton()!.disabled).toBe(false);
    monacoState.selection = new (monacoState.selection.constructor as new (a: number, b: number, c: number, d: number) => typeof monacoState.selection)(3, 1, 3, 1);
    await click(gotoPdfButton());
    const s = pdfState.scrolls.at(-1)!;
    expect(s.page).toBe(1);
    expect(s.y).toBeCloseTo(100, 1);
    expect(s.opts).toEqual({ select: true, instant: false });
  });

  it("Go to PDF is disabled until a synctex map exists", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    expect(gotoPdfButton()!.disabled).toBe(true);
    expect(gotoPdfButton()!.title).toMatch(/Compile first/);
  });

  it("sync scroll: the PDF's viewport top moves the editor quietly; the editor scroll moves the PDF", async () => {
    await openWithSync();
    // PDF → editor (quiet: no flash/selection)
    monacoState.selection = new (monacoState.selection.constructor as new (a: number, b: number, c: number, d: number) => typeof monacoState.selection)(1, 1, 1, 1);
    await act(async () => pdfState.props!.onViewportTop!(1, 98));
    await settle();
    expect(monacoState.reveals.at(-1)).toBe(3);
    expect(monacoState.decorations).toHaveLength(0); // no mint flash on a follow
    // the lock stops the echo: an editor scroll right after is ignored
    const scrollsBefore = pdfState.scrolls.length;
    await act(async () => monacoState.scrollListener!({ scrollTopChanged: true }));
    expect(pdfState.scrolls.length).toBe(scrollsBefore);
    // after the lock expires the editor drives the PDF
    await advance(600);
    monacoState.visibleTop = 3;
    await act(async () => monacoState.scrollListener!({ scrollTopChanged: true }));
    expect(pdfState.scrolls.at(-1)).toMatchObject({ page: 1, opts: { select: false, instant: true } });
  });

  it("garbage synctex leaves navigation off instead of throwing", async () => {
    FakeBusyTex.handler = (call) => result({ pdf: fakePdfFor(call), synctex: new Uint8Array([0x1f, 0x8b, 1, 2, 3]) });
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    expect(statusText()).toMatch(/^Compiled in/);
    expect(gotoPdfButton()!.disabled).toBe(true);
  });
});

describe("divider jump arrows (synctex)", () => {
  const files = {
    "main.tex": "\\documentclass{article}\n\\begin{document}\nMAIN LINE\n\\input{a/inner}\n\\input{inner}\n\\end{document}\n",
    "a/inner.tex": "line one\nNESTEDMARK\n",
    "inner.tex": "FLATMARK\n",
  };
  const synctex = () =>
    synctexDoc({ 1: `${ABS}main.tex`, 2: `${ABS}a/inner.tex`, 3: `${ABS}inner.tex`, 4: `${ABS}main.bbl` }, [
      glyph(1, 3, 72, 100),
      glyph(2, 2, 72, 150),
      glyph(3, 1, 72, 200),
      glyph(4, 7, 72, 250),
    ]);

  async function openWithSync() {
    FakeBusyTex.handler = (call) => result({ pdf: fakePdfFor(call), synctex: synctex() });
    await mountEditor({ name: "t", mainPath: "main.tex", files });
    await advance(10);
  }

  it("both arrows are disabled until a synctex map exists", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    expect(dividerArrow("Go to PDF")!.disabled).toBe(true);
    expect(dividerArrow("Go to editor")!.disabled).toBe(true);
  });

  it("both arrows enable after a compile with a synctex map", async () => {
    await openWithSync();
    expect(dividerArrow("Go to PDF")!.disabled).toBe(false);
    expect(dividerArrow("Go to editor")!.disabled).toBe(false);
  });

  it("'Go to PDF' (top arrow) jumps the viewer to the line under the editor cursor", async () => {
    await openWithSync();
    monacoState.selection = new (monacoState.selection.constructor as new (a: number, b: number, c: number, d: number) => typeof monacoState.selection)(3, 1, 3, 1);
    await click(dividerArrow("Go to PDF"));
    const s = pdfState.scrolls.at(-1)!;
    expect(s.page).toBe(1);
    expect(s.y).toBeCloseTo(100, 1);
    expect(s.opts).toEqual({ select: true, instant: false });
  });

  it("'Go to editor' (bottom arrow) jumps the editor to the PDF's current viewport top", async () => {
    await openWithSync();
    pdfState.viewportTop = { page: 1, yTop: 150 };
    await click(dividerArrow("Go to editor"));
    // y=150 on page 1 is a/inner.tex:2 (same mapping as the PDF-click path)
    expect(activeTab()).toBe("a/inner.tex");
    expect(monacoState.reveals.at(-1)).toBe(2);
    expect(monacoState.selection.startLineNumber).toBe(2);
  });
});

describe("scroll restore across recompiles (#17)", () => {
  it("the reader's position survives a recompile: restored once the new PDF's page exists, retried while pdf.js renders", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    pdfState.viewportTop = { page: 2, yTop: 123 };
    pdfState.scrollOk = false; // pdf.js has not rendered the page yet
    pdfState.scrolls = [];
    await click(compileButton());
    await advance(10);
    const first = pdfState.scrolls.filter((s) => s.page === 2 && s.y === 123);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0].opts).toEqual({ select: false, instant: true });
    const tries = first.length;
    await advance(300); // polls every 100 ms
    expect(pdfState.scrolls.filter((s) => s.y === 123).length).toBeGreaterThan(tries);
    pdfState.scrollOk = true;
    await advance(100);
    const settled = pdfState.scrolls.length;
    await advance(1000); // restored: polling stops
    expect(pdfState.scrolls.length).toBe(settled);
  });

  it("gives up after about six seconds", async () => {
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    pdfState.viewportTop = { page: 1, yTop: 5 };
    pdfState.scrollOk = false;
    pdfState.scrolls = [];
    await click(compileButton());
    await advance(7000);
    const n = pdfState.scrolls.filter((s) => s.y === 5).length;
    expect(n).toBeGreaterThanOrEqual(60);
    await advance(2000);
    expect(pdfState.scrolls.filter((s) => s.y === 5).length).toBe(n);
  });

  it("the page badge counts rendered pages and the download name follows the main file", async () => {
    pdfState.pages = 3;
    await mountEditor({ name: "t", files: { "main.tex": doc("x") } });
    await advance(10);
    expect(document.querySelector('[title="3 pages in the current PDF"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pdf"]')!.getAttribute("data-download")).toBe("main.pdf");
  });
});

describe("tab switching leaves the build alone", () => {
  it("switching tabs does not recompile", async () => {
    await mountEditor({ name: "t", openPaths: ["main.tex", "b.tex"], files: { "main.tex": doc("x"), "b.tex": "b" } });
    await advance(10);
    await tab("b.tex");
    await advance(2000);
    expect(FakeBusyTex.calls).toHaveLength(1);
  });
});
