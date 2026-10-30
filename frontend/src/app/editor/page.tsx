"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import PdfViewer from "@/components/pdf-viewer";
import { BusyTexCompiler } from "@/lib/busytex";

// Light Monaco theme using the HomeHub palette (no dark mode).
const defineTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("homehub", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5e5e5e", fontStyle: "italic" },
      { token: "keyword", foreground: "333333", fontStyle: "bold" },
      { token: "string", foreground: "14a98a" },
      { token: "number", foreground: "b0764a" },
      { token: "tag", foreground: "333333", fontStyle: "bold" },
    ],
    colors: {
      "editor.background": "#fcfaf9",
      "editor.foreground": "#333333",
      "editor.lineHighlightBackground": "#f3d3bd59",
      "editorLineNumber.foreground": "#5e5e5e",
      "editorLineNumber.activeForeground": "#333333",
      "editorCursor.foreground": "#14a98a",
      "editor.selectionBackground": "#48e5c266",
      "editorIndentGuide.background1": "#33333322",
      "editorWidget.background": "#fcfaf9",
      "editorSuggestWidget.background": "#fcfaf9",
      "minimap.background": "#fcfaf9",
    },
  });
};

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
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const compilerRef = useRef<BusyTexCompiler | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const compiler = new BusyTexCompiler();
    compilerRef.current = compiler;
    compiler.init(
      (line) => {
        setStatus((s) =>
          s.kind === "compiling"
            ? { kind: "compiling", line: lastLine(line, s.line) }
            : { kind: "loading", line: lastLine(line, "") },
        );
      },
      () => {
        // Engine finished its background preload; stop showing
        // "Loading engine…" (unless a compile already started).
        setStatus((s) => (s.kind === "loading" ? { kind: "idle" } : s));
      },
    );
    return () => compiler.dispose();
  }, []);

  const compile = useCallback(async () => {
    const compiler = compilerRef.current;
    if (!compiler || busyRef.current) return;
    busyRef.current = true;
    setPdf(null);
    setStatus({ kind: "compiling", line: "preparing…" });
    const started = performance.now();
    try {
      await compiler.init();
      const result = await compiler.compile(source);
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
  }, [source]);

  const statusText =
    status.kind === "idle"
      ? "Ready."
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
        <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
          <span className="h-3 w-3 rounded-sm bg-mint" />
          LaTeX Editor
        </h1>
        <button
          onClick={compile}
          disabled={status.kind === "compiling"}
          className="rounded bg-mint px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
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
            theme="homehub"
            beforeMount={defineTheme}
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
        <pre className="max-h-48 overflow-auto border-t border-ink/10 bg-peach/60 p-3 text-xs text-ink">
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
