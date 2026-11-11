// The GitHub bridge end to end through the real modal and the real editor page:
// PAT sign-in, repo/branch browsing, pull, re-pull, push (e2e: github.cjs).
// api.github.com is a fetch stub; nothing else is mocked between the UI and OPFS.
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CompileResult } from "@/lib/busytex";
import { GITHUB_PAT_KEY } from "@/lib/github";
import { listProjects, loadProject } from "@/lib/opfs";
import { FakeBusyTex, fakePdfFor } from "../support/fake-busytex";
import { click, compileButton, q, qa, rail, rowFor } from "../support/page-actions";
import { act, activeTab, advance, deferred, fileRows, mountEditor, noticeText, projectNameValue, railActive, settle, statusText } from "../support/page-utils";
import { MAIN_TEX, MAIN_TEX_DEV, PNG, installGithubStub, type GithubStub } from "../support/github-fixtures";
import { pdfState } from "../support/stubs/pdf-viewer";

let stub: GithubStub;
beforeEach(() => {
  FakeBusyTex.autoReady = false;
  stub = installGithubStub();
});

const gh = (k: string) => q(`[data-gh="${k}"]`);
const modal = () => q('[data-modal="github"]');
const select = (k: "repo" | "branch") => q<HTMLSelectElement>(`select[data-gh="${k}"]`)!;

async function openModal() {
  await click(q('[data-action="github"]'));
  await settle();
}
async function signIn(token = "ghp_testtoken") {
  await openModal();
  fireEvent.change(gh("pat")!, { target: { value: token } });
  await click(gh("save"));
  await settle(200);
}
async function pull(branch?: string) {
  if (branch) {
    fireEvent.change(select("branch"), { target: { value: branch } });
    await settle();
  }
  await click(gh("pull"));
  await settle(300);
}

describe("sign-in (PAT)", () => {
  it("shows the PAT step without a saved token, then signs in, persists the token and sends it as Bearer", async () => {
    await mountEditor();
    expect(localStorage.getItem(GITHUB_PAT_KEY)).toBeNull();
    await openModal();
    expect(gh("pat")).not.toBeNull();
    expect(gh("login")).toBeNull();
    fireEvent.change(gh("pat")!, { target: { value: "  ghp_abc  " } });
    await click(gh("save"));
    await settle(200);
    expect(gh("login")!.textContent).toBe("testuser");
    expect(localStorage.getItem(GITHUB_PAT_KEY)).toBe("ghp_abc");
    expect(stub.requests.every((r) => r.headers.authorization === "Bearer ghp_abc")).toBe(true);
    expect(gh("error")).toBeNull();
  });

  it("lists the repo, loads the branches and preselects the default branch; a fresh repo offers a fresh pull", async () => {
    await mountEditor();
    await signIn();
    expect([...select("repo").options].map((o) => o.value)).toEqual(["testuser/latex-repo"]);
    expect([...select("branch").options].map((o) => o.value)).toEqual(["main", "dev"]);
    expect(select("branch").value).toBe("main");
    expect(gh("pull")!.textContent).toBe("Pull into a project");
  });

  it("a rejected token shows the error banner and stays on the PAT step", async () => {
    stub.status["/user"] = 401;
    await mountEditor();
    await signIn("bad");
    expect(gh("error")!.textContent).toMatch(/rejected the token/);
    expect(gh("pat")).not.toBeNull();
  });

  it("an offline GitHub shows a connection message", async () => {
    stub.offline = true;
    await mountEditor();
    await signIn();
    expect(gh("error")!.textContent).toMatch(/Could not reach GitHub/);
  });

  it("Disconnect forgets the token and returns to the PAT step", async () => {
    await mountEditor();
    await signIn();
    await click(gh("disconnect"));
    expect(localStorage.getItem(GITHUB_PAT_KEY)).toBeNull();
    expect(gh("pat")).not.toBeNull();
  });

  it("closes from the close button and by clicking the backdrop (when idle)", async () => {
    await mountEditor();
    await openModal();
    await click(q('button[title="Close"]'));
    expect(modal()).toBeNull();
    await openModal();
    fireEvent.mouseDown(modal()!);
    await settle();
    expect(modal()).toBeNull();
  });
});

describe("pull (github.cjs: pull)", () => {
  it("creates a project named for the repo, skipping the dotfile before downloading it", async () => {
    await mountEditor();
    await signIn();
    await pull();
    expect(modal()).toBeNull(); // closed itself
    expect(noticeText()).toBe("Pulled 3 files from testuser/latex-repo — 1 dotfile skipped");
    expect(projectNameValue()).toBe("latex-repo");
    expect(fileRows().sort()).toEqual(["inner.tex", "logo.png", "main.tex"]);
    expect(fileRows()).not.toContain(".gitignore");
    expect(activeTab()).toBe("main.tex");
    expect(stub.blobHits).toEqual({ "sha-main": 1, "sha-png": 1, "sha-inner": 1 }); // each kept blob once, junk never requested
    expect(stub.codeloadHits).toBe(0);
    expect(rowFor("main.tex")!.querySelector('[title="Build target"]')).not.toBeNull();
  });

  it("persists the files, the png byte-for-byte, the main path and the GitHub source in OPFS", async () => {
    await mountEditor();
    await signIn();
    await pull();
    await advance(700);
    const list = await listProjects();
    expect(list.map((p) => p.name).sort()).toEqual(["LaTeX project", "latex-repo"]); // the default project is untouched
    const p = list.find((x) => x.name === "latex-repo")!;
    expect(p.source).toEqual({ kind: "github", owner: "testuser", repo: "latex-repo", branch: "main" });
    const { meta, files } = await loadProject(p.id);
    expect(meta.mainPath).toBe("main.tex");
    expect(files[".gitignore"]).toBeUndefined();
    expect(files["main.tex"]).toBe(MAIN_TEX);
    expect(Array.from(files["figs/logo.png"] as Uint8Array)).toEqual(Array.from(PNG));
    expect(files["sub/inner.tex"]).toBe("Inner content.\n");
  });

  it("the pulled project compiles with its nested files", async () => {
    FakeBusyTex.autoReady = true;
    await mountEditor();
    await signIn();
    await pull();
    await advance(10);
    const call = FakeBusyTex.calls.at(-1)!;
    expect(call.main).toBe("main.tex");
    expect(Object.keys(call.files).sort()).toEqual(["figs/logo.png", "main.tex", "sub/inner.tex"]);
    expect(pdfState.text()).toContain("Pulled from GitHub.");
    expect(statusText()).toMatch(/^Compiled/);
  });

  it("re-opening the modal signs in from the saved token and offers Re-pull for a pulled repo", async () => {
    await mountEditor();
    await signIn();
    await pull();
    stub.requests.length = 0;
    await openModal();
    await settle(200);
    expect(gh("pat")).toBeNull(); // auto-signed-in
    expect(gh("login")!.textContent).toBe("testuser");
    expect(gh("pull")!.textContent).toBe("Re-pull");
    expect(select("branch").value).toBe("main"); // the project's source branch preselected
  });

  it("a re-pull from another branch REPLACES the project's files (same id, stale path deleted, branch recorded)", async () => {
    await mountEditor();
    await signIn();
    await pull();
    const firstId = (await listProjects()).find((p) => p.name === "latex-repo")!.id;
    await openModal();
    await settle(200);
    await pull("dev");
    expect(projectNameValue()).toBe("latex-repo");
    expect(fileRows().sort()).toEqual(["logo.png", "main.tex", "second.tex"]);
    await advance(700);
    const list = await listProjects();
    expect(list.filter((p) => p.name === "latex-repo")).toHaveLength(1); // no duplicate
    expect(list).toHaveLength(2); // default + the repo
    const p = list.find((x) => x.name === "latex-repo")!;
    expect(p.id).toBe(firstId);
    expect(p.source?.branch).toBe("dev");
    const { files } = await loadProject(p.id);
    expect(files["main.tex"]).toBe(MAIN_TEX_DEV);
    expect(files["sub/inner.tex"]).toBeUndefined(); // the stale file is gone
    expect(files["second.tex"]).toBe("Second file on the dev branch.\n");
    expect(noticeText()).toBe("Pulled 3 files from testuser/latex-repo");
  });

  it("applying a pulled project resets the pane to Files (a genuine project change) and re-triggers the open-time compile", async () => {
    FakeBusyTex.autoReady = true;
    await mountEditor();
    await advance(10);
    await rail("log");
    expect(railActive()).toEqual(["log"]);
    // the modal needs the rail button, which is always present
    await signIn();
    await pull();
    await advance(10);
    expect(railActive()).toEqual(["files"]);
    expect(FakeBusyTex.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a build in flight for the OUTGOING project does not land its PDF on the pulled project", async () => {
    FakeBusyTex.autoReady = true;
    const slow = deferred<CompileResult>();
    let n = 0;
    FakeBusyTex.handler = (call) => {
      n++;
      return n === 1 ? slow.promise : { pdf: fakePdfFor(call), log: "", synctex: null, buildState: null };
    };
    await mountEditor();
    await advance(10);
    expect(statusText()).toMatch(/^Compiling/);
    await signIn();
    await pull();
    await advance(10);
    await act(async () => slow.resolve({ pdf: new TextEncoder().encode("OLD PROJECT PDF"), log: "old", synctex: null, buildState: null }));
    await settle();
    expect(pdfState.text()).not.toContain("OLD PROJECT PDF"); // the outgoing build's result is dropped
    expect(statusText()).not.toMatch(/^Compiled/);
    // the pulled project builds normally on demand
    await click(compileButton());
    await advance(10);
    expect(pdfState.text()).toContain("Pulled from GitHub.");
  });

  it("an empty repo says so and creates nothing", async () => {
    stub.treeMain = { sha: "t", tree: [], truncated: false };
    await mountEditor();
    await signIn();
    await pull();
    expect(noticeText()).toBe("That repo has no files to pull");
    expect(await listProjects()).toHaveLength(1);
  });

  it("reports files dropped by the 1000-file limit", async () => {
    stub.treeMain = {
      sha: "t",
      truncated: false,
      tree: Array.from({ length: 1005 }, (_, i) => ({ path: `f${i}.tex`, type: "blob", sha: "sha-inner", size: 1 })),
    };
    await mountEditor();
    await signIn();
    await pull();
    expect(noticeText()).toBe("Pulled 1000 files from testuser/latex-repo — 5 over the 1000-file limit");
  });

  it("a truncated tree is reported in the modal and nothing is created", async () => {
    stub.treeMain = { sha: "t", tree: [], truncated: true };
    await mountEditor();
    await signIn();
    await pull();
    expect(gh("error")!.textContent).toMatch(/too large to pull/);
    expect(modal()).not.toBeNull();
    expect(await listProjects()).toHaveLength(1);
  });
});

describe("push (github.cjs: push)", () => {
  async function pulledThenPush() {
    await mountEditor();
    await signIn();
    await pull("dev");
    await openModal();
    await settle(200);
  }

  it("preselects the project's source repo and branch and offers the push button", async () => {
    await pulledThenPush();
    expect(select("repo").value).toBe("testuser/latex-repo");
    expect(select("branch").value).toBe("dev");
    expect(gh("push")).not.toBeNull();
    expect(gh("push")!.hasAttribute("disabled")).toBe(false);
  });

  it("uploads one blob per file, trees deepest-first, ONE commit on the branch head, then a non-forced ref move", async () => {
    await pulledThenPush();
    await click(gh("push"));
    await settle(300);
    expect(modal()).toBeNull();
    expect(noticeText()).toBe("Pushed 3 files to testuser/latex-repo @ dev (new-com)");
    // blobs byte-for-byte
    const blobs = stub.pushBlobs.map((b) => Array.from(b.bytes).join(","));
    expect(blobs).toHaveLength(3);
    expect(blobs).toContain(Array.from(PNG).join(","));
    expect(blobs).toContain(Array.from(new TextEncoder().encode(MAIN_TEX_DEV)).join(","));
    // trees: figs first, the root last and listing every path
    expect(stub.pushTrees).toHaveLength(2);
    const [figs, root] = stub.pushTrees;
    expect(figs.entries.map((e) => e.path)).toEqual(["logo.png"]);
    expect(root.entries.map((e) => e.path).sort()).toEqual(["figs", "main.tex", "second.tex"]);
    expect(root.entries.find((e) => e.path === "figs")).toMatchObject({ type: "tree", sha: figs.sha, mode: "040000" });
    // one commit, on dev's head, template message, authored by the signed-in user
    expect(stub.pushCommits).toHaveLength(1);
    const c = stub.pushCommits[0] as { message: string; parents: string[]; tree: string; author: { name: string; email: string } };
    expect(c.parents).toEqual(["head-dev"]);
    expect(c.message).toMatch(/^machlatex \d{4}-\d{2}-\d{2}:\d{2}:\d{2}:\d{2}$/);
    expect(c.author).toMatchObject({ name: "Test User", email: "test@example.com" });
    expect(c.tree).toBe(root.sha);
    expect(stub.pushRefs).toEqual([{ ref: "refs/heads/dev", sha: "new-commit-1", force: false }]);
    expect(stub.codeloadHits).toBe(0);
  });

  it("records the pushed repo/branch as the project's source in OPFS", async () => {
    await mountEditor();
    await signIn();
    await pull();
    await openModal();
    await settle(200);
    fireEvent.change(select("branch"), { target: { value: "dev" } });
    await settle();
    await click(gh("push"));
    await settle(300);
    await advance(700);
    const p = (await listProjects()).find((x) => x.name === "latex-repo")!;
    expect(p.source).toEqual({ kind: "github", owner: "testuser", repo: "latex-repo", branch: "dev" });
  });

  it("a push failure (branch moved) is shown in the modal, which stays open", async () => {
    await pulledThenPush();
    stub.status["/repos/testuser/latex-repo/git/refs/heads/dev"] = 409;
    await click(gh("push"));
    await settle(300);
    expect(gh("error")!.textContent).toMatch(/branch moved/);
    expect(modal()).not.toBeNull();
  });

  it("every request is the Git Data API — no tarball traffic, no non-GitHub hosts", async () => {
    await pulledThenPush();
    await click(gh("push"));
    await settle(300);
    expect(stub.requests.every((r) => r.url.startsWith("https://api.github.com/"))).toBe(true);
    void qa;
  });
});
