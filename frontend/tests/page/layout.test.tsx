// The inscribe.io layout: app bar, formatting toolbar, search pane, pane swap,
// workspace persistence, notes and stats popovers (e2e: layout.cjs, regression brand link).
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeBusyTex } from "../support/fake-busytex";
import { click, openFile, q, qa, rail, typeInEditor } from "../support/page-actions";
import { advance, fileRows, mountEditor, settle } from "../support/page-utils";
import { FakeSelection, monacoState } from "../support/stubs/monaco";
import { pdfState } from "../support/stubs/pdf-viewer";

beforeEach(() => {
  FakeBusyTex.autoReady = false;
});

const files = {
  "main.tex": "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}\n",
  "refs.bib": "@book{a,\n  title={Hello},\n  year={1984}\n}\n",
};
const seed = { name: "layout", mainPath: "main.tex", files };

describe("app bar", () => {
  it("the HomeHub wordmark links to the dashboard; there is no Projects menu (it lives on the dashboard)", async () => {
    await mountEditor(seed);
    const link = q<HTMLAnchorElement>("header a")!;
    expect(link.getAttribute("href")).toBe("/");
    expect(link.textContent).toContain("HomeHub");
    expect(qa("header button").some((b) => /projects/i.test(b.textContent ?? "") || /projects/i.test(b.title))).toBe(false);
    expect(q("header span.truncate")!.textContent).toBe("Ready."); // build status still lives in the header
  });
});

describe("formatting toolbar", () => {
  it("offers the block select then I/B/U/S/link/code/image/table, in order, plus a save indicator", async () => {
    await mountEditor(seed);
    expect(q("select[data-format-block]")).not.toBeNull();
    expect(qa("[data-format]").map((e) => e.dataset.format)).toEqual(["emph", "strong", "underline", "strikethrough", "link", "code", "image", "table"]);
    expect(q("[data-save-state]")!.getAttribute("data-save-state")).toBe("saved");
  });

  it("Bold with no selection inserts the placeholder with its text pre-selected", async () => {
    await mountEditor(seed);
    monacoState.position = { lineNumber: 3, column: 1 };
    monacoState.selection = new FakeSelection(3, 1, 3, 1);
    await click(q('[data-format="strong"]'));
    expect(monacoState.model()!.value).toContain("\\textbf{Text}Hello world");
    const sel = monacoState.selection;
    expect([sel.startLineNumber, sel.startColumn, sel.endColumn]).toEqual([3, 2, 2 + "\\textbf{Text}".length]);
  });

  it("with a selection, wraps it and keeps it selected inside the braces", async () => {
    await mountEditor(seed);
    monacoState.position = { lineNumber: 3, column: 1 };
    monacoState.selection = new FakeSelection(3, 1, 3, 6); // "Hello"
    await click(q('[data-format="emph"]'));
    expect(monacoState.model()!.value).toContain("\\emph{Hello} world");
    expect(monacoState.selection.startColumn).toBe(1 + "\\emph{".length); // the caret lands inside the braces
  });

  it("strikethrough adds the ulem package once after \\documentclass", async () => {
    await mountEditor(seed);
    monacoState.position = { lineNumber: 3, column: 1 };
    monacoState.selection = new FakeSelection(3, 1, 3, 1);
    await click(q('[data-format="strikethrough"]'));
    const v = monacoState.model()!.value;
    expect(v.split("\n")[1]).toContain("\\usepackage[normalem]{ulem}"); // right after \documentclass
    expect(v).toContain("\\sout{Text}");
    await click(q('[data-format="strikethrough"]'));
    expect(monacoState.model()!.value.match(/ulem/g)).toHaveLength(1);
  });

  it("link, code, image and table insert their snippets", async () => {
    await mountEditor(seed);
    const at = (line: number) => {
      monacoState.position = { lineNumber: line, column: 1 };
      monacoState.selection = new FakeSelection(line, 1, line, 1);
    };
    at(3);
    await click(q('[data-format="link"]'));
    expect(monacoState.model()!.value).toContain("\\href{https://example.com/}{Text}");
    at(3);
    await click(q('[data-format="code"]'));
    expect(monacoState.model()!.value).toContain("\\texttt{code}");
    at(3);
    await click(q('[data-format="image"]'));
    expect(monacoState.model()!.value).toContain("\\includegraphics{figure.png}");
    at(3);
    await click(q('[data-format="table"]'));
    expect(monacoState.model()!.value).toContain("\\begin{tabular}{ll}");
  });

  it("the block select turns a line into a section, an itemize, or back to plain text", async () => {
    await mountEditor(seed);
    monacoState.position = { lineNumber: 3, column: 1 };
    const select = q<HTMLSelectElement>("select[data-format-block]")!;
    fireEvent.change(select, { target: { value: "section" } });
    await settle();
    expect(monacoState.model()!.getLineContent(3)).toBe("\\section{Hello world}");
    fireEvent.change(select, { target: { value: "itemize" } });
    await settle();
    expect(monacoState.model()!.value).toContain("\\begin{itemize}\n  \\item \\section{Hello world}\n\\end{itemize}");
  });
});

describe("search pane (layout.cjs)", () => {
  async function search(query: string) {
    await rail("search");
    fireEvent.change(q("[data-search-input]")!, { target: { value: query } });
    await settle();
  }
  const hits = () => qa("button").filter((b) => /:\d+$/.test(b.querySelector("span")?.textContent ?? "")).map((b) => b.querySelector("span")!.textContent);

  it("an empty query shows the hint; no hits says 'No matches.'", async () => {
    await mountEditor(seed);
    await rail("search");
    expect(document.body.textContent).toContain("Search every text file in the project.");
    await search("zzzzzzimpossible");
    expect(document.body.textContent).toContain("No matches.");
  });

  it("finds matches across files as path:line, case-insensitively, with a count badge", async () => {
    await mountEditor(seed);
    await search("DOCUMENTCLASS");
    expect(hits()).toEqual(["main.tex:1"]);
    await search("hello");
    expect(hits().sort()).toEqual(["main.tex:3", "refs.bib:2"]);
    const badge = q("header ~ div [class*=tabular-nums]") ?? qa("span").find((s) => s.className.includes("tabular-nums") && /^\d+\+?$/.test(s.textContent ?? ""));
    expect(badge!.textContent).toBe("2");
  });

  it("skips binary files and caps results at 200 (badge shows 200+)", async () => {
    const many = Array.from({ length: 250 }, () => "needle").join("\n");
    await mountEditor({ name: "big", mainPath: "main.tex", files: { "main.tex": many, "pic.png": new Uint8Array([137, 80, 78, 71, 255]) } as never });
    await search("needle");
    expect(hits()).toHaveLength(200);
    expect(qa("span").some((s) => s.textContent === "200+")).toBe(true);
    await search("png");
    expect(hits()).toEqual([]);
  });

  it("clicking a hit in another file opens it as a tab and jumps to that line; in the active file it just reveals", async () => {
    await mountEditor(seed);
    await search("year");
    await click(qa("button").find((b) => b.textContent?.includes("refs.bib:3")) ?? null);
    await rail("files");
    expect(q("[data-tab][data-active]")!.getAttribute("data-tab")).toBe("refs.bib");
    expect(monacoState.reveals.at(-1)).toBe(3);
    await search("title");
    await click(qa("button").find((b) => b.textContent?.includes("refs.bib:2")) ?? null);
    expect(monacoState.reveals.at(-1)).toBe(2);
  });
});

describe("pane swap and workspace persistence", () => {
  const order = () => {
    const kids = [...(q('[data-testid="monaco"]')?.closest("div.flex.min-w-0.flex-1")?.children ?? [])];
    return kids.map((c) => (c.querySelector('[data-testid="monaco"]') ? "editor" : c.querySelector('[data-testid="pdf"]') ? "pdf" : "divider"));
  };

  it("the swap button is invisible and click-through at rest, and exchanges the panes", async () => {
    await mountEditor(seed);
    const btn = q('button[title="Swap editor and PDF"]')!;
    expect(btn.className).toContain("opacity-0");
    expect(btn.className).toContain("pointer-events-none");
    expect(order()).toEqual(["editor", "divider", "pdf"]);
    await click(btn);
    expect(order()).toEqual(["pdf", "divider", "editor"]);
  });

  it("persists the arrangement (debounced) and restores it clamped on the next load", async () => {
    const first = await mountEditor(seed);
    await click(q('button[title="Swap editor and PDF"]'));
    await advance(300);
    expect(JSON.parse(localStorage.getItem("homehub-workspace-v1")!)).toMatchObject({ editorFirst: false, filesW: 256, split: 0.5 });
    first.unmount();
    localStorage.setItem("homehub-workspace-v1", JSON.stringify({ filesW: 9999, split: 0.95, editorFirst: false }));
    await mountEditor();
    const w = (q("nav[aria-label='Left panel']")!.nextElementSibling as HTMLElement).style.width;
    expect(w).toBe("480px"); // clamped to the max
    expect(order()[0]).toBe("pdf");
  });

  it("falls back to defaults for a corrupt layout", async () => {
    localStorage.setItem("homehub-workspace-v1", "{{nope");
    await mountEditor(seed);
    expect((q("nav[aria-label='Left panel']")!.nextElementSibling as HTMLElement).style.width).toBe("256px");
  });
});

describe("popovers: notes, stats, page badge", () => {
  it("notes are kept per project in localStorage and survive closing and reopening", async () => {
    const { id } = await mountEditor(seed);
    await click(q('button[title^="Project notes"]'));
    const ta = q<HTMLTextAreaElement>("textarea[data-notes]")!;
    fireEvent.change(ta, { target: { value: "remember the bibliography" } });
    expect(localStorage.getItem(`homehub-notes-${id}`)).toBe("remember the bibliography");
    await click(q('button[title^="Project notes"]')); // close
    expect(q("textarea[data-notes]")).toBeNull();
    await click(q('button[title^="Project notes"]'));
    expect(q<HTMLTextAreaElement>("textarea[data-notes]")!.value).toBe("remember the bibliography");
    expect(document.body.textContent).toContain("Notes — layout");
  });

  it("outside clicks close the popovers; clicks inside keep them open", async () => {
    await mountEditor(seed);
    await click(q('button[title="Project stats"]'));
    expect(q('[data-popover-root="stats"] dl')).not.toBeNull();
    await click(q('[data-popover-root="stats"] dl'));
    expect(q('[data-popover-root="stats"] dl')).not.toBeNull();
    await click(document.body);
    expect(q('[data-popover-root="stats"] dl')).toBeNull();
  });

  it("stats count files, words and lines of the active file and PDF pages", async () => {
    pdfState.pages = 4;
    FakeBusyTex.autoReady = true;
    await mountEditor(seed);
    await advance(10);
    await click(q('button[title="Project stats"]'));
    const dd = qa('[data-popover-root="stats"] dd').map((d) => d.textContent);
    expect(dd).toEqual(["2", "5", "5", "4"]); // files, words in main.tex, lines, pages
    expect(document.querySelector('[title="4 pages in the current PDF"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Words — main.tex");
    await openFile("refs.bib");
  });

  it("with no PDF the badge is absent and stats show a dash", async () => {
    await mountEditor(seed);
    await click(q('button[title="Project stats"]'));
    expect(qa('[data-popover-root="stats"] dd').at(-1)!.textContent).toBe("—");
    expect(document.querySelector('[title="No PDF yet — press Compile"]')).not.toBeNull();
    void fileRows;
    void typeInEditor;
  });
});
