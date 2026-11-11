// A stub of api.github.com for unit tests, mirroring the fixtures of the old
// browser suite (e2e/github.cjs): user "testuser", repo "latex-repo" with
// branches main/dev, blob shas, a tree holding a dotfile that must never be
// downloaded, and the Git Data endpoints a push goes through. Installed at the
// global `fetch` boundary; every request is recorded.
import { vi } from "vitest";

export const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 255, 254, 253, 128, 0, 1,
]);

export const MAIN_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Pulled from GitHub.",
  "\\end{document}",
].join("\n");
export const MAIN_TEX_DEV = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Pulled from the dev branch.",
  "\\end{document}",
].join("\n");
export const INNER_TEX = "Inner content.\n";
export const SECOND_TEX = "Second file on the dev branch.\n";
export const GITIGNORE = "*.aux\n*.log\n";

const enc = (s: string) => new TextEncoder().encode(s);

export const BLOBS: Record<string, Uint8Array> = {
  "sha-main": enc(MAIN_TEX),
  "sha-main-dev": enc(MAIN_TEX_DEV),
  "sha-inner": enc(INNER_TEX),
  "sha-second": enc(SECOND_TEX),
  "sha-png": PNG,
  "sha-gitignore": enc(GITIGNORE),
};

export const TREE_MAIN = {
  sha: "tree-main",
  tree: [
    { path: ".gitignore", mode: "100644", type: "blob", sha: "sha-gitignore", size: GITIGNORE.length },
    { path: "figs", mode: "040000", type: "tree", sha: "tree-figs" },
    { path: "figs/logo.png", mode: "100644", type: "blob", sha: "sha-png", size: PNG.length },
    { path: "main.tex", mode: "100644", type: "blob", sha: "sha-main", size: MAIN_TEX.length },
    { path: "sub", mode: "040000", type: "tree", sha: "tree-sub" },
    { path: "sub/inner.tex", mode: "100644", type: "blob", sha: "sha-inner", size: INNER_TEX.length },
  ],
  truncated: false,
};

// dev: inner.tex is gone, second.tex is new — proves a re-pull replaces.
export const TREE_DEV = {
  sha: "tree-dev",
  tree: [
    { path: "figs", mode: "040000", type: "tree", sha: "tree-figs" },
    { path: "figs/logo.png", mode: "100644", type: "blob", sha: "sha-png", size: PNG.length },
    { path: "main.tex", mode: "100644", type: "blob", sha: "sha-main-dev", size: MAIN_TEX_DEV.length },
    { path: "second.tex", mode: "100644", type: "blob", sha: "sha-second", size: SECOND_TEX.length },
  ],
  truncated: false,
};

export type Recorded = {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

export type GithubStub = {
  requests: Recorded[];
  blobHits: Record<string, number>;
  codeloadHits: number;
  pushBlobs: { sha: string; bytes: Uint8Array }[];
  pushTrees: { sha: string; entries: { path: string; mode: string; type: string; sha: string }[] }[];
  pushCommits: Record<string, unknown>[];
  pushRefs: { ref: string; sha: string; force: boolean }[];
  /** Override the GET /user/emails answer (status 403 simulates a scope-less token). */
  emails: { email: string; primary?: boolean; verified?: boolean }[] | "forbidden";
  /** Make every request fail at the network layer. */
  offline: boolean;
  /** Per-path status overrides, e.g. {"/user": 401}. */
  status: Record<string, number>;
  /** Replace the main tree (e.g. to test truncation). */
  treeMain: unknown;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

/** Install the stub as the global fetch and return its recording state. */
export function installGithubStub(): GithubStub {
  const stub: GithubStub = {
    requests: [],
    blobHits: {},
    codeloadHits: 0,
    pushBlobs: [],
    pushTrees: [],
    pushCommits: [],
    pushRefs: [],
    emails: [{ email: "test@example.com", primary: true, verified: true }],
    offline: false,
    status: {},
    treeMain: TREE_MAIN,
  };
  const repo = "/repos/testuser/latex-repo";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url);
      const path = u.pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (u.hostname === "codeload.github.com") {
        stub.codeloadHits++;
        throw new Error("codeload (tarball) traffic is forbidden");
      }
      if (u.hostname !== "api.github.com") {
        throw new Error(`unexpected non-GitHub request: ${url}`);
      }
      stub.requests.push({ method, url, path, headers: headersOf(init), body });
      if (stub.offline) throw new TypeError("Failed to fetch");
      const forced = stub.status[path];
      if (forced) return json({ message: "forced" }, forced);

      if (method === "GET") {
        if (path === "/user") return json({ login: "testuser", name: "Test User", avatar_url: "" });
        if (path === "/user/emails") {
          return stub.emails === "forbidden" ? json({}, 403) : json(stub.emails);
        }
        if (path === "/user/repos") {
          return json([
            {
              full_name: "testuser/latex-repo",
              name: "latex-repo",
              owner: { login: "testuser" },
              default_branch: "main",
              private: false,
              pushed_at: "2026-11-03T00:00:00Z",
            },
          ]);
        }
        if (path === `${repo}/branches`) return json([{ name: "main" }, { name: "dev" }]);
        const head = /^\/repos\/testuser\/latex-repo\/branches\/(main|dev)$/.exec(path);
        if (head) {
          return json({ name: head[1], commit: { sha: `head-${head[1]}` } });
        }
        const tree = /^\/repos\/testuser\/latex-repo\/git\/trees\/(.+)$/.exec(path);
        if (tree) return json(tree[1] === "dev" ? TREE_DEV : stub.treeMain);
        const blob = /^\/repos\/testuser\/latex-repo\/git\/blobs\/(.+)$/.exec(path);
        if (blob) {
          const sha = blob[1];
          stub.blobHits[sha] = (stub.blobHits[sha] ?? 0) + 1;
          const bytes = BLOBS[sha];
          if (!bytes) return json({ message: "Not Found" }, 404);
          return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
        }
      }
      if (method === "POST") {
        const b = body as Record<string, unknown>;
        if (path === `${repo}/git/blobs`) {
          const sha = `blob-push-${stub.pushBlobs.length + 1}`;
          stub.pushBlobs.push({ sha, bytes: Uint8Array.from(Buffer.from(String(b.content ?? ""), "base64")) });
          return json({ sha }, 201);
        }
        if (path === `${repo}/git/trees`) {
          const sha = `tree-push-${stub.pushTrees.length + 1}`;
          stub.pushTrees.push({ sha, entries: (b.tree ?? []) as never });
          return json({ sha }, 201);
        }
        if (path === `${repo}/git/commits`) {
          stub.pushCommits.push(b);
          return json({ sha: "new-commit-1" }, 201);
        }
      }
      if (method === "PATCH" && path.startsWith(`${repo}/git/refs/`)) {
        const b = body as { sha: string; force: boolean };
        stub.pushRefs.push({ ref: `refs/${path.split("/git/refs/")[1]}`, ...b });
        return json({ ref: `refs/${path.split("/git/refs/")[1]}`, object: { sha: b.sha } });
      }
      throw new Error(`[stub] UNMATCHED ${method} ${url}`);
    }),
  );
  return stub;
}
