import { describe, expect, it } from "vitest";
import { DEFAULT_FILES, DEFAULT_MAIN, DEFAULT_PROJECT_NAME, nextProjectName } from "@/lib/defaults";

describe("starter project (e2e projects: first run)", () => {
  it("is a two-file bibtex example the engine can build out of the box", () => {
    expect(DEFAULT_MAIN).toBe("main.tex");
    expect(Object.keys(DEFAULT_FILES).sort()).toEqual(["main.tex", "refs.bib"]);
    const main = DEFAULT_FILES[DEFAULT_MAIN];
    expect(main).toContain("\\bibliography{refs}");
    expect(main).toContain("\\cite{euler1748}");
    expect(main).toContain("\\cite{knuth1984}");
    expect(DEFAULT_FILES["refs.bib"]).toContain("@article{euler1748");
    expect(DEFAULT_FILES["refs.bib"]).toContain("@book{knuth1984");
  });
});

describe("nextProjectName (e2e projects: create → numbered name)", () => {
  it("returns the plain name first, then numbers the next free one", () => {
    expect(nextProjectName([])).toBe(DEFAULT_PROJECT_NAME);
    expect(nextProjectName([DEFAULT_PROJECT_NAME])).toBe("LaTeX project 2");
    expect(nextProjectName([DEFAULT_PROJECT_NAME, "LaTeX project 2"])).toBe("LaTeX project 3");
  });

  it("fills gaps and ignores unrelated names", () => {
    expect(nextProjectName(["Thesis", "LaTeX project 2"])).toBe(DEFAULT_PROJECT_NAME);
    expect(nextProjectName([DEFAULT_PROJECT_NAME, "LaTeX project 3"])).toBe("LaTeX project 2");
  });
});
