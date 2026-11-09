"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  IconFile,
  IconPlus,
  IconSpinner,
  IconTrash,
} from "@/components/icons";
import {
  ACTIVE_PROJECT_KEY,
  createProject,
  deleteProject,
  listProjects,
  loadPreview,
  type ProjectSummary,
} from "@/lib/opfs";
import {
  DEFAULT_FILES,
  DEFAULT_MAIN,
  nextProjectName,
} from "@/lib/defaults";

type Card = {
  project: ProjectSummary;
  /** Object URL of the project's square first-page PNG, or null (never compiled). */
  previewUrl: string | null;
};

/** "just now" / "5 min ago" / "3 days ago" — a light relative-time label. */
function relativeTime(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export default function Home() {
  const router = useRouter();
  // null = still reading OPFS; an array (possibly empty) = the project list.
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The project id currently being deleted (its card shows the busy trash).
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      try {
        const projects = await listProjects();
        const next: Card[] = [];
        for (const p of projects) {
          let url: string | null = null;
          const bytes = await loadPreview(p.id);
          if (bytes) {
            url = URL.createObjectURL(
              new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" }),
            );
            urls.push(url);
          }
          next.push({ project: p, previewUrl: url });
        }
        if (cancelled) return;
        setCards(next);
      } catch {
        if (!cancelled)
          setError("Couldn't read your projects from browser storage");
      }
    })();
    return () => {
      cancelled = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  // Point the editor at a project and open it. The editor's load effect reads
  // the active-project key on mount, so this reuses its whole open path.
  const openProject = (id: string) => {
    try {
      localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    } catch {
      // best effort — the click still navigates
    }
    router.push("/editor");
  };

  const newProject = async () => {
    if (creating || cards === null) return;
    setCreating(true);
    try {
      const name = nextProjectName(cards.map((c) => c.project.name));
      const id = await createProject(name, DEFAULT_FILES, {
        mainPath: DEFAULT_MAIN,
        openPaths: [DEFAULT_MAIN],
        activePath: DEFAULT_MAIN,
      });
      openProject(id);
    } catch {
      setError("Couldn't create the project — is browser storage available?");
    } finally {
      setCreating(false);
    }
  };

  // Delete a project and all its files. The card's preview URL is
  // revoked right away; the effect cleanup's double revoke is a no-op.
  const removeProject = async (id: string) => {
    const card = cards?.find((c) => c.project.id === id);
    if (deleting || !card) return;
    if (!window.confirm(`Delete “${card.project.name}” and all its files?`))
      return;
    setDeleting(id);
    try {
      await deleteProject(id);
      if (card.previewUrl) URL.revokeObjectURL(card.previewUrl);
      setCards((cs) => (cs ? cs.filter((c) => c.project.id !== id) : cs));
    } catch {
      setError("Couldn't delete that project");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="min-h-full bg-cream">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 pt-8">
        <div className="flex items-center gap-3">
          <span className="h-6 w-6 rounded-sm bg-mint" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            HomeHub
          </h1>
        </div>
        <button
          onClick={newProject}
          disabled={creating || cards === null}
          title="Create a new project and open it"
          className="flex items-center gap-1.5 rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconPlus className="h-4 w-4" />
          New project
        </button>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <p className="mb-6 text-sm text-stone">
          Your LaTeX projects — click one to open it in the editor.
        </p>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {cards === null && !error && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="overflow-hidden rounded-lg border border-ink/10 bg-white"
              >
                <div className="aspect-square animate-pulse bg-peach/30" />
                <div className="h-11" />
              </div>
            ))}
          </div>
        )}

        {cards !== null && cards.length === 0 && !error && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-stone/40 py-16 text-center">
            <IconFile className="h-10 w-10 text-stone/40" />
            <p className="text-sm text-stone">
              No projects yet — create one to get started.
            </p>
          </div>
        )}

        {cards !== null && cards.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-5">
            {cards.map(({ project, previewUrl }) => (
              // The delete button is a sibling of the card button, not a
              // child: a nested <button> is invalid HTML.
              <div key={project.id} className="group/card relative">
                <button
                  onClick={() => openProject(project.id)}
                  title={`Open ${project.name}`}
                  className="block w-full overflow-hidden rounded-lg border border-ink/10 bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-mint hover:shadow-md"
                >
                  <div className="relative aspect-square w-full overflow-hidden border-b border-ink/10 bg-white">
                    {previewUrl ? (
                      <div
                        className="absolute inset-0 bg-cover"
                        style={{ backgroundImage: `url(${previewUrl})` }}
                        aria-hidden
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center bg-cream">
                        <IconFile className="h-10 w-10 text-stone/30" />
                      </div>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <p
                      className="truncate text-sm font-medium text-ink"
                      title={project.name}
                    >
                      {project.name}
                    </p>
                    <p className="mt-0.5 text-xs text-stone">
                      {relativeTime(project.updatedAt)}
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => removeProject(project.id)}
                  disabled={deleting === project.id}
                  title={`Delete ${project.name}`}
                  className="absolute right-1.5 top-1.5 rounded bg-white/90 p-1.5 text-stone opacity-0 shadow-sm transition-opacity hover:bg-peach hover:text-ink disabled:cursor-wait disabled:opacity-50 group-hover/card:opacity-100"
                >
                  {deleting === project.id ? (
                    <IconSpinner className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <IconTrash className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
