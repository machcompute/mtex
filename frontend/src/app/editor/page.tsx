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
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          LaTeX Editor
        </h1>
        <select
          value={driver}
          onChange={(e) => setDriver(e.target.value as BusyTexDriver)}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
        >
          <option value="pdftex_bibtex8">pdflatex</option>
          <option value="xetex_bibtex8_dvipdfmx">xelatex</option>
          <option value="luahbtex_bibtex8">lualatex (harfbuzz)</option>
        </select>
        <button
          onClick={compile}
          disabled={status.kind === "compiling" || status.kind === "loading"}
          className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black dark:hover:bg-zinc-300"
        >
          Compile
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {statusText}
        </span>
        <button
          onClick={() => setShowLog((v) => !v)}
          className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {showLog ? "Hide log" : "Show log"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-zinc-200 dark:border-zinc-800">
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
        <pre className="max-h-48 overflow-auto border-t border-zinc-200 bg-zinc-900 p-3 text-xs text-zinc-300 dark:border-zinc-800">
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
