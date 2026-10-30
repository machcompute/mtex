"use client";

import { useState } from "react";

type Props = {
  /** Sorted file paths (flat names, e.g. "main.tex", "refs.bib"). */
  files: string[];
  activePath: string;
  mainPath: string;
  onOpen: (path: string) => void;
  onAdd: (name: string) => void;
  onRename: (oldPath: string, newName: string) => void;
  onDelete: (path: string) => void;
  onSetMain: (path: string) => void;
};

/**
 * Left-hand file browser for the LaTeX editor: open, add, rename
 * (double-click) and delete files, and pick which .tex is the build
 * target ("main").
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
}: Props) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-ink/10 bg-cream">
      <div className="border-b border-ink/10 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone">
          Files
        </h2>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.length === 0 && (
          <li className="px-3 py-2 text-xs text-stone">
            No files yet — add one below.
          </li>
        )}
        {files.map((path) => {
          const isMain = path === mainPath;
          const isActive = path === activePath;
          const isRenaming = renaming === path;
          return (
            <li key={path} className="px-1.5 py-0.5">
              <div
                className={
                  "group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 " +
                  (isActive ? "bg-peach/60" : "hover:bg-peach/30")
                }
                onClick={() => {
                  if (!isRenaming) onOpen(path);
                }}
              >
                <span className="w-11 shrink-0">
                  {isMain ? (
                    <span
                      title="Build target"
                      className="inline-block rounded bg-mint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink"
                    >
                      main
                    </span>
                  ) : path.endsWith(".tex") ? (
                    <button
                      title="Set as main file"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetMain(path);
                      }}
                      className="inline-block rounded border border-ink/25 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone opacity-0 transition-opacity hover:bg-mint hover:text-ink group-hover:opacity-100"
                    >
                      main
                    </button>
                  ) : null}
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
                    className="min-w-0 flex-1 rounded border border-mint bg-cream px-1.5 py-0.5 text-sm text-ink focus:outline-none"
                  />
                ) : (
                  <span
                    title={path + " (double-click to rename)"}
                    onDoubleClick={() => startRename(path)}
                    className="min-w-0 flex-1 truncate text-sm text-ink"
                  >
                    {path}
                  </span>
                )}

                <button
                  title="Delete file"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(path);
                  }}
                  className="shrink-0 rounded px-1 text-stone opacity-0 transition-opacity hover:bg-red-100 hover:text-red-600 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-ink/10 p-2">
        <div className="flex items-center gap-1.5">
          <input
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
          Double-click a name to rename. A .bib file triggers bibtex8
          automatically.
        </p>
      </div>
    </aside>
  );
}
