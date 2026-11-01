"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type BeforeMount, type Monaco } from "@monaco-editor/react";
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
  /** Active tab on load (restored when the file is still open). */
  activePath?: string;
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
  // Set when a save failed (quota): the header must not claim “Saved”.
  const [saveError, setSaveError] = useState<string | null>(null);
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
  // The Monaco namespace (from the editor's onMount), for disposing models
  // on rename/delete — Monaco models are keyed by path and never disposed
  // otherwise, so a rename-back would resurrect pre-rename content.
  const monacoRef = useRef<Monaco | null>(null);
  // An edit (or manual Recompile) arrived while a compile was running; the
  // finishing compile retries once, because the debounce that fired it
  // can't retry itself.
  const recompileQueuedRef = useRef(false);
  // The PDF's scroll position before the latest compile; restored once the
  // new PDF renders (pdf.js renders async — the effect below polls).
  const pendingScrollRef = useRef<{ page: number; yTop: number } | null>(null);
  // Set when the stored project was unreadable: the first persistence run
  // (which would write the defaults over it) is skipped.
  const skipNextSaveRef = useRef(false);
  // uploadFiles is redefined every render; the window-level drop handler
  // (attached once) calls it through this ref.
  const uploadFilesRef = useRef<(list: File[], dropped?: DroppedTree) => void>(
    () => {},
  );
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
    let corrupt = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const proj = JSON.parse(raw) as StoredProject;
        if (
          proj &&
          proj.v === 1 &&
          proj.files &&
          typeof proj.files === "object"
        ) {
          const restored: Record<string, FileData> = {};
          for (const [k, v] of Object.entries(proj.files)) {
            if (typeof v === "string") {
              restored[k] = v;
            } else {
              try {
                restored[k] = fromB64(v.b64);
              } catch {
                corrupt = true; // a base64 entry that doesn't decode
                break;
              }
            }
          }
          if (!corrupt && Object.keys(restored).length === 0) {
            corrupt = true; // a saved project always has at least one file
          }
          if (!corrupt) {
            const main = Object.hasOwn(restored, proj.mainPath)
              ? proj.mainPath
              : Object.keys(restored)[0];
            const open = (proj.openPaths ?? []).filter((p) =>
              Object.hasOwn(restored, p),
            );
            // Prefer the tab that was active when the session ended.
            const active =
              proj.activePath &&
              Object.hasOwn(restored, proj.activePath) &&
              open.includes(proj.activePath)
                ? proj.activePath
                : open.length
                  ? open[open.length - 1]
                  : main;
            setFiles(restored);
            setMainPath(main);
            setOpenPaths(open.length ? open : [main]);
            setActivePath(active);
            setProjectName(proj.projectName || DEFAULT_PROJECT_NAME);
          }
        } else {
          corrupt = true;
        }
      }
    } catch {
      corrupt = true; // unparseable storage
    }
    if (corrupt) {
      // Start from the defaults, but don't let the first persistence run
      // write them over the unreadable project. (showNotice is created per
      // render, so the notice is set inline here.)
      skipNextSaveRef.current = true;
      setNotice("Couldn't read the saved project — starting fresh");
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = window.setTimeout(() => setNotice(null), 8000);
    }
    setLoaded(true);
  }, []);

  // --- persist to localStorage (debounced; binary as base64) ------------
  useEffect(() => {
    if (!loaded) return;
    if (skipNextSaveRef.current) {
      // The stored project was unreadable; the first run would overwrite
      // it with the defaults. Skip it — the next real edit saves normally.
      skipNextSaveRef.current = false;
      return;
    }
    setSaving(true);
    const t = window.setTimeout(() => {
      const proj: StoredProject = {
        v: 1,
        projectName,
        mainPath,
        openPaths: openPaths.filter((p) => Object.hasOwn(files, p)),
        activePath,
        files: Object.fromEntries(
          Object.entries(files).map(([k, v]) =>
            [k, typeof v === "string" ? v : { b64: toB64(v) }] as const,
          ),
        ),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(proj));
        setSaveError(null);
      } catch {
        // Quota exceeded or storage unavailable: the session isn't saved —
        // the header says so instead of claiming “Saved”.
        setSaveError("Storage is full — changes are not being saved");
      }
      setSaving(false);
    }, 600);
    return () => window.clearTimeout(t);
  }, [files, mainPath, openPaths, activePath, projectName, loaded]);

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
      (msg) => {
        // A failure outside a compile (an init-time asset load failing, a
        // worker crash). The worker is already disposed and the next
        // compile recreates it — but the header must not sit on
        // "Loading engine…" forever, and the error must be visible.
        setLiveLog((prev) => {
          const next = prev ? prev + "\n" + msg : msg;
          const lines = next.split("\n");
          return lines.length > 400 ? lines.slice(-400).join("\n") : next;
        });
        setStatus((s) =>
          s.kind === "compiling"
            ? s
            : { kind: "error", message: "Engine failed to load — see log" },
        );
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
    if (!compiler) return;
    if (busyRef.current) {
      // An edit (or a manual Recompile) arrived mid-compile. The debounce
      // that fired it can't retry itself, so the finishing compile does.
      recompileQueuedRef.current = true;
      return;
    }
    if (!mainPath || !Object.hasOwn(files, mainPath)) {
      setStatus({
        kind: "error",
        message: "No main .tex file — add one and mark it “main”",
      });
      return;
    }
    busyRef.current = true;
    // Remember the PDF's scroll position so the new PDF can restore it —
    // a recompile must not yank the reader back to the top of page 1.
    pendingScrollRef.current = pdfRef.current?.getViewportTop() ?? null;
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
      // Input-table paths are resolved against the project files so a
      // nested \input maps to its real path, not its basename.
      if (result.pdf && result.synctex) {
        setSyncEntries(
          await decodeSynctex(result.synctex, Object.keys(files), mainPath).catch(
            () => null,
          ),
        );
      } else {
        setSyncEntries(null);
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
      if (recompileQueuedRef.current) {
        recompileQueuedRef.current = false;
        // Let the state above settle, then recompile through the
        // always-current ref so the latest files are picked up.
        window.setTimeout(() => compileRef.current(), 0);
      }
    }
  }, [files, mainPath]);
  compileRef.current = compile;

  // Errors open the log drawer automatically.
  useEffect(() => {
    if (status.kind === "error") setShowLog(true);
  }, [status]);

  // Restore the PDF scroll position after a recompile. The new PDF is a
  // fresh document that pdf.js renders asynchronously, so poll until the
  // page exists (up to ~6 s).
  useEffect(() => {
    const target = pendingScrollRef.current;
    // The viewer is cleared (setPdf(null)) before the new PDF arrives and
    // this effect runs on that intermediate state — don't consume the
    // target then, or the run with the new pdf would find it gone.
    if (!pdf || !target) return;
    pendingScrollRef.current = null;
    let tries = 0;
    let timer: number | undefined;
    const tick = () => {
      if (
        pdfRef.current?.scrollToPosition(target.page, target.yTop, {
          select: false,
          instant: true,
        })
      ) {
        lockRef.current.until = Date.now() + 500;
        return;
      }
      if (++tries >= 60) return;
      timer = window.setTimeout(tick, 100);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [pdf]);

  // --- file operations -------------------------------------------------

  /** Dispose Monaco's model for a path so the next open of that path starts
   * from the current value. Models are keyed by path and never disposed
   * otherwise — a rename-back would resurrect the pre-rename model. */
  const disposeModel = (path: string) => {
    const m = monacoRef.current;
    if (!m) return;
    for (const model of m.editor.getModels()) {
      if (model.uri.path === path) model.dispose();
    }
  };

  const addFile = (name: string) => {
    const path = normalizeName(name);
    if (!path) {
      showNotice(
        `Cannot create “${name}” — use a flat name (no folders or reserved names)`,
      );
      return;
    }
    if (Object.hasOwn(files, path)) {
      showNotice(`“${path}” already exists`);
      return;
    }
    if (pathIsFolder(Object.keys(files), path)) {
      showNotice(`“${path}” is a folder in this project`);
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
      showNotice(
        `Cannot rename to “${newName}” — use a valid path (no empty, “.” or “..” segments)`,
      );
      return;
    }
    if (path === oldPath) return;
    if (Object.hasOwn(files, path)) {
      showNotice(`Cannot rename to “${newName}” — name already taken`);
      return;
    }
    if (
      pathUnderFile(Object.keys(files), path) ||
      pathIsFolder(Object.keys(files), path)
    ) {
      showNotice(
        `Cannot rename to “${newName}” — it would collide with an existing file or folder`,
      );
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
    // Drop the models for BOTH paths: the old one holds pre-rename content
    // (a rename-back would resurrect it), and a stale model at the new path
    // could do the same in the other direction.
    disposeModel(oldPath);
    disposeModel(path);
  };

  const deleteFile = (path: string) => {
    const rest = Object.keys(files).filter((p) => p !== path);
    // Only a .tex file can be the main file — if none remains, the project
    // has no build target (the header says so on the next compile) instead
    // of silently picking refs.bib.
    const nextMain =
      path === mainPath
        ? (rest.find((p) => p.toLowerCase().endsWith(".tex")) ?? "")
        : mainPath;
    setFiles((f) => {
      const next = { ...f };
      delete next[path];
      return next;
    });
    disposeModel(path);
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
  // Folder uploads from the folder button arrive as one File per entry with
  // a webkitRelativePath like "myproj/figs/a.png"; the top folder is stripped
  // so the tree lands at the project root. Dropped folders have no such path:
  // the drop handler walks them and passes the project paths in `dropped`.

  /** A pill at the bottom of the page, auto-clearing after `ms`. */
  const showNotice = (msg: string, ms = 3000) => {
    setNotice(msg);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), ms);
  };

  const uploadFiles = (list: File[], dropped?: DroppedTree) => {
    void (async () => {
      const added: Record<string, FileData> = {};
      let firstOpen: string | null = null;
      let skippedJunk = 0;
      let droppedFolders = dropped?.unreadable ?? 0;
      for (const f of list) {
        const droppedPath = dropped?.paths.get(f);
        // Without the entry API a folder dragged from the OS arrives as one
        // unreadable File (no relative path), so fall back to a heuristic —
        // a 0-byte, typeless file with no extension.
        if (
          droppedPath === undefined &&
          !f.webkitRelativePath &&
          f.size === 0 &&
          f.type === "" &&
          !f.name.includes(".")
        ) {
          droppedFolders++;
          continue;
        }
        const name =
          droppedPath !== undefined
            ? normalizePath(droppedPath)
            : f.webkitRelativePath
              ? normalizePath(f.webkitRelativePath.split("/").slice(1).join("/"))
              : normalizeName(f.name);
        // Skip junk paths and dotfiles at any depth (.DS_Store, .git, …).
        if (
          !name ||
          name
            .split("/")
            .some((p) => p.startsWith(".") || RESERVED_NAMES.has(p.toLowerCase()))
        ) {
          skippedJunk++;
          continue;
        }
        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
        const isBinary = BINARY_EXT.has(ext);
        let data: FileData;
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          // Text is decoded as STRICT UTF-8; bytes that are not valid
          // UTF-8 are kept raw instead of being mangled with U+FFFD.
          data = isBinary ? buf : (decodeText(buf) ?? buf);
        } catch {
          droppedFolders++;
          continue; // unreadable file — skip it
        }
        added[name] = data;
        // Prefer a .tex file; otherwise the first text file.
        if (
          typeof data === "string" &&
          (firstOpen === null ||
            (name.toLowerCase().endsWith(".tex") &&
              !firstOpen.toLowerCase().endsWith(".tex")))
        ) {
          firstOpen = name;
        }
      }
      // A slow import can race a second drop or user edits, so re-check
      // against the current files and count the notice from what actually
      // lands.
      const merged: Record<string, FileData> = {};
      let skippedExisting = 0;
      for (const [k, v] of Object.entries(added)) {
        if (Object.hasOwn(filesRef.current, k)) {
          skippedExisting++;
          continue; // never overwrite existing work
        }
        merged[k] = v;
      }
      if (firstOpen && !Object.hasOwn(merged, firstOpen)) firstOpen = null;
      const count = Object.keys(merged).length;
      if (count === 0 && skippedExisting === 0 && skippedJunk === 0 && droppedFolders === 0) {
        showNotice("Nothing uploaded — the folder is empty");
        return;
      }
      const folderNote =
        droppedFolders > 0
          ? ` — ${droppedFolders} dropped folder${droppedFolders === 1 ? "" : "s"} can't be read by the browser, use the folder button`
          : "";
      if (count > 0) {
        setFiles((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(merged)) {
            if (!Object.hasOwn(prev, k)) next[k] = v;
          }
          return next;
        });
        if (firstOpen) openPath(firstOpen);
        showNotice(
          `Uploaded ${count} file${count === 1 ? "" : "s"} — kept in your browser` +
            (skippedExisting
              ? ` (${skippedExisting} already existed, skipped)`
              : "") +
            (skippedJunk
              ? ` (${skippedJunk} skipped: dotfiles or reserved names)`
              : "") +
            folderNote,
          droppedFolders > 0 ? 8000 : 3000,
        );
      } else {
        showNotice(
          `Nothing uploaded — ` +
            [
              skippedExisting > 0
                ? `${skippedExisting} file${skippedExisting === 1 ? " was" : "s were"} already in the project`
                : "",
              skippedJunk > 0
                ? `${skippedJunk} skipped (dotfiles or reserved names)`
                : "",
              droppedFolders > 0
                ? `the ${droppedFolders} dropped folder${droppedFolders === 1 ? " can" : "s can"}'t be read by the browser — use the folder button to import it`
                : "",
            ]
              .filter(Boolean)
              .join("; "),
          droppedFolders > 0 ? 8000 : 3000,
        );
      }
    })();
  };
  uploadFilesRef.current = uploadFiles;

  // Window-level drop guard (capture phase): files dropped ANYWHERE must
  // not navigate the page away (a file:// Security Error) — and real drops
  // are imported through the same path as the Files panel. The panel's own
  // drop handler stays as a fallback; this one stops propagation only when
  // it handles the drop.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (!types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      if (!dt) return;
      // Entries must be taken now: the DataTransfer is emptied once this
      // handler returns. A synthetic drop has no entries → uploadFiles gets
      // the plain file list and its heuristic applies.
      const entries: FileSystemEntry[] = [];
      for (const item of Array.from(dt.items)) {
        try {
          const entry = item.webkitGetAsEntry?.();
          if (entry) entries.push(entry);
        } catch {
          // entry unreadable — fall back to the heuristic
        }
      }
      if (entries.length === 0) {
        uploadFilesRef.current(Array.from(dt.files));
        return;
      }
      void readDroppedEntries(entries).then((dropped) =>
        uploadFilesRef.current([...dropped.paths.keys()], dropped),
      );
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, []);

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
      // Open the file as a tab if it isn't open yet — switching the active
      // path alone would leave the editor pane empty for an unopened file.
      pendingJumpRef.current = { file, line, quiet };
      openPath(file);
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
        <span
          title={saveError ?? undefined}
          className={
            "shrink-0 text-xs " + (saveError ? "text-red-600" : "text-stone")
          }
        >
          {saving ? "Saving…" : saveError ? "Not saved" : "Saved"}
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
            onClick={() => {
              // Turning auto recompile off must cancel a pending one —
              // otherwise it still fires 1.2 s after the last keystroke.
              if (autoRecompile) window.clearTimeout(autoTimerRef.current);
              setAutoRecompile(!autoRecompile);
            }}
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
                  monacoRef.current = m;
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
              mainPath.toLowerCase().endsWith(".tex")
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

// File names that collide with Object.prototype. Storing them as keys of
// the plain `files` object would shadow the inherited members (and a
// `files[name] !== undefined` lookup would hit them), so they are refused
// outright and every lookup uses Object.hasOwn.
const RESERVED_NAMES = new Set(["constructor", "__proto__", "prototype"]);

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
function decodeText(buf: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** True when `path` would live under an existing file (a file can't be a
 * directory). */
function pathUnderFile(all: string[], path: string): boolean {
  return all.some((p) => p !== path && path.startsWith(p + "/"));
}

/** True when files already exist under `path` (it is used as a folder). */
function pathIsFolder(all: string[], path: string): boolean {
  return all.some((p) => p.startsWith(path + "/"));
}

// Flat file names for manual entry (new file / rename). “v1..2.tex” is a
// legal name — only the literal paths “.” and “..” are rejected.
function normalizeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (RESERVED_NAMES.has(trimmed.toLowerCase())) return null;
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

/** A dropped selection: each file with its project path, plus how many
 * entries could not be read. */
type DroppedTree = { paths: Map<File, string>; unreadable: number };

// A single dropped folder lands at the project root, like the folder button.
// Dropped alongside anything else it keeps its name, so same-named files in
// different folders can't collide.
async function readDroppedEntries(
  entries: FileSystemEntry[],
): Promise<DroppedTree> {
  const tree: DroppedTree = { paths: new Map(), unreadable: 0 };
  const stripTop = entries.length === 1 && entries[0].isDirectory;
  await Promise.all(
    entries.map((e) => readEntry(e, stripTop ? "" : e.name, tree)),
  );
  return tree;
}

async function readEntry(
  entry: FileSystemEntry,
  path: string,
  tree: DroppedTree,
): Promise<void> {
  try {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      tree.paths.set(file, path);
      return;
    }
    // readEntries returns one batch per call (100 in Chromium); an empty
    // batch marks the end.
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      children.push(...batch);
    }
    await Promise.all(
      children.map((c) =>
        readEntry(c, path ? `${path}/${c.name}` : c.name, tree),
      ),
    );
  } catch {
    tree.unreadable++;
  }
}
