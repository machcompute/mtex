"use client";

// Wraps the busytex WebAssembly worker (full TeX Live 2026 compiled to
// WASM). The heavy assets (busytex.js/.wasm, the texlive-{basic,
// recommended, extra} data packages, the biber module) are served
// same-origin through /api/texlive — the worker loads some of them with
// importScripts(), which browsers only allow for same-origin URLs, and the
// .wasm needs application/wasm (GitHub serves octet-stream), so the
// browser can't fetch the release directly.
//
// The worker + pipeline in /busytex/ come from the same pinned release as
// the WASM assets (see public/busytex/ for provenance and the pipeline's
// one patch). The pipeline's driver xetex_bibtex8_dvipdfmx runs xelatex,
// auto-runs bibtex8 (or biber) when a .bib is present, auto-runs makeindex
// on a non-empty .idx, and reruns until the log stops asking for it.
//
// Packages: the engine's texlive-basic data package (~93 MB, preloaded)
// covers most \usepackage. Anything else is pulled on demand — the page
// installs it into the server's CTAN package store (POST /api/packages),
// and the engine's kpathsea fetches the file from /api/texlive-remote/ at
// compile time (TEXLIVE_REMOTE_ENDPOINT). So init fetches the installed
// names once (remote_packages) and the pipeline's resolver treats them as
// local packages: without that, an installed package would count as
// unresolved and the pipeline would enable ALL data packages (pulling the
// ~540 MB recommended+extra trees the document does not need). The engine
// caches misses for its whole lifetime, so after installing or removing a
// package the caller must dispose() the compiler — the next compile
// restarts the worker with a fresh miss cache and package list.
//
// Worker protocol (the pinned release's — plain message objects, no
// wrapper):
//   init:    {busytex_js, busytex_wasm, biber_js, biber_wasm, biber_data,
//             data_packages_js, preload_data_packages_js, texmf_local,
//             preload, verbose, remote_packages}
//   compile: {files, main_tex_path, bibtex, biber, makeindex, rerun,
//             verbose, driver, data_packages_js, remote_endpoint,
//             shell_escape}  ->  {pdf, log, synctex, exit_code, logs}
//   events:  {ready}, {loaded}, {print: string}, {error: string}

// Same origin: src/app/api/texlive/[name]/route.ts downloads the pinned
// release assets on first request and serves them from a local disk cache.
const TEXLIVE_BASE = "/api/texlive";

// The engine's three data packages (their .js scripts are the catalog the
// resolver scans for \ProvidesPackage; the .data files are the trees the
// pipeline mounts into the FS). basic is preloaded — it holds the kernel,
// most packages, and the fonts; recommended and extra load on demand when
// a compiled document actually uses a package from them.
const DATA_PACKAGES_JS = [
  `${TEXLIVE_BASE}/texlive-basic.js`,
  `${TEXLIVE_BASE}/texlive-recommended.js`,
  `${TEXLIVE_BASE}/texlive-extra.js`,
];
const PRELOAD_DATA_PACKAGES_JS = [`${TEXLIVE_BASE}/texlive-basic.js`];

// The only driver that produces a PDF in this build (xelatex → xdvipdfmx).
const DRIVER = "xetex_bibtex8_dvipdfmx";

// The engine's on-demand package file endpoint (see
// src/app/api/texlive-remote/). Leading slash on purpose: a relative URL
// in the worker would resolve against the worker script's own directory
// (/busytex/), not the page's origin root.
const REMOTE_ENDPOINT = "/api/texlive-remote";

// Bump whenever public/busytex/busytex_worker.js or
// public/busytex/busytex_pipeline.js changes: browsers cache classic worker
// scripts aggressively and may not refetch them even on a hard reload.
// Keep in sync with SCRIPT_VERSION in busytex_worker.js.
const WORKER_VERSION = 15;

export type CompileResult = {
  pdf: Uint8Array | null;
  log: string;
  /** Synctex data (gzipped by xetex) for PDF<->source navigation. */
  synctex: Uint8Array | null;
};

type WorkerMessage = {
  ready?: boolean;
  loaded?: boolean;
  print?: string;
  error?: string;
  pdf?: Uint8Array | null;
  log?: string | null;
  synctex?: Uint8Array | null;
};

/**
 * The names the pipeline should treat as locally available: the installed
 * package names plus everything they \ProvidesPackage (pgf provides tikz,
 * algorithm provides algcompatible, …). Fails soft — an empty list only
 * means installed packages fall through to the enable-all-data-packages
 * fallback instead of the remote endpoint, which still compiles.
 */
async function fetchRemotePackages(): Promise<string[]> {
  try {
    const res = await fetch("/api/packages");
    if (!res.ok) throw new Error(`GET /api/packages -> ${res.status}`);
    const data = (await res.json()) as {
      packages: { name: string; provides: string[] }[];
    };
    const names = new Set<string>();
    for (const p of data.packages) {
      names.add(p.name.toLowerCase());
      for (const n of p.provides) names.add(n.toLowerCase());
    }
    return [...names];
  } catch (err) {
    console.warn("[busytex] installed package list unavailable, continuing without remote_packages:", err);
    return [];
  }
}

export class BusyTexCompiler {
  private worker: Worker | null = null;
  private pending: ((msg: WorkerMessage) => void) | null = null;
  private onLog: ((line: string) => void) | null = null;
  private onReady: (() => void) | null = null;
  private onError: ((msg: string) => void) | null = null;
  private disposed = false;

  constructor(private workerUrl = `/busytex/busytex_worker.js?v=${WORKER_VERSION}`) {}

  /**
   * Create the worker and send the init message. Idempotent while a worker
   * is alive. onError fires for failures outside a compile (an asset load
   * failing during init, a worker crash) — the worker is disposed when it
   * fires, and the next compile() recreates it.
   */
  async init(
    onLog?: (line: string) => void,
    onReady?: () => void,
    onError?: (msg: string) => void,
  ): Promise<void> {
    this.onLog = onLog ?? this.onLog;
    this.onReady = onReady ?? this.onReady;
    this.onError = onError ?? this.onError;
    if (!this.worker) {
      // A dispose() that PRECEDES init() is the normal recovery path —
      // a failed worker was disposed, and the caller (compile()) wants
      // the fresh worker. Only a dispose() DURING the fetch below means
      // the caller is tearing the compiler down.
      const disposedBefore = this.disposed;
      // The package list is fetched before the worker starts: the
      // init message carries it (see the file header), and the engine
      // needs the right list from its very first compile.
      const remote_packages = await fetchRemotePackages();
      // The await yielded: a dispose() in that window makes this worker
      // start moot (the caller is tearing the compiler down).
      if (this.disposed && !disposedBefore) return;
      this.disposed = false;
      const worker = new Worker(this.workerUrl);
      this.worker = worker;

      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.ready !== undefined) {
          console.debug("[busytex] worker ready");
          return;
        }
        if (msg.loaded !== undefined) {
          console.debug("[busytex] engine loaded");
          if (this.onReady) this.onReady();
          return;
        }
        if (msg.print !== undefined && this.onLog) this.onLog(msg.print);
        // Worker-reported failure (asset load, pipeline crash, …).
        if (msg.error !== undefined) {
          console.error("[busytex] worker error:\n" + msg.error);
          if (this.pending) {
            const resolvePending = this.pending;
            this.pending = null;
            this.dispose();
            resolvePending({ pdf: null, log: msg.error });
          } else {
            // Outside a compile (an init-time asset load failed): the
            // worker is dead — dispose it and report it, or the next
            // compile would wait forever on a promise that never settles.
            this.dispose();
            this.onError?.(msg.error);
          }
          return;
        }
        // Compile results only arrive while pending.
        if (this.pending && (msg.pdf !== undefined || msg.log !== undefined)) {
          const resolvePending = this.pending;
          this.pending = null;
          resolvePending(msg);
        }
      };
      // The worker script itself failed to load or crashed — its own
      // {error} channel can't report that, so surface it here.
      worker.onerror = (e) => {
        const message = `worker crashed${e.message ? ": " + e.message : ""}`;
        console.error("[busytex] worker error event:", e);
        if (this.pending) {
          const resolvePending = this.pending;
          this.pending = null;
          this.dispose();
          resolvePending({ pdf: null, log: message });
        } else {
          // The worker is dead with no compile to report to — dispose and
          // surface the error instead of leaving the UI stuck.
          this.dispose();
          this.onError?.(message);
        }
      };

      // The worker reads evt.data and expects the fields at the top level
      // (the release protocol posts plain message objects, no wrapper).
      worker.postMessage({
        busytex_js: `${TEXLIVE_BASE}/busytex.js`,
        busytex_wasm: `${TEXLIVE_BASE}/busytex.wasm`,
        // The biber module is lazy in the pipeline (constructor only stores
        // the URLs); the assets load on the first biber run, so passing
        // them now costs nothing.
        biber_js: `${TEXLIVE_BASE}/biber.js`,
        biber_wasm: `${TEXLIVE_BASE}/biber.wasm`,
        biber_data: `${TEXLIVE_BASE}/biber.data`,
        // The data-package catalog (the resolver fetches each .js for the
        // \ProvidesPackage scan) and the set to preload now (basic only —
        // the other two are hundreds of MB and load on demand).
        data_packages_js: DATA_PACKAGES_JS,
        preload_data_packages_js: PRELOAD_DATA_PACKAGES_JS,
        texmf_local: [] as string[],
        preload: true,
        verbose: "silent",
        // PATCH (see public/busytex/busytex_pipeline.js): the names the
        // server's CTAN package store provides, treated as local so they
        // never trigger the enable-all-data-packages fallback.
        remote_packages,
      });
    }
  }

  /**
   * Compile a project of files (a map of path → contents). Text files are
   * strings; binary files (images, PDFs, …) are byte arrays — the pipeline
   * hands both to FS.writeFile, which writes each type as-is, so uploads
   * can be used in the document (e.g. \includegraphics). The pipeline
   * auto-runs bibtex8/biber when a .bib is present and makeindex on a
   * non-empty .idx. pdf is null when compilation failed.
   */
  async compile(
    files: Record<string, string | Uint8Array>,
    mainTexPath: string,
  ): Promise<CompileResult> {
    // A disposed worker (after a load failure, a crash, or a package
    // store change) is recreated here — init() is a no-op while a worker
    // is alive, and the asset fetches are cached by then.
    if (!this.worker) {
      await this.init();
    }
    // The pipeline writes each entry with FS.mkdir (dir) or FS.writeFile
    // (file), and FS.writeFile does not create parent directories — so a
    // nested path (a folder upload) also needs its ancestor directories.
    // A dir path is a string prefix of everything inside it, and the
    // pipeline sorts by path, so dirs always land before their children.
    const all = Object.entries(files).map(([path, contents]) => ({
      path,
      contents,
    }));
    const dirs = new Set<string>();
    for (const { path } of all) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++)
        dirs.add(parts.slice(0, i).join("/"));
    }

    // The awaits above yielded: a worker that failed to load in that window
    // is already disposed (init()'s onerror path). Recreate it, or the post
    // below would land on a terminated worker and never settle.
    if (!this.worker) {
      await this.init();
    }

    return new Promise<CompileResult>((resolve) => {
      this.worker!.postMessage({
        files: [
          ...[...dirs].map((path) => ({ path, contents: null as string | null })),
          ...all,
        ],
        main_tex_path: mainTexPath,
        // null = auto: bibtex runs when a .bib is present, biber is used
        // when the document asks for it (biblatex backend=biber), makeindex
        // on a non-empty .idx, and the log-driven rerun loop is enabled.
        bibtex: null,
        biber: null,
        makeindex: null,
        rerun: null,
        verbose: "silent",
        driver: DRIVER,
        // Explicit null, NOT undefined: the pipeline defaults a missing
        // value to [] (no data packages), which marks every package
        // unresolved and enables ALL of them — the ~540 MB fallback. null
        // means "resolve against the catalog and load only what is used".
        data_packages_js: null,
        remote_endpoint: REMOTE_ENDPOINT,
        shell_escape: false,
      });
      this.pending = (msg) => {
        // The pipeline reads the PDF back from MEMFS as a Uint8Array
        // (FS.readFile with encoding 'binary'); copy it out of the worker.
        resolve({
          pdf: msg.pdf ? Uint8Array.from(msg.pdf) : null,
          log: msg.log ?? "",
          synctex: msg.synctex ? Uint8Array.from(msg.synctex) : null,
        });
      };
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
  }
}
