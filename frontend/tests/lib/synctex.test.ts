import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeSynctex, findOutputForSource, findSourceForPoint, type SyncEntry } from "@/lib/synctex";

const U = 65536 * (72.27 / 72); // record units per PDF point
const enc = (s: string) => new TextEncoder().encode(s);

/** Build a synctex document; `records` are raw content lines after "{1". */
function synctex(inputs: Record<number, string>, records: string[], extra: string[] = []) {
  return [
    "SyncTeX Version:1",
    ...Object.entries(inputs).map(([n, p]) => `Input:${n}:${p}`),
    "Output:pdf",
    "Magnification:1000",
    "Unit:1",
    "X Offset:0",
    "Y Offset:0",
    "Content:",
    "{1",
    ...records,
    "}1",
    "Postamble:",
    "Count:1",
    ...extra,
    "Post scriptum:",
    "",
  ].join("\n");
}
const rec = (t: string, file: number, line: number, xPt: number, yPt: number) =>
  `${t}${file},${line}:${Math.round(xPt * U)},${Math.round(yPt * U)}:1,1,1`;

const ABS = "/home/web_user/project_dir/./";

describe("decodeSynctex", () => {
  it("converts record units to PDF points (72/72.27, y grows downward)", async () => {
    const text = synctex({ 1: `${ABS}main.tex` }, [rec("g", 1, 7, 100, 200)]);
    const [e] = await decodeSynctex(enc(text), ["main.tex"], "main.tex");
    expect(e).toMatchObject({ page: 1, line: 7, file: "main.tex", hasGlyph: true });
    expect(e.xLeft).toBeCloseTo(100, 2);
    expect(e.yTop).toBeCloseTo(200, 2);
  });

  it("reads gzipped synctex like the engine writes it", async () => {
    const text = synctex({ 1: `${ABS}main.tex` }, [rec("g", 1, 3, 10, 20)]);
    const out = await decodeSynctex(new Uint8Array(gzipSync(text)), ["main.tex"], "main.tex");
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(3);
  });

  it("resolves nested \\input paths to their project keys, not basenames (fixes #6)", async () => {
    const text = synctex({ 1: `${ABS}main.tex`, 2: `${ABS}a/inner.tex`, 3: `${ABS}inner.tex` }, [
      rec("g", 1, 1, 10, 10),
      rec("g", 2, 4, 10, 30),
      rec("g", 3, 9, 10, 50),
    ]);
    const files = ["main.tex", "a/inner.tex", "inner.tex"];
    const out = await decodeSynctex(enc(text), files, "main.tex");
    expect(out.map((e) => e.file).sort()).toEqual(["a/inner.tex", "inner.tex", "main.tex"]);
    expect(out.find((e) => e.line === 4)!.file).toBe("a/inner.tex");
    expect(out.find((e) => e.line === 9)!.file).toBe("inner.tex");
  });

  it("resolves cwd-relative inputs against the main file's directory", async () => {
    const text = synctex({ 1: "main.tex", 2: "./chapters/intro.tex" }, [
      rec("g", 2, 2, 1, 1),
    ]);
    const out = await decodeSynctex(enc(text), ["doc/main.tex", "doc/chapters/intro.tex"], "doc/main.tex");
    expect(out[0].file).toBe("doc/chapters/intro.tex");
  });

  it("falls back to a unique basename, then to the raw table path", async () => {
    const text = synctex({ 1: "/weird/prefix/inner.tex", 2: "/tmp/main.aux" }, [
      rec("g", 1, 2, 1, 1),
      rec("g", 2, 3, 1, 5),
    ]);
    const out = await decodeSynctex(enc(text), ["x/inner.tex"], "main.tex");
    expect(out.find((e) => e.line === 2)!.file).toBe("x/inner.tex");
    expect(out.find((e) => e.line === 3)!.file).toBe("/tmp/main.aux");
  });

  it("merges records of one physical line and tracks xLeft/xRight/hasGlyph", async () => {
    const text = synctex({ 1: `${ABS}main.tex` }, [
      rec("h", 1, 5, 50, 100),
      rec("g", 1, 5, 20, 100),
      rec("k", 1, 5, 80, 100),
    ]);
    const out = await decodeSynctex(enc(text), ["main.tex"], "main.tex");
    expect(out).toHaveLength(1);
    expect(out[0].xLeft).toBeCloseTo(20, 2);
    expect(out[0].xRight).toBeCloseTo(80, 2);
    expect(out[0].hasGlyph).toBe(true);
  });

  it("ignores counters, bad lines, unknown inputs, page 0 and apply offsets", async () => {
    const text = [
      "SyncTeX Version:1",
      "Input:1:/p/./main.tex",
      "X Offset:65536",
      "Y Offset:0",
      "Content:",
      "g1,1:0,0", // before any page: dropped
      "{2",
      "!9",
      "zzz",
      "g9,1:0,0:1,1,1", // unknown input
      "g1,0:0,0:1,1,1", // line 0
      "g1,3:65536,0:1,1,1",
      "}2",
    ].join("\n");
    const out = await decodeSynctex(enc(text), ["main.tex"], "main.tex");
    expect(out).toHaveLength(1);
    expect(out[0].page).toBe(2);
    expect(out[0].xLeft).toBeCloseTo((65536 + 65536) / U, 4); // offset added
  });

  it("tolerates a late Input line in the postamble (files read late, like .aux)", async () => {
    const text = synctex({ 1: `${ABS}main.tex` }, [rec("g", 1, 1, 1, 1)], ["Input:2:/p/./main.aux"]);
    const out = await decodeSynctex(enc(text), ["main.tex"], "main.tex");
    expect(out).toHaveLength(1);
  });
});

describe("findSourceForPoint (inverse sync: PDF click → file/line)", () => {
  const e = (over: Partial<SyncEntry>): SyncEntry => ({
    page: 1,
    yTop: 100,
    xLeft: 50,
    xRight: 80,
    hasGlyph: true,
    line: 1,
    file: "main.tex",
    ...over,
  });

  it("picks the physical line with the closest baseline on the page", () => {
    const entries = [e({ yTop: 100, line: 1 }), e({ yTop: 120, line: 2 }), e({ page: 2, yTop: 121, line: 9 })];
    expect(findSourceForPoint(entries, 1, 60, 118)!.line).toBe(2);
    expect(findSourceForPoint(entries, 1, 60, 101)!.line).toBe(1);
    expect(findSourceForPoint(entries, 2, 60, 0)!.line).toBe(9);
    expect(findSourceForPoint(entries, 3, 0, 0)).toBeNull();
  });

  it("a tie goes to the line below", () => {
    const entries = [e({ yTop: 100, line: 1 }), e({ yTop: 120, line: 2 })];
    expect(findSourceForPoint(entries, 1, 60, 110)!.line).toBe(2);
  });

  it("breaks ties on a shared baseline by x: the line starting just before the cursor, glyphs first", () => {
    const entries = [
      e({ line: 3, xLeft: 10, hasGlyph: true }),
      e({ line: 4, xLeft: 60, hasGlyph: true }),
      e({ line: 5, xLeft: 60, hasGlyph: false }),
    ];
    expect(findSourceForPoint(entries, 1, 70, 100)!.line).toBe(4);
    expect(findSourceForPoint(entries, 1, 30, 100)!.line).toBe(3);
    // a click left of everything takes the leftmost
    expect(findSourceForPoint(entries, 1, 0, 100)!.line).toBe(3);
  });

  it("returns the nested file, so the page can open it as a tab (e2e #6)", () => {
    const entries = [e({ file: "a/inner.tex", line: 4 })];
    expect(findSourceForPoint(entries, 1, 60, 100)).toMatchObject({ file: "a/inner.tex", line: 4 });
  });
});

describe("findOutputForSource (forward sync)", () => {
  const entries: SyncEntry[] = [
    { page: 1, yTop: 10, xLeft: 0, xRight: 1, hasGlyph: true, line: 2, file: "a.tex" },
    { page: 1, yTop: 50, xLeft: 0, xRight: 1, hasGlyph: true, line: 10, file: "a.tex" },
    { page: 2, yTop: 5, xLeft: 0, xRight: 1, hasGlyph: true, line: 4, file: "b.tex" },
  ];
  it("uses the greatest line at or above, else the nearest below, per file", () => {
    expect(findOutputForSource(entries, "a.tex", 10)!.yTop).toBe(50);
    expect(findOutputForSource(entries, "a.tex", 9)!.yTop).toBe(10);
    expect(findOutputForSource(entries, "a.tex", 1)!.line).toBe(2);
    expect(findOutputForSource(entries, "b.tex", 99)!.page).toBe(2);
    expect(findOutputForSource(entries, "c.tex", 1)).toBeNull();
  });
});
