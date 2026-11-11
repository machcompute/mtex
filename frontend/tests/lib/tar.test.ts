import { describe, expect, it } from "vitest";
import { parseTar } from "@/lib/tar";

import { concat, tarEntry as entry, tarOf as buf } from "../support/tar-builder";

const END = new Uint8Array(1024);

describe("parseTar (CTAN container reader)", () => {
  it("returns regular files, skipping directories and links", () => {
    const tar = buf(
      entry("texmf-dist/", "", "5"),
      entry("texmf-dist/tex/latex/foo/foo.sty", "\\ProvidesPackage{foo}"),
      entry("link", "", "2"),
      entry("texmf-dist/doc/readme.txt", "hi"),
    );
    const files = parseTar(tar);
    expect([...files.keys()]).toEqual(["texmf-dist/tex/latex/foo/foo.sty", "texmf-dist/doc/readme.txt"]);
    expect(new TextDecoder().decode(files.get("texmf-dist/doc/readme.txt")!)).toBe("hi");
  });

  it("keeps file bytes exact across block padding", () => {
    const data = new Uint8Array(1300).map((_, i) => (i * 7) % 256);
    const files = parseTar(buf(entry("a.bin", data)));
    expect(Array.from(files.get("a.bin")!)).toEqual(Array.from(data));
  });

  it("applies a GNU long-name entry to the next file", () => {
    const long = "texmf-dist/" + "d/".repeat(60) + "file.sty";
    const tar = buf(entry("././@LongLink", long + "\0", "L"), entry("truncated-name", "x"));
    expect([...parseTar(tar).keys()]).toEqual([long]);
  });

  it("joins the ustar prefix field", () => {
    const files = parseTar(buf(entry("file.sty", "x", "0", "texmf-dist/tex")));
    expect([...files.keys()]).toEqual(["texmf-dist/tex/file.sty"]);
  });

  it("stops at two zero blocks and tolerates a lone padding block", () => {
    const tar = new Uint8Array(concat([entry("a", "1"), new Uint8Array(512), entry("b", "2"), END, entry("after", "3")]));
    expect([...parseTar(tar).keys()]).toEqual(["a", "b"]);
  });

  it("rejects a truncated archive", () => {
    const tar = entry("a", "x".repeat(600));
    expect(() => parseTar(new Uint8Array(tar.subarray(0, 700)))).toThrow(/truncated/);
  });

  it("rejects entries that escape the extraction root", () => {
    expect(() => parseTar(buf(entry("../evil", "x")))).toThrow(/escapes/);
    expect(() => parseTar(buf(entry("/etc/passwd", "x")))).toThrow(/escapes/);
    expect(() => parseTar(buf(entry("a/../../b", "x")))).toThrow(/escapes/);
  });
});
