import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWorker, settle } from "../support/fake-worker";

const storeState = {
  names: ["pgf", "tikz"] as string[] | Error,
  files: [{ path: "/texlive/texmf-dist/tex/latex/pgf/pgf.sty", contents: "x" }] as {
    path: string;
    contents: string | Uint8Array;
  }[],
  storeFilesCalls: 0,
};

vi.mock("@/lib/ctan-store", () => ({
  remotePackageNames: vi.fn(async () => {
    if (storeState.names instanceof Error) throw storeState.names;
    return storeState.names;
  }),
  storeFiles: vi.fn(async () => {
    storeState.storeFilesCalls++;
    return storeState.files;
  }),
}));

import { BusyTexCompiler, contentHash } from "@/lib/busytex";
import { RELEASE_ID } from "@/lib/texlive-release";

beforeEach(() => {
  FakeWorker.reset();
  storeState.names = ["pgf", "tikz"];
  storeState.storeFilesCalls = 0;
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const pdfMsg = (extra: Record<string, unknown> = {}) => ({
  pdf: new Uint8Array([37, 80, 68, 70]),
  log: "ok",
  synctex: new Uint8Array([1]),
  ...extra,
});

describe("worker start", () => {
  it("posts the init message with release-stamped same-origin assets and the installed package names", async () => {
    const c = new BusyTexCompiler();
    await c.init();
    const w = FakeWorker.last;
    expect(w.url).toMatch(/^\/busytex\/busytex_worker\.js\?v=\d+$/);
    const init = w.posted[0] as Record<string, unknown>;
    expect(init.busytex_wasm).toBe(`/api/texlive/busytex.wasm?v=${RELEASE_ID}`);
    expect(init.busytex_js).toBe(`/api/texlive/busytex.js?v=${RELEASE_ID}`);
    expect(init.biber_data).toBe(`/api/texlive/biber.data?v=${RELEASE_ID}`);
    // basic preloaded, the other two catalogued only
    expect(init.preload_data_packages_js).toEqual([`/api/texlive/texlive-basic.js?v=${RELEASE_ID}`]);
    expect(init.data_packages_js).toHaveLength(3);
    expect(init.remote_packages).toEqual(["pgf", "tikz"]);
    expect(init.preload).toBe(true);
    // every asset is same-origin (importScripts requires it)
    for (const k of ["busytex_js", "busytex_wasm", "biber_js", "biber_wasm", "biber_data"]) {
      expect(String(init[k]).startsWith("/api/texlive/")).toBe(true);
    }
  });

  it("is idempotent while a worker is alive and while an init is in flight (one worker only)", async () => {
    const c = new BusyTexCompiler();
    await Promise.all([c.init(), c.init(), c.init()]);
    await c.init();
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("falls back to an empty package list when the store cannot be read", async () => {
    storeState.names = new Error("opfs down");
    await new BusyTexCompiler().init();
    expect((FakeWorker.last.posted[0] as { remote_packages: string[] }).remote_packages).toEqual([]);
  });

  it("a dispose() during the in-flight init cancels the start (no orphan worker)", async () => {
    const c = new BusyTexCompiler();
    const p = c.init();
    c.dispose();
    await p;
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("forwards ready, loaded and print messages", async () => {
    const logs: string[] = [];
    const ready = vi.fn();
    const c = new BusyTexCompiler();
    await c.init((l) => logs.push(l), ready);
    FakeWorker.last.emit({ ready: true });
    expect(ready).not.toHaveBeenCalled();
    FakeWorker.last.emit({ loaded: true });
    expect(ready).toHaveBeenCalledTimes(1);
    FakeWorker.last.emit({ print: "Downloading data..." });
    expect(logs).toEqual(["Downloading data..."]);
  });
});

describe("compile", () => {
  it("sends project files, their ancestor directories first, and the engine settings", async () => {
    const c = new BusyTexCompiler();
    const p = c.compile(
      { "main.tex": "x", "paper/figs/logo.png": new Uint8Array([1, 2]), "a/b.tex": "y" },
      "main.tex",
      { "refs.bib": "h" },
    );
    await settle();
    const w = FakeWorker.last;
    const msg = w.posted[1] as {
      files: { path: string; contents: unknown }[];
      main_tex_path: string;
      [k: string]: unknown;
    };
    const paths = msg.files.map((f) => f.path);
    // directories (contents null) precede everything, parents before children
    const dirEntries = msg.files.filter((f) => f.contents === null).map((f) => f.path);
    expect(dirEntries.sort()).toEqual(["a", "paper", "paper/figs"]);
    expect(paths.slice(0, 3).every((p) => dirEntries.includes(p))).toBe(true);
    expect(msg.main_tex_path).toBe("main.tex");
    expect(msg.bib_hashes).toEqual({ "refs.bib": "h" });
    expect(msg.driver).toBe("xetex_bibtex8_dvipdfmx");
    expect(msg.data_packages_js).toBeNull(); // null, NOT undefined: avoids the 540 MB fallback
    expect(msg.remote_endpoint).toBe("");
    expect(msg.shell_escape).toBe(false);
    expect(msg.bibtex).toBeNull();
    w.emit(pdfMsg());
    await p;
  });

  it("returns a copied PDF, the log, synctex and the next build state", async () => {
    const c = new BusyTexCompiler();
    const p = c.compile({ "main.tex": "x" }, "main.tex");
    await settle();
    const aux = new Uint8Array([9]);
    FakeWorker.last.emit(
      pdfMsg({
        build_state: { aux, bcf: null, bbl: new Uint8Array([3]), bib_hashes: { "refs.bib": "abc" } },
      }),
    );
    const res = await p;
    expect(Array.from(res.pdf!)).toEqual([37, 80, 68, 70]);
    expect(res.log).toBe("ok");
    expect(Array.from(res.synctex!)).toEqual([1]);
    expect(res.buildState).toMatchObject({ bcf: null, bibHashes: { "refs.bib": "abc" } });
    expect(Array.from(res.buildState!.aux!)).toEqual([9]);
    expect(res.buildState!.aux).not.toBe(aux); // copied out of the worker
  });

  it("a failed build carries no pdf and no state (a half-written state must not seed the next build)", async () => {
    const c = new BusyTexCompiler();
    const p = c.compile({ "main.tex": "x" }, "main.tex");
    await settle();
    FakeWorker.last.emit({ pdf: null, log: "! Undefined control sequence", synctex: null, build_state: null });
    expect(await p).toEqual({ pdf: null, log: "! Undefined control sequence", synctex: null, buildState: null });
  });

  it("sends the installed package files once per worker session", async () => {
    const c = new BusyTexCompiler();
    const run = async () => {
      const p = c.compile({ "main.tex": "x" }, "main.tex");
      await settle();
      const w = FakeWorker.last;
      const posted = w.posted[w.posted.length - 1] as { files: { path: string }[] };
      w.emit(pdfMsg());
      await p;
      return posted.files.map((f) => f.path);
    };
    expect(await run()).toContain("/texlive/texmf-dist/tex/latex/pgf/pgf.sty");
    expect(await run()).not.toContain("/texlive/texmf-dist/tex/latex/pgf/pgf.sty");
    expect(storeState.storeFilesCalls).toBe(1);
    // absolute engine paths create no directory entries
    c.dispose();
    const p = c.compile({ "main.tex": "x" }, "main.tex");
    await settle();
    const msg = FakeWorker.last.posted[1] as { files: { path: string; contents: unknown }[] };
    expect(msg.files.filter((f) => f.contents === null)).toEqual([]);
    FakeWorker.last.emit(pdfMsg());
    await p;
  });
});

describe("failed-engine recovery (e2e fixes #2/#3)", () => {
  it("a worker-reported error mid-compile settles the compile with the message and disposes the worker", async () => {
    const c = new BusyTexCompiler();
    const p = c.compile({ "main.tex": "x" }, "main.tex");
    await settle();
    const first = FakeWorker.last;
    first.emit({ error: "texlive-basic.data failed to load" });
    expect(await p).toMatchObject({ pdf: null, log: "texlive-basic.data failed to load", buildState: null });
    expect(first.terminated).toBe(true);

    // The next compile recreates the worker and re-sends the store files.
    const p2 = c.compile({ "main.tex": "x" }, "main.tex");
    await settle();
    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.last;
    expect(second).not.toBe(first);
    expect((second.posted[1] as { files: { path: string }[] }).files.some((f) => f.path.startsWith("/texlive/"))).toBe(true);
    second.emit(pdfMsg());
    expect((await p2).pdf).not.toBeNull();
  });

  it("an error outside a compile disposes the worker and reaches onError", async () => {
    const onError = vi.fn();
    const c = new BusyTexCompiler();
    await c.init(undefined, undefined, onError);
    const w = FakeWorker.last;
    w.emit({ error: "asset load failed" });
    expect(onError).toHaveBeenCalledWith("asset load failed");
    expect(w.terminated).toBe(true);
    // and the next init starts a fresh worker
    await c.init();
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("a worker crash (script failed to load) is reported both in and outside a compile", async () => {
    const onError = vi.fn();
    const c = new BusyTexCompiler();
    await c.init(undefined, undefined, onError);
    FakeWorker.last.crash("boom");
    expect(onError).toHaveBeenCalledWith("worker crashed: boom");

    const p = c.compile({ "main.tex": "x" }, "main.tex");
    await settle();
    FakeWorker.last.crash();
    expect(await p).toMatchObject({ pdf: null, log: "worker crashed" });
  });
});

describe("contentHash (build-cache key)", () => {
  it("is a stable sha256 hex, independent of key order and of string vs bytes", async () => {
    const a = await contentHash({ "a.tex": "hello", "b.bib": "x" });
    const b = await contentHash({ "b.bib": new TextEncoder().encode("x"), "a.tex": "hello" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes with content, with paths, and with the main path marker", async () => {
    const base = await contentHash({ "a.tex": "hello" });
    expect(await contentHash({ "a.tex": "hellO" })).not.toBe(base);
    expect(await contentHash({ "b.tex": "hello" })).not.toBe(base);
    expect(await contentHash({ "a.tex": "hello", "\u0000main": "a.tex" })).not.toBe(base);
  });

  it("length-prefixing keeps (path, contents) boundaries unambiguous", async () => {
    expect(await contentHash({ a: "b\u00001\u0000c" })).not.toBe(await contentHash({ a: "b", c: "" }));
    expect(await contentHash({ ab: "c" })).not.toBe(await contentHash({ a: "bc" }));
  });
});
