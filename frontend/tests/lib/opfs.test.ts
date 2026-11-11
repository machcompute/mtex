import { describe, expect, it } from "vitest";
import {
  PREVIEW_FILE,
  clearBuildCache,
  createProject,
  decodeText,
  decodeTextLenient,
  deleteProject,
  listProjects,
  loadBuildCache,
  loadBuildState,
  loadPreview,
  loadProject,
  saveBuildCache,
  saveBuildState,
  savePreview,
  saveProject,
  updateProjectMeta,
  walkFiles,
  type FileData,
  type ProjectMeta,
} from "@/lib/opfs";
import {
  existsPath,
  faultPlan,
  listDir,
  opfsRoot,
  readPath,
  readText,
  seedFile,
} from "../support/memfs";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("project layout (e2e: projects, folder, artifacts)", () => {
  it("keeps content in projects/<id>/ and settings in artifacts/<id>/", async () => {
    const id = await createProject(
      "Alpha",
      { "main.tex": "hello", "figs/a.png": bytes(137, 80, 78, 71) },
      { mainPath: "main.tex", openPaths: ["main.tex"], activePath: "main.tex" },
    );
    expect(listDir(`projects/${id}`)).toEqual(["figs", "main.tex"]);
    // the content folder never holds the meta (artifacts layout)
    expect(existsPath(`projects/${id}/project.json`)).toBe(false);
    const meta = JSON.parse(readText(`artifacts/${id}/project.json`)!);
    expect(meta).toMatchObject({ v: 1, name: "Alpha", mainPath: "main.tex" });
  });

  it("round-trips nested paths and binary bytes byte-for-byte", async () => {
    const png = bytes(137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 254);
    const id = await createProject("P", { "paper/figs/logo.png": png, "a.tex": "x" });
    const { files } = await loadProject(id);
    expect(files["a.tex"]).toBe("x");
    expect(Array.from(files["paper/figs/logo.png"] as Uint8Array)).toEqual(Array.from(png));
  });

  it("keeps non-UTF-8 bytes raw instead of mangling them (fixes #15)", async () => {
    const latin1 = bytes(0x63, 0x61, 0x66, 0xe9); // "café" in latin-1: invalid UTF-8
    const id = await createProject("P", { "old.sty": latin1, "ok.tex": "café" });
    const { files } = await loadProject(id);
    expect(files["old.sty"]).toBeInstanceOf(Uint8Array);
    expect(Array.from(files["old.sty"] as Uint8Array)).toEqual(Array.from(latin1));
    expect(files["ok.tex"]).toBe("café");
  });

  it("lists projects newest-updated first with their ids", async () => {
    const a = await createProject("A", { "a.tex": "" });
    const b = await createProject("B", { "b.tex": "" });
    await updateProjectMeta(a, { name: "A2" }); // bumps updatedAt past B's
    const list = await listProjects();
    expect(list.map((p) => p.id)).toEqual([a, b]);
    expect(list[0].name).toBe("A2");
  });

  it("walkFiles skips project.json and preview.png (artifacts, not content)", async () => {
    seedFile("root/main.tex", "x");
    seedFile("root/project.json", "{}");
    seedFile("root/preview.png", bytes(1));
    seedFile("root/sub/project.json", "{}");
    seedFile("root/sub/keep.txt", "k");
    const dir = await opfsRoot().getDirectoryHandle("root");
    const out = await walkFiles(dir as never);
    expect([...out.keys()].sort()).toEqual(["main.tex", "sub/keep.txt"]);
  });

  it("persists a project rename in the meta", async () => {
    const id = await createProject("Old", { "a.tex": "" });
    await updateProjectMeta(id, { name: "Renamed proj" });
    expect(JSON.parse(readText(`artifacts/${id}/project.json`)!).name).toBe("Renamed proj");
    expect((await loadProject(id)).meta.name).toBe("Renamed proj");
  });

  it("records the GitHub source in the meta", async () => {
    const source = { kind: "github" as const, owner: "testuser", repo: "latex-repo", branch: "main" };
    const id = await createProject("latex-repo", { "main.tex": "x" }, { source });
    expect((await loadProject(id)).meta.source).toEqual(source);
    await updateProjectMeta(id, { source: { ...source, branch: "dev" } });
    expect((await loadProject(id)).meta.source?.branch).toBe("dev");
  });

  it("loadProject throws for a missing project", async () => {
    await expect(loadProject("nope")).rejects.toThrow(/no readable meta/);
  });

  it("deleteProject removes content and artifacts, and is idempotent", async () => {
    const id = await createProject("P", { "a.tex": "x" });
    await savePreview(id, bytes(1, 2, 3));
    await deleteProject(id);
    expect(existsPath(`projects/${id}`)).toBe(false);
    expect(existsPath(`artifacts/${id}`)).toBe(false);
    await expect(deleteProject(id)).resolves.toBeUndefined();
    expect(await listProjects()).toEqual([]);
  });

  it("ignores directories with no readable meta when listing", async () => {
    await createProject("Real", { "a.tex": "" });
    seedFile("projects/orphan/a.tex", "x"); // no meta anywhere
    seedFile("projects/bad/project.json", "not json");
    expect((await listProjects()).map((p) => p.name)).toEqual(["Real"]);
  });
});

describe("saveProject is diff-based (e2e: fixes #11, projects)", () => {
  const baseMeta = (): ProjectMeta => ({
    v: 1,
    name: "P",
    mainPath: "a.tex",
    openPaths: ["a.tex"],
    activePath: "a.tex",
    createdAt: 1,
    updatedAt: 1,
  });

  it("writes only changed refs, deletes removed paths, refreshes updatedAt", async () => {
    const same: FileData = "unchanged";
    const id = await createProject("P", { "a.tex": same, "gone.tex": "bye", "d/x.tex": "x" });
    const saved = new Map<string, FileData>(Object.entries((await loadProject(id)).files));
    const files: Record<string, FileData> = { "a.tex": saved.get("a.tex")!, "new.tex": "n", "d/x.tex": "x2" };
    await saveProject(id, baseMeta(), files, saved);
    expect(readText(`projects/${id}/new.tex`)).toBe("n");
    expect(readText(`projects/${id}/d/x.tex`)).toBe("x2");
    expect(existsPath(`projects/${id}/gone.tex`)).toBe(false);
    expect(readText(`projects/${id}/a.tex`)).toBe("unchanged");
    expect(JSON.parse(readText(`artifacts/${id}/project.json`)!).updatedAt).toBeGreaterThan(1);
  });

  it("an unchanged ref is not rewritten", async () => {
    const id = await createProject("P", { "a.tex": "orig" });
    const data = "orig";
    // The caller says it last persisted this exact ref; tamper with the store
    // to prove saveProject does not touch it.
    seedFile(`projects/${id}/a.tex`, "tampered");
    await saveProject(id, baseMeta(), { "a.tex": data }, new Map([["a.tex", data]]));
    expect(readText(`projects/${id}/a.tex`)).toBe("tampered");
  });

  it("rejects when storage fails (the page turns this into a notice)", async () => {
    const id = await createProject("P", { "a.tex": "x" });
    faultPlan().failWrites = true;
    await expect(
      saveProject(id, baseMeta(), { "a.tex": "changed" }, new Map([["a.tex", "x"]])),
    ).rejects.toThrow();
  });
});

describe("old-layout migration (e2e: artifacts.cjs)", () => {
  const meta = JSON.stringify({
    v: 1,
    name: "Old layout",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    createdAt: 5,
    updatedAt: 5,
  });

  it("moves project.json and preview.png into artifacts/<id>/, idempotently", async () => {
    seedFile("projects/old1/main.tex", "content");
    seedFile("projects/old1/project.json", meta);
    seedFile("projects/old1/preview.png", bytes(9, 9, 9));
    expect(existsPath("artifacts")).toBe(false);

    const list = await listProjects();
    expect(list.map((p) => p.name)).toEqual(["Old layout"]);
    // meta migrated by the listing itself
    expect(existsPath("artifacts/old1/project.json")).toBe(true);
    expect(existsPath("projects/old1/project.json")).toBe(false);

    // the preview migrates on first read
    expect(Array.from((await loadPreview("old1"))!)).toEqual([9, 9, 9]);
    expect(existsPath("artifacts/old1/preview.png")).toBe(true);
    expect(existsPath("projects/old1/preview.png")).toBe(false);

    // content untouched
    expect(readText("projects/old1/main.tex")).toBe("content");

    // idempotent on a second pass
    const again = await listProjects();
    expect(again).toHaveLength(1);
    expect(Array.from((await loadPreview("old1"))!)).toEqual([9, 9, 9]);
    expect(listDir("projects/old1")).toEqual(["main.tex"]);
  });

  it("loadProject of an old-layout project migrates and hides the artifacts", async () => {
    seedFile("projects/old2/main.tex", "c");
    seedFile("projects/old2/project.json", meta);
    seedFile("projects/old2/preview.png", bytes(1));
    const { files } = await loadProject("old2");
    expect(Object.keys(files)).toEqual(["main.tex"]); // preview.png is not content
  });

  it("a project that never compiled has no preview", async () => {
    const id = await createProject("P", { "a.tex": "" });
    expect(await loadPreview(id)).toBeNull();
  });

  it("savePreview writes into artifacts/<id>/ (dashboard compiled → preview shown)", async () => {
    const id = await createProject("P", { "a.tex": "" });
    await savePreview(id, bytes(7, 7));
    expect(existsPath(`artifacts/${id}/${PREVIEW_FILE}`)).toBe(true);
    expect(existsPath(`projects/${id}/${PREVIEW_FILE}`)).toBe(false);
    expect(Array.from((await loadPreview(id))!)).toEqual([7, 7]);
  });
});

describe("incremental-build state (e2e: incremental.cjs S1/S2)", () => {
  it("round-trips aux/bcf/bbl and the .bib hashes, keyed by main path", async () => {
    const id = await createProject("P", { "main.tex": "" });
    expect(await loadBuildState(id, "main.tex")).toBeNull(); // never built
    await saveBuildState(id, "main.tex", {
      aux: bytes(1),
      bcf: bytes(2),
      bbl: bytes(3),
      bibHashes: { "refs.bib": "abc" },
    });
    expect(listDir(`artifacts/${id}/build`).sort()).toEqual(
      ["bib-hashes.json", "main.aux", "main.bbl", "main.bcf"].sort(),
    );
    const st = (await loadBuildState(id, "main.tex"))!;
    expect(Array.from(st.aux!)).toEqual([1]);
    expect(Array.from(st.bcf!)).toEqual([2]);
    expect(Array.from(st.bbl!)).toEqual([3]);
    expect(st.bibHashes).toEqual({ "refs.bib": "abc" });
    // a renamed main file has no state
    expect(await loadBuildState(id, "other.tex")).toBeNull();
  });

  it("an absent entry deletes its old file (bibtex8 build drops the .bcf)", async () => {
    const id = await createProject("P", { "main.tex": "" });
    await saveBuildState(id, "main.tex", { aux: bytes(1), bcf: bytes(2), bbl: bytes(3), bibHashes: {} });
    await saveBuildState(id, "main.tex", { aux: bytes(1), bcf: null, bbl: bytes(3), bibHashes: { "r.bib": "h" } });
    expect(existsPath(`artifacts/${id}/build/main.bcf`)).toBe(false);
    expect((await loadBuildState(id, "main.tex"))!.bcf).toBeNull();
  });

  it("tolerates a corrupt bib-hashes.json", async () => {
    const id = await createProject("P", { "main.tex": "" });
    await saveBuildState(id, "main.tex", { aux: bytes(1), bcf: null, bbl: null, bibHashes: {} });
    seedFile(`artifacts/${id}/build/bib-hashes.json`, "{{{");
    expect((await loadBuildState(id, "main.tex"))!.bibHashes).toEqual({});
  });
});

describe("build cache (e2e: incremental.cjs part A)", () => {
  const entry = (n: number) => ({ pdf: bytes(n, n), log: `log ${n}`, synctex: bytes(n) });

  it("returns the cached output for a hash, null on a miss", async () => {
    const id = await createProject("P", { "main.tex": "" });
    expect(await loadBuildCache(id, "h1")).toBeNull();
    await saveBuildCache(id, "h1", entry(1));
    const hit = (await loadBuildCache(id, "h1"))!;
    expect(Array.from(hit.pdf)).toEqual([1, 1]);
    expect(hit.log).toBe("log 1");
    expect(Array.from(hit.synctex!)).toEqual([1]);
    expect(await loadBuildCache(id, "h2")).toBeNull();
  });

  it("keeps one entry per distinct input set", async () => {
    const id = await createProject("P", { "main.tex": "" });
    await saveBuildCache(id, "h1", entry(1));
    await saveBuildCache(id, "h2", entry(2));
    await saveBuildCache(id, "h1", entry(1));
    const pdfs = listDir(`artifacts/${id}/build/cache`).filter((n) => n.endsWith(".pdf"));
    expect(pdfs).toEqual(["h1.pdf", "h2.pdf"]);
  });

  it("evicts beyond the newest 8", async () => {
    const id = await createProject("P", { "main.tex": "" });
    for (let i = 1; i <= 10; i++) await saveBuildCache(id, `h${i}`, entry(i));
    expect(await loadBuildCache(id, "h1")).toBeNull();
    expect(await loadBuildCache(id, "h2")).toBeNull();
    expect(await loadBuildCache(id, "h3")).not.toBeNull();
    expect(await loadBuildCache(id, "h10")).not.toBeNull();
    const idx = JSON.parse(readText(`artifacts/${id}/build/cache/index.json`)!);
    expect(idx).toHaveLength(8);
    expect(idx[0]).toBe("h10");
  });

  it("omits an empty synctex and rebuilds from a corrupt index", async () => {
    const id = await createProject("P", { "main.tex": "" });
    await saveBuildCache(id, "h1", { pdf: bytes(1), log: "", synctex: null });
    expect((await loadBuildCache(id, "h1"))!.synctex).toBeNull();
    seedFile(`artifacts/${id}/build/cache/index.json`, "nope");
    await saveBuildCache(id, "h2", entry(2));
    expect(JSON.parse(readText(`artifacts/${id}/build/cache/index.json`)!)).toEqual(["h2"]);
  });

  it("clearBuildCache drops the cache but keeps the build state", async () => {
    const id = await createProject("P", { "main.tex": "" });
    await saveBuildState(id, "main.tex", { aux: bytes(1), bcf: null, bbl: null, bibHashes: {} });
    await saveBuildCache(id, "h1", entry(1));
    await clearBuildCache(id);
    expect(await loadBuildCache(id, "h1")).toBeNull();
    expect(await loadBuildState(id, "main.tex")).not.toBeNull();
    await expect(clearBuildCache("missing")).resolves.toBeUndefined();
  });

  it("ignores a zero-length cached PDF", async () => {
    const id = await createProject("P", { "main.tex": "" });
    await saveBuildCache(id, "h1", { pdf: new Uint8Array(0), log: "", synctex: null });
    expect(await loadBuildCache(id, "h1")).toBeNull();
    expect(readPath(`artifacts/${id}/build/cache/h1.pdf`)).not.toBeNull();
  });
});

describe("text decoding", () => {
  it("decodeText is strict, decodeTextLenient substitutes", () => {
    expect(decodeText(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(decodeText(bytes(0xff, 0xfe))).toBeNull();
    expect(decodeTextLenient(bytes(0x61, 0xe9))).toBe("a�");
  });
});
