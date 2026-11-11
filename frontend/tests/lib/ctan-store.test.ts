import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTar } from "../support/tar-builder";
import { installCtanStub, simplePkg, sty, type CtanStub, type Pkg } from "../support/ctan-fixtures";
import { existsPath, listDir, readText, resetOpfs, seedFile } from "../support/memfs";

// xz is the only thing mocked inside the store: containers are plain tars in
// the fixtures, so the XZ stream is an identity pass-through.
vi.mock("xz-decompress", () => ({
  XzReadableStream: class {
    constructor(stream: ReadableStream<Uint8Array>) {
      return stream;
    }
  },
}));

type Store = typeof import("@/lib/ctan-store");
let store: Store;
let stub: CtanStub;

/** Fresh module state (the store caches the tlpdb and the op chain at module level). */
async function boot(pkgs: Pkg[], basic?: string[], keepStore = false): Promise<Store> {
  vi.resetModules();
  if (!keepStore) resetOpfs();
  stub = installCtanStub(pkgs, basic);
  store = await import("@/lib/ctan-store");
  return store;
}

const fixtureSet = (): Pkg[] => [
  // pgfplots requires pgf; pgf requires xcolor + pdfcolmk (transitive), tikz alias
  { name: "pgfplots", files: { "tex/latex/pgfplots/pgfplots.sty": sty("pgfplots", ["tikz", "xcolor"]) } },
  {
    name: "pgf",
    files: {
      "tex/latex/pgf/pgf.sty": sty("pgf", ["xcolor", "pdfcolmk"]),
      "tex/latex/pgf/frontendlayer/tikz.sty": "\\RequirePackage{pgf}\n", // no \ProvidesPackage
      // documentation/examples must not cascade installs
      "tex/latex/pgf/doc/pgf-doc.sty": "\\RequirePackage{pstricks}\n",
      "tex/latex/pgf/examples/ex.sty": "\\RequirePackage{biblatex}\n",
    },
  },
  simplePkg("xcolor"),
  simplePkg("pdfcolmk"),
  simplePkg("pstricks"),
  simplePkg("biblatex", ["logreq"]),
  simplePkg("logreq"),
  {
    // not valid UTF-8 (latin-1 byte) — requires must still be found
    name: "algorithm2e",
    files: {
      "tex/latex/algorithm2e/algorithm2e.sty": new Uint8Array([
        ...new TextEncoder().encode("\\ProvidesPackage{algorithm2e}\n% \\RequirePackage{commented}\n"),
        0xe9,
        ...new TextEncoder().encode("\n\\RequirePackage{ifoddpage}\n\\RequirePackage{relsize}\n"),
      ]),
    },
  },
  simplePkg("ifoddpage"),
  simplePkg("relsize"),
  simplePkg("fontspec"),
  { name: "bigfoot", files: { "tex/latex/bigfoot/perpage.sty": sty("perpage") } },
  simplePkg("footmisc", ["perpage"]),
  simplePkg("needsmissing", ["nosuchpackage-xyz"]),
  {
    name: "babel-portuges",
    files: { "tex/generic/babel-portuges/portuges.ldf": "\\ProvidesLanguage{portuges}\n" },
  },
  {
    name: "babel-french",
    files: { "tex/generic/babel-french/french.ldf": "x" },
  },
  {
    name: "misc-french",
    files: { "tex/generic/misc/french.ldf": "y" },
  },
  { name: "other-a", files: { "tex/latex/oa/shared.sty": "a" } },
  { name: "other-b", files: { "tex/latex/ob/shared.sty": "b" } },
];

beforeEach(async () => {
  await boot(fixtureSet(), ["article.cls", "amsmath.sty", "graphicx.sty", "ifthen.sty"]);
});

describe("package search (tlpdb metadata)", () => {
  it("ranks exact, prefix, substring, then description matches, with the installed flag", async () => {
    await store.installWithDependencies("pgf");
    const res = await store.searchPackages("pgf");
    expect(res.map((r) => r.name)).toEqual(["pgf", "pgfplots"]);
    expect(res[0].installed).toBe(true);
    expect(res[1].installed).toBe(false);
    const byDesc = await store.searchPackages("the pstricks package");
    expect(byDesc.map((r) => r.name)).toEqual(["pstricks"]);
    expect(await store.searchPackages("zzzzz")).toEqual([]);
    expect((await store.searchPackages("", 3)).length).toBe(3);
  });

  it("downloads the tlpdb once, through the same-origin proxy, then reads it from OPFS", async () => {
    await store.searchPackages("pgf");
    await store.searchPackages("xcolor");
    expect(stub.tlpdbHits).toBe(1);
    expect(stub.requests.every((u) => u.startsWith("/api/ctan/") || u.startsWith("/api/texlive/"))).toBe(true);
    expect(existsPath("ctan/texlive.tlpdb")).toBe(true);
    // a fresh page load finds the cached copy
    await boot(fixtureSet(), undefined, true);
    await store.searchPackages("pgf");
    expect(stub.tlpdbHits).toBe(0);
  });

  it("a failed tlpdb download is retried by the next call", async () => {
    stub.tlpdb = "";
    const real = globalThis.fetch;
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown, i?: RequestInit) => {
        if (first && String(u) === "/api/ctan/tlpdb") {
          first = false;
          return new Response(null, { status: 502 });
        }
        return real(u as string, i);
      }),
    );
    await boot(fixtureSet());
    const real2 = globalThis.fetch;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown, i?: RequestInit) => {
        if (n++ === 0 && String(u) === "/api/ctan/tlpdb") return new Response(null, { status: 502 });
        return real2(u as string, i);
      }),
    );
    await expect(store.searchPackages("pgf")).rejects.toThrow(/package database \(HTTP 502\)/);
    expect((await store.searchPackages("pgf")).length).toBeGreaterThan(0);
  });
});

describe("packageForFile (e2e babel-pt: which tlpkg ships portuguese.ldf)", () => {
  it("returns the sole owner, prefers babel-* among several, refuses to guess otherwise", async () => {
    expect(await store.packageForFile("portuges.ldf")).toBe("babel-portuges");
    expect(await store.packageForFile("PORTUGES.LDF")).toBe("babel-portuges"); // case-insensitive
    expect(await store.packageForFile("french.ldf")).toBe("babel-french"); // babel-* wins the tie
    expect(await store.packageForFile("shared.sty")).toBeNull(); // ambiguous, no babel owner
    expect(await store.packageForFile("nonexistent.ldf")).toBeNull();
  });
});

describe("install (e2e regression: package installs)", () => {
  it("lands the container in OPFS texmf-dist and records provides + files in the manifest", async () => {
    const res = await store.installWithDependencies("xcolor");
    expect(res.package.name).toBe("xcolor");
    expect(res.installedDependencies).toEqual([]);
    expect(readText("ctan/texmf-dist/tex/latex/xcolor/xcolor.sty")).toContain("ProvidesPackage{xcolor}");
    const m = JSON.parse(readText("ctan/manifest.json")!);
    expect(m.packages.xcolor.files).toEqual(["tex/latex/xcolor/xcolor.sty"]);
    expect(m.packages.xcolor.provides).toContain("xcolor");
    expect((await store.listPackages()).map((p) => p.name)).toEqual(["xcolor"]);
  });

  it("provides includes the file-name stem even without \\ProvidesPackage (tikz.sty)", async () => {
    await store.installWithDependencies("pgf");
    const [p] = (await store.listPackages()).filter((x) => x.name === "pgf");
    expect(p.provides).toEqual(expect.arrayContaining(["pgf", "tikz"]));
    expect(await store.remotePackageNames()).toEqual(expect.arrayContaining(["pgf", "tikz", "xcolor", "pdfcolmk"]));
  });

  it("rejects bad names, unknown packages and size/checksum mismatches", async () => {
    await expect(store.installWithDependencies("../etc")).rejects.toMatchObject({ status: 400 });
    await expect(store.installWithDependencies("Bad_Name")).rejects.toMatchObject({ status: 400 });
    await expect(store.installWithDependencies("nope")).rejects.toMatchObject({ status: 404 });
    await boot([{ ...simplePkg("sized"), badSize: true }, { ...simplePkg("summed"), badChecksum: true }]);
    await expect(store.installWithDependencies("sized")).rejects.toThrow(/size/);
    await expect(store.installWithDependencies("summed")).rejects.toThrow(/checksum/);
    expect(await store.listPackages()).toEqual([]);
  });

  it("reports a missing container (404) and a transient failure retried once", async () => {
    stub.failContainer.xcolor = 404;
    await expect(store.installWithDependencies("xcolor")).rejects.toMatchObject({ status: 404 });
    expect(stub.containerHits.xcolor).toBe(1); // a 404 is final

    delete stub.failContainer.xcolor;
    vi.useFakeTimers();
    stub.networkFailures = 1;
    const p = store.installWithDependencies("xcolor");
    await vi.advanceTimersByTimeAsync(2000); // the pause before the single retry
    await expect(p).resolves.toMatchObject({ package: { name: "xcolor" } });
    expect(stub.containerHits.xcolor).toBe(3);
  });

  it("rejects a container with no files", async () => {
    await boot([{ name: "empty", files: {} }]);
    await expect(store.installWithDependencies("empty")).rejects.toThrow(/no files in the empty container/);
  });
});

describe("install with dependencies (transitive)", () => {
  it("pgfplots pulls in pgf, and pgf's xcolor + pdfcolmk — but not doc/example references", async () => {
    const res = await store.installWithDependencies("pgfplots");
    expect(res.package.name).toBe("pgfplots");
    expect(res.installedDependencies.sort()).toEqual(["pdfcolmk", "pgf", "xcolor"]);
    expect(res.unresolved).toEqual([]);
    const names = (await store.listPackages()).map((p) => p.name);
    expect(names).toEqual(["pdfcolmk", "pgf", "pgfplots", "xcolor"]);
    // no pstricks / biblatex cascade from pgf-doc.sty or examples/
    expect(names).not.toContain("pstricks");
    expect(names).not.toContain("biblatex");
  });

  it("algorithm2e (latin-1 bytes) still reports ifoddpage + relsize; commented requires are ignored", async () => {
    const res = await store.installWithDependencies("algorithm2e");
    expect(res.installedDependencies.sort()).toEqual(["ifoddpage", "relsize"]);
    expect(res.unresolved).toEqual([]);
    expect((await store.listPackages()).map((p) => p.name)).not.toContain("commented");
  });

  it("biblatex pulls logreq (past the old scan cap, large file)", async () => {
    const res = await store.installWithDependencies("biblatex");
    expect(res.installedDependencies).toEqual(["logreq"]);
  });

  it("scans files up to 4 MB: a 600 KB sty still reports its dependency", async () => {
    const big = sty("bigone", ["xcolor"]) + "%".repeat(600 * 1024) + "\n";
    await boot([{ name: "bigone", files: { "tex/latex/bigone/bigone.sty": big } }, simplePkg("xcolor")]);
    const res = await store.installWithDependencies("bigone");
    expect(res.installedDependencies).toEqual(["xcolor"]);
  });

  it("skips what the engine's basic tree already has, and uses aliases for conditional deps", async () => {
    await boot(
      [simplePkg("needsbasic", ["graphicx"]), simplePkg("footmisc", ["perpage"]), { name: "bigfoot", files: { "tex/latex/bigfoot/perpage.sty": sty("perpage") } }],
      ["graphicx.sty"],
    );
    expect((await store.installWithDependencies("needsbasic")).installedDependencies).toEqual([]);
    expect((await store.installWithDependencies("footmisc")).installedDependencies).toEqual(["bigfoot"]);
  });

  it("reports dependencies that map to no tlpkg as unresolved", async () => {
    const res = await store.installWithDependencies("needsmissing");
    expect(res.unresolved).toEqual(["nosuchpackage-xyz"]);
  });

  it("is idempotent: an installed root is kept, its missing dependencies are still pulled", async () => {
    await store.installWithDependencies("pgfplots");
    stub.containerHits = {};
    const again = await store.installWithDependencies("pgfplots");
    expect(again.package.name).toBe("pgfplots");
    expect(again.installedDependencies).toEqual([]);
    expect(Object.keys(stub.containerHits)).toEqual([]);
  });

  it("still installs when the basic-tree listing is unavailable", async () => {
    stub.basicNames = null;
    const res = await store.installWithDependencies("biblatex");
    expect(res.installedDependencies).toEqual(["logreq"]);
  });

  it("serializes concurrent installs on one op chain", async () => {
    const [a, b] = await Promise.all([store.installWithDependencies("xcolor"), store.installWithDependencies("fontspec")]);
    expect([a.package.name, b.package.name]).toEqual(["xcolor", "fontspec"]);
    expect((await store.listPackages()).map((p) => p.name)).toEqual(["fontspec", "xcolor"]);
  });
});

describe("remove", () => {
  it("deletes the package's files and manifest entry, keeps a directory another package shares", async () => {
    await boot([
      { name: "one", files: { "tex/latex/shared/one.sty": "1", "tex/latex/onlyone/x.sty": "x" } },
      { name: "two", files: { "tex/latex/shared/two.sty": "2" } },
    ]);
    await store.installWithDependencies("one");
    await store.installWithDependencies("two");
    await store.removePackage("one");
    expect(existsPath("ctan/texmf-dist/tex/latex/shared/one.sty")).toBe(false);
    expect(existsPath("ctan/texmf-dist/tex/latex/shared/two.sty")).toBe(true);
    expect(existsPath("ctan/texmf-dist/tex/latex/onlyone/x.sty")).toBe(false);
    expect((await store.listPackages()).map((p) => p.name)).toEqual(["two"]);
    await expect(store.removePackage("one")).rejects.toMatchObject({ status: 404 });
  });
});

describe("the engine's view of the store", () => {
  it("storeFiles: only manifest-listed files at absolute engine paths, sorted, binary as bytes", async () => {
    const bin = new Uint8Array([0, 255, 1, 128]);
    await boot([
      {
        name: "fonty",
        files: {
          "tex/latex/fonty/fonty.sty": "text",
          "fonts/type1/fonty/f.pfb": bin,
          "tex/latex/fonty/latin1.def": new Uint8Array([0x63, 0xe9]),
        },
      },
    ]);
    expect(await store.storeFiles()).toEqual([]); // empty store
    await store.installWithDependencies("fonty");
    seedFile("ctan/texmf-dist/tex/latex/crash/leftover.sty", "from a crashed install");
    const out = await store.storeFiles();
    expect(out.map((f) => f.path)).toEqual([
      "/texlive/texmf-dist/fonts/type1/fonty/f.pfb",
      "/texlive/texmf-dist/tex/latex/fonty/fonty.sty",
      "/texlive/texmf-dist/tex/latex/fonty/latin1.def",
    ]);
    expect(out[1].contents).toBe("text");
    expect(Array.from(out[0].contents as Uint8Array)).toEqual(Array.from(bin));
    expect(out[2].contents).toBeInstanceOf(Uint8Array); // invalid UTF-8 kept raw
  });

  it("remotePackageNames is empty for an empty store", async () => {
    expect(await store.remotePackageNames()).toEqual([]);
  });
});

describe("first-run default packages (e2e defaults.cjs)", () => {
  async function bootDefaults() {
    await boot([...store.DEFAULT_PACKAGES.map((n) => simplePkg(n)), simplePkg("extra")]);
  }

  it("installs every default once, reports progress, and writes the version marker", async () => {
    await bootDefaults();
    const progress: [string, number, number][] = [];
    const installed = await store.ensureDefaults((n, d, t) => progress.push([n, d, t]));
    expect(installed).toHaveLength(store.DEFAULT_PACKAGES.length);
    expect(installed).toEqual([...store.DEFAULT_PACKAGES]);
    expect(progress[0]).toEqual([store.DEFAULT_PACKAGES[0], 0, store.DEFAULT_PACKAGES.length]);
    expect(progress.at(-1)![1]).toBe(store.DEFAULT_PACKAGES.length - 1);
    const m = JSON.parse(readText("ctan/manifest.json")!);
    expect(m.defaultsVersion).toBe(store.DEFAULTS_VERSION);
    for (const n of store.DEFAULT_PACKAGES) expect(m.packages[n]).toBeDefined();
    // containers came through the stateless proxy, once each
    expect(Object.values(stub.containerHits).every((c) => c === 1)).toBe(true);
    // the same session promise is shared
    expect(await store.ensureDefaults()).toEqual(installed);
  });

  it("a second load downloads nothing and does not resurrect a removed default", async () => {
    await bootDefaults();
    await store.ensureDefaults();
    await store.removePackage("float");
    const pkgs = [...store.DEFAULT_PACKAGES.map((n) => simplePkg(n))];
    await boot(pkgs, undefined, true); // "reload"
    expect(await store.ensureDefaults()).toEqual([]);
    expect(stub.containerHits).toEqual({});
    expect((await store.listPackages()).map((p) => p.name)).not.toContain("float");
  });

  it("a bumped DEFAULTS_VERSION re-seeds only the packages missing from the manifest", async () => {
    await bootDefaults();
    await store.ensureDefaults();
    await store.removePackage("float");
    const manifest = JSON.parse(readText("ctan/manifest.json")!);
    manifest.defaultsVersion = store.DEFAULTS_VERSION - 1;
    seedFile("ctan/manifest.json", JSON.stringify(manifest));
    await boot([...store.DEFAULT_PACKAGES.map((n) => simplePkg(n))], undefined, true);
    expect(await store.ensureDefaults()).toEqual(["float"]);
  });

  it("a failed sweep leaves no marker and the next call retries", async () => {
    await bootDefaults();
    stub.failContainer.biblatex = 404;
    await expect(store.ensureDefaults()).rejects.toMatchObject({ status: 404 });
    expect(JSON.parse(readText("ctan/manifest.json")!).defaultsVersion).toBeUndefined();
    delete stub.failContainer.biblatex;
    const again = await store.ensureDefaults();
    expect(again).toContain("biblatex");
    expect(again).not.toContain("fontspec"); // installed before the failure, kept
    expect(listDir("ctan")).toContain("manifest.json");
  });

  it("the default set includes the babel language pack and the pslatex font packs", () => {
    expect(store.DEFAULT_PACKAGES).toEqual(expect.arrayContaining(["babel-portuges", "times", "zapfchan", "symbol", "pgfplots", "biblatex"]));
    expect(store.DEFAULT_PACKAGES).toHaveLength(18);
  });
});

describe("tar builder sanity", () => {
  it("fixtures build valid archives", () => {
    expect(buildTar({ "a/b.txt": "x" }).length % 512).toBe(0);
  });
});
