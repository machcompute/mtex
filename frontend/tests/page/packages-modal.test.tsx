// The real Packages modal over the mocked CTAN store (the store itself is covered in
// tests/lib/ctan-store.test.ts); the page-level restart/notice contract lives in
// incremental.test.tsx.
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type PackagesModalType from "@/components/packages-modal";
import { click, q, qa } from "../support/page-actions";
import { advance, settle } from "../support/page-utils";
import { ctan } from "../support/stubs/ctan";

let PackagesModal: typeof PackagesModalType;
beforeEach(async () => {
  vi.useFakeTimers();
  PackagesModal = (await vi.importActual<typeof import("@/components/packages-modal")>("@/components/packages-modal")).default;
});

const info = (name: string) => ({ name, category: "Package", revision: 1, shortdesc: `${name} desc`, size: 2048, provides: [name], files: 3, installedAt: "x" });

async function open(onChanged = vi.fn(), onClose = vi.fn()) {
  render(<PackagesModal onChanged={onChanged} onClose={onClose} />);
  await settle();
  return { onChanged, onClose };
}
const search = async (text: string) => {
  fireEvent.change(q("[data-pkg-search]")!, { target: { value: text } });
  await advance(300);
};

describe("packages modal", () => {
  it("lists what is installed with its size and file count, or says nothing is", async () => {
    ctan.listPackages.mockResolvedValue([info("pgf"), info("xcolor")] as never);
    await open();
    expect(document.body.textContent).toContain("Installed (2)");
    expect(q('[data-pkg-row="pgf"]')!.textContent).toContain("2 KB · 3 files");
    ctan.listPackages.mockResolvedValue([] as never);
    document.body.innerHTML = "";
    await open();
    expect(document.body.textContent).toContain("Nothing installed yet");
  });

  it("searches CTAN after a 300 ms pause, showing a spinner meanwhile, and 'No packages match' for nothing", async () => {
    ctan.searchPackages.mockResolvedValue([{ name: "tikz-cd", installed: false, shortdesc: "diagrams", size: 1024 * 1024 * 3 } as never]);
    await open();
    fireEvent.change(q("[data-pkg-search]")!, { target: { value: "tikz" } });
    await settle();
    expect(document.body.textContent).toContain("Searching…");
    expect(ctan.searchPackages).not.toHaveBeenCalled(); // debounced
    await advance(300);
    expect(ctan.searchPackages).toHaveBeenCalledWith("tikz");
    expect(q('[data-pkg-results] [data-pkg-row="tikz-cd"]')!.textContent).toContain("3.0 MB");
    ctan.searchPackages.mockResolvedValue([]);
    await search("zzzz");
    expect(document.body.textContent).toContain("No packages match.");
    fireEvent.change(q("[data-pkg-search]")!, { target: { value: "  " } });
    await settle();
    expect(q("[data-pkg-results]")).toBeNull();
  });

  it("a failed search shows its error", async () => {
    ctan.searchPackages.mockRejectedValue(new Error("the first search downloads the package database"));
    await open();
    await search("x");
    expect(document.body.textContent).toContain("the first search downloads the package database");
  });

  it("install flips the card (and its pulled-in dependencies) to 'installed' and reports through onChanged", async () => {
    ctan.searchPackages.mockResolvedValue([
      { name: "pgfplots", installed: false, shortdesc: "plots", size: 10 },
      { name: "xcolor", installed: false, shortdesc: "colors", size: 10 },
    ]);
    ctan.installWithDependencies.mockResolvedValue({ package: { name: "pgfplots" }, installedDependencies: ["xcolor"], unresolved: ["weird"] } as never);
    ctan.listPackages.mockResolvedValue([info("pgfplots")] as never);
    const { onChanged } = await open();
    await search("pgf");
    await click(q('[data-pkg-install="pgfplots"]'));
    expect(ctan.installWithDependencies).toHaveBeenCalledWith("pgfplots");
    expect(qa('[data-pkg-results] [data-pkg-row]').every((r) => r.textContent?.includes("installed"))).toBe(true);
    expect(onChanged).toHaveBeenCalledWith("Installed “pgfplots” (pulled in: xcolor) — could not auto-install: weird");
    expect(q('[data-pkg-installed] [data-pkg-row="pgfplots"]')).not.toBeNull();
  });

  it("remove restores the Install button and reports the removal", async () => {
    ctan.listPackages.mockResolvedValue([info("pgf")] as never);
    ctan.searchPackages.mockResolvedValue([{ name: "pgf", installed: true, shortdesc: "g", size: 1 }]);
    const { onChanged } = await open();
    await search("pgf");
    ctan.listPackages.mockResolvedValue([] as never);
    await click(q('[data-pkg-remove="pgf"]'));
    expect(ctan.removePackage).toHaveBeenCalledWith("pgf");
    expect(onChanged).toHaveBeenCalledWith("Removed “pgf”");
    expect(q('[data-pkg-install="pgf"]')).not.toBeNull();
  });

  it("an install failure shows in the modal and does not notify the page", async () => {
    ctan.searchPackages.mockResolvedValue([{ name: "bad", installed: false, shortdesc: "d", size: 1 }]);
    ctan.installWithDependencies.mockRejectedValue(new Error("downloaded container checksum mismatch"));
    const { onChanged } = await open();
    await search("bad");
    await click(q('[data-pkg-install="bad"]'));
    expect(q("[data-pkg-error]")!.textContent).toBe("downloaded container checksum mismatch");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("closes from the button and the backdrop", async () => {
    const { onClose } = await open();
    await click(q('button[title="Close"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(q('[data-modal="packages"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
