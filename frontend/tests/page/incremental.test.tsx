// Incremental builds: the OPFS build cache and the persisted build state that
// seeds the next pipeline run (e2e: incremental.cjs S1-S3, babel-pt.cjs, package changes).
import { describe, expect, it } from "vitest";
import type { CompileResult } from "@/lib/busytex";
import { loadBuildCache, loadBuildState } from "@/lib/opfs";
import { FakeBusyTex, fakePdfFor, type CompileCall } from "../support/fake-busytex";
import { click, compileButton, openFile, typeInEditor } from "../support/page-actions";
import { act, advance, mountEditor, railActive, settle, statusText } from "../support/page-utils";
import { existsPath, listDir } from "../support/memfs";
import { pdfState } from "../support/stubs/pdf-viewer";
import { packagesModalState } from "../support/stubs/packages-modal";
import { ctan } from "../support/stubs/ctan";

const bytes = (...n: number[]) => new Uint8Array(n);
const main = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\bibliography{refs}\n\\end{document}\n`;
const refs = (year: string) => `@book{k, title={The TeXbook}, year={${year}}}`;

/** A fake pipeline: emits aux/bcf/bbl + the .bib hashes like the real one. */
function pipeline(kind: "biber" | "bibtex8") {
  return (call: CompileCall): CompileResult => ({
    pdf: fakePdfFor(call),
    log: `build ${FakeBusyTex.calls.length}`,
    synctex: bytes(7),
    buildState: {
      aux: bytes(1),
      bcf: kind === "biber" ? bytes(2) : null,
      bbl: bytes(3),
      bibHashes: { "refs.bib": `hash:${String(call.files["refs.bib"])}` },
    },
  });
}

const seed = { name: "bib", mainPath: "main.tex", files: { "main.tex": main("x"), "refs.bib": refs("1984") } };

describe("build state persistence and seeding (S1/S2)", () => {
  it("build 1 has no seed and persists aux/bcf/bbl + .bib hashes + a cache entry", async () => {
    FakeBusyTex.handler = pipeline("biber");
    const { id } = await mountEditor(seed);
    await advance(10);
    expect(FakeBusyTex.calls[0].bibHashes).toBeNull();
    expect(Object.keys(FakeBusyTex.calls[0].files).sort()).toEqual(["main.tex", "refs.bib"]); // nothing injected
    const st = (await loadBuildState(id!, "main.tex"))!;
    expect(Array.from(st.aux!)).toEqual([1]);
    expect(Array.from(st.bcf!)).toEqual([2]);
    expect(Array.from(st.bbl!)).toEqual([3]);
    expect(st.bibHashes).toEqual({ "refs.bib": `hash:${refs("1984")}` });
    const cacheFiles = listDir(`artifacts/${id}/build/cache`);
    expect(cacheFiles.filter((f) => f.endsWith(".pdf"))).toHaveLength(1);
    expect(cacheFiles).toContain("index.json");
  });

  it("build 2 (an edit that leaves the .bib alone) injects the old .aux/.bcf/.bbl and the old hashes so the pipeline can skip biber", async () => {
    FakeBusyTex.handler = pipeline("biber");
    await mountEditor(seed);
    await advance(10);
    await typeInEditor(main("x plus a harmless trailing paragraph"));
    await click(compileButton());
    await advance(10);
    const call = FakeBusyTex.calls[1];
    expect(Array.from(call.files["main.aux"] as Uint8Array)).toEqual([1]);
    expect(Array.from(call.files["main.bcf"] as Uint8Array)).toEqual([2]);
    expect(Array.from(call.files["main.bbl"] as Uint8Array)).toEqual([3]);
    expect(call.bibHashes).toEqual({ "refs.bib": `hash:${refs("1984")}` });
    // the PDF is the up-to-date one (the new paragraph)
    expect(pdfState.text()).toContain("harmless trailing paragraph");
  });

  it("the bibtex8 path: no .bcf in the state, so none is injected", async () => {
    FakeBusyTex.handler = pipeline("bibtex8");
    await mountEditor(seed);
    await advance(10);
    await typeInEditor(main("y"));
    await click(compileButton());
    await advance(10);
    const files = FakeBusyTex.calls[1].files;
    expect(files["main.bcf"]).toBeUndefined();
    expect(files["main.aux"]).toBeDefined();
    expect(files["main.bbl"]).toBeDefined();
  });

  it("an edited .bib is passed with the PREVIOUS hashes, so the pipeline detects the change and re-runs the bibliography (S1 build 4)", async () => {
    FakeBusyTex.handler = pipeline("biber");
    await mountEditor(seed);
    await advance(10);
    await openFile("refs.bib");
    await typeInEditor(refs("1985"));
    await click(compileButton());
    await advance(10);
    const call = FakeBusyTex.calls[1];
    expect(String(call.files["refs.bib"])).toContain("1985");
    expect(call.bibHashes).toEqual({ "refs.bib": `hash:${refs("1984")}` }); // the pipeline compares these with the new sha256
    expect(pdfState.text()).toContain("%PDF-FAKE main.tex");
  });
});

describe("whole-build cache (S1 build 3, part A)", () => {
  it("an unchanged recompile is answered from the cache: the engine is not run and the cached PDF is shown", async () => {
    FakeBusyTex.handler = pipeline("biber");
    const { id } = await mountEditor(seed);
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(1);
    const pdfBefore = pdfState.text();
    await click(compileButton());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(1); // cache hit
    expect(statusText()).toMatch(/^Compiled in \d+ ms$/);
    expect(pdfState.text()).toBe(pdfBefore);
    expect((await loadBuildCache(id!, await hashOf(seed.files, "main.tex")))!.log).toBe("build 1");
  });

  it("holds one entry per distinct input set (edit → new entry, revert → hit the old one)", async () => {
    FakeBusyTex.handler = pipeline("biber");
    const { id } = await mountEditor(seed);
    await advance(10);
    await typeInEditor(main("second"));
    await click(compileButton());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(2);
    expect(listDir(`artifacts/${id}/build/cache`).filter((f) => f.endsWith(".pdf"))).toHaveLength(2);
    await typeInEditor(main("x")); // back to the original inputs
    await click(compileButton());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(2); // answered by the first entry
  });

  it("the cache survives a page reload", async () => {
    FakeBusyTex.handler = pipeline("biber");
    const first = await mountEditor(seed);
    await advance(10);
    first.unmount();
    FakeBusyTex.reset();
    FakeBusyTex.handler = pipeline("biber");
    await mountEditor();
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(0); // the open-time compile hit the persisted cache
    expect(statusText()).toMatch(/^Compiled in/);
  });

  it("a failed build persists nothing: it neither seeds the next build nor evicts the cache (S3)", async () => {
    let fail = false;
    FakeBusyTex.handler = (call) => (fail ? { pdf: null, log: "! LaTeX Error", synctex: null, buildState: null } : pipeline("biber")(call));
    const { id } = await mountEditor(seed);
    await advance(10);
    const stateBefore = await loadBuildState(id!, "main.tex");
    const goodPdf = pdfState.text();
    fail = true;
    await typeInEditor(main("\\broken"));
    await click(compileButton());
    await advance(10);
    expect(statusText()).toBe("Compilation failed — see log");
    expect(railActive()).toEqual(["log"]);
    expect(pdfState.text()).toBe(goodPdf);
    expect(await loadBuildState(id!, "main.tex")).toEqual(stateBefore);
    expect(listDir(`artifacts/${id}/build/cache`).filter((f) => f.endsWith(".pdf"))).toHaveLength(1);
  });

  it("the old PDF stays on screen while the next build runs (S3)", async () => {
    let n = 0;
    let release!: (r: CompileResult) => void;
    FakeBusyTex.handler = (call) => {
      n++;
      if (n === 1) return pipeline("biber")(call);
      return new Promise<CompileResult>((res) => {
        release = res;
      });
    };
    await mountEditor(seed);
    await advance(10);
    const old = pdfState.text();
    await typeInEditor(main("new"));
    await click(compileButton());
    await advance(10);
    expect(statusText()).toMatch(/^Compiling/);
    expect(pdfState.text()).toBe(old); // shown while the build runs
    await act(async () => release(pipeline("biber")(FakeBusyTex.calls[1])));
    await settle();
    expect(pdfState.text()).toContain("new");
  });

  it("a package-store change restarts the engine and clears the cache (but keeps the build state)", async () => {
    FakeBusyTex.handler = pipeline("biber");
    const { id } = await mountEditor(seed);
    await advance(10);
    await click(document.querySelector('[data-action="packages"]'));
    act(() => packagesModalState.props!.onChanged("Installed tikz"));
    await settle();
    expect(document.querySelector("[data-notice]")!.textContent).toBe("Installed tikz — the engine restarts with the next compile");
    expect(FakeBusyTex.instances[0].disposed).toBe(true);
    expect(existsPath(`artifacts/${id}/build/cache`)).toBe(false);
    expect(await loadBuildState(id!, "main.tex")).not.toBeNull();
    await click(compileButton());
    await advance(10);
    expect(FakeBusyTex.calls).toHaveLength(2); // no stale cache hit after the store changed
  });
});

describe("babel language auto-fix (e2e babel-pt.cjs)", () => {
  const ptDoc = "\\documentclass{article}\n\\usepackage[portuguese]{babel}\n\\begin{document}\nOlá\n\\end{document}\n";
  const unknown = "! Package babel Error: Unknown option 'portuguese'.";

  it("installs the tlpkg that ships the .ldf, restarts the engine and recompiles to success", async () => {
    ctan.packageForFile.mockResolvedValue("babel-portuges");
    let installed = false;
    ctan.installWithDependencies.mockImplementation(async (name: string) => {
      installed = true;
      return { package: { name }, installedDependencies: [], unresolved: [] };
    });
    FakeBusyTex.handler = (call) => (installed ? { pdf: fakePdfFor(call), log: "ok Figura", synctex: null, buildState: null } : { pdf: null, log: unknown, synctex: null, buildState: null });
    await mountEditor({ name: "pt", mainPath: "main.tex", files: { "main.tex": ptDoc } });
    await advance(1); // the failed first build
    expect(ctan.packageForFile).toHaveBeenCalledWith("portuguese.ldf");
    expect(ctan.installWithDependencies).toHaveBeenCalledWith("babel-portuges");
    await advance(10);
    expect(FakeBusyTex.instances[0].disposed).toBe(true); // restarted so the new .ldf is visible
    expect(FakeBusyTex.calls).toHaveLength(2); // the queued recompile ran
    expect(statusText()).toMatch(/^Compiled in/);
    expect(pdfState.text()).toContain("Olá");
  });

  it("shows the 'installing …' status line while it works", async () => {
    ctan.packageForFile.mockResolvedValue("babel-portuges");
    let finish!: () => void;
    ctan.installWithDependencies.mockImplementation(
      (name: string) =>
        new Promise((res) => {
          finish = () => res({ package: { name }, installedDependencies: [], unresolved: [] });
        }),
    );
    FakeBusyTex.handler = () => ({ pdf: null, log: unknown, synctex: null, buildState: null });
    await mountEditor({ name: "pt", mainPath: "main.tex", files: { "main.tex": ptDoc } });
    await advance(1);
    expect(statusText()).toBe("Compiling… installing babel-portuges (language “portuguese”)…");
    await act(async () => finish());
    await advance(10);
  });

  it("tries each language once: a language that stays broken does not loop", async () => {
    ctan.packageForFile.mockResolvedValue("babel-portuges");
    FakeBusyTex.handler = () => ({ pdf: null, log: unknown, synctex: null, buildState: null });
    await mountEditor({ name: "pt", mainPath: "main.tex", files: { "main.tex": ptDoc } });
    await advance(200);
    expect(FakeBusyTex.calls).toHaveLength(2); // original + the one retry
    expect(ctan.installWithDependencies).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("Compilation failed — see log");
  });

  it("does nothing when no tlpkg ships the language file, or when the install fails", async () => {
    FakeBusyTex.handler = () => ({ pdf: null, log: unknown, synctex: null, buildState: null });
    await mountEditor({ name: "pt", mainPath: "main.tex", files: { "main.tex": ptDoc } });
    await advance(50);
    expect(ctan.installWithDependencies).not.toHaveBeenCalled();
    expect(statusText()).toBe("Compilation failed — see log");
    expect(FakeBusyTex.calls).toHaveLength(1);
  });

  it("an install that throws neither restarts the engine nor loops", async () => {
    ctan.packageForFile.mockResolvedValue("babel-portuges");
    ctan.installWithDependencies.mockRejectedValue(new Error("offline"));
    FakeBusyTex.handler = () => ({ pdf: null, log: unknown, synctex: null, buildState: null });
    await mountEditor({ name: "pt", mainPath: "main.tex", files: { "main.tex": ptDoc } });
    await advance(50);
    // No recompile loop, no engine restart: the failed install changes nothing.
    expect(ctan.installWithDependencies).toHaveBeenCalledTimes(1);
    expect(FakeBusyTex.calls).toHaveLength(1);
    expect(FakeBusyTex.instances[0].disposed).toBe(false);
  });
});

async function hashOf(files: Record<string, string>, mainPath: string): Promise<string> {
  const { contentHash } = await import("@/lib/busytex");
  return contentHash({ ...files, "\u0000main": mainPath });
}
