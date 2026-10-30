"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import PdfViewer, { type PdfViewerHandle } from "@/components/pdf-viewer";
import FileBrowser from "@/components/file-browser";
import { BusyTexCompiler } from "@/lib/busytex";
import {
  decodeSynctex,
  findOutputForSource,
  findSourceForPoint,
  type SyncEntry,
} from "@/lib/synctex";

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

const DEFAULT_MAIN = "main.tex";

// Default project: a two-file bibtex example, so multi-file compilation and
// bibtex8 (the pipeline auto-runs it whenever a .bib is present) work out of
// the box.
const DEFAULT_FILES: Record<string, string> = {
  [DEFAULT_MAIN]: `\\documentclass{article}
\\usepackage{amsmath}

\\title{HomeHub LaTeX}
\\author{You}
\\date{\\today}

\\begin{document}
\\maketitle

Hello from a \\textbf{full TeX Live} running in your browser.
Citations are resolved by bibtex8: Euler's classic
\\cite{euler1748} and Knuth's \\cite{knuth1984}.

\\begin{equation}
  e^{i\\pi} + 1 = 0
\\end{equation}

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`,
  "refs.bib": `@article{euler1748,
  author  = {Euler, Leonhard},
  title   = {Introductio in analysin infinitorum},
  journal = {Genevae},
  year    = {1748},
}

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}
`,
};

type Status =
  | { kind: "idle" }
  | { kind: "loading"; line: string }
  | { kind: "compiling"; line: string }
  | { kind: "done"; ms: number }
  | { kind: "error"; message: string };

export default function EditorPage() {
  const [files, setFiles] = useState<Record<string, string>>(DEFAULT_FILES);
  const [activePath, setActivePath] = useState(DEFAULT_MAIN);
  const [mainPath, setMainPath] = useState(DEFAULT_MAIN);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Decoded synctex data for the current PDF (null = no navigation yet).
  const [syncEntries, setSyncEntries] = useState<SyncEntry[] | null>(null);

  const compilerRef = useRef<BusyTexCompiler | null>(null);
  const busyRef = useRef(false);
  // Flips once the worker reports {loaded}; stray engine print lines after
  // that must not drag the status back to "Loading engine…".
  const engineReadyRef = useRef(false);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // IDs of the mint flash decoration (deltaDecorations returns string[]).
  const flashDecorationsRef = useRef<string[] | null>(null);
  const flashTimerRef = useRef<number | undefined>(undefined);
  // Set when a PDF click lands in a file that isn't active yet; consumed by
  // the effect below once Monaco has switched to that file's model.
  const pendingJumpRef = useRef<{ file: string; line: number } | null>(null);

  useEffect(() => {
    const compiler = new BusyTexCompiler();
    compilerRef.current = compiler;
    compiler.init(
      (line) => {
        setStatus((s) => {
          if (s.kind === "compiling")
            return { kind: "compiling", line: lastLine(line, s.line) };
          // Terminal states survive late print lines (the engine can emit
          // trailing output after a successful compile).
          if (engineReadyRef.current || s.kind === "done" || s.kind === "error")
            return s;
          return {
            kind: "loading",
            line: lastLine(line, s.kind === "loading" ? s.line : ""),
          };
        });
      },
      () => {
        engineReadyRef.current = true;
        // Engine finished its background preload; stop showing
        // "Loading engine…" (unless a compile already started).
        setStatus((s) => (s.kind === "loading" ? { kind: "idle" } : s));
      },
    );
    return () => compiler.dispose();
  }, []);

  const activeSource = files[activePath] ?? "";

  // --- file operations -------------------------------------------------

  const addFile = (name: string) => {
    const path = normalizeName(name);
    if (!path || files[path] !== undefined) {
      setStatus({
        kind: "error",
        message: `Cannot create “${name}” — use a flat name (no folders), not already taken`,
      });
      return;
    }
    setFiles((f) => ({ ...f, [path]: "" }));
    setActivePath(path);
  };

  const renameFile = (oldPath: string, newName: string) => {
    const path = normalizeName(newName);
    if (!path || path === oldPath) return;
    if (files[path] !== undefined) {
      setStatus({
        kind: "error",
        message: `Cannot rename to “${newName}” — name already taken`,
      });
      return;
    }
    setFiles((f) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) next[k === oldPath ? path : k] = v;
      return next;
    });
    setActivePath((p) => (p === oldPath ? path : p));
    setMainPath((m) => (m === oldPath ? path : m));
  };

  const deleteFile = (path: string) => {
    const rest = Object.keys(files).filter((p) => p !== path);
    const nextMain =
      path === mainPath ? (rest.find((p) => p.endsWith(".tex")) ?? rest[0] ?? "") : mainPath;
    setFiles((f) => {
      const next = { ...f };
      delete next[path];
      return next;
    });
    setMainPath(nextMain);
    setActivePath((p) => (p === path ? nextMain : p));
  };

  // --- compile ----------------------------------------------------------

  const compile = useCallback(async () => {
    const compiler = compilerRef.current;
    if (!compiler || busyRef.current) return;
    if (!mainPath || files[mainPath] === undefined) {
      setStatus({
        kind: "error",
        message: "No main .tex file — add one and mark it “main”",
      });
      return;
    }
    busyRef.current = true;
    setPdf(null);
    setStatus({ kind: "compiling", line: "preparing…" });
    const started = performance.now();
    try {
      await compiler.init();
      // All files go to the worker; the pipeline runs bibtex8 itself when
      // any of them is a .bib.
      const result = await compiler.compile(files, mainPath);
      if (result.pdf) {
        setPdf(result.pdf);
        setStatus({ kind: "done", ms: Math.round(performance.now() - started) });
      } else {
        setPdf(null);
        setStatus({ kind: "error", message: "Compilation failed — see log" });
      }
      setLog(result.log);
      // Decode synctex for PDF<->source navigation; a failed build has no
      // usable map, and decoding is best-effort (bad bytes = no navigation).
      if (result.pdf && result.synctex) {
        setSyncEntries(await decodeSynctex(result.synctex).catch(() => null));
      } else {
        setSyncEntries(null);
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
    }
  }, [files, mainPath]);

  // --- PDF <-> source navigation (synctex) ------------------------------

  /** Move the Monaco cursor to a line, reveal it and flash it mint. */
  const revealLine = (line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.setSelection({
      startLineNumber: line,
      startColumn: 1,
      endLineNumber: line,
      endColumn: Infinity,
    });
    editor.revealLineInCenter(line);
    const prev = flashDecorationsRef.current;
    flashDecorationsRef.current = editor.deltaDecorations(prev ?? [], [
      {
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { isWholeLine: true, className: "sync-flash" },
      },
    ]);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      const ids = flashDecorationsRef.current;
      if (ids) editor.deltaDecorations(ids, []);
      flashDecorationsRef.current = null;
    }, 1400);
  };

  /** Inverse sync: open the source line a PDF position points at. */
  const jumpToSource = (entry: SyncEntry) => {
    // The synctex file only names files TeX itself read; content coming
    // from a .bbl (via \bibliography) is attributed to the .bbl, which is
    // not part of the project — land on the \bibliography line instead.
    const file = files[entry.file] !== undefined ? entry.file : mainPath;
    let line = entry.line;
    if (file !== entry.file) {
      const main = files[mainPath] ?? "";
      const bibLine = main
        .split("\n")
        .findIndex((l) => /\\bibliography\s*{/.test(l));
      line = bibLine >= 0 ? bibLine + 1 : 1;
    }
    if (file === activePath) {
      revealLine(line);
    } else {
      pendingJumpRef.current = { file, line };
      setActivePath(file);
    }
  };

  // Monaco switches the model in its own (child) effect, which runs before
  // this one — so the model for `activePath` is live when we get here.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.file !== activePath) return;
    pendingJumpRef.current = null;
    revealLine(pending.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  /** Inverse sync entry point: a click in the rendered PDF. */
  const handlePageClick = (page: number, xFromLeftPts: number, yFromTopPts: number) => {
    if (!syncEntries) return;
    const entry = findSourceForPoint(syncEntries, page, xFromLeftPts, yFromTopPts);
    if (entry) jumpToSource(entry);
  };

  /** Forward sync: jump the PDF to the editor's current line. */
  const gotoPdf = () => {
    const editor = editorRef.current;
    if (!syncEntries || !editor) return;
    const line =
      editor.getSelection()?.startLineNumber ?? editor.getPosition()?.lineNumber;
    if (!line) return;
    const entry = findOutputForSource(syncEntries, activePath, line);
    if (entry) pdfRef.current?.scrollToPosition(entry.page, entry.yTop);
  };

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
        <button
          onClick={gotoPdf}
          disabled={!syncEntries}
          title={
            syncEntries
              ? "Jump the PDF to the line under the editor cursor"
              : "Compile first to build the PDF<->source map"
          }
          className="rounded border border-stone/40 px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Go to PDF
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
        <FileBrowser
          files={Object.keys(files).sort()}
          activePath={activePath}
          mainPath={mainPath}
          onOpen={setActivePath}
          onAdd={addFile}
          onRename={renameFile}
          onDelete={deleteFile}
          onSetMain={setMainPath}
        />
        <div className="min-w-0 flex-1 border-r border-ink/10">
          {activePath ? (
            <Editor
              height="100%"
              path={activePath}
              defaultLanguage="latex"
              value={activeSource}
              onChange={(value) =>
                setFiles((f) => ({ ...f, [activePath]: value ?? "" }))
              }
              onMount={(editor) => {
                editorRef.current = editor;
              }}
              theme="homehub"
              beforeMount={defineTheme}
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                wordWrap: "on",
                automaticLayout: true,
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-stone">
              No file selected — add one on the left.
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <PdfViewer ref={pdfRef} data={pdf} onPageClick={handlePageClick} />
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

// Flat file names only: the busytex pipeline writes straight into the
// working directory, and the file browser has no folder support.
function normalizeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes(".."))
    return null;
  return trimmed;
}
