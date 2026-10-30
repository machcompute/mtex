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

// Bump whenever public/busytex/busytex_worker.js changes: browsers cache
// classic worker scripts aggressively and may not refetch them even on a
// hard reload. Keep in sync with SCRIPT_VERSION in busytex_worker.js.
const WORKER_VERSION = 6;

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
  private disposed = false;

  constructor(private workerUrl = `/busytex/busytex_worker.js?v=${WORKER_VERSION}`) {}

  /** Create the worker and send the init message. */
  init(
    onLog?: (line: string) => void,
    onReady?: () => void,
  ): Promise<void> {
    this.onLog = onLog ?? this.onLog;
    this.onReady = onReady ?? this.onReady;
    if (!this.worker) {
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
          } else if (this.onLog) {
            this.onLog(msg.error);
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
        } else if (this.onLog) {
          this.onLog(message);
        }
      };

      // The worker reads evt.data and expects the fields at the top level
      // (the old busytex protocol posts plain message objects, no wrapper).
      worker.postMessage({
        busytex_js: `${TEXLIVE_BASE}/busytex.js`,
        busytex_wasm: `${TEXLIVE_BASE}/busytex.wasm`,
        texlive_js: [`${TEXLIVE_BASE}/texlive-basic.js`],
        texmf_local: [] as string[],
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
  compile(
    files: Record<string, string | Uint8Array>,
    mainTexPath: string,
  ): Promise<CompileResult> {
    return new Promise<CompileResult>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("compiler not initialized"));
        return;
      }
      this.worker.postMessage({
        files: Object.entries(files).map(([path, contents]) => ({
          path,
          contents,
        })),
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
