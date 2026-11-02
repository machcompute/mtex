"use client";

// Wraps the busytex WebAssembly worker (full TeX Live compiled to WASM).
// The heavy assets (busytex.js/.wasm, texlive-basic.js/.data) are served
// by the Go backend and proxied same-origin through /api/texlive — the
// worker loads two of them with importScripts(), which browsers only allow
// for same-origin URLs, so the browser can't fetch :8080 directly.
//
// The worker + pipeline files in /busytex/ are from the same busytex commit
// as the pinned release (build_b16fdf28) — that build runs xelatex via
// xdvipdfmx and auto-runs bibtex8 when a .bib file is present.
//
// Worker protocol (old, matching the build):
//   init:    {busytex_js, busytex_wasm, texlive_js: [url], texmf_local, preload, verbose}
//   compile: {files, main_tex_path, bibtex, verbose}  ->  {pdf, log, synctex}
//   logs:    {print: string}
// There is no "initialized" handshake; the pipeline is built synchronously
// on the init message and the first compile awaits asset loading, reporting
// progress through print messages.

// Same origin: src/app/api/texlive/[name]/route.ts proxies to the Go
// backend, which downloads from the pinned release and caches locally.
const TEXLIVE_BASE = "/api/texlive";

// The pinned texlive-basic set (~320 packages) lacks packages users
// routinely \usepackage, so documents fail with "File `X.sty' not found".
// Such packages are vendored in public/texmf-extra/ (scripts/sync-texlive.sh
// pulls them from the local TeX Live and generates extra-bundle.json). The
// WORKER fetches that bundle once per engine start and the pipeline
// installs the tree into the in-memory FS root at /texmf-extra (PATCH 9 in
// busytex_pipeline.js) — it survives the per-compile project remount, so it
// never rides in the compile payload. texmf_local: ["/texmf-extra"] below
// makes the pipeline add /texmf-extra/texmf-dist to TEXMFDIST (absolute
// entries map to the FS root).
const EXTRA_TEXMF_DIR = "/texmf-extra";

// Bump whenever public/busytex/busytex_worker.js changes: browsers cache
// classic worker scripts aggressively and may not refetch them even on a
// hard reload. Keep in sync with SCRIPT_VERSION in busytex_worker.js.
const WORKER_VERSION = 12;

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
  init(
    onLog?: (line: string) => void,
    onReady?: () => void,
    onError?: (msg: string) => void,
  ): Promise<void> {
    this.onLog = onLog ?? this.onLog;
    this.onReady = onReady ?? this.onReady;
    this.onError = onError ?? this.onError;
    if (!this.worker) {
      // A previous worker may have been disposed after a failure — clear
      // the latch so this worker can be terminated again.
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
      // (the old busytex protocol posts plain message objects, no wrapper).
      worker.postMessage({
        busytex_js: `${TEXLIVE_BASE}/busytex.js`,
        busytex_wasm: `${TEXLIVE_BASE}/busytex.wasm`,
        texlive_js: [`${TEXLIVE_BASE}/texlive-basic.js`],
        // Extra local TeX tree: the vendored packages (see the comment at
        // the top of this file). Absolute path — the worker installs it at
        // the FS root, outside the per-compile project remount.
        texmf_local: [EXTRA_TEXMF_DIR] as string[],
        preload: true,
        verbose: "silent",
      });
    }
    return Promise.resolve();
  }

  /**
   * Compile a project of files (a map of path → contents). Text files are
   * strings; binary files (images, PDFs, …) are byte arrays — the pipeline
   * hands both to FS.writeFile, which writes each type as-is, so uploads
   * can be used in the document (e.g. \includegraphics). The build targets
   * mainTexPath; bibtex8 runs automatically when any file is a .bib (the
   * pipeline detects it). pdf is null when compilation failed.
   */
  async compile(
    files: Record<string, string | Uint8Array>,
    mainTexPath: string,
  ): Promise<CompileResult> {
    // A disposed worker (after a load failure or a crash) is recreated
    // here — init() is a no-op while a worker is alive, and the asset
    // fetches are cached by then.
    if (!this.worker) {
      await this.init();
    }
    // The pipeline writes each entry with FS.mkdir (dir) or FS.writeFile
    // (file), and FS.writeFile does not create parent directories — so a
    // nested path (a folder upload) also needs its ancestor directories.
    // A dir path is a string prefix of everything inside it, and the
    // pipeline sorts by path, so dirs always land before their children.
    // The vendored texmf-extra tree is not part of this payload — the
    // worker installs it once into the FS root (see the top of this file).
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
        bibtex: null, // auto-run bibtex8 when a .bib is present
        verbose: "silent",
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
