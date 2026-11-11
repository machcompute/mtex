// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_PAT_KEY,
  MAX_PULL_FILES,
  clearPat,
  fetchRepoFiles,
  getIdentity,
  getMe,
  isJunkPath,
  listBranches,
  listRepos,
  listTree,
  loadPat,
  pushCommitMessage,
  pushFiles,
  savePat,
} from "@/lib/github";
import {
  GITIGNORE,
  INNER_TEX,
  MAIN_TEX,
  PNG,
  installGithubStub,
  type GithubStub,
} from "../support/github-fixtures";

let stub: GithubStub;
beforeEach(() => {
  stub = installGithubStub();
});

describe("token storage (e2e github: token persisted to localStorage)", () => {
  it("saves a trimmed token, loads it back, clears it", () => {
    expect(loadPat()).toBeNull();
    savePat("  ghp_abc  ");
    expect(localStorage.getItem(GITHUB_PAT_KEY)).toBe("ghp_abc");
    expect(loadPat()).toBe("ghp_abc");
    clearPat();
    expect(loadPat()).toBeNull();
  });

  it("is best effort when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => savePat("x")).not.toThrow();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadPat()).toBeNull();
  });
});

describe("read endpoints", () => {
  it("sends the Bearer token and the JSON accept header (API requests carry the token)", async () => {
    const me = await getMe("tok123");
    expect(me.login).toBe("testuser");
    expect(stub.requests[0].headers.authorization).toBe("Bearer tok123");
    expect(stub.requests[0].headers.accept).toBe("application/vnd.github+json");
  });

  it("lists the repo with its default branch, then main/dev branches", async () => {
    const repos = await listRepos("t");
    expect(repos.map((r) => r.full_name)).toEqual(["testuser/latex-repo"]);
    expect(repos[0].default_branch).toBe("main");
    const branches = await listBranches("t", "testuser", "latex-repo");
    expect(branches.map((b) => b.name)).toEqual(["main", "dev"]);
  });

  it("maps HTTP failures to readable messages", async () => {
    stub.status["/user"] = 401;
    await expect(getMe("t")).rejects.toThrow(/rejected the token/);
    stub.status["/user"] = 403;
    await expect(getMe("t")).rejects.toThrow(/rate-limited|“repo” scope/);
    stub.status["/user"] = 404;
    await expect(getMe("t")).rejects.toThrow("Not found on GitHub");
    stub.status["/user"] = 500;
    await expect(getMe("t")).rejects.toThrow("GitHub error 500");
  });

  it("reports an unreachable GitHub", async () => {
    stub.offline = true;
    await expect(getMe("t")).rejects.toThrow(/Could not reach GitHub/);
  });

  it("refuses a truncated tree", async () => {
    stub.treeMain = { tree: [], truncated: true };
    await expect(listTree("t", "testuser", "latex-repo", "main")).rejects.toThrow(/too large/);
  });
});

describe("isJunkPath (same rule as folder uploads)", () => {
  it.each([
    [".gitignore", true],
    [".git/config", true],
    ["a/.DS_Store", true],
    ["constructor", true],
    ["a/__proto__/b", true],
    ["main.tex", false],
    ["figs/logo.png", false],
    ["v1..2.tex", false],
  ])("%s -> %s", (p, junk) => {
    expect(isJunkPath(p)).toBe(junk);
  });
});

describe("fetchRepoFiles (e2e github: pull)", () => {
  it("pulls kept files, skips the dotfile BEFORE downloading, each blob once", async () => {
    const progress: [number, number][] = [];
    const res = await fetchRepoFiles("t", "testuser", "latex-repo", "main", (d, t) =>
      progress.push([d, t]),
    );
    expect(Object.keys(res.files).sort()).toEqual(["figs/logo.png", "main.tex", "sub/inner.tex"]);
    expect(res.skippedJunk).toBe(1);
    expect(res.skippedCap).toBe(0);
    expect(res.total).toBe(4);
    expect(res.files["main.tex"]).toBe(MAIN_TEX);
    expect(res.files["sub/inner.tex"]).toBe(INNER_TEX);
    // binary kept byte-for-byte
    expect(Array.from(res.files["figs/logo.png"] as Uint8Array)).toEqual(Array.from(PNG));
    // each kept blob fetched exactly once; the junk blob never requested
    expect(stub.blobHits).toEqual({ "sha-main": 1, "sha-png": 1, "sha-inner": 1 });
    expect(stub.blobHits["sha-gitignore"]).toBeUndefined();
    expect(GITIGNORE).toBeTruthy();
    expect(stub.codeloadHits).toBe(0);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it("re-pull from another branch replaces the file set", async () => {
    const dev = await fetchRepoFiles("t", "testuser", "latex-repo", "dev");
    expect(Object.keys(dev.files).sort()).toEqual(["figs/logo.png", "main.tex", "second.tex"]);
    expect(String(dev.files["main.tex"])).toContain("dev branch");
    expect(dev.files["sub/inner.tex"]).toBeUndefined();
  });

  it("keeps non-UTF-8 text as raw bytes and treats image extensions as binary", async () => {
    stub.treeMain = {
      sha: "t",
      truncated: false,
      tree: [
        { path: "old.sty", type: "blob", sha: "sha-main", size: 1 },
        { path: "pic.PNG", type: "blob", sha: "sha-main", size: 1 },
      ],
    };
    const res = await fetchRepoFiles("t", "testuser", "latex-repo", "main");
    expect(typeof res.files["old.sty"]).toBe("string");
    expect(res.files["pic.PNG"]).toBeInstanceOf(Uint8Array);
  });

  it("caps the pull at MAX_PULL_FILES and reports the overflow", async () => {
    const tree = Array.from({ length: MAX_PULL_FILES + 5 }, (_, i) => ({
      path: `f${i}.tex`,
      type: "blob",
      sha: "sha-inner",
      size: 1,
    }));
    stub.treeMain = { sha: "t", tree, truncated: false };
    const res = await fetchRepoFiles("t", "testuser", "latex-repo", "main");
    expect(Object.keys(res.files)).toHaveLength(MAX_PULL_FILES);
    expect(res.skippedCap).toBe(5);
    expect(res.total).toBe(MAX_PULL_FILES + 5);
  });

  it("surfaces a failed blob download", async () => {
    stub.treeMain = {
      sha: "t",
      truncated: false,
      tree: [{ path: "x.tex", type: "blob", sha: "sha-missing", size: 1 }],
    };
    await expect(fetchRepoFiles("t", "testuser", "latex-repo", "main")).rejects.toThrow(
      /GitHub error 404 downloading a file/,
    );
  });
});

describe("getIdentity / commit message (e2e github: authored user, template)", () => {
  it("uses the display name and the primary verified email", async () => {
    stub.emails = [
      { email: "other@example.com" },
      { email: "test@example.com", primary: true, verified: true },
    ];
    expect(await getIdentity("t")).toEqual({ name: "Test User", email: "test@example.com" });
  });

  it("falls back to the noreply address when emails are not readable", async () => {
    stub.emails = "forbidden";
    expect(await getIdentity("t")).toEqual({
      name: "Test User",
      email: "testuser@users.noreply.github.com",
    });
  });

  it("falls back to the first email, and to the login when the name is empty", async () => {
    stub.emails = [{ email: "first@example.com" }];
    expect((await getIdentity("t")).email).toBe("first@example.com");
  });

  it("formats machlatex <local date>:<time>", () => {
    expect(pushCommitMessage(new Date(2026, 10, 3, 19, 40, 46))).toBe("machlatex 2026-11-03:19:40:46");
    expect(pushCommitMessage(new Date(2026, 0, 5, 3, 4, 5))).toBe("machlatex 2026-01-05:03:04:05");
    expect(pushCommitMessage()).toMatch(/^machlatex \d{4}-\d{2}-\d{2}:\d{2}:\d{2}:\d{2}$/);
  });
});

describe("pushFiles (e2e github: push)", () => {
  const identity = { name: "Test User", email: "test@example.com" };
  const files = { "main.tex": MAIN_TEX, "sub/inner.tex": INNER_TEX, "figs/logo.png": PNG };

  it("builds blobs → trees deepest-first → commit → non-forced ref move", async () => {
    const progress: number[] = [];
    const res = await pushFiles("t", "testuser", "latex-repo", "main", files, "machlatex 2026-11-03:19:40:46", identity, (d) =>
      progress.push(d),
    );
    expect(res).toEqual({ sha: "new-commit-1", files: 3 });

    // one blob per file, byte-for-byte
    expect(stub.pushBlobs).toHaveLength(3);
    const blobBytes = stub.pushBlobs.map((b) => Array.from(b.bytes).join(","));
    expect(blobBytes).toContain(Array.from(new TextEncoder().encode(MAIN_TEX)).join(","));
    expect(blobBytes).toContain(Array.from(PNG).join(","));

    // trees: the two sub folders first, the root last
    expect(stub.pushTrees).toHaveLength(3);
    const rootTree = stub.pushTrees[2];
    const subTrees = stub.pushTrees.slice(0, 2);
    expect(subTrees.every((t) => t.entries.every((e) => e.type === "blob"))).toBe(true);
    expect(rootTree.entries.map((e) => e.path).sort()).toEqual(["figs", "main.tex", "sub"]);
    const figs = rootTree.entries.find((e) => e.path === "figs")!;
    expect(figs).toMatchObject({ mode: "040000", type: "tree" });
    const figsTree = subTrees.find((t) => t.sha === figs.sha)!;
    expect(figsTree.entries.map((e) => e.path)).toEqual(["logo.png"]);
    expect(rootTree.entries.find((e) => e.path === "main.tex")).toMatchObject({
      mode: "100644",
      type: "blob",
    });

    // one commit on top of the branch's current head, authored by the user
    expect(stub.pushCommits).toHaveLength(1);
    const commit = stub.pushCommits[0] as {
      message: string;
      tree: string;
      parents: string[];
      author: { name: string; email: string };
      committer: { name: string; email: string };
    };
    expect(commit.parents).toEqual(["head-main"]);
    expect(commit.message).toBe("machlatex 2026-11-03:19:40:46");
    expect(commit.author).toMatchObject(identity);
    expect(commit.committer).toMatchObject(identity);
    expect(commit.tree).toBe(rootTree.sha);

    // the ref moves forward, not forced
    expect(stub.pushRefs).toEqual([{ ref: "refs/heads/main", sha: "new-commit-1", force: false }]);

    // progress ends at the total (3 blobs + 3 trees)
    expect(progress.length).toBeGreaterThan(0);
  });

  it("orders requests: head lookup, then all blobs, then trees, commit, ref", async () => {
    await pushFiles("t", "testuser", "latex-repo", "dev", files, "m", identity);
    const kinds = stub.requests.map((r) => {
      if (r.path.endsWith("/branches/dev")) return "head";
      if (r.path.endsWith("/git/blobs")) return "blob";
      if (r.path.endsWith("/git/trees")) return "tree";
      if (r.path.endsWith("/git/commits")) return "commit";
      if (r.path.includes("/git/refs/")) return "ref";
      return "other";
    });
    expect(kinds[0]).toBe("head");
    expect(kinds.slice(1, 4)).toEqual(["blob", "blob", "blob"]);
    expect(kinds.slice(4)).toEqual(["tree", "tree", "tree", "commit", "ref"]);
    expect((stub.pushCommits[0] as { parents: string[] }).parents).toEqual(["head-dev"]);
  });

  it("builds a folder that holds only subfolders (intermediate tree gets its entry)", async () => {
    await pushFiles("t", "testuser", "latex-repo", "main", { "a/b/c.tex": "x" }, "m", identity);
    // trees: a/b, a, root — deepest first
    expect(stub.pushTrees).toHaveLength(3);
    const [ab, a, root] = stub.pushTrees;
    expect(ab.entries).toMatchObject([{ path: "c.tex", type: "blob" }]);
    expect(a.entries).toMatchObject([{ path: "b", type: "tree", sha: ab.sha }]);
    expect(root.entries).toMatchObject([{ path: "a", type: "tree", sha: a.sha }]);
  });

  it("refuses a folder with more than 100 entries up front (no request sent)", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 101; i++) many[`f${i}.tex`] = "x";
    await expect(pushFiles("t", "testuser", "latex-repo", "main", many, "m", identity)).rejects.toThrow(
      /more than 100 entries/,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it("counts subdirectories toward every ancestor's 100-entry limit", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`f${i}.tex`] = "x";
    many["sub/y.tex"] = "y"; // the root now holds 101 entries
    await expect(pushFiles("t", "testuser", "latex-repo", "main", many, "m", identity)).rejects.toThrow(/“\/”/);
  });

  it("encodes large binaries in chunks without overflowing the stack", async () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    await pushFiles("t", "testuser", "latex-repo", "main", { "big.bin": big }, "m", identity);
    expect(stub.pushBlobs[0].bytes).toHaveLength(300_000);
    expect(Array.from(stub.pushBlobs[0].bytes)).toEqual(Array.from(big));
  });

  it("reports a moved branch (409) with the reopen hint", async () => {
    stub.status["/repos/testuser/latex-repo/git/refs/heads/main"] = 409;
    await expect(pushFiles("t", "testuser", "latex-repo", "main", { "a.tex": "x" }, "m", identity)).rejects.toThrow(
      /branch moved/,
    );
  });
});
