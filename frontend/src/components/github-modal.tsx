"use client";

import { useEffect, useState } from "react";
import { IconClose, IconGitHub, IconSpinner } from "@/components/icons";
import {
  clearPat,
  fetchRepoFiles,
  getIdentity,
  getMe,
  listBranches,
  listRepos,
  loadPat,
  pushCommitMessage,
  pushFiles,
  savePat,
  type GhBranch,
  type GhRepo,
  type GhUser,
} from "@/lib/github";
import type { FileData, ProjectSource, ProjectSummary } from "@/lib/opfs";

export type PullRequest = {
  owner: string;
  repo: string;
  branch: string;
  files: Record<string, FileData>;
  skippedJunk: number;
  skippedCap: number;
};

export type PushRequest = {
  owner: string;
  repo: string;
  branch: string;
  /** The new commit the branch ref now points at. */
  sha: string;
  files: number;
  message: string;
};

type Props = {
  /** All OPFS projects — used to tell a fresh pull from a re-pull of a repo
   * that was already imported. */
  projects: ProjectSummary[];
  /** The active project's files — the Push button uploads exactly these. */
  files: Record<string, FileData>;
  /** Where the active project came from (a GitHub repo, if any) — that
   * repo/branch is preselected on sign-in so a push is one click. */
  projectSource: ProjectSource | null;
  onPulled: (req: PullRequest) => Promise<void>;
  onPushed: (req: PushRequest) => Promise<void>;
  onClose: () => void;
};

/**
 * A serverless GitHub bridge: the user pastes a personal access token (kept in
 * localStorage), picks a repo and branch, and pulls the files straight from
 * api.github.com into the browser — or pushes the active project's files back
 * as a new commit. No server is involved.
 */
export default function GitHubModal({
  projects,
  files,
  projectSource,
  onPulled,
  onPushed,
  onClose,
}: Props) {
  // A saved token seeds the signed-in step on open; the PAT step otherwise.
  const [token, setToken] = useState<string | null>(() => loadPat());
  const [patInput, setPatInput] = useState("");
  const [user, setUser] = useState<GhUser | null>(null);
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [branches, setBranches] = useState<GhBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  // A saved token starts an immediate sign-in, so the UI begins busy.
  // signIn only ever CLEARS this (it never sets it), which keeps the mount
  // effect free of synchronous setState.
  const [authing, setAuthing] = useState(token !== null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRepoObj = repos.find((r) => r.full_name === selectedRepo) ?? null;
  const existing = selectedRepoObj
    ? projects.find(
        (p) =>
          p.source?.kind === "github" &&
          p.source.owner === selectedRepoObj.owner.login &&
          p.source.repo === selectedRepoObj.name,
      )
    : undefined;

  // Sign-in split in two so the mount effect can drive it without calling a
  // state-setting function before its first await: fetchAuth is a pure
  // fetch, applyAuth only ever runs after it has settled.
  async function fetchAuth(t: string) {
    const me = await getMe(t);
    const repos = await listRepos(t);
    return { me, repos };
  }

  function applyAuth(t: string, res: { me: GhUser; repos: GhRepo[] }) {
    setUser(res.me);
    setRepos(res.repos);
    if (res.repos.length === 0) return;
    // The active project's GitHub source (if any) wins the preselection —
    // that repo/branch is where a push goes back to.
    const src = projectSource;
    const match =
      src?.kind === "github"
        ? res.repos.find((r) => r.owner.login === src.owner && r.name === src.repo)
        : undefined;
    const repo = match ?? res.repos[0];
    setSelectedRepo(repo.full_name);
    void loadBranches(t, repo, match && src ? src.branch : undefined);
  }

  async function signIn(t: string) {
    try {
      applyAuth(t, await fetchAuth(t));
    } catch (e) {
      setUser(null);
      setRepos([]);
      setError(errMsg(e));
    } finally {
      setAuthing(false);
    }
  }

  async function loadBranches(t: string, repo: GhRepo, preferred?: string) {
    setLoadingBranches(true);
    setError(null);
    try {
      const br = await listBranches(t, repo.owner.login, repo.name);
      setBranches(br);
      const preferredBranch = preferred
        ? br.find((b) => b.name === preferred)?.name
        : undefined;
      setSelectedBranch(
        preferredBranch ??
          br.find((b) => b.name === repo.default_branch)?.name ??
          br[0]?.name ??
          null,
      );
    } catch (e) {
      setBranches([]);
      setSelectedBranch(null);
      setError(errMsg(e));
    } finally {
      setLoadingBranches(false);
    }
  }

  // If a token was saved, sign in on open; otherwise the PAT step shows.
  // Inline (like the page's load effect): every state update happens after
  // the first await, never synchronously in the effect body.
  useEffect(() => {
    if (!token) return;
    const t = token;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchAuth(t);
        if (!cancelled) applyAuth(t, res);
      } catch (e) {
        if (!cancelled) {
          setUser(null);
          setRepos([]);
          setError(errMsg(e));
        }
      } finally {
        if (!cancelled) setAuthing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSavePat = () => {
    const t = patInput.trim();
    if (!t) return;
    savePat(t);
    setToken(t);
    setPatInput("");
    setAuthing(true);
    setError(null);
    void signIn(t);
  };

  const handleRepoChange = (fullName: string) => {
    const t = token;
    const repo = repos.find((r) => r.full_name === fullName);
    if (!t || !repo) return;
    setSelectedRepo(fullName);
    setBranches([]);
    setSelectedBranch(null);
    void loadBranches(t, repo);
  };

  const handlePull = () => {
    const t = token;
    const repo = selectedRepoObj;
    if (!t || !repo) return;
    const owner = repo.owner.login;
    const name = repo.name;
    const branch = selectedBranch ?? repo.default_branch;
    setPulling(true);
    setError(null);
    setProgress({ done: 0, total: 0 });
    void (async () => {
      try {
        const res = await fetchRepoFiles(t, owner, name, branch, (done, total) =>
          setProgress({ done, total }),
        );
        await onPulled({
          owner,
          repo: name,
          branch,
          files: res.files,
          skippedJunk: res.skippedJunk,
          skippedCap: res.skippedCap,
        });
        onClose();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setPulling(false);
        setProgress(null);
      }
    })();
  };

  // Upload the active project's files as ONE new commit on top of the
  // selected branch's current HEAD (the modal does the network work; the
  // page records where the project now lives).
  const handlePush = () => {
    const t = token;
    const repo = selectedRepoObj;
    const branch = selectedBranch ?? repo?.default_branch;
    if (!t || !repo || !branch || Object.keys(files).length === 0) return;
    const owner = repo.owner.login;
    const name = repo.name;
    const message = pushCommitMessage();
    setPushing(true);
    setError(null);
    setProgress({ done: 0, total: 0 });
    void (async () => {
      try {
        const identity = await getIdentity(t);
        const res = await pushFiles(
          t,
          owner,
          name,
          branch,
          files,
          message,
          identity,
          (done, total) => setProgress({ done, total }),
        );
        await onPushed({
          owner,
          repo: name,
          branch,
          sha: res.sha,
          files: res.files,
          message,
        });
        onClose();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setPushing(false);
        setProgress(null);
      }
    })();
  };

  const handleDisconnect = () => {
    clearPat();
    setToken(null);
    setUser(null);
    setRepos([]);
    setSelectedRepo(null);
    setBranches([]);
    setSelectedBranch(null);
    setPatInput("");
    setError(null);
  };

  const busy = authing || pulling || pushing || loadingBranches;

  return (
    <div
      data-modal="github"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-md border border-ink/10 bg-cream p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <IconGitHub className="h-4 w-4" />
            GitHub
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            title="Close"
            className="rounded p-1 text-stone hover:bg-peach/60 hover:text-ink disabled:opacity-40"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>

        {error && (
          <p data-gh="error" className="mb-2 rounded bg-peach/60 px-2 py-1 text-xs text-ink">
            {error}
          </p>
        )}

        {!user ? (
          // --- PAT step ------------------------------------------------------
          <div className="space-y-2">
            <p className="text-xs text-stone">
              Paste a personal access token. Use a <em>classic</em> token with the{" "}
              <code className="rounded bg-white px-1 text-ink">repo</code> scope. It is
              stored only in this browser and never sent anywhere but GitHub.
            </p>
            <input
              data-gh="pat"
              type="password"
              value={patInput}
              onChange={(e) => setPatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSavePat();
              }}
              placeholder="ghp_…"
              autoComplete="off"
              className="w-full rounded border border-stone/40 bg-white px-2 py-1.5 text-sm text-ink focus:border-mint focus:outline-none"
            />
            <button
              data-gh="save"
              onClick={handleSavePat}
              disabled={authing || !patInput.trim()}
              className="flex w-full items-center justify-center gap-1.5 rounded bg-mint px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
            >
              {authing ? (
                <>
                  <IconSpinner className="h-3.5 w-3.5" />
                  Signing in…
                </>
              ) : (
                "Save & sign in"
              )}
            </button>
          </div>
        ) : (
          // --- browse step ---------------------------------------------------
          <div className="space-y-2.5">
            <p className="flex items-center gap-1.5 text-xs text-stone">
              Signed in as
              <span data-gh="login" className="font-medium text-ink">
                {user.login}
              </span>
            </p>

            <label className="block">
              <span className="mb-0.5 block text-xs font-medium text-ink">Repository</span>
              <select
                data-gh="repo"
                value={selectedRepo ?? ""}
                onChange={(e) => handleRepoChange(e.target.value)}
                disabled={busy}
                className="w-full rounded border border-stone/40 bg-white px-2 py-1 text-xs text-ink focus:border-mint focus:outline-none"
              >
                {repos.length === 0 && <option value="">No repositories</option>}
                {repos.map((r) => (
                  <option key={r.full_name} value={r.full_name}>
                    {r.full_name}
                    {r.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-0.5 block text-xs font-medium text-ink">Branch</span>
              <select
                data-gh="branch"
                value={selectedBranch ?? ""}
                onChange={(e) => setSelectedBranch(e.target.value)}
                disabled={busy || loadingBranches}
                className="w-full rounded border border-stone/40 bg-white px-2 py-1 text-xs text-ink focus:border-mint focus:outline-none"
              >
                {loadingBranches ? (
                  <option value="">Loading…</option>
                ) : (
                  branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))
                )}
              </select>
            </label>

            {(pulling || pushing) && progress && (
              <p data-gh="progress" className="flex items-center gap-1.5 text-xs text-stone">
                <IconSpinner className="h-3 w-3" />
                {pushing ? "Pushing…" : "Pulling…"} {progress.done}/{progress.total || "…"}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                data-gh="pull"
                onClick={handlePull}
                disabled={busy || !selectedRepo || !selectedBranch}
                className="flex flex-1 items-center justify-center gap-1.5 rounded bg-mint px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pulling ? (
                  <>
                    <IconSpinner className="h-3.5 w-3.5" />
                    Pulling…
                  </>
                ) : (
                  existing ? "Re-pull" : "Pull into a project"
                )}
              </button>
              <button
                data-gh="push"
                onClick={handlePush}
                disabled={
                  busy || !selectedRepo || !selectedBranch || Object.keys(files).length === 0
                }
                title="Upload this project's files to the selected branch as a new commit"
                className="flex flex-1 items-center justify-center gap-1.5 rounded bg-mint px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-ink hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pushing ? (
                  <>
                    <IconSpinner className="h-3.5 w-3.5" />
                    Pushing…
                  </>
                ) : (
                  "Push"
                )}
              </button>
            </div>
            <div className="flex justify-end pt-1">
              <button
                data-gh="disconnect"
                onClick={handleDisconnect}
                disabled={busy}
                className="rounded border border-stone/40 px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}
