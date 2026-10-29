"use client";

// Wraps the busytex WebAssembly worker (full TeX Live compiled to WASM).
// The heavy assets (busytex.js/.wasm, texlive-basic.js/.data) are served by
// the Go backend at /api/texlive/ and cached there on first use.

const TEXLIVE_BASE = "http://localhost:8080/api/texlive";

export type CompileResult = {
  pdf: Uint8Array | null;
  log: string;
  exit_code: number;
};

export type BusyTexDriver =
  | "xetex_bibtex8_dvipdfmx"
  | "pdftex_bibtex8"
  | "luahbtex_bibtex8"
  | "luatex_bibtex8";

type WorkerMessage = {
  print?: string;
  initialized?: Record<string, string>;
  exception?: string;
  pdf?: ArrayBuffer | null;
  log?: string;
  exit_code?: number;
};

export class BusyTexCompiler {
  private worker: Worker | null = null;
  private pending: ((msg: WorkerMessage) => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private workerUrl = "/busytex/busytex_worker.js") {}

  get ready() {
    return this.initPromise !== null;
  }

  /** Create the worker and wait for the Emscripten module to initialize. */
  init(onLog?: (line: string) => void): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = new Promise<void>((resolve, reject) => {
        const worker = new Worker(this.workerUrl);
        this.worker = worker;

        worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
          const msg = e.data;
          if (msg.print !== undefined && onLog) onLog(msg.print);
          if (msg.initialized !== undefined) {
            resolve();
            return;
          }
          if (msg.exception !== undefined) {
            if (this.pending) {
              const resolvePending = this.pending;
              this.pending = null;
              resolvePending({ exception: msg.exception });
              this.dispose();
              return;
            }
            this.dispose();
            if (this.initPromise) reject(new Error(msg.exception));
            return;
          }
          // Compile results only arrive while pending.
          if (this.pending) {
            const resolvePending = this.pending;
            this.pending = null;
            resolvePending(msg);
          }
        };
        worker.onerror = (e) => {
          const message = e.message || "worker error";
          if (this.initPromise && !this.pending) {
            this.initPromise = null;
            this.dispose();
            reject(new Error(message));
          } else {
            this.pending?.({ exception: message });
          }
        };

        worker.postMessage({
          busytex_js: `${TEXLIVE_BASE}/busytex.js`,
          busytex_wasm: `${TEXLIVE_BASE}/busytex.wasm`,
          preload_data_packages_js: [`${TEXLIVE_BASE}/texlive-basic.js`],
          data_packages_js: [] as string[],
          texmf_local: [] as string[],
          preload: true,
          verbose: "silent",
          driver: "pdftex_bibtex8",
        });
      });
      this.initPromise.catch(() => {
        // Allow a retry after a failed init.
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  /** Compile a LaTeX source string and return the PDF bytes (null on failure). */
  compile(
    source: string,
    driver: BusyTexDriver = "pdftex_bibtex8",
    onLog?: (line: string) => void,
  ): Promise<CompileResult> {
    return new Promise<CompileResult>((resolve) => {
      this.worker?.postMessage({
        files: [{ path: "main.tex", contents: source }],
        main_tex_path: "main.tex",
        bibtex: null,
        verbose: "silent",
        driver,
        data_packages_js: [] as string[],
      });
      void onLog; // logs are forwarded via the init onLog channel
      this.pending = (msg) => {
        if (msg.exception !== undefined) {
          resolve({ pdf: null, log: msg.exception, exit_code: 1 });
          return;
        }
        const result = msg as CompileResult;
        resolve({
          pdf: result.pdf ? new Uint8Array(result.pdf) : null,
          log: result.log ?? "",
          exit_code: result.exit_code ?? 1,
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
    this.initPromise = null;
  }
}
