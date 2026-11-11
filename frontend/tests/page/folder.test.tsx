// Folder import and drag-and-drop (e2e: folder.cjs, firefox.cjs, fixes #10 #12 #15 #23).
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBusyTex } from "../support/fake-busytex";
import { click, dropEntries, dropFiles, fakeFile, newFile, openFile, pick, q, qa, rowFor, type FsNode } from "../support/page-actions";
import { activeTab, advance, fileRows, mountEditor, noticeText, openTabs, settle, statusText, stored } from "../support/page-utils";
import { monacoState } from "../support/stubs/monaco";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 254]);
const DOC = "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nFolder doc with nested image.\n\\includegraphics[width=2cm]{figs/logo.png}\n\\end{document}\n";

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() }));
});

const padOf = (name: string) => (rowFor(name)!.querySelector("div.group") as HTMLElement).style.paddingLeft;
const iconKind = (name: string) => rowFor(name)!.querySelector("[data-kind]")!.getAttribute("data-kind");

describe("folder button (webkitdirectory picker — firefox.cjs)", () => {
  it("is a webkitdirectory input, distinct from the plain file picker", async () => {
    await mountEditor();
    const inputs = qa<HTMLInputElement>('aside input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(inputs.filter((i) => i.hasAttribute("webkitdirectory"))).toHaveLength(1);
    expect(q('button[data-action="upload-folder"]')).not.toBeNull();
  });

  it("imports a picked folder: top folder stripped, nested rows indented, notice, first .tex opened", async () => {
    await mountEditor();
    await pick("upload-folder", [
      fakeFile("doc.tex", DOC, { relativePath: "paper/doc.tex" }),
      fakeFile("logo.png", PNG, { relativePath: "paper/figs/logo.png", type: "image/png" }),
    ]);
    expect(noticeText()).toMatch(/^Uploaded 2 files — kept in your browser/);
    expect(fileRows()).toEqual(expect.arrayContaining(["doc.tex", "logo.png"]));
    expect(padOf("doc.tex")).toBe("8px");
    expect(padOf("logo.png")).toBe("18px"); // nested row indented
    expect(iconKind("logo.png")).toBe("image");
    expect(activeTab()).toBe("doc.tex"); // a .tex file is preferred for the first open
  });

  it("the imported main switch compiles with the nested files in the payload", async () => {
    await mountEditor();
    await pick("upload-folder", [
      fakeFile("doc.tex", DOC, { relativePath: "paper/doc.tex" }),
      fakeFile("logo.png", PNG, { relativePath: "paper/figs/logo.png" }),
    ]);
    await click(rowFor("doc.tex")!.querySelector('button[title="Set as main file"]'));
    expect(rowFor("doc.tex")!.querySelector('[title="Build target"]')).not.toBeNull(); // main badge moved
    await advance(10);
    FakeBusyTex.calls.length = 0;
    await click(q('[data-testid="pdf-leading"] button'), "compile");
    const call = FakeBusyTex.calls.at(-1)!;
    expect(call.main).toBe("doc.tex");
    expect(Array.from(call.files["figs/logo.png"] as Uint8Array)).toEqual(Array.from(PNG)); // binary byte-for-byte
    expect(String(call.files["doc.tex"])).toContain("figs/logo.png");
  });

  it("opens an image as a preview tab (binary, not editable) and persists nested paths", async () => {
    const { id } = await mountEditor();
    await pick("upload-folder", [fakeFile("logo.png", PNG, { relativePath: "paper/figs/logo.png" }), fakeFile("doc.tex", DOC, { relativePath: "paper/doc.tex" })]);
    await openFile("logo.png");
    expect(activeTab()).toBe("figs/logo.png");
    expect(q('img[alt="figs/logo.png"]')).not.toBeNull();
    expect(q("[data-testid=monaco]")).toBeNull();
    expect(document.body.textContent).toContain(`Binary file (${PNG.length} bytes)`);
    await advance(700);
    const s = await stored(id!);
    expect(Array.from(s.files["figs/logo.png"] as Uint8Array)).toEqual(Array.from(PNG));
    expect(s.files["doc.tex"]).toBe(DOC);
  });

  it("skips dotfiles and reserved names at any depth, and counts them in the notice", async () => {
    await mountEditor();
    await pick("upload-folder", [
      fakeFile("a.tex", "a", { relativePath: "p/a.tex" }),
      fakeFile(".DS_Store", "x", { relativePath: "p/.DS_Store" }),
      fakeFile("HEAD", "x", { relativePath: "p/.git/HEAD" }),
      fakeFile("constructor", "x", { relativePath: "p/constructor" }),
    ]);
    expect(fileRows()).toContain("a.tex");
    expect(fileRows()).not.toContain(".DS_Store");
    expect(fileRows()).not.toContain("HEAD");
    expect(noticeText()).toContain("(3 skipped: dotfiles or reserved names)");
  });

  it("never overwrites an existing file, and says so", async () => {
    await mountEditor();
    await pick("upload", [fakeFile("main.tex", "REPLACEMENT")]);
    expect(noticeText()).toMatch(/Nothing uploaded — 1 file was already in the project/);
    await openFile("main.tex");
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).not.toBe("REPLACEMENT");
  });

  it("stores bytes that are not valid UTF-8 raw instead of mangling them (#15)", async () => {
    const { id } = await mountEditor();
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    await pick("upload", [fakeFile("old.sty", latin1)]);
    expect(iconKind("old.sty")).toBe("image"); // a byte array row (binary)
    await advance(700);
    const s = await stored(id!);
    expect(s.files["old.sty"]).toBeInstanceOf(Uint8Array);
    expect(Array.from(s.files["old.sty"] as Uint8Array)).toEqual(Array.from(latin1));
  });
});

describe("drag and drop (#10 #12 #23)", () => {
  const thesis = (): FsNode => ({
    name: "thesis",
    children: [
      { name: "thesis.tex", data: DOC },
      { name: "ch", children: [{ name: "deep", children: [{ name: "one.tex", data: "Deep.\n" }] }] },
      { name: ".git", children: [{ name: "HEAD", data: "ref\n" }] },
      { name: "LICENSE", data: "" },
      { name: "fig.png", data: PNG },
      { name: "many", children: Array.from({ length: 150 }, (_, i) => ({ name: `f${i}.tex`, data: `${i}\n` })) },
    ],
  });

  it("a plain file dropped anywhere is imported and the page does not navigate away (#23)", async () => {
    await mountEditor();
    const e = await dropFiles([fakeFile("b.tex", "BBB")]);
    expect(e.defaultPrevented).toBe(true); // the browser's own file:// navigation is suppressed
    expect(fileRows()).toContain("b.tex");
    expect(openTabs()).toContain("b.tex");
  });

  it("ignores non-file drags (text selections) so they keep their default", async () => {
    await mountEditor();
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["text/plain"], items: [], files: [] } });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("dragover with files is cancelled so the drop can happen", async () => {
    await mountEditor();
    const e = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"] } });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("a dropped folder is walked recursively, past the 100-entry readEntries batch, top folder stripped (#10)", async () => {
    const { id } = await mountEditor();
    await dropEntries([thesis()]);
    await advance(700);
    const paths = Object.keys((await stored(id!)).files);
    expect(paths).toContain("thesis.tex");
    expect(paths.some((p) => p.startsWith("thesis/"))).toBe(false);
    expect(paths).toContain("ch/deep/one.tex");
    expect(paths.filter((p) => p.startsWith("many/"))).toHaveLength(150);
    expect(paths).toContain("LICENSE"); // empty extensionless file kept
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false); // junk folder skipped, no junk row
    expect(fileRows()).not.toContain("HEAD");
    const files = (await stored(id!)).files;
    expect(Array.from(files["fig.png"] as Uint8Array)).toEqual(Array.from(PNG)); // byte-for-byte
  });

  it("two folders dropped together keep their names so same-named files cannot collide", async () => {
    const { id } = await mountEditor();
    await dropEntries([
      { name: "other", children: [{ name: "same.tex", data: "Other.\n" }] },
      { name: "second", children: [{ name: "same.tex", data: "Second.\n" }] },
    ]);
    await advance(700);
    const files = (await stored(id!)).files;
    expect(files["other/same.tex"]).toBe("Other.\n");
    expect(files["second/same.tex"]).toBe("Second.\n");
  });

  it("an empty folder explains itself and creates no row", async () => {
    await mountEditor();
    await dropEntries([{ name: "empty", children: [] }]);
    expect(noticeText()).toBe("Nothing uploaded — the folder is empty");
    expect(fileRows().some((r) => r === "empty")).toBe(false);
  });

  it("unreadable entries are counted and reported instead of silently dropped", async () => {
    await mountEditor();
    await dropEntries([{ name: "locked", children: [], unreadable: true }]);
    expect(noticeText()).toMatch(/1 dropped folder can't be read by the browser — use the folder button/);
  });

  it("a folder dragged without the entry API (an unreadable 0-byte typeless File) is flagged, a 0-byte file with a dot still imports", async () => {
    await mountEditor();
    await dropFiles([fakeFile("somefolder", "", { type: "" })]);
    expect(noticeText()).toMatch(/dropped folder can't be read by the browser/);
    await dropFiles([fakeFile("empty.txt", "", { type: "" })]);
    expect(fileRows()).toContain("empty.txt");
  });

  it("an existing file is never overwritten by a drop (#12)", async () => {
    await mountEditor({ name: "t", mainPath: "a.tex", files: { "a.tex": "ORIGINAL" } });
    await dropFiles([fakeFile("a.tex", "FROM DROP"), fakeFile("b.tex", "B")]);
    expect(noticeText()).toMatch(/\(1 already existed, skipped\)/);
    await advance(700);
    expect(monacoState.model()?.value).toBe("ORIGINAL");
    expect(fileRows()).toContain("b.tex");
  });

  it("the file panel's own drop highlights while dragging and clears on drop", async () => {
    await mountEditor();
    const aside = q("aside")!;
    fireEvent.dragEnter(aside);
    await settle();
    expect(document.body.textContent).toContain("Drop files or a folder to add them");
    fireEvent.drop(aside, { dataTransfer: { files: [] } });
    await settle();
    expect(document.body.textContent).not.toContain("Drop files or a folder to add them");
  });
});

describe("folder rows", () => {
  it("collapsing hides a folder's files; a new file created in a collapsed folder auto-expands it", async () => {
    await mountEditor({ name: "t", mainPath: "main.tex", files: { "main.tex": "x", "other/same.tex": "o" } });
    const folderRow = () => qa('aside li div.group[title="other"]').find((d) => d.querySelector('[data-kind="folder"]'));
    const fileRowsIn = () => qa('aside li div.group[title="other"]').filter((d) => !d.querySelector('[data-kind="folder"]'));
    expect(fileRowsIn()).toHaveLength(1);
    await click(folderRow()!);
    expect(folderRow()).toBeDefined();
    expect(fileRowsIn()).toHaveLength(0);
    expect(await newFile("newone.tex", "other")).toBe(true);
    expect(rowFor("newone.tex")).not.toBeNull();
    expect(fileRowsIn().length).toBeGreaterThan(0);
  });

  it("the status line is idle-ready and the engine was not involved in the import", async () => {
    FakeBusyTex.autoReady = false;
    await mountEditor();
    await pick("upload", [fakeFile("x.tex", "x")]);
    expect(FakeBusyTex.calls).toHaveLength(0);
    expect(statusText()).toBe("Ready.");
  });
});
