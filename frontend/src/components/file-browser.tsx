"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  IconChevronRight,
  IconFile,
  IconFileBib,
  IconFileImage,
  IconFilePdf,
  IconFileTex,
  IconFolder,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUpload,
} from "@/components/icons";

export type FileEntry = {
  path: string;
  isBinary: boolean;
};

type Props = {
  files: FileEntry[];
  activePath: string;
  mainPath: string;
  onOpen: (path: string) => void;
  /** Create a file at `location/name`; returns false (with a notice) when
   * the name or location is invalid, so the modal can stay open. */
  onAdd: (name: string, location: string) => boolean;
  onRename: (oldPath: string, newName: string) => void;
  onDelete: (path: string) => void;
  onSetMain: (path: string) => void;
  /** Read locally in the browser — files never leave the page. */
  onUpload: (files: File[]) => void;
  /** Panel width in px (the workspace layout makes the edge draggable). */
  width?: number;
  /** The panel header's left slot — the page puts the project-name input
   * there (inscribe.io places the project name above the tree, not in the
   * app bar). */
  title?: ReactNode;
  /** Extra header controls at the far right (the page puts the project
   * stats button there — inscribe.io's rightmost header icon). */
  headerExtra?: ReactNode;
};

/**
 * Overleaf-style file panel: "Files" header with upload / new-file
 * actions, per-type file icons, hover rename/delete, a "main" badge for
 * the build target, and drag-and-drop upload. Folders are derived from
 * file paths and rendered as collapsible rows; files show their base
 * name indented by depth. The header "+" opens a modal for the file
 * name and its folder. All file bytes stay in the browser.
 */
export default function FileBrowser({
  files,
  activePath,
  mainPath,
  onOpen,
  onAdd,
  onRename,
  onDelete,
  onSetMain,
  onUpload,
  width,
  title,
  headerExtra,
}: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalName, setModalName] = useState("");
  const [modalLoc, setModalLoc] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // Folders have no entries of their own — they are implied by file
  // paths — so the ordered row list (folders before files, alphabetically
  // within each level) is computed. Collapse is view state only, expanded
  // by default.
  const rows = useMemo(() => buildRows(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const hiddenBy = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (collapsed.has(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  };

  // A file that just landed (new-file modal, upload, drop) must not
  // disappear into a collapsed folder: expand its ancestors so the user
  // can see where it went.
  const prevPathsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const current = new Set(files.map((f) => f.path));
    const prev = prevPathsRef.current;
    prevPathsRef.current = current;
    if (!prev) return; // first render: nothing is new yet
    const added = [...current].filter((p) => !prev.has(p));
    if (added.length === 0) return;
    setCollapsed((prevCollapsed) => {
      let changed = false;
      const next = new Set(prevCollapsed);
      for (const p of added) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) {
          if (next.delete(parts.slice(0, i).join("/"))) changed = true;
        }
      }
      return changed ? next : prevCollapsed;
    });
  }, [files]);

  // The page's window-level drop guard stops propagation, so the panel's
  // onDrop does not see file drops; clear the highlight from window too.
  useEffect(() => {
    const clear = () => setDragging(0);
    window.addEventListener("drop", clear, true);
    return () => window.removeEventListener("drop", clear, true);
  }, []);

  const closeModal = () => {
    setModalOpen(false);
    setModalName("");
    setModalLoc("");
  };

  // A failed create leaves the modal open — the page's notice pill
  // explains why — so the user can fix the name or location in place.
  const createFile = () => {
    const name = modalName.trim();
    if (!name) return;
    if (onAdd(name, modalLoc.trim().replace(/\/+$/, ""))) closeModal();
  };

  const startRename = (path: string) => {
    setRenaming(path);
    setDraft(path);
  };

  const commitRename = (path: string) => {
    setRenaming(null);
    const name = draft.trim();
    if (name && name !== path) onRename(path, name);
  };

  const pickUpload = () => inputRef.current?.click();
  const pickFolder = () => dirInputRef.current?.click();

  return (
    <aside
      style={width !== undefined ? { width } : undefined}
      className={
        "flex shrink-0 flex-col border-r border-ink/10 bg-white " +
        (width === undefined ? "w-64 " : "") +
        (dragging > 0 ? "bg-mint/10" : "")
      }
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging((d) => d + 1);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging((d) => Math.max(0, d - 1));
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(0);
        const list = Array.from(e.dataTransfer.files);
        if (list.length) onUpload(list);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (list.length) onUpload(list);
        }}
      />
      {/* webkitdirectory makes the picker select a whole folder tree;
          each File then carries a webkitRelativePath the page uses to
          recreate the folder structure (top folder stripped). */}
      <input
        ref={dirInputRef}
        type="file"
        multiple
        className="hidden"
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (list.length) onUpload(list);
        }}
      />

      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-ink/10 px-3">
        <div className="min-w-0 flex-1">
          {title ?? (
            <h2 className="text-xs font-semibold uppercase tracking-wide text-stone">
              Files
            </h2>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderBtn
            action="upload-folder"
            tip="Upload a whole folder (kept in your browser)"
            onClick={pickFolder}
          >
            <IconFolder className="h-4 w-4" />
          </HeaderBtn>
          <HeaderBtn
            action="new-file"
            tip="New file"
            onClick={() => setModalOpen(true)}
          >
            <IconPlus className="h-4 w-4" />
          </HeaderBtn>
          <HeaderBtn
            action="upload"
            tip="Upload files (kept in your browser)"
            onClick={pickUpload}
          >
            <IconUpload className="h-4 w-4" />
          </HeaderBtn>
          {headerExtra}
        </div>
      </div>

      {dragging > 0 && (
        <div className="border-b border-mint/50 bg-mint/20 px-3 py-1.5 text-xs font-medium text-ink">
          Drop files or a folder to add them
        </div>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.length === 0 && (
          <li className="px-3 py-2 text-xs text-stone">
            No files yet — add one below.
          </li>
        )}
        {rows.map((row) => {
          // Rows are flat siblings (no nested <li>): a file's ancestors
          // are separate rows, and a collapsed ancestor hides its subtree.
          if (hiddenBy(row.path)) return null;
          if (row.kind === "folder") {
            const open = !collapsed.has(row.path);
            return (
              <li key={"d:" + row.path} className="px-1.5 py-0.5">
                <div
                  className="group flex cursor-pointer select-none items-center gap-2 rounded py-1 pr-2 hover:bg-peach/25"
                  style={{ paddingLeft: 8 + row.depth * 10 }}
                  title={row.path}
                  onClick={() => toggleFolder(row.path)}
                >
                  <span className="flex w-4 shrink-0 justify-center text-stone">
                    <IconChevronRight
                      className={
                        "h-3 w-3 transition-transform " +
                        (open ? "rotate-90" : "")
                      }
                    />
                  </span>
                  <span
                    className="flex w-4 shrink-0 justify-center text-stone"
                    data-kind="folder"
                  >
                    <IconFolder className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {row.path.split("/").pop()}
                  </span>
                </div>
              </li>
            );
          }
          const { path, isBinary } = row;
          const isMain = path === mainPath;
          const isActive = path === activePath;
          const isRenaming = renaming === path;
          return (
            <li key={"f:" + path} className="px-1.5 py-0.5">
              <div
                className={
                  "group flex cursor-pointer items-center gap-2 rounded py-1 pr-2 " +
                  (isActive ? "bg-mint/25" : "hover:bg-peach/25")
                }
                style={{ paddingLeft: 8 + row.depth * 10 }}
                title={path.split("/").slice(0, -1).join("/")}
                onClick={() => {
                  if (!isRenaming) onOpen(path);
                }}
              >
                {/* Empty chevron gutter so the file icon sits in the same
                    column as folder icons (chevron rows shift it right). */}
                <span className="w-4 shrink-0" aria-hidden />
                <span
                  className="flex w-4 shrink-0 justify-center text-stone"
                  data-kind={kindOf(path, isBinary)}
                >
                  {fileIcon(path, isBinary)}
                </span>

                {isRenaming ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(path);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => commitRename(path)}
                    className="min-w-0 flex-1 rounded border border-mint bg-white px-1.5 py-0.5 text-sm text-ink focus:outline-none"
                  />
                ) : (
                  <span
                    title={path + (isMain ? " (main file)" : "") + " — double-click to rename"}
                    onDoubleClick={() => startRename(path)}
                    className="min-w-0 flex-1 truncate text-sm text-ink"
                  >
                    {path.split("/").pop()}
                  </span>
                )}

                {isMain ? (
                  <span
                    title="Build target"
                    className="shrink-0 rounded bg-mint px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink"
                  >
                    main
                  </span>
                ) : path.toLowerCase().endsWith(".tex") && !isRenaming ? (
                  <button
                    title="Set as main file"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSetMain(path);
                    }}
                    className="shrink-0 rounded border border-ink/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-stone opacity-0 transition-opacity hover:bg-mint hover:text-ink group-hover:opacity-100"
                  >
                    main
                  </button>
                ) : null}

                {!isRenaming && (
                  <>
                    <button
                      title="Rename file"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(path);
                      }}
                      className="shrink-0 rounded p-0.5 text-stone opacity-0 transition-opacity hover:bg-peach/60 hover:text-ink group-hover:opacity-100"
                    >
                      <IconPencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      title="Delete file"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(path);
                      }}
                      className="shrink-0 rounded p-0.5 text-stone opacity-0 transition-opacity hover:bg-red-100 hover:text-red-600 group-hover:opacity-100"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {modalOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30"
          onClick={closeModal}
        >
          <div
            data-modal="new-file"
            className="w-80 rounded-lg border border-ink/10 bg-white p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-ink">New file</h3>
            <label className="mt-3 block text-xs font-medium text-stone">
              Name
              <input
                autoFocus
                value={modalName}
                onChange={(e) => setModalName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFile();
                  if (e.key === "Escape") closeModal();
                }}
                placeholder="chapter.tex"
                className="mt-1 w-full rounded border border-ink/15 bg-cream px-2 py-1 text-sm text-ink placeholder:text-stone/60 focus:border-mint focus:outline-none"
              />
            </label>
            <label className="mt-2 block text-xs font-medium text-stone">
              Location
              <input
                value={modalLoc}
                onChange={(e) => setModalLoc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFile();
                  if (e.key === "Escape") closeModal();
                }}
                placeholder="empty for the project root, e.g. ch/"
                className="mt-1 w-full rounded border border-ink/15 bg-cream px-2 py-1 text-sm text-ink placeholder:text-stone/60 focus:border-mint focus:outline-none"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closeModal}
                className="rounded border border-stone/40 px-3 py-1 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={createFile}
                className="rounded bg-mint px-3 py-1 text-xs font-semibold text-ink transition-colors hover:bg-ink hover:text-mint"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/** Header action button with a CSS hover tooltip (the native `title`
 *  only appears after a long hover delay). */
function HeaderBtn({
  action,
  tip,
  onClick,
  children,
}: {
  action: string;
  tip: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-action={action}
      onClick={onClick}
      className="group relative rounded p-1 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
    >
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
        {tip}
      </span>
    </button>
  );
}

type RowNode =
  | { kind: "folder"; path: string; depth: number }
  | { kind: "file"; path: string; depth: number; isBinary: boolean };

/**
 * Flatten the implicit folder tree into ordered sibling rows: at every
 * level folders first, then files, alphabetical within each group, and a
 * folder's children directly under it. Folders exist only as prefixes of
 * file paths, so the rows are computed, never stored.
 */
function buildRows(entries: FileEntry[]): RowNode[] {
  type Branch = { dirs: Map<string, Branch>; files: FileEntry[] };
  const root: Branch = { dirs: new Map(), files: [] };
  for (const f of entries) {
    const parts = f.path.split("/");
    let branch = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      let next = branch.dirs.get(key);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        branch.dirs.set(key, next);
      }
      branch = next;
    }
    branch.files.push(f);
  }
  const rows: RowNode[] = [];
  const walk = (branch: Branch, dir: string, depth: number) => {
    for (const name of [...branch.dirs.keys()].sort()) {
      const p = dir ? `${dir}/${name}` : name;
      rows.push({ kind: "folder", path: p, depth });
      walk(branch.dirs.get(name)!, p, depth + 1);
    }
    for (const f of [...branch.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      rows.push({ kind: "file", path: f.path, depth, isBinary: f.isBinary });
    }
  };
  walk(root, "", 0);
  return rows;
}

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "tif",
  "tiff",
  "bmp",
  "avif",
]);

export function kindOf(path: string, isBinary: boolean): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "tex") return "tex";
  if (ext === "bib") return "bib";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.has(ext) || isBinary) return "image";
  return "other";
}

export function fileIcon(path: string, isBinary: boolean) {
  const kind = kindOf(path, isBinary);
  switch (kind) {
    case "tex":
      return <IconFileTex className="h-4 w-4" />;
    case "bib":
      return <IconFileBib className="h-4 w-4" />;
    case "pdf":
      return <IconFilePdf className="h-4 w-4" />;
    case "image":
      return <IconFileImage className="h-4 w-4" />;
    default:
      return <IconFile className="h-4 w-4" />;
  }
}
