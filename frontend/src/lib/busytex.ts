"use client";

// Wraps the busytex WebAssembly worker (full TeX Live compiled to WASM).
// The heavy assets (busytex.js/.wasm, texlive-basic.js/.data) are served by
// the Go backend at /api/texlive/ and cached there on first use.
//
// The worker + pipeline files in /busytex/ are from the same busytex commit
// as the pinned release (build_b16fdf28) — that build runs xelatex via
// xdvipdfmx and auto-runs bibtex8 when a .bib file is present.
//
// Worker protocol (old, matching the build):
//   init:    {busytex_js, busytex_wasm, texlive_js: [url], texmf_local, preload, verbose}
//   compile: {files, main_tex_path, bibtex, verbose}  ->  {pdf, log}
//   logs:    {print: string}
// There is no "initialized" handshake; the pipeline is built synchronously
// on the init message and the first compile awaits asset loading, reporting
// progress through print messages.

const TEXLIVE_BASE = "http://localhost:8080/api/texlive";

export type CompileResult = {
  pdf: Uint8Array | null;
  log: string;
};

type WorkerMessage = {
  print?: string;
  pdf?: Uint8Array | null;
  log?: string | null;
};

export class BusyTexCompiler {
  private worker: Worker | null = null;
  private pending: ((msg: WorkerMessage) => void) | null = null;
  private disposed = false;

  constructor(private workerUrl = "/busytex/busytex_worker.js") {}

  /** Create the worker and send the init message. */
  init(onLog?: (line: string) => void): Promise<void> {
    if (!this.worker) {
      const worker = new Worker(this.workerUrl);
      this.worker = worker;

      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.print !== undefined && onLog) onLog(msg.print);
        // Compile results only arrive while pending.
        if (this.pending && (msg.pdf !== undefined || msg.log !== undefined)) {
          const resolvePending = this.pending;
          this.pending = null;
          resolvePending(msg);
        }
      };
      worker.onerror = (e) => {
        const message = e.message || "worker error";
        if (this.pending) {
          const resolvePending = this.pending;
          this.pending = null;
          this.dispose();
          resolvePending({ pdf: null, log: message });
        }
      };

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

  /** Compile a LaTeX source string; pdf is null when compilation failed. */
  compile(source: string): Promise<CompileResult> {
    return new Promise<CompileResult>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("compiler not initialized"));
        return;
      }
      this.worker.postMessage({
        files: [{ path: "main.tex", contents: source }],
        main_tex_path: "main.tex",
        bibtex: null,
        verbose: "silent",
      });
      this.pending = (msg) => {
        // The pipeline reads the PDF back from MEMFS as a Uint8Array
        // (FS.readFile with encoding 'binary'); copy it out of the worker.
        resolve({
          pdf: msg.pdf ? Uint8Array.from(msg.pdf) : null,
          log: msg.log ?? "",
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
