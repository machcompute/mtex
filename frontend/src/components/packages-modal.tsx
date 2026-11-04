"use client";

import { useEffect, useState } from "react";
import {
  IconCheck,
  IconClose,
  IconSpinner,
  IconTrash,
} from "@/components/icons";

type PackageInfo = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  size: number;
  provides: string[];
  files: number;
  installedAt: string;
};

type SearchResult = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  size: number;
  installed: boolean;
};

type Props = {
  /** Called after a successful install or remove, with a short
   * description of what happened ("Installed "caption""). The page
   * restarts the engine (its file lookup caches the old state) and shows
   * the result as a notice. */
  onChanged: (msg: string) => void;
  onClose: () => void;
};

/**
 * Pull and remove LaTeX packages for the in-browser engine. The engine
 * (TeX Live 2026 WASM) ships its base tree; anything a document
 * \usepackage's beyond that is installed HERE into the server's CTAN
 * package store, where it stays and is served to the engine on demand at
 * compile time.
 */
export default function PackagesModal({ onChanged, onClose }: Props) {
  const [installed, setInstalled] = useState<PackageInfo[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // True while a search is in flight; the previous results stay visible
  // underneath the spinner (an empty list would look idle — and the first
  // search may download the ~20 MB package database, which takes a while).
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // package name mid change
  const [error, setError] = useState<string | null>(null);

  // Load the installed list on open. Inline async (like the page's load
  // effect): every state update happens after the first await, never
  // synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/packages");
        const data = (await res.json().catch(() => ({}))) as {
          packages?: PackageInfo[];
          error?: string;
        };
        if (!res.ok)
          throw new Error(data.error ?? `could not list packages (${res.status})`);
        if (!cancelled) setInstalled(data.packages ?? []);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clearing the input is an edit, so clear the results in the handler
  // (not in an effect): the debounced search below only handles non-empty
  // queries and sets state from its timeout callback.
  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (value.trim() === "") {
      setResults(null);
      setSearchError(null);
      setSearching(false);
    } else {
      setSearching(true);
    }
  };

  // Debounced CTAN search.
  useEffect(() => {
    if (query.trim() === "") return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/packages/search?query=${encodeURIComponent(query.trim())}`,
          );
          const data = (await res.json().catch(() => ({}))) as {
            results?: SearchResult[];
            error?: string;
          };
          if (!res.ok)
            throw new Error(data.error ?? `search failed (${res.status})`);
          if (!cancelled) {
            setResults(data.results ?? []);
            setSearchError(null);
          }
        } catch (e) {
          if (!cancelled) {
            setSearchError(errMsg(e));
            setResults(null);
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  // Called from the install/remove handlers (event context, so setState
  // here is fine): refresh the installed list, then tell the page.
  async function afterChange(msg: string) {
    try {
      const res = await fetch("/api/packages");
      const data = (await res.json().catch(() => ({}))) as {
        packages?: PackageInfo[];
      };
      if (res.ok) setInstalled(data.packages ?? []);
    } catch {
      // best effort — the change itself succeeded
    }
    onChanged(msg);
  }

  async function install(name: string) {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch("/api/packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        package?: PackageInfo;
        installedDependencies?: string[];
        unresolved?: string[];
        error?: string;
      };
      if (!res.ok)
        throw new Error(data.error ?? `install failed (${res.status})`);
      // The fetched results predate the install; flip the flags in place so
      // the cards show "installed" instead of stale Install buttons.
      setResults((prev) =>
        prev
          ? prev.map((r) =>
              r.name === name ||
              (data.installedDependencies ?? []).includes(r.name)
                ? { ...r, installed: true }
                : r,
            )
          : prev,
      );
      const deps = data.installedDependencies ?? [];
      const unresolved = data.unresolved ?? [];
      let msg = `Installed “${data.package?.name ?? name}”`;
      if (deps.length > 0) msg += ` (pulled in: ${deps.join(", ")})`;
      if (unresolved.length > 0)
        msg += ` — could not auto-install: ${unresolved.join(", ")}`;
      await afterChange(msg);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch(`/api/packages/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `remove failed (${res.status})`);
      // Mirror of the install fix: a removed package that is visible in
      // the search results gets its Install button back.
      setResults((prev) =>
        prev
          ? prev.map((r) => (r.name === name ? { ...r, installed: false } : r))
          : prev,
      );
      await afterChange(`Removed “${name}”`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-modal="packages"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-md border border-ink/10 bg-cream p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">LaTeX packages</h2>
          <button
            onClick={onClose}
            disabled={busy !== null}
            title="Close"
            className="rounded p-1 text-stone hover:bg-peach/60 hover:text-ink disabled:opacity-40"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="mb-2 text-xs text-stone">
          The engine ships TeX Live 2026’s base tree. Search CTAN to pull
          anything else — installs are kept on the server and served to the
          engine on demand at compile time.
        </p>

        {error && (
          <p data-pkg-error className="mb-2 rounded bg-peach/60 px-2 py-1 text-xs text-ink">
            {error}
          </p>
        )}

        <input
          data-pkg-search
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search CTAN packages… (e.g. tikz, biblatex)"
          autoComplete="off"
          autoFocus
          className="w-full rounded border border-stone/40 bg-white px-2 py-1.5 text-sm text-ink focus:border-mint focus:outline-none"
        />

        {searching && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-stone">
            <IconSpinner className="h-3 w-3" />
            Searching… (the first search downloads the package database)
          </p>
        )}
        {searchError && (
          <p className="mt-2 text-xs text-ink">{searchError}</p>
        )}

        {results && results.length > 0 && (
          <div
            data-pkg-results
            className="mt-2 max-h-48 shrink space-y-0.5 overflow-auto rounded border border-ink/10 bg-white p-1"
          >
            {results.map((r) => (
              <div
                key={r.name}
                data-pkg-row={r.name}
                className="flex items-center gap-2 rounded px-1.5 py-1"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-medium text-ink">{r.name}</span>
                  <span className="ml-1.5 text-[10px] text-stone">
                    {fmtBytes(r.size)}
                  </span>
                  <p className="truncate text-[11px] text-stone">{r.shortdesc}</p>
                </div>
                {r.installed ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-stone">
                    <IconCheck className="h-3 w-3 text-mint" />
                    installed
                  </span>
                ) : (
                  <button
                    data-pkg-install={r.name}
                    onClick={() => void install(r.name)}
                    disabled={busy !== null}
                    className="shrink-0 rounded bg-mint px-2 py-0.5 text-xs font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === r.name ? (
                      <span className="flex items-center gap-1">
                        <IconSpinner className="h-3 w-3" />
                        …
                      </span>
                    ) : (
                      "Install"
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {results && results.length === 0 && (
          <p className="mt-2 text-xs text-stone">No packages match.</p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs font-medium text-ink">
            Installed ({installed.length})
          </span>
          <div className="h-px flex-1 bg-ink/10" />
        </div>

        <div
          data-pkg-installed
          className="mt-1.5 max-h-48 shrink space-y-0.5 overflow-auto rounded border border-ink/10 bg-white p-1"
        >
          {installed.length === 0 ? (
            <p className="px-1.5 py-1 text-[11px] text-stone">
              Nothing installed yet — the base tree covers most documents.
            </p>
          ) : (
            installed.map((p) => (
              <div
                key={p.name}
                data-pkg-row={p.name}
                className="flex items-center gap-2 rounded px-1.5 py-1"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-medium text-ink">{p.name}</span>
                  <span className="ml-1.5 text-[10px] text-stone">
                    {fmtBytes(p.size)} · {p.files} files
                  </span>
                  <p className="truncate text-[11px] text-stone">{p.shortdesc}</p>
                </div>
                <button
                  data-pkg-remove={p.name}
                  onClick={() => void remove(p.name)}
                  disabled={busy !== null}
                  title={`Remove ${p.name}`}
                  className="shrink-0 rounded p-1 text-stone hover:bg-peach/60 hover:text-ink disabled:opacity-40"
                >
                  {busy === p.name ? (
                    <IconSpinner className="h-3.5 w-3.5" />
                  ) : (
                    <IconTrash className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}
