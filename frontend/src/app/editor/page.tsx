"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import PdfViewer, {
  toArrayBuffer,
  type PdfViewerHandle,
} from "@/components/pdf-viewer";
import FileBrowser, {
  fileIcon,
  type FileEntry,
} from "@/components/file-browser";
import {
  IconAuto,
  IconCheck,
  IconClose,
  IconFile,
  IconPlay,
  IconSpinner,
} from "@/components/icons";
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
const DEFAULT_PROJECT_NAME = "LaTeX project";
const STORAGE_KEY = "homehub-latex-project-v1";

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

/** File contents: text files are strings, binary files are byte arrays. */
type FileData = string | Uint8Array;

/** What the project looks like in localStorage (binary as base64). */
type StoredProject = {
  v: 1;
  projectName: string;
  mainPath: string;
  openPaths: string[];
  files: Record<string, string | { b64: string }>;
};

// Extensions read as bytes on upload (everything else is read as text).
// SVG stays text: it is XML, and Monaco can show it.
const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "avif",
  "pdf",
  "pfb",
  "pfa",
  "otf",
  "ttf",
  "woff",
  "woff2",
  "eot",
]);

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
]);

type Status =
  | { kind: "idle" }
  | { kind: "loading"; line: string }
  | { kind: "compiling"; line: string }
  | { kind: "done"; ms: number }
  | { kind: "error"; message: string };

function toB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mimeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "";
  }
}

export default function EditorPage() {
  const [files, setFiles] = useState<Record<string, FileData>>(DEFAULT_FILES);
  // Always-current view of `files` for async handlers (uploads read it while
  // awaiting file bytes, where the render-time closure would be stale).
  const filesRef = useRef(files);
  filesRef.current = files;
  const [activePath, setActivePath] = useState(DEFAULT_MAIN);
  const [openPaths, setOpenPaths] = useState<string[]>([DEFAULT_MAIN]);
  const [mainPath, setMainPath] = useState(DEFAULT_MAIN);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  // True once the saved project (if any) has been loaded from
  // localStorage; persistence is gated on it so defaults can't clobber a
  // saved project before the load effect runs.
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [log, setLog] = useState("");
  const [liveLog, setLiveLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Decoded synctex data for the current PDF (null = no navigation yet).
  const [syncEntries, setSyncEntries] = useState<SyncEntry[] | null>(null);
  const [autoRecompile, setAutoRecompile] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

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
  const pendingJumpRef = useRef<{
    file: string;
    line: number;
    quiet: boolean;
  } | null>(null);
  // Feedback guard for scroll sync: every programmatic scroll (editor OR
  // PDF) stamps this; the scroll handlers of the OTHER side ignore
  // events until it expires, breaking the loop.
  const lockRef = useRef({ until: 0 });
  const autoTimerRef = useRef<number | undefined>(undefined);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  // Refs mirroring state so handlers attached once (Monaco onMount, the
  // PDF viewer's scroll callback) never see stale values.
  const syncEntriesRef = useRef<SyncEntry[] | null>(null);
  syncEntriesRef.current = syncEntries;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const syncScrollRef = useRef(syncScroll);
  syncScrollRef.current = syncScroll;
  const autoRef = useRef(autoRecompile);
  autoRef.current = autoRecompile;
  const compileRef = useRef<() => void>(() => {});

  // --- load saved project (client-only; defaults render first, as SSR
  //     did, so hydration never mismatches) ------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const proj = JSON.parse(raw) as StoredProject;
        if (proj && proj.v === 1 && proj.files) {
          const restored: Record<string, FileData> = {};
          for (const [k, v] of Object.entries(proj.files)) {
            restored[k] = typeof v === "string" ? v : fromB64(v.b64);
          }
          if (Object.keys(restored).length > 0) {
            const main =
              restored[proj.mainPath] !== undefined
                ? proj.mainPath
                : Object.keys(restored)[0];
            const open = (proj.openPaths ?? []).filter(
              (p) => restored[p] !== undefined,
            );
            setFiles(restored);
            setMainPath(main);
            setOpenPaths(open.length ? open : [main]);
            setActivePath(open.length ? open[open.length - 1] : main);
            setProjectName(proj.projectName || DEFAULT_PROJECT_NAME);
          }
        }
      }
    } catch {
      // Corrupt storage — start from the defaults.
    }
    setLoaded(true);
  }, []);

  // --- persist to localStorage (debounced; binary as base64) ------------
  useEffect(() => {
    if (!loaded) return;
    setSaving(true);
    const t = window.setTimeout(() => {
      const proj: StoredProject = {
        v: 1,
        projectName,
        mainPath,
        openPaths: openPaths.filter((p) => files[p] !== undefined),
        files: Object.fromEntries(
          Object.entries(files).map(([k, v]) =>
            [k, typeof v === "string" ? v : { b64: toB64(v) }] as const,
          ),
        ),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(proj));
      } catch {
        // Storage full or unavailable — the session just isn't saved.
      }
      setSaving(false);
    }, 600);
    return () => window.clearTimeout(t);
  }, [files, mainPath, openPaths, projectName, loaded]);

  // --- engine ------------------------------------------------------------
  useEffect(() => {
    const compiler = new BusyTexCompiler();
    compilerRef.current = compiler;
    compiler.init(
      (line) => {
        // Live stream for the log drawer (capped so a chatty engine can't
        // grow it without bound).
        setLiveLog((prev) => {
          const next = prev ? prev + "\n" + line : line;
          const lines = next.split("\n");
          return lines.length > 400 ? lines.slice(-400).join("\n") : next;
        });
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

  useEffect(
    () => () => {
      window.clearTimeout(autoTimerRef.current);
      window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const activeSource: string | null =
    typeof files[activePath] === "string" ? (files[activePath] as string) : null;

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
    setLiveLog("");
    setStatus({ kind: "compiling", line: "preparing…" });
    const started = performance.now();
    try {
      await compiler.init();
      // All files go to the worker (text as strings, binary as bytes);
      // the pipeline runs bibtex8 itself when any of them is a .bib.
      const result = await compiler.compile(files, mainPath);
      // An empty PDF is a failure (a zero-length Uint8Array is truthy).
      if (result.pdf && result.pdf.byteLength > 0) {
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
  compileRef.current = compile;

  // Errors open the log drawer automatically.
  useEffect(() => {
    if (status.kind === "error") setShowLog(true);
  }, [status]);

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
    setOpenPaths((o) => (o.includes(path) ? o : [...o, path]));
    setActivePath(path);
  };

  const renameFile = (oldPath: string, newName: string) => {
    // The rename field shows the full path, so nested files can be renamed
    // in place (or moved between folders) — validate as a path, not a name.
    const path = normalizePath(newName);
    if (!path) {
      setStatus({
        kind: "error",
        message: `Cannot rename to “${newName}” — use a valid path (no empty, “.” or “..” segments)`,
      });
      return;
    }
    if (path === oldPath) return;
    if (files[path] !== undefined) {
      setStatus({
        kind: "error",
        message: `Cannot rename to “${newName}” — name already taken`,
      });
      return;
    }
    setFiles((f) => {
      const next: Record<string, FileData> = {};
      for (const [k, v] of Object.entries(f)) next[k === oldPath ? path : k] = v;
      return next;
    });
    setOpenPaths((o) => o.map((p) => (p === oldPath ? path : p)));
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
    const without = openPaths.filter((p) => p !== path);
    const idx = openPaths.indexOf(path);
    setOpenPaths(without.length ? without : nextMain ? [nextMain] : []);
    setMainPath(nextMain);
    if (activePath === path) {
      setActivePath(without[idx - 1] ?? without[idx] ?? nextMain);
    }
  };

  const openPath = (path: string) => {
    setActivePath(path);
    setOpenPaths((o) => (o.includes(path) ? o : [...o, path]));
  };

  const closeTab = (path: string) => {
    const idx = openPaths.indexOf(path);
    const without = openPaths.filter((p) => p !== path);
    setOpenPaths(without.length ? without : mainPath ? [mainPath] : []);
    if (activePath === path) {
      setActivePath(without[idx - 1] ?? without[idx] ?? mainPath);
    }
  };

  // --- uploads (browser-only: File bytes are read locally, never posted) --
  //
  // Folder uploads (the folder button, or a dropped folder) arrive as one
  // File per entry with a webkitRelativePath like "myproj/figs/a.png"; the
  // top folder is stripped so the tree lands at the project root.

  const uploadFiles = (list: File[]) => {
    void (async () => {
      const added: Record<string, FileData> = {};
      let firstOpen: string | null = null;
      let skipped = 0;
      let droppedFolders = 0;
      for (const f of list) {
        // A folder dragged from the OS arrives in Chromium as a single
        // unreadable File (no relative path, size 0, no type/extension).
        // Skip it — importing it would create a junk row.
        if (
          !f.webkitRelativePath &&
          f.size === 0 &&
          f.type === "" &&
          !f.name.includes(".")
        ) {
          droppedFolders++;
          continue;
        }
        const name =
          f.webkitRelativePath
            ? normalizePath(f.webkitRelativePath.split("/").slice(1).join("/"))
            : normalizeName(f.name);
        // Skip junk paths and dotfiles at any depth (.DS_Store, .git, …).
        if (!name || name.split("/").some((p) => p.startsWith("."))) continue;
        if (filesRef.current[name] !== undefined) {
          skipped++;
          continue; // never overwrite existing work
        }
        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
        const isBinary = BINARY_EXT.has(ext);
        let data: FileData;
        try {
          data = isBinary
            ? new Uint8Array(await f.arrayBuffer())
            : await f.text();
        } catch {
          continue; // unreadable file — skip it
        }
        added[name] = data;
        // Prefer a .tex file; otherwise the first text file.
        if (!isBinary && (firstOpen === null || (name.endsWith(".tex") && !firstOpen.endsWith(".tex")))) {
          firstOpen = name;
        }
      }
      const count = Object.keys(added).length;
      const folderNote =
        droppedFolders > 0
          ? ` (${droppedFolders} dropped folder${droppedFolders === 1 ? "" : "s"} can't be read by the browser — use the folder button)`
          : "";
      if (count > 0) {
        setFiles((prev) => ({ ...prev, ...added }));
        if (firstOpen) openPath(firstOpen);
        setNotice(
          `Uploaded ${count} file${count === 1 ? "" : "s"} — kept in your browser` +
            (skipped ? ` (${skipped} already existed, skipped)` : "") +
            folderNote,
        );
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3000);
      } else if (skipped > 0) {
        setNotice(
          `Nothing uploaded — ${skipped} file${skipped === 1 ? " was" : "s were"} already in the project` +
            folderNote,
        );
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3000);
      } else if (droppedFolders > 0) {
        setNotice(
          `Dropped folder${droppedFolders === 1 ? "" : "s"} can't be read by the browser — use the folder button to import it`,
        );
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3000);
      }
    })();
  };

  // --- PDF <-> source navigation (synctex) ------------------------------

  /**
   * Move the Monaco cursor to a line and reveal it. `flash` adds the mint
   * highlight (click jumps); `select` highlights the whole line. Sync
   * scroll uses both off — it only follows, it never draws attention.
   */
  const revealLine = (
    line: number,
    opts?: { flash?: boolean; select?: boolean },
  ) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: line, column: 1 });
    if (opts?.select !== false) {
      editor.setSelection({
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: Infinity,
      });
    }
    editor.revealLineInCenter(line);
    if (opts?.flash === false) return;
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
  const jumpToSource = (entry: SyncEntry, quiet = false) => {
    // The synctex file only names files TeX itself read; content coming
    // from a .bbl (via \bibliography) is attributed to the .bbl, which is
    // not part of the project — land on the \bibliography line instead.
    const file = files[entry.file] !== undefined ? entry.file : mainPath;
    let line = entry.line;
    if (file !== entry.file) {
      const main = files[mainPath];
      if (typeof main === "string") {
        const bibLine = main
          .split("\n")
          .findIndex((l) => /\\bibliography\s*{/.test(l));
        line = bibLine >= 0 ? bibLine + 1 : 1;
      }
    }
    // A programmatic editor scroll follows; stop it from bouncing the
    // PDF back (sync-scroll feedback loop).
    lockRef.current.until = Date.now() + 500;
    if (file === activePath) {
      revealLine(line, { flash: !quiet, select: !quiet });
    } else {
      pendingJumpRef.current = { file, line, quiet };
      setActivePath(file);
    }
  };

  // Monaco switches the model in its own (child) effect, which runs before
  // this one — so the model for `activePath` is live when we get here.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.file !== activePath) return;
    pendingJumpRef.current = null;
    lockRef.current.until = Date.now() + 500;
    revealLine(pending.line, {
      flash: !pending.quiet,
      select: !pending.quiet,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  /** Inverse sync entry point: a click in the rendered PDF. */
  const handlePageClick = (
    page: number,
    xFromLeftPts: number,
    yFromTopPts: number,
  ) => {
    if (!syncEntries) return;
    const entry = findSourceForPoint(syncEntries, page, xFromLeftPts, yFromTopPts);
    if (entry) jumpToSource(entry, false);
  };

  /** Forward sync: jump the PDF to the editor's current line. */
  const gotoPdf = () => {
    const editor = editorRef.current;
    if (!syncEntries || !editor) return;
    const line =
      editor.getSelection()?.startLineNumber ?? editor.getPosition()?.lineNumber;
    if (!line) return;
    const entry = findOutputForSource(syncEntries, activePath, line);
    if (!entry) return;
    lockRef.current.until = Date.now() + 500;
    pdfRef.current?.scrollToPosition(entry.page, entry.yTop, {
      select: true,
      instant: false,
    });
  };

  // --- scroll sync (two-way, guarded by lockRef) --------------------------

  /** Editor scrolled: the PDF follows the editor's top visible line. */
  const handleEditorScroll = () => {
    const now = Date.now();
    if (!syncScrollRef.current || lockRef.current.until > now) return;
    const editor = editorRef.current;
    const entries = syncEntriesRef.current;
    if (!editor || !entries) return;
    const ranges = editor.getVisibleRanges();
    if (ranges.length === 0) return;
    const line = ranges[0].startLineNumber;
    const entry = findOutputForSource(entries, activePathRef.current, line);
    if (!entry) return;
    lockRef.current.until = now + 500;
    pdfRef.current?.scrollToPosition(entry.page, entry.yTop, {
      select: false,
      instant: true,
    });
  };

  /** PDF scrolled: the editor follows the topmost visible line. */
  const handleViewportTop = (page: number, yTopPts: number) => {
    const now = Date.now();
    if (!syncScrollRef.current || lockRef.current.until > now) return;
    const entries = syncEntriesRef.current;
    if (!entries) return;
    // x = 0: for scroll-following the leftmost line of the physical line
    // is the right one (single-column documents).
    const entry = findSourceForPoint(entries, page, 0, yTopPts);
    if (!entry) return;
    lockRef.current.until = now + 500;
    jumpToSource(entry, true);
  };

  const entries: FileEntry[] = useMemo(
    () =>
      Object.keys(files)
        .sort()
        .map((p) => ({ path: p, isBinary: typeof files[p] !== "string" })),
    [files],
  );

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
    <div className="relative flex h-screen flex-col bg-cream">
      {/* Top bar (Overleaf-style) */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-ink/10 bg-cream px-3">
        <h1 className="flex shrink-0 items-center gap-2 text-sm font-semibold text-ink">
          <span className="h-3 w-3 rounded-sm bg-mint" />
          HomeHub
        </h1>
        <span className="h-4 w-px shrink-0 bg-ink/10" />
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          title="Project name (saved in your browser)"
          className="w-44 shrink rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium text-ink transition-colors hover:border-ink/15 focus:border-mint focus:outline-none"
        />
        <span className="shrink-0 text-xs text-stone">
          {saving ? "Saving…" : "Saved"}
        </span>

        <div className="flex min-w-0 flex-1 justify-center">
          <div className="flex items-center gap-2">
            <button
              onClick={() => compileRef.current()}
              disabled={status.kind === "compiling"}
              title="Recompile (Ctrl/Cmd+Enter)"
              className="flex items-center gap-1.5 rounded-full bg-mint px-4 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconPlay className="h-3.5 w-3.5" />
              Recompile
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
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status.kind === "compiling" || status.kind === "loading" ? (
            <IconSpinner className="h-3.5 w-3.5 shrink-0 animate-spin text-mint" />
          ) : status.kind === "error" ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
          ) : status.kind === "done" ? (
            <IconCheck className="h-3.5 w-3.5 shrink-0 text-mint" />
          ) : null}
          <span
            className={
              "min-w-0 max-w-64 truncate text-xs " +
              (status.kind === "error" ? "text-red-600" : "text-stone")
            }
          >
            {statusText}
          </span>
          <button
            title={
              autoRecompile
                ? "Auto recompile: on (after you stop typing)"
                : "Auto recompile: off (press Recompile or Ctrl/Cmd+Enter)"
            }
            onClick={() => setAutoRecompile((v) => !v)}
            className={
              "rounded p-1 transition-colors " +
              (autoRecompile
                ? "bg-mint/30 text-ink hover:bg-mint/30"
                : "text-stone hover:bg-peach/40 hover:text-ink")
            }
          >
            <IconAuto className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowLog((v) => !v)}
            className="rounded border border-stone/40 px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
          >
            {showLog ? "Hide log" : "View log"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <FileBrowser
          files={entries}
          activePath={activePath}
          mainPath={mainPath}
          onOpen={openPath}
          onAdd={addFile}
          onRename={renameFile}
          onDelete={deleteFile}
          onSetMain={setMainPath}
          onUpload={uploadFiles}
        />

        {/* Editor pane: Overleaf-style tabs + editor (or binary preview) */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-ink/10 bg-white">
          <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b border-ink/10 bg-cream/70">
            {openPaths.map((p) => {
              const active = p === activePath;
              return (
                <div
                  key={p}
                  data-tab={p}
                  data-active={active || undefined}
                  onClick={() => setActivePath(p)}
                  title={p}
                  className={
                    "group flex h-full max-w-52 shrink-0 cursor-pointer items-center gap-1.5 border-r border-t-2 border-r-ink/10 px-3 text-xs " +
                    (active
                      ? "border-t-mint bg-white font-medium text-ink"
                      : "border-t-transparent bg-transparent text-stone hover:bg-white/70 hover:text-ink")
                  }
                >
                  <span className="shrink-0">
                    {fileIcon(p, typeof files[p] !== "string")}
                  </span>
                  <span className="truncate">{p}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(p);
                    }}
                    title="Close tab"
                    className="shrink-0 rounded p-0.5 text-stone opacity-0 transition-opacity hover:bg-peach/60 hover:text-ink group-hover:opacity-100"
                  >
                    <IconClose className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="min-h-0 flex-1">
            {activePath && activeSource !== null ? (
              <Editor
                height="100%"
                path={activePath}
                defaultLanguage="latex"
                value={activeSource}
                onChange={(value) => {
                  const path = activePath;
                  setFiles((f) => ({ ...f, [path]: value ?? "" }));
                  // Auto recompile (toggleable): after a short pause once
                  // you stop typing, only when the engine is ready.
                  if (autoRef.current && engineReadyRef.current) {
                    window.clearTimeout(autoTimerRef.current);
                    autoTimerRef.current = window.setTimeout(
                      () => compileRef.current(),
                      1200,
                    );
                  }
                }}
                onMount={(editor, m) => {
                  editorRef.current = editor;
                  // Overleaf's recompile binding.
                  editor.addCommand(
                    m.KeyMod.CtrlCmd | m.KeyCode.Enter,
                    () => {
                      compileRef.current();
                    },
                  );
                  editor.onDidScrollChange((e) => {
                    if (e.scrollTopChanged) handleEditorScroll();
                  });
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
            ) : activePath ? (
              <BinaryPreview
                name={activePath}
                data={files[activePath] as Uint8Array}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-stone">
                No file selected — add one on the left.
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <PdfViewer
            ref={pdfRef}
            data={pdf}
            onPageClick={handlePageClick}
            downloadName={
              mainPath.endsWith(".tex")
                ? mainPath.slice(0, -4) + ".pdf"
                : "output.pdf"
            }
            syncScroll={syncScroll}
            onToggleSyncScroll={() => setSyncScroll((v) => !v)}
            onViewportTop={handleViewportTop}
          />
        </div>
      </div>

      {showLog && (
        <div className="max-h-56 shrink-0 overflow-auto border-t border-ink/10 bg-peach/50 p-3">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink">
            {(status.kind === "compiling" || status.kind === "loading"
              ? liveLog
              : log) || "(no log output yet)"}
          </pre>
        </div>
      )}

      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-ink/10 bg-white px-4 py-1.5 text-xs font-medium text-ink shadow-sm">
          {notice}
        </div>
      )}
    </div>
  );
}

/**
 * Placeholder for binary files (images, PDFs, fonts, …): images get an
 * in-browser preview via an object URL; the bytes stay local and are only
 * ever handed to the WASM compiler.
 */
function BinaryPreview({ name, data }: { name: string; data: Uint8Array }) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const isImage = IMAGE_EXT.has(ext);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(
      new Blob([toArrayBuffer(data)], { type: mimeOf(name) }),
    );
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, isImage, name]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto bg-cream p-6 text-center">
      {url ? (
        <img
          src={url}
          alt={name}
          className="max-h-full max-w-full rounded border border-ink/10 bg-white object-contain shadow-sm"
        />
      ) : (
        <IconFile className="h-10 w-10 text-stone/40" />
      )}
      <p className="text-sm font-medium text-ink">{name}</p>
      <p className="max-w-sm text-xs text-stone">
        Binary file ({data.byteLength.toLocaleString()} bytes) — not editable
        here. It is available to the compiler in your browser; it is never
        sent to a server.
      </p>
    </div>
  );
}

function lastLine(line: string, prev: string) {
  const trimmed = line.trim();
  if (trimmed.length <= 80) return trimmed;
  return prev.length > trimmed.length ? prev : trimmed.slice(0, 80) + "…";
}

// Flat file names for manual entry (new file / rename).
function normalizeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes(".."))
    return null;
  return trimmed;
}

// Nested paths from folder uploads (webkitRelativePath with the top folder
// stripped): the pipeline writes them straight into the project tree, so
// \includegraphics{figs/a.png} just works.
function normalizePath(path: string): string | null {
  const parts = path.split("/");
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") return null;
    if (trimmed.includes("\\")) return null;
  }
  return parts.map((p) => p.trim()).join("/");
}
