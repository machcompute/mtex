// The TeX engine boundary for page tests: a drop-in for BusyTexCompiler whose
// compile() is answered by a per-test handler. No worker, no WASM, no network.
import type { CompileResult } from "@/lib/busytex";

export type CompileCall = {
  files: Record<string, string | Uint8Array>;
  main: string;
  bibHashes: Record<string, string> | null;
};

export type Handler = (call: CompileCall, instance: FakeBusyTex) => CompileResult | Promise<CompileResult>;

const enc = (s: string) => new TextEncoder().encode(s);

/** A "PDF" whose bytes spell the main file's text, so tests can assert content. */
export function fakePdfFor(call: CompileCall): Uint8Array<ArrayBuffer> {
  const main = call.files[call.main];
  const body = typeof main === "string" ? main : "(binary)";
  return enc(`%PDF-FAKE ${call.main}\n${body}`);
}

export const okHandler: Handler = (call) => ({
  pdf: fakePdfFor(call),
  log: `This is XeTeX, fake build of ${call.main}`,
  synctex: null,
  buildState: null,
});

export class FakeBusyTex {
  static instances: FakeBusyTex[] = [];
  static calls: CompileCall[] = [];
  static handler: Handler = okHandler;
  /** Report ready right after init (microtask). */
  static autoReady = true;

  static reset(): void {
    FakeBusyTex.instances = [];
    FakeBusyTex.calls = [];
    FakeBusyTex.handler = okHandler;
    FakeBusyTex.autoReady = true;
  }

  onLog: ((line: string) => void) | null = null;
  onReady: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  disposed = false;
  initCount = 0;

  constructor() {
    FakeBusyTex.instances.push(this);
  }

  async init(onLog?: (l: string) => void, onReady?: () => void, onError?: (m: string) => void): Promise<void> {
    this.onLog = onLog ?? this.onLog;
    this.onReady = onReady ?? this.onReady;
    this.onError = onError ?? this.onError;
    this.initCount++;
    if (this.initCount === 1 && FakeBusyTex.autoReady) queueMicrotask(() => this.onReady?.());
  }

  async compile(
    files: Record<string, string | Uint8Array>,
    main: string,
    bibHashes: Record<string, string> | null = null,
  ): Promise<CompileResult> {
    const call: CompileCall = { files: { ...files }, main, bibHashes };
    FakeBusyTex.calls.push(call);
    return FakeBusyTex.handler(call, this);
  }

  dispose(): void {
    this.disposed = true;
  }

  // --- test controls ---
  emitReady(): void {
    this.onReady?.();
  }
  emitLog(line: string): void {
    this.onLog?.(line);
  }
  emitError(msg: string): void {
    this.onError?.(msg);
  }
}
