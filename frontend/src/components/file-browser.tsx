"use client";

import { useEffect, useRef, useState } from "react";
import {
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
  onAdd: (name: string) => void;
  onRename: (oldPath: string, newName: string) => void;
  onDelete: (path: string) => void;
  onSetMain: (path: string) => void;
  /** Read locally in the browser — files never leave the page. */
  onUpload: (files: File[]) => void;
};

/**
 * Overleaf-style file panel: "Files" header with upload / new-file
 * actions, per-type file icons, hover rename/delete, a "main" badge for
 * the build target, and drag-and-drop upload. New files are created in
 * the row at the bottom. All file bytes stay in the browser.
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
}: Props) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // The page's window-level drop guard stops propagation, so the panel's
  // onDrop does not see file drops; clear the highlight from window too.
  useEffect(() => {
    const clear = () => setDragging(0);
    window.addEventListener("drop", clear, true);
    return () => window.removeEventListener("drop", clear, true);
  }, []);

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onAdd(name);
    setNewName("");
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
      className={
        "flex w-64 shrink-0 flex-col border-r border-ink/10 bg-white " +
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

      <div className="flex h-9 shrink-0 items-center justify-between border-b border-ink/10 px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone">
          Files
        </h2>
        <div className="flex items-center gap-0.5">
          <button
            onClick={pickUpload}
            title="Upload files (kept in your browser)"
            className="rounded p-1 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
          >
            <IconUpload className="h-4 w-4" />
          </button>
          <button
            onClick={pickFolder}
            title="Upload a whole folder, recursively (kept in your browser)"
            className="rounded p-1 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
          >
            <IconFolder className="h-4 w-4" />
          </button>
          <button
            onClick={() => document.getElementById("new-file-input")?.focus()}
            title="New file"
            className="rounded p-1 text-stone transition-colors hover:bg-peach/40 hover:text-ink"
          >
            <IconPlus className="h-4 w-4" />
          </button>
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
        {files.map((f) => {
          const { path, isBinary } = f;
          const isMain = path === mainPath;
          const isActive = path === activePath;
          const isRenaming = renaming === path;
          const depth = path.split("/").length - 1;
          return (
            <li key={path} className="px-1.5 py-0.5">
              <div
                className={
                  "group flex cursor-pointer items-center gap-2 rounded py-1 pr-2 " +
                  (isActive ? "bg-mint/25" : "hover:bg-peach/25")
                }
                style={{ paddingLeft: 8 + depth * 10 }}
                title={path.split("/").slice(0, -1).join("/")}
                onClick={() => {
                  if (!isRenaming) onOpen(path);
                }}
              >
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
                    {path}
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

      <div className="shrink-0 border-t border-ink/10 p-2">
        <div className="flex items-center gap-1.5">
          <input
            id="new-file-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="new-file.tex"
            className="min-w-0 flex-1 rounded border border-ink/15 bg-cream px-2 py-1 text-xs text-ink placeholder:text-stone/60 focus:border-mint focus:outline-none"
          />
          <button
            onClick={add}
            title="Add file"
            className="rounded bg-mint px-2.5 py-1 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint"
          >
            +
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-stone">
          Upload files or a whole folder (the folder icon), or drag them in —
          they stay in your browser. Double-click a name to rename. A .bib
          file triggers bibtex8 automatically.
        </p>
      </div>
    </aside>
  );
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
