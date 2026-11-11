// Projects: the dashboard (src/app/page.tsx) and the editor's load/persist cycle
// (e2e: projects.cjs, dashboard.cjs, artifacts.cjs, fixes #11 #21, mount-restore).
import { StrictMode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_PROJECT_KEY, createProject, listProjects, loadProject, savePreview } from "@/lib/opfs";
import { DEFAULT_FILES } from "@/lib/defaults";
import { FakeBusyTex } from "../support/fake-busytex";
import { click, openFile, q, qa, rail, typeInEditor } from "../support/page-actions";
import { advance, fileRows, mountEditor, noticeText, projectNameValue, railActive, seedProject, settle, stored } from "../support/page-utils";
import { existsPath, faultPlan, gateOpfs, listDir, readText, seedFile } from "../support/memfs";
import { routerPush } from "../support/page-setup";

beforeEach(() => {
  FakeBusyTex.autoReady = false;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
});

async function mountDashboard() {
  if (!vi.isFakeTimers()) vi.useFakeTimers();
  const { default: Home } = await import("@/app/page");
  const utils = render(<Home />);
  await settle();
  return utils;
}
const cards = () => qa("main .group\\/card");
const cardTitles = () => qa("main .group\\/card p.truncate").map((p) => p.textContent);
const cardOf = (name: string) => cards().find((c) => c.textContent?.includes(name))!;
const hasPreview = (name: string) => (cardOf(name).querySelector("[style*='background-image']") ? "preview" : "placeholder");

describe("dashboard (e2e dashboard.cjs)", () => {
  it("lists a card per project with its title; uncompiled projects show the placeholder", async () => {
    await createProject("Alpha doc", { "main.tex": "a" });
    await createProject("Beta doc", { "main.tex": "b" });
    await createProject("Gamma doc", { "main.tex": "c" });
    await mountDashboard();
    expect(cards()).toHaveLength(3);
    expect(cardTitles().sort()).toEqual(["Alpha doc", "Beta doc", "Gamma doc"]);
    expect(hasPreview("Alpha doc")).toBe("placeholder");
    expect(hasPreview("Beta doc")).toBe("placeholder");
  });

  it("a compiled project's preview.png shows on its card; the others stay placeholders", async () => {
    await createProject("Alpha doc", { "main.tex": "a" });
    const beta = await createProject("Beta doc", { "main.tex": "b" });
    await savePreview(beta, new Uint8Array([137, 80, 78, 71]));
    await mountDashboard();
    expect(hasPreview("Beta doc")).toBe("preview");
    expect(hasPreview("Alpha doc")).toBe("placeholder");
  });

  it("an old-layout project (meta + preview inside projects/<id>/) is migrated and its thumbnail shown (artifacts.cjs)", async () => {
    seedFile("projects/old/main.tex", "content");
    seedFile("projects/old/project.json", JSON.stringify({ v: 1, name: "Old layout", mainPath: "main.tex", openPaths: [], activePath: "", createdAt: 1, updatedAt: 1 }));
    seedFile("projects/old/preview.png", new Uint8Array([137, 80, 78, 71]));
    await mountDashboard();
    expect(hasPreview("Old layout")).toBe("preview");
    expect(existsPath("artifacts/old/project.json")).toBe(true);
    expect(existsPath("artifacts/old/preview.png")).toBe(true);
    expect(existsPath("projects/old/project.json")).toBe(false);
    expect(existsPath("projects/old/preview.png")).toBe(false);
    expect(listDir("projects/old")).toEqual(["main.tex"]);
  });

  it("opening a card points the editor at it and navigates", async () => {
    const a = await createProject("Alpha doc", { "main.tex": "a" });
    await mountDashboard();
    await click(cardOf("Alpha doc").querySelector('button[title^="Open"]'));
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe(a);
    expect(routerPush).toHaveBeenCalledWith("/editor");
  });

  it("New project creates a default-content project with the next free numbered name and opens it", async () => {
    await createProject("LaTeX project", { "main.tex": "a" });
    await mountDashboard();
    await click(qa("header button").find((b) => b.textContent?.includes("New project")) ?? null);
    const list = await listProjects();
    expect(list.map((p) => p.name).sort()).toEqual(["LaTeX project", "LaTeX project 2"]);
    const fresh = list.find((p) => p.name === "LaTeX project 2")!;
    expect((await loadProject(fresh.id)).files).toEqual(DEFAULT_FILES);
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe(fresh.id);
    expect(routerPush).toHaveBeenCalledWith("/editor");
  });

  it("delete asks for confirmation naming the project, then removes content and artifacts", async () => {
    const a = await createProject("Alpha doc", { "main.tex": "a" });
    await createProject("Beta doc", { "main.tex": "b" });
    await savePreview(a, new Uint8Array([1]));
    await mountDashboard();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(cardOf("Alpha doc").querySelector('button[title="Delete Alpha doc"]'));
    expect(confirm).toHaveBeenCalledWith("Delete “Alpha doc” and all its files?");
    expect(cards()).toHaveLength(2); // declined: nothing happens
    confirm.mockReturnValue(true);
    await click(cardOf("Alpha doc").querySelector('button[title="Delete Alpha doc"]'));
    expect(cardTitles()).toEqual(["Beta doc"]);
    expect(existsPath(`projects/${a}`)).toBe(false);
    expect(existsPath(`artifacts/${a}`)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("delete-to-empty: the dashboard shows its empty state and storage is empty", async () => {
    await createProject("Only", { "main.tex": "a" });
    await mountDashboard();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(cardOf("Only").querySelector('button[title="Delete Only"]'));
    expect(document.body.textContent).toContain("No projects yet — create one to get started.");
    expect(await listProjects()).toEqual([]);
  });

  it("reports unreadable storage instead of hanging on the skeleton", async () => {
    faultPlan().failRoot = true;
    await mountDashboard();
    expect(document.body.textContent).toContain("Couldn't read your projects from browser storage");
  });

  it.each([
    [0, "just now"],
    [5 * 60_000, "5 min ago"],
    [60 * 60_000, "1 hr ago"],
    [3 * 3_600_000, "3 hrs ago"],
    [2 * 86_400_000, "2 days ago"],
  ])("labels a project last updated %i ms ago as %s", async (age, label) => {
    vi.useFakeTimers();
    await createProject("Aged", { "main.tex": "a" });
    vi.advanceTimersByTime(age);
    await mountDashboard();
    expect(cardOf("Aged").textContent).toContain(label);
  });
});

describe("editor project load and persistence (projects.cjs)", () => {
  it("first run: the default project is created, named, filled and listed once", async () => {
    await mountEditor();
    expect(projectNameValue()).toBe("LaTeX project");
    expect(fileRows().sort()).toEqual(["main.tex", "refs.bib"]);
    const list = await listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("LaTeX project");
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe(list[0].id);
  });

  it("StrictMode's double mount still creates exactly one default project (no orphan folder)", async () => {
    vi.useFakeTimers();
    const { default: EditorPage } = await import("@/app/editor/page");
    render(
      <StrictMode>
        <EditorPage />
      </StrictMode>,
    );
    await settle();
    expect(await listProjects()).toHaveLength(1);
    expect(listDir("projects")).toHaveLength(1);
  });

  it("opens the project named by the active-project key and shows its own content; a stale key falls back to the newest", async () => {
    const a = await createProject("A", { "main.tex": "AAA" }, { mainPath: "main.tex", openPaths: ["main.tex"], activePath: "main.tex" });
    await new Promise((r) => r(0));
    const b = await createProject("B", { "main.tex": "BBB", "extra.tex": "E" }, { mainPath: "main.tex", openPaths: ["main.tex"], activePath: "main.tex" });
    localStorage.setItem(ACTIVE_PROJECT_KEY, a);
    const first = await mountEditor();
    expect(projectNameValue()).toBe("A");
    first.unmount();
    localStorage.setItem(ACTIVE_PROJECT_KEY, b);
    const second = await mountEditor();
    expect(projectNameValue()).toBe("B");
    expect(fileRows().sort()).toEqual(["extra.tex", "main.tex"]);
    second.unmount();
    localStorage.setItem(ACTIVE_PROJECT_KEY, "does-not-exist");
    await mountEditor();
    expect(["A", "B"]).toContain(projectNameValue());
  });

  it("a project switch shows the incoming project, persists the outgoing edit and the marker survives", async () => {
    const a = await seedProject({ name: "A", files: { "main.tex": "AAA" } });
    const first = await mountEditor();
    await typeInEditor("AAA MARKER");
    await advance(700);
    expect((await stored(a)).files["main.tex"]).toBe("AAA MARKER");
    first.unmount();
    const b = await createProject("B", { "main.tex": "BBB" }, { mainPath: "main.tex", openPaths: ["main.tex"], activePath: "main.tex" });
    localStorage.setItem(ACTIVE_PROJECT_KEY, b);
    const second = await mountEditor();
    expect(projectNameValue()).toBe("B");
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).toBe("BBB");
    second.unmount();
    localStorage.setItem(ACTIVE_PROJECT_KEY, a);
    await mountEditor();
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).toBe("AAA MARKER"); // switch back: the marker survived
  });

  it("renaming the project is persisted (meta.name) and restored after a reload", async () => {
    const { id, unmount } = await mountEditor();
    const input = q<HTMLInputElement>('aside input[title^="Project name"]')!;
    fireEvent.change(input, { target: { value: "Renamed proj" } });
    await advance(700);
    expect(JSON.parse(readText(`artifacts/${id}/project.json`)!).name).toBe("Renamed proj");
    unmount();
    await mountEditor();
    expect(projectNameValue()).toBe("Renamed proj");
  });

  it("persists tab state (open tabs, active tab, main) into the meta, debounced", async () => {
    const { id } = await mountEditor({ name: "t", mainPath: "main.tex", openPaths: ["main.tex"], files: { "main.tex": "m", "b.tex": "b" } });
    await openFile("b.tex");
    expect(JSON.parse(readText(`artifacts/${id}/project.json`)!).activePath).toBe("main.tex"); // not yet: 600 ms debounce
    await advance(700);
    const meta = JSON.parse(readText(`artifacts/${id}/project.json`)!);
    expect(meta).toMatchObject({ mainPath: "main.tex", openPaths: ["main.tex", "b.tex"], activePath: "b.tex" });
    expect(meta.updatedAt).toBeGreaterThanOrEqual(meta.createdAt);
  });

  it("the save indicator reads Saving… while a save is pending and Saved at rest", async () => {
    await mountEditor();
    await advance(700);
    expect(q("[data-save-state]")!.getAttribute("data-save-state")).toBe("saved");
    await typeInEditor("x");
    expect(q("[data-save-state]")!.textContent).toContain("Saved");
  });

  it("the open-time compile of a seeded project uses the loaded files, and the cache dir never leaks into the file list", async () => {
    FakeBusyTex.autoReady = true;
    const { id } = await mountEditor({ name: "t", mainPath: "main.tex", files: { "main.tex": "x" } });
    await advance(10);
    expect(FakeBusyTex.calls[0].files).toEqual({ "main.tex": "x" });
    expect(fileRows()).toEqual(["main.tex"]); // preview.png / build/ live in artifacts/, not content
    expect(existsPath(`projects/${id}/build`)).toBe(false);
  });
});

describe("storage trouble (#11)", () => {
  it("a failing save raises ONE notice per failure run, and a later success resets it", async () => {
    await mountEditor({ name: "t", files: { "main.tex": "a" } });
    await advance(700);
    faultPlan().failWrites = true;
    await typeInEditor("b");
    await advance(700);
    expect(noticeText()).toBe("Storage unavailable — changes are not being saved");
    await advance(9000); // the pill times out
    expect(noticeText()).toBe("");
    await typeInEditor("c");
    await advance(700);
    expect(noticeText()).toBe(""); // not re-raised while the same failure run continues
    faultPlan().failWrites = false;
    await typeInEditor("d");
    await advance(700);
    faultPlan().failWrites = true;
    await typeInEditor("e");
    await advance(700);
    expect(noticeText()).toBe("Storage unavailable — changes are not being saved");
  });

  it("OPFS unavailable at load: the session still works in memory and says so", async () => {
    faultPlan().failRoot = true;
    await mountEditor();
    expect(noticeText()).toBe("Storage unavailable — changes are not being saved");
    expect(fileRows().sort()).toEqual(["main.tex", "refs.bib"]); // defaults render in memory
    await typeInEditor("typed anyway");
    expect((q("[data-testid=monaco]") as HTMLTextAreaElement).value).toBe("typed anyway");
  });
});

describe("a late mount restore does not yank the pane the user picked (050d3a6)", () => {
  it("picking Chat while OPFS is still loading keeps Chat after the restore lands", async () => {
    const release = gateOpfs();
    vi.useFakeTimers();
    const { default: EditorPage } = await import("@/app/editor/page");
    render(<EditorPage />);
    await settle();
    await rail("chat");
    expect(railActive()).toEqual(["chat"]);
    release();
    await settle();
    expect(projectNameValue()).toBe(""); // the files pane is not shown — chat stays
    expect(railActive()).toEqual(["chat"]);
    await rail("files");
    expect(projectNameValue()).toBe("LaTeX project"); // the restore did land
  });
});
