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
    case 409:
      return "The branch moved while pushing — reopen GitHub and push again";
    case 413:
      return "A file is over GitHub's 100 MB limit";
    default:
      return `GitHub error ${status}`;
  }
}

async function gh<T>(
  token: string,
  path: string,
  init?: { method: "POST" | "PATCH"; body: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: API_ACCEPT,
        ...(init ? { "Content-Type": "application/json" } : {}),
      },
      body: init ? JSON.stringify(init.body) : undefined,
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

// --- push (Git Data API) --------------------------------------------------
//
// The pull direction reads the Trees API; the push direction builds a new
// commit from the project's files: one blob per file, the paths reassembled
// into nested trees (deepest first), a commit on top of the branch's current
// HEAD, and the branch ref moved forward. History is kept — the new commit
// parents onto the latest one.

export type GhIdentity = { name: string; email: string };

/**
 * Who the commit is authored by: the signed-in user's display name and
 * (public) email. A repo-scoped token only reveals public emails, so the
 * fallback is the account's noreply address — the commit still lands under
 * the user's name.
 */
export async function getIdentity(token: string): Promise<GhIdentity> {
  const me = await getMe(token);
  let email: string | null = null;
  try {
    const emails = await gh<{ email: string; primary?: boolean; verified?: boolean }[]>(
      token,
      "/user/emails?per_page=100",
    );
    if (Array.isArray(emails)) {
      email =
        emails.find((e) => e.primary && e.verified)?.email ??
        emails.find((e) => e.primary)?.email ??
        emails[0]?.email ??
        null;
    }
  } catch {
    // no readable public email — the noreply fallback below still works
  }
  return {
    name: me.name || me.login,
    email: email ?? `${me.login}@users.noreply.github.com`,
  };
}

/** "machlatex <local date>:<time>", e.g. "machlatex 2026-11-03:19:40:46". */
export function pushCommitMessage(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `machlatex ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `:${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  );
}

/**
 * Bytes to base64 in chunks — one fromCharCode spread of a large file would
 * overflow the stack.
 */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function getBranchHead(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const data = await gh<{ commit: { sha: string } }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
  );
  return data.commit.sha;
}

async function createBlob(
  token: string,
  owner: string,
  repo: string,
  bytes: Uint8Array,
): Promise<string> {
  const data = await gh<{ sha: string }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
    { method: "POST", body: { content: toBase64(bytes), encoding: "base64" } },
  );
  return data.sha;
}

type TreeEntryIn = { path: string; mode: string; type: "blob" | "tree"; sha: string };

async function createTree(
  token: string,
  owner: string,
  repo: string,
  entries: TreeEntryIn[],
): Promise<string> {
  const data = await gh<{ sha: string }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
    { method: "POST", body: { tree: entries } },
  );
  return data.sha;
}

async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  tree: string,
  parents: string[],
  identity: GhIdentity,
): Promise<string> {
  const date = new Date().toISOString();
  const data = await gh<{ sha: string }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree,
        parents,
        author: { name: identity.name, email: identity.email, date },
        committer: { name: identity.name, email: identity.email, date },
      },
    },
  );
  return data.sha;
}

async function updateRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<void> {
  await gh(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "PATCH", body: { force: false, sha } },
  );
}

export type PushResult = { sha: string; files: number };

/**
 * Push a path -> FileData map as ONE new commit on top of `branch`'s current
 * HEAD. Files absent from the map are deleted from the branch. GitHub's tree
 * API takes at most 100 entries per call, so a folder holding more than that
 * is refused up front.
 */
export async function pushFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: Record<string, FileData>,
  message: string,
  identity: GhIdentity,
  onProgress?: (done: number, total: number) => void,
): Promise<PushResult> {
  const paths = Object.keys(files);

  // dir -> final tree entry count. "" is the root; every directory that
  // appears anywhere in a path ends up in a tree (git tracks no empty
  // folders). A subdirectory counts as one entry in EACH of its ancestors,
  // up to and including the root.
  const dirCounts = new Map<string, number>();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const dir = i >= 0 ? p.slice(0, i) : "";
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    let anc = dir;
    while (anc !== "") {
      const j = anc.lastIndexOf("/");
      anc = j >= 0 ? anc.slice(0, j) : "";
      dirCounts.set(anc, (dirCounts.get(anc) ?? 0) + 1);
    }
  }
  for (const [dir, count] of dirCounts) {
    if (count > 100) {
      throw new Error(
        `Folder “${dir || "/"}” holds more than 100 entries — GitHub's tree API can't push it`,
      );
    }
  }

  const head = await getBranchHead(token, owner, repo, branch);

  // 1. Blobs, batched like the pull path.
  const blobSha = new Map<string, string>();
  let done = 0;
  const total = paths.length + dirCounts.size;
  for (let i = 0; i < paths.length; i += BLOB_BATCH) {
    const batch = paths.slice(i, i + BLOB_BATCH);
    await Promise.all(
      batch.map(async (p) => {
        const data = files[p];
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        blobSha.set(p, await createBlob(token, owner, repo, bytes));
      }),
    );
    done += batch.length;
    onProgress?.(done, total);
  }

  // 2a. dir -> tree entries, now that every blob sha is known.
  const dirEntries = new Map<string, TreeEntryIn[]>();
  const dirOf = (dir: string) => {
    if (!dirEntries.has(dir)) dirEntries.set(dir, []);
    return dirEntries.get(dir)!;
  };
  dirOf("");
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const dir = i >= 0 ? p.slice(0, i) : "";
    dirOf(dir).push({
      path: p.slice(i + 1),
      mode: "100644",
      type: "blob",
      sha: blobSha.get(p)!,
    });
  }

  // 2b. Trees, deepest first (a parent's entry is filled in before the parent
  // is submitted). dirCounts, not dirEntries, names the directories: a folder
  // holding only subfolders gets its entry while its children are processed.
  const treeSha = new Map<string, string>();
  // Depth: the root is 0 — "".split("/").length is 1, which would tie it
  // with top-level folders and let insertion order win.
  const depth = (d: string) => (d === "" ? 0 : d.split("/").length);
  const dirs = [...dirCounts.keys()].sort((a, b) => depth(b) - depth(a));
  for (const dir of dirs) {
    const sha = await createTree(token, owner, repo, dirOf(dir));
    treeSha.set(dir, sha);
    if (dir !== "") {
      const i = dir.lastIndexOf("/");
      const parent = i >= 0 ? dir.slice(0, i) : "";
      dirOf(parent).push({ path: dir.slice(i + 1), mode: "040000", type: "tree", sha });
    }
    done++;
    onProgress?.(done, total);
  }

  // 3. Commit + move the branch ref (non-forced: a branch that moved since
  // step 1 is rejected by GitHub instead of clobbered).
  const sha = await createCommit(
    token,
    owner,
    repo,
    message,
    treeSha.get("")!,
    [head],
    identity,
  );
  await updateRef(token, owner, repo, branch, sha);
  return { sha, files: paths.length };
}
