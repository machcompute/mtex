// Editor file operations, tab state and validation notices
// (e2e: fixes.cjs #1 #13 #14c #18 #21 #22 #24, rename.cjs, layout swaps).
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeBusyTex } from "../support/fake-busytex";
import { monacoState } from "../support/stubs/monaco";
import { click, newFile, openFile, q, qa, rail, renameFile, rowFor, tab, typeInEditor } from "../support/page-actions";
import { activeTab, advance, fileRows, mountEditor, noticeText, openTabs, railActive, settle, statusText, stored } from "../support/page-utils";

beforeEach(() => {
  FakeBusyTex.autoReady = false; // file ops need no engine: keep the open-time compile out of the way
});

const seed = {
  name: "t",
  mainPath: "main.tex",
  openPaths: ["main.tex", "b.tex"],
  activePath: "b.tex",
  files: { "main.tex": "AAA\n", "b.tex": "BBB\n" } as Record<string, string>,
};

describe("tab restore (#21)", () => {
  it("restores the open tabs and the tab that was active when the project was left", async () => {
    await mountEditor(seed);
    expect(activeTab()).toBe("b.tex");
    expect(openTabs()).toEqual(["main.tex", "b.tex"]);
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).toBe("BBB\n");
  });

  it("falls back sensibly when the stored meta names files that no longer exist", async () => {
    await mountEditor({ ...seed, openPaths: ["gone.tex", "main.tex"], activePath: "gone.tex" });
    expect(openTabs()).toEqual(["main.tex"]);
    expect(activeTab()).toBe("main.tex");
  });

  it("a project with no .tex has no main file and no main badge (#24)", async () => {
    await mountEditor({ name: "notex", mainPath: "", openPaths: [], activePath: "", files: { "refs.bib": "@book{x}", "notes.txt": "hi" } });
    expect(qa("aside li").some((li) => li.textContent?.includes("main") && li.querySelector('[title="Build target"]'))).toBe(false);
    expect(q('[title="Build target"]')).toBeNull();
  });
});

describe("rename-back (#1: no stale Monaco model)", () => {
  it("edits made under the temporary name survive renaming back", async () => {
    await mountEditor(seed);
    await tab("main.tex");
    await typeInEditor("AAA\nED");
    await renameFile("main.tex", "m2.tex");
    expect(activeTab()).toBe("m2.tex");
    await typeInEditor("AAA\nEDX");
    await renameFile("m2.tex", "main.tex");
    expect(activeTab()).toBe("main.tex");
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).toBe("AAA\nEDX");
  });

  it("disposes the Monaco models of both the old and the new path on rename and delete", async () => {
    await mountEditor(seed);
    await tab("main.tex");
    expect([...monacoState.models.keys()].sort()).toContain("main.tex");
    await renameFile("main.tex", "m2.tex");
    expect(monacoState.models.has("main.tex")).toBe(false);
  });
});

describe("new-file validation notices (#22, #18)", () => {
  it("a duplicate name shows a notice, keeps the modal open and the log panel closed", async () => {
    await mountEditor(seed);
    const closed = await newFile("b.tex");
    expect(closed).toBe(false);
    expect(noticeText()).toContain("“b.tex” already exists");
    expect(railActive()).toEqual(["files"]); // a validation error never opens the log
    // Escape closes, a legal name then works
    fireEvent.keyDown(q('[data-modal="new-file"] input')!, { key: "Escape" });
    await settle();
    expect(q('[data-modal="new-file"]')).toBeNull();
  });

  it("v1..2.tex is a legal name; '.' and '..' are not", async () => {
    await mountEditor(seed);
    expect(await newFile("v1..2.tex")).toBe(true);
    expect(fileRows()).toContain("v1..2.tex");
    expect(activeTab()).toBe("v1..2.tex");
    expect(await newFile("..")).toBe(false);
    expect(noticeText()).toMatch(/Cannot create “\.\.”/);
  });

  it.each(["constructor", "__proto__", "prototype", "Constructor"])("reserved name %s is refused with a notice", async (name) => {
    await mountEditor(seed);
    expect(await newFile(name)).toBe(false);
    expect(noticeText()).toMatch(/use a flat name \(no folders or reserved names\)/);
    expect(fileRows()).not.toContain(name);
  });

  it("refuses names with folder separators and bad folder locations", async () => {
    await mountEditor(seed);
    expect(await newFile("a/b.tex")).toBe(false);
    expect(await newFile("ok.tex", "../up")).toBe(false);
    expect(noticeText()).toMatch(/not a valid folder path/);
  });

  it("creates a file inside a folder and refuses collisions with files/folders", async () => {
    await mountEditor(seed);
    expect(await newFile("ch1.tex", "chapters/")).toBe(true);
    expect(fileRows()).toContain("ch1.tex");
    expect(await newFile("chapters", "")).toBe(false);
    expect(noticeText()).toBe("“chapters” is a folder in this project");
    expect(await newFile("deep.tex", "b.tex")).toBe(false);
    expect(noticeText()).toMatch(/collide with an existing file/);
  });

  it("the notice clears itself after its timeout", async () => {
    await mountEditor(seed);
    await newFile("b.tex");
    expect(noticeText()).not.toBe("");
    await advance(3000);
    expect(noticeText()).toBe("");
  });
});

describe("rename collisions (#13, rename.cjs)", () => {
  it("refuses to rename onto an existing file or under one", async () => {
    await mountEditor({ ...seed, files: { "main.tex": "A", "b.tex": "B", "dir/c.tex": "C" } });
    await renameFile("b.tex", "main.tex");
    expect(noticeText()).toMatch(/Cannot rename to “main.tex” — name already taken/);
    expect(fileRows()).toContain("b.tex");
    await renameFile("b.tex", "main.tex/x.tex");
    expect(noticeText()).toMatch(/collide with an existing file or folder/);
    await renameFile("b.tex", "dir");
    expect(noticeText()).toMatch(/collide/);
    expect(fileRows().sort()).toEqual(["b.tex", "c.tex", "main.tex"].sort());
  });

  it("an invalid path shows a notice and leaves the log panel closed and the file unchanged", async () => {
    await mountEditor(seed);
    await renameFile("b.tex", "../escape.tex");
    expect(noticeText()).toMatch(/Cannot rename/);
    expect(railActive()).toEqual(["files"]);
    expect(fileRows()).toContain("b.tex");
  });

  it("renames in place and moves between folders, keeping tree depth", async () => {
    await mountEditor({ ...seed, files: { "main.tex": "A", "figs/logo.png": new Uint8Array([1, 2, 3]) } as never });
    const pad = (name: string) => (rowFor(name)!.querySelector("div.group") as HTMLElement).style.paddingLeft;
    expect(pad("logo.png")).toBe("18px");
    await renameFile("figs/logo.png", "figs/logo2.png");
    expect(rowFor("logo2.png")).not.toBeNull();
    expect(rowFor("logo.png")).toBeNull();
    expect(pad("logo2.png")).toBe("18px"); // in place keeps folder depth
    await renameFile("figs/logo2.png", "rootlogo.png");
    expect(pad("rootlogo.png")).toBe("8px"); // moved to the root
  });

  it("the renamed file follows into OPFS", async () => {
    const { id } = await mountEditor({ ...seed, files: { "main.tex": "A", "figs/logo.png": new Uint8Array([137, 80, 78, 71, 255]) } as never });
    await renameFile("figs/logo.png", "rootlogo.png");
    await advance(700); // the 600 ms debounced persist
    const s = await stored(id!);
    expect(s.files["figs/logo.png"]).toBeUndefined();
    expect(Array.from(s.files["rootlogo.png"] as Uint8Array)).toEqual([137, 80, 78, 71, 255]);
  });

  it("renaming the main file moves the main badge and the open tab", async () => {
    await mountEditor(seed);
    await renameFile("main.tex", "root.tex");
    expect(openTabs()).toEqual(["root.tex", "b.tex"]);
    const row = rowFor("root.tex")!;
    expect(row.textContent).toContain("main");
    expect(row.querySelector('[title="Build target"]')).not.toBeNull();
  });
});

describe("deleting files (#14c)", () => {
  it("deleting the only .tex leaves no build target, and compile says so", async () => {
    FakeBusyTex.autoReady = true;
    await mountEditor({ name: "t", mainPath: "main.tex", files: { "main.tex": "A", "refs.bib": "@book{x}" } });
    await advance(10);
    expect(statusText()).toMatch(/Compiled/);
    await click(rowFor("main.tex")!.querySelector('button[title="Delete file"]'));
    expect(q('[title="Build target"]')).toBeNull(); // refs.bib is never picked as main
    await click(q('[data-testid="pdf-leading"] button'), "compile");
    expect(statusText()).toBe("No main .tex file — add one and mark it “main”");
    expect(FakeBusyTex.calls).toHaveLength(1);
  });

  it("deleting the main file promotes the first remaining .tex and activates a neighbour tab", async () => {
    await mountEditor({ name: "t", mainPath: "main.tex", openPaths: ["main.tex", "b.tex", "c.tex"], activePath: "b.tex", files: { "main.tex": "A", "b.tex": "B", "c.tex": "C" } });
    await click(rowFor("b.tex")!.querySelector('button[title="Delete file"]'));
    expect(openTabs()).toEqual(["main.tex", "c.tex"]);
    expect(activeTab()).toBe("main.tex"); // the tab before the deleted one
    await click(rowFor("main.tex")!.querySelector('button[title="Delete file"]'));
    expect(rowFor("c.tex")!.querySelector('[title="Build target"]')).not.toBeNull();
  });

  it("closing a tab keeps the file; closing the last tab reopens main", async () => {
    await mountEditor(seed);
    await click(q('[data-tab="b.tex"] button[title="Close tab"]'));
    expect(openTabs()).toEqual(["main.tex"]);
    expect(fileRows()).toContain("b.tex");
    await click(q('[data-tab="main.tex"] button[title="Close tab"]'));
    expect(openTabs()).toEqual(["main.tex"]);
  });
});

describe("set main", () => {
  it("the main badge moves to the chosen .tex file", async () => {
    await mountEditor(seed);
    await click(rowFor("b.tex")!.querySelector('button[title="Set as main file"]'));
    expect(rowFor("b.tex")!.querySelector('[title="Build target"]')).not.toBeNull();
    expect(rowFor("main.tex")!.querySelector('[title="Build target"]')).toBeNull();
  });
});

describe("rail", () => {
  it("lists files/search/chat/log in order, with tooltips, files active, GitHub + Packages at the bottom", async () => {
    await mountEditor(seed);
    const ids = qa("[data-rail]").map((e) => e.dataset.rail);
    expect(ids).toEqual(["files", "search", "chat", "log"]);
    expect(qa("[data-rail]").map((e) => e.getAttribute("title"))).toEqual(["Files", "Search", "Chat", "Log"]);
    expect(railActive()).toEqual(["files"]);
    const nav = q("nav[aria-label='Left panel']")!;
    const kids = [...nav.children];
    const iGh = kids.findIndex((k) => (k as HTMLElement).dataset.action === "github");
    const iPk = kids.findIndex((k) => (k as HTMLElement).dataset.action === "packages");
    expect(iGh).toBeGreaterThan(3);
    expect(iPk).toBe(iGh + 1);
    expect(kids.at(-1)).toBe(kids[iPk]);
  });

  it("switching panes shows exactly one view at a time", async () => {
    await mountEditor(seed);
    await rail("search");
    expect(q("[data-search-input]")).not.toBeNull();
    expect(q("aside")).toBeNull();
    await rail("chat");
    expect(q("[data-chat-input]")).not.toBeNull();
    expect(q("[data-search-input]")).toBeNull();
    await rail("log");
    expect(q("pre")?.textContent).toBe("(no log output yet)");
    await rail("files");
    expect(q("aside")).not.toBeNull();
    expect(q("[data-search-input]")).toBeNull();
    expect(railActive()).toEqual(["files"]);
  });
});
