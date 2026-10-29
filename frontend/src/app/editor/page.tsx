"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import PdfViewer from "@/components/pdf-viewer";
import { BusyTexCompiler, type BusyTexDriver } from "@/lib/busytex";

const DEFAULT_SOURCE = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}

\\title{HomeHub LaTeX}
\\author{You}
\\date{\\today}

\\begin{document}
\\maketitle

Hello from a \\textbf{full TeX Live} running in your browser.

\\begin{equation}
  e^{i\\pi} + 1 = 0
\\end{equation}

\\end{document}
`;

type Status =
  | { kind: "idle" }
  | { kind: "loading"; line: string }
  | { kind: "compiling"; line: string }
  | { kind: "done"; ms: number }
  | { kind: "error"; message: string };

export default function EditorPage() {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [driver, setDriver] = useState<BusyTexDriver>("pdftex_bibtex8");
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const compilerRef = useRef<BusyTexCompiler | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const compiler = new BusyTexCompiler();
    compilerRef.current = compiler;
    compiler.init((line) => {
      setStatus((s) =>
        s.kind === "compiling"
          ? { kind: "compiling", line: lastLine(line, s.line) }
          : { kind: "loading", line: lastLine(line, "") },
      );
    });
    return () => compiler.dispose();
  }, []);

  const compile = useCallback(async () => {
    const compiler = compilerRef.current;
    if (!compiler || busyRef.current) return;
    busyRef.current = true;
    setPdf(null);
    setStatus({ kind: "compiling", line: "compiling…" });
    const started = performance.now();
    try {
      await compiler.init();
      const result = await compiler.compile(source, driver);
      if (result.pdf) {
        setPdf(result.pdf);
        setStatus({ kind: "done", ms: Math.round(performance.now() - started) });
      } else {
        setStatus({ kind: "error", message: "Compilation failed — see log" });
      }
      setLog(result.log);
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
    }
  }, [source, driver]);

  const statusText =
    status.kind === "idle"
      ? "Ready. The TeX engine loads on first compile (~100 MB one-time download)."
      : status.kind === "loading"
        ? `Loading engine… ${status.line}`
        : status.kind === "compiling"
          ? `Compiling… ${status.line}`
          : status.kind === "done"
            ? `Compiled in ${status.ms} ms`
            : status.message;

  return (
    <div className="flex h-screen flex-col bg-cream">
      <header className="flex items-center gap-4 border-b border-ink/10 bg-cream px-4 py-2">
        <h1 className="text-base font-semibold text-ink">
          LaTeX Editor
        </h1>
        <select
          value={driver}
          onChange={(e) => setDriver(e.target.value as BusyTexDriver)}
          className="rounded border border-stone/40 bg-cream px-2 py-1 text-sm text-ink"
        >
          <option value="pdftex_bibtex8">pdflatex</option>
          <option value="xetex_bibtex8_dvipdfmx">xelatex</option>
          <option value="luahbtex_bibtex8">lualatex (harfbuzz)</option>
        </select>
        <button
          onClick={compile}
          disabled={status.kind === "compiling" || status.kind === "loading"}
          className="rounded bg-ink px-4 py-1.5 text-sm font-medium text-mint transition-colors hover:bg-mint hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Compile
        </button>
        <span
          className={"min-w-0 flex-1 truncate text-xs " + (status.kind === "error" ? "text-red-600" : "text-stone")}
        >
          {statusText}
        </span>
        <button
          onClick={() => setShowLog((v) => !v)}
          className="rounded border border-stone/40 px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          {showLog ? "Hide log" : "Show log"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-ink/10">
          <Editor
            height="100%"
            defaultLanguage="latex"
            value={source}
            onChange={(value) => setSource(value ?? "")}
            theme="vs-dark"
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <PdfViewer data={pdf} />
        </div>
      </div>

      {showLog && (
        <pre className="max-h-48 overflow-auto border-t border-ink/10 bg-ink p-3 text-xs text-cream/90">
          {log || "(no log output)"}
        </pre>
      )}
    </div>
  );
}

function lastLine(line: string, prev: string) {
  const trimmed = line.trim();
  if (trimmed.length <= 80) return trimmed;
  return prev.length > trimmed.length ? prev : trimmed.slice(0, 80) + "…";
}
