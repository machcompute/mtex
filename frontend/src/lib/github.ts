/**
 * A PAT-based GitHub client. The personal access token lives in localStorage
 * and the browser talks to api.github.com directly (it sends CORS headers), so
 * there is no server route, no env var and no shared state — the whole flow is
 * serverless. Files are pulled file-by-file through the Git Trees API (a
 * recursive tree listing plus raw blobs) rather than a tarball, so junk can be
 * filtered *before* anything is downloaded and no tar decoding is needed.
 */
import { BINARY_EXT, RESERVED_NAMES, decodeText, type FileData } from "./opfs";

/** localStorage key for the GitHub personal access token. */
export const GITHUB_PAT_KEY = "homehub-github-pat-v1";

export function savePat(token: string): void {
  try {
    localStorage.setItem(GITHUB_PAT_KEY, token.trim());
  } catch {
    // best effort — the token still works in memory for this session
  }
}

export function loadPat(): string | null {
  try {
    return localStorage.getItem(GITHUB_PAT_KEY);
  } catch {
    return null;
  }
}

export function clearPat(): void {
  try {
    localStorage.removeItem(GITHUB_PAT_KEY);
  } catch {
    // best effort
  }
}

const API = "https://api.github.com";
const API_ACCEPT = "application/vnd.github+json";

function githubError(status: number): string {
  switch (status) {
    case 401:
      return "GitHub rejected the token — check it and try again";
    case 403:
      return "GitHub refused the request — the token is rate-limited, or it lacks the “repo” scope (fine-grained tokens can’t list your repos)";
    case 404:
      return "Not found on GitHub";
    default:
      return `GitHub error ${status}`;
  }
}

async function gh<T>(token: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: API_ACCEPT },
    });
  } catch {
    throw new Error("Could not reach GitHub — check your connection");
  }
  if (!res.ok) throw new Error(githubError(res.status));
  return (await res.json()) as T;
}

export type GhUser = { login: string; name?: string | null; avatar_url?: string };

export async function getMe(token: string): Promise<GhUser> {
  return gh<GhUser>(token, "/user");
}

export type GhRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  pushed_at: string;
};

export async function listRepos(token: string): Promise<GhRepo[]> {
  const repos = await gh<GhRepo[]>(
    token,
    "/user/repos?affiliation=owner,collaborator&per_page=100&sort=pushed",
  );
  return Array.isArray(repos) ? repos : [];
}

export type GhBranch = { name: string };

export async function listBranches(
  token: string,
  owner: string,
  repo: string,
): Promise<GhBranch[]> {
  const branches = await gh<GhBranch[]>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
  );
  return Array.isArray(branches) ? branches : [];
}

export type TreeEntry = { path: string; type: "blob" | "tree"; sha: string; size?: number };

/** Full recursive tree for a ref; throws when GitHub truncates it. */
export async function listTree(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<TreeEntry[]> {
  const data = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  if (data.truncated) {
    throw new Error("That repo is too large to pull — GitHub caps the file listing");
  }
  return data.tree ?? [];
}

/** Raw bytes of a blob. */
export async function fetchBlob(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetch(
      `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
        },
      },
    );
  } catch {
    throw new Error("Could not reach GitHub while downloading a file");
  }
  if (!res.ok) throw new Error(`GitHub error ${res.status} downloading a file`);
  return new Uint8Array(await res.arrayBuffer());
}

/** True when any path segment is a dotfile or a reserved Object name — the
 * same junk rule folder uploads use, applied before anything is fetched. */
export function isJunkPath(path: string): boolean {
  return path
    .split("/")
    .some((p) => p.startsWith(".") || RESERVED_NAMES.has(p.toLowerCase()));
}

/** Hard cap on files pulled from a single repo (the tree is listed up front,
 * so the limit is predictable). */
export const MAX_PULL_FILES = 1000;

export type PullResult = {
  files: Record<string, FileData>;
  /** Blobs skipped as junk (dotfiles / reserved names) — never downloaded. */
  skippedJunk: number;
  /** Blobs dropped because the repo exceeded MAX_PULL_FILES. */
  skippedCap: number;
  /** Total blob entries in the tree (before any filtering). */
  total: number;
};

const BLOB_BATCH = 8;

/**
 * Pull every file of `repo@ref` into a path -> FileData map. Junk is filtered
 * out of the tree listing first (it is never downloaded), the file count is
 * capped, then blobs are fetched in small parallel batches with progress
 * reporting.
 */
export async function fetchRepoFiles(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  onProgress?: (done: number, total: number) => void,
): Promise<PullResult> {
  const tree = await listTree(token, owner, repo, ref);
  const blobs = tree.filter((e) => e.type === "blob");
  let skippedJunk = 0;
  const keep: TreeEntry[] = [];
  for (const b of blobs) {
    if (isJunkPath(b.path)) {
      skippedJunk++;
      continue;
    }
    keep.push(b);
  }
  const toFetch = keep.slice(0, MAX_PULL_FILES);
  const skippedCap = Math.max(0, keep.length - toFetch.length);

  const files: Record<string, FileData> = {};
  let done = 0;
  for (let i = 0; i < toFetch.length; i += BLOB_BATCH) {
    const batch = toFetch.slice(i, i + BLOB_BATCH);
    await Promise.all(
      batch.map(async (b) => {
        const bytes = await fetchBlob(token, owner, repo, b.sha);
        const dot = b.path.lastIndexOf(".");
        const ext = dot >= 0 ? b.path.slice(dot + 1).toLowerCase() : "";
        files[b.path] = BINARY_EXT.has(ext) ? bytes : (decodeText(bytes) ?? bytes);
      }),
    );
    done += batch.length;
    onProgress?.(done, toFetch.length);
  }
  return { files, skippedJunk, skippedCap, total: blobs.length };
}
