// Plain (uncompressed) synctex documents for page tests.
const U = 65536 * (72.27 / 72);

export function synctexDoc(inputs: Record<number, string>, records: string[]): Uint8Array<ArrayBuffer> {
  const text = [
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
    "Post scriptum:",
    "",
  ].join("\n");
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/** One glyph record: file index, source line, position in PDF points. */
export const glyph = (file: number, line: number, xPt: number, yPt: number) =>
  `g${file},${line}:${Math.round(xPt * U)},${Math.round(yPt * U)}:1,1,1`;

export const ABS = "/home/web_user/project_dir/./";
