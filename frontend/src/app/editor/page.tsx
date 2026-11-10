"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";

// Timestamp for the scroll-sync lock. Kept at module scope: the React
// compiler lint treats Date.now as impure and flags it in functions it
// cannot prove run outside of render.
function now() {
  return Date.now();
}
import Link from "next/link";
import type { BeforeMount, Monaco } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import MonacoEditor from "@/components/monaco-editor";
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
  IconChart,
  IconChat,
  IconCheck,
  IconClose,
  IconCode,
  IconClock,
  IconFile,
  IconNote,
  IconSearch,
  IconGitHub,
  IconImage,
  IconLink,
  IconPlay,
  IconSpinner,
  IconSwap,
  IconSync,
  IconTable,
} from "@/components/icons";
import GitHubModal, { type PullRequest, type PushRequest } from "@/components/github-modal";
import PackagesModal from "@/components/packages-modal";
import { BusyTexCompiler, contentHash } from "@/lib/busytex";
import {
  ensureDefaults,
  installWithDependencies,
  packageForFile,
  searchPackages,
} from "@/lib/ctan-store";
import {
  ACTIVE_PROJECT_KEY,
  BINARY_EXT,
  RESERVED_NAMES,
  createProject,
  decodeText,
  listProjects,
  clearBuildCache,
  loadBuildCache,
  loadBuildState,
  loadProject,
  saveBuildCache,
  saveBuildState,
  saveProject,
  savePreview,
  type FileData,
  type ProjectMeta,
  type ProjectSource,
  type ProjectSummary,
} from "@/lib/opfs";
import { MAX_PULL_FILES } from "@/lib/github";
import {
  DEFAULT_FILES,
  DEFAULT_MAIN,
  DEFAULT_PROJECT_NAME,
} from "@/lib/defaults";
import { renderFirstPagePng } from "@/lib/preview";
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

// The status slot renders in-flight work as a progress bar (total 0 =
// still unknown, indeterminate), never the log drawer. Two things drive
// it: the engine's emscripten loader reporting data-asset downloads as
// "Downloading data…" / "Downloading data… (loaded/total)" print lines,
// and the first-run default package install (one step per package).
type DownloadProgress = { loaded: number; total: number };

type Status =
  | { kind: "idle" }
  | { kind: "loading"; line: string; progress?: DownloadProgress }
  | { kind: "compiling"; line: string; progress?: DownloadProgress }
  | { kind: "done"; ms: number }
  | { kind: "error"; message: string };

// One message in the chat drawer's conversation (the system context is
// built per request and never stored here). Assistant messages may carry
// the tool calls they made (rendered as chips); tool messages record a
// tool's result back into the transcript.
type ChatToolCallInfo = { id: string; name: string; args: string };
type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ChatToolCallInfo[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

// The wire shapes for /api/chat (OpenAI format). Assistant messages may
// carry tool_calls (content can then be empty); tool messages answer
// exactly one call by id.
type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type ApiChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ApiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// A file change the assistant proposed and the user has not decided yet.
// The tool loop BLOCKS on it: the model's turn already ended, no stream
// is open, so waiting between turns is safe.
type PendingEdit = {
  id: string; // the tool_call id
  path: string;
  old: string;
  new: string;
  line: number; // 1-based line of the match
};

// The snapshot the chat tools execute against (chatCtxRef, reassigned
// every render — the loop outlives renders and must never see stale files
// or log).
type ChatToolCtx = {
  files: Record<string, FileData>;
  activePath: string | null;
  mainPath: string;
  log: string;
  entries: FileEntry[];
  setFiles: Dispatch<SetStateAction<Record<string, FileData>>>;
  handlePackagesChanged: (msg: string) => void;
};

// The seven tools the assistant can call on the project (OpenAI function
// format). The page executes them against in-memory state; the model only
// ever sees the results. `apply_edit` is gated on the user's accept.
const CHAT_TOOLS: Array<{
  type: "function";
  function: { name: string; description: string; parameters: object };
}> = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List all files in the current project (path and whether each is binary), and which file is the main file.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the text content of one file in the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. main.tex" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compile",
      description:
        "Compile the project with XeLaTeX and wait for the build to finish. Returns the outcome (success/failure) and a tail of the build log.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_build_log",
      description: "Return the log of the last completed build.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_edit",
      description:
        "Replace one exact occurrence of `old` in a project file with `new`. The user must accept the change in the UI; the result reports whether it was accepted. `old` must occur exactly once in the file — if it does not, the result is an error and you should read_file and retry with the exact text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. main.tex" },
          old: {
            type: "string",
            description:
              "The exact existing text to replace (must occur exactly once)",
          },
          new: { type: "string", description: "The replacement text" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_package",
      description:
        "Install a LaTeX package (plus its dependencies) from CTAN into the browser's package store. The engine restarts and the package is available on the next compile.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The tlpkg package name, e.g. tikz or biblatex",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_packages",
      description:
        "Search CTAN for LaTeX packages by name or description. Returns matches with a one-line description and whether each is already installed.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search text, e.g. \"tikz\" or \"bibliography\"",
          },
        },
        required: ["query"],
      },
    },
  },
];

// Minimal line diff (LCS) for the apply_edit approval card. Snippets are
// small; the DP grid is fine.
type DiffLine = { t: "same" | "del" | "add"; text: string };
function diffSnippet(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "del", text: a[i] });
      i++;
    } else {
      out.push({ t: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

/**
 * One streaming completion against /api/chat. Accumulates the assistant's
 * content and its tool_calls (the upstream streams them as per-index
 * fragments: function.name and function.arguments arrive in pieces and
 * are concatenated here before the caller JSON.parses them). onDelta
 * fires per content piece so the transcript can stream live.
 */
async function streamChatCompletion(
  messages: ApiChatMessage[],
  tools: object[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<{
  content: string;
  toolCalls: ApiToolCall[];
  finishReason: string | null;
}> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, tools }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = String((await res.json())?.error ?? "");
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let finishReason: string | null = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    // The upstream is SSE: "data: {…}\n" lines, "\n\n" between events,
    // and a final "data: [DONE]".
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: {
        choices?: {
          delta?: {
            content?: unknown;
            tool_calls?: Array<{
              index?: unknown;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }>;
          };
          finish_reason?: unknown;
        }[];
      };
      try {
        ev = JSON.parse(payload);
      } catch {
        // A partial or malformed line is skipped; the stream ends with
        // [DONE] regardless.
        continue;
      }
      const choice = ev.choices?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === "string")
        finishReason = choice.finish_reason;
      const d = choice.delta;
      if (!d) continue;
      if (typeof d.content === "string" && d.content) {
        content += d.content;
        onDelta(d.content);
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const cur = calls.get(idx) ?? { id: "", name: "", arguments: "" };
          if (typeof tc.id === "string") cur.id += tc.id;
          if (typeof tc.function?.name === "string")
            cur.name += tc.function.name;
          if (typeof tc.function?.arguments === "string")
            cur.arguments += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
    }
  }
  return {
    content,
    toolCalls: [...calls.values()]
      .filter((c) => c.id || c.name)
      .map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    finishReason,
  };
}

// --- workspace layout ----------------------------------------------------
// The panes are user-arrangeable: drag the files panel's right edge to
// resize it, drag the handle between the editor and PDF to re-split them,
// click the arrows on that handle to swap the two panes. The arrangement
// persists in localStorage (like the active project) and survives reloads.
type WorkspaceLayout = {
  filesW: number; // files panel width, px
  split: number; // editor's share of the editor+PDF row, 0.2–0.8
  editorFirst: boolean; // editor left of the PDF (false = swapped)
};
const WORKSPACE_KEY = "homehub-workspace-v1";
const FILES_W = { min: 160, max: 480 };
const SPLIT = { min: 0.2, max: 0.8 };
// Compile-history popover: newest first, capped so a long session can't
// grow it without bound.
const HISTORY_CAP = 50;
// Per-project notes live in localStorage keyed by project id — browser-
// local, like the workspace layout and the chat conversation.
const NOTES_KEY = (id: string) => `homehub-notes-${id}`;
const readNotes = (id: string | null) =>
  id ? (localStorage.getItem(NOTES_KEY(id)) ?? "") : "";
const DEFAULT_WORKSPACE: WorkspaceLayout = {
  filesW: 256,
  split: 0.5,
  editorFirst: true,
};

const clampN = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

function loadWorkspace(): WorkspaceLayout {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return DEFAULT_WORKSPACE;
    const p = JSON.parse(raw) as Partial<WorkspaceLayout>;
    return {
      filesW: clampN(Number(p.filesW), FILES_W.min, FILES_W.max),
      split: clampN(Number(p.split), SPLIT.min, SPLIT.max),
      editorFirst: typeof p.editorFirst === "boolean" ? p.editorFirst : true,
    };
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/**
 * Track a pointer drag on a layout handle from the pointerdown. `onMove`
 * gets the CUMULATIVE delta from the press point (callers combine it with
 * the value captured at press time — never with the live state, or the
 * delta would be re-applied on every move). While the drag is live the
 * body's cursor and text selection are locked so the panes, not a text
 * selection, follow the pointer.
 */
function startLayoutDrag(
  e: ReactPointerEvent,
  cursor: string,
  onMove: (dx: number, dy: number) => void,
) {
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const body = document.body;
  const prevCursor = body.style.cursor;
  const prevSelect = body.style.userSelect;
  body.style.cursor = cursor;
  body.style.userSelect = "none";
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    body.style.cursor = prevCursor;
    body.style.userSelect = prevSelect;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
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
  const [activePath, setActivePath] = useState(DEFAULT_MAIN);
  const [openPaths, setOpenPaths] = useState<string[]>([DEFAULT_MAIN]);
  const [mainPath, setMainPath] = useState(DEFAULT_MAIN);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  // The OPFS project this session edits (null until the load effect
  // resolves, or forever when storage is unavailable).
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [ghModalOpen, setGhModalOpen] = useState(false);
  const [pkgModalOpen, setPkgModalOpen] = useState(false);
  // True once a project has been loaded from OPFS (or the attempt failed);
  // persistence is gated on it so defaults can't be written before the load
  // effect has settled.
  const [loaded, setLoaded] = useState(false);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [log, setLog] = useState("");
  const [liveLog, setLiveLog] = useState("");
  // What the left panel shows (picked from the icon rail): the file
  // tree, the search view, the chat or the build log. (The log and chat
  // used to share a bottom drawer with tabs; the rail replaces it.)
  const [leftPane, setLeftPane] = useState<
    "files" | "search" | "chat" | "log"
  >("files");
  // The Search view's query (session-only, like the log — it is not part
  // of the project).
  const [searchQuery, setSearchQuery] = useState("");
  // The chat conversation (in-memory; it lives with this page's session,
  // like the log — it is not part of the project).
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // apply_edit calls awaiting the user's decision (the diff card in the
  // drawer). The tool loop blocks on the matching resolver below.
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Decoded synctex data for the current PDF (null = no navigation yet).
  const [syncEntries, setSyncEntries] = useState<SyncEntry[] | null>(null);
  const [autoRecompile, setAutoRecompile] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // Compile history for this session's project (newest first, capped at
  // HISTORY_CAP). In-memory like the chat — a project's build log is not
  // part of its stored files. Cleared when a different project opens.
  const [compileHistory, setCompileHistory] = useState<
    { t: string; ok: boolean; ms?: number; message?: string }[]
  >([]);
  // The popovers in the toolbar rows (compile history, project notes,
  // project stats) — each closes on an outside click (see below).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  // The current PDF's page count (the badge in the PDF toolbar row); the
  // viewer reports it through onNumPages.
  const [pdfPages, setPdfPages] = useState(0);
  const recordHistory = useCallback(
    (ok: boolean, extra: { ms?: number; message?: string } = {}) => {
      setCompileHistory((h) =>
        [{ t: new Date().toISOString(), ok, ...extra }, ...h].slice(
          0,
          HISTORY_CAP,
        ),
      );
    },
    [],
  );
  // True while the debounced OPFS persist is pending — the "Saving…"
  // indicator in the editor toolbar.
  const [savePending, setSavePending] = useState(false);
  // Reactive twin of engineReadyRef: the auto-compile-on-open effect needs
  // a state update, not just the ref, to know when the engine settles.
  const [engineReady, setEngineReady] = useState(false);
  // Bumped once per applied project (load, switch, pull): the open-time
  // auto-compile effect keys on it so a re-pull of the SAME project id
  // still re-triggers, while plain re-renders never do.
  const [projectVersion, setProjectVersion] = useState(0);
  // The user's pane arrangement (drag edges to resize, swap the panes):
  // the first render uses the defaults, as SSR did, so hydration never
  // mismatches; the mount effect swaps in the saved layout.
  const [workspace, setWorkspace] = useState<WorkspaceLayout>(DEFAULT_WORKSPACE);
  // The saved layout has been applied; until then the persist effect must
  // not write, or it would race the load and clobber the saved layout
  // with the defaults.
  const workspaceSavedRef = useRef(false);

  const compilerRef = useRef<BusyTexCompiler | null>(null);
  const busyRef = useRef(false);
  // Mirror of `status` for the chat's compile tool: it polls for the build
  // to settle from an async loop, where the state value in the closure
  // would be stale.
  const statusRef = useRef<Status>({ kind: "idle" });
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
  // Babel languages we already auto-installed for (one attempt each): the
  // auto-install only recompiles when it succeeds, so marking a language
  // can't cause a recompile loop, and it stops a persistently-unfixable
  // language (no tlpkg ships its .ldf) from re-attempting on every build.
  const babelAutoFixedRef = useRef<Set<string>>(new Set());
  // The PDF's scroll position before the latest compile; restored once the
  // new PDF renders (pdf.js renders async — the effect below polls).
  const pendingScrollRef = useRef<{ page: number; yTop: number } | null>(null);
  // The editor+PDF split row: a split drag's dx is a fraction of its width.
  const splitRef = useRef<HTMLDivElement | null>(null);
  // The log drawer's scroll container, plus its sticky-to-bottom flag: the
  // log follows the compile until the user scrolls up to read, and
  // scrolling back to the bottom resumes following.
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const logFollowRef = useRef(true);
  // The chat drawer's scroll container and sticky-to-bottom flag (same
  // behavior as the log: follows until the user scrolls up).
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatFollowRef = useRef(true);
  // In-flight chat stream; Stop (and unmount) abort it.
  const chatAbortRef = useRef<AbortController | null>(null);
  // Resolvers for the pending apply_edit cards, keyed by tool_call id.
  // The tool loop awaits the promise; deciding (or stopping) resolves it,
  // which unblocks the loop.
  const pendingEditResolveRef = useRef(
    new Map<string, (result: string) => void>(),
  );
  // Snapshot the chat tools execute against, reassigned every render. The
  // agentic loop is one long-running async function that outlives renders;
  // reading state through this ref (not the closure) keeps every tool call
  // — read_file after an accepted apply_edit, list_files after an install —
  // on the latest values.
  // setFiles is the stable useState setter, captured once here so the
  // mirror effect below never references it (a setState reference in a
  // dependency-less effect trips react-hooks/exhaustive-deps).
  const chatCtxRef = useRef<ChatToolCtx>({
    files: {},
    activePath: null,
    mainPath: "",
    log: "",
    entries: [],
    setFiles,
    handlePackagesChanged: () => {},
  });
  // uploadFiles is redefined every render; the window-level drop handler
  // (attached once) calls it through this ref.
  const uploadFilesRef = useRef<(list: File[], dropped?: DroppedTree) => void>(
    () => {},
  );
  // Refs mirroring state so handlers attached once (Monaco onMount, the
  // PDF viewer's scroll callback) never see stale values.
  const syncEntriesRef = useRef<SyncEntry[] | null>(null);
  const activePathRef = useRef(activePath);
  const syncScrollRef = useRef(syncScroll);
  const autoRef = useRef(autoRecompile);
  const compileRef = useRef<() => Promise<void>>(async () => {});

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
    setProjectVersion((v) => v + 1);
    setProjects(list);
    setFiles(files);
    setMainPath(main);
    setOpenPaths(openPathsNorm);
    setActivePath(active);
    setProjectName(meta.name || DEFAULT_PROJECT_NAME);
    // The PDF/log/sync belong to the previous project's build.
    setPdf(null);
    pendingScrollRef.current = null;
    setLog("");
    setLiveLog("");
    setSyncEntries(null);
    setStatus({ kind: "idle" });
    // The left panel shows the new project's files — never inherit the
    // outgoing project's auto-opened log pane (its failed build's error
    // state would otherwise survive the switch).
    setLeftPane("files");
    // The build history belongs to the outgoing project's session.
    setCompileHistory([]);
    setHistoryOpen(false);
    window.clearTimeout(autoTimerRef.current);
    try {
      localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    } catch {
      // best effort: the project is in memory regardless
    }
  };

  // Persist the arrangement. Debounced: layout drags update state at
  // pointer rate and each write would otherwise be a synchronous
  // localStorage hit.
  useEffect(() => {
    if (!workspaceSavedRef.current) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
      } catch {
        // storage can be unavailable (private mode); the layout still works
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [workspace]);

  // Sticky-to-bottom log follow: while the user stays within 24 px of the
  // tail, every new line keeps the tail in view; scrolling up pauses the
  // follow until the user scrolls back to the bottom. A re-shown panel
  // starts at the tail.
  const handleLogScroll = useCallback(() => {
    const el = logScrollRef.current;
    if (!el) return;
    logFollowRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  useEffect(() => {
    if (leftPane !== "log") {
      logFollowRef.current = true;
      return;
    }
    const el = logScrollRef.current;
    if (el && logFollowRef.current) el.scrollTop = el.scrollHeight;
  }, [leftPane, liveLog, log]);

  // --- chat (bottom drawer, proxied through /api/chat — the router's key
  //     never reaches the browser) ----------------------------------------
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    chatFollowRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  // Follow the streaming reply until the user scrolls up to read.
  useEffect(() => {
    if (leftPane !== "chat") return;
    const el = chatScrollRef.current;
    if (el && chatFollowRef.current) el.scrollTop = el.scrollHeight;
  }, [leftPane, chatMessages, chatError]);

  // Resolves a pending apply_edit (the user's button, or a stop/clear/
  // unmount) and drops its card. Idempotent: a double settle is a no-op.
  const settlePendingEdit = useCallback((id: string, result: string) => {
    const resolve = pendingEditResolveRef.current.get(id);
    if (!resolve) return;
    pendingEditResolveRef.current.delete(id);
    setPendingEdits((prev) => prev.filter((p) => p.id !== id));
    resolve(result);
  }, []);

  // Aborts the in-flight stream AND settles any pending apply_edit: the
  // loop blocks on that promise with no fetch in flight to reject, so
  // without the settle it would wait forever after Stop.
  const abortChat = useCallback(() => {
    chatAbortRef.current?.abort();
    for (const id of [...pendingEditResolveRef.current.keys()])
      settlePendingEdit(
        id,
        "The user stopped the conversation; the edit was not applied.",
      );
  }, [settlePendingEdit]);

  // A stream (or a blocked tool) that outlives the page (unmount) is
  // aborted.
  useEffect(() => abortChat, [abortChat]);

  const stopChat = () => {
    abortChat();
  };

  const clearChat = () => {
    abortChat();
    setChatMessages([]);
    setChatError(null);
  };

  // The system context is rebuilt every round (not just at send time): an
  // accepted edit changes the active file mid-conversation, and the model
  // must not keep quoting the pre-edit text.
  const buildChatSystemPrompt = () => {
    const ctx = chatCtxRef.current;
    const active =
      ctx.activePath && Object.hasOwn(ctx.files, ctx.activePath)
        ? ctx.activePath
        : null;
    const filePart = active
      ? ` The user is editing "${active}" in the editor right now:\n\n<file path="${active}">\n${
          typeof ctx.files[active] === "string"
            ? (ctx.files[active] as string).slice(0, 24_000)
            : "(binary file)"
        }\n</file>`
      : "";
    // The cursor/selection is read live from the editor at send time (this
    // prompt is rebuilt every round), so it describes where the user is
    // looking when they ask — a selection is quoted so "fix this" has a
    // target without a read_file round trip.
    const editor = editorRef.current;
    const selection = active ? editor?.getSelection() : undefined;
    const model = active ? editor?.getModel() : undefined;
    const cursorPart =
      active && selection && model
        ? !selection.isEmpty()
          ? `\n\nThe user's selection in "${active}", lines ${selection.startLineNumber}-${selection.endLineNumber}:\n<selection>\n${model
              .getValueInRange(selection)
              .slice(0, 4_000)}\n</selection>`
          : ` The cursor in "${active}" is at line ${selection.startLineNumber}, column ${selection.startColumn}.`
        : "";
    return (
      "You are a helpful LaTeX assistant inside HomeHub, a browser-based TeX Live editor (XeLaTeX, TeX Live 2026)." +
      filePart +
      cursorPart +
      "\n\nYou can act on the project with tools:" +
      "\n- list_files: list the project's files (and the main file)" +
      "\n- read_file(path): read a text file" +
      "\n- compile: compile the project and report the outcome with a log tail" +
      "\n- get_build_log: read the last build's log" +
      "\n- apply_edit(path, old, new): change a file — the user must accept the diff shown in the UI; the result tells you whether they did" +
      "\n- search_packages(query) / install_package(name): find and install CTAN packages" +
      "\n\nRules: inspect the real project (list_files, read_file, compile, get_build_log) before diagnosing or changing anything. To change a file, call apply_edit with the EXACT existing text as \"old\" (it must occur exactly once — copy it from read_file). Never claim an edit was made unless the result says the user accepted it; if an edit is rejected, say so and do not retry the same change. Answer concisely, in the user's language, and use ```tex code fences for code."
    );
  };

  // The transcript (state) in the wire shapes /api/chat expects.
  const toApiMessages = (msgs: ChatMessage[]): ApiChatMessage[] => {
    const out: ApiChatMessage[] = [];
    for (const m of msgs) {
      if (m.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content.slice(0, 16_000),
        });
      } else if (m.role === "assistant") {
        if (m.toolCalls && m.toolCalls.length > 0) {
          out.push({
            role: "assistant",
            content: m.content,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: t.args },
            })),
          });
        } else {
          out.push({ role: "assistant", content: m.content });
        }
      } else {
        out.push({ role: "user", content: m.content });
      }
    }
    return out;
  };

  // Wait until no build is in flight and the last one reached a terminal
  // status (done/error), then give a REQUEUED build a beat to start and
  // wait for it too: compile() requeues itself (through a setTimeout(0)
  // that fires AFTER the compile promise resolves) when a package install
  // — the babel auto-fix — lands mid-build.
  const COMPILE_SETTLE_TIMEOUT = 180_000;
  const waitForCompileSettle = async () => {
    const terminal = () => {
      const s = statusRef.current;
      return !busyRef.current && (s.kind === "done" || s.kind === "error");
    };
    const wait = () =>
      new Promise<void>((resolve, reject) => {
        const t0 = now();
        const tick = () => {
          if (terminal()) return resolve();
          if (now() - t0 > COMPILE_SETTLE_TIMEOUT)
            return reject(
              new Error("the build did not finish within 3 minutes"),
            );
          window.setTimeout(tick, 200);
        };
        tick();
      });
    await wait();
    await new Promise((r) => window.setTimeout(r, 80));
    if (!terminal()) await wait();
  };

  // The apply_edit tool: validate the match, then BLOCK on the user's
  // decision. The model's turn already ended (finish_reason tool_calls),
  // no stream is open — the diff card waits in the drawer while the loop
  // holds this promise. Stop/Clear/unmount settles it with an abort.
  const applyEditTool = (
    callId: string,
    path: string,
    oldText: string,
    newText: string,
  ): Promise<string> => {
    const c = chatCtxRef.current;
    const cur = c.files[path];
    if (cur === undefined)
      return Promise.resolve(
        `ERROR: no file "${path}" in the project. Files: ${c.entries
          .map((e) => e.path)
          .join(", ")}`,
      );
    if (typeof cur !== "string")
      return Promise.resolve(
        `ERROR: "${path}" is a binary file; apply_edit works on text files only.`,
      );
    if (oldText === "")
      return Promise.resolve('ERROR: "old" must not be empty.');
    if (!cur.includes(oldText))
      return Promise.resolve(
        `ERROR: the text given as "old" was not found in "${path}". Read the file with read_file and copy the exact text.`,
      );
    const count = cur.split(oldText).length - 1;
    if (count > 1)
      return Promise.resolve(
        `ERROR: the text given as "old" occurs ${count} times in "${path}". Include more surrounding context so it matches exactly once.`,
      );
    const line = cur.slice(0, cur.indexOf(oldText)).split("\n").length;
    return new Promise<string>((resolve) => {
      pendingEditResolveRef.current.set(callId, resolve);
      setPendingEdits((prev) =>
        prev.some((p) => p.id === callId)
          ? prev
          : [...prev, { id: callId, path, old: oldText, new: newText, line }],
      );
    });
  };

  // Execute one of the assistant's tool calls. Everything reads state
  // through chatCtxRef (the loop outlives renders). Errors come back as
  // "ERROR: …" text the model can react to, not as thrown exceptions.
  const executeChatTool = async (
    callId: string,
    name: string,
    argsRaw: string,
  ): Promise<string> => {
    let args: Record<string, unknown> = {};
    try {
      args = argsRaw ? (JSON.parse(argsRaw) as Record<string, unknown>) : {};
    } catch {
      return `ERROR: the tool arguments were not valid JSON: ${argsRaw.slice(0, 200)}`;
    }
    switch (name) {
      case "list_files": {
        const c = chatCtxRef.current;
        const lines = c.entries.map((e) => `${e.path}${e.isBinary ? " (binary)" : ""}`);
        return `Main file: ${c.mainPath || "(none)"}\nFiles:\n${lines.join("\n")}`;
      }
      case "read_file": {
        const path = String(args.path ?? "");
        const c = chatCtxRef.current;
        const v = c.files[path];
        if (v === undefined)
          return `ERROR: no file "${path}" in the project. Files: ${c.entries
            .map((e) => e.path)
            .join(", ")}`;
        if (typeof v !== "string")
          return `(binary file, ${v.byteLength} bytes — content not shown)`;
        const CAP = 24_000;
        return v.length > CAP
          ? `${v.slice(0, CAP)}\n… (truncated — ${v.length} characters total)`
          : v;
      }
      case "compile": {
        try {
          if (busyRef.current) await waitForCompileSettle();
          await compileRef.current();
          await waitForCompileSettle();
          const s = statusRef.current;
          const logText = chatCtxRef.current.log;
          const tail =
            logText.length > 4_000
              ? `…\n${logText.slice(-4_000)}`
              : logText || "(no log output)";
          if (s.kind === "done")
            return `Compilation succeeded in ${s.ms} ms.\n\nLog tail:\n${tail}`;
          if (s.kind === "error")
            return `Compilation FAILED: ${s.message}\n\nLog tail:\n${tail}`;
          return `The build is still running (status: ${s.kind}); call compile again to wait for it.`;
        } catch (err) {
          return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      case "get_build_log": {
        const l = chatCtxRef.current.log;
        if (!l) return "(no build has completed yet)";
        return l.length > 16_000 ? `…\n${l.slice(-16_000)}` : l;
      }
      case "apply_edit":
        return applyEditTool(
          callId,
          String(args.path ?? ""),
          String(args.old ?? ""),
          String(args.new ?? ""),
        );
      case "install_package": {
        const pkgName = String(args.name ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(pkgName))
          return `ERROR: "${pkgName}" is not a valid package name (letters, digits, hyphens; e.g. tikz, biblatex).`;
        try {
          const result = await installWithDependencies(pkgName);
          let msg = `Installed "${result.package.name}"`;
          if (result.installedDependencies.length > 0)
            msg += ` (pulled in: ${result.installedDependencies.join(", ")})`;
          if (result.unresolved.length > 0)
            msg += ` — could not auto-install: ${result.unresolved.join(", ")}`;
          // Same path as the Packages modal: a notice, and the engine
          // restarts so the new files are visible on the next compile.
          chatCtxRef.current.handlePackagesChanged(msg);
          return `${msg}. The package is available on the next compile.`;
        } catch (e) {
          return `ERROR: install failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case "search_packages": {
        const query = String(args.query ?? "").trim();
        if (!query) return "ERROR: query must not be empty.";
        try {
          const results = await searchPackages(query, 15);
          if (results.length === 0) return `No packages match "${query}".`;
          return results
            .map((r) => `${r.name}${r.installed ? " (installed)" : ""} — ${r.shortdesc}`)
            .join("\n");
        } catch (e) {
          return `ERROR: search failed (the first search downloads the ~20 MB package database): ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      default:
        return `ERROR: unknown tool "${name}".`;
    }
  };

  // The Accept/Reject buttons on a pending edit card. Accept writes the
  // file through one setFiles (one undo step); for the ACTIVE file an
  // undo stop is pushed first so Ctrl+Z reverts the whole change in one
  // step instead of fighting the model's earlier content.
  const decideEdit = (id: string, accepted: boolean) => {
    const edit = pendingEdits.find((p) => p.id === id);
    if (!edit) return;
    if (accepted) {
      const c = chatCtxRef.current;
      const cur = c.files[edit.path];
      const stillMatches = typeof cur === "string" && cur.includes(edit.old);
      if (stillMatches) {
        if (c.activePath === edit.path) editorRef.current?.pushUndoStop();
        c.setFiles((f) => {
          const v = f[edit.path];
          return typeof v === "string"
            ? { ...f, [edit.path]: v.replace(edit.old, edit.new) }
            : f;
        });
      }
      settlePendingEdit(
        id,
        stillMatches
          ? `The user ACCEPTED the edit; it was applied to ${edit.path}.`
          : `The user ACCEPTED the edit, but ${edit.path} changed in the meantime and the edit could not be applied. Read the file again if a change is still wanted.`,
      );
    } else {
      settlePendingEdit(
        id,
        `The user REJECTED the edit; ${edit.path} is unchanged. Tell the user, and do not retry the same change.`,
      );
    }
  };

  // One agentic turn: the model ends with either a text answer (done) or
  // tool_calls (execute them, feed the results back as tool messages, and
  // go again until it does).
  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatError(null);
    setChatInput("");
    setChatBusy(true);
    chatFollowRef.current = true;
    const controller = new AbortController();
    chatAbortRef.current = controller;
    // The conversation so far (state) + this user message, in wire shape.
    const history: ApiChatMessage[] = [
      { role: "system", content: buildChatSystemPrompt() },
      ...toApiMessages(chatMessages),
      { role: "user", content: text },
    ];
    setChatMessages((prev) => [...prev, { role: "user", content: text }]);
    // Stream the reply into the LAST assistant bubble (the stub added per
    // round); tool rounds add no deltas, so the stub is always the target.
    const appendAssistantDelta = (delta: string) => {
      setChatMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") return prev;
        next[next.length - 1] = { ...last, content: last.content + delta };
        return next;
      });
    };
    try {
      for (;;) {
        // Rebuild the system context: an accepted edit may have changed
        // the active file since the previous round.
        history[0] = { role: "system", content: buildChatSystemPrompt() };
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: "" },
        ]);
        const turn = await streamChatCompletion(
          history,
          CHAT_TOOLS,
          controller.signal,
          appendAssistantDelta,
        );
        if (turn.toolCalls.length > 0) {
          // Record the assistant message WITH its tool calls (the wire
          // shape the next request needs) and execute each call.
          setChatMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant")
              next[next.length - 1] = {
                ...last,
                toolCalls: turn.toolCalls.map((t) => ({
                  id: t.id,
                  name: t.function.name,
                  args: t.function.arguments,
                })),
              };
            return next;
          });
          history.push({
            role: "assistant",
            content: turn.content,
            tool_calls: turn.toolCalls,
          });
          for (const tc of turn.toolCalls) {
            const result = await executeChatTool(
              tc.id,
              tc.function.name,
              tc.function.arguments,
            );
            // Stop was clicked while a tool (apply_edit) held the loop.
            if (controller.signal.aborted) {
              const e = new Error("aborted");
              e.name = "AbortError";
              throw e;
            }
            history.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
            setChatMessages((prev) => [
              ...prev,
              {
                role: "tool",
                toolCallId: tc.id,
                toolName: tc.function.name,
                content: result,
              },
            ]);
          }
          continue;
        }
        // Final text turn: the streamed content is already in the stub.
        if (turn.content === "") {
          setChatMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.content === "")
              return prev.slice(0, -1).concat({
                role: "assistant",
                content: "(no response from the model)",
              });
            return prev;
          });
        }
        return;
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setChatError((err as Error).message || "chat request failed");
      }
      // Drop an empty assistant stub so the transcript stays clean.
      setChatMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.content === "")
          return prev.slice(0, -1);
        return prev;
      });
    } finally {
      chatAbortRef.current = null;
      setChatBusy(false);
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
          const t = now();
          const id = await createDefaultProjectOnce();
          list = [
            {
              v: 1,
              name: DEFAULT_PROJECT_NAME,
              mainPath: DEFAULT_MAIN,
              openPaths: [DEFAULT_MAIN],
              activePath: DEFAULT_MAIN,
              createdAt: t,
              updatedAt: t,
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
      if (!cancelled) {
        // The saved workspace layout restores with the project (in the
        // async continuation, like setLoaded above): the first render
        // keeps the SSR defaults, so hydration never mismatches.
        setWorkspace(loadWorkspace());
        workspaceSavedRef.current = true;
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- auto-compile on open -------------------------------------------------
  // A project compiles as soon as it opens, not only when you type: the
  // trigger is whichever settles LAST — the loaded files or the ready
  // engine — plus every project switch or re-pull (applyProject bumps
  // projectVersion). A project without a main .tex has nothing to compile
  // and stays idle. Typing has its own debounce; this fires once per open.
  useEffect(() => {
    if (!loaded || !engineReady || !activeProjectId) return;
    if (!autoRef.current) return;
    if (!mainPath || !Object.hasOwn(files, mainPath)) return;
    compileRef.current();
    // files/mainPath come from this render (batched with the version bump)
    // and are read, not watched: firing keys on open/switch, not on edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, engineReady, activeProjectId, projectVersion]);

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
      metaRef.current = { ...nextMeta, updatedAt: now() };
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
      setSavePending(true);
      void persistNow().then(() => setSavePending(false));
    }, 600);
    return () => window.clearTimeout(t);
  }, [files, mainPath, openPaths, activePath, projectName, loaded, activeProjectId, persistNow]);

  // --- project operations -------------------------------------------------

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

  // The modal already pushed the files to GitHub; here we just record where
  // the project now lives, so the next modal open preselects that
  // repo/branch and a "Re-pull" matches the push target.
  const pushGithub = async (req: PushRequest): Promise<void> => {
    const id = activeProjectId;
    if (!id) return;
    const source: ProjectSource = {
      kind: "github",
      owner: req.owner,
      repo: req.repo,
      branch: req.branch,
    };
    if (metaRef.current) metaRef.current = { ...metaRef.current, source };
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, source } : p)));
    await persistNow();
    showNotice(
      `Pushed ${req.files} file${req.files === 1 ? "" : "s"} to ` +
        `${req.owner}/${req.repo} @ ${req.branch} (${req.sha.slice(0, 7)})`,
    );
  };

  // Same outside-click dismissal for the toolbar popovers (compile
  // history, project notes, project stats).
  useEffect(() => {
    if (!historyOpen && !notesOpen && !statsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      // Each popover stays open only while the click lands inside it
      // (the trigger button lives inside its root, so the button's own
      // onClick still toggles it).
      if (!e.target.closest('[data-popover-root="history"]')) setHistoryOpen(false);
      if (!e.target.closest('[data-popover-root="notes"]')) setNotesOpen(false);
      if (!e.target.closest('[data-popover-root="stats"]')) setStatsOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [historyOpen, notesOpen, statsOpen]);

  // --- engine ------------------------------------------------------------
  useEffect(() => {
    const compiler = new BusyTexCompiler();
    compilerRef.current = compiler;
    compiler.init(
      (line) => {
        // Data-asset download progress: shown as a bar in the status slot,
        // never logged (the drawer is for errors, not byte counts).
        const dl = line.match(/^Downloading data\.\.\.(\s*\((\d+)\/(\d+)\))?\s*$/);
        if (dl) {
          setStatus((s) => {
            if (s.kind !== "loading" && s.kind !== "compiling") return s;
            return {
              ...s,
              progress: dl[2]
                ? { loaded: Number(dl[2]), total: Number(dl[3]) }
                : { loaded: 0, total: 0 },
            };
          });
          return;
        }
        // Live stream for the log drawer (capped so a chatty engine can't
        // grow it without bound).
        setLiveLog((prev) => {
          const next = prev ? prev + "\n" + line : line;
          const lines = next.split("\n");
          return lines.length > 400 ? lines.slice(-400).join("\n") : next;
        });
        setStatus((s) => {
          if (s.kind === "compiling")
            return {
              kind: "compiling",
              line: lastLine(line, s.line),
              progress: undefined,
            };
          // Terminal states survive late print lines (the engine can emit
          // trailing output after a successful compile).
          if (engineReadyRef.current || s.kind === "done" || s.kind === "error")
            return s;
          return {
            kind: "loading",
            line: lastLine(line, s.kind === "loading" ? s.line : ""),
            // A plain print line does not cancel an in-flight progress bar
            // (the first-run package install runs alongside engine load).
            progress: s.kind === "loading" ? s.progress : undefined,
          };
        });
      },
      () => {
        engineReadyRef.current = true;
        setEngineReady(true);
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

  // Drop the worker AND the build cache. A worker is only dropped when
  // the CTAN package store changed (an install/remove) — that changes
  // what "same inputs" produces, so every cached output is stale (the
  // unmount dispose does not clear the cache: the store is intact when
  // the editor closes). The build STATE (aux/bcf/bbl) is kept — it is
  // the document's own content, not a store-dependent output.
  const disposeCompiler = () => {
    compilerRef.current?.dispose();
    const id = persistStateRef.current.activeProjectId;
    if (id) void clearBuildCache(id).catch(() => {});
  };

  // The engine caches file-lookup misses for its worker's lifetime, so a
  // package install or remove only takes effect after the worker restarts.
  // A compile in flight must not be torn down (its promise would never
  // settle), so the restart is deferred to that compile's finally block.
  // Declared before the `compile` useCallback that captures this ref: the
  // React compiler treats values passed to a hook as frozen from the call
  // site on, so a later mutation (in restartCompiler) would be an
  // immutability error.
  const restartPendingRef = useRef(false);
  const restartCompiler = () => {
    if (busyRef.current) {
      restartPendingRef.current = true;
    } else {
      disposeCompiler();
    }
  };

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
    // The old PDF stays on screen while the build runs (the reader keeps
    // reading it; the status bar shows the build is in flight). The
    // viewport callback keeps this target fresh if they scroll it, and
    // the restore effect applies it when the new PDF lands.
    pendingScrollRef.current = pdfRef.current?.getViewportTop() ?? null;
    setLiveLog("");
    setStatus({ kind: "compiling", line: "preparing…" });
    const started = performance.now();
    try {
      // Incremental builds, part A — the build cache (OPFS,
      // artifacts/<id>/build/cache/, see opfs.ts): the inputs (every file
      // plus the main path, sha256'd by contentHash) hash to a previous
      // successful build's output, so the engine is never touched. A
      // package-store change clears the cache (disposeCompiler) because it
      // changes what "same inputs" produces.
      if (projectId) {
        const hash = await contentHash({ ...files, "\u0000main": mainPath });
        const cached = await loadBuildCache(projectId, hash).catch(() => null);
        if (cached) {
          if (projectId !== persistStateRef.current.activeProjectId) return;
          setPdf(cached.pdf);
          setLog(cached.log);
          setSyncEntries(
            cached.synctex
              ? await decodeSynctex(cached.synctex, Object.keys(files), mainPath).catch(
                  () => null,
                )
              : null,
          );
          setStatus({ kind: "done", ms: Math.round(performance.now() - started) });
          recordHistory(true, { ms: Math.round(performance.now() - started) });
          return;
        }
      }
      await compiler.init();
      if (projectId !== persistStateRef.current.activeProjectId) return;
      // Incremental builds, part B — seed this build with the last
      // successful build's state (opfs.ts): the .aux/.bcf/.bbl ride in as
      // ordinary project files (the pipeline writes them before its first
      // pass, so labels and citations resolve in fewer passes), and the
      // .bib hashes tell the pipeline whether the bibliography step can be
      // skipped (biber is a separate WASM module).
      let compileFiles: Record<string, string | Uint8Array> = files;
      let bibHashes: Record<string, string> | null = null;
      if (projectId) {
        const state = await loadBuildState(projectId, mainPath).catch(() => null);
        if (state) {
          const base = mainPath.replace(/\.tex$/i, "");
          const seed: Record<string, string | Uint8Array> = {};
          if (state.aux && state.aux.byteLength > 0) seed[`${base}.aux`] = state.aux;
          if (state.bcf && state.bcf.byteLength > 0) seed[`${base}.bcf`] = state.bcf;
          if (state.bbl && state.bbl.byteLength > 0) seed[`${base}.bbl`] = state.bbl;
          if (Object.keys(seed).length > 0) compileFiles = { ...files, ...seed };
          bibHashes = state.bibHashes;
        }
      }
      // All files go to the worker (text as strings, binary as bytes);
      // the pipeline runs bibtex8 itself when any of them is a .bib.
      const result = await compiler.compile(compileFiles, mainPath, bibHashes);
      // The build ran for seconds: a project switch in that window must not
      // land the old project's result — or its auto-shown log panel — on the
      // new project (the init() check above only covers that short window).
      if (projectId !== persistStateRef.current.activeProjectId) return;
      // An empty PDF is a failure (a zero-length Uint8Array is truthy).
      if (result.pdf && result.pdf.byteLength > 0) {
        setPdf(result.pdf);
        setStatus({ kind: "done", ms: Math.round(performance.now() - started) });
        recordHistory(true, { ms: Math.round(performance.now() - started) });
        // Refresh the dashboard's square thumbnail (first page). Fire-and-
        // forget: rendering it is best-effort and must never affect the
        // compile result the reader just saw.
        if (projectId) {
          void (async () => {
            try {
              const png = await renderFirstPagePng(result.pdf!);
              if (png) await savePreview(projectId, png);
            } catch {
              // best effort — the thumbnail is optional
            }
          })();
        }
      } else {
        // Keep the previous PDF on screen: it is still the last successful
        // build of this project, and the failure is visible in the status
        // bar and the (auto-shown) log panel.
        setStatus({ kind: "error", message: "Compilation failed — see log" });
        setLeftPane("log");
        recordHistory(false, { message: "Compilation failed — see log" });
      }
      setLog(result.log);
      // A missing babel language (\usepackage[portuguese]{babel}): recent TeX
      // Live ships each language's definition file (<lang>.ldf) in its own
      // babel-* tlpkg that the base tree lacks, so the build fails with
      // "Unknown option 'portuguese'". Install the tlpkg that provides the
      // file and recompile. The worker must restart first — it caches
      // file-lookup misses for its lifetime, so the new file is invisible
      // until a fresh worker (see restartCompiler) is built and the store
      // files re-sent.
      if (!result.pdf) {
        const m =
          /Package babel Error: Unknown option '([^']+)'/.exec(result.log ?? "");
        const lang = m?.[1]?.toLowerCase();
        if (lang && !babelAutoFixedRef.current.has(lang)) {
          const pkg = await packageForFile(`${lang}.ldf`).catch(() => null);
          if (pkg) {
            setStatus({
              kind: "compiling",
              line: `installing ${pkg} (language “${lang}”)…`,
            });
            let installed = false;
            try {
              await installWithDependencies(pkg);
              installed = true;
            } catch {
              // the install failed — keep the "Compilation failed" status
            }
            if (installed) {
              babelAutoFixedRef.current.add(lang);
              // Reuse the mid-compile package-change path: the finally block
              // below disposes the worker (restartPending) and requeues a
              // compile (recompileQueued) that picks the file up.
              restartPendingRef.current = true;
              recompileQueuedRef.current = true;
              return;
            }
          }
        }
      }
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
      // Incremental builds — persist this build for the next one. The
      // cache entry (part A) lets an unchanged recompile skip the engine;
      // the build state (part B) lets the pipeline seed the next pass and
      // skip the bibliography step. Both are fire-and-forget: persisting
      // is best-effort and must never change the result the reader saw.
      // A failed build persists nothing (buildState is null on failure —
      // a half-written state must not seed the next build).
      if (projectId && result.pdf && result.pdf.byteLength > 0) {
        const pdf = result.pdf;
        const hash = await contentHash({ ...files, "\u0000main": mainPath });
        void (async () => {
          try {
            await saveBuildCache(projectId, hash, {
              pdf: Uint8Array.from(pdf),
              log: result.log,
              synctex: result.synctex ? Uint8Array.from(result.synctex) : null,
            });
          } catch {
            // best effort
          }
        })();
        if (result.buildState) {
          const bs = result.buildState;
          void saveBuildState(projectId, mainPath, bs).catch(() => {});
        }
      }
    } catch (err) {
      // Same stale-switch guard as after the compile call: a build of the
      // outgoing project must not flag the incoming one as failed.
      if (projectId === persistStateRef.current.activeProjectId) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message: msg });
        setLeftPane("log");
        recordHistory(false, { message: msg });
      }
    } finally {
      busyRef.current = false;
      if (restartPendingRef.current) {
        restartPendingRef.current = false;
        // A package changed mid-compile (see restartCompiler): drop the
        // worker so the next compile restarts it with the new package
        // list and a fresh miss cache (and clear the build cache — see
        // disposeCompiler).
        disposeCompiler();
      }
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
  }, [files, mainPath, recordHistory]);
  // Called by the packages modal after a successful install/remove: the
  // engine must restart to pick the package up (see above).
  const handlePackagesChanged = (msg: string) => {
    showNotice(`${msg} — the engine restarts with the next compile`, 5000);
    restartCompiler();
  };

  // Restore the PDF scroll position after a recompile. The new PDF is a
  // fresh document that pdf.js renders asynchronously, so poll until the
  // page exists (up to ~6 s). The target was captured at build start and
  // kept fresh while the (still-visible) old PDF was scrolled; it is
  // cleared on a project switch, so a stale position can never be applied
  // to another project's PDF.
  useEffect(() => {
    const target = pendingScrollRef.current;
    // No PDF means nothing to restore into (first build, project switch)
    // — and never consume the target on that state.
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
        lockRef.current.until = now() + 500;
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

  // --- first-run default packages --------------------------------------
  // A fresh browser's CTAN store is empty; the curated default set (see
  // ctan-store.ts) installs in the background so the first compile of a
  // common document does not sit on missing packages. The sweep runs once
  // per store (the manifest marker survives), a ?noDefaults=1 visit
  // skips it (used by the e2e clean-store suite), and a failed sweep
  // (network blip) simply retries on the next load. Declared after
  // restartCompiler/showNotice so the closure never captures a
  // not-yet-declared binding.
  // The progress callback must not be a plain closure of this effect:
  // dev-mode React strict mode double-mounts the page, and the FIRST
  // effect run's ensureDefaults() call is the one that registers the
  // callback the store holds for the sweep's whole life (see
  // ctan-store.ts) — that first run is then immediately cleaned up.
  // Route the callback through a ref so the store's single captured
  // callback always reaches the effect run that is alive (or none,
  // after a real unmount).
  const defaultsProgressRef = useRef<
    ((name: string, done: number, total: number) => void) | null
  >(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("noDefaults")) return;
    defaultsProgressRef.current = (_name, done, total) => {
      // Take over the status slot (text line + progress bar) from idle,
      // engine loading, and even a finished compile: the point of the bar
      // is that the install stays visible while the sweep runs in the
      // background. An active compile keeps its own streaming lines, and
      // a visible error is left alone (the log drawer is open — the user
      // is looking at it, and replacing it would hide the failure).
      setStatus((s) =>
        s.kind === "compiling" || s.kind === "error"
          ? s
          : {
              kind: "loading",
              line: `Installing default packages ${done + 1}/${total}…`,
              // Drives the status progress bar: one step per package
              // installed into the OPFS store.
              progress: { loaded: done, total },
            },
      );
    };
    void ensureDefaults((_name, done, total) => {
      defaultsProgressRef.current?.(_name, done, total);
    })
      .then((installed) => {
        if (installed.length === 0) return;
        // The worker that started with the empty store caches that state;
        // drop it so the next compile re-reads the store (see
        // restartCompiler). Nothing to do if the engine never started.
        restartCompiler();
        showNotice(
          `Installed ${installed.length} default LaTeX packages — the engine restarts with the next compile`,
          5000,
        );
        // The install line is done; if the status slot still shows it
        // (no compile took it over in the meantime) hand it back to
        // "Ready." so the bar doesn't sit at 100% forever.
        setStatus((s) =>
          s.kind === "loading" && s.line.startsWith("Installing default packages")
            ? { kind: "idle" }
            : s,
        );
      })
      .catch(() => {
        // Retried on the next load (the marker is only written on
        // success); the Packages modal can always install by hand.
      });
    return () => {
      defaultsProgressRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    lockRef.current.until = now() + 500;
    if (file === activePath) {
      revealLine(line, { flash: !quiet, select: !quiet });
    } else {
      // Open the file as a tab if it isn't open yet — switching the active
      // path alone would leave the editor pane empty for an unopened file.
      pendingJumpRef.current = { file, line, quiet };
      openPath(file);
    }
  };

  /** Search view: open the file (if needed) and jump to the line. */
  const jumpToLine = (path: string, line: number) => {
    // A programmatic editor scroll follows; stop it from bouncing the
    // PDF back (the same guard the synctex jumps use).
    lockRef.current.until = now() + 500;
    if (path === activePath) {
      revealLine(line, { flash: true, select: true });
    } else {
      pendingJumpRef.current = { file: path, line, quiet: false };
      openPath(path);
    }
  };

  // Monaco switches the model in its own (child) effect, which runs before
  // this one — so the model for `activePath` is live when we get here.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.file !== activePath) return;
    pendingJumpRef.current = null;
    lockRef.current.until = now() + 500;
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
    lockRef.current.until = now() + 500;
    pdfRef.current?.scrollToPosition(entry.page, entry.yTop, {
      select: true,
      instant: false,
    });
  };

  // --- formatting toolbar (inscribe.io style) -----------------------------
  // All inserts go through editor.executeEdits, so the normal
  // onChange → setFiles pipeline handles the file state, the debounced OPFS
  // save and the auto-recompile. With no selection, a placeholder is
  // inserted pre-selected so typing overwrites it.

  const formatWrap = (prefix: string, suffix: string, placeholder: string) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const sel = editor.getSelection();
    const pos = editor.getPosition();
    if (!sel || !pos) return;
    if (!sel.isEmpty()) {
      const range = new monaco.Selection(
        sel.startLineNumber,
        sel.startColumn,
        sel.endLineNumber,
        sel.endColumn,
      );
      const inner = editor.getModel()?.getValueInRange(range) ?? "";
      editor.executeEdits("format-toolbar", [
        { range, text: prefix + inner + suffix },
      ]);
      editor.setSelection(
        new monaco.Selection(
          sel.startLineNumber,
          sel.startColumn + prefix.length,
          sel.endLineNumber,
          sel.endColumn + suffix.length,
        ),
      );
    } else {
      editor.executeEdits("format-toolbar", [
        {
          range: new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
          text: placeholder,
        },
      ]);
      editor.setSelection(
        new monaco.Selection(
          pos.lineNumber,
          pos.column + 1,
          pos.lineNumber,
          pos.column + 1 + placeholder.length,
        ),
      );
    }
    editor.focus();
  };

  const applyBlock = (
    kind:
      | "normal"
      | "section"
      | "subsection"
      | "subsubsection"
      | "itemize"
      | "enumerate",
  ) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    const pos = editor?.getPosition();
    if (!editor || !monaco || !model || !pos) return;
    const line = pos.lineNumber;
    const lineEnd = model.getLineMaxColumn(line);
    const lineRange = new monaco.Range(line, 1, line, lineEnd);
    const content = model.getLineContent(line).trim();
    if (kind === "normal") {
      // Turn a \section{…} back into plain text.
      const m = content.match(/^\\(?:section|subsection|subsubsection)\{([\s\S]*)\}$/);
      if (!m) return;
      editor.executeEdits("format-toolbar", [{ range: lineRange, text: m[1] }]);
    } else if (kind === "itemize" || kind === "enumerate") {
      const item = content || "Item";
      const snippet = `\\begin{${kind}}\n  \\item ${item}\n\\end{${kind}}`;
      editor.executeEdits("format-toolbar", [{ range: lineRange, text: snippet }]);
      editor.setSelection(
        new monaco.Selection(line + 1, 8, line + 1, 8 + item.length),
      );
    } else {
      const cmd = `\\${kind}`;
      // If the line is already a heading, re-wrap its title.
      const m = content.match(/^\\(?:section|subsection|subsubsection)\{([\s\S]*)\}$/);
      const inner = m ? m[1] : content || "Section";
      editor.executeEdits("format-toolbar", [
        { range: lineRange, text: `${cmd}{${inner}}` },
      ]);
      editor.setSelection(
        new monaco.Selection(line, cmd.length + 2, line, cmd.length + 2 + inner.length),
      );
    }
    editor.focus();
  };

  const insertSnippet = (text: string, selOffset?: { col: number; len: number }) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const pos = editor?.getPosition();
    if (!editor || !monaco || !pos) return;
    editor.executeEdits("format-toolbar", [
      {
        range: new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text,
      },
    ]);
    editor.setSelection(
      selOffset
        ? new monaco.Selection(
            pos.lineNumber,
            pos.column + selOffset.col,
            pos.lineNumber,
            pos.column + selOffset.col + selOffset.len,
          )
        : new monaco.Selection(
            pos.lineNumber,
            pos.column + text.length,
            pos.lineNumber,
            pos.column + text.length,
          ),
    );
    editor.focus();
  };

  // \sout needs the ulem package; the default project doesn't load it, so
  // insert it right after \documentclass in the active file once.
  const ensureUlem = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    const pkg = "\\usepackage[normalem]{ulem}";
    if (model.getValue().includes(pkg)) return;
    const count = model.getLineCount();
    for (let l = 1; l <= count; l++) {
      if (model.getLineContent(l).includes("\\documentclass")) {
        editor.executeEdits("format-toolbar", [
          {
            range: new monaco.Range(l, model.getLineMaxColumn(l), l + 1, 1),
            text: "\n" + pkg,
          },
        ]);
        return;
      }
    }
  };

  // --- scroll sync (two-way, guarded by lockRef) --------------------------

  /** Editor scrolled: the PDF follows the editor's top visible line. */
  const handleEditorScroll = () => {
    const t = now();
    if (!syncScrollRef.current || lockRef.current.until > t) return;
    const editor = editorRef.current;
    const entries = syncEntriesRef.current;
    if (!editor || !entries) return;
    const ranges = editor.getVisibleRanges();
    if (ranges.length === 0) return;
    const line = ranges[0].startLineNumber;
    const entry = findOutputForSource(entries, activePathRef.current, line);
    if (!entry) return;
    lockRef.current.until = t + 500;
    pdfRef.current?.scrollToPosition(entry.page, entry.yTop, {
      select: false,
      instant: true,
    });
  };

  /** PDF scrolled: the editor follows the topmost visible line. */
  const handleViewportTop = (page: number, yTopPts: number) => {
    // While a build is in flight the old PDF is still on screen: keep the
    // pending scroll target at wherever the reader scrolls it, so the new
    // PDF lands where they left off, not where the build started.
    if (busyRef.current) pendingScrollRef.current = { page, yTop: yTopPts };
    const t = now();
    if (!syncScrollRef.current || lockRef.current.until > t) return;
    const entries = syncEntriesRef.current;
    if (!entries) return;
    // x = 0: for scroll-following the leftmost line of the physical line
    // is the right one (single-column documents).
    const entry = findSourceForPoint(entries, page, 0, yTopPts);
    if (!entry) return;
    lockRef.current.until = t + 500;
    jumpToSource(entry, true);
  };

  const entries: FileEntry[] = useMemo(
    () =>
      Object.keys(files)
        .sort()
        .map((p) => ({ path: p, isBinary: typeof files[p] !== "string" })),
    [files],
  );

  // Keep the mirror refs fresh after every render. They exist because the
  // handlers attached once (Monaco onMount, the window drop guard, the PDF
  // scroll callback) and the long-lived chat tool loop outlive renders,
  // where a render-time closure would be stale. Written in a layout
  // effect rather than during render (the React compiler forbids updating
  // refs while rendering); it runs before passive effects and before
  // paint, so the auto-compile effect and every event handler read
  // current values — including the chat tools' context (chatCtxRef).
  useLayoutEffect(() => {
    filesRef.current = files;
    statusRef.current = status;
    persistStateRef.current = {
      files,
      mainPath,
      openPaths,
      activePath,
      projectName,
      activeProjectId,
      loaded,
    };
    syncEntriesRef.current = syncEntries;
    activePathRef.current = activePath;
    syncScrollRef.current = syncScroll;
    autoRef.current = autoRecompile;
    compileRef.current = compile;
    uploadFilesRef.current = uploadFiles;
    chatCtxRef.current = {
      ...chatCtxRef.current,
      files,
      activePath,
      mainPath,
      log,
      entries,
      handlePackagesChanged,
    };
  });

  // Search view: matches across the project's text files (binary files
  // are skipped — their bytes are not text). Filename first, then line
  // number; capped so a large project can't build an unbounded list.
  const searchResults = useMemo(() => {
    const out: { path: string; line: number; text: string }[] = [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return out;
    for (const [path, data] of Object.entries(files)) {
      if (typeof data !== "string") continue;
      const lines = data.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          out.push({ path, line: i + 1, text: lines[i].trim() });
          if (out.length >= 200) return out;
        }
      }
    }
    return out;
  }, [files, searchQuery]);

  const statusText =
    status.kind === "idle"
      ? "Ready."
      : status.kind === "loading"
        // The first-run package install takes over the status line; the
        // "Loading engine…" prefix would mislabel it.
        ? status.line.startsWith("Installing")
          ? status.line
          : `Loading engine… ${status.line}`
        : status.kind === "compiling"
          ? `Compiling… ${status.line}`
          : status.kind === "done"
            ? `Compiled in ${status.ms} ms`
            : status.message;
  // A data-asset download in flight replaces the streaming status text
  // with a progress bar (determinate once the loader knows the total).
  const downloading =
    (status.kind === "loading" || status.kind === "compiling") &&
    status.progress !== undefined;
  const dlPct =
    downloading && status.progress!.total > 0
      ? Math.min(100, Math.round((status.progress!.loaded / status.progress!.total) * 100))
      : null;

  // --- workspace panes ----------------------------------------------------
  // The editor and PDF panes carry flex-grow ratios (zero basis), so the
  // fixed-width divider is absorbed and the editor's share of the row is
  // exactly `split`. The values travel WITH the panes, so a swap keeps
  // each pane's size.
  const editorPane = (
    <div
      style={{ flex: `${workspace.split} 1 0%` }}
      className="flex min-w-0 flex-col bg-white"
    >
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
      {/* Formatting toolbar (inscribe.io style): block type, inline
          formatting, snippets; the right side reports the debounced OPFS
          persist. */}
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-ink/10 bg-white px-2">
        <select
          data-format-block
          value="normal"
          onChange={(e) => {
            if (e.target.value !== "normal")
              applyBlock(
                e.target.value as
                  | "section"
                  | "subsection"
                  | "subsubsection"
                  | "itemize"
                  | "enumerate",
              );
          }}
          title="Block type (applies to the line at the cursor)"
          className="h-6 shrink-0 rounded border border-stone/40 bg-white px-1 text-xs text-stone outline-none focus:border-ink"
        >
          <option value="normal">Normal text</option>
          <option value="section">Section</option>
          <option value="subsection">Subsection</option>
          <option value="subsubsection">Subsubsection</option>
          <option value="itemize">Itemize</option>
          <option value="enumerate">Enumerate</option>
        </select>
        <span className="mx-1 h-4 w-px shrink-0 bg-ink/10" />
        {(
          [
            ["emph", "Italic — \\emph{…}", "\\emph{", "}", "\\emph{Text}", "I"],
            ["strong", "Bold — \\textbf{…}", "\\textbf{", "}", "\\textbf{Text}", "B"],
            ["underline", "Underline — \\underline{…}", "\\underline{", "}", "\\underline{Text}", "U"],
            ["strikethrough", "Strikethrough — \\sout{…} (adds ulem)", "\\sout{", "}", "\\sout{Text}", "S"],
          ] as const
        ).map(([id, title, prefix, suffix, placeholder, label]) => (
          <button
            key={id}
            data-format={id}
            title={title}
            onClick={() => {
              if (id === "strikethrough") ensureUlem();
              formatWrap(prefix, suffix, placeholder);
            }}
            className={
              "shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-stone transition-colors hover:bg-peach hover:text-ink " +
              (id === "emph" ? "italic" : id === "underline" ? "underline" : "")
            }
          >
            {label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px shrink-0 bg-ink/10" />
        <button
          data-format="link"
          title="Link — \\href{…}{…}"
          onClick={() =>
            formatWrap(
              "\\href{https://example.com/}{",
              "}",
              "\\href{https://example.com/}{Text}",
            )
          }
          className="shrink-0 rounded p-1 text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          <IconLink className="h-3.5 w-3.5" />
        </button>
        <button
          data-format="code"
          title="Code — \\texttt{…}"
          onClick={() => formatWrap("\\texttt{", "}", "\\texttt{code}")}
          className="shrink-0 rounded p-1 text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          <IconCode className="h-3.5 w-3.5" />
        </button>
        <button
          data-format="image"
          title="Image — \\includegraphics{…}"
          onClick={() =>
            insertSnippet("\\includegraphics{figure.png}", { col: 17, len: 10 })
          }
          className="shrink-0 rounded p-1 text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          <IconImage className="h-3.5 w-3.5" />
        </button>
        <button
          data-format="table"
          title="Table — tabular skeleton"
          onClick={() =>
            insertSnippet(
              "\\begin{tabular}{ll}\n  A & B \\\\\n  C & D \\\\\n\\end{tabular}",
            )
          }
          className="shrink-0 rounded p-1 text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          <IconTable className="h-3.5 w-3.5" />
        </button>
        <span
          data-save-state={savePending ? "saving" : "saved"}
          className="ml-auto flex shrink-0 items-center gap-1 text-xs text-stone"
        >
          {savePending ? (
            "Saving…"
          ) : (
            <>
              <IconCheck className="h-3 w-3 text-mint" /> Saved
            </>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {activePath && activeSource !== null ? (
          <MonacoEditor
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
  );

  // Stats for the files-header popover (computed only while it is open —
  // splitting the active file's text is cheap, but pointless per render).
  const activeFileStats = statsOpen
    ? (() => {
        const t = files[activePath];
        if (typeof t !== "string") return null;
        return {
          words: t.trim().split(/\s+/).filter(Boolean).length,
          lines: t.split("\n").length,
        };
      })()
    : null;

  const pdfPane = (
    <div
      style={{ flex: `${1 - workspace.split} 1 0%` }}
      className="flex min-w-0 flex-col"
    >
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
        // The pane's top is one row (inscribe.io style): the build button
        // lives with the output, left of the viewer controls. The title
        // keeps the "Recompile" prefix — e2e's busy-watcher selects on it.
        leading={
          <>
            <button
              onClick={() => compileRef.current()}
              disabled={status.kind === "compiling"}
              title="Recompile (Ctrl/Cmd+Enter)"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-mint px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status.kind === "compiling" ? (
                <IconSpinner className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <IconPlay className="h-3.5 w-3.5" />
              )}
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
              className="shrink-0 rounded border border-stone/40 px-2 py-1 text-xs text-stone transition-colors hover:bg-peach hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Go to PDF
            </button>
          </>
        }
        onNumPages={setPdfPages}
        // Right-end icons (inscribe.io's right group): compile history,
        // project notes, and the page-count badge on the document glyph.
        trailing={
          <>
            <span data-popover-root="history" className="relative">
              <button
                title="Compile history"
                onClick={() => setHistoryOpen((v) => !v)}
                className="rounded p-0.5 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
              >
                <IconClock className="h-4 w-4" />
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-ink/10 bg-white p-2 shadow-lg">
                  <div className="mb-1 flex items-center justify-between px-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-stone">
                      Compile history
                    </span>
                    <button
                      title="Clear the history"
                      onClick={() => setCompileHistory([])}
                      className="text-xs text-stone transition-colors hover:text-ink"
                    >
                      Clear
                    </button>
                  </div>
                  {compileHistory.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-stone">
                      No compiles yet this session.
                    </p>
                  ) : (
                    <ul className="max-h-72 overflow-y-auto">
                      {compileHistory.map((h, i) => (
                        <li
                          key={h.t + ":" + i}
                          className="flex items-start gap-2 rounded px-1 py-1 text-xs hover:bg-peach/30"
                        >
                          <span
                            className={
                              "mt-1 h-1.5 w-1.5 shrink-0 rounded-full " +
                              (h.ok ? "bg-mint" : "bg-red-500")
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-ink">
                            {h.ok
                              ? `Compiled in ${h.ms} ms`
                              : (h.message ?? "Compilation failed")}
                          </span>
                          <span className="shrink-0 tabular-nums text-stone">
                            {new Date(h.t).toLocaleTimeString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </span>
            <span data-popover-root="notes" className="relative">
              <button
                title="Project notes (kept in this browser)"
                onClick={() => setNotesOpen((v) => !v)}
                className="rounded p-0.5 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
              >
                <IconNote className="h-4 w-4" />
              </button>
              {notesOpen && activeProjectId && (
                <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-ink/10 bg-white p-2 shadow-lg">
                  <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-stone">
                    Notes — {projectName}
                  </p>
                  <textarea
                    // The key remounts the textarea per project, re-reading
                    // that project's stored notes (uncontrolled on purpose:
                    // the value lives in localStorage, written on change).
                    key={activeProjectId}
                    defaultValue={readNotes(activeProjectId)}
                    onChange={(e) =>
                      localStorage.setItem(
                        NOTES_KEY(activeProjectId),
                        e.target.value,
                      )
                    }
                    data-notes
                    placeholder="Notes about this project (kept in this browser)…"
                    rows={6}
                    className="w-full resize-y rounded border border-stone/30 bg-cream/40 px-2 py-1.5 text-xs text-ink focus:border-mint focus:outline-none"
                  />
                </div>
              )}
            </span>
            <span
              title={
                pdfPages > 0
                  ? `${pdfPages} page${pdfPages === 1 ? "" : "s"} in the current PDF`
                  : "No PDF yet — press Compile"
              }
              className="relative rounded p-0.5 text-stone"
            >
              <IconFile className="h-4 w-4" />
              {pdfPages > 0 && (
                <span className="absolute -right-2 -top-1.5 rounded-full bg-peach px-1 text-[9px] font-semibold leading-none text-ink">
                  {pdfPages}
                </span>
              )}
            </span>
          </>
        }
      />
    </div>
  );

  // Draggable divider between the panes. The swap button only appears on
  // hover: the divider is 6 px wide but the button is not, so an always-
  // visible button sits on top of the editor's scrollbar and eats its
  // clicks. At rest it is invisible and click-through.
  const divider = (
    <div
      onPointerDown={(e) => {
        const row = splitRef.current;
        if (!row) return;
        // Capture the press-time values: startLayoutDrag delivers
        // cumulative deltas from the press point.
        const base = workspace.split;
        const dir = workspace.editorFirst ? 1 : -1;
        const w = row.clientWidth;
        startLayoutDrag(e, "col-resize", (dx) =>
          setWorkspace((ws) => ({
            ...ws,
            split: clampN(base + (dir * dx) / w, SPLIT.min, SPLIT.max),
          })),
        );
      }}
      title="Drag to re-split — hover for the swap button"
      className="group relative z-10 w-1.5 shrink-0 cursor-col-resize bg-ink/10 transition-colors hover:bg-mint"
    >
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() =>
          setWorkspace((w) => ({ ...w, editorFirst: !w.editorFirst }))
        }
        title="Swap editor and PDF"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-white p-0.5 text-stone opacity-0 shadow-sm transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-mint hover:text-ink"
      >
        <IconSwap className="h-3 w-3" />
      </button>
    </div>
  );

  return (
    <div className="relative flex h-screen flex-col bg-cream">
      {/* Top bar (Overleaf-style) */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-ink/10 bg-cream px-3">
        <Link
          href="/"
          title="Back to the project dashboard"
          className="flex shrink-0 items-center gap-2 rounded px-1 py-0.5 text-sm font-semibold text-ink transition-colors hover:bg-peach"
        >
          <span className="h-3 w-3 rounded-sm bg-mint" />
          HomeHub
        </Link>
        {/* Project switching, creating and deleting live on the dashboard
            (the wordmark goes there); GitHub and Packages live in the
            left panel's icon rail. */}
        {/* Recompile now sits in the PDF pane's header; the log and chat
            moved to the left panel's icon rail. The build status stays in
            the header — e2e reads it from `header span.truncate`. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Fixed-width slots: the icon and the status text swap content
              (spinner/check/dot/none, streaming compile lines) — variable
              widths would jitter the whole right cluster on every update. */}
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            {status.kind === "compiling" || status.kind === "loading" ? (
              <IconSpinner className="h-3.5 w-3.5 animate-spin text-mint" />
            ) : status.kind === "error" ? (
              <span className="h-2 w-2 rounded-full bg-red-500" />
            ) : status.kind === "done" ? (
              <IconCheck className="h-3.5 w-3.5 text-mint" />
            ) : null}
          </span>
          {downloading ? (
            <span className="flex w-64 shrink-0 items-center gap-2" title={statusText}>
              <span className="relative h-1.5 w-44 overflow-hidden rounded-full bg-ink/10">
                {dlPct !== null ? (
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-mint transition-[width] duration-300"
                    style={{ width: `${dlPct}%` }}
                  />
                ) : (
                  <span className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-mint" />
                )}
              </span>
              {dlPct !== null && (
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-stone">
                  {dlPct}%
                </span>
              )}
            </span>
          ) : (
            <span
              className={
                "w-64 shrink-0 truncate text-xs " +
                (status.kind === "error" ? "text-red-600" : "text-stone")
              }
            >
              {statusText}
            </span>
          )}
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
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Icon rail: switches the left panel's content (inscribe.io's
            vertical tab strip). */}
        <nav
          aria-label="Left panel"
          className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-ink/10 bg-cream py-2"
        >
          {(
            [
              ["files", "Files", IconFile],
              ["search", "Search", IconSearch],
              ["chat", "Chat", IconChat],
              ["log", "Log", IconClock],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              data-rail={id}
              data-active={leftPane === id || undefined}
              title={label}
              onClick={() => setLeftPane(id)}
              className={
                "rounded p-1.5 transition-colors " +
                (leftPane === id
                  ? "bg-mint/40 text-ink"
                  : "text-stone hover:bg-peach/40 hover:text-ink")
              }
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          {/* GitHub and Packages anchor the bottom of the rail (moved out
              of the top bar); data-action keeps the e2e selectors. */}
          <div className="flex-1" />
          <button
            data-action="github"
            onClick={() => setGhModalOpen(true)}
            title="Import a project from GitHub (your token stays in this browser)"
            className="rounded p-1.5 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
          >
            <IconGitHub className="h-4 w-4" />
          </button>
          <button
            data-action="packages"
            onClick={() => setPkgModalOpen(true)}
            title="Pull or remove LaTeX packages from CTAN"
            className="rounded p-1.5 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
          >
            <IconSync className="h-4 w-4" />
          </button>
        </nav>

        {/* Left panel: width from the workspace layout, right edge
            draggable */}
        <div
          className="relative flex shrink-0"
          style={{ width: workspace.filesW }}
        >
          {leftPane === "chat" ? (
            <div className="flex min-w-0 flex-1 flex-col bg-white">
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-ink/10 px-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-stone">
                  Chat
                </h2>
                <button
                  data-chat-clear
                  title="Clear the conversation"
                  onClick={clearChat}
                  className="rounded px-2 py-0.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
                >
                  Clear
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <div
                  ref={chatScrollRef}
                  onScroll={handleChatScroll}
                  className="min-h-0 flex-1 space-y-2 overflow-auto p-3"
                >
                  {chatMessages.length === 0 && !chatError && (
                    <p className="text-xs text-stone">
                      Ask about the document you are editing — or have the
                      assistant read files, compile, fix code (you approve each
                      change), or install packages.
                    </p>
                  )}
                  {chatMessages.map((m, i) =>
                    m.role === "tool" ? (
                      <div
                        key={i}
                        data-chat-role="tool"
                        className="rounded border border-stone/30 bg-peach/30 px-2 py-1.5"
                      >
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-stone">
                          Tool · {m.toolName}
                        </div>
                        <div className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink">
                          {m.content}
                        </div>
                      </div>
                    ) : (
                      <div
                        key={i}
                        data-chat-role={m.role}
                        className={
                          "rounded border px-2 py-1.5 " +
                          (m.role === "user"
                            ? "border-mint/60 bg-mint/30"
                            : "border-stone/30 bg-white/70")
                        }
                      >
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-stone">
                          {m.role === "user" ? "You" : "Assistant"}
                        </div>
                        <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
                          {m.content ||
                            (i === chatMessages.length - 1 && chatBusy
                              ? "…"
                              : "")}
                        </div>
                        {m.role === "assistant" &&
                          m.toolCalls &&
                          m.toolCalls.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {m.toolCalls.map((t) => (
                                <span
                                  key={t.id}
                                  className="rounded bg-peach/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink"
                                >
                                  ⚙ {t.name}
                                </span>
                              ))}
                            </div>
                          )}
                      </div>
                    ),
                  )}
                  {pendingEdits.map((p) => (
                    <div
                      key={p.id}
                      data-chat-pending-edit
                      className="rounded border border-ink/20 bg-white/80 p-2 shadow-sm"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink">
                          Apply edit
                        </span>
                        <span className="truncate font-mono text-[11px] text-stone">
                          {p.path}:{p.line}
                        </span>
                      </div>
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-cream p-1.5 font-mono text-[11px] leading-relaxed">
                        {diffSnippet(p.old, p.new).map((d, li) => (
                          <div
                            key={li}
                            className={
                              d.t === "del"
                                ? "bg-red-100 text-red-800"
                                : d.t === "add"
                                  ? "bg-green-100 text-green-800"
                                  : "text-stone"
                            }
                          >
                            {d.t === "del" ? "- " : d.t === "add" ? "+ " : "  "}
                            {d.text || " "}
                          </div>
                        ))}
                      </pre>
                      <div className="mt-1.5 flex gap-2">
                        <button
                          data-chat-edit-accept
                          onClick={() => decideEdit(p.id, true)}
                          className="rounded bg-mint px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:bg-ink hover:text-mint"
                        >
                          Accept
                        </button>
                        <button
                          data-chat-edit-reject
                          onClick={() => decideEdit(p.id, false)}
                          className="rounded border border-stone/40 px-2.5 py-1 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                  {chatError && (
                    <div
                      data-chat-error
                      className="whitespace-pre-wrap rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700"
                    >
                      {chatError}
                    </div>
                  )}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendChat();
                  }}
                  className="flex shrink-0 items-end gap-2 border-t border-ink/10 p-2"
                >
                  <textarea
                    data-chat-input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendChat();
                      }
                    }}
                    rows={1}
                    placeholder="Ask the assistant… (Enter to send, Shift+Enter for a new line)"
                    className="max-h-24 min-w-0 flex-1 resize-y rounded border border-stone/40 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-ink"
                  />
                  {chatBusy ? (
                    <button
                      type="button"
                      data-chat-stop
                      onClick={stopChat}
                      className="rounded border border-stone/40 px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="submit"
                      data-chat-send
                      disabled={!chatInput.trim()}
                      className="rounded bg-ink px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40 disabled:hover:opacity-40"
                    >
                      Send
                    </button>
                  )}
                </form>
              </div>
            </div>
          ) : leftPane === "log" ? (
            <div className="flex min-w-0 flex-1 flex-col bg-white">
              <div className="flex h-9 shrink-0 items-center border-b border-ink/10 px-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-stone">
                  Log
                </h2>
              </div>
              <div
                ref={logScrollRef}
                onScroll={handleLogScroll}
                className="min-h-0 flex-1 overflow-auto p-3"
              >
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink">
                  {(status.kind === "compiling" || status.kind === "loading"
                    ? liveLog
                    : log) || "(no log output yet)"}
                </pre>
              </div>
            </div>
          ) : leftPane === "search" ? (
            <div className="flex min-w-0 flex-1 flex-col bg-white">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-ink/10 px-3">
                <IconSearch className="h-3.5 w-3.5 shrink-0 text-stone" />
                <input
                  data-search-input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search files…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-stone/60"
                />
                {searchQuery.trim() !== "" && (
                  <span className="shrink-0 text-[10px] tabular-nums text-stone">
                    {searchResults.length}
                    {searchResults.length >= 200 ? "+" : ""}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {searchQuery.trim() === "" ? (
                  <p className="p-3 text-xs text-stone">
                    Search every text file in the project.
                  </p>
                ) : searchResults.length === 0 ? (
                  <p className="p-3 text-xs text-stone">No matches.</p>
                ) : (
                  searchResults.map((hit, i) => (
                    <button
                      key={`${hit.path}:${hit.line}:${i}`}
                      onClick={() => jumpToLine(hit.path, hit.line)}
                      className="block w-full border-b border-ink/5 px-3 py-1.5 text-left transition-colors hover:bg-mint/30"
                    >
                      <span className="block truncate font-mono text-[10px] text-stone">
                        {hit.path}:{hit.line}
                      </span>
                      <span className="block truncate font-mono text-xs text-ink">
                        {hit.text}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
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
              width={workspace.filesW}
              // The project name sits above the tree (inscribe.io position),
              // not in the app bar.
              title={
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  title="Project name (saved in your browser)"
                  className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium text-ink transition-colors hover:border-ink/15 focus:border-mint focus:outline-none"
                />
              }
              // The project stats button — inscribe.io's rightmost icon in
              // the files panel header.
              headerExtra={
                <span
                  data-popover-root="stats"
                  className="relative flex items-center gap-0.5"
                >
                  <button
                    title="Project stats"
                    onClick={() => setStatsOpen((v) => !v)}
                    className="rounded p-1 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
                  >
                    <IconChart className="h-4 w-4" />
                  </button>
                  {statsOpen && (
                    <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-ink/10 bg-white p-2 shadow-lg">
                      <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-stone">
                        {projectName}
                      </p>
                      <dl className="space-y-1 px-1 text-xs">
                        <div className="flex justify-between">
                          <dt className="text-stone">Files</dt>
                          <dd className="tabular-nums text-ink">
                            {entries.length}
                          </dd>
                        </div>
                        {activeFileStats && (
                          <>
                            <div className="flex justify-between">
                              <dt className="text-stone">
                                Words — {activePath}
                              </dt>
                              <dd className="tabular-nums text-ink">
                                {activeFileStats.words.toLocaleString()}
                              </dd>
                            </div>
                            <div className="flex justify-between">
                              <dt className="text-stone">Lines</dt>
                              <dd className="tabular-nums text-ink">
                                {activeFileStats.lines}
                              </dd>
                            </div>
                          </>
                        )}
                        <div className="flex justify-between">
                          <dt className="text-stone">PDF pages</dt>
                          <dd className="tabular-nums text-ink">
                            {pdfPages || "—"}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  )}
                </span>
              }
            />
          )}
          <div
            onPointerDown={(e) => {
              const base = workspace.filesW;
              startLayoutDrag(e, "col-resize", (dx) =>
                setWorkspace((w) => ({
                  ...w,
                  filesW: clampN(base + dx, FILES_W.min, FILES_W.max),
                })),
              );
            }}
            title="Drag to resize the files panel"
            className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize transition-colors hover:bg-mint"
          />
        </div>

        {/* Editor + PDF: a draggable divider splits them, the arrows
            swap the panes */}
        <div ref={splitRef} className="flex min-w-0 flex-1">
          {workspace.editorFirst ? (
            <>
              {editorPane}
              {divider}
              {pdfPane}
            </>
          ) : (
            <>
              {pdfPane}
              {divider}
              {editorPane}
            </>
          )}
        </div>
      </div>


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
          files={files}
          projectSource={projects.find((p) => p.id === activeProjectId)?.source ?? null}
          onPulled={pullGithub}
          onPushed={pushGithub}
          onClose={() => setGhModalOpen(false)}
        />
      )}
      {pkgModalOpen && (
        <PackagesModal
          onChanged={handlePackagesChanged}
          onClose={() => setPkgModalOpen(false)}
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
