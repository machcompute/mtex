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
  IconChevronDown,
  IconClose,
  IconFile,
  IconGitHub,
  IconPlay,
  IconPlus,
  IconSpinner,
  IconTrash,
} from "@/components/icons";
import GitHubModal, { type PullRequest } from "@/components/github-modal";
import { BusyTexCompiler } from "@/lib/busytex";
import {
  ACTIVE_PROJECT_KEY,
  BINARY_EXT,
  RESERVED_NAMES,
  createProject,
  decodeText,
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
  type FileData,
  type ProjectMeta,
  type ProjectSummary,
} from "@/lib/opfs";
import { MAX_PULL_FILES } from "@/lib/github";
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
  // The OPFS project this session edits (null until the load effect
  // resolves, or forever when storage is unavailable).
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const [ghModalOpen, setGhModalOpen] = useState(false);
  // True once a project has been loaded from OPFS (or the attempt failed);
  // persistence is gated on it so defaults can't be written before the load
  // effect has settled.
  const [loaded, setLoaded] = useState(false);
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
  // True while consecutive saves are failing (OPFS unavailable/full): the
  // failure notice is raised once per failure run, not on every debounced
  // save.
  const saveFailedRef = useRef(false);
  // The FileData refs each path was last persisted with; saveProject diffs
  // against this, so a keystroke rewrites one file, not the whole tree.
  const savedRefsRef = useRef<Map<string, FileData>>(new Map());
  // The last persisted (normalized) meta of the active project.
  const metaRef = useRef<ProjectMeta | null>(null);
  // Always-current persistence inputs for the debounced and async save
  // paths (a closure made at render time would be stale 600 ms later).
  const persistStateRef = useRef({
    files,
    mainPath,
    openPaths,
    activePath,
    projectName,
    activeProjectId,
    loaded,
  });
  persistStateRef.current = {
    files,
    mainPath,
    openPaths,
    activePath,
    projectName,
    activeProjectId,
    loaded,
  };
  // True while a project switch/new/delete is in flight; keeps a second
  // one from starting.
  const switchingRef = useRef(false);
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

  /**
   * Point the editor at a freshly loaded project: files, the meta-derived
   * main/open/active state, and the persisted refs. Resets everything a
   * previous project left behind (PDF, log, sync map, pending recompile)
   * and disposes the OUTGOING project's Monaco models — models are keyed by
   * path and survive project switches, so a same-named path in the new
   * project would resurrect the old project's content.
   */
  const applyProject = (
    id: string,
    meta: ProjectMeta,
    files: Record<string, FileData>,
    list: ProjectSummary[],
  ) => {
    const m = monacoRef.current;
    if (m) {
      const outgoing = new Set(Object.keys(filesRef.current));
      for (const model of m.editor.getModels()) {
        if (outgoing.has(model.uri.path)) model.dispose();
      }
    }
    // The stored main wins; otherwise the first .tex, mirroring deleteFile —
    // a project without any .tex has NO main ("") rather than a .bib picked
    // up as first key.
    const main = Object.hasOwn(files, meta.mainPath)
      ? meta.mainPath
      : (Object.keys(files).find((p) => p.toLowerCase().endsWith(".tex")) ?? "");
    const open = (meta.openPaths ?? []).filter((p) => Object.hasOwn(files, p));
    const openPathsNorm = open.length ? open : main ? [main] : [];
    // Prefer the tab that was active when the session last left this project.
    const active =
      meta.activePath &&
      Object.hasOwn(files, meta.activePath) &&
      open.includes(meta.activePath)
        ? meta.activePath
        : open.length
          ? open[open.length - 1]
          : main;
    metaRef.current = {
      ...meta,
      name: meta.name || DEFAULT_PROJECT_NAME,
      mainPath: main,
      openPaths: openPathsNorm,
      activePath: active,
    };
    savedRefsRef.current = new Map(Object.entries(files));
    setActiveProjectId(id);
    setProjects(list);
    setFiles(files);
    setMainPath(main);
    setOpenPaths(openPathsNorm);
    setActivePath(active);
    setProjectName(meta.name || DEFAULT_PROJECT_NAME);
    // The PDF/log/sync belong to the previous project's build.
    setPdf(null);
    setLog("");
    setLiveLog("");
    setSyncEntries(null);
    setStatus({ kind: "idle" });
    window.clearTimeout(autoTimerRef.current);
    try {
      localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    } catch {
      // best effort: the project is in memory regardless
    }
  };

  // --- load the active project from OPFS (client-only; defaults render
  //     first, as SSR did, so hydration never mismatches) -----------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let list = await listProjects();
        if (list.length === 0) {
          // First run: the default project IS the starting point.
          const now = Date.now();
          const id = await createDefaultProjectOnce();
          list = [
            {
              v: 1,
              name: DEFAULT_PROJECT_NAME,
              mainPath: DEFAULT_MAIN,
              openPaths: [DEFAULT_MAIN],
              activePath: DEFAULT_MAIN,
              createdAt: now,
              updatedAt: now,
              id,
            },
          ];
        }
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(ACTIVE_PROJECT_KEY);
        } catch {
          stored = null;
        }
        const picked =
          (stored ? list.find((p) => p.id === stored) : undefined) ?? list[0];
        const { meta, files: loadedFiles } = await loadProject(picked.id);
        if (cancelled) return;
        applyProject(picked.id, meta, loadedFiles, list);
      } catch {
        if (!cancelled) {
          // OPFS unavailable: the session still works in memory, but nothing
          // is persisted (activeProjectId stays null).
          setNotice("Storage unavailable — changes are not being saved");
          window.clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = window.setTimeout(
            () => setNotice(null),
            8000,
          );
        }
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- persist the active project to OPFS (debounced, diff-based) --------
  const persistNow = useCallback(async () => {
    const s = persistStateRef.current;
    const meta = metaRef.current;
    if (!s.loaded || !s.activeProjectId || !meta) return;
    const nextMeta: ProjectMeta = {
      ...meta,
      name: s.projectName || DEFAULT_PROJECT_NAME,
      mainPath: s.mainPath,
      openPaths: s.openPaths.filter((p) => Object.hasOwn(s.files, p)),
      activePath: s.activePath,
    };
    try {
      await saveProject(s.activeProjectId, nextMeta, s.files, savedRefsRef.current);
      savedRefsRef.current = new Map(Object.entries(s.files));
      metaRef.current = { ...nextMeta, updatedAt: Date.now() };
      saveFailedRef.current = false;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === s.activeProjectId
            ? { ...p, name: nextMeta.name, updatedAt: metaRef.current!.updatedAt }
            : p,
        ),
      );
    } catch {
      // Storage unavailable or full: the session isn't saved. Notice once
      // per failure run — the debounced save would re-raise it on every
      // edit otherwise.
      if (!saveFailedRef.current) {
        saveFailedRef.current = true;
        setNotice("Storage unavailable — changes are not being saved");
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 8000);
      }
    }
  }, []);

  useEffect(() => {
    if (!loaded || !activeProjectId) return;
    const t = window.setTimeout(() => {
      void persistNow();
    }, 600);
    return () => window.clearTimeout(t);
  }, [files, mainPath, openPaths, activePath, projectName, loaded, activeProjectId, persistNow]);

  // --- project operations -------------------------------------------------

  const switchProject = (id: string) => {
    if (id === activeProjectId || switchingRef.current) return;
    setProjectsMenuOpen(false);
    switchingRef.current = true;
    void (async () => {
      try {
        // Flush the outgoing project's pending edits first.
        await persistNow();
        const list = await listProjects();
        const { meta, files: loadedFiles } = await loadProject(id);
        applyProject(id, meta, loadedFiles, list);
      } catch {
        showNotice("Couldn't open that project");
      } finally {
        switchingRef.current = false;
      }
    })();
  };

  const newProject = () => {
    if (switchingRef.current) return;
    setProjectsMenuOpen(false);
    switchingRef.current = true;
    void (async () => {
      try {
        await persistNow();
        const name = nextProjectName(projects.map((p) => p.name));
        const id = await createProject(
          name,
          DEFAULT_FILES,
          {
            mainPath: DEFAULT_MAIN,
            openPaths: [DEFAULT_MAIN],
            activePath: DEFAULT_MAIN,
          },
        );
        const list = await listProjects();
        const { meta, files: loadedFiles } = await loadProject(id);
        applyProject(id, meta, loadedFiles, list);
      } catch {
        showNotice("Couldn't create the project");
      } finally {
        switchingRef.current = false;
      }
    })();
  };

  const deleteProjectById = (id: string) => {
    if (switchingRef.current) return;
    const target = projects.find((p) => p.id === id);
    const name =
      id === activeProjectId
        ? projectName
        : (target?.name ?? "the project");
    if (!window.confirm(`Delete “${name}” and all its files?`)) return;
    setProjectsMenuOpen(false);
    switchingRef.current = true;
    void (async () => {
      try {
        await deleteProject(id);
        let list = await listProjects();
        if (id === activeProjectId) {
          try {
            localStorage.removeItem(ACTIVE_PROJECT_KEY);
          } catch {
            // best effort
          }
          if (list.length === 0) {
            // Deleting down to empty: start from a fresh default project.
            await createDefaultProjectOnce();
            list = await listProjects();
          }
          const { meta, files: loadedFiles } = await loadProject(list[0].id);
          applyProject(list[0].id, meta, loadedFiles, list);
        } else {
          setProjects(list);
        }
      } catch {
        showNotice("Couldn't delete that project");
      } finally {
        switchingRef.current = false;
      }
    })();
  };

  // Pull a GitHub repo into a project. The files arrive already fetched (the
  // modal does the network work); here we only touch OPFS. A fresh repo
  // creates a new project named for it; re-pulling the same repo (any branch)
  // replaces the files of the project that already holds it — never a
  // duplicate.
  const pullGithub = async (req: PullRequest): Promise<void> => {
    const { files, skippedJunk, skippedCap } = req;
    switchingRef.current = true;
    try {
      const count = Object.keys(files).length;
      if (count === 0) {
        showNotice("That repo has no files to pull");
        return;
      }
      const paths = Object.keys(files).sort();
      const main =
        paths.find((p) => p.toLowerCase() === "main.tex") ??
        paths.find((p) => p.toLowerCase().endsWith(".tex")) ??
        "";
      const openPaths = main ? [main] : [];
      const source = {
        kind: "github" as const,
        owner: req.owner,
        repo: req.repo,
        branch: req.branch,
      };
      const list = await listProjects();
      const existing = list.find(
        (p) =>
          p.source?.kind === "github" &&
          p.source.owner === req.owner &&
          p.source.repo === req.repo,
      );
      let id: string;
      if (existing) {
        id = existing.id;
        const old = await loadProject(id);
        const newMeta: ProjectMeta = {
          v: existing.v,
          name: existing.name,
          mainPath: main,
          openPaths,
          activePath: main,
          createdAt: existing.createdAt,
          // saveProject stamps a fresh updatedAt itself when it writes.
          updatedAt: existing.updatedAt,
          source,
        };
        // The old on-disk files as the "saved" map makes saveProject delete
        // anything that is no longer in the repo and write everything new.
        await saveProject(id, newMeta, files, new Map(Object.entries(old.files)));
      } else {
        id = await createProject(req.repo, files, {
          mainPath: main,
          openPaths,
          activePath: main,
          source,
        });
      }
      const freshList = await listProjects();
      const { meta, files: loadedFiles } = await loadProject(id);
      applyProject(id, meta, loadedFiles, freshList);
      showNotice(
        `Pulled ${count} file${count === 1 ? "" : "s"} from ${req.owner}/${req.repo}` +
          (skippedJunk
            ? ` — ${skippedJunk} dotfile${skippedJunk === 1 ? "" : "s"} skipped`
            : "") +
          (skippedCap
            ? ` — ${skippedCap} over the ${MAX_PULL_FILES}-file limit`
            : ""),
        skippedJunk > 0 || skippedCap > 0 ? 6000 : 3000,
      );
    } catch {
      showNotice("Couldn't pull that repo from GitHub", 8000);
    } finally {
      switchingRef.current = false;
    }
  };

  // The Projects menu closes on any click outside of it.
  useEffect(() => {
    if (!projectsMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        e.target instanceof Element &&
        !e.target.closest('[data-menu="projects"]')
      ) {
        setProjectsMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [projectsMenuOpen]);

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
    // A project switch mid-build must not land the old project's PDF on the
    // new project; the result is dropped instead.
    const projectId = persistStateRef.current.activeProjectId;
    // Remember the PDF's scroll position so the new PDF can restore it —
    // a recompile must not yank the reader back to the top of page 1.
    pendingScrollRef.current = pdfRef.current?.getViewportTop() ?? null;
    setPdf(null);
    setLiveLog("");
    setStatus({ kind: "compiling", line: "preparing…" });
    const started = performance.now();
    try {
      await compiler.init();
      if (projectId !== persistStateRef.current.activeProjectId) return;
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
        // A project switch consumed the queued edit — retrying would
        // compile the NEW project for no reason.
        if (projectId === persistStateRef.current.activeProjectId) {
          // Let the state above settle, then recompile through the
          // always-current ref so the latest files are picked up.
          window.setTimeout(() => compileRef.current(), 0);
        }
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

  // From the new-file modal: `name` is the base name, `location` the
  // folder path ("" = project root). Returns whether the file was
  // created, so the modal can stay open on a rejected name.
  const addFile = (name: string, location: string): boolean => {
    const loc = location.replace(/\/+$/, "");
    const dir = loc ? normalizePath(loc) : null;
    if (loc && !dir) {
      showNotice(
        `Cannot create “${name}” — “${loc}” is not a valid folder path`,
      );
      return false;
    }
    const base = normalizeName(name);
    if (!base) {
      showNotice(
        `Cannot create “${name}” — use a flat name (no folders or reserved names)`,
      );
      return false;
    }
    const path = dir ? `${dir}/${base}` : base;
    if (Object.hasOwn(files, path)) {
      showNotice(`“${path}” already exists`);
      return false;
    }
    if (pathUnderFile(Object.keys(files), path)) {
      showNotice(
        `Cannot create “${name}” — it would collide with an existing file`,
      );
      return false;
    }
    if (pathIsFolder(Object.keys(files), path)) {
      showNotice(`“${path}” is a folder in this project`);
      return false;
    }
    setFiles((f) => ({ ...f, [path]: "" }));
    setOpenPaths((o) => (o.includes(path) ? o : [...o, path]));
    setActivePath(path);
    return true;
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
        {/* Projects menu: switch between the OPFS projects, or create and
            delete them. The active row shows the live name (the input
            above edits it before the next debounced save). */}
        <div className="relative shrink-0" data-menu="projects">
          <button
            data-action="projects"
            onClick={() => setProjectsMenuOpen((v) => !v)}
            title="Open, create or delete projects (kept in your browser)"
            className={
              "flex items-center gap-1 rounded border px-2.5 py-1 text-xs transition-colors " +
              (projectsMenuOpen
                ? "border-mint bg-peach/50 text-ink"
                : "border-stone/40 text-stone hover:bg-peach hover:text-ink")
            }
          >
            Projects
            <IconChevronDown className="h-3 w-3" />
          </button>
          {projectsMenuOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-ink/10 bg-white py-1 shadow-lg">
              {projects.map((p) => {
                const active = p.id === activeProjectId;
                return (
                  <div
                    key={p.id}
                    data-project={p.id}
                    data-active={active || undefined}
                    className="group flex items-center gap-1 px-2 py-0.5"
                  >
                    <button
                      onClick={() => switchProject(p.id)}
                      title={active ? "Current project" : `Open ${p.name}`}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-ink hover:bg-peach/60"
                    >
                      <span className="truncate">
                        {active ? projectName : p.name}
                      </span>
                      {active && (
                        <IconCheck className="h-3 w-3 shrink-0 text-mint" />
                      )}
                    </button>
                    <button
                      onClick={() => deleteProjectById(p.id)}
                      title="Delete project"
                      className="shrink-0 rounded p-1 text-stone opacity-0 transition-opacity hover:bg-peach/60 hover:text-ink group-hover:opacity-100"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              <div className="my-1 h-px bg-ink/10" />
              <button
                onClick={newProject}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-ink hover:bg-peach/60"
              >
                <IconPlus className="h-3.5 w-3.5 text-mint" />
                New project
              </button>
            </div>
          )}
        </div>
        <button
          data-action="github"
          onClick={() => setGhModalOpen(true)}
          title="Import a project from GitHub (your token stays in this browser)"
          className="flex shrink-0 items-center gap-1.5 rounded border border-stone/40 px-2.5 py-1 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          <IconGitHub className="h-3.5 w-3.5" />
          GitHub
        </button>
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
          {/* Fixed-width slots: the icon and the status text swap content
              (spinner/check/dot/none, streaming compile lines) — variable
              widths would push the centered buttons left and right on
              every update. */}
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            {status.kind === "compiling" || status.kind === "loading" ? (
              <IconSpinner className="h-3.5 w-3.5 animate-spin text-mint" />
            ) : status.kind === "error" ? (
              <span className="h-2 w-2 rounded-full bg-red-500" />
            ) : status.kind === "done" ? (
              <IconCheck className="h-3.5 w-3.5 text-mint" />
            ) : null}
          </span>
          <span
            className={
              "w-64 shrink-0 truncate text-xs " +
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
          <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b border-ink/10 bg-cream">
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
                  // Monaco 0.55.1's occurrences-highlighter schedules each
                  // highlight through an internal "delayer" whose completion
                  // promise nothing ever handles. A tab switch inside the
                  // ~100 ms highlight window cancels the pending request,
                  // and the cancellation rejects that promise with
                  // "Canceled" — an unhandled rejection Next's dev overlay
                  // reports as "Runtime Canceled". With the highlight off
                  // the promise is never created, so every cancel() is a
                  // no-op. (Monaco 0.57 rewrote the delayer; revisit on
                  // upgrade if we want the feature back.)
                  occurrencesHighlight: "off",
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
        <div
          data-notice
          className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-ink/10 bg-white px-4 py-1.5 text-xs font-medium text-ink shadow-sm"
        >
          {notice}
        </div>
      )}
      {ghModalOpen && (
        <GitHubModal
          projects={projects}
          onPulled={pullGithub}
          onClose={() => setGhModalOpen(false)}
        />
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

// Dev StrictMode mounts effects twice; if both first-run loads saw an
// empty projects dir they would each create a default, leaving an orphan
// folder in OPFS that the menu later lists as a second "LaTeX project".
// Share the in-flight creation so only one directory is ever written. The
// slot clears on settle, so a later genuine first run (delete-to-empty)
// can create again.
let firstRunCreate: Promise<string> | null = null;
function createDefaultProjectOnce(): Promise<string> {
  if (!firstRunCreate) {
    const p = createProject(
      DEFAULT_PROJECT_NAME,
      DEFAULT_FILES,
      {
        mainPath: DEFAULT_MAIN,
        openPaths: [DEFAULT_MAIN],
        activePath: DEFAULT_MAIN,
      },
    );
    firstRunCreate = p;
    void p.then(
      () => {
        if (firstRunCreate === p) firstRunCreate = null;
      },
      () => {
        if (firstRunCreate === p) firstRunCreate = null;
      },
    );
  }
  return firstRunCreate;
}

/** "LaTeX project", "LaTeX project 2", … — the first one not taken. */
function nextProjectName(taken: string[]): string {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? DEFAULT_PROJECT_NAME : `${DEFAULT_PROJECT_NAME} ${i}`;
    if (!taken.includes(name)) return name;
  }
  return `${DEFAULT_PROJECT_NAME} ${Date.now()}`;
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
