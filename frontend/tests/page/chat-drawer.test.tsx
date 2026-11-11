import { describe, expect, it } from "vitest";
import { diffSnippet } from "@/components/chat-drawer";
import { fileIcon, kindOf } from "@/components/file-browser";
import { render } from "@testing-library/react";

describe("diffSnippet (the apply_edit approval card)", () => {
  it("marks unchanged, removed and added lines", () => {
    expect(diffSnippet("a\nb\nc", "a\nB\nc")).toEqual([
      { t: "same", text: "a" },
      { t: "del", text: "b" },
      { t: "add", text: "B" },
      { t: "same", text: "c" },
    ]);
  });

  it("handles pure insertion, pure deletion and identical text", () => {
    expect(diffSnippet("x", "x\ny")).toEqual([
      { t: "same", text: "x" },
      { t: "add", text: "y" },
    ]);
    expect(diffSnippet("x\ny", "x")).toEqual([
      { t: "same", text: "x" },
      { t: "del", text: "y" },
    ]);
    expect(diffSnippet("same", "same")).toEqual([{ t: "same", text: "same" }]);
  });

  it("a fully replaced snippet is all del then add", () => {
    const d = diffSnippet("Hello world", "Hello CHAT EDIT");
    expect(d.map((x) => x.t)).toEqual(["del", "add"]);
  });
});

describe("file kinds and icons (file panel)", () => {
  it.each([
    ["main.tex", false, "tex"],
    ["refs.bib", false, "bib"],
    ["fig.PDF", true, "pdf"],
    ["logo.png", true, "image"],
    ["photo.JPEG", true, "image"],
    ["vector.svg", false, "image"],
    ["font.bin", true, "image"],
    ["notes.txt", false, "other"],
    ["LICENSE", false, "other"],
  ])("%s (binary=%s) is %s", (path, bin, kind) => {
    expect(kindOf(path, bin)).toBe(kind);
    const { container } = render(<span>{fileIcon(path, bin)}</span>);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
